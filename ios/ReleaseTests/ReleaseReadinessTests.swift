import XCTest
import Foundation
import Security
import CryptoKit
import ImageIO
import LocalAuthentication
import UIKit
@testable import Lovelies

final class ReleaseReadinessTests: XCTestCase {
    func testRegisteredDeletionRejectsAnotherReceiptAndFalseCompletion() throws {
        let account = UUID().uuidString.lowercased(), operation = UUID().uuidString.lowercased(), request = UUID().uuidString.lowercased()
        var receipt = NativeRegisteredDeletionRecord(accountID: account, operationKey: operation, statusToken: "lvd_" + String(repeating: "a", count: 64), apiOrigin: "https://fixture", preparedAt: Date())
        try receipt.validate(origin: URL(string: "https://fixture")!)
        func response(_ id: String, _ state: String, _ completed: Bool) -> WireValue { .object([
            "protocol": .string("lovelies-account-deletion-v1"), "source": .string("privacy"), "operation_key": .string(operation),
            "privacy_request": .object(["id": .string(id), "request_type": .string("delete"), "status": .string(state)]), "deletion_completed": .bool(completed)
        ]) }
        let pending = response(request, "pending_approval", false)
        try receipt.validateResponse(pending); receipt.response = pending
        XCTAssertFalse(receipt.completed)
        XCTAssertThrowsError(try receipt.validateResponse(response(UUID().uuidString, "completed", true)))
        XCTAssertThrowsError(try receipt.validateResponse(response(request, "processing", true)))
        try receipt.validateResponse(response(request, "completed", true))
        receipt.response = response(request, "completed", true); XCTAssertTrue(receipt.completed)
    }
    func testAccountLibraryIntentRoundTrip() throws {
        var state = NativeLibraryState(accountID: UUID().uuidString.lowercased())
        state.favoriteIDs = [UUID().uuidString.lowercased()]; state.anchor = state.favoriteIDs.first; state.columns = 4; state.destination = 15; state.query = "mountains"; state.category = "landscapes"
        let restored = try JSONDecoder().decode(NativeLibraryState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(restored.accountID, state.accountID); XCTAssertEqual(restored.favoriteIDs, state.favoriteIDs)
        XCTAssertEqual(restored.anchor, state.anchor); XCTAssertEqual(restored.columns, 4)
        XCTAssertEqual(restored.safeDestination, 15); XCTAssertEqual(restored.query, "mountains"); XCTAssertEqual(restored.category, "landscapes")
        state.destination = 23; XCTAssertNil(state.safeDestination)
        XCTAssertNil(restored.review) // Persistence never manufactures a server preview.
    }
    func testCancelledPublicationCannotPublish() {
        XCTAssertFalse(NativePublicationFence(generation: 3).permits(currentGeneration: 3, cancelled: true))
        XCTAssertFalse(NativePublicationFence(generation: 3).permits(currentGeneration: 4, cancelled: false))
    }

    /// Opt-in application-hosted repository/security-key HTTP check. Declared
    /// engineering JPEGs are not camera captures or recognition acceptance.
    func testOptInConnectedFaceRepositoryOnPhysicalDevice() async throws {
        guard let encoded = ProcessInfo.processInfo.environment["LOVELIES_CONNECTED_DEVICE_QA_JSON"] else {
            throw XCTSkip("Connected device check requires an explicit isolated, expiring run configuration.")
        }
        var stage = "configuration"
        var ownedSecrets: ConnectedDeviceQASecrets?
        var ownedSigner: ConnectedDeviceQASigner?
        var activeRepository: BackendRepository?
        var systemAuthorization: ConnectedDeviceQASystemAuthorization?
        do {
            let config = try ConnectedDeviceQAConfiguration(encoded)
            try ConnectedDeviceQA.require(ProcessInfo.processInfo.arguments.contains("--reference-preview"), "reference_host_required")
            #if targetEnvironment(simulator)
            throw ConnectedDeviceQA.Failure.check("physical_device_required")
            #else
            let secrets = ConnectedDeviceQASecrets(runID: config.runID)
            let signer = ConnectedDeviceQASigner(runID: config.runID)
            ownedSecrets = secrets; ownedSigner = signer
            try secrets.claimEmptyNamespace()
            try signer.claimEmptyAlias()
            let authorization = await ConnectedDeviceQASystemAuthorization()
            systemAuthorization = authorization
            stage = "readiness"
            try await ConnectedDeviceQA.readiness(config)
            let repository = BackendRepository(origin: config.origin, transport: NativeURLTransport(), secrets: secrets, signer: signer)
            activeRepository = repository
            stage = "anonymous_admission"
            try config.requireCurrent()
            let initial = try await authorization.perform(repository, purpose: .connect, config: config) { grant in
                try ConnectedDeviceQA.require(grant == nil, "anonymous_bootstrap_must_not_prompt")
                return try await repository.bootstrap()
            }
            guard let anonymous = initial else { throw ConnectedDeviceQA.Failure.check("anonymous_session_missing") }
            try ConnectedDeviceQA.require(!anonymous.authenticated && anonymous.roles == ["user"], "anonymous_authority_changed")
            let denied = try await ConnectedDeviceQA.request(config, path: "/community/action", method: "POST", secrets: secrets,
                body: .object(["action": .string("photos"), "payload": .object(["source": .string("all")])]))
            try ConnectedDeviceQA.require(denied.status == 403, "anonymous_gallery_not_denied")
            let unknown = try await repository.audience()
            try ConnectedDeviceQA.require(unknown.accountID == anonymous.accountID && unknown.ageBand == .unknown && unknown.version == 0, "initial_audience_changed")
            let adult = try await repository.declareAudience(.adult, expectedVersion: 0)
            try ConnectedDeviceQA.require(adult.accountID == anonymous.accountID && adult.ageBand == .adult && adult.status == .eligible && adult.version == 1 && adult.policyVersion == NativeAudienceProjection.policy, "adult_admission_changed")
            try adult.require(.faceAuthentication)
            let pendingAudience = try await repository.pendingAudienceMutation()
            try ConnectedDeviceQA.require(pendingAudience == nil, "audience_operation_unconfirmed")
            stage = "three_still_enrollment"
            try config.requireCurrent()
            let enrollment = try await authorization.perform(repository, purpose: .enrollment, config: config, grantRequired: true) { _ in
                let publicKey = try signer.publicJWK(alias: NativeEnrollmentRecord.keyAlias, create: true)
                try signer.requireSecureEnclaveKey()
                let policy = try await repository.policy()
                return try await repository.startFace(consentPolicy: policy, publicKey: publicKey)
            }
            let keyDigest = signer.sha256(try signer.publicJWK(alias: NativeEnrollmentRecord.keyAlias, create: false).canonical())
            try ConnectedDeviceQA.require(enrollment.accountID == anonymous.accountID && enrollment.purpose == "registration" && enrollment.poses == ["front", "left", "right"], "enrollment_binding_changed")
            var captures: [WireValue] = []
            for (index, name) in ["a0", "a1", "a2"].enumerated() {
                try config.requireCurrent()
                captures.append(try await authorization.perform(repository, purpose: .capture, config: config, grantRequired: true) { _ in
                    try await repository.capture(try config.jpeg(name), index: index, challenge: enrollment)
                })
            }
            let enrollmentReceipts = captures
            let registered = try await authorization.perform(repository, purpose: .reconciliation, config: config, grantRequired: true) { _ in
                try await repository.completeFace(enrollment, captures: enrollmentReceipts)
            }
            guard let originalDevice = try await repository.device() else { throw ConnectedDeviceQA.Failure.check("registered_device_missing") }
            try ConnectedDeviceQA.require(registered.authenticated && registered.accountID == anonymous.accountID && originalDevice.accountID == anonymous.accountID && originalDevice.profileID != nil && originalDevice.profileRevision != nil, "same_account_upgrade_missing")
            stage = "logout_and_retained_state"
            try await authorization.perform(repository, purpose: .connect, config: config) { _ in try await repository.logout() }
            activeRepository = nil
            let loggedOut = await repository.summary()
            try ConnectedDeviceQA.require(loggedOut == nil && (try secrets.read("credentials")) == nil && (try signer.hasRetainedKey()), "logout_or_retained_key_changed")
            // A new actor restores only this run's actual Keychain records/key.
            let returning = BackendRepository(origin: config.origin, transport: NativeURLTransport(), secrets: secrets, signer: signer)
            activeRepository = returning
            let restored = try await authorization.perform(returning, purpose: .connect, config: config) { _ in try await returning.bootstrap() }
            guard let retained = try await returning.device() else { throw ConnectedDeviceQA.Failure.check("retained_device_missing") }
            try ConnectedDeviceQA.require(restored == nil && retained.accountID == originalDevice.accountID && retained.deviceID == originalDevice.deviceID && retained.faceHandle == originalDevice.faceHandle && retained.profileID == originalDevice.profileID && retained.profileRevision == originalDevice.profileRevision && retained.modelID == originalDevice.modelID, "retained_identity_changed")
            let retainedPublicKey = try signer.publicJWK(alias: NativeEnrollmentRecord.keyAlias, create: false)
            try ConnectedDeviceQA.require(signer.sha256(try retainedPublicKey.canonical()) == keyDigest, "retained_key_changed")
            stage = "single_still_returning_login"
            try config.requireCurrent()
            let login = try await authorization.perform(returning, purpose: .enrollment, config: config, grantRequired: true) { _ in
                let currentPolicy = try await returning.policy()
                return try await returning.startFace(consentPolicy: currentPolicy, publicKey: retainedPublicKey)
            }
            try ConnectedDeviceQA.require(login.purpose == "login" && login.poses == ["front"] && login.accountID == anonymous.accountID && login.deviceID == originalDevice.deviceID && login.id != enrollment.id && login.wire["profile_id"].string == originalDevice.profileID && login.wire["profile_revision"].string == originalDevice.profileRevision && login.wire["model_id"].string == originalDevice.modelID, "returning_challenge_binding_changed")
            let freshCapture = try await authorization.perform(returning, purpose: .capture, config: config, grantRequired: true) { _ in
                try await returning.capture(try config.jpeg("a5"), index: 0, challenge: login)
            }
            let signedIn = try await authorization.perform(returning, purpose: .reconciliation, config: config, grantRequired: true) { _ in
                try await returning.completeFace(login, captures: [freshCapture])
            }
            try ConnectedDeviceQA.require(signedIn.authenticated && signedIn.accountID == anonymous.accountID, "returning_account_changed")
            stage = "consumed_challenge_replay"
            var envelope = login.deviceEnvelope()
            envelope["step"] = .string("complete"); envelope["capture_manifest"] = .array([freshCapture])
            let replayBytes = try WireValue.object(envelope).canonical()
            let replay = try await authorization.perform(returning, purpose: .reconciliation, config: config, grantRequired: true) { grant in
                guard let grant else { throw NativeLocalAuthenticationIssue.required }
                let permit = try grant.permit(replayBytes, alias: NativeEnrollmentRecord.keyAlias,
                                             epoch: grant.binding.epoch, operationID: grant.binding.operationID)
                let signature = try signer.sign(replayBytes, alias: NativeEnrollmentRecord.keyAlias, permit: permit)
                _ = try permit.require(replayBytes, alias: NativeEnrollmentRecord.keyAlias)
                return try await ConnectedDeviceQA.request(config, path: "/auth/face/complete", method: "POST", secrets: secrets,
                    body: .object(["challenge_id": .string(login.id), "device_signature": .string(signature)]))
            }
            try ConnectedDeviceQA.require([401, 409].contains(replay.status), "consumed_challenge_replay_not_denied")
            let current = try await returning.current()
            try ConnectedDeviceQA.require(current["authenticated"].bool == true && current["user_id"].string == anonymous.accountID, "replay_changed_current_authority")
            stage = "final_logout"
            try await authorization.perform(returning, purpose: .connect, config: config) { _ in try await returning.logout() }
            activeRepository = nil
            let finalSession = await returning.summary()
            try ConnectedDeviceQA.require(finalSession == nil && (try secrets.read("credentials")) == nil, "final_session_not_retired")
            #endif
        } catch {
            // Framework errors may contain a URL or server detail. Keep failures
            // stage-bound, with no credentials, handles, signatures or image data.
            let code = (error as? ConnectedDeviceQA.Failure)?.safeCode ?? "repository_or_platform_failure"
            XCTFail("Connected physical repository check failed at " + stage + ": " + code)
        }
        if let activeRepository {
            do {
                guard let systemAuthorization else { throw NativeLocalAuthenticationIssue.required }
                try await systemAuthorization.performCleanup(activeRepository)
            }
            catch { XCTFail("Connected physical repository cleanup could not confirm its own session logout.") }
        }
        await systemAuthorization?.close()
        do { try ownedSecrets?.cleanupOwnedItems() }
        catch { XCTFail("Connected physical repository cleanup could not confirm removal of its own Keychain items.") }
        do { try ownedSigner?.cleanupOwnedKey() }
        catch { XCTFail("Connected physical repository cleanup could not confirm removal of its own device key.") }
    }
}

private enum ConnectedDeviceQA {
    enum Failure: Error {
        case check(String)
        var safeCode: String { switch self { case .check(let code): return code } }
    }
    static func require(_ value: @autoclosure () throws -> Bool, _ code: String) throws {
        guard try value() else { throw Failure.check(code) }
    }
    static func request(_ config: ConnectedDeviceQAConfiguration, path: String, method: String = "GET",
                        secrets: ConnectedDeviceQASecrets? = nil, body: WireValue? = nil) async throws -> NativeHTTPReply {
        try config.requireCurrent()
        try require(path.hasPrefix("/") && !path.hasPrefix("//") && !path.contains("?") && !path.contains("#"), "request_path_changed")
        guard var components = URLComponents(url: config.origin, resolvingAgainstBaseURL: false) else { throw Failure.check("origin_invalid") }
        components.path = (config.origin.path == "/" ? "" : config.origin.path) + path
        guard let url = components.url, url.scheme == "https", url.host == config.origin.host, url.port == config.origin.port else { throw Failure.check("request_origin_changed") }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let secrets {
            guard let data = try secrets.read("credentials") else { throw Failure.check("owned_credentials_missing") }
            let credential = try JSONDecoder().decode(NativeCredentials.self, from: data)
            try require(credential.expiresAt > Date(), "owned_credentials_expired")
            request.setValue("Bearer " + credential.access_token, forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try body.encoded()
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await NativeURLTransport().send(request, limit: 64 * 1024)
    }
    static func readiness(_ config: ConnectedDeviceQAConfiguration) async throws {
        for path in ["/health", "/ready"] {
            let response = try await request(config, path: path)
            try require(response.status == 200, "isolated_api_not_ready")
            let value = try WireValue.decoded(response.data)
            try require(value["status"].string == "ok" && value["service"].string == "lovelies-supabase-api" && value["database"].string == "supabase_postgresql" && value["database_ready"].bool == true && value["liveness_required"].bool == false, "isolated_api_readiness_contract_changed")
            if path == "/ready" { try require(value["inference_ready"].bool == true && value["missing"].array?.isEmpty == true, "actual_inference_readiness_missing") }
        }
    }
}

private struct ConnectedDeviceQAConfiguration {
    let origin: URL, runID: String, expires: Date
    private let images: [String: Data]
    init(_ encoded: String) throws {
        let bytes = Data(encoded.utf8)
        try ConnectedDeviceQA.require(!bytes.isEmpty && bytes.count <= 256 * 1024, "configuration_size_invalid")
        let value = try WireValue.decoded(bytes)
        try NativeAudienceProjection.keys(value, ["schema", "api_origin", "run_id", "expires_at", "engineering_stills", "fixtures"])
        try ConnectedDeviceQA.require(value["schema"].integer == 1 && value["engineering_stills"].bool == true, "engineering_configuration_required")
        let run = try value.text("run_id", maximum: 36)
        guard let uuid = UUID(uuidString: run), uuid.uuidString.lowercased() == run else { throw ConnectedDeviceQA.Failure.check("run_uuid_invalid") }
        runID = run
        let endpoint = try value.text("api_origin", maximum: 512)
        guard let components = URLComponents(string: endpoint), let url = components.url,
              components.scheme == "https", let host = components.host?.lowercased(),
              !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil, components.port == nil || components.port == 443,
              ["", "/", "/functions/v1/lovelies-api"].contains(components.percentEncodedPath),
              host != "ltqfplqevxztlswlzexn.supabase.co", host != "lovelies-supabase-inference.ikanisa.workers.dev",
              !["localhost", "127.0.0.1", "::1"].contains(host), !host.hasSuffix(".")
        else { throw ConnectedDeviceQA.Failure.check("explicit_isolated_https_origin_required") }
        origin = url
        let parsedExpiry = try NativeRefreshDeliveryRecord.date(value["expires_at"])
        try ConnectedDeviceQA.require(parsedExpiry > Date() && parsedExpiry.timeIntervalSinceNow <= 30 * 60, "configuration_expiry_invalid")
        expires = parsedExpiry
        try NativeAudienceProjection.keys(value["fixtures"], ["a0", "a1", "a2", "a5"])
        var decoded: [String: Data] = [:], hashes = Set<String>(), total = 0
        for name in ["a0", "a1", "a2", "a5"] {
            let fixture = value["fixtures"][name]
            try NativeAudienceProjection.keys(fixture, ["base64", "sha256", "bytes"])
            let digest = try fixture.text("sha256", maximum: 64)
            guard digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                  let length = fixture["bytes"].integer, length > 0, length <= 8 * 1024 * 1024,
                  let base64 = fixture["base64"].string, let raw = Data(base64Encoded: base64),
                  raw.count == length, raw.base64EncodedString() == base64,
                  raw.starts(with: [0xff, 0xd8, 0xff]), raw.suffix(2) == Data([0xff, 0xd9]),
                  DeviceIdentity.sha256(raw) == digest,
                  let image = CGImageSourceCreateWithData(raw as CFData, nil), CGImageSourceGetCount(image) == 1,
                  (CGImageSourceGetType(image) as String?) == "public.jpeg"
            else { throw ConnectedDeviceQA.Failure.check("declared_jpeg_invalid") }
            total += raw.count; hashes.insert(digest); decoded[name] = raw
        }
        try ConnectedDeviceQA.require(total <= 8 * 1024 * 1024 && hashes.count == 4, "distinct_bounded_engineering_stills_required")
        images = decoded
    }
    func requireCurrent() throws { try ConnectedDeviceQA.require(expires > Date(), "configuration_expired") }
    func jpeg(_ name: String) throws -> Data {
        try requireCurrent()
        guard let image = images[name] else { throw ConnectedDeviceQA.Failure.check("undeclared_fixture_requested") }
        return image
    }
}

/// A dedicated test service, never the installed application's fixed vault.
private final class ConnectedDeviceQASecrets: NativeSecretStore, @unchecked Sendable {
    private let service: String
    private let lock = NSRecursiveLock()
    private var claimed = false
    private var created = Set<String>()
    init(runID: String) { service = "com.lovelies.connected.qa." + runID }
    private func query(_ name: String? = nil) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let name { query[kSecAttrAccount as String] = name }
        return query
    }
    func claimEmptyNamespace() throws {
        lock.lock(); defer { lock.unlock() }
        try ConnectedDeviceQA.require(!claimed && SecItemCopyMatching(query() as CFDictionary, nil) == errSecItemNotFound, "test_keychain_namespace_not_empty")
        claimed = true
    }
    func read(_ name: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        try ConnectedDeviceQA.require(claimed && !name.isEmpty && name.utf8.count <= 128, "unowned_keychain_read")
        var request = query(name)
        request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw ConnectedDeviceQA.Failure.check("test_keychain_read_failed") }
        return data
    }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        try ConnectedDeviceQA.require(claimed && !name.isEmpty && name.utf8.count <= 128 && (data?.count ?? 0) <= 2 * 1024 * 1024, "unowned_keychain_write")
        let existing = try read(name)
        try ConnectedDeviceQA.require(existing == nil || created.contains(name), "untracked_keychain_item_found")
        guard let data else {
            if created.contains(name) {
                let status = SecItemDelete(query(name) as CFDictionary)
                try ConnectedDeviceQA.require(status == errSecSuccess || status == errSecItemNotFound, "test_keychain_delete_failed")
            }
            return
        }
        if existing != nil {
            let status = SecItemUpdate(query(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            try ConnectedDeviceQA.require(status == errSecSuccess, "test_keychain_update_failed")
        } else {
            var item = query(name)
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            try ConnectedDeviceQA.require(SecItemAdd(item as CFDictionary, nil) == errSecSuccess, "test_keychain_add_failed")
            created.insert(name)
        }
    }
    func cleanupOwnedItems() throws {
        lock.lock(); defer { lock.unlock() }
        guard claimed else { return }
        for name in created {
            let status = SecItemDelete(query(name) as CFDictionary)
            try ConnectedDeviceQA.require(status == errSecSuccess || status == errSecItemNotFound, "owned_keychain_cleanup_failed")
        }
        try ConnectedDeviceQA.require(SecItemCopyMatching(query() as CFDictionary, nil) == errSecItemNotFound, "owned_keychain_cleanup_not_confirmed")
    }
}

/// This opt-in physical lane uses real system authorization. It cannot auto-pass
/// Face ID, Touch ID or passcode, and it never substitutes a fixture authorizer.
@MainActor
private final class ConnectedDeviceQASystemAuthorization {
    private let authenticator = NativeLocalAuthenticator()
    private var observers: [NSObjectProtocol] = []
    private var generation = 0
    private var busy = false
    init() {
        observers = [UIApplication.didEnterBackgroundNotification, UIApplication.willTerminateNotification].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.generation += 1; self?.authenticator.invalidate() }
            }
        }
    }
    func perform<T>(_ repository: BackendRepository, purpose: NativeLocalAuthenticationPurpose,
                    config: ConnectedDeviceQAConfiguration? = nil, grantRequired: Bool = false,
                    _ work: (NativeLocalSigningLease?) async throws -> T) async throws -> T {
        guard !busy, UIApplication.shared.applicationState == .active else { throw NativeLocalAuthenticationIssue.required }
        busy = true; defer { busy = false }
        let operationID = UUID(), expectedGeneration = generation
        var lease: NativeLocalSigningLease?
        do {
            try config?.requireCurrent(); try Task.checkCancellation()
            if let request = try await repository.prepareLocalSigning(purpose: purpose, operationID: operationID) {
                lease = try await authenticator.authorize(request)
                // The expected system sheet can make the scene inactive. True
                // background invalidates the real context and this generation.
                let deadline = ProcessInfo.processInfo.systemUptime + 5
                while UIApplication.shared.applicationState != .active {
                    guard generation == expectedGeneration, ProcessInfo.processInfo.systemUptime < deadline else { throw NativeLocalAuthenticationIssue.cancelled }
                    try await Task.sleep(for: .milliseconds(25))
                }
                guard generation == expectedGeneration, let lease else { throw NativeLocalAuthenticationIssue.cancelled }
                try await repository.installLocalSigning(lease)
            }
            guard !grantRequired || lease != nil, generation == expectedGeneration,
                  UIApplication.shared.applicationState == .active else { throw NativeLocalAuthenticationIssue.required }
            try config?.requireCurrent(); try Task.checkCancellation()
            let result = try await NativeLocalSigningOperation.$id.withValue(operationID) {
                try await NativeLocalSigningOperation.$purpose.withValue(purpose) { try await work(lease) }
            }
            guard generation == expectedGeneration, UIApplication.shared.applicationState == .active else { throw NativeLocalAuthenticationIssue.cancelled }
            try config?.requireCurrent(); try Task.checkCancellation()
            lease?.retire(); await repository.finishLocalSigning(operationID: operationID)
            return result
        } catch {
            lease?.invalidate(); authenticator.invalidate()
            await repository.finishLocalSigning(operationID: operationID)
            throw error
        }
    }
    func performCleanup(_ repository: BackendRepository) async throws {
        try await perform(repository, purpose: .connect) { _ in try await repository.logout() }
    }
    func close() {
        generation += 1; authenticator.invalidate()
        observers.forEach(NotificationCenter.default.removeObserver); observers = []
    }
}

