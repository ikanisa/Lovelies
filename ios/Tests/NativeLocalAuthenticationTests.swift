import Foundation
import CryptoKit
import LocalAuthentication

// Controlled host proof only. Fake OS authorization and software keys do not
// establish Face ID/Touch ID, Secure Enclave ACL, optical or store acceptance.
private final class LocalAuthClock: @unchecked Sendable {
    private let lock = NSLock(); private var value: TimeInterval = 100
    func now() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ next: TimeInterval) { lock.lock(); value = next; lock.unlock() }
}
private final class LocalAuthSession: NativeLocalAuthenticationSession, @unchecked Sendable {
    private let lock = NSLock()
    private var invalid = false, evaluations = 0
    let failure: NativeLocalAuthenticationIssue?
    init(failure: NativeLocalAuthenticationIssue? = nil) { self.failure = failure }
    var keychainContext: LAContext? { nil }
    var count: Int { lock.lock(); defer { lock.unlock() }; return evaluations }
    var invalidated: Bool { lock.lock(); defer { lock.unlock() }; return invalid }
    private func evaluated() { lock.lock(); evaluations += 1; lock.unlock() }
    func authenticate(reason: String) async throws { evaluated(); if let failure { throw failure } }
    func invalidate() { lock.lock(); invalid = true; lock.unlock() }
}
private final class HeldLocalAuthSession: NativeLocalAuthenticationSession, @unchecked Sendable {
    private let lock = NSLock()
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var result: CheckedContinuation<Void, any Error>?
    var keychainContext: LAContext? { nil }
    private func begin(_ continuation: CheckedContinuation<Void, any Error>) {
        lock.lock(); result = continuation; started = true; let waiters = startWaiters; startWaiters = []; lock.unlock()
        waiters.forEach { $0.resume() }
    }
    func authenticate(reason: String) async throws {
        try await withCheckedThrowingContinuation { begin($0) }
    }
    func waitUntilStarted() async {
        await withCheckedContinuation { continuation in
            lock.lock(); if started { lock.unlock(); continuation.resume() }
            else { startWaiters.append(continuation); lock.unlock() }
        }
    }
    func invalidate() {
        lock.lock(); let held = result; result = nil; lock.unlock()
        held?.resume(throwing: NativeLocalAuthenticationIssue.cancelled)
    }
}
private final class LocalAuthSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock(); private var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); values[name] = data; lock.unlock() }
    func snapshot() -> [String: Data] { lock.lock(); defer { lock.unlock() }; return values }
}
private final class LocalAuthSigner: NativeDeviceSigner, @unchecked Sendable {
    let key = P256.Signing.PrivateKey()
    private let lock = NSLock(); private var signed = 0, deleted = 0, creates = 0, lookupUnavailable = false
    let requiresLocalAuthentication = true
    var signCount: Int { lock.lock(); defer { lock.unlock() }; return signed }
    var clearCount: Int { lock.lock(); defer { lock.unlock() }; return deleted }
    var createCount: Int { lock.lock(); defer { lock.unlock() }; return creates }
    func unavailableLookup() { lock.lock(); lookupUnavailable = true; lock.unlock() }
    var jwk: WireValue {
        let raw = key.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(raw.subdata(in: 1..<33).base64URL),
                        "y": .string(raw.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
    func sign(_ data: Data) throws -> String { throw NativeLocalAuthenticationIssue.required }
    func sign(_ data: Data, alias: String) throws -> String { throw NativeLocalAuthenticationIssue.required }
    func sign(_ data: Data, alias: String, permit: NativeLocalSigningPermit) throws -> String {
        _ = try permit.require(data, alias: alias)
        lock.lock(); signed += 1; lock.unlock()
        return try key.signature(for: data).rawRepresentation.base64URL
    }
    func sha256(_ data: Data) -> String { NativeLocalSigningLease.digest(data) }
    func clear() { lock.lock(); deleted += 1; lock.unlock() }
    func clear(alias: String) { clear() }
    func hasRetainedKey() throws -> Bool { false }
    func publicJWK(alias: String, create: Bool) throws -> WireValue {
        lock.lock(); if create { creates += 1 }; let unavailable = lookupUnavailable; lock.unlock()
        if unavailable { throw NativeAPIError.unavailable("fixture_key_lookup") }; return jwk
    }
}
private actor LocalAuthTransport: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000091"
    private(set) var paths: [String] = []
    nonisolated func cancelPending() {}
    private func reply(_ value: WireValue, status: Int = 200) throws -> NativeHTTPReply {
        NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try value.encoded())
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        if path == "/auth/anonymous" {
            let claims: WireValue = .object(["sub": .string(Self.account), "auth_method": .string("anonymous"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
            return try reply(.object(["account_id": .string(Self.account), "auth_method": .string("anonymous"), "roles": .strings(["user"]),
                "expires_in": .integer(900), "refresh_token": .string("local-auth-fixture-refresh"),
                "access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture")]))
        }
        if path == "/me/audience" {
            return try reply(.object(["protocol": .string("lovelies-audience-v1"), "policy_version": .string("audience-2026-10-24-v1"),
                "account_id": .string(Self.account), "audience": .object(["age_band": .string("18_plus"), "status": .string("eligible"), "version": .integer(1),
                    "policy_version": .string("audience-2026-10-24-v1"), "next_review_at": .null]), "guardian_request": .null,
                "capabilities": .object(["face_authentication": .bool(true), "photo_matching": .bool(true), "photo_processing": .bool(true)])]))
        }
        if path == "/auth/face/registration/challenge" || path == "/auth/face/registration/status" || path == "/auth/face/registration/recovery" {
            return try reply(.object(["error": .object(["code": .string("service_unavailable")])]), status: 503)
        }
        FileHandle.standardError.write(Data(("Unexpected LocalAuthTransport route: " + path + "\n").utf8))
        throw NativeAPIError.invalidResponse
    }
}
private enum LocalAuthPromotionFixture {
    static let origin = URL(string: "https://local-auth.invalid")!
    static let device = "00000000-0000-4000-8000-000000000092", revision = "00000000-0000-4000-8000-000000000093"
    static let profile = NativeEnrollmentProfile(id: "00000000-0000-4000-8000-000000000094", revision: "local-auth-profile-v1", modelID: "local-auth-software-model")
    static func credential(account: String, refresh: String = "staged-refresh", signature: String = "fixture") throws -> NativeCredentials {
        let claims: WireValue = .object(["sub": .string(account), "auth_method": .string("registered_face"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return try NativeCredentials(.object(["account_id": .string(account), "auth_method": .string("registered_face"), "roles": .strings(["user"]),
            "expires_in": .integer(900), "refresh_token": .string(refresh), "access_token": .string("fixture." + (try claims.encoded()).base64URL + "." + signature)]))
    }
    static func record(signer: LocalAuthSigner, account: String = LocalAuthTransport.account) throws -> NativeFaceLifecycleRecord {
        let digest = signer.sha256(try signer.jwk.canonical())
        let wire: WireValue = .object(["protocol": .string("lovelies-face-profile-v1"), "authenticated": .bool(false), "account_id": .string(account),
            "device_id": .string(device), "device_revision": .string(revision), "public_key_digest": .string(digest), "version": .integer(1),
            "auth_policy_version": .string("face-v1"), "photo_policy_version": .string("photo-v1"),
            "profile": .object(["id": .string(profile.id), "revision": .string(profile.revision), "model_id": .string(profile.modelID)]),
            "authentication_enabled": .bool(true), "matching_enabled": .bool(true), "processing_enabled": .bool(true), "receive_matches": .bool(true),
            "matching_paused": .bool(false), "removal_state": .string("none"), "operation": .null])
        let device = RegisteredDevice(accountID: account, faceHandle: "lfh_" + Data(repeating: 1, count: 32).base64URL, deviceID: device,
            profileID: profile.id, profileRevision: profile.revision, modelID: profile.modelID)
        var record = NativeFaceLifecycleRecord(accountID: account, apiOrigin: origin.absoluteString, originalDevice: device,
            keyAlias: NativeEnrollmentRecord.keyAlias, publicJWK: signer.jwk, publicKeyDigest: digest,
            controlKey: "lfl_" + Data(repeating: 2, count: 32).base64URL, controlOperationKey: UUID().uuidString.lowercased(),
            controlSignature: "", createdAt: Date(), metadata: try NativeFaceProfileMetadata(wire, account: account, device: device.deviceID, digest: digest))
        record.controlSignature = try signer.key.signature(for: record.controlEnvelope.canonical()).rawRepresentation.base64URL
        record.controlReady = true; record.promotionCredentials = try credential(account: account); record.promotionProfile = profile
        try record.validate(origin: origin); return record
    }
    static func save(_ record: NativeFaceLifecycleRecord, in secrets: LocalAuthSecrets) throws {
        try secrets.write("face-profile-lifecycle", data: JSONEncoder().encode(record))
        try secrets.write("registered-device", data: JSONEncoder().encode(record.originalDevice))
    }
}
private actor LocalAuthPromotionTransport: NativeTransport {
    let secrets: LocalAuthSecrets
    private var pendingFailure: Bool
    private(set) var paths: [String] = []
    init(_ secrets: LocalAuthSecrets, failFirstCurrent: Bool = false) { self.secrets = secrets; pendingFailure = failFirstCurrent }
    nonisolated func cancelPending() {}
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        let record = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: secrets.read("face-profile-lifecycle")!)
        let profile = record.promotionProfile ?? record.metadata.profile!
        var status = 200
        let value: WireValue
        switch path {
        case "/me":
            if pendingFailure { pendingFailure = false; status = 503; value = .object(["error": .object(["code": .string("service_unavailable")])]) }
            else { value = .object(["user_id": .string(record.accountID), "auth_method": .string("registered_face"), "authenticated": .bool(true),
                "profile_id": .string(profile.id), "profile_revision": .string(profile.revision)]) }
        case "/me/devices": value = .object(["items": .array([.object(["id": .string(record.originalDevice.deviceID), "current": .bool(true), "status": .string("active")])])])
        case "/auth/face/profile/status":
            let body = try WireValue.decoded(request.httpBody!), signature = try body.text("device_signature")
            var envelope = body.object!; envelope.removeValue(forKey: "device_signature")
            envelope["protocol"] = .string("lovelies-face-profile-device-v1"); envelope["step"] = .string("status")
            guard let raw = Data(base64URL: signature), try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: WireValue.object(envelope).canonical()) else { throw NativeAPIError.invalidResponse }
            var fields = record.metadata.wire.object!; fields["request_nonce"] = body["request_nonce"]; value = .object(fields)
        default:
            FileHandle.standardError.write(Data(("Unexpected LocalAuthPromotionTransport route: " + path + "\n").utf8))
            throw NativeAPIError.invalidResponse
        }
        return NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try value.encoded())
    }
}

/// Exercises the actual guest deletion/resume repository methods with a valid
/// signed, uncommitted enrollment.404 proves absence of that original start;
/// it never authorizes a replacement account, key or enrollment operation.
private actor LocalAuthGuestTransport: NativeTransport {
    let secrets: LocalAuthSecrets
    private let created = Date(), outcome = Date()
    private var phase: NativeGuestDeletionPhase = .rejected
    private var exists = false, loseCreation = false, recoveryUnavailable = false
    private(set) var paths: [String] = [], deletionBodies: [WireValue] = [], enrollmentKeys: [String] = []
    private(set) var statusBearerCount = 0
    init(_ secrets: LocalAuthSecrets) { self.secrets = secrets }
    nonisolated func cancelPending() {}
    func status(_ value: NativeGuestDeletionPhase) { phase = value }
    func loseNextCreation() { loseCreation = true }
    func unavailableRecovery(_ value: Bool) { recoveryUnavailable = value }
    private func reply(_ value: WireValue, status: Int = 200) throws -> NativeHTTPReply {
        NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try value.encoded())
    }
    private func problem(_ status: Int, _ code: String) throws -> NativeHTTPReply {
        try reply(.object(["error": .object(["code": .string(code)])]), status: status)
    }
    private func credential() throws -> WireValue {
        let claims: WireValue = .object(["sub": .string(LocalAuthTransport.account), "auth_method": .string("anonymous"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return .object(["account_id": .string(LocalAuthTransport.account), "auth_method": .string("anonymous"), "roles": .strings(["user"]),
            "expires_in": .integer(900), "refresh_token": .string("guest-local-auth-refresh"), "access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture")])
    }
    private func receipt() throws -> NativeGuestDeletionRecord {
        try JSONDecoder().decode(NativeGuestDeletionRecord.self, from: secrets.read("guest-deletion-receipt")!)
    }
    private func lifecycle(_ receipt: NativeGuestDeletionRecord) -> WireValue {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func date(_ value: Date) -> WireValue { .string(formatter.string(from: value)) }
        return .object(["protocol": .string("lovelies-account-deletion-v1"), "source": .string("privacy"), "operation_key": .string(receipt.operationKey),
            "privacy_request": .object(["id": .string("00000000-0000-4000-8000-000000000099"), "request_type": .string("delete"), "status": .string(phase.rawValue),
                "created_at": date(created), "reviewed_at": phase == .pendingApproval ? .null : date(outcome),
                "completed_at": phase == .completed ? date(outcome) : .null, "failure_code": .null]),
            "request_expires_at": date(created.addingTimeInterval(30 * 86400)), "request_expired": .bool(false),
            "deletion_status": .object(["expires_at": date((phase == .completed || phase == .rejected || phase == .cancelled ? outcome : created).addingTimeInterval(30 * 86400))]),
            "deletion_completed": .bool(phase == .completed)])
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        let body = try request.httpBody.map(WireValue.decoded) ?? .null
        switch path {
        case "/auth/anonymous": return try reply(credential(), status: 201)
        case "/me":
            guard request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true else { throw NativeAPIError.invalidResponse }
            return try reply(.object(["user_id": .string(LocalAuthTransport.account), "auth_method": .string("anonymous"), "authenticated": .bool(false)]))
        case "/auth/face/registration/recovery":
            let record = try JSONDecoder().decode(NativeEnrollmentRecord.self, from: secrets.read("face-enrollment-journal")!)
            var envelope = body.object!; envelope.removeValue(forKey: "device_signature")
            envelope["protocol"] = .string("lovelies-face-enrollment-device-v1"); envelope["step"] = .string("status")
            guard body["account_id"].string == record.accountID, body["enrollment_key"].string == record.enrollmentKey,
                  let raw = body["device_signature"].string.flatMap(Data.init(base64URL:)),
                  try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: WireValue.object(envelope).canonical()) else { throw NativeAPIError.invalidResponse }
            enrollmentKeys.append(record.enrollmentKey)
            return try problem(recoveryUnavailable ? 503 : 404, recoveryUnavailable ? "service_unavailable" : "enrollment_not_found")
        case "/privacy/account-deletion":
            let receipt = try receipt()
            guard body == receipt.payload, request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true else { throw NativeAPIError.invalidResponse }
            deletionBodies.append(body); exists = true
            if loseCreation { loseCreation = false; throw URLError(.timedOut) }
            return try reply(lifecycle(receipt), status: 201)
        case "/privacy/account-deletion/status":
            if request.value(forHTTPHeaderField: "Authorization") != nil { statusBearerCount += 1; throw NativeAPIError.invalidResponse }
            guard body == .object(["status_token": .string(try receipt().statusToken)]) else { throw NativeAPIError.invalidResponse }
            return try exists ? reply(lifecycle(receipt())) : problem(404, "deletion_status_unavailable")
        default: throw NativeAPIError.unsupported("Unexpected LocalAuthGuestTransport route: " + path)
        }
    }
}

private actor LocalAuthTransitionTransport: NativeTransport {
    let secrets: LocalAuthSecrets
    private(set) var paths: [String] = [], recoveryRequests: [String] = [], cancellationOperations: [String] = []
    private var loseCancellation = false
    init(_ secrets: LocalAuthSecrets) { self.secrets = secrets }
    nonisolated func cancelPending() {}
    func loseNextCancellation() { loseCancellation = true }
    private func reply(_ value: WireValue, status: Int = 200) throws -> NativeHTTPReply {
        NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try value.encoded())
    }
    private func verify(_ body: WireValue, protocol name: String, step: String, key: P256.Signing.PublicKey) throws {
        var envelope = body.object!; envelope.removeValue(forKey: "device_signature")
        envelope["protocol"] = .string(name); envelope["step"] = .string(step)
        guard let raw = body["device_signature"].string.flatMap(Data.init(base64URL:)),
              try key.isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: WireValue.object(envelope).canonical()) else { throw NativeAPIError.invalidResponse }
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        let body = try request.httpBody.map(WireValue.decoded) ?? .null
        switch path {
        case "/auth/face/policy": return try reply(.object(["protocol": .string("lovelies-face-auth-v1"), "policy_version": .string("face-v1"), "available": .bool(true)]))
        case "/auth/logout": return try reply(.object(["status": .string("logged_out")]))
        case "/auth/face/recovery/status":
            let record = try JSONDecoder().decode(NativeAccountRecoveryRecord.self, from: secrets.read("account-recovery-journal")!)
            try verify(body, protocol: "lovelies-account-recovery-device-v1", step: "status", key: record.publicKey())
            return try reply(.object(["error": .object(["code": .string("account_recovery_not_found")])]), status: 404)
        case "/auth/face/recovery/challenge":
            let record = try JSONDecoder().decode(NativeAccountRecoveryRecord.self, from: secrets.read("account-recovery-journal")!)
            guard body == record.startBody, let raw = body["device_signature"].string.flatMap(Data.init(base64URL:)),
                  try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: record.startEnvelope.canonical()) else { throw NativeAPIError.invalidResponse }
            recoveryRequests.append(record.requestID)
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return try reply(.object(["protocol": .string("lovelies-face-auth-v1"), "challenge_id": .string(UUID().uuidString.lowercased()),
                "account_id": .string(record.accountID), "device_id": .string(LocalAuthPromotionFixture.device), "device_revision": .string(LocalAuthPromotionFixture.revision),
                "nonce": .string("lfn_" + Data(repeating: 8, count: 32).base64URL), "purpose": .string("login"),
                "profile_id": .string(LocalAuthPromotionFixture.profile.id), "profile_revision": .string(LocalAuthPromotionFixture.profile.revision), "model_id": .string(LocalAuthPromotionFixture.profile.modelID),
                "policy_version": .string(record.policy), "recovery_request_id": .string(record.requestID), "recovery_generation": .integer(1),
                "poses": .strings(["front"]), "required_captures": .integer(1), "maximum_capture_bytes": .integer(8 * 1024 * 1024),
                "expires_at": .string(formatter.string(from: Date().addingTimeInterval(100)))]))
        case "/auth/face/profile/cancel":
            let record = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: secrets.read("face-profile-lifecycle")!)
            try verify(body, protocol: "lovelies-face-profile-device-v1", step: "cancel", key: record.publicKey())
            guard let pending = record.pending, body["operation_key"].string == pending.operationKey else { throw NativeAPIError.invalidResponse }
            cancellationOperations.append(pending.operationKey)
            if loseCancellation { loseCancellation = false; throw URLError(.timedOut) }
            var metadata = record.metadata.wire.object!
            metadata["version"] = .integer(record.metadata.version + 1); metadata["request_nonce"] = body["request_nonce"]
            metadata["operation"] = .object(["operation_key": .string(pending.operationKey), "action": .string(pending.action.rawValue),
                "generation": .integer(pending.generation), "state": .string("cancelled"), "cleanup_state": .string("none"),
                "challenge_id": pending.predecessorID.map(WireValue.string) ?? .null, "challenge": .null, "captures": .array([])])
            return try reply(.object(metadata))
        default: throw NativeAPIError.unsupported("Unexpected transition route: " + path)
        }
    }
}

