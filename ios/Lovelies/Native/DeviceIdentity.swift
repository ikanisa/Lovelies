import Foundation
import Security
import CryptoKit
import LocalAuthentication

protocol NativeSecretStore: Sendable {
    var authorityNamespace: String { get }
    func read(_ name: String) throws -> Data?
    func write(_ name: String, data: Data?) throws
    func compareAndSwap(_ name: String, expected: Data?, replacement: Data?) throws -> Bool
}
/// Credential/reference writes and key creation/removal share a custody gate. The separate
/// authority ledger and its publication clock never acquire this gate.
enum NativeIdentityCustody {
    private static let lock = NSRecursiveLock()
    static let slots: Set<String> = ["credentials", "registered-device", "pending-face-device", "face-enrollment-journal", "ordinary-face-login-journal",
        "face-profile-lifecycle", "account-recovery-journal", "retired-face-profile-controls", "retired-account-recoveries", "deleted-face-profile-controls",
        "audience-device-renewals", "face-lifecycle-retired-identities", "registered-deletion-receipt"]
    static func withLock<T>(_ body: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body() }
    static func withSlot<T>(_ name: String, _ body: () throws -> T) rethrows -> T {
        if slots.contains(name) { return try withLock(body) }; return try body()
    }
}
private enum NativeSecretStoreCAS {
    static let registry = NSLock()
    nonisolated(unsafe) static var locks: [String: NSRecursiveLock] = [:]
    static func lock(_ slot: String) -> NSRecursiveLock {
        registry.lock(); defer { registry.unlock() }
        if let found = locks[slot] { return found }
        let result = NSRecursiveLock(); locks[slot] = result; return result
    }
}
extension NativeSecretStore {
    /// The app has one secure-vault service and no shared extension access group.
    /// Serialize its same-process journal CAS across repository instances.
    func compareAndSwap(_ name: String, expected: Data?, replacement: Data?) throws -> Bool {
        let lock = NativeSecretStoreCAS.lock(authorityNamespace + ":" + name)
        lock.lock(); defer { lock.unlock() }
        guard try read(name) == expected else { return false }
        try write(name, data: replacement)
        guard try read(name) == replacement else { throw NativeAPIError.unavailable("protected_storage_write_unconfirmed") }
        return true
    }
}

/// One per vault/origin, shared by foreground and background repository instances.
/// The lock protects only integers; no Keychain call is made while holding it.
final class NativeAuthorityClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0, pendingBeforeRestore = 0
    private var restored = false
    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var registry: [String: NativeAuthorityClock] = [:]
    static func shared(_ key: String) -> NativeAuthorityClock {
        registryLock.lock(); defer { registryLock.unlock() }
        if let found = registry[key] { return found }
        let result = NativeAuthorityClock(); registry[key] = result; return result
    }
    func snapshot() -> Int { lock.lock(); defer { lock.unlock() }; return value }
    func advance() -> Int {
        lock.lock(); defer { lock.unlock() }
        if value < Int.max - 1 { value += 1 }
        if !restored, pendingBeforeRestore < Int.max - 1 { pendingBeforeRestore += 1 }
        return value
    }
    func restore(_ generation: Int) {
        lock.lock(); defer { lock.unlock() }
        if !restored {
            let total = generation.addingReportingOverflow(pendingBeforeRestore)
            value = max(value, total.overflow ? Int.max - 1 : total.partialValue)
            pendingBeforeRestore = 0; restored = true
        } else { value = max(value, generation) }
    }
}

