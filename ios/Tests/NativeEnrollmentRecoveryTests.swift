import Foundation
import CryptoKit

// Controlled lifecycle/contract tests of the production repository. No real
// verifier, server, camera, Keychain, Secure Enclave or iOS SDK is qualified.
private final class RecoverySecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var failure: String?, removeOnly = false
    private var failedState: NativeEnrollmentState?
    func fail(_ name: String, removal: Bool = false) { lock.lock(); defer { lock.unlock() }; failure = name; removeOnly = removal }
    func failJournal(_ state: NativeEnrollmentState) { lock.lock(); defer { lock.unlock() }; failedState = state }
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if failure == name && (!removeOnly || data == nil) { failure = nil; throw NativeAPIError.unavailable("protected_storage") }
        if name == "face-enrollment-journal", let data, let state = failedState,
           try JSONDecoder().decode(NativeEnrollmentRecord.self, from: data).state == state {
            failedState = nil; throw NativeAPIError.unavailable("protected_storage")
        }
        values[name] = data
    }
    func journal() throws -> NativeEnrollmentRecord {
        guard let data = try read("face-enrollment-journal") else { throw NativeAPIError.invalidResponse }
        return try JSONDecoder().decode(NativeEnrollmentRecord.self, from: data)
    }
    func save(_ record: NativeEnrollmentRecord) throws { try write("face-enrollment-journal", data: JSONEncoder().encode(record)) }
    func expired(_ credential: NativeCredentials) throws -> NativeCredentials {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(credential)) as! [String: Any]
        object["expiresAt"] = Date().addingTimeInterval(-5).timeIntervalSinceReferenceDate
        return try JSONDecoder().decode(NativeCredentials.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
private final class RecoverySigner: NativeDeviceSigner, @unchecked Sendable {
    private let lock = NSLock()
    private var key: P256.Signing.PrivateKey? = P256.Signing.PrivateKey()
    private var retained = false, cleared = 0
    var jwk: WireValue {
        lock.lock(); defer { lock.unlock() }; retained = true
        let bytes = key!.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(bytes.subdata(in: 1..<33).base64URL), "y": .string(bytes.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
    func publicJWK(alias: String, create: Bool) throws -> WireValue {
        lock.lock(); defer { lock.unlock() }
        guard alias == NativeEnrollmentRecord.keyAlias, !create, let key else { throw NativeAPIError.unavailable("missing_original_key") }
        let bytes = key.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(bytes.subdata(in: 1..<33).base64URL),
            "y": .string(bytes.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
    func sign(_ data: Data) throws -> String {
        lock.lock(); defer { lock.unlock() }; guard let key else { throw NativeAPIError.unavailable("missing_original_key") }
        retained = true; return try key.signature(for: data).rawRepresentation.base64URL
    }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() { lock.lock(); defer { lock.unlock() }; key = nil; retained = false; cleared += 1 }
    func missing() { lock.lock(); defer { lock.unlock() }; key = nil; retained = false }
    func replace() { lock.lock(); defer { lock.unlock() }; key = P256.Signing.PrivateKey(); retained = true }
    func hasRetainedKey() throws -> Bool { lock.lock(); defer { lock.unlock() }; return retained }
    var clearCount: Int { lock.lock(); defer { lock.unlock() }; return cleared }
}
private actor RecoveryFixture: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000061"
    static let other = "00000000-0000-4000-8000-000000000062"
    static let device = "00000000-0000-4000-8000-000000000063"
    static let revision = "00000000-0000-4000-8000-000000000064"
    static let profile = "00000000-0000-4000-8000-000000000065"
    static let policy = "registered-face-opencv-v1"
    private let secrets: RecoverySecrets
    private var publicKey: P256.Signing.PublicKey?
    private var startBody: WireValue?, challenge: WireValue = .null, captureRows: [WireValue] = []
    private var created = Date(), generation = 1, registered = false, expired = false
    private var forcedState: String?, loss: (String, Bool)?
    private var responseOverrides: [String: WireValue] = [:], ackOverrides: [String: WireValue] = [:]
    private var denyRecovery: (Int, String)?, denyMe = false, failSlotRefresh = false
    private var consumedRefresh: Set<String> = [], resumes: [String: WireValue] = [:]
    private var deletionBody: WireValue?, deletionCreated = Date(), deletionPhase = "pending_approval"
    private(set) var paths: [String] = [], startBodies: [WireValue] = [], refreshBodies: [String] = []
    private(set) var anonymousCount = 0, completeCount = 0, resumeCount = 0, signatureCount = 0
    private(set) var logoutTokens: [String] = [], logoutSawRetiredPromotion = false
    init(secrets: RecoverySecrets) { self.secrets = secrets }
    nonisolated func cancelPending() {}
    func lose(_ path: String, after: Bool = true) { loss = (path, after) }
    func state(_ value: String?) { forcedState = value }
    func expire() { expired = true }
    func cleanExpiredProofs(sparse: Bool) { expired = true; captureRows = sparse ? Array(captureRows.dropFirst()) : [] }
    func overrideRecovery(_ values: [String: WireValue]) { responseOverrides = values }
    func overrideACK(_ values: [String: WireValue]) { ackOverrides = values }
    func refuseRecovery(_ status: Int, _ code: String) { denyRecovery = (status, code) }
    func refuseMe(_ value: Bool = true) { denyMe = value }
    func failSlotAfterRefresh() { failSlotRefresh = true }
    func deletionStatus(_ value: String) { deletionPhase = value }
    func wasConsumed(_ token: String) -> Bool { consumedRefresh.contains(token) }
    private func reply(_ value: WireValue, _ status: Int = 200) throws -> NativeHTTPReply { NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try value.encoded()) }
    private func denied(_ status: Int, _ code: String) throws -> NativeHTTPReply { try reply(.object(["error": .object(["code": .string(code)])]), status) }
    private func date(_ value: Date) -> WireValue {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return .string(formatter.string(from: value))
    }
    private func credentials(_ method: String) throws -> WireValue {
        let claims: WireValue = .object(["sub": .string(Self.account), "auth_method": .string(method), "jti": .string(UUID().uuidString), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return .object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("fixture-refresh-" + UUID().uuidString), "expires_in": .integer(900), "roles": .strings(["user"]), "account_id": .string(Self.account), "auth_method": .string(method)])
    }
    private func method(_ request: URLRequest) -> String? {
        guard let token = request.value(forHTTPHeaderField: "Authorization")?.split(separator: " ").last,
              let part = token.split(separator: ".").dropFirst().first, let bytes = Data(base64URL: String(part)) else { return nil }
        return (try? WireValue.decoded(bytes))?["auth_method"].string
    }
    private func verify(_ signature: String?, envelope: WireValue, key: P256.Signing.PublicKey? = nil) throws {
        guard let key = key ?? publicKey, let signature, let bytes = Data(base64URL: signature), bytes.count == 64,
              key.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: bytes), for: try envelope.canonical()) else { throw NativeAPIError.invalidResponse }
        signatureCount += 1
    }
    private func newChallenge(login: Bool = false) -> WireValue {
        var result: [String: WireValue] = ["protocol": .string("lovelies-face-auth-v1"), "challenge_id": .string(UUID().uuidString.lowercased()), "account_id": .string(Self.account), "device_id": .string(Self.device), "device_revision": .string(Self.revision), "nonce": .string("lfn_" + Data(repeating: UInt8(generation), count: 32).base64URL), "purpose": .string(login ? "login" : "registration"), "profile_id": login ? .string(Self.profile) : .null, "profile_revision": login ? .string("fixture-profile-v1") : .null, "model_id": login ? .string("yunet-sface-v1") : .null, "policy_version": .string(Self.policy), "required_captures": .integer(login ? 1 : 3), "poses": .strings(login ? ["front"] : ["front", "left", "right"]), "maximum_capture_bytes": .integer(8 * 1024 * 1024), "expires_at": date(Date().addingTimeInterval(100))]
        if !login, let startBody {
            result["enrollment_key"] = startBody["enrollment_key"]; result["face_handle"] = startBody["face_handle"]
            result["public_key_digest"] = .string(SHA256.hash(data: try! startBody["device_public_jwk"].canonical()).map { String(format: "%02x", $0) }.joined())
            result["enrollment_generation"] = .integer(generation)
        }
        return audienceBoundChallenge(.object(result))
    }
    private func maybeLose(_ path: String, after: Bool) throws {
        if let loss, loss.0 == path, loss.1 == after { self.loss = nil; throw URLError(.timedOut) }
    }
    private func deliveryReply(_ value: WireValue, body: WireValue) throws -> WireValue {
        guard body["protocol"].string == NativeRefreshDeliveryRecord.protocolName else { return value }
        var fields = value.object!
        let token = try value.text("access_token"), claims = try WireValue.decoded(Data(base64URL: String(token.split(separator: ".")[1]))!)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        fields["protocol"] = .string(NativeRefreshDeliveryRecord.protocolName); fields["rotation_key"] = body["rotation_key"]
        fields["access_expires_at"] = .string(formatter.string(from: Date(timeIntervalSince1970: Double(claims["exp"].integer!))))
        fields["refresh_expires_at"] = .string(formatter.string(from: Date().addingTimeInterval(7 * 86400)))
        fields["delivery_expires_at"] = .string(formatter.string(from: Date().addingTimeInterval(86400)))
        return .object(fields)
    }
    // These named software actors are explicitly declared synthetic adults in
    // this fixture setup. This is neither a production default nor age proof.
    private func declaredAdultAudience(account: String) -> WireValue {
        .object(["protocol": .string("lovelies-audience-v1"), "policy_version": .string("audience-2026-10-24-v1"), "account_id": .string(account),
            "audience": .object(["age_band": .string("18_plus"), "status": .string("eligible"), "version": .integer(1), "policy_version": .string("audience-2026-10-24-v1"), "next_review_at": .null]),
            "guardian_request": .null, "capabilities": .object(["face_authentication": .bool(true), "photo_matching": .bool(true), "photo_processing": .bool(true)])])
    }
    private func audienceBoundChallenge(_ wire: WireValue) -> WireValue {
        var value = wire.object!
        value["audience_authority"] = .object(["protocol": .string("lovelies-audience-challenge-v1"), "policy_version": .string("audience-2026-10-24-v1"),
            "account_id": wire["account_id"], "challenge_id": wire["challenge_id"], "device_id": wire["device_id"], "purpose": wire["purpose"], "audience_version": .integer(1), "expires_at": wire["expires_at"]])
        return .object(value)
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        let body = request.value(forHTTPHeaderField: "Content-Type") == "application/json" ? try request.httpBody.map(WireValue.decoded) ?? .null : .null
        try maybeLose(path, after: false)
        switch path {
        case "/me/audience":
            guard let token = request.value(forHTTPHeaderField: "Authorization")?.split(separator: " ").last,
                  let payload = token.split(separator: ".").dropFirst().first.flatMap({ Data(base64URL: String($0)) }),
                  let claims = try? WireValue.decoded(payload), let account = claims["sub"].string,
                  [Self.account].contains(account) else { return try denied(401, "session_invalid") }
            return try reply(declaredAdultAudience(account: account))
        case "/auth/logout":
            logoutTokens.append(request.value(forHTTPHeaderField: "Authorization") ?? "")
            let record = try secrets.journal()
            logoutSawRetiredPromotion = record.promotionCredentials == nil && record.promotionDevice == nil && record.state == .registered
            return try reply(.object(["status": .string("logged_out")]))
        case "/auth/anonymous": anonymousCount += 1; return try reply(credentials("anonymous"), 201)
        case "/auth/session/refresh":
            let token = try body.text("refresh_token"); refreshBodies.append(token)
            if consumedRefresh.contains(token) { return try denied(401, "session_invalid") }; consumedRefresh.insert(token)
            if failSlotRefresh { failSlotRefresh = false; secrets.fail("credentials") }
            return try reply(deliveryReply(credentials(method(request) ?? "anonymous"), body: body))
        case "/me":
            if denyMe { return try denied(503, "temporarily_unavailable") }
            guard let method = method(request), method == (registered ? "registered_face" : "anonymous") else { return try denied(401, "session_invalid") }
            return try reply(.object(["user_id": .string(Self.account), "auth_method": .string(method), "authenticated": .bool(registered), "roles": .strings(["user"])]))
        case "/auth/face/registration/challenge":
            let journal = try secrets.journal()
            guard body == journal.startBody, body["account_id"].string == Self.account, method(request) == "anonymous", body["roles"] == .null else { throw NativeAPIError.invalidResponse }
            try verify(body["device_signature"].string, envelope: journal.startEnvelope, key: journal.publicKey())
            startBodies.append(body)
            if let previous = startBody { guard previous == body else { return try denied(409, "enrollment_conflict") } }
            else { startBody = body; publicKey = try journal.publicKey(); challenge = newChallenge(); created = Date() }
            try maybeLose(path, after: true); return try reply(challenge)
        case "/auth/face/registration/recovery", "/auth/face/registration/resume":
            let journal = try secrets.journal()
            var envelope = body.object!; envelope.removeValue(forKey: "device_signature"); envelope["protocol"] = .string("lovelies-face-enrollment-device-v1"); envelope["step"] = .string(path.hasSuffix("resume") ? "resume" : "status")
            try verify(body["device_signature"].string, envelope: .object(envelope), key: journal.publicKey())
            guard body["account_id"].string == journal.accountID, body["enrollment_key"].string == journal.enrollmentKey, body["face_handle"].string == journal.faceHandle,
                  UUID(uuidString: try body.text("request_nonce")) != nil, let expiry = body["request_expires_at"].integer,
                  Double(expiry) > Date().timeIntervalSince1970 * 1000, Double(expiry) <= Date().addingTimeInterval(60).timeIntervalSince1970 * 1000 else { throw NativeAPIError.invalidResponse }
            if let denyRecovery { return try denied(denyRecovery.0, denyRecovery.1) }
            guard let startBody else { return try denied(404, method(request) == "anonymous" ? "enrollment_not_found" : "enrollment_recovery_unavailable") }
            guard body["enrollment_key"] == startBody["enrollment_key"], body["face_handle"] == startBody["face_handle"] else { throw NativeAPIError.invalidResponse }
            if path.hasSuffix("resume") {
                guard method(request) == "anonymous", !registered, forcedState == nil, let key = body["resume_key"].string,
                      journal.resume?.key == key else { return try denied(409, "enrollment_unresolved") }
                if let existing = resumes[key] { return try reply(existing) }
                guard body["expected_generation"].integer == generation, body["expected_challenge_id"] == challenge["challenge_id"] else { return try denied(409, "enrollment_conflict") }
                resumeCount += 1; generation += 1; expired = false; captureRows = []; challenge = newChallenge(); resumes[key] = challenge
                try maybeLose(path, after: true); return try reply(challenge)
            }
            var base = challenge.object!; ["enrollment_key", "face_handle", "public_key_digest", "enrollment_generation"].forEach { base.removeValue(forKey: $0) }
            var value: [String: WireValue] = ["protocol": .string("lovelies-face-enrollment-v1"), "account_id": .string(Self.account), "enrollment_key": startBody["enrollment_key"], "device_id": .string(Self.device), "device_revision": .string(Self.revision), "public_key_digest": .string(journal.publicKeyDigest), "policy_version": .string(Self.policy), "enrollment_generation": .integer(generation), "challenge_id": challenge["challenge_id"], "request_nonce": body["request_nonce"], "expires_at": date(created.addingTimeInterval(30 * 86400)), "authenticated": .bool(false), "state": .string(registered ? "registered" : forcedState ?? (expired ? "restart_required" : "pending")), "challenge": registered || expired ? .null : .object(base), "captures": .array(registered ? [] : captureRows), "profile": registered ? .object(["id": .string(Self.profile), "revision": .string("fixture-profile-v1"), "model_id": .string("yunet-sface-v1")]) : .null]
            for (key, replacement) in responseOverrides { value[key] = replacement }; return try reply(.object(value))
        case "/auth/face/challenge":
            guard registered, body["face_handle"] == startBody?["face_handle"], body["device_id"].string == Self.device else { return try denied(401, "face_handle_unavailable") }
            challenge = newChallenge(login: true); captureRows = []; return try reply(challenge)
        case "/auth/face/registration/complete", "/auth/face/complete":
            let journal = try secrets.journal()
            guard journal.state == .completionPending, body["challenge_id"] == challenge["challenge_id"], captureRows.count == (registered ? 1 : 3) else { throw NativeAPIError.invalidResponse }
            var envelope = try NativeFaceChallenge(challenge, accountID: Self.account, purpose: registered ? "login" : "registration").deviceEnvelope()
            envelope["step"] = .string("complete"); envelope["capture_manifest"] = .array(captureRows)
            try verify(body["device_signature"].string, envelope: .object(envelope)); completeCount += 1; registered = true
            var result = try credentials("registered_face").object!; result["protocol"] = .string("lovelies-face-auth-v1"); result["status"] = .string("authenticated"); result["device_id"] = .string(Self.device); result["profile_id"] = .string(Self.profile); result["profile_revision"] = .string("fixture-profile-v1"); result["model_id"] = .string("yunet-sface-v1")
            try maybeLose(path, after: true); return try reply(.object(result))
        case "/privacy/account-deletion":
            guard method(request) == "anonymous", !registered else { return try denied(403, "anonymous_required") }
            deletionBody = body; deletionCreated = Date(); expired = true
            try maybeLose(path, after: true); return try deletionReply()
        case "/privacy/account-deletion/status":
            guard request.value(forHTTPHeaderField: "Authorization") == nil, body["status_token"] == deletionBody?["status_token"] else { return try denied(404, "deletion_status_unavailable") }
            return try deletionReply()
        default:
            guard path.hasPrefix("/auth/face/proof/"), let index = Int(path.split(separator: "/").last!), let bytes = request.httpBody else { throw NativeAPIError.invalidResponse }
            let journal = try secrets.journal(), planned = registered ? journal.loginCaptures : journal.captures
            guard journal.state == .capturePending, index == captureRows.count, planned.count == index + 1, !planned[index].accepted,
                  planned[index].sha256 == SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() else { throw NativeAPIError.invalidResponse }
            var envelope = try NativeFaceChallenge(challenge, accountID: Self.account, purpose: registered ? "login" : "registration").deviceEnvelope()
            envelope["step"] = .string("capture"); envelope["capture_index"] = .integer(index); envelope["capture_sha256"] = .string(planned[index].sha256); envelope["mime"] = .string("image/jpeg"); envelope["byte_size"] = .integer(bytes.count)
            try verify(request.value(forHTTPHeaderField: "X-Lovelies-Device-Signature"), envelope: .object(envelope))
            captureRows.append(planned[index].wire)
            var result: [String: WireValue] = ["protocol": .string("lovelies-face-auth-v1"), "status": .string("capture_received"), "challenge_id": challenge["challenge_id"], "capture_index": .integer(index), "capture_sha256": .string(planned[index].sha256), "byte_size": .integer(bytes.count)]
            for (key, value) in ackOverrides { result[key] = value }
            try maybeLose(path, after: true); return try reply(.object(result))
        }
    }
    private func deletionReply() throws -> NativeHTTPReply {
        guard let deletionBody else { throw NativeAPIError.invalidResponse }
        return try reply(.object(["protocol": .string("lovelies-account-deletion-v1"), "source": .string("privacy"), "operation_key": deletionBody["operation_key"], "privacy_request": .object(["id": .string("00000000-0000-4000-8000-000000000069"), "request_type": .string("delete"), "status": .string(deletionPhase), "created_at": date(deletionCreated), "reviewed_at": deletionPhase == "pending_approval" ? .null : date(Date()), "completed_at": deletionPhase == "completed" ? date(Date()) : .null]), "request_expires_at": date(deletionCreated.addingTimeInterval(7 * 86400)), "request_expired": .bool(false), "deletion_status": .object(["expires_at": date(deletionCreated.addingTimeInterval(30 * 86400))]), "deletion_completed": .bool(deletionPhase == "completed")]))
    }
}

@main struct NativeEnrollmentRecoveryTests {
    private static let origin = URL(string: "https://native-recovery.invalid")!
    private static var checks = 0
    private static func require(_ value: @autoclosure () throws -> Bool, _ label: String) throws { guard try value() else { throw NativeAPIError.unsupported("Recovery check failed: " + label) }; checks += 1 }
    private static func rejects(_ label: String, _ block: () async throws -> Void) async throws {
        do { try await block() } catch { checks += 1; return }; throw NativeAPIError.unsupported("Missing rejection: " + label)
    }
    private static func make() -> (BackendRepository, RecoveryFixture, RecoverySecrets, RecoverySigner) {
        let store = RecoverySecrets(), signer = RecoverySigner(), fixture = RecoveryFixture(secrets: store)
        return (BackendRepository(origin: origin, transport: fixture, secrets: store, signer: signer), fixture, store, signer)
    }
    private static func reconstruct(_ fixture: RecoveryFixture, _ store: RecoverySecrets, _ signer: RecoverySigner) -> BackendRepository { BackendRepository(origin: origin, transport: fixture, secrets: store, signer: signer) }
    private static func started() async throws -> (BackendRepository, RecoveryFixture, RecoverySecrets, RecoverySigner, NativeFaceChallenge) {
        let (repository, fixture, store, signer) = make(); let guest = try await repository.bootstrap()
        try require(guest?.authenticated == false && guest?.accountID == RecoveryFixture.account, "Pristine bootstrap stays anonymous")
        let challenge = try await repository.startFace(consentPolicy: RecoveryFixture.policy, publicKey: signer.jwk)
        try require(challenge.accountID == RecoveryFixture.account && challenge.poses.count == 3, "Start is bound to original account")
        return (repository, fixture, store, signer, challenge)
    }
    private static func fill(_ repository: BackendRepository, _ challenge: NativeFaceChallenge, from index: Int = 0, prefix: [WireValue] = []) async throws -> [WireValue] {
        var result = prefix
        for slot in index..<challenge.poses.count { result.append(try await repository.capture(Data([0xff, 0xd8, 0xff, UInt8(slot + 1)]), index: slot, challenge: challenge)) }
        return result
    }
    private static func run() async throws {
        do {
            let (repository, fixture, store, signer) = make(); _ = try await repository.bootstrap(); let key = signer.jwk
            store.failJournal(.starting)
            try await rejects("Intent persistence before start") { _ = try await repository.startFace(consentPolicy: RecoveryFixture.policy, publicKey: key) }
            let bodies = await fixture.startBodies; try require(bodies.isEmpty, "Missing durable intent forbids registration dispatch")
            _ = try await repository.startFace(consentPolicy: RecoveryFixture.policy, publicKey: key)
            try require((try store.journal()).publicJWK == key && signer.clearCount == 0, "Predispatch storage retry keeps original account/key")
        }
        // The start intent is present before dispatch; committed and absent starts
        // both preserve the original key/body across repository reconstruction.
        for after in [true, false] {
            let (repository, fixture, store, signer) = make(); _ = try await repository.bootstrap(); let key = signer.jwk
            await fixture.lose("/auth/face/registration/challenge", after: after)
            try await rejects("lost start") { _ = try await repository.startFace(consentPolicy: RecoveryFixture.policy, publicKey: key) }
            let before = try store.journal(); try require(before.deviceID == nil && before.state == .starting, "Unacknowledged start remains durable")
            let restored = reconstruct(fixture, store, signer); _ = try await restored.bootstrap()
            let resumed = try await restored.startFace(consentPolicy: before.policy, publicKey: key), current = try store.journal()
            try require(resumed.accountID == before.accountID && current.enrollmentKey == before.enrollmentKey && current.publicJWK == before.publicJWK && current.faceHandle == before.faceHandle, "Start recovery keeps account/key/intent/handle")
            let count = await fixture.anonymousCount; try require(count == 1, "No second anonymous account")
            let bodies = await fixture.startBodies; try require(bodies.allSatisfy { $0 == before.startBody }, "Original start body is replayed unchanged only after absence")
        }
        do {
            let (repository, fixture, store, signer) = make(); _ = try await repository.bootstrap(); let key = signer.jwk
            await fixture.lose("/auth/face/registration/challenge", after: false)
            try await rejects("lost absent start") { _ = try await repository.startFace(consentPolicy: RecoveryFixture.policy, publicKey: key) }
            var before = try store.journal(); before.originalAnonymous = try store.expired(before.originalAnonymous!); try store.save(before)
            try store.write("credentials", data: JSONEncoder().encode(before.originalAnonymous!))
            let restored = reconstruct(fixture, store, signer); _ = try await restored.bootstrap(); _ = try await restored.startFace(consentPolicy: before.policy, publicKey: key)
            let refreshes = await fixture.refreshBodies; try require(refreshes == [before.originalAnonymous!.refresh_token], "Expired absent start rotates only retained guest")
            try require(try store.journal().accountID == before.accountID, "Delayed absent start never changes account")
        }
        do {
            let (repository, fixture, store, signer) = make(); _ = try await repository.bootstrap(); let key = signer.jwk
            await fixture.lose("/auth/face/registration/challenge")
            try await rejects("lost start before expiry") { _ = try await repository.startFace(consentPolicy: RecoveryFixture.policy, publicKey: key) }; await fixture.expire()
            let restored = reconstruct(fixture, store, signer); _ = try await restored.bootstrap()
            let adopted = try store.journal(); try require(adopted.challengeWire == nil && adopted.predecessorID != nil, "Null expired details retain authoritative predecessor ID")
            let next = try await restored.startFace(consentPolicy: adopted.policy, publicKey: key)
            try require(next.deviceID == adopted.deviceID && next.id != adopted.predecessorID && (try store.journal()).generation == 2, "Expired lost start gets same-device successor")
            try require(try store.journal().captures.isEmpty, "Successor never rebinds old proofs")
        }
        for sparse in [false, true] {
            let (repository, fixture, store, signer, challenge) = try await started()
            _ = try await repository.capture(Data([1, 2]), index: 0, challenge: challenge)
            _ = try await repository.capture(Data([3, 4]), index: 1, challenge: challenge)
            await fixture.cleanExpiredProofs(sparse: sparse)
            let restored = reconstruct(fixture, store, signer); _ = try await restored.bootstrap()
            try require((try store.journal()).state == .restartRequired && (try store.journal()).captures.isEmpty, "Expired empty/sparse cleanup retires old completion progress")
            let next = try await restored.startFace(consentPolicy: RecoveryFixture.policy, publicKey: signer.jwk)
            try require(next.deviceID == challenge.deviceID && next.id != challenge.id && next.poses.count == 3, "Cleaned predecessor requires three fresh same-device captures")
        }
        // Planned capture metadata is durable before upload. Acknowledged loss
        // reconciles exact receipts; confirmed absence permits only that slot.
        for after in [true, false] {
            let (repository, fixture, store, signer, challenge) = try await started()
            await fixture.lose("/auth/face/proof/" + challenge.id + "/0", after: after)
            try await rejects("capture response loss") { _ = try await repository.capture(Data([1, 2, 3]), index: 0, challenge: challenge) }
            try require(try store.journal().captures.count == 1 && !(try store.journal()).captures[0].accepted, "Planned ambiguous capture retained")
            let restored = reconstruct(fixture, store, signer); _ = try await restored.bootstrap(); let status = try await restored.enrollmentSummary()!
            try require(status.receipts.count == (after ? 1 : 0), "Only signed accepted receipts advance capture index")
            let cameraRecovery = try await restored.prepareFaceRetake(challenge, terminalQualityFailure: false)
            try require(cameraRecovery.challenge?.id == challenge.id && cameraRecovery.receipts == status.receipts && !cameraRecovery.awaitingServer, "Camera interruption reconciles the original signed prefix before retaking only a missing slot")
            let next = try await restored.startFace(consentPolicy: challenge.wire["policy_version"].string!, publicKey: signer.jwk)
            let index = status.receipts.count; _ = try await restored.capture(Data([4, 5, 6]), index: index, challenge: next)
            try require(try store.journal().captures.count == index + 1 && (try store.journal()).captures.allSatisfy(\.accepted), "Capture resumes exactly at confirmed missing slot")
        }
        for state in ["capture_pending", "verifying"] {
            let (repository, fixture, store, signer, challenge) = try await started(); await fixture.state(state)
            let status = try await repository.recoverEnrollment(); try require(status.awaitingServer, "Unresolved writer/verifier stays blocked")
            let cameraRecovery = try await repository.prepareFaceRetake(challenge, terminalQualityFailure: false)
            try require(cameraRecovery.awaitingServer && cameraRecovery.challenge == nil, "Camera retry cannot bypass an unresolved media writer or verifier")
            try await rejects("Unresolved direct capture") { _ = try await repository.capture(Data([7, 8]), index: 0, challenge: challenge) }
            try await rejects("Unresolved start") { _ = try await repository.startFace(consentPolicy: RecoveryFixture.policy, publicKey: signer.jwk) }
            try await rejects("Unresolved guest deletion preparation") { _ = try await repository.requestGuestDeletion() }
            let paths = await fixture.paths; try require(!paths.contains("/privacy/account-deletion") && !paths.contains("/auth/face/registration/resume"), "Unresolved work cannot prepare deletion or successor")
            try require((try store.journal()).predecessorID == challenge.id, "Unresolved challenge remains bound")
        }
        // Every ACK field is authoritative. Bad 2xx payloads preserve ambiguity
        // and signed recovery can still learn the real accepted capture.
        let ackFields: [(String, WireValue)] = [("protocol", .string("wrong")), ("status", .string("done")), ("challenge_id", .string(RecoveryFixture.other)), ("capture_index", .integer(1)), ("capture_sha256", .string(String(repeating: "0", count: 64))), ("byte_size", .integer(123))]
        for (field, value) in ackFields {
            let (repository, fixture, store, _, challenge) = try await started(); await fixture.overrideACK([field: value])
            try await rejects("ACK " + field) { _ = try await repository.capture(Data([1, 2]), index: 0, challenge: challenge) }
            try require((try store.journal()).state == .capturePending && !(try store.journal()).captures[0].accepted, "Bad ACK cannot mark accepted")
            let status = try await repository.recoverEnrollment(); try require(status.receipts.count == 1, "Signed reconciliation repairs ACK loss")
        }
        do {
            let (repository, fixture, store, signer, challenge) = try await started(); let receipts = try await fill(repository, challenge)
            await fixture.lose("/auth/face/registration/complete")
            try await rejects("Completion response loss") { _ = try await repository.completeFace(challenge, captures: receipts) }
            try require((try store.journal()).state == .completionPending, "Completion intent precedes dispatch")
            let restored = reconstruct(fixture, store, signer); let session = try await restored.bootstrap(); let status = try await restored.enrollmentSummary()
            try require(session == nil && status?.state == .registered && (try store.read("credentials")) == nil, "Readonly registered recovery never authenticates")
            let login = try await restored.startFace(consentPolicy: RecoveryFixture.policy, publicKey: signer.jwk)
            try require(login.purpose == "login" && login.poses == ["front"] && login.accountID == challenge.accountID && login.deviceID == challenge.deviceID, "Committed response loss requires one fresh same-profile selfie")
            try await rejects("Ordinary current login cannot be recreated by camera retry before terminal quality failure or expiry") { _ = try await restored.prepareFaceRetake(login, terminalQualityFailure: false) }
            try require((try store.journal()).loginChallengeWire?["challenge_id"].string == login.id, "Held ordinary camera retry preserves original fresh-login challenge")
            let fresh = try await fill(restored, login), authenticated = try await restored.completeFace(login, captures: fresh)
            try require(authenticated.authenticated && authenticated.accountID == challenge.accountID && (try store.read("face-enrollment-journal")) == nil, "Fresh login completes replayable promotion")
            let count = await fixture.completeCount; try require(count == 2, "Registration completion never replayed")
        }
        // Failure at each promotion boundary retains enough original authority
        // to validate/recover; the journal is retired last.
        do {
            let (repository, fixture, store, signer, original) = try await started(); let registrationProof = try await fill(repository, original)
            await fixture.lose("/auth/face/registration/complete")
            try await rejects("Prepare committed registration reply loss") { _ = try await repository.completeFace(original, captures: registrationProof) }
            let recovered = reconstruct(fixture, store, signer); _ = try await recovered.bootstrap()
            let login = try await recovered.startFace(consentPolicy: RecoveryFixture.policy, publicKey: signer.jwk)
            await fixture.lose("/auth/face/proof/" + login.id + "/0")
            try await rejects("Interrupted ordinary fresh selfie inside A01 journal") { _ = try await recovered.capture(Data([8, 9]), index: 0, challenge: login) }
            let again = reconstruct(fixture, store, signer), publicSession = try await again.bootstrap(), held = try await again.enrollmentSummary()!
            try require(publicSession == nil && held.awaitingServer && (try store.journal()).loginChallengeWire?["challenge_id"].string == login.id, "A01 restart preserves unexpired ordinary proof rather than clearing it through registration status")
            try await rejects("A01 camera retry retains ordinary ambiguity until terminal result/expiry") { _ = try await again.prepareFaceRetake(login, terminalQualityFailure: false) }
        }
        for boundary in ["registered-device", "credentials", "pending-face-device", "face-enrollment-journal"] {
            let (repository, fixture, store, signer, challenge) = try await started(); let receipts = try await fill(repository, challenge)
            store.fail(boundary, removal: boundary == "pending-face-device" || boundary == "face-enrollment-journal")
            try await rejects("Promotion storage " + boundary) { _ = try await repository.completeFace(challenge, captures: receipts) }
            try require((try store.journal()).promotionCredentials != nil && signer.clearCount == 0, "Interrupted promotion keeps credentials/key in journal")
            let restored = reconstruct(fixture, store, signer); let result = try await restored.bootstrap()
            try require(result?.authenticated == true && result?.accountID == challenge.accountID && (try store.read("face-enrollment-journal")) == nil, "Promotion restart repairs original account")
            let count = await fixture.anonymousCount; try require(count == 1, "Promotion cannot bootstrap guest")
        }
        do {
            let (repository, fixture, store, signer, challenge) = try await started(); let receipts = try await fill(repository, challenge)
            store.fail("registered-device")
            try await rejects("A01 staged completion before registered-device publication") { _ = try await repository.completeFace(challenge, captures: receipts) }
            let original = try store.journal(), staged = original.promotionCredentials!
            try require((try store.read("registered-device")) == nil, "A01 staged ownership comes from original signed journal before public device exists")
            await repository.clearSession(); try await repository.logout()
            let retired = try store.journal(), tokens = await fixture.logoutTokens, beforeAwait = await fixture.logoutSawRetiredPromotion
            try require(beforeAwait && tokens.contains("Bearer " + staged.access_token) && retired.promotionCredentials == nil && retired.promotionDevice == nil && retired.publicKeyDigest == original.publicKeyDigest && retired.enrollmentKey == original.enrollmentKey, "A01 explicit logout retires staged authority before transport and revokes exact token while preserving original journal/key")
            let rebuilt = reconstruct(fixture, store, signer), session = try await rebuilt.bootstrap()
            try require(session == nil && (try store.journal()).promotionCredentials == nil, "A01 restart cannot automatically republish explicitly logged-out staged authority")
        }
        do {
            let (repository, fixture, store, signer, challenge) = try await started(); let receipts = try await fill(repository, challenge)
            store.failJournal(.promoting)
            try await rejects("Received credentials journal failure") { _ = try await repository.completeFace(challenge, captures: receipts) }
            let restored = reconstruct(fixture, store, signer); let result = try await restored.bootstrap()
            try require(result == nil && (try store.journal()).state == .registered, "Unstaged credential response recovers read-only before fresh login")
        }
        // Both kinds of single-use refresh survive an older generic slot.
        for method in ["anonymous", "registered_face"] {
            let (repository, fixture, store, signer, challenge) = try await started()
            var record: NativeEnrollmentRecord
            if method == "registered_face" {
                let receipts = try await fill(repository, challenge); store.fail("pending-face-device", removal: true)
                try await rejects("Prepare durable promotion") { _ = try await repository.completeFace(challenge, captures: receipts) }
            }
            record = try store.journal()
            let original = method == "anonymous" ? record.originalAnonymous! : record.promotionCredentials!
            let expired = try store.expired(original)
            if method == "anonymous" { record.originalAnonymous = expired } else { record.promotionCredentials = expired }
            try store.save(record); try store.write("credentials", data: JSONEncoder().encode(expired)); await fixture.failSlotAfterRefresh()
            let first = reconstruct(fixture, store, signer)
            try await rejects("Rotated slot write failure") { _ = try await first.bootstrap(); if method == "anonymous" { try await first.refresh() } }
            let survived = try store.journal(), rotated = method == "anonymous" ? survived.originalAnonymous! : survived.promotionCredentials!
            try require(rotated.refresh_token != original.refresh_token, "Journal keeps rotated refresh before slot write")
            let restored = reconstruct(fixture, store, signer); _ = try await restored.bootstrap()
            if method == "anonymous" { try await restored.refresh() }
            let replayed = await fixture.refreshBodies
            try require(replayed.filter { $0 == original.refresh_token }.count == 1, "Consumed refresh never overwrites surviving journal")
            let consumed = await fixture.wasConsumed(original.refresh_token); try require(consumed, "Fixture enforces single-use refresh")
        }
        // Binding errors and unavailable authority never authorize absence/newkey.
        for (field, value) in [("account_id", WireValue.string(RecoveryFixture.other)), ("public_key_digest", .string(String(repeating: "f", count: 64))), ("policy_version", .string("wrong")), ("device_id", .string(RecoveryFixture.other)), ("request_nonce", .string(RecoveryFixture.other)), ("enrollment_generation", .integer(2)), ("authenticated", .bool(true)), ("challenge_id", .string(RecoveryFixture.other))] {
            let (repository, fixture, store, signer, _) = try await started(); let before = try store.journal(); await fixture.overrideRecovery([field: value])
            try await rejects("Recovery binding " + field) { _ = try await repository.recoverEnrollment() }
            try require((try store.journal()).enrollmentKey == before.enrollmentKey && signer.clearCount == 0, "Rejected binding retains original journal/key")
        }
        for (status, code) in [(503, "temporarily_unavailable"), (401, "device_proof_invalid"), (404, "enrollment_recovery_unavailable")] {
            let (repository, fixture, store, signer, _) = try await started(); await fixture.refuseRecovery(status, code)
            let restored = reconstruct(fixture, store, signer); try await rejects("Recovery denial") { _ = try await restored.bootstrap() }
            let count = await fixture.anonymousCount; try require(count == 1 && (try store.read("face-enrollment-journal")) != nil && signer.clearCount == 0, "Transient/unknown denial cannot recreate account/key")
        }
        for missing in [true, false] {
            let (_, fixture, store, signer, _) = try await started(); let count = await fixture.paths.count
            if missing { signer.missing() } else { signer.replace() }
            let restored = reconstruct(fixture, store, signer); try await rejects("Missing/changed original key") { _ = try await restored.bootstrap() }
            let after = await fixture.paths.count; try require(after == count && (try store.read("face-enrollment-journal")) != nil, "Key failure blocks all recovery requests")
        }
        do {
            let (_, fixture, store, signer, _) = try await started(); try store.write("face-enrollment-journal", data: nil); try store.write("pending-face-device", data: nil); try store.write("credentials", data: nil)
            let restored = reconstruct(fixture, store, signer); try await rejects("Orphaned persistent key") { _ = try await restored.bootstrap() }
            let count = await fixture.anonymousCount; try require(count == 1, "Missing recovery storage cannot mint replacement account")
        }
        // Higher-priority D04 holds keep A01 privately and release only after
        // explicit same-account revalidation plus enrollment reconciliation.
        do {
            let (repository, fixture, store, signer, _) = try await started(); let original = try store.journal()
            _ = try await repository.requestGuestDeletion()
            try require((try store.journal()).enrollmentKey == original.enrollmentKey && signer.clearCount == 0, "Deletion acknowledgement retains original enrollment/key privately")
            try await rejects("Capture while deletion held") { _ = try await repository.startFace(consentPolicy: RecoveryFixture.policy, publicKey: signer.jwk) }
            await fixture.deletionStatus("rejected")
            let restored = reconstruct(fixture, store, signer); _ = try await restored.bootstrap(); _ = try await restored.checkGuestDeletion()
            let session = try await restored.resumeGuestSetup()
            try require(session.accountID == original.accountID && !session.authenticated && (try store.read("guest-deletion-receipt")) == nil, "Rejected deletion resumes only original reconciled guest")
            let next = try await restored.startFace(consentPolicy: original.policy, publicKey: signer.jwk)
            try require(next.deviceID == original.deviceID && (try store.journal()).generation == 2, "Deletion-cancelled registration resumes same key/device")
        }
        do {
            let (repository, fixture, store, signer, _) = try await started(); _ = try await repository.requestGuestDeletion(); await fixture.deletionStatus("completed")
            _ = try await repository.checkGuestDeletion()
            try require((try store.read("face-enrollment-journal")) == nil && signer.clearCount == 1, "Confirmed own-account deletion clears own journal/key")
        }
        do {
            let (repository, fixture, store, signer) = make(); _ = try await repository.bootstrap(); let key = signer.jwk
            await fixture.lose("/auth/face/registration/challenge", after: false)
            try await rejects("Absent start before guest hold") { _ = try await repository.startFace(consentPolicy: RecoveryFixture.policy, publicKey: key) }
            _ = try await repository.requestGuestDeletion(); await fixture.deletionStatus("rejected")
            let restored = reconstruct(fixture, store, signer); _ = try await restored.bootstrap(); _ = try await restored.checkGuestDeletion()
            let resumed = try await restored.resumeGuestSetup()
            try require(resumed.accountID == RecoveryFixture.account && (try store.journal()).state == .starting, "Absent enrollment stays private through explicit same-account guest resume")
            _ = try await restored.startFace(consentPolicy: RecoveryFixture.policy, publicKey: key)
            let count = await fixture.anonymousCount; try require(count == 1, "Guest absence recovery cannot bootstrap another account")
        }
        let fence = NativePublicationFence(generation: 8)
        try require(!fence.permits(currentGeneration: 9, cancelled: false) && !fence.permits(currentGeneration: 8, cancelled: true), "Old/cancelled enrollment UI cannot publish")
    }
    static func main() async {
        do { try await run(); print("Native enrollment recovery controlled checks passed: \(checks). Host protocol fixtures; not iOS/device/server acceptance.") }
        catch { print("Native enrollment recovery controlled checks FAILED: " + error.localizedDescription); exit(1) }
    }
}
