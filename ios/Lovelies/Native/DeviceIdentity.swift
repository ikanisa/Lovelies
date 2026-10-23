import Foundation
import Security
import CryptoKit

protocol NativeSecretStore: Sendable {
    func read(_ name: String) throws -> Data?
    func write(_ name: String, data: Data?) throws
    func compareAndSwap(_ name: String, expected: Data?, replacement: Data?) throws -> Bool
}
private enum NativeSecretStoreCAS { static let lock = NSRecursiveLock() }
extension NativeSecretStore {
    /// The app has one secure-vault service and no shared extension access group.
    /// Serialize its same-process journal CAS across repository instances.
    func compareAndSwap(_ name: String, expected: Data?, replacement: Data?) throws -> Bool {
        NativeSecretStoreCAS.lock.lock(); defer { NativeSecretStoreCAS.lock.unlock() }
        guard try read(name) == expected else { return false }; try write(name, data: replacement); return true
    }
}
protocol NativeDeviceSigner: Sendable {
    func sign(_ data: Data) throws -> String
    func sha256(_ data: Data) -> String
    func clear()
    func hasRetainedKey() throws -> Bool
    func publicJWK(alias: String, create: Bool) throws -> WireValue
    func sign(_ data: Data, alias: String) throws -> String
    func clear(alias: String)
}
// Existing isolated protocol fixtures do not represent persistent key storage.
// Production and restart-capable fixtures override this noncreating query.
extension NativeDeviceSigner {
    func hasRetainedKey() throws -> Bool { false }
    func publicJWK(alias: String, create: Bool) throws -> WireValue { throw NativeAPIError.unsupported("This signer cannot manage a new device key.") }
    func sign(_ data: Data, alias: String) throws -> String {
        guard alias == NativeEnrollmentRecord.keyAlias else { throw NativeAPIError.unsupported("The saved recovery device key is unavailable.") }
        return try sign(data)
    }
    func clear(alias: String) { if alias == NativeEnrollmentRecord.keyAlias { clear() } }
}
struct KeychainDeviceSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { try DeviceIdentity.sign(data) }
    func sha256(_ data: Data) -> String { DeviceIdentity.sha256(data) }
    func clear() { DeviceIdentity.clear() }
    func hasRetainedKey() throws -> Bool { try DeviceIdentity.hasOwnedKey() }
    func publicJWK(alias: String, create: Bool) throws -> WireValue { try DeviceIdentity.publicJWK(alias: alias, createIfMissing: create) }
    func sign(_ data: Data, alias: String) throws -> String { try DeviceIdentity.sign(data, alias: alias) }
    func clear(alias: String) { DeviceIdentity.clear(alias: alias) }
}
struct KeychainSecretStore: NativeSecretStore {
    private let service = "com.lovelies.connected.private.v1"
    func read(_ name: String) throws -> Data? {
        NativeSecretStoreCAS.lock.lock(); defer { NativeSecretStoreCAS.lock.unlock() }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: name, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw NativeAPIError.unsupported("Protected storage is unavailable. Unlock this device and try again.") }
        return data
    }
    func write(_ name: String, data: Data?) throws {
        NativeSecretStoreCAS.lock.lock(); defer { NativeSecretStoreCAS.lock.unlock() }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
        guard let data else { let status = SecItemDelete(query as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeAPIError.unavailable("protected_storage") }; return }
        guard data.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query; item[kSecValueData as String] = data; item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw NativeAPIError.unavailable("protected_storage") }
        } else if status != errSecSuccess { throw NativeAPIError.unavailable("protected_storage") }
    }
}

enum DeviceIdentity {
    private static func tag(_ alias: String) throws -> Data {
        guard NativeAccountRecoveryRecord.validAlias(alias) else { throw NativeAPIError.invalidResponse }
        return Data(alias.utf8)
    }
    static func hasOwnedKey() throws -> Bool {
        let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess, let rows = result as? [[String: Any]] else { throw NativeAPIError.unavailable("protected_storage") }
        return rows.contains { row in
            guard let bytes = row[kSecAttrApplicationTag as String] as? Data, let alias = String(data: bytes, encoding: .utf8) else { return false }
            return NativeAccountRecoveryRecord.validAlias(alias)
        }
    }
    static func hasExistingKey(alias: String = NativeEnrollmentRecord.keyAlias) throws -> Bool {
        let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: try tag(alias),
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecReturnRef as String: true]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess, result != nil else { throw NativeAPIError.unsupported("Unlock this device to check its existing face-verification key.") }
        return true
    }
    static func key(alias: String = NativeEnrollmentRecord.keyAlias, createIfMissing: Bool = true) throws -> SecKey {
        let tag = try tag(alias)
        let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecReturnRef as String: true]
        var existing: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &existing)
        if status == errSecSuccess, let existing { return existing as! SecKey }
        guard status == errSecItemNotFound else { throw NativeAPIError.unsupported("Unlock your device to access its face-verification key.") }
        guard createIfMissing else { throw NativeAPIError.unsupported("The original face-verification key is unavailable. Enrollment recovery cannot create a replacement key.") }
        var attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]]
        #if !targetEnvironment(simulator)
        attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage], nil) else { throw NativeAPIError.unsupported("Protected device-key access is unavailable.") }
        attributes[kSecPrivateKeyAttrs as String] = [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag, kSecAttrAccessControl as String: access]
        #endif
        var error: Unmanaged<CFError>?
        guard let value = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw NativeAPIError.unsupported("This device could not create its protected verification key.") }
        return value
    }
    static func publicJWK(alias: String = NativeEnrollmentRecord.keyAlias, createIfMissing: Bool = true) throws -> WireValue {
        guard let publicKey = SecKeyCopyPublicKey(try key(alias: alias, createIfMissing: createIfMissing)), let data = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else { throw NativeAPIError.invalidResponse }
        let publicKeyValue = try P256.Signing.PublicKey(x963Representation: data)
        let raw = publicKeyValue.x963Representation
        guard raw.count == 65 else { throw NativeAPIError.invalidResponse }
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(raw.subdata(in: 1..<33).base64URL),
            "y": .string(raw.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
    static func sign(_ data: Data, alias: String = NativeEnrollmentRecord.keyAlias) throws -> String {
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(try key(alias: alias, createIfMissing: false), .ecdsaSignatureMessageX962SHA256, data as CFData, &error) as Data? else { throw NativeAPIError.unsupported("The device could not sign this capture. Unlock it and try again.") }
        return try P256.Signing.ECDSASignature(derRepresentation: signature).rawRepresentation.base64URL
    }
    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func clear(alias: String = NativeEnrollmentRecord.keyAlias) {
        guard let tag = try? tag(alias) else { return }
        SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag, kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom] as CFDictionary)
    }
}