/// This independent slot survives a late credential or promotion-journal write.
/// Retired challenge/rotation bindings also prevent an old completion reply from
/// being relabelled as a new generation merely because its retrieval was retried.
final class NativeAuthorityLedger: @unchecked Sendable {
    private struct Record: Codable {
        var version = 1
        let origin: String
        var generation: Int
        var challenges: Set<String> = [], rotations: Set<String> = []
        var knownChallenges: Set<String>? = [], knownRotations: Set<String>? = []
        var challengeGenerations: [String: Int]? = [:], rotationGenerations: [String: Int]? = [:]
    }
    let clock: NativeAuthorityClock
    private let store: any NativeSecretStore, origin: String, slot: String
    private let lock = NSLock()
    private var challenges: Set<String> = [], rotations: Set<String> = []
    private var retiredChallenges: Set<String> = [], retiredRotations: Set<String> = []
    init(store: any NativeSecretStore, origin: URL) {
        self.store = store; self.origin = origin.absoluteString
        slot = "session-authority-v1-" + NativeAppleStoreJournal.digest(Data(origin.absoluteString.utf8))
        clock = NativeAuthorityClock.shared(store.authorityNamespace + ":" + origin.absoluteString)
    }
    private func decode(_ bytes: Data?) throws -> Record? {
        guard let bytes else { return nil }
        guard bytes.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        let record = try JSONDecoder().decode(Record.self, from: bytes)
        guard record.version == 1, record.origin == origin, record.generation >= 0, record.generation < Int.max - 1,
              record.challenges.count <= 8192, record.rotations.count <= 8192,
              (record.knownChallenges?.count ?? 0) <= 8192, (record.knownRotations?.count ?? 0) <= 8192,
              (record.challengeGenerations?.count ?? 0) <= 8192, (record.rotationGenerations?.count ?? 0) <= 8192,
              (record.challengeGenerations ?? [:]).allSatisfy({ NativeExportManifestPage.validHash($0.key) && $0.value >= 0 && $0.value <= record.generation }),
              (record.rotationGenerations ?? [:]).allSatisfy({ NativeExportManifestPage.validHash($0.key) && $0.value >= 0 && $0.value <= record.generation }),
              record.challenges.union(record.rotations).union(record.knownChallenges ?? []).union(record.knownRotations ?? []).allSatisfy({ $0.count == 64 && $0.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) }) else { throw NativeAPIError.invalidResponse }
        return record
    }
    func restore() throws {
        let bytes = try store.read(slot)
        if let record = try decode(bytes) {
            adopt(record)
            if clock.snapshot() > record.generation { try persistRetirement(clock.snapshot()) }
            try registerStoredBindings(); return
        }
        // A generation-stamped credential/journal is evidence of a migrated
        // installation. Missing retirement state must not reset it to zero.
        for name in ["credentials", "face-enrollment-journal", "account-recovery-journal", "face-profile-lifecycle", "ordinary-face-login-journal", "refresh-delivery-journal-v1"] {
            if let data = try store.read(name), String(data: data, encoding: .utf8)?.contains("\"localAuthorityGeneration\"") == true {
                throw NativeAPIError.unavailable("session_authority_unavailable")
            }
        }
        let first = Record(origin: origin, generation: 0)
        if try store.compareAndSwap(slot, expected: nil, replacement: JSONEncoder().encode(first)) {
            adopt(first)
            if clock.snapshot() > 0 { try persistRetirement(clock.snapshot()) }
            try registerStoredBindings(); return
        }
        guard let saved = try decode(store.read(slot)) else { throw NativeAPIError.unavailable("session_authority_unavailable") }
        adopt(saved); try registerStoredBindings()
    }
    private func registerStoredBindings() throws {
        for name in ["face-enrollment-journal", "account-recovery-journal", "face-profile-lifecycle", "ordinary-face-login-journal", "refresh-delivery-journal-v1"] {
            try observeStored(store.read(name))
        }
    }
    private func adopt(_ record: Record) {
        clock.restore(record.generation)
        lock.lock(); retiredChallenges.formUnion(record.challenges); retiredRotations.formUnion(record.rotations); lock.unlock()
    }
    private func bindings(_ bytes: Data?) -> (Set<String>, Set<String>) {
        guard let bytes, let value = try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]) else { return ([], []) }
        var foundChallenges: Set<String> = [], foundRotations: Set<String> = []
        func walk(_ value: Any) {
            if let row = value as? [String: Any] {
                if let id = row["challenge_id"] as? String { foundChallenges.insert(NativeAppleStoreJournal.digest(Data(id.utf8))) }
                if let id = row["rotation_key"] as? String ?? row["rotationKey"] as? String { foundRotations.insert(NativeAppleStoreJournal.digest(Data(id.utf8))) }
                row.values.forEach(walk)
            } else if let rows = value as? [Any] { rows.forEach(walk) }
        }
        walk(value)
        return (foundChallenges, foundRotations)
    }
    /// New authentication bindings are durably reserved in the independent
    /// authority slot before their ordinary journal can be blocked or committed.
    func prepareWrite(_ bytes: Data?, generation: Int) throws { try register(bindings(bytes), generation: generation, stored: false) }
    func observeStored(_ bytes: Data?) throws { try register(bindings(bytes), generation: clock.snapshot(), stored: true) }
    private func register(_ found: (Set<String>, Set<String>), generation: Int, stored: Bool) throws {
        guard !found.0.isEmpty || !found.1.isEmpty else { return }
        lock.lock(); challenges.formUnion(found.0); rotations.formUnion(found.1); lock.unlock()
        for _ in 0..<16 {
            let before = try store.read(slot)
            var record = try decode(before) ?? Record(origin: origin, generation: generation)
            guard record.generation == generation, clock.snapshot() == generation else { throw NativeAPIError.sessionChanged }
            let knownChallenges = (record.knownChallenges ?? []).union((record.challengeGenerations ?? [:]).keys)
            let knownRotations = (record.knownRotations ?? []).union((record.rotationGenerations ?? [:]).keys)
            let missingChallenges = found.0.subtracting(knownChallenges), missingRotations = found.1.subtracting(knownRotations)
            if stored, generation > 0 {
                // An unreserved old/late journal cannot become a fresh challenge
                // just because a new repository happens to discover it later.
                record.challenges.formUnion(missingChallenges); record.rotations.formUnion(missingRotations)
            }
            if missingChallenges.isEmpty, missingRotations.isEmpty { adopt(record); return }
            var challengeGenerations = record.challengeGenerations ?? [:], rotationGenerations = record.rotationGenerations ?? [:]
            for id in record.knownChallenges ?? [] where challengeGenerations[id] == nil { challengeGenerations[id] = 0 }
            for id in record.knownRotations ?? [] where rotationGenerations[id] == nil { rotationGenerations[id] = 0 }
            for id in missingChallenges { challengeGenerations[id] = generation }
            for id in missingRotations { rotationGenerations[id] = generation }
            record.knownChallenges = nil; record.knownRotations = nil
            record.challengeGenerations = challengeGenerations; record.rotationGenerations = rotationGenerations
            guard challengeGenerations.count <= 8192, rotationGenerations.count <= 8192,
                  record.challenges.count <= 8192, record.rotations.count <= 8192 else { throw NativeAPIError.unavailable("session_retirement_storage_full") }
            let encoded = try JSONEncoder().encode(record)
            guard encoded.count <= 2 * 1024 * 1024 else { throw NativeAPIError.unavailable("session_retirement_storage_full") }
            if try store.compareAndSwap(slot, expected: before, replacement: encoded) { adopt(record); return }
        }
        throw NativeAPIError.unavailable("session_retirement_unconfirmed")
    }
    func permitsRequest(_ body: WireValue?) -> Bool {
        do { if let record = try decode(store.read(slot)) { adopt(record) } else { return false } } catch { return false }
        lock.lock(); defer { lock.unlock() }
        if let id = body?["challenge_id"].string, retiredChallenges.contains(NativeAppleStoreJournal.digest(Data(id.utf8))) { return false }
        if let id = body?["rotation_key"].string, retiredRotations.contains(NativeAppleStoreJournal.digest(Data(id.utf8))) { return false }
        return true
    }
    func retiredChallenge(_ id: String?) -> Bool {
        guard let id else { return false }
        lock.lock(); defer { lock.unlock() }; return retiredChallenges.contains(NativeAppleStoreJournal.digest(Data(id.utf8)))
    }
    @discardableResult func persistRetirement(_ generation: Int) throws -> Int {
        lock.lock(); let observedChallenges = challenges, observedRotations = rotations
        retiredChallenges.formUnion(observedChallenges); retiredRotations.formUnion(observedRotations); lock.unlock()
        for _ in 0..<16 {
            let bytes = try store.read(slot)
            var record = try decode(bytes) ?? Record(origin: origin, generation: 0)
            clock.restore(record.generation)
            let target = max(generation, clock.snapshot())
            guard target < Int.max - 1 else { throw NativeAPIError.unavailable("session_retirement_storage_full") }
            record.generation = max(record.generation, target)
            record.challenges.formUnion((record.challengeGenerations ?? [:]).filter { $0.value < target }.keys)
            record.rotations.formUnion((record.rotationGenerations ?? [:]).filter { $0.value < target }.keys)
            record.challenges.formUnion(record.knownChallenges ?? []); record.rotations.formUnion(record.knownRotations ?? [])
            record.challenges.formUnion(observedChallenges.filter { (record.challengeGenerations?[$0] ?? 0) < target })
            record.rotations.formUnion(observedRotations.filter { (record.rotationGenerations?[$0] ?? 0) < target })
            guard record.challenges.count <= 8192, record.rotations.count <= 8192 else { throw NativeAPIError.unavailable("session_retirement_storage_full") }
            let encoded = try JSONEncoder().encode(record)
            guard encoded.count <= 2 * 1024 * 1024 else { throw NativeAPIError.unavailable("session_retirement_storage_full") }
            if try store.compareAndSwap(slot, expected: bytes, replacement: encoded) { adopt(record); return record.generation }
        }
        throw NativeAPIError.unavailable("session_retirement_unconfirmed")
    }
    func persistSoon(_ generation: Int) {
        // No actor or existing credential-slot lock is needed by this monotonic write.
        Task.detached(priority: .userInitiated) { [self] in try? persistRetirement(generation) }
    }
}