/// Only the logical enrollment alias is mapped to this run's one physical tag.
private final class ConnectedDeviceQASigner: NativeDeviceSigner, @unchecked Sendable {
    private let ownedAlias: String
    private let lock = NSRecursiveLock()
    private var claimed = false, creationAttempted = false
    var requiresLocalAuthentication: Bool { true }
    init(runID: String) { ownedAlias = NativeAccountRecoveryRecord.aliasPrefix + runID }
    func claimEmptyAlias() throws {
        lock.lock(); defer { lock.unlock() }
        try ConnectedDeviceQA.require(!claimed && !(try DeviceIdentity.hasExistingKey(alias: ownedAlias)), "test_key_alias_not_empty")
        claimed = true
    }
    func hasRetainedKey() throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        try ConnectedDeviceQA.require(claimed, "unowned_key_lookup")
        return try DeviceIdentity.hasExistingKey(alias: ownedAlias)
    }
    func sha256(_ data: Data) -> String { DeviceIdentity.sha256(data) }
    func publicJWK(alias: String, create: Bool) throws -> WireValue {
        lock.lock(); defer { lock.unlock() }
        try ConnectedDeviceQA.require(claimed && alias == NativeEnrollmentRecord.keyAlias, "foreign_key_alias_rejected")
        if create { creationAttempted = true }
        return try DeviceIdentity.publicJWK(alias: ownedAlias, createIfMissing: create)
    }
    func sign(_ data: Data) throws -> String { throw NativeLocalAuthenticationIssue.required }
    func sign(_ data: Data, alias: String) throws -> String {
        throw NativeLocalAuthenticationIssue.required
    }
    func sign(_ data: Data, alias: String, permit: NativeLocalSigningPermit) throws -> String {
        lock.lock(); defer { lock.unlock() }
        try ConnectedDeviceQA.require(claimed && alias == NativeEnrollmentRecord.keyAlias, "foreign_key_alias_rejected")
        guard let context = try permit.require(data, alias: alias) else { throw NativeLocalAuthenticationIssue.required }
        var error: Unmanaged<CFError>?
        let key = try DeviceIdentity.key(alias: ownedAlias, createIfMissing: false, authenticationContext: context)
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, &error) as Data? else {
            throw ConnectedDeviceQA.Failure.check("owned_signature_unavailable")
        }
        _ = try permit.require(data, alias: alias)
        return try P256.Signing.ECDSASignature(derRepresentation: signature).rawRepresentation.base64URL
    }
    func requireSecureEnclaveKey() throws {
        let key = try DeviceIdentity.key(alias: ownedAlias, createIfMissing: false)
        guard let attributes = SecKeyCopyAttributes(key) as? [String: Any],
              attributes[kSecAttrTokenID as String] as? String == kSecAttrTokenIDSecureEnclave as String
        else { throw ConnectedDeviceQA.Failure.check("physical_secure_enclave_key_required") }
    }
    func clear() {
        lock.lock(); defer { lock.unlock() }
        if claimed && creationAttempted { DeviceIdentity.clear(alias: ownedAlias) }
    }
    func clear(alias: String) { if alias == NativeEnrollmentRecord.keyAlias { clear() } }
    func cleanupOwnedKey() throws {
        lock.lock(); defer { lock.unlock() }
        guard claimed && creationAttempted else { return }
        DeviceIdentity.clear(alias: ownedAlias)
        try ConnectedDeviceQA.require(!(try DeviceIdentity.hasExistingKey(alias: ownedAlias)), "owned_key_cleanup_not_confirmed")
    }
}