@main struct NativeLocalAuthenticationTests {
    private static var assertions = 0
    private static func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        assertions += 1; if try !value() { throw NSError(domain: message, code: 1) }
    }
    private static func denied(_ work: () throws -> Void, _ message: String) throws {
        do { try work() } catch { assertions += 1; return }
        throw NSError(domain: "Expected denial: " + message, code: 1)
    }
    private static func binding(operation: UUID = UUID(), account: String = LocalAuthTransport.account, epoch: Int = 1,
                                purpose: NativeLocalAuthenticationPurpose = .capture) throws -> NativeLocalAuthenticationBinding {
        try NativeLocalAuthenticationBinding(operationID: operation, purpose: purpose, accountID: account, epoch: epoch,
            aliases: [NativeEnrollmentRecord.keyAlias], stateDigest: String(repeating: "a", count: 64))
    }
    private static func envelope(account: String = LocalAuthTransport.account) throws -> Data {
        try WireValue.object(["protocol": .string("lovelies-face-device-v1"), "account_id": .string(account), "step": .string("capture")]).canonical()
    }
    private static func scoped<T>(_ binding: NativeLocalAuthenticationBinding, _ body: () throws -> T) rethrows -> T {
        try NativeLocalSigningOperation.$id.withValue(binding.operationID) {
            try NativeLocalSigningOperation.$purpose.withValue(binding.purpose, operation: body)
        }
    }
    private static func scoped<T>(_ binding: NativeLocalAuthenticationBinding, _ body: () async throws -> T) async rethrows -> T {
        try await NativeLocalSigningOperation.$id.withValue(binding.operationID) {
            try await NativeLocalSigningOperation.$purpose.withValue(binding.purpose) { try await body() }
        }
    }
    private static func permits() async throws {
        let clock = LocalAuthClock(), session = LocalAuthSession(), auth = NativeLocalAuthenticator(makeSession: { session }, clock: { clock.now() })
        let request = try binding(), bytes = try envelope(), alias = NativeEnrollmentRecord.keyAlias
        let lease = try await auth.authorize(request)
        try expect(session.count == 1, "Exactly one injected authorization")
        try denied({ _ = try lease.permit(bytes, alias: alias, epoch: request.epoch, operationID: request.operationID) }, "No task operation")
        try scoped(request) {
            let permit = try lease.permit(bytes, alias: alias, epoch: request.epoch, operationID: request.operationID)
            _ = try permit.require(bytes, alias: alias); try expect(true, "Exact bound permit")
            try denied({ _ = try lease.permit(bytes, alias: alias, epoch: 2, operationID: request.operationID) }, "Current epoch")
            try denied({ _ = try lease.permit(bytes, alias: NativeAccountRecoveryRecord.aliasPrefix + UUID().uuidString, epoch: 1, operationID: request.operationID) }, "Unapproved alias")
            try denied({ _ = try lease.permit(envelope(account: UUID().uuidString), alias: alias, epoch: 1, operationID: request.operationID) }, "Other account")
            try denied({ _ = try permit.require(bytes + Data([32]), alias: alias) }, "Payload changes after permit")
            try denied({ _ = try lease.permit(bytes, alias: alias, epoch: 1, operationID: UUID()) }, "Different operation")
            try NativeLocalSigningOperation.$purpose.withValue(.profileControl) {
                try denied({ _ = try lease.permit(bytes, alias: alias, epoch: 1, operationID: request.operationID) }, "Different purpose within same task operation")
            }
        }
        clock.set(100)
        let next = try binding(), nextLease = try await auth.authorize(next)
        try expect(session.count == 1, "Bounded same-account/epoch/alias context reuse")
        lease.retire()
        try scoped(request) {
            try denied({ _ = try lease.permit(bytes, alias: alias, epoch: 1, operationID: request.operationID) }, "Completed operation cannot be reused")
        }
        clock.set(219)
        let last = try await auth.authorize(binding())
        clock.set(220)
        try scoped(last.binding) {
            try denied({ _ = try last.permit(bytes, alias: alias, epoch: 1, operationID: last.binding.operationID) }, "New lease cannot extend original deadline")
        }
        nextLease.invalidate(); auth.invalidate()
        try expect(session.invalidated, "Cancellation invalidates cached system context")
        let rollbackClock = LocalAuthClock(), rollbackRequest = try binding()
        let rollbackLease = try NativeLocalSigningLease(binding: rollbackRequest, session: LocalAuthSession(), clock: { rollbackClock.now() })
        try scoped(rollbackRequest) {
            rollbackClock.set(99)
            try denied({ _ = try rollbackLease.permit(bytes, alias: alias, epoch: 1, operationID: rollbackRequest.operationID) }, "Monotonic rollback")
            rollbackClock.set(100)
            try denied({ _ = try rollbackLease.permit(bytes, alias: alias, epoch: 1, operationID: rollbackRequest.operationID) }, "Rollback cannot revive context")
        }
        try denied({ _ = try DeviceIdentity.sign(bytes) }, "Direct legacy signing has no implicit fallback")
        let enrollment = try binding(purpose: .enrollment), enrollmentLease = try await NativeLocalAuthenticator(makeSession: { LocalAuthSession() }).authorize(enrollment)
        try scoped(enrollment) {
            let unrelated = try WireValue.object(["protocol": .string("lovelies-face-profile-device-v1"), "account_id": .string(enrollment.accountID), "step": .string("control")]).canonical()
            try denied({ _ = try enrollmentLease.permit(unrelated, alias: alias, epoch: 1, operationID: enrollment.operationID) }, "Enrollment purpose cannot authorize profile control")
        }
    }
    private static func failures() async throws {
        for issue in [NativeLocalAuthenticationIssue.cancelled, .failed, .unavailable, .passcodeRequired] {
            let session = LocalAuthSession(failure: issue), auth = NativeLocalAuthenticator(makeSession: { session })
            do { _ = try await auth.authorize(binding()); throw NSError(domain: "Unexpected authorization", code: 1) }
            catch is NativeLocalAuthenticationIssue { try expect(session.invalidated, "Failed auth produces no reusable context") }
        }
        let held = HeldLocalAuthSession(), auth = NativeLocalAuthenticator(makeSession: { held })
        let request = try binding(), task = Task { try await auth.authorize(request) }
        await held.waitUntilStarted(); auth.invalidate()
        do { _ = try await task.value; throw NSError(domain: "Cancelled prompt published authorization", code: 1) }
        catch is NativeLocalAuthenticationIssue { try expect(true, "True background/cancel before reply cannot publish a lease") }
    }
    private static func repository() async throws {
        let secrets = LocalAuthSecrets(), signer = LocalAuthSigner(), transport = LocalAuthTransport()
        let repo = BackendRepository(origin: URL(string: "https://local-auth.invalid")!, transport: transport, secrets: secrets, signer: signer)
        let noPrompt = try await repo.prepareLocalSigning(purpose: .connect, operationID: UUID())
        try expect(noPrompt == nil, "Anonymous bootstrap/privacy has no retained signed journal")
        let anonymous = try await repo.bootstrap()
        try expect(anonymous?.authenticated == false && anonymous?.accountID == LocalAuthTransport.account, "Same anonymous authority")
        let legacyPublicKey = signer.key.publicKey.rawRepresentation, before = secrets.snapshot(), operation = UUID()
        let request = try await repo.prepareLocalSigning(purpose: .enrollment, operationID: operation)!
        let auth = NativeLocalAuthenticator(makeSession: { LocalAuthSession() }), lease = try await auth.authorize(request)
        try await repo.installLocalSigning(lease)
        do {
            _ = try await repo.startFace(consentPolicy: "face-v1", publicKey: signer.jwk)
            throw NSError(domain: "Background task borrowed foreground authorization", code: 1)
        } catch is NativeLocalAuthenticationIssue {}
        try expect(signer.signCount == 0 && secrets.snapshot() == before, "Unscoped signing denied before journal mutation")
        let beforePost = await transport.paths.filter { $0 == "/auth/face/registration/challenge" }.count
        try expect(beforePost == 0, "No signed registration dispatch without operation proof")
        do {
            _ = try await scoped(request) {
                try await repo.startFace(consentPolicy: "face-v1", publicKey: signer.jwk)
            }
            throw NSError(domain: "Fixture503 was ignored", code: 1)
        } catch NativeAPIError.denied(let status, _) { try expect(status == 503, "Ambiguous operation remains pending") }
        let journal = try secrets.read("face-enrollment-journal")
        try expect(journal != nil && signer.signCount > 0, "Original enrollment intent persisted before dispatch")
        await repo.finishLocalSigning(operationID: operation)
        let after503 = secrets.snapshot(), rejected = try await repo.prepareLocalSigning(purpose: .reconciliation, operationID: UUID())!
        let cancel = NativeLocalAuthenticator(makeSession: { LocalAuthSession(failure: .cancelled) })
        do { _ = try await cancel.authorize(rejected); throw NSError(domain: "Expected cancelled retry", code: 1) }
        catch NativeLocalAuthenticationIssue.cancelled {}
        let retainedJournal = try secrets.read("face-enrollment-journal")
        try expect(secrets.snapshot() == after503 && retainedJournal == journal,
                   "Cancelled retry preserves503 journal/original operation")
        let checks = await transport.paths.filter { $0 == "/auth/face/registration/challenge" }.count
        try expect(checks == 1, "Cancelled retry sends no duplicate signed operation")
        let restarted = BackendRepository(origin: URL(string: "https://local-auth.invalid")!, transport: transport, secrets: secrets, signer: signer)
        let beforeHydration = secrets.snapshot(), beforeHydrationSigns = signer.signCount, beforeHydrationPaths = await transport.paths
        let restartRequest = try await restarted.prepareLocalSigning(purpose: .connect, operationID: UUID())!
        let heldSession = await restarted.summary()
        try expect(secrets.snapshot() == beforeHydration && signer.signCount == beforeHydrationSigns && heldSession?.authenticated != true && heldSession?.accountID == LocalAuthTransport.account,
                   "Restart hydration loads a held journal without key use, mutation or promoted authority")
        let afterHydrationPaths = await transport.paths
        try expect(afterHydrationPaths == beforeHydrationPaths, "Local hydration performs no dispatch")
        let restartLease = try await auth.authorize(restartRequest); try await restarted.installLocalSigning(restartLease)
        do { _ = try await scoped(restartRequest) { try await restarted.bootstrap() }; throw NSError(domain: "Expected status503", code: 1) }
        catch NativeAPIError.denied(let status, _) { try expect(status == 503, "Restart proof reaches original signed status instead of invalidating on credential hydration") }
        await restarted.finishLocalSigning(operationID: restartRequest.operationID)
        let stale = try await repo.prepareLocalSigning(purpose: .reconciliation, operationID: UUID())!
        let staleLease = try await auth.authorize(stale)
        try secrets.write("pending-face-device", data: JSONEncoder().encode(RegisteredDevice(accountID: LocalAuthTransport.account,
            faceHandle: "lfh_" + Data(repeating: 1, count: 32).base64URL, deviceID: UUID().uuidString.lowercased())))
        let mutation = secrets.snapshot()
        do { try await repo.installLocalSigning(staleLease); throw NSError(domain: "Changed durable state accepted", code: 1) }
        catch NativeLocalAuthenticationIssue.bindingChanged {}
        try expect(secrets.snapshot() == mutation, "Changed durable binding is denied without destructive repair")
        do { _ = try await repo.prepareLocalSigning(purpose: .reconciliation, operationID: UUID()); throw NSError(domain: "Malformed held relationship accepted", code: 1) }
        catch NativeLocalAuthenticationIssue.bindingChanged {}
        try expect(secrets.snapshot() == mutation, "Malformed held device/journal relationship cannot be repaired before auth")
        try secrets.write("pending-face-device", data: nil) // Restore this controlled malformed fixture.
        let epochRequest = try await repo.prepareLocalSigning(purpose: .reconciliation, operationID: UUID())!
        let epochLease = try await auth.authorize(epochRequest)
        await repo.clearSession()
        let afterRetirement = secrets.snapshot()
        do { try await repo.installLocalSigning(epochLease); throw NSError(domain: "Retired epoch accepted authorization", code: 1) }
        catch NativeLocalAuthenticationIssue.bindingChanged {}
        let afterRetirementJournal = try secrets.read("face-enrollment-journal")
        try expect(secrets.snapshot() == afterRetirement && afterRetirementJournal == journal,
                   "Epoch retirement cannot install a late proof or erase the held operation")
        try expect(signer.clearCount == 0 && signer.key.publicKey.rawRepresentation == legacyPublicKey, "Legacy key/journals never rotated or deleted")
    }
    private static func concurrentCredentialChange() async throws {
        let secrets = LocalAuthSecrets(), signer = LocalAuthSigner(), transport = LocalAuthTransport()
        let repo = BackendRepository(origin: URL(string: "https://local-auth.invalid")!, transport: transport, secrets: secrets, signer: signer)
        _ = try await repo.bootstrap()
        let operation = UUID(), request = try await repo.prepareLocalSigning(purpose: .enrollment, operationID: operation)!
        let lease = try await NativeLocalAuthenticator(makeSession: { LocalAuthSession() }).authorize(request)
        try await repo.installLocalSigning(lease)
        var record = try JSONSerialization.jsonObject(with: secrets.read("credentials")!) as! [String: Any]
        record["refresh_token"] = "other-repository-rotation"; try secrets.write("credentials", data: JSONSerialization.data(withJSONObject: record))
        let changed = secrets.snapshot()
        do {
            _ = try await scoped(request) {
                try await repo.startFace(consentPolicy: "face-v1", publicKey: signer.jwk)
            }
            throw NSError(domain: "Other repository credentials bypassed authorization", code: 1)
        } catch NativeLocalAuthenticationIssue.bindingChanged {}
        try expect(signer.signCount == 0 && signer.clearCount == 0 && secrets.snapshot() == changed,
                   "Cross-repository credential change denies signing without overwriting state")
        let dispatches = await transport.paths.filter { $0 == "/auth/face/registration/challenge" }.count
        try expect(dispatches == 0, "No signed dispatch after external credential change")
    }
    private static func promotionRetry() async throws {
        let secrets = LocalAuthSecrets(), signer = LocalAuthSigner(), session = LocalAuthSession()
        let record = try LocalAuthPromotionFixture.record(signer: signer); try LocalAuthPromotionFixture.save(record, in: secrets)
        let transport = LocalAuthPromotionTransport(secrets, failFirstCurrent: true)
        let repo = BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: signer)
        let auth = NativeLocalAuthenticator(makeSession: { session })
        let initial = secrets.snapshot(), request = try await repo.prepareLocalSigning(purpose: .connect, operationID: UUID())!
        let summary = await repo.summary(), noPaths = await transport.paths
        try expect(summary == nil && signer.signCount == 0 && secrets.snapshot() == initial && noPaths.isEmpty,
                   "Staged hydration exposes no session, private proof, durable repair or dispatch")
        try await repo.installLocalSigning(auth.authorize(request))
        do { _ = try await scoped(request) { try await repo.bootstrap() }; throw NSError(domain: "Expected promotion503", code: 1) }
        catch NativeAPIError.denied(let status, _) { try expect(status == 503, "Staged original authority survives current-server503") }
        await repo.finishLocalSigning(operationID: request.operationID)
        try expect(secrets.snapshot() == initial && signer.clearCount == 0, "503 cannot replace or erase staged key/intent/credentials")
        let retry = try await repo.prepareLocalSigning(purpose: .connect, operationID: UUID())!
        try expect(retry.epoch == request.epoch, "Exact staged credential/intent retry does not advance epoch")
        try await repo.installLocalSigning(auth.authorize(retry))
        let restored = try await scoped(retry) { try await repo.bootstrap() }
        let repaired = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: secrets.read("face-profile-lifecycle")!)
        try expect(restored?.authenticated == true && restored?.accountID == record.accountID && restored?.epoch == retry.epoch,
                   "Exact staged retry reaches signed status and publishes only server-confirmed same-account authority")
        try expect(repaired.promotionCredentials == nil && repaired.credentials?.refresh_token == record.promotionCredentials?.refresh_token && session.count == 1 && signer.clearCount == 0,
                   "Promotion repair is usable under the original bounded authorization without rotating a key")
        await repo.finishLocalSigning(operationID: retry.operationID)
    }
    private static func changedPromotionBindings() async throws {
        for change in ["refresh", "session", "expiry", "intent", "account", "epoch"] {
            let secrets = LocalAuthSecrets(), signer = LocalAuthSigner()
            var record = try LocalAuthPromotionFixture.record(signer: signer); try LocalAuthPromotionFixture.save(record, in: secrets)
            let transport = LocalAuthPromotionTransport(secrets)
            let repo = BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: signer)
            let request = try await repo.prepareLocalSigning(purpose: .connect, operationID: UUID())!
            let auth = NativeLocalAuthenticator(makeSession: { LocalAuthSession() })
            try await repo.installLocalSigning(auth.authorize(request))
            switch change {
            case "refresh":
                var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record.promotionCredentials!)) as! [String: Any]
                object["refresh_token"] = "different-staged-refresh"
                record.promotionCredentials = try JSONDecoder().decode(NativeCredentials.self, from: JSONSerialization.data(withJSONObject: object))
            case "session":
                var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record.promotionCredentials!)) as! [String: Any]
                object["access_token"] = record.promotionCredentials!.access_token + "-different-session"
                record.promotionCredentials = try JSONDecoder().decode(NativeCredentials.self, from: JSONSerialization.data(withJSONObject: object))
            case "expiry":
                var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record.promotionCredentials!)) as! [String: Any]
                object["expiresAt"] = record.promotionCredentials!.expiresAt.addingTimeInterval(-2).timeIntervalSinceReferenceDate
                record.promotionCredentials = try JSONDecoder().decode(NativeCredentials.self, from: JSONSerialization.data(withJSONObject: object))
            case "intent":
                record.controlOperationKey = UUID().uuidString.lowercased()
                record.controlSignature = try signer.key.signature(for: record.controlEnvelope.canonical()).rawRepresentation.base64URL
            case "account": record = try LocalAuthPromotionFixture.record(signer: signer, account: "00000000-0000-4000-8000-000000000095")
            default: await repo.clearSession()
            }
            try record.validate(origin: LocalAuthPromotionFixture.origin); try LocalAuthPromotionFixture.save(record, in: secrets)
            let changed = secrets.snapshot()
            do { _ = try await scoped(request) { try await repo.bootstrap() }; throw NSError(domain: "Changed promotion accepted: " + change, code: 1) }
            catch is NativeLocalAuthenticationIssue {}
            let paths = await transport.paths
            try expect(signer.signCount == 0 && signer.clearCount == 0 && paths.isEmpty && secrets.snapshot() == changed,
                       "Changed staged " + change + " denies before private signing/dispatch and preserves exact held state")
        }
    }
    private static func guestFixture(retainedEnrollment: Bool = true) async throws -> (BackendRepository, LocalAuthGuestTransport, LocalAuthSecrets, LocalAuthSigner) {
        let secrets = LocalAuthSecrets(), signer = LocalAuthSigner(), transport = LocalAuthGuestTransport(secrets)
        let repo = BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: signer)
        _ = try await repo.bootstrap()
        if retainedEnrollment {
            let original = try JSONDecoder().decode(NativeCredentials.self, from: secrets.read("credentials")!)
            var record = NativeEnrollmentRecord(accountID: original.account_id, apiOrigin: LocalAuthPromotionFixture.origin.absoluteString,
                enrollmentKey: UUID().uuidString.lowercased(), keyAlias: NativeEnrollmentRecord.keyAlias,
                publicJWK: signer.jwk, publicKeyDigest: signer.sha256(try signer.jwk.canonical()), faceHandle: "lfh_" + Data(repeating: 3, count: 32).base64URL,
                policy: "local-auth-guest-face-v1", consent: true, createdAt: Date(), startSignature: "", originalAnonymous: original)
            // startSignature is immutable in production. Build the complete
            // fixture value from its canonical envelope before persisting it.
            let signature = try signer.key.signature(for: record.startEnvelope.canonical()).rawRepresentation.base64URL
            record = NativeEnrollmentRecord(accountID: record.accountID, apiOrigin: record.apiOrigin, enrollmentKey: record.enrollmentKey, keyAlias: record.keyAlias,
                publicJWK: record.publicJWK, publicKeyDigest: record.publicKeyDigest, faceHandle: record.faceHandle, policy: record.policy,
                consent: record.consent, createdAt: record.createdAt, startSignature: signature, originalAnonymous: original)
            try record.validate(origin: LocalAuthPromotionFixture.origin)
            try secrets.write("face-enrollment-journal", data: JSONEncoder().encode(record))
        }
        return (repo, transport, secrets, signer)
    }
    private static func createGuestDeletion(_ repo: BackendRepository, auth: NativeLocalAuthenticator) async throws -> NativeGuestDeletionSummary {
        if let binding = try await repo.prepareLocalSigning(purpose: .reconciliation, operationID: UUID(), retainedEnrollmentOnly: true) {
            try await repo.installLocalSigning(auth.authorize(binding))
            let value = try await scoped(binding) { try await repo.requestGuestDeletion() }
            await repo.finishLocalSigning(operationID: binding.operationID); return value
        }
        return try await repo.requestGuestDeletion()
    }
    private static func guestPrivacy() async throws {
        let (repo, transport, secrets, signer) = try await guestFixture(), session = LocalAuthSession()
        let auth = NativeLocalAuthenticator(makeSession: { session }), original = secrets.snapshot()
        do { _ = try await repo.requestGuestDeletion(); throw NSError(domain: "Guest enrollment reconciled without OS grant", code: 1) }
        catch is NativeLocalAuthenticationIssue {}
        let beforeGrant = await transport.paths
        try expect(signer.signCount == 0 && secrets.snapshot() == original && !beforeGrant.contains("/privacy/account-deletion"),
                   "Retained enrollment denies guest deletion before private proof or deletion dispatch without exact grant")
        let created = try await createGuestDeletion(repo, auth: auth)
        let originalJournal = try secrets.read("face-enrollment-journal"), afterDeleteSigns = signer.signCount
        let deletionPosts = await transport.deletionBodies
        try expect(created.canResumeSetup && session.count == 1 && deletionPosts.count == 1 && originalJournal == original["face-enrollment-journal"],
                   "Explicit grant reconciles only original enrollment before actual same-account guest deletion")
        let privacyBinding = try await repo.prepareLocalSigning(purpose: .connect, operationID: UUID())
        _ = try await repo.checkGuestDeletion()
        try expect(privacyBinding == nil && signer.signCount == afterDeleteSigns && session.count == 1,
                   "Receipt status remains noninteractive even while an original enrollment is retained")
        let ticket = try await repo.prepareGuestSetupResume(), afterPreflight = secrets.snapshot(), preflightSigns = signer.signCount
        let binding = try await repo.prepareLocalSigning(purpose: .reconciliation, operationID: UUID(), guestResume: ticket)!
        try expect(preflightSigns == afterDeleteSigns && binding.accountID == LocalAuthTransport.account,
                   "Receipt/current-account preflight finishes epoch changes before the OS grant and never signs")
        let cancel = NativeLocalAuthenticator(makeSession: { LocalAuthSession(failure: .cancelled) })
        do { _ = try await cancel.authorize(binding); throw NSError(domain: "Expected cancelled guest resume", code: 1) }
        catch NativeLocalAuthenticationIssue.cancelled {}
        do { _ = try await repo.resumeGuestSetup(ticket); throw NSError(domain: "Cancelled OS grant resumed enrollment", code: 1) }
        catch is NativeLocalAuthenticationIssue {}
        try expect(signer.signCount == preflightSigns && secrets.snapshot() == afterPreflight,
                   "Cancelled guest-resume authorization preserves exact receipt, journal and original authority")
        let fresh = try await repo.prepareGuestSetupResume()
        let continuation = try await repo.prepareLocalSigning(purpose: .reconciliation, operationID: UUID(), guestResume: fresh)!
        try await repo.installLocalSigning(auth.authorize(continuation))
        let resumed = try await scoped(continuation) { try await repo.resumeGuestSetup(fresh) }
        try expect(!resumed.authenticated && resumed.accountID == LocalAuthTransport.account && (try secrets.read("guest-deletion-receipt")) == nil &&
                   (try secrets.read("face-enrollment-journal")) == originalJournal && signer.clearCount == 0,
                   "Bound guest continuation actually resumes the same anonymous account and original enrollment without replacing a key")
        let proofs = await transport.enrollmentKeys, posts = await transport.deletionBodies, bearerCount = await transport.statusBearerCount
        let held = try JSONDecoder().decode(NativeEnrollmentRecord.self, from: originalJournal!)
        try expect(proofs.count == 2 && Set(proofs) == [held.enrollmentKey] && posts.count == 1 && bearerCount == 0,
                   "Guest resume uses only original enrollment key, no duplicate deletion, and non-bearer receipt status")
        do { _ = try await scoped(continuation) { try await repo.resumeGuestSetup(fresh) }; throw NSError(domain: "Consumed guest ticket replayed", code: 1) }
        catch is NativeLocalAuthenticationIssue { try expect(true, "Guest continuation ticket is single-use") }
        await repo.finishLocalSigning(operationID: continuation.operationID)
        let (plain, plainWire, plainSecrets, plainSigner) = try await guestFixture(retainedEnrollment: false)
        let noGrant = try await plain.prepareLocalSigning(purpose: .reconciliation, operationID: UUID(), retainedEnrollmentOnly: true)
        _ = try await plain.requestGuestDeletion()
        let noFaceTicket = try await plain.prepareGuestSetupResume()
        let noFaceBinding = try await plain.prepareLocalSigning(purpose: .reconciliation, operationID: UUID(), guestResume: noFaceTicket)
        let noFace = try await plain.resumeGuestSetup(noFaceTicket)
        try expect(noGrant == nil && noFaceBinding == nil && !noFace.authenticated && plainSigner.signCount == 0 && plainSigner.createCount == 0 &&
                   (try plainSecrets.read("guest-deletion-receipt")) == nil, "Ordinary guest deletion and resume require no OS gate or key creation")
        let plainPosts = await plainWire.deletionBodies
        try expect(plainPosts.count == 1, "Plain guest resume does not repeat deletion")
    }
    private static func staleGuestTickets() async throws {
        for change in ["receipt", "credential", "enrollment", "epoch", "status", "restart", "purpose"] {
            let (repo, transport, secrets, signer) = try await guestFixture()
            let auth = NativeLocalAuthenticator(makeSession: { LocalAuthSession() })
            _ = try await createGuestDeletion(repo, auth: auth)
            let ticket = try await repo.prepareGuestSetupResume()
            let binding = try await repo.prepareLocalSigning(purpose: .reconciliation, operationID: UUID(), guestResume: ticket)!
            try await repo.installLocalSigning(auth.authorize(binding))
            var target = repo
            switch change {
            case "receipt":
                var receipt = try JSONDecoder().decode(NativeGuestDeletionRecord.self, from: secrets.read("guest-deletion-receipt")!)
                receipt.statusUnavailable = true; try secrets.write("guest-deletion-receipt", data: JSONEncoder().encode(receipt))
            case "credential":
                var credential = try JSONSerialization.jsonObject(with: JSONEncoder().encode(JSONDecoder().decode(NativeGuestDeletionRecord.self, from: secrets.read("guest-deletion-receipt")!).originalCredentials!)) as! [String: Any]
                credential["refresh_token"] = "foreign-repository-guest-rotation"; try secrets.write("credentials", data: JSONSerialization.data(withJSONObject: credential))
            case "enrollment":
                var record = try JSONSerialization.jsonObject(with: secrets.read("face-enrollment-journal")!) as! [String: Any]
                record["enrollmentKey"] = UUID().uuidString.lowercased(); try secrets.write("face-enrollment-journal", data: JSONSerialization.data(withJSONObject: record))
            case "epoch": await repo.clearSession()
            case "status": _ = try await repo.checkGuestDeletion()
            case "restart":
                target = BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: signer)
                _ = try await target.bootstrap()
            default: break
            }
            let state = secrets.snapshot(), signs = signer.signCount, paths = await transport.paths
            do {
                if change == "purpose" { _ = try await repo.prepareLocalSigning(purpose: .capture, operationID: UUID(), guestResume: ticket) }
                else { _ = try await scoped(binding) { try await target.resumeGuestSetup(ticket) } }
                throw NSError(domain: "Stale guest ticket accepted: " + change, code: 1)
            } catch is NativeLocalAuthenticationIssue {}
            let after = await transport.paths
            try expect(signer.signCount == signs && signer.clearCount == 0 && secrets.snapshot() == state && paths == after,
                       "Changed guest " + change + " denies stale ticket before signing/dispatch or destructive repair")
        }
    }
    private static func guestDeletionCleanup() async throws {
        for keyState in ["matched", "unmatched", "unavailable", "unknown"] {
            let (repo, transport, secrets, originalSigner) = try await guestFixture(retainedEnrollment: keyState != "unknown")
            let auth = NativeLocalAuthenticator(makeSession: { LocalAuthSession() })
            await transport.status(.pendingApproval)
            _ = try await createGuestDeletion(repo, auth: auth)
            let signer = keyState == "unmatched" ? LocalAuthSigner() : originalSigner
            if keyState == "unavailable" { signer.unavailableLookup() }
            let restored = BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: signer)
            let connect = try await restored.prepareLocalSigning(purpose: .connect, operationID: UUID())
            _ = try await restored.bootstrap()
            let signs = signer.signCount
            await transport.status(.completed)
            let completed = try await restored.checkGuestDeletion()
            try expect(completed.completed && connect == nil && signer.signCount == signs && signer.createCount == 0,
                       "Completed guest deletion cleanup remains noninteractive and never signs/creates: " + keyState)
            try expect(signer.clearCount == (keyState == "matched" ? 1 : 0),
                       "Only an exact existing canonical public key can be retired after completed deletion: " + keyState)
        }
    }
    private static func guestLostRepliesAndResume() async throws {
        let (repo, transport, secrets, signer) = try await guestFixture()
        let auth = NativeLocalAuthenticator(makeSession: { LocalAuthSession() })
        let original = secrets.snapshot()
        await transport.unavailableRecovery(true)
        do { _ = try await createGuestDeletion(repo, auth: auth); throw NSError(domain: "Expected enrollment status503", code: 1) }
        catch NativeAPIError.denied(let status, _) { try expect(status == 503, "Unknown enrollment status blocks deletion creation") }
        let noPosts = await transport.deletionBodies
        try expect(noPosts.isEmpty && secrets.snapshot() == original && signer.clearCount == 0,
                   "Enrollment503 preserves original journal/account and sends no deletion")
        await transport.unavailableRecovery(false); await transport.loseNextCreation()
        do { _ = try await createGuestDeletion(repo, auth: auth); throw NSError(domain: "Expected lost deletion reply", code: 1) }
        catch NativeAPIError.unavailable {}
        let lost = try JSONDecoder().decode(NativeGuestDeletionRecord.self, from: secrets.read("guest-deletion-receipt")!)
        try expect(lost.status == nil && lost.originalCredentials?.account_id == LocalAuthTransport.account,
                   "Lost committed deletion reply retains original operation and private receipt authority")
        let restored = BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: signer)
        let noOS = try await restored.prepareLocalSigning(purpose: .connect, operationID: UUID())
        _ = try await restored.bootstrap(); let checked = try await restored.checkGuestDeletion()
        let committed = try JSONDecoder().decode(NativeGuestDeletionRecord.self, from: secrets.read("guest-deletion-receipt")!)
        try expect(noOS == nil && checked.canResumeSetup && committed.operationKey == lost.operationKey && committed.statusToken == lost.statusToken,
                   "Restart resolves a lost deletion reply through the exact noninteractive receipt")
        let ticket = try await restored.prepareGuestSetupResume()
        let binding = try await restored.prepareLocalSigning(purpose: .reconciliation, operationID: UUID(), guestResume: ticket)!
        try await restored.installLocalSigning(auth.authorize(binding))
        let held = secrets.snapshot()
        await transport.unavailableRecovery(true)
        do { _ = try await scoped(binding) { try await restored.resumeGuestSetup(ticket) }; throw NSError(domain: "Expected resume503", code: 1) }
        catch NativeAPIError.denied(let status, _) { try expect(status == 503, "Ambiguous resume status keeps the original operation held") }
        try expect(secrets.snapshot() == held && signer.clearCount == 0, "Resume503 does not erase receipt, journal or same-account authority")
        await restored.finishLocalSigning(operationID: binding.operationID)
        await transport.unavailableRecovery(false)
        let afterCrash = BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: signer)
        _ = try await afterCrash.bootstrap()
        let fresh = try await afterCrash.prepareGuestSetupResume()
        let freshBinding = try await afterCrash.prepareLocalSigning(purpose: .reconciliation, operationID: UUID(), guestResume: fresh)!
        try await afterCrash.installLocalSigning(auth.authorize(freshBinding))
        let resumed = try await scoped(freshBinding) { try await afterCrash.resumeGuestSetup(fresh) }
        let posts = await transport.deletionBodies, keys = await transport.enrollmentKeys
        let originalEnrollment = try JSONDecoder().decode(NativeEnrollmentRecord.self, from: original["face-enrollment-journal"]!)
        try expect(!resumed.authenticated && resumed.accountID == LocalAuthTransport.account && posts.count == 1 &&
                   Set(keys) == [originalEnrollment.enrollmentKey] && (try secrets.read("face-enrollment-journal")) == original["face-enrollment-journal"],
                   "Restart after lost reply/resume503 completes only the same account and original enrollment without duplicate deletion")
        await afterCrash.finishLocalSigning(operationID: freshBinding.operationID)
    }
    private static func guestResumeWrongKey() async throws {
        let (repo, transport, secrets, originalSigner) = try await guestFixture()
        let auth = NativeLocalAuthenticator(makeSession: { LocalAuthSession() })
        _ = try await createGuestDeletion(repo, auth: auth)
        let wrong = LocalAuthSigner(), restored = BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: wrong)
        _ = try await restored.bootstrap()
        let ticket = try await restored.prepareGuestSetupResume()
        let binding = try await restored.prepareLocalSigning(purpose: .reconciliation, operationID: UUID(), guestResume: ticket)!
        try await restored.installLocalSigning(auth.authorize(binding))
        let saved = secrets.snapshot(), before = await transport.paths, clears = originalSigner.clearCount
        do { _ = try await scoped(binding) { try await restored.resumeGuestSetup(ticket) }; throw NSError(domain: "Wrong original key resumed guest", code: 1) }
        catch NativeAPIError.unsupported {}
        let after = await transport.paths
        try expect(saved == secrets.snapshot() && before == after && originalSigner.clearCount == clears && wrong.clearCount == 0,
                   "Unmatched retained key cannot dispatch resume or repair/replace/delete original receipt and journal")
        let (otherRepo, _, otherSecrets, otherSigner) = try await guestFixture()
        _ = try await createGuestDeletion(otherRepo, auth: auth)
        try otherSecrets.write("account-recovery-journal", data: Data("{}".utf8))
        let signs = otherSigner.signCount
        do { _ = try await otherRepo.prepareGuestSetupResume(); throw NSError(domain: "Conflicting held journal produced a guest ticket", code: 1) }
        catch NativeAPIError.sessionChanged { try expect(otherSigner.signCount == signs && otherSigner.clearCount == 0, "Unknown competing authentication hold cannot produce a guest-resume signing ticket") }
    }
    private static func profileDeletionCleanup() async throws {
        for keyState in ["matched", "unmatched", "foreign-reference"] {
            let (repo, transport, secrets, originalSigner) = try await guestFixture(retainedEnrollment: false)
            await transport.status(.pendingApproval); _ = try await repo.requestGuestDeletion()
            let profile = try LocalAuthPromotionFixture.record(signer: originalSigner)
            try LocalAuthPromotionFixture.save(profile, in: secrets)
            if keyState == "foreign-reference" {
                try secrets.write("registered-device", data: JSONEncoder().encode(RegisteredDevice(accountID: "00000000-0000-4000-8000-000000000095",
                    faceHandle: profile.originalDevice.faceHandle, deviceID: profile.originalDevice.deviceID)))
            }
            let signer = keyState == "unmatched" ? LocalAuthSigner() : originalSigner
            let restored = BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: signer)
            _ = try await restored.bootstrap(); let signs = signer.signCount
            await transport.status(.completed); let completed = try await restored.checkGuestDeletion()
            let archived = try JSONDecoder().decode([NativeFaceLifecycleRecord].self, from: secrets.read("deleted-face-profile-controls")!)
            try expect(completed.completed && signer.signCount == signs && signer.createCount == 0 && signer.clearCount == (keyState == "matched" ? 1 : 0) &&
                       archived.count == 1 && archived[0].controlOperationKey == profile.controlOperationKey && archived[0].promotionCredentials == nil &&
                       (try secrets.read("face-profile-lifecycle")) == nil,
                       "Completed receipt archives profile authority without private signing and retires only matched existing public key")
        }
    }
    private static let recoveryBackup = "LVR1:" + LocalAuthTransport.account + ":lfr_" + Data(repeating: 9, count: 32).base64URL
    private static func recoveryTransitionFixture(anonymous: Bool = false) throws -> (BackendRepository, LocalAuthTransitionTransport, LocalAuthSecrets, LocalAuthSigner) {
        let secrets = LocalAuthSecrets(), signer = LocalAuthSigner(), transport = LocalAuthTransitionTransport(secrets)
        if anonymous {
            let claims: WireValue = .object(["sub": .string(LocalAuthTransport.account), "auth_method": .string("anonymous"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
            let credential = try NativeCredentials(.object(["account_id": .string(LocalAuthTransport.account), "auth_method": .string("anonymous"), "roles": .strings(["user"]),
                "expires_in": .integer(900), "refresh_token": .string("transition-anonymous-refresh"), "access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture")]))
            try secrets.write("credentials", data: JSONEncoder().encode(credential))
        }
        return (BackendRepository(origin: LocalAuthPromotionFixture.origin, transport: transport, secrets: secrets, signer: signer), transport, secrets, signer)
    }
    private static func firstRecoveryAction() async throws {
        let (repo, transport, secrets, signer) = try recoveryTransitionFixture(anonymous: true)
        let original = secrets.snapshot()
        do { _ = try await repo.startAccountRecovery(backup: recoveryBackup); throw NSError(domain: "Recovery bypassed preflight", code: 1) }
        catch NativeLocalAuthenticationIssue.required {}
        try expect(original == secrets.snapshot() && signer.createCount == 0 && signer.signCount == 0, "No production recovery key or request starts without a post-transition grant")
        let anonymousNoPrompt = try await repo.prepareLocalSigning(purpose: .connect, operationID: UUID()), anonymous = await repo.summary()
        try expect(anonymousNoPrompt == nil && anonymous?.authenticated == false && anonymous?.accountID == LocalAuthTransport.account,
                   "Recovery starts from actual validated anonymous repository authority without an OS bootstrap prompt")
        let ticket = try await repo.prepareAccountRecoveryStart(backup: recoveryBackup)
        let preparing = try JSONDecoder().decode(NativeAccountRecoveryRecord.self, from: secrets.read("account-recovery-journal")!)
        let beforeOS = secrets.snapshot(), preflightPaths = await transport.paths
        try expect(preparing.state == .preparingKey && signer.signCount == 0 && signer.createCount == 0 && preflightPaths == ["/auth/face/policy"],
                   "Recovery preflight preserves one original unsigned intent and retires its epoch before OS auth, without key creation or recovery POST")
        let binding = try await repo.prepareLocalSigning(purpose: .accountRecovery, operationID: UUID(), recoveryBackup: recoveryBackup, transition: ticket)!
        let auth = NativeLocalAuthenticator(makeSession: { LocalAuthSession() })
        try await repo.installLocalSigning(auth.authorize(binding))
        let first = try await scoped(binding) { try await repo.startAccountRecovery(backup: recoveryBackup, transition: ticket) }
        let started = try JSONDecoder().decode(NativeAccountRecoveryRecord.self, from: secrets.read("account-recovery-journal")!), requests = await transport.recoveryRequests
        try expect(first.state == .pending && first.challenge?.accountID == LocalAuthTransport.account && first.challenge?.poses == ["front"] &&
                   started.requestID == preparing.requestID && started.keyAlias == preparing.keyAlias && requests == [preparing.requestID] && signer.createCount == 1,
                   "First protected recovery action succeeds after one post-retirement grant using the original request and key alias")
        await repo.finishLocalSigning(operationID: binding.operationID)
        try expect(beforeOS["account-recovery-journal"] != nil && signer.clearCount == 0, "Successful start retains original recovery intent and never rotates an old key")
        for change in ["request", "epoch", "backup", "cancel", "unscoped-key"] {
            let (other, wire, vault, key) = try recoveryTransitionFixture(anonymous: true)
            let pending = try await other.prepareAccountRecoveryStart(backup: recoveryBackup)
            let grant = try await other.prepareLocalSigning(purpose: .accountRecovery, operationID: UUID(), recoveryBackup: recoveryBackup, transition: pending)!
            if change == "cancel" {
                let denial = NativeLocalAuthenticator(makeSession: { LocalAuthSession(failure: .cancelled) })
                do { _ = try await denial.authorize(grant); throw NSError(domain: "Expected OS cancellation", code: 1) }
                catch NativeLocalAuthenticationIssue.cancelled {}
            } else { try await other.installLocalSigning(auth.authorize(grant)) }
            var backup = recoveryBackup
            if change == "request" {
                var record = try JSONSerialization.jsonObject(with: vault.read("account-recovery-journal")!) as! [String: Any]
                let changed = UUID().uuidString.lowercased(); record["requestID"] = changed; record["keyAlias"] = NativeAccountRecoveryRecord.aliasPrefix + changed
                try vault.write("account-recovery-journal", data: JSONSerialization.data(withJSONObject: record))
            } else if change == "epoch" { await other.clearSession() }
            else if change == "backup" { backup = "LVR1:" + LocalAuthTransport.account + ":lfr_" + Data(repeating: 10, count: 32).base64URL }
            else if change == "unscoped-key" {
                do { _ = try await other.recoverAccount(); throw NSError(domain: "Unscoped actor created recovery key", code: 1) }
                catch NativeLocalAuthenticationIssue.required {}
            }
            let state = vault.snapshot(), paths = await wire.paths
            do { _ = try await scoped(grant) { try await other.startAccountRecovery(backup: backup, transition: pending) }; throw NSError(domain: "Stale recovery start accepted: " + change, code: 1) }
            catch is NativeLocalAuthenticationIssue {}
            let after = await wire.paths
            try expect(state == vault.snapshot() && paths == after && key.createCount == 0 && key.signCount == 0 && key.clearCount == 0,
                       "Changed/cancelled recovery " + change + " cannot create/sign/dispatch or replace its held intent")
            if change == "cancel" {
                let held = try JSONDecoder().decode(NativeAccountRecoveryRecord.self, from: vault.read("account-recovery-journal")!)
                let freshTicket = try await other.prepareAccountRecoveryStart(backup: recoveryBackup)
                let freshGrant = try await other.prepareLocalSigning(purpose: .accountRecovery, operationID: UUID(), recoveryBackup: recoveryBackup, transition: freshTicket)!
                try await other.installLocalSigning(auth.authorize(freshGrant))
                let continued = try await scoped(freshGrant) { try await other.startAccountRecovery(backup: recoveryBackup, transition: freshTicket) }
                let requests = await wire.recoveryRequests
                try expect(continued.state == .pending && requests == [held.requestID] && key.createCount == 1 && key.clearCount == 0,
                           "Explicit recovery after OS cancellation uses the preserved original request/alias and a fresh grant")
            }
        }
    }
    private static func cancellationFixture() async throws -> (BackendRepository, LocalAuthTransitionTransport, LocalAuthSecrets, LocalAuthSigner) {
        let (repo, wire, vault, key) = try recoveryTransitionFixture()
        var record = try LocalAuthPromotionFixture.record(signer: key)
        record.credentials = record.promotionCredentials; record.promotionCredentials = nil; record.promotionProfile = nil
        record.currentAuthorityValidated = true
        record.pending = NativeFaceLifecycleIntent(operationKey: UUID().uuidString.lowercased(), action: .replace, expectedVersion: 1,
            consent: .object(["purpose": .string("face_authentication"), "granted": .bool(true), "policy_version": .string("face-v1")]), createdAt: Date(),
            generation: 1, predecessorID: UUID().uuidString.lowercased(), serverState: "verifying")
        try record.validate(origin: LocalAuthPromotionFixture.origin); try LocalAuthPromotionFixture.save(record, in: vault)
        _ = try await repo.prepareLocalSigning(purpose: .profileControl, operationID: UUID()) // Local-only hydration of this existing hold.
        return (repo, wire, vault, key)
    }
    private static func firstCancellationAction() async throws {
        let (repo, wire, vault, key) = try await cancellationFixture()
        let original = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: vault.read("face-profile-lifecycle")!)
        let ticket = try await repo.prepareFaceProfileCancellation()
        let pending = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: vault.read("face-profile-lifecycle")!), before = await wire.paths
        try expect(pending.pending?.cancelRequested == true && key.signCount == 0 && before.isEmpty,
                   "Cancellation preflight retires the shutter/verifier epoch and saves original restriction before OS auth without signing/dispatch")
        let binding = try await repo.prepareLocalSigning(purpose: .profileControl, operationID: UUID(), transition: ticket)!
        let auth = NativeLocalAuthenticator(makeSession: { LocalAuthSession() })
        try await repo.installLocalSigning(auth.authorize(binding))
        let result = try await scoped(binding) { try await repo.cancelFaceProfileCapture(transition: ticket) }
        let sent = await wire.cancellationOperations
        try expect(result.operation?.serverState == "cancelled" && sent == [original.pending!.operationKey] && key.clearCount == 0 && key.createCount == 0,
                   "First protected cancellation dispatches and reconciles the exact original operation after its post-fence OS grant")
        await repo.finishLocalSigning(operationID: binding.operationID)
        let (lost, lostWire, lostVault, lostKey) = try await cancellationFixture()
        let lostTicket = try await lost.prepareFaceProfileCancellation()
        let lostGrant = try await lost.prepareLocalSigning(purpose: .profileControl, operationID: UUID(), transition: lostTicket)!
        try await lost.installLocalSigning(auth.authorize(lostGrant)); await lostWire.loseNextCancellation()
        let beforeLoss = lostVault.snapshot()
        do { _ = try await scoped(lostGrant) { try await lost.cancelFaceProfileCapture(transition: lostTicket) }; throw NSError(domain: "Expected lost cancellation reply", code: 1) }
        catch NativeAPIError.unavailable {}
        try expect(beforeLoss == lostVault.snapshot() && lostKey.clearCount == 0, "Lost cancellation reply preserves exact restrictive intent and original key")
        await lost.finishLocalSigning(operationID: lostGrant.operationID)
        let retryTicket = try await lost.prepareFaceProfileCancellation()
        let retryGrant = try await lost.prepareLocalSigning(purpose: .profileControl, operationID: UUID(), transition: retryTicket)!
        try await lost.installLocalSigning(auth.authorize(retryGrant))
        let retried = try await scoped(retryGrant) { try await lost.cancelFaceProfileCapture(transition: retryTicket) }
        let attempts = await lostWire.cancellationOperations
        try expect(retried.operation?.serverState == "cancelled" && attempts.count == 2 && Set(attempts).count == 1 && lostKey.createCount == 0,
                   "A fresh post-fence grant reconciles a lost cancellation reply with the original operation, never a new action")
        for change in ["operation", "epoch", "cancel"] {
            let (other, transport, secrets, signer) = try await cancellationFixture()
            let pending = try await other.prepareFaceProfileCancellation()
            let grant = try await other.prepareLocalSigning(purpose: .profileControl, operationID: UUID(), transition: pending)!
            if change == "cancel" {
                let denied = NativeLocalAuthenticator(makeSession: { LocalAuthSession(failure: .cancelled) })
                do { _ = try await denied.authorize(grant); throw NSError(domain: "Expected cancelled cancellation grant", code: 1) }
                catch NativeLocalAuthenticationIssue.cancelled {}
            } else { try await other.installLocalSigning(auth.authorize(grant)) }
            if change == "operation" {
                var object = try JSONSerialization.jsonObject(with: secrets.read("face-profile-lifecycle")!) as! [String: Any]
                var operation = object["pending"] as! [String: Any]; operation["operationKey"] = UUID().uuidString.lowercased(); object["pending"] = operation
                try secrets.write("face-profile-lifecycle", data: JSONSerialization.data(withJSONObject: object))
            } else if change == "epoch" { await other.clearSession() }
            let state = secrets.snapshot(), paths = await transport.paths
            do { _ = try await scoped(grant) { try await other.cancelFaceProfileCapture(transition: pending) }; throw NSError(domain: "Stale cancellation accepted", code: 1) }
            catch is NativeLocalAuthenticationIssue {}
            let after = await transport.paths
            try expect(state == secrets.snapshot() && paths == after && signer.signCount == 0 && signer.clearCount == 0,
                       "Changed/cancelled cancellation " + change + " preserves original restriction and cannot sign/dispatch")
        }
        let (logout, logoutWire, logoutVault, logoutKey) = try await cancellationFixture()
        try await logout.logout()
        let loggedOut = await logout.summary(), retired = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: logoutVault.read("face-profile-lifecycle")!)
        let logoutPaths = await logoutWire.paths
        try expect(loggedOut == nil && retired.credentials == nil && retired.pending?.cancelRequested == true && logoutKey.signCount == 0 &&
                   logoutPaths == ["/auth/logout"], "Logout immediately retires local authority and stages remote cancellation without borrowing its retired signing grant")
        let continuation = try await logout.prepareFaceProfileCancellation()
        let fresh = try await logout.prepareLocalSigning(purpose: .profileControl, operationID: UUID(), transition: continuation)!
        try await logout.installLocalSigning(auth.authorize(fresh))
        let cancelled = try await scoped(fresh) { try await logout.cancelFaceProfileCapture(transition: continuation) }
        try expect(!cancelled.authenticated && cancelled.operation?.serverState == "cancelled", "Post-logout cancellation requires a fresh explicit grant and cannot sign the account back in")
    }
    static func main() async throws {
        try await permits(); try await failures(); try await repository(); try await concurrentCredentialChange()
        try await promotionRetry(); try await changedPromotionBindings()
        try await guestPrivacy(); try await staleGuestTickets(); try await guestDeletionCleanup()
        try await guestLostRepliesAndResume(); try await guestResumeWrongKey(); try await profileDeletionCleanup()
        try await firstRecoveryAction(); try await firstCancellationAction()
        print("NativeLocalAuthenticationTests: \(assertions) assertions passed; injected OS/software-key host scope only")
    }
}