/// Covers every remaining direct slot writer. First observation is its exact
/// baseline; a later independent writer cannot be erased by a stale snapshot.
/// Explicit compare-and-swap protocols retain their own stronger bindings.
final class NativeOwnedSecretStore: NativeSecretStore, @unchecked Sendable {
    private enum Baseline { case missing, bytes(Data); var value: Data? { if case .bytes(let data) = self { return data }; return nil } }
    private let base: any NativeSecretStore, ledger: NativeAuthorityLedger
    private let lock = NSLock()
    private var baselines: [String: Baseline] = [:]
    var authorityNamespace: String { base.authorityNamespace }
    init(base: any NativeSecretStore, ledger: NativeAuthorityLedger) { self.base = base; self.ledger = ledger }
    func read(_ name: String) throws -> Data? {
        let value = try base.read(name); try ledger.observeStored(value)
        lock.lock(); if baselines[name] == nil { baselines[name] = value.map(Baseline.bytes) ?? .missing }; lock.unlock()
        return value
    }
    func write(_ name: String, data: Data?) throws {
        try NativeIdentityCustody.withSlot(name) {
        let generation = ledger.clock.snapshot(); try ledger.prepareWrite(data, generation: generation)
        lock.lock(); let expected = baselines[name]?.value; lock.unlock()
        guard try base.compareAndSwap(name, expected: expected, replacement: data) else { throw NativeAPIError.unavailable("operation_storage_changed") }
        lock.lock(); baselines[name] = data.map(Baseline.bytes) ?? .missing; lock.unlock()
        guard ledger.clock.snapshot() == generation else { throw NativeAPIError.sessionChanged }
        }
    }
    func compareAndSwap(_ name: String, expected: Data?, replacement: Data?) throws -> Bool {
        try NativeIdentityCustody.withSlot(name) {
        let generation = ledger.clock.snapshot(); try ledger.prepareWrite(replacement, generation: generation)
        guard try base.compareAndSwap(name, expected: expected, replacement: replacement) else { return false }
        lock.lock(); baselines[name] = replacement.map(Baseline.bytes) ?? .missing; lock.unlock()
        guard ledger.clock.snapshot() == generation else { throw NativeAPIError.sessionChanged }; return true
        }
    }
}
protocol NativeDeviceSigner: Sendable {
    var requiresLocalAuthentication: Bool { get }
    func sign(_ data: Data) throws -> String
    func sha256(_ data: Data) -> String
    func clear()
    func hasRetainedKey() throws -> Bool
    func hasKey(alias: String) throws -> Bool
    func publicJWK(alias: String, create: Bool) throws -> WireValue
    func sign(_ data: Data, alias: String) throws -> String
    func clear(alias: String)
    func removeOwnedKey(alias: String, publicJWK: WireValue) throws
    func keyExists(alias: String) throws -> Bool
    func clearConfirmed(alias: String) throws
    func sign(_ data: Data, alias: String, permit: NativeLocalSigningPermit) throws -> String
}
// Existing isolated protocol fixtures do not represent persistent key storage.
// Production and restart-capable fixtures override this noncreating query.
extension NativeDeviceSigner {
    var requiresLocalAuthentication: Bool { false }
    func hasRetainedKey() throws -> Bool { false }
    func hasKey(alias: String) throws -> Bool { (try? publicJWK(alias: alias, create: false)) != nil }
    func publicJWK(alias: String, create: Bool) throws -> WireValue { throw NativeAPIError.unsupported(String(localized: "This signer cannot manage a new device key.")) }
    func sign(_ data: Data, alias: String) throws -> String {
        guard alias == NativeEnrollmentRecord.keyAlias else { throw NativeAPIError.unsupported(String(localized: "The saved recovery device key is unavailable.")) }
        return try sign(data)
    }
    func clear(alias: String) { if alias == NativeEnrollmentRecord.keyAlias { clear() } }
    func removeOwnedKey(alias: String, publicJWK: WireValue) throws {
        guard try self.publicJWK(alias: alias, create: false).canonical() == publicJWK.canonical() else { throw NativeAPIError.unavailable("device_key_ownership_changed") }
        clear(alias: alias)
    }
    // Nonpersistent protocol fixtures retain their existing no-key behavior.
    // Production implements both operations with checked Keychain statuses.
    func keyExists(alias: String) throws -> Bool { alias == NativeEnrollmentRecord.keyAlias ? try hasRetainedKey() : (try? publicJWK(alias: alias, create: false)) != nil }
    func clearConfirmed(alias: String) throws { clear(alias: alias) }
    func sign(_ data: Data, alias: String, permit: NativeLocalSigningPermit) throws -> String {
        _ = try permit.require(data, alias: alias)
        return try sign(data, alias: alias)
    }
}
struct KeychainDeviceSigner: NativeDeviceSigner {
    var requiresLocalAuthentication: Bool { true }
    func sign(_ data: Data) throws -> String { try DeviceIdentity.sign(data) }
    func sha256(_ data: Data) -> String { DeviceIdentity.sha256(data) }
    func clear() { DeviceIdentity.clear() }
    func hasRetainedKey() throws -> Bool { try DeviceIdentity.hasOwnedKey() }
    func hasKey(alias: String) throws -> Bool { try DeviceIdentity.hasExistingKey(alias: alias) }
    func publicJWK(alias: String, create: Bool) throws -> WireValue { try DeviceIdentity.publicJWK(alias: alias, createIfMissing: create) }
    func sign(_ data: Data, alias: String) throws -> String { try DeviceIdentity.sign(data, alias: alias) }
    func clear(alias: String) { DeviceIdentity.clear(alias: alias) }
    func removeOwnedKey(alias: String, publicJWK: WireValue) throws { try DeviceIdentity.removeOwnedKey(alias: alias, publicJWK: publicJWK) }
    func keyExists(alias: String) throws -> Bool { try DeviceIdentity.hasExistingKey(alias: alias) }
    func clearConfirmed(alias: String) throws { try DeviceIdentity.clearConfirmed(alias: alias) }
    func sign(_ data: Data, alias: String, permit: NativeLocalSigningPermit) throws -> String {
        try DeviceIdentity.sign(data, alias: alias, permit: permit)
    }
}
struct KeychainSecretStore: NativeSecretStore {
    private let service = "com.lovelies.connected.private.v1"
    var authorityNamespace: String { "keychain:" + service }
    func read(_ name: String) throws -> Data? {
        let lock = NativeSecretStoreCAS.lock(authorityNamespace + ":" + name)
        lock.lock(); defer { lock.unlock() }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: name, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw NativeAPIError.unsupported(String(localized: "Protected storage is unavailable. Unlock this device and try again.")) }
        return data
    }
    func write(_ name: String, data: Data?) throws {
        let lock = NativeSecretStoreCAS.lock(authorityNamespace + ":" + name)
        lock.lock(); defer { lock.unlock() }
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
        guard status == errSecSuccess, result != nil else { throw NativeAPIError.unsupported(String(localized: "Unlock this device to check its existing face-verification key.")) }
        return true
    }
    static func key(alias: String = NativeEnrollmentRecord.keyAlias, createIfMissing: Bool = true, authenticationContext: LAContext? = nil) throws -> SecKey {
        try NativeIdentityCustody.withLock {
        let tag = try tag(alias)
        let context = authenticationContext ?? LAContext()
        // UI authorization happened asynchronously before repository work. A key
        // query/signature cannot start another prompt or bypass a cancelled one.
        context.interactionNotAllowed = true
        let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecReturnRef as String: true,
            kSecUseAuthenticationContext as String: context]
        var existing: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &existing)
        if status == errSecSuccess, let existing { return existing as! SecKey }
        guard status == errSecItemNotFound else { throw NativeAPIError.unsupported(String(localized: "Unlock your device to access its face-verification key.")) }
        guard createIfMissing else { throw NativeAPIError.unsupported(String(localized: "The original face-verification key is unavailable. Enrollment recovery cannot create a replacement key.")) }
        var attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]]
        #if !targetEnvironment(simulator)
        attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], nil) else { throw NativeAPIError.unsupported(String(localized: "Protected device-key access is unavailable.")) }
        attributes[kSecPrivateKeyAttrs as String] = [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag, kSecAttrAccessControl as String: access]
        #endif
        var error: Unmanaged<CFError>?
        guard let value = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw NativeAPIError.unsupported(String(localized: "This device could not create its protected verification key.")) }
        return value
        }
    }
    static func publicJWK(alias: String = NativeEnrollmentRecord.keyAlias, createIfMissing: Bool = true) throws -> WireValue {
        guard let publicKey = SecKeyCopyPublicKey(try key(alias: alias, createIfMissing: createIfMissing)), let data = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else { throw NativeAPIError.invalidResponse }
        let publicKeyValue = try P256.Signing.PublicKey(x963Representation: data)
        let raw = publicKeyValue.x963Representation
        guard raw.count == 65 else { throw NativeAPIError.invalidResponse }
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(raw.subdata(in: 1..<33).base64URL),
            "y": .string(raw.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
    static func sign(_ data: Data, alias: String = NativeEnrollmentRecord.keyAlias, permit: NativeLocalSigningPermit? = nil) throws -> String {
        guard let permit else { throw NativeLocalAuthenticationIssue.required }
        guard let context = try permit.require(data, alias: alias) else { throw NativeLocalAuthenticationIssue.required }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(try key(alias: alias, createIfMissing: false, authenticationContext: context), .ecdsaSignatureMessageX962SHA256, data as CFData, &error) as Data? else { throw NativeAPIError.unsupported(String(localized: "The device could not sign this capture. Unlock it and try again.")) }
        _ = try permit.require(data, alias: alias) // Cancellation cannot publish a late signature.
        return try P256.Signing.ECDSASignature(derRepresentation: signature).rawRepresentation.base64URL
    }
    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func clear(alias: String = NativeEnrollmentRecord.keyAlias) {
        NativeIdentityCustody.withLock {
        guard let tag = try? tag(alias) else { return }
        SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag, kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom] as CFDictionary)
        }
    }
    static func removeOwnedKey(alias: String, publicJWK expected: WireValue) throws {
        try NativeIdentityCustody.withLock {
            guard try hasExistingKey(alias: alias) else { return }
            guard try publicJWK(alias: alias, createIfMissing: false).canonical() == expected.canonical() else { throw NativeAPIError.unavailable("device_key_ownership_changed") }
            let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: try tag(alias), kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom]
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound, !(try hasExistingKey(alias: alias)) else { throw NativeAPIError.unavailable("device_key_retirement_unconfirmed") }
        }
    }
    static func clearConfirmed(alias: String) throws {
        let status = SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: try tag(alias), kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound, try !hasExistingKey(alias: alias) else { throw NativeAPIError.unavailable("protected_storage") }
    }
}