// Synthetic same-account test of the actual LiveAppStore and repository path.
// The transport is in-memory and the test creates only its own temporary folder.
private final class PhotoShareSelectionSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var slots: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return slots[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; slots[name] = data }
}
private struct PhotoShareSelectionSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
}
private actor PhotoShareSelectionGate {
    private var opened = false
    private var waiter: CheckedContinuation<Void, Never>?
    func hold() async {
        if opened { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func open() { opened = true; waiter?.resume(); waiter = nil }
}
private actor PhotoShareSelectionTransport: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000091"
    static let ticket = "00000000-0000-4000-8000-000000000092"
    static let assetA = "00000000-0000-4000-8000-000000000093"
    let gate: PhotoShareSelectionGate, reached: XCTestExpectation?
    private(set) var signCount = 0, downloadCount = 0
    init(gate: PhotoShareSelectionGate, reached: XCTestExpectation?) { self.gate = gate; self.reached = reached }
    nonisolated func cancelPending() {}
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        func json(_ value: WireValue) throws -> NativeHTTPReply {
            .init(status: 200, headers: ["content-type": "application/json"], data: try value.encoded())
        }
        switch request.url!.path {
        case "/me":
            return try json(.object(["user_id": .string(Self.account), "auth_method": .string("registered_face"), "authenticated": .bool(true)]))
        case "/me/audience":
            return try json(.object(["protocol": .string(NativeAudienceProjection.protocolName), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(Self.account),
                "audience": .object(["age_band": .string("18_plus"), "status": .string("eligible"), "version": .integer(1), "policy_version": .string(NativeAudienceProjection.policy), "next_review_at": .null]),
                "guardian_request": .null, "capabilities": .object(["face_authentication": .bool(true), "photo_matching": .bool(true), "photo_processing": .bool(true)])]))
        case "/downloads/sign":
            signCount += 1
            let body = try WireValue.decoded(request.httpBody!)
            guard let asset = body["asset_id"].string,
                  [Self.assetA, "00000000-0000-4000-8000-000000000094"].contains(asset),
                  body["operation_key"].string != nil else { throw NativeAPIError.invalidResponse }
            return try json(.object(["method": .string("GET"), "download_url": .string("https://fixture.invalid/downloads/" + Self.ticket),
                                     "expires_in": .integer(120), "source_version": .string("source-v1")]))
        case "/downloads/" + Self.ticket:
            downloadCount += 1; reached?.fulfill(); await gate.hold()
            return .init(status: 200, headers: ["content-type": "image/png"], data: Data([0x89, 0x50, 0x4e, 0x47, 0x01]))
        default: throw NativeAPIError.invalidResponse
        }
    }
}

@MainActor private final class PhotoShareSelectionSaver {
    private(set) var attempts = 0, dispatched = 0
    var permissionGate: PhotoShareSelectionGate?
    var permissionReached: XCTestExpectation?
    func save(_ bytes: Data, requireCurrent: @escaping @MainActor () async throws -> Void) async throws {
        attempts += 1
        try await requireCurrent()
        if let permissionGate {
            permissionReached?.fulfill()
            await permissionGate.hold()
        }
        try await requireCurrent()
        dispatched += 1
    }
}

@MainActor final class PhotoShareSelectionIntegrationTests: XCTestCase {
    private func photo(_ id: String, _ version: String) throws -> NativePhoto {
        try NativePhoto(.object(["id": .string(id), "title": .string("Synthetic photo"), "media_source": .string("personal"), "version": .string(version)]))
    }
    private func waitUntilIdle(_ store: LiveAppStore) async throws {
        for _ in 0..<500 {
            if !store.busy { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Synthetic operation did not become idle")
        throw NativeAPIError.unavailable("synthetic_test_timeout")
    }
    private func makeStore(_ reached: XCTestExpectation?, saver: PhotoShareSelectionSaver) async throws -> (LiveAppStore, PhotoShareSelectionGate, PhotoShareSelectionTransport, URL) {
        let gate = PhotoShareSelectionGate(), vault = PhotoShareSelectionSecrets()
        let transport = PhotoShareSelectionTransport(gate: gate, reached: reached)
        let now = Date(), lifetime = 900
        let claims: WireValue = .object(["sub": .string(PhotoShareSelectionTransport.account), "auth_method": .string("registered_face"), "exp": .integer(Int(now.timeIntervalSince1970) + lifetime + 1)])
        let credential = try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("synthetic-selection-refresh"),
            "account_id": .string(PhotoShareSelectionTransport.account), "auth_method": .string("registered_face"), "expires_in": .integer(lifetime), "roles": .strings(["user"])]), now: now)
        try vault.write("credentials", data: JSONEncoder().encode(credential))
        let repository = BackendRepository(origin: URL(string: "https://fixture.invalid")!, transport: transport, secrets: vault, signer: PhotoShareSelectionSigner())
        _ = try await repository.bootstrap()
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-selection-test-" + UUID().uuidString, isDirectory: true)
        let store = LiveAppStore(sharedFiles: NativeAuthorizedShareFiles(directory: scratch), repository: repository,
            savePhotoToLibrary: { bytes, requireCurrent in try await saver.save(bytes, requireCurrent: requireCurrent) })
        store.refreshAudience(); try await waitUntilIdle(store)
        XCTAssertEqual(store.session?.accountID, PhotoShareSelectionTransport.account)
        XCTAssertTrue(store.session?.authenticated == true)
        return (store, gate, transport, scratch)
    }
    private func cleanup(_ store: LiveAppStore, scratch: URL) throws {
        // This per-test directory is newly generated and contains only the
        // synthetic file, if the actual app share path produced one.
        store.retireSharedFile()
        if FileManager.default.fileExists(atPath: scratch.path) { try FileManager.default.removeItem(at: scratch) }
    }
    func testActualShareAndSaveRejectStaleSelectedPhoto() async throws {
        let assetA = PhotoShareSelectionTransport.assetA, assetB = "00000000-0000-4000-8000-000000000094"
        let a = try photo(assetA, "source-v1"), b = try photo(assetB, "source-v1"), newVersion = try photo(assetA, "source-v2")
        for action in ["share", "save"] {
            for mode in ["A-B", "A-B-A", "A-new-version", "unchanged"] {
                let reached = expectation(description: "Synthetic download reached for " + action + " " + mode)
                let saver = PhotoShareSelectionSaver()
                let (store, gate, transport, scratch) = try await makeStore(reached, saver: saver)
                store.currentPhoto = a
                if action == "share" { store.shareCurrentPhoto() } else { store.saveCurrentPhoto() }
                await fulfillment(of: [reached], timeout: 5)
                switch mode {
                case "A-B": store.currentPhoto = b
                case "A-B-A": store.currentPhoto = b; store.currentPhoto = a
                case "A-new-version": store.currentPhoto = newVersion
                default: break
                }
                await gate.open(); try await waitUntilIdle(store)
                let downloaded = await transport.downloadCount
                XCTAssertEqual(downloaded, 1)
                if mode == "unchanged" && action == "share" {
                    guard let file = store.sharedFile else { XCTFail("Unchanged selection did not reach its own share slot"); try cleanup(store, scratch: scratch); continue }
                    XCTAssertEqual(try Data(contentsOf: file.url), Data([0x89, 0x50, 0x4e, 0x47, 0x01]))
                } else if mode == "unchanged" {
                    XCTAssertEqual(saver.attempts, 1); XCTAssertEqual(saver.dispatched, 1)
                } else {
                    XCTAssertNil(store.sharedFile, "Old bytes must not be shared after \(mode)")
                    XCTAssertNotNil(store.error, "The stale operation must not report success")
                    if action == "save" { XCTAssertEqual(saver.dispatched, 0, "Old bytes must not be dispatched to the fake Photos handoff") }
                }
                try cleanup(store, scratch: scratch)
            }
        }
    }
    func testSelectionChangesBeforeWorkStartsDoNotFetchAnotherPhoto() async throws {
        let a = try photo(PhotoShareSelectionTransport.assetA, "source-v1")
        let b = try photo("00000000-0000-4000-8000-000000000094", "source-v1")
        for action in ["share", "save"] {
            for returnToA in [false, true] {
                let saver = PhotoShareSelectionSaver()
                let (store, gate, transport, scratch) = try await makeStore(nil, saver: saver)
                await gate.open()
                store.currentPhoto = a
                if action == "share" { store.shareCurrentPhoto() } else { store.saveCurrentPhoto() }
                // The test remains on MainActor, so the scheduled work has not
                // yet run when these selection changes are published.
                store.currentPhoto = b
                if returnToA { store.currentPhoto = a }
                try await waitUntilIdle(store)
                let signed = await transport.signCount, downloaded = await transport.downloadCount
                XCTAssertEqual(signed, 0); XCTAssertEqual(downloaded, 0)
                XCTAssertEqual(saver.dispatched, 0)
                XCTAssertNil(store.sharedFile); XCTAssertNotNil(store.error)
                try cleanup(store, scratch: scratch)
            }
        }
    }
    func testSelectionChangeDuringSavePermissionWaitIsRechecked() async throws {
        let a = try photo(PhotoShareSelectionTransport.assetA, "source-v1")
        let b = try photo("00000000-0000-4000-8000-000000000094", "source-v1")
        let downloadReached = expectation(description: "Synthetic download ready")
        let permissionReached = expectation(description: "Synthetic permission handoff")
        let saver = PhotoShareSelectionSaver(), permissionGate = PhotoShareSelectionGate()
        saver.permissionGate = permissionGate; saver.permissionReached = permissionReached
        let (store, downloadGate, _, scratch) = try await makeStore(downloadReached, saver: saver)
        store.currentPhoto = a; store.saveCurrentPhoto()
        await fulfillment(of: [downloadReached], timeout: 5); await downloadGate.open()
        await fulfillment(of: [permissionReached], timeout: 5)
        store.currentPhoto = b; await permissionGate.open(); try await waitUntilIdle(store)
        XCTAssertEqual(saver.attempts, 1); XCTAssertEqual(saver.dispatched, 0)
        XCTAssertNotNil(store.error)
        try cleanup(store, scratch: scratch)
    }
}
