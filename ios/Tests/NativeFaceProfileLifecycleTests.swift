import Foundation
import CryptoKit

// Controlled production-repository checks. Provider/model/server/Keychain/iOS
// device behavior is deliberately outside this software-transport fixture.
private final class ProfileSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock(); private var values: [String: Data] = [:]
    private var failName: String?, failAfter = 0
    func fail(_ name: String, after: Int = 0) { lock.lock(); defer { lock.unlock() }; failName = name; failAfter = after }
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if failName == name { if failAfter == 0 { failName = nil; throw NativeAPIError.unavailable("protected_storage") }; failAfter -= 1 }
        values[name] = data
    }
    func journal() throws -> NativeFaceLifecycleRecord { guard let data = try read("face-profile-lifecycle") else { throw NativeAPIError.invalidResponse }; return try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: data) }
}
private final class ProfileSigner: NativeDeviceSigner, @unchecked Sendable {
    private let lock = NSLock(); private var key: P256.Signing.PrivateKey? = P256.Signing.PrivateKey()
    private(set) var creates = 0, clears = 0
    func publicJWK(alias: String, create: Bool) throws -> WireValue {
        lock.lock(); defer { lock.unlock() }; guard alias == NativeEnrollmentRecord.keyAlias else { throw NativeAPIError.invalidResponse }
        if create { creates += 1 }; guard let key else { throw NativeAPIError.unavailable("original_key_missing") }
        let bytes = key.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(bytes.subdata(in: 1..<33).base64URL), "y": .string(bytes.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
    func sign(_ bytes: Data) throws -> String { try sign(bytes, alias: NativeEnrollmentRecord.keyAlias) }
    func sign(_ bytes: Data, alias: String) throws -> String { lock.lock(); defer { lock.unlock() }; guard alias == NativeEnrollmentRecord.keyAlias, let key else { throw NativeAPIError.unavailable("original_key_missing") }; return try key.signature(for: bytes).rawRepresentation.base64URL }
    func sha256(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    func clear() { lock.lock(); defer { lock.unlock() }; key = nil; clears += 1 }
    func clear(alias: String) { clear() }
    func hasRetainedKey() throws -> Bool { lock.lock(); defer { lock.unlock() }; return key != nil }
    func replaceKey() { lock.lock(); defer { lock.unlock() }; key = P256.Signing.PrivateKey() }
}
private actor ProfileGate {
    private var waiting = false, continuation: CheckedContinuation<Void, Never>?, observers: [CheckedContinuation<Void, Never>] = []
    func pause() async { waiting = true; observers.forEach { $0.resume() }; observers = []; await withCheckedContinuation { continuation = $0 } }
    func started() async { if !waiting { await withCheckedContinuation { observers.append($0) } } }
    func release() { continuation?.resume(); continuation = nil }
}
private actor ProfileFixture: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000091", device = "00000000-0000-4000-8000-000000000092", revision = "00000000-0000-4000-8000-000000000093", profile = "00000000-0000-4000-8000-000000000094", foreign = "00000000-0000-4000-8000-000000000095"
    static let policy = "registered-face-opencv-v1", photoPolicy = "photo-model-v1"
    private let store: ProfileSecrets, initialDigest: String
    private var version = 1, auth = true, matching = true, processing = true, receiving = true, paused = false
    private var profile: NativeEnrollmentProfile? = NativeEnrollmentProfile(id: ProfileFixture.profile, revision: "profile-v1", modelID: "yunet-sface-v1")
    private var removal = "none", control = false, controlExpired = false, controlKey: String?, creationKey: String?, operation: WireValue = .null, challenge: WireValue = .null
    private var proofs: [WireValue] = [], currentOverrides: [String: WireValue] = [:], deviceOverrides: [String: WireValue] = [:]
    private var overrides: [String: WireValue] = [:], captureOverrides: [String: WireValue] = [:], denied: (Int, String)?, loss: (String, Bool)?, captureGate: ProfileGate?
    private var usedRefresh: Set<String> = [], refreshTokens: [String] = [], loggedOutTokens: [String] = [], failRefreshSlot = false, rejectFace = false
    private(set) var paths: [String] = [], signatures = 0, anonymousCount = 0, actionBodies: [WireValue] = [], challengeBodies: [WireValue] = [], completionCount = 0
    init(store: ProfileSecrets, digest: String) { self.store = store; initialDigest = digest }
    nonisolated func cancelPending() {}
    func lose(_ path: String, after: Bool = true) { loss = (path, after) }
    func override(_ value: [String: WireValue]) { overrides = value }
    func overrideCapture(_ value: [String: WireValue]) { captureOverrides = value }
    func unavailable(_ status: Int?, _ code: String = "unavailable") { denied = status.map { ($0, code) } }
    func driftCurrent(_ value: [String: WireValue]) { currentOverrides = value }
    func driftDevice(_ value: [String: WireValue]) { deviceOverrides = value }
    func expireControl() { controlExpired = true }
    func noMatching() { matching = false; receiving = false; paused = true }
    func finishCleanup() { removal = "completed"; if operation["action"].string == "remove" || operation["action"].string == "withdraw_authentication" { var op = operation.object!; op["cleanup_state"] = .string("completed"); operation = .object(op) } }
    func driftVersion() { version += 1 }
    func rejectNextFace() { rejectFace = true }
    func failNextRefreshSlot() { failRefreshSlot = true }
    func refreshCount(_ token: String) -> Int { refreshTokens.filter { $0 == token }.count }
    func logoutCount(_ token: String) -> Int { loggedOutTokens.filter { $0 == token }.count }
    func delayCapture(_ value: ProfileGate) { captureGate = value }
    func expire(sparse: Bool) {
        var op = operation.object!; op["state"] = .string("restart_required"); op["challenge"] = .null
        op["captures"] = sparse && proofs.count > 1 ? .array([proofs[1]]) : .array([]); operation = .object(op)
    }
    func settleWriterProof(_ bytes: Data) {
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        proofs.append(.object(["index": .integer(proofs.count), "sha256": .string(hash), "mime": .string("image/jpeg"), "byte_size": .integer(bytes.count)]))
        var op = operation.object!; op["state"] = .string("pending"); op["captures"] = .array(proofs); operation = .object(op)
    }
    func unsettledWriter() { var op = operation.object!; op["state"] = .string("capture_pending"); operation = .object(op) }
    func awaiting() { var op = operation.object!; op["state"] = .string("verifying"); op["challenge"] = .null; operation = .object(op) }
    func credential() throws -> WireValue {
        let claims: WireValue = .object(["sub": .string(Self.account), "auth_method": .string("registered_face"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return .object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("fixture-refresh-" + UUID().uuidString), "account_id": .string(Self.account), "auth_method": .string("registered_face"), "expires_in": .integer(900), "roles": .strings(["user"])])
    }
    private func reply(_ value: WireValue, _ status: Int = 200) throws -> NativeHTTPReply { NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try value.encoded()) }
    private func failure(_ status: Int, _ code: String) throws -> NativeHTTPReply { try reply(.object(["error": .object(["code": .string(code)])]), status) }
    private func lost(_ path: String, after: Bool) throws { if let loss, loss.0 == path && loss.1 == after { self.loss = nil; throw URLError(.timedOut) } }
    private func metadata(nonce: WireValue = .null, withOperation: Bool = false) throws -> WireValue {
        var value: [String: WireValue] = ["protocol": .string("lovelies-face-profile-v1"), "authenticated": .bool(false), "account_id": .string(Self.account), "device_id": .string(Self.device), "device_revision": .string(Self.revision), "public_key_digest": .string(initialDigest), "version": .integer(version), "auth_policy_version": .string(Self.policy), "photo_policy_version": .string(Self.photoPolicy), "profile": profile.map { .object(["id": .string($0.id), "revision": .string($0.revision), "model_id": .string($0.modelID)]) } ?? .null, "authentication_enabled": .bool(auth), "matching_enabled": .bool(matching), "processing_enabled": .bool(processing), "receive_matches": .bool(receiving), "matching_paused": .bool(paused), "removal_state": .string(removal), "operation": withOperation ? operation : .null]
        if nonce != .null { value["request_nonce"] = nonce }; overrides.forEach { value[$0.key] = $0.value }; return .object(value)
    }
    private func verify(_ body: WireValue, step: String) throws {
        let record = try store.journal(); var envelope = body.object!; envelope.removeValue(forKey: "device_signature")
        envelope["protocol"] = .string("lovelies-face-profile-device-v1"); envelope["step"] = .string(step)
        guard body["account_id"].string == record.accountID, body["device_id"].string == record.originalDevice.deviceID,
              let bytes = body["device_signature"].string.flatMap(Data.init(base64URL:)), bytes.count == 64,
              try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: bytes), for: WireValue.object(envelope).canonical()) else { throw NativeAPIError.invalidResponse }
        if step != "control" { guard UUID(uuidString: try body.text("request_nonce")) != nil, let deadline = body["request_expires_at"].integer, deadline > Int(Date().timeIntervalSince1970 * 1000), deadline <= Int(Date().addingTimeInterval(60).timeIntervalSince1970 * 1000) else { throw NativeAPIError.invalidResponse } }
        signatures += 1
    }
    private func makeChallenge(purpose: String, required: Int) -> WireValue {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var value: [String: WireValue] = ["protocol": .string("lovelies-face-auth-v1"), "challenge_id": .string(UUID().uuidString.lowercased()), "nonce": .string("lfn_" + Data(repeating: UInt8(version), count: 32).base64URL), "account_id": .string(Self.account), "device_id": .string(Self.device), "device_revision": .string(Self.revision), "purpose": .string(purpose), "profile_id": profile.map { .string($0.id) } ?? .null, "profile_revision": profile.map { .string($0.revision) } ?? .null, "model_id": profile.map { .string($0.modelID) } ?? .null, "policy_version": .string(Self.policy), "required_captures": .integer(required), "poses": .strings(required == 3 ? ["front", "left", "right"] : ["front"]), "maximum_capture_bytes": .integer(8 * 1024 * 1024), "expires_at": .string(formatter.string(from: Date().addingTimeInterval(100)))]
        if purpose != "login" { value["lifecycle_operation_key"] = operation["operation_key"]; value["lifecycle_generation"] = operation["generation"] }
        return .object(value)
    }
    private func verifyDevice(_ request: URLRequest, body: WireValue, complete: Bool) throws {
        let record = try store.journal(), parsed = try NativeFaceChallenge(challengeWithHandle(), accountID: Self.account, purpose: challenge["purpose"].string!)
        var envelope = parsed.deviceEnvelope(); envelope["step"] = .string(complete ? "complete" : "capture")
        let signature: String?
        if complete { envelope["capture_manifest"] = .array(proofs); signature = body["device_signature"].string }
        else {
            envelope["capture_index"] = .integer(Int(request.url!.lastPathComponent)!); envelope["capture_sha256"] = .string(request.value(forHTTPHeaderField: "X-Lovelies-Capture-SHA256")!)
            envelope["mime"] = .string("image/jpeg"); envelope["byte_size"] = .integer(request.httpBody!.count); signature = request.value(forHTTPHeaderField: "X-Lovelies-Device-Signature")
        }
        guard let raw = signature.flatMap(Data.init(base64URL:)), raw.count == 64,
              try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: WireValue.object(envelope).canonical()) else { throw NativeAPIError.invalidResponse }; signatures += 1
    }
    private func challengeWithHandle() throws -> WireValue { var result = challenge.object!; if challenge["purpose"].string == "registration" { result["face_handle"] = .string(try store.journal().originalDevice.faceHandle) }; return .object(result) }
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
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path); try lost(path, after: false)
        let body = request.value(forHTTPHeaderField: "Content-Type") == "application/json" ? try request.httpBody.map(WireValue.decoded) ?? .null : .null
        switch path {
        case "/auth/anonymous": anonymousCount += 1; return try failure(403, "fixture_no_anonymous")
        case "/auth/face/policy": return try reply(.object(["protocol": .string("lovelies-face-auth-v1"), "policy_version": .string(Self.policy), "available": .bool(true)]))
        case "/me":
            guard auth else { return try failure(401, "session_invalid") }
            var value: [String: WireValue] = ["user_id": .string(Self.account), "auth_method": .string("registered_face"), "authenticated": .bool(true), "profile_id": profile.map { .string($0.id) } ?? .null, "profile_revision": profile.map { .string($0.revision) } ?? .null]
            currentOverrides.forEach { value[$0.key] = $0.value }; return try reply(.object(value))
        case "/me/devices":
            var value: [String: WireValue] = ["id": .string(Self.device), "revision": .string(Self.revision), "current": .bool(true), "status": .string("active")]
            deviceOverrides.forEach { value[$0.key] = $0.value }; return try reply(.object(["items": .array([.object(value)])]))
        case "/me/face-profile": return try reply(metadata())
        case "/auth/session/refresh":
            let token = try body.text("refresh_token"); refreshTokens.append(token); guard !usedRefresh.contains(token) else { return try failure(401, "session_invalid") }; usedRefresh.insert(token)
            if failRefreshSlot { failRefreshSlot = false; store.fail("credentials") }; return try reply(deliveryReply(credential(), body: body))
        case "/auth/logout":
            let record = try store.journal()
            guard record.credentials == nil, record.promotionCredentials == nil, record.promotionProfile == nil,
                  record.loginChallengeWire == nil, record.loginCaptures.isEmpty, !record.loginCompletionPending,
                  !record.stableControlLogin, !record.currentAuthorityValidated,
                  let authorization = request.value(forHTTPHeaderField: "Authorization"), authorization.hasPrefix("Bearer ") else { throw NativeAPIError.invalidResponse }
            loggedOutTokens.append(String(authorization.dropFirst(7)))
            return try reply(.object(["status": .string("logged_out")]))
        case "/auth/face/profile/control":
            try verify(body, step: "control"); guard request.value(forHTTPHeaderField: "Authorization") != nil else { return try failure(401, "session_invalid") }
            if body["renew"].bool == true {
                guard auth, creationKey == body["previous_control_operation_key"].string || creationKey == body["control_operation_key"].string else { return try failure(401, "face_profile_control_unavailable") }
                guard controlExpired || creationKey == body["control_operation_key"].string else { return try failure(409, "face_profile_control_exists") }
            }
            control = true; controlExpired = false; controlKey = body["control_key"].string; creationKey = body["control_operation_key"].string
            try lost(path, after: true); return try reply(metadata(), 201)
        case "/auth/face/profile/status":
            try verify(body, step: "status"); if let denied { return try failure(denied.0, denied.1) }
            guard control else { return try failure(404, "face_profile_control_not_found") }
            guard !controlExpired, body["control_key"].string == controlKey else { return try failure(401, "face_profile_control_unavailable") }
            if body["operation_key"] != .null, body["operation_key"] != operation["operation_key"] { return try failure(404, "face_profile_operation_not_found") }
            return try reply(metadata(nonce: body["request_nonce"], withOperation: body["operation_key"] != .null))
        case "/auth/face/profile/cancel":
            try verify(body, step: "cancel"); guard body["operation_key"] == operation["operation_key"] else { return try failure(404, "face_profile_operation_not_found") }
            if operation["state"].string != "completed" { var op = operation.object!; op["state"] = .string("cancelled"); op["challenge"] = .null; op["captures"] = .array([]); operation = .object(op) }
            try lost(path, after: true); return try reply(metadata(nonce: body["request_nonce"], withOperation: true))
        case "/auth/face/profile/action":
            try verify(body, step: "action"); actionBodies.append(body)
            if operation["operation_key"] != body["operation_key"] {
                guard body["expected_version"].integer == version else { return try failure(409, "face_profile_version_changed") }
                let action = body["action"].string!
                if action == "pause" || action == "remove" { matching = false; receiving = false; paused = true }
                if action == "resume" { guard body["consent"]["purpose"].string == "photo_matching", body["consent"]["policy_version"].string == Self.photoPolicy, body["consent"]["granted"].bool == true else { return try failure(400, "explicit_matching_consent_required") }; matching = true; receiving = true; paused = false }
                if action == "withdraw_authentication" || action == "remove" { auth = false }
                if action == "remove" || (action == "withdraw_authentication" && !matching) || (action == "pause" && !auth) { profile = nil; removal = "pending" }
                version += 1
                operation = .object(["operation_key": body["operation_key"], "action": body["action"], "state": .string("applied"), "generation": .integer(0), "challenge_id": .null, "challenge": .null, "captures": .array([]), "cleanup_state": .string(removal == "pending" ? "pending" : "none")])
            }
            try lost(path, after: true); return try reply(metadata(nonce: body["request_nonce"], withOperation: true))
        case "/auth/face/profile/challenge":
            try verify(body, step: "challenge"); challengeBodies.append(body)
            guard body["consent"]["purpose"].string == "face_authentication", body["consent"]["policy_version"].string == Self.policy, body["consent"]["granted"].bool == true else { return try failure(400, "explicit_auth_consent_required") }
            operation = .object(["operation_key": body["operation_key"], "action": body["action"], "state": .string("pending"), "generation": .integer(1), "challenge_id": .null, "challenge": .null, "captures": .array([]), "cleanup_state": .string("none")]); proofs = []
            let action = body["action"].string!; challenge = makeChallenge(purpose: action == "replace" ? "replacement" : "registration", required: action == "restore_authentication" ? 1 : 3)
            var op = operation.object!; op["challenge_id"] = challenge["challenge_id"]; op["challenge"] = challenge; operation = .object(op)
            try lost(path, after: true); return try reply(challenge, 201)
        case "/auth/face/profile/resume":
            try verify(body, step: "resume"); guard operation["state"].string == "restart_required" || operation["state"].string == "failed" else { return try failure(409, "face_profile_in_flight") }
            guard body["expected_challenge_id"] == operation["challenge_id"], body["expected_generation"] == operation["generation"] else { return try failure(409, "face_profile_operation_changed") }
            var op = operation.object!; op["generation"] = .integer(operation["generation"].integer! + 1); operation = .object(op)
            challenge = makeChallenge(purpose: operation["action"].string == "replace" ? "replacement" : "registration", required: operation["action"].string == "restore_authentication" ? 1 : 3)
            proofs = []; op["state"] = .string("pending"); op["challenge_id"] = challenge["challenge_id"]; op["challenge"] = challenge; op["captures"] = .array([]); operation = .object(op); return try reply(challenge, 201)
        case "/auth/face/challenge":
            guard auth else { return try failure(403, "face_authentication_consent_required") }; challenge = makeChallenge(purpose: "login", required: 1); proofs = []; return try reply(challenge, 201)
        case "/auth/face/profile/complete", "/auth/face/complete":
            try verifyDevice(request, body: body, complete: true)
            if rejectFace { rejectFace = false; return try failure(403, "face_verification_failed") }
            guard proofs.count == challenge["required_captures"].integer else { return try failure(409, "missing_captures") }
            if path == "/auth/face/profile/complete" {
                if operation["action"].string == "replace" { profile = NativeEnrollmentProfile(id: Self.profile, revision: "profile-v\(version + 1)", modelID: "yunet-sface-v1") }
                if operation["action"].string == "enroll" { profile = NativeEnrollmentProfile(id: UUID().uuidString.lowercased(), revision: "profile-reenrolled", modelID: "yunet-sface-v1"); matching = false; receiving = false; paused = true; removal = "none" }
                auth = true; version += 1; var op = operation.object!; op["state"] = .string("completed"); op["challenge"] = .null; op["captures"] = .array([]); operation = .object(op)
            }
            completionCount += 1; var value = try credential().object!; value["protocol"] = .string("lovelies-face-auth-v1"); value["status"] = .string("authenticated"); value["device_id"] = .string(Self.device); value["profile_id"] = .string(profile!.id); value["profile_revision"] = .string(profile!.revision); value["model_id"] = .string(profile!.modelID)
            try lost(path, after: true); return try reply(.object(value))
        default:
            if path.hasPrefix("/auth/face/proof/") {
                try verifyDevice(request, body: .null, complete: false); if let captureGate { self.captureGate = nil; await captureGate.pause() }
                let index = Int(request.url!.lastPathComponent)!, bytes = request.httpBody!, hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
                let receipt: WireValue = .object(["index": .integer(index), "sha256": .string(hash), "mime": .string("image/jpeg"), "byte_size": .integer(bytes.count)])
                proofs.append(receipt)
                if challenge["purpose"].string != "login" { var op = operation.object!; op["state"] = .string("pending"); op["captures"] = .array(proofs); operation = .object(op) }
                try lost(path, after: true)
                var acknowledgment: [String: WireValue] = ["protocol": .string("lovelies-face-auth-v1"), "status": .string("capture_received"), "challenge_id": challenge["challenge_id"], "capture_index": .integer(index), "capture_sha256": .string(hash), "byte_size": .integer(bytes.count)]
                captureOverrides.forEach { acknowledgment[$0.key] = $0.value }; return try reply(.object(acknowledgment))
            }
            return try failure(404, "fixture_route_unavailable")
        }
    }
}

@main struct NativeFaceProfileLifecycleTests {
    private static var checks = 0
    private static let origin = URL(string: "https://fixture.invalid")!
    private static func require(_ value: Bool, _ message: String) throws { checks += 1; if !value { throw NativeAPIError.unsupported("FAILED: " + message) } }
    private static func rejects(_ name: String, _ body: () async throws -> Void) async throws {
        do { try await body() } catch { checks += 1; return }; throw NativeAPIError.unsupported("Expected denial: " + name)
    }
    private static func setup(open: Bool = true, matching: Bool = true) async throws -> (BackendRepository, ProfileFixture, ProfileSecrets, ProfileSigner) {
        let store = ProfileSecrets(), signer = ProfileSigner()
        let fixture = ProfileFixture(store: store, digest: signer.sha256(try signer.publicJWK(alias: NativeEnrollmentRecord.keyAlias, create: false).canonical()))
        if !matching { await fixture.noMatching() }
        let credential = try NativeCredentials(await fixture.credential())
        let device = RegisteredDevice(accountID: ProfileFixture.account, faceHandle: "lfh_" + Data(repeating: 9, count: 32).base64URL, deviceID: ProfileFixture.device, profileID: ProfileFixture.profile, profileRevision: "profile-v1", modelID: "yunet-sface-v1")
        try store.write("credentials", data: JSONEncoder().encode(credential)); try store.write("registered-device", data: JSONEncoder().encode(device))
        let repository = BackendRepository(origin: origin, transport: fixture, secrets: store, signer: signer); _ = try await repository.bootstrap()
        if open { _ = try await repository.openFaceLifecycle() }
        return (repository, fixture, store, signer)
    }
    private static func restart(_ fixture: ProfileFixture, _ store: ProfileSecrets, _ signer: ProfileSigner) -> BackendRepository { BackendRepository(origin: origin, transport: fixture, secrets: store, signer: signer) }
    private static func captures(_ repository: BackendRepository, _ challenge: NativeFaceChallenge) async throws -> [WireValue] {
        var values: [WireValue] = []
        for index in challenge.poses.indices { values.append(try await repository.capture(Data([255, 216, UInt8(index + 1), 255, 217]), index: index, challenge: challenge)) }
        return values
    }
    private static func run() async throws {
        do {
            let (repository, fixture, store, signer) = try await setup(); let saved = try store.journal()
            try require(saved.controlReady && saved.accountID == ProfileFixture.account && saved.keyAlias == NativeEnrollmentRecord.keyAlias, "Private control preserves original account/alias")
            try require(signer.creates == 0 && signer.clears == 0, "Management never creates/replaces original device key")
            let paused = try await repository.faceProfileAction(.pause)
            try require(!paused.metadata.matchingEnabled && !paused.metadata.receiveMatches && paused.metadata.authenticationEnabled && paused.metadata.processingEnabled, "Pause only matching; preserves independent auth/processing")
            try await rejects("Resume without explicit purpose policy") { _ = try await repository.faceProfileAction(.resume) }
            let resumed = try await repository.faceProfileAction(.resume, consentPolicy: ProfileFixture.photoPolicy)
            try require(resumed.metadata.matchingEnabled && resumed.metadata.receiveMatches && resumed.metadata.version > paused.metadata.version, "New matching episode follows current explicit consent")
            let withdrawn = try await repository.faceProfileAction(.withdrawAuthentication)
            try require(!withdrawn.metadata.authenticationEnabled && withdrawn.metadata.matchingEnabled && withdrawn.metadata.processingEnabled && withdrawn.metadata.profile != nil, "Withdrawal retains reference only for separately granted matching")
            let session = await repository.summary(); try require(session == nil && (try store.read("credentials")) == nil, "Withdrawal retires account/private credential publication")
            try await rejects("Generic registered requests after withdrawal") { _ = try await repository.protectedJSON("/me/photo-preferences") }
            try await rejects("A02 cannot bypass active withdrawal hold") { _ = try await repository.startAccountRecovery(backup: "LVR1:" + ProfileFixture.account + ":lfr_" + Data(repeating: 1, count: 32).base64URL) }
            let restored = try await repository.startFaceProfileCapture(.restoreAuthentication, consentPolicy: ProfileFixture.policy)
            try require(restored.challenge?.poses == ["front"] && restored.challenge?.deviceID == saved.originalDevice.deviceID, "Restore uses one ordinary selfie against same retained reference/key")
            let receipts = try await captures(repository, restored.challenge!), authenticated = try await repository.completeFace(restored.challenge!, captures: receipts)
            try require(authenticated.accountID == saved.accountID && authenticated.authenticated && signer.clears == 0, "Restore validates current account/device before same-key promotion")
            let count = await fixture.anonymousCount; try require(count == 0, "No anonymous fallback during lifecycle")
        }
        for after in [false, true] {
            let (repository, fixture, store, signer) = try await setup(open: false); await fixture.lose("/auth/face/profile/control", after: after)
            try await rejects("Lost control") { _ = try await repository.openFaceLifecycle() }
            let original = try store.journal(), rebuilt = restart(fixture, store, signer)
            if after { _ = try await rebuilt.bootstrap() } else { try await rejects("Absent control remains held until explicit retry") { _ = try await rebuilt.bootstrap() }; _ = try await rebuilt.checkFaceLifecycle(retryOriginal: true) }
            let next = try store.journal(); try require(original.controlKey == next.controlKey && original.controlOperationKey == next.controlOperationKey && next.controlReady, "Lost control/restart retains exact private key/operation")
        }
        for after in [false, true] {
            let (repository, fixture, store, signer) = try await setup(); await fixture.lose("/auth/face/profile/action", after: after)
            try await rejects("Lost action") { _ = try await repository.faceProfileAction(.pause) }
            let original = try store.journal().pending!, rebuilt = restart(fixture, store, signer); _ = try await rebuilt.bootstrap()
            _ = try await rebuilt.checkFaceLifecycle(retryOriginal: true)
            let next = try store.journal().pending!; try require(original.operationKey == next.operationKey && next.serverState == "applied", "Action retry only original key/current expected version")
            let bodies = await fixture.actionBodies; try require(bodies.allSatisfy { $0["operation_key"].string == original.operationKey }, "No regenerated action key after loss")
        }
        do {
            let (repository, fixture, store, _) = try await setup(); await fixture.lose("/auth/face/profile/action", after: false)
            try await rejects("Missing saved action") { _ = try await repository.faceProfileAction(.pause) }; await fixture.driftVersion()
            try await rejects("Version drift prohibits blind replay") { _ = try await repository.checkFaceLifecycle(retryOriginal: true) }
            try require(try store.journal().pending?.missingOnServer == true, "Unknown operation journal retained under drift")
        }
        do {
            let (repository, fixture, store, signer) = try await setup(); await fixture.lose("/auth/face/profile/challenge")
            try await rejects("Lost replacement start") { _ = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy) }
            let original = try store.journal().pending!, rebuilt = restart(fixture, store, signer); _ = try await rebuilt.bootstrap()
            let continued = try await rebuilt.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy), challenge = continued.challenge!
            try require(challenge.purpose == "replacement" && challenge.poses.count == 3 && challenge.wire["lifecycle_operation_key"].string == original.operationKey, "Replacement challenge reconciles exact operation/reference and all three poses")
            await fixture.lose("/auth/face/proof/\(challenge.id)/0")
            try await rejects("Lost replacement capture") { _ = try await rebuilt.capture(Data([1, 2, 3]), index: 0, challenge: challenge) }
            let again = restart(fixture, store, signer); _ = try await again.bootstrap(); let reconciled = try await again.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy)
            try require(reconciled.receipts.count == 1 && reconciled.receipts[0]["sha256"].string == signer.sha256(Data([1, 2, 3])), "Accepted signed capture loss is exact metadata, never inferred bytes")
            var receipts = reconciled.receipts
            for index in 1..<3 { receipts.append(try await again.capture(Data([UInt8(index + 4), 7]), index: index, challenge: reconciled.challenge!)) }
            await fixture.lose("/auth/face/profile/complete")
            try await rejects("Lost committed replacement") { _ = try await again.completeFace(reconciled.challenge!, captures: receipts) }
            let final = restart(fixture, store, signer); _ = try await final.bootstrap()
            let checked = try await final.faceLifecycleSummary()!; try require(checked.operation?.serverState == "completed" && !checked.authenticated && checked.metadata.profile?.id == ProfileFixture.profile, "Read-only completed status updates reference without sign-in")
            let fresh = try await final.prepareFaceRetake(reconciled.challenge!, terminalQualityFailure: false); try require(fresh.challenge?.poses == ["front"] && fresh.challenge?.wire["profile_revision"].string == checked.metadata.profile?.revision, "Lost completion camera recovery requires one fresh selfie against current registered reference")
            let freshReceipts = try await captures(final, fresh.challenge!), session = try await final.completeFace(fresh.challenge!, captures: freshReceipts)
            try require(session.authenticated && session.accountID == ProfileFixture.account && signer.clears == 0 && signer.creates == 0, "Lost completion recovers same account/original key without three-selfie re-enrollment")
        }
        for sparse in [false, true] {
            let (repository, fixture, store, signer) = try await setup(); let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy), challenge = started.challenge!
            _ = try await repository.capture(Data([1, 9]), index: 0, challenge: challenge); _ = try await repository.capture(Data([2, 9]), index: 1, challenge: challenge)
            await fixture.expire(sparse: sparse); let rebuilt = restart(fixture, store, signer); _ = try await rebuilt.bootstrap()
            let status = try await rebuilt.faceLifecycleSummary()!; try require(status.receipts.isEmpty && status.challenge == nil, "Terminal sparse/empty cleanup is retired, never capture progress")
            let fresh = try await rebuilt.prepareFaceRetake(challenge, terminalQualityFailure: false)
            try require(fresh.challenge?.id != challenge.id && fresh.challenge?.deviceID == challenge.deviceID && fresh.receipts.isEmpty && (try store.journal()).pending?.generation == 2, "Expired predecessor resumes same key with three fresh successor captures")
        }
        for matching in [false, true] {
            let (repository, fixture, store, signer) = try await setup(matching: matching)
            let action: NativeFaceProfileAction = matching ? .remove : .withdrawAuthentication
            let removed = try await repository.faceProfileAction(action); try require(removed.metadata.profile == nil && removed.cleanupPending && !removed.metadata.authenticationEnabled, "Reference withdrawal/removal reports actual pending cleanup")
            try await rejects("Re-enrollment before absent HEAD") { _ = try await repository.startFaceProfileCapture(.enroll, consentPolicy: ProfileFixture.policy) }
            await fixture.finishCleanup(); let checked = try await repository.checkFaceLifecycle(); try require(checked.metadata.removalState == "completed", "Only server confirms private-reference cleanup")
            let fresh = try await repository.startFaceProfileCapture(.enroll, consentPolicy: ProfileFixture.policy); try require(fresh.challenge?.poses.count == 3 && fresh.challenge?.wire["profile_id"] == .null, "After deletion enroll same account/key with no old-reference comparison claim")
            let receipts = try await captures(repository, fresh.challenge!), session = try await repository.completeFace(fresh.challenge!, captures: receipts), metadata = try await repository.faceLifecycleSummary()!
            try require(session.accountID == ProfileFixture.account && !metadata.metadata.matchingEnabled && metadata.metadata.processingEnabled && signer.clears == 0, "Re-enrollment never auto-regrants matching or clears account/uploads")
            try require((try store.journal()).originalDevice.deviceID == ProfileFixture.device, "Original management device retained after verified cleanup")
        }
        for field in ["request_nonce", "public_key_digest", "device_revision", "account_id", "device_id", "authenticated", "version"] {
            let (repository, fixture, store, _) = try await setup(); let saved = try store.journal()
            let value: WireValue = field == "authenticated" ? .bool(true) : field == "version" ? .integer(0) : .string(ProfileFixture.foreign)
            await fixture.override([field: value]); try await rejects("Exact metadata " + field) { _ = try await repository.checkFaceLifecycle() }
            try require((try store.journal()).controlKey == saved.controlKey && (try store.journal()).authorityUnavailable, "Unverified metadata retains private control but no public authority")
        }
        for missing in [false, true] {
            let (_, fixture, store, signer) = try await setup(); let pathCount = await fixture.paths.count
            if missing { signer.clear() } else { signer.replaceKey() }
            let rebuilt = restart(fixture, store, signer); try await rejects("Original lifecycle key missing/replaced") { _ = try await rebuilt.bootstrap() }
            let count = await fixture.paths.count; try require(count == pathCount, "No key recreation or new account after original key loss")
        }
        for status in [401, 404, 503] {
            let (_, fixture, store, signer) = try await setup(); await fixture.unavailable(status, "face_profile_control_unavailable")
            let rebuilt = restart(fixture, store, signer); try await rejects("Unavailable lifecycle authority") { _ = try await rebuilt.bootstrap() }
            let count = await fixture.anonymousCount; try require(count == 0 && (try store.read("face-profile-lifecycle")) != nil, "Unknown/revoked/network failure never becomes deletion or anonymous bootstrap")
        }
        for drift in ["profile", "device", "inactive"] {
            let (repository, fixture, store, signer) = try await setup(); let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy), receipts = try await captures(repository, started.challenge!)
            if drift == "profile" { await fixture.driftCurrent(["profile_revision": .string("wrong")]) }
            else { await fixture.driftDevice(drift == "device" ? ["id": .string(ProfileFixture.foreign)] : ["status": .string("revoked")]) }
            try await rejects("Staged promotion binding " + drift) { _ = try await repository.completeFace(started.challenge!, captures: receipts) }
            try require((try store.journal()).promotionCredentials != nil, "Current authority mismatch retains staged original-key journal")
            await fixture.driftCurrent([:]); await fixture.driftDevice([:]); let rebuilt = restart(fixture, store, signer), result = try await rebuilt.bootstrap()
            try require(result?.authenticated == true && result?.accountID == ProfileFixture.account, "Promotion repairs only after exact current profile/active device checks")
        }
        do {
            let (repository, fixture, store, signer) = try await setup(); let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy), receipts = try await captures(repository, started.challenge!)
            store.fail("registered-device"); try await rejects("Durable promotion boundary") { _ = try await repository.completeFace(started.challenge!, captures: receipts) }
            var record = try store.journal(); let previous = record.promotionCredentials!
            var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(previous)) as! [String: Any]; object["expiresAt"] = Date().addingTimeInterval(-5).timeIntervalSinceReferenceDate
            record.promotionCredentials = try JSONDecoder().decode(NativeCredentials.self, from: JSONSerialization.data(withJSONObject: object)); try store.write("face-profile-lifecycle", data: JSONEncoder().encode(record)); await fixture.failNextRefreshSlot()
            let failed = restart(fixture, store, signer); try await rejects("Single-use promotion refresh slot failure") { _ = try await failed.bootstrap() }
            try require((try store.journal()).promotionCredentials?.refresh_token != previous.refresh_token, "Journal-first rotated credential survives stale credential slot")
            let rebuilt = restart(fixture, store, signer), result = try await rebuilt.bootstrap(), count = await fixture.refreshCount(previous.refresh_token)
            try require(result?.authenticated == true && count == 1, "Restart never reuses consumed promotion refresh")
        }
        for boundary in ["current-profile", "device-slot"] {
            let (repository, fixture, store, signer) = try await setup(); let original = try store.journal()
            let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy), receipts = try await captures(repository, started.challenge!)
            if boundary == "current-profile" { await fixture.driftCurrent(["profile_revision": .string("wrong")]) }
            else { store.fail("registered-device") }
            try await rejects("Interrupted promotion before explicit logout " + boundary) { _ = try await repository.completeFace(started.challenge!, captures: receipts) }
            let staged = try store.journal().promotionCredentials!, operation = try store.journal().pending!.operationKey
            await repository.clearSession()
            try require((try store.journal()).promotionCredentials?.refresh_token == staged.refresh_token, "Internal session retirement preserves staged repair")
            try await repository.logout()
            let retired = try store.journal(), logoutCount = await fixture.logoutCount(staged.access_token)
            try require(retired.credentials == nil && retired.promotionCredentials == nil && retired.promotionProfile == nil && !retired.currentAuthorityValidated, "Explicit logout durably retires ordinary and staged lifecycle authority")
            try require(retired.loginChallengeWire == nil && retired.loginCaptures.isEmpty && !retired.loginCompletionPending && !retired.stableControlLogin && logoutCount == 1, "Login capture repair retires before awaiting actual staged-session logout")
            try require(retired.pending?.operationKey == operation && retired.pending?.serverState == "completed" && retired.controlKey == original.controlKey && retired.keyAlias == original.keyAlias && retired.publicKeyDigest == original.publicKeyDigest, "Logout retains readonly completed operation and original control/key")
            await fixture.driftCurrent([:]); let before = await fixture.paths, rebuilt = restart(fixture, store, signer), restored = try await rebuilt.bootstrap()
            let checked = try await rebuilt.checkFaceLifecycle(), after = await fixture.paths
            try require(restored == nil && !checked.authenticated && checked.operation?.serverState == "completed" && (try store.journal()).promotionCredentials == nil, "Restart reconciles completion without promoting a revoked staged session")
            try require(after.filter { $0 == "/me" || $0 == "/auth/session/refresh" }.count == before.filter { $0 == "/me" || $0 == "/auth/session/refresh" }.count, "Readonly restart never retries retired authentication")
            let fresh = try await rebuilt.freshFaceProfileLogin()
            try require(fresh.challenge?.purpose == "login" && fresh.challenge?.poses == ["front"], "Completed status permits only an explicit fresh one-selfie login")
            let freshReceipts = try await captures(rebuilt, fresh.challenge!), authenticated = try await rebuilt.completeFace(fresh.challenge!, captures: freshReceipts)
            try require(authenticated.authenticated && authenticated.accountID == original.accountID && signer.creates == 0 && signer.clears == 0 && (try store.journal()).keyAlias == original.keyAlias, "Fresh current-reference login preserves the same account and original key")
            let anonymousCount = await fixture.anonymousCount; try require(anonymousCount == 0, "Explicit logout after failed promotion never bootstraps another account")
        }
        do {
            let (repository, fixture, store, signer) = try await setup(); let original = try store.journal()
            let fresh = try await repository.freshFaceProfileLogin(), receipts = try await captures(repository, fresh.challenge!)
            await fixture.lose("/auth/face/complete", after: false)
            try await rejects("Ordinary login completion ambiguity") { _ = try await repository.completeFace(fresh.challenge!, captures: receipts) }
            let held = try store.journal()
            try require(held.loginChallengeWire != nil && held.loginCaptures.count == 1 && held.loginCompletionPending, "Ordinary login ambiguity retains its camera/completion record before explicit logout")
            try await rejects("Camera retry cannot recreate a live ambiguous ordinary login under an older completed operation") { _ = try await repository.prepareFaceRetake(fresh.challenge!, terminalQualityFailure: false) }
            try await rejects("Direct managed fresh-login action cannot bypass an unexpired ambiguous ordinary proof") { _ = try await repository.freshFaceProfileLogin() }
            try require(try store.journal().loginChallengeWire?["challenge_id"].string == fresh.challenge?.id, "Held ordinary camera retry retains exact original login proof authority")
            try await repository.logout(); let retired = try store.journal()
            try require(retired.loginChallengeWire == nil && retired.loginCaptures.isEmpty && !retired.loginCompletionPending && retired.credentials == nil && retired.promotionCredentials == nil, "Explicit logout retires an actual pending ordinary login capture")
            try await rejects("Old ordinary selfie cannot publish after logout") { _ = try await repository.capture(Data([1, 2, 3]), index: 0, challenge: fresh.challenge!) }
            let rebuilt = restart(fixture, store, signer), restored = try await rebuilt.bootstrap(), next = try await rebuilt.freshFaceProfileLogin()
            try require(restored == nil && next.challenge?.id != fresh.challenge?.id && next.challenge?.poses == ["front"] && (try store.journal()).controlKey == original.controlKey && signer.creates == 0 && signer.clears == 0, "Restart offers a new explicit login challenge without recreating account, control or key")
        }
        do {
            let (repository, fixture, store, _) = try await setup(); let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy), receipts = try await captures(repository, started.challenge!)
            await fixture.rejectNextFace(); try await rejects("Server wrong-reference face denial") { _ = try await repository.completeFace(started.challenge!, captures: receipts) }
            try require((try store.journal()).promotionCredentials == nil, "Client never substitutes a score or invents verifier success")
        }
        do {
            let (repository, fixture, store, signer) = try await setup(); let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy), gate = ProfileGate()
            await fixture.delayCapture(gate); let task = Task { try await repository.capture(Data([9, 8]), index: 0, challenge: started.challenge!) }
            await gate.started(); await repository.clearSession(); await gate.release(); try await rejects("Late capture after logout") { _ = try await task.value }
            try require((try store.journal()).pending?.captures.first?.accepted == false && signer.clears == 0, "Late publication cannot confirm old capture or clear original alias")
            let context = NativeFaceShutterContext(started.challenge!)
            var changed = started.challenge!.wire.object!; changed["lifecycle_generation"] = .integer(2)
            let altered = try NativeFaceChallenge(.object(changed), accountID: ProfileFixture.account, purpose: "replacement")
            try require(!context.permits(altered) && context.permits(started.challenge!), "Shutter binds exact operation/generation before UI publication")
        }
        for field in ["protocol", "status", "challenge_id", "capture_index", "capture_sha256", "byte_size"] {
            let (repository, fixture, store, _) = try await setup(); let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy)
            let value: WireValue = field == "capture_index" || field == "byte_size" ? .integer(999) : .string("wrong")
            await fixture.overrideCapture([field: value]); try await rejects("Capture receipt binding " + field) { _ = try await repository.capture(Data([8, 6]), index: 0, challenge: started.challenge!) }
            try require((try store.journal()).pending?.captures.first?.accepted == false, "Unverified ACK keeps planned proof ambiguous")
            await fixture.overrideCapture([:]); let checked = try await repository.checkFaceLifecycle()
            try require(checked.receipts.count == 1, "Signed exact manifest repairs unverified receipt without claiming absent bytes")
        }
        do {
            let (repository, fixture, store, signer) = try await setup(); let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy)
            await fixture.lose("/auth/face/profile/cancel"); try await rejects("Lost cancellation response") { _ = try await repository.cancelFaceProfileCapture() }
            try require((try store.journal()).pending?.cancelRequested == true, "Ambiguous cancel keeps control/original operation and blocks capture")
            try await rejects("Capture after local cancel") { _ = try await repository.capture(Data([8, 6]), index: 0, challenge: started.challenge!) }
            let rebuilt = restart(fixture, store, signer); _ = try await rebuilt.bootstrap(); let checked = try await rebuilt.faceLifecycleSummary()!
            try require(checked.operation?.serverState == "cancelled" && checked.receipts.isEmpty && signer.clears == 0, "Signed cancellation retires progress but preserves original key/account")
        }
        do {
            let (repository, fixture, _, _) = try await setup(); _ = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy)
            await fixture.awaiting(); let held = try await repository.checkFaceLifecycle()
            try require(held.awaitingServer && held.challenge == nil, "Verifier in flight has no usable camera challenge")
            try await rejects("No new operation during held verifier") { _ = try await repository.faceProfileAction(.pause) }
            _ = try await repository.cancelFaceProfileCapture(); let checked = try await repository.faceLifecycleSummary()!
            try require(checked.operation?.serverState == "cancelled", "Explicit signed cancel resolves held verifier without anonymous fallback")
        }
        do {
            let (_, fixture, store, signer) = try await setup()
            let claims: WireValue = .object(["sub": .string(ProfileFixture.account), "auth_method": .string("anonymous"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
            let original = try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("original-anonymous"), "account_id": .string(ProfileFixture.account), "auth_method": .string("anonymous"), "expires_in": .integer(900), "roles": .strings(["user"])]))
            let held = NativeGuestDeletionRecord(accountID: ProfileFixture.account, operationKey: UUID().uuidString.lowercased(), statusToken: "lvd_" + String(repeating: "a", count: 64), apiOrigin: origin.absoluteString, reason: nil, preparedAt: Date(), originalCredentials: original)
            try store.write("credentials", data: nil); try store.write("guest-deletion-receipt", data: JSONEncoder().encode(held))
            let rebuilt = restart(fixture, store, signer); _ = try await rebuilt.bootstrap()
            try await rejects("D04 holds precede A03") { _ = try await rebuilt.checkFaceLifecycle() }
            try require((try store.read("face-profile-lifecycle")) != nil && signer.clears == 0, "Deletion ambiguity preserves original lifecycle journal/key")
        }
        do {
            let (repository, fixture, store, signer) = try await setup(); let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: ProfileFixture.policy)
            _ = try await repository.capture(Data([1, 2]), index: 0, challenge: started.challenge!)
            let writerBytes = Data([2, 3]); var saved = try store.journal()
            saved.pending!.captures.append(NativeEnrollmentCapture(index: 1, sha256: signer.sha256(writerBytes), byteSize: writerBytes.count))
            try store.write("face-profile-lifecycle", data: JSONEncoder().encode(saved))
            await fixture.unsettledWriter(); let rebuilt = restart(fixture, store, signer); _ = try await rebuilt.bootstrap()
            let held = try await rebuilt.faceLifecycleSummary()!
            try require(held.awaitingServer && held.challenge == nil && held.receipts.count == 1, "Unsettled account writer blocks capture even with an exact accepted prefix/usable nested challenge")
            try await rejects("Writer hold cannot advance next pose") { _ = try await rebuilt.capture(Data([3, 4]), index: 2, challenge: started.challenge!) }
            try require((try store.journal()).pending?.captures.count == 2 && (try store.journal()).pending?.captures[1].accepted == false, "Writer hold preserves ambiguous planned metadata for exact later reconciliation")
            await fixture.settleWriterProof(writerBytes); let settled = try await rebuilt.checkFaceLifecycle()
            try require(!settled.awaitingServer && settled.challenge?.id == started.challenge?.id && settled.receipts.count == 2 && settled.receipts[1]["sha256"].string == signer.sha256(writerBytes), "Later settled pending manifest confirms exact previously planned writer proof")
            _ = try await rebuilt.capture(Data([3, 4]), index: 2, challenge: settled.challenge!)
            try require((try store.journal()).pending?.captures.count == 3, "Only settled pending state advances next fresh pose")
        }
        for after in [false, true] {
            let (repository, fixture, store, signer) = try await setup(); let previous = try store.journal()
            await fixture.expireControl(); try await rejects("Expired control must remain held") { _ = try await repository.checkFaceLifecycle() }
            let eligible = try await repository.faceLifecycleSummary()!; try require(eligible.canRenewControl, "Existing current registered authority offers only explicit renewal")
            await fixture.lose("/auth/face/profile/control", after: after); try await rejects("Renewal response loss") { _ = try await repository.renewFaceControl() }
            let saved = try store.journal(); try require(saved.controlKey == previous.controlKey && saved.renewal?.key != previous.controlKey && saved.renewal?.previousOperationKey == previous.controlOperationKey, "Renewal journal preserves predecessor, new secret and exact body before network")
            let rebuilt = restart(fixture, store, signer)
            if after { _ = try await rebuilt.bootstrap() } else { try await rejects("Uncommitted renewal never guessed from old capability") { _ = try await rebuilt.bootstrap() }; _ = try await rebuilt.renewFaceControl() }
            let renewed = try store.journal(); try require(renewed.renewal == nil && renewed.controlOperationKey == saved.renewal?.operationKey && renewed.controlHistory.count == 1 && renewed.controlHistory[0].key == previous.controlKey && signer.creates == 0, "Renewal recovery adopts only exact new capability and retains original private binding/key history")
        }
        do {
            let (repository, fixture, store, signer) = try await setup(); try await repository.logout(); await fixture.expireControl()
            try await rejects("No current bearer cannot silently renew") { _ = try await repository.renewFaceControl() }
            let fresh = try await repository.freshFaceProfileLogin(); try require(fresh.challenge?.poses == ["front"] && fresh.challenge?.purpose == "login", "Expired stable control permits explicit ordinary current-reference selfie only")
            let receipts = try await captures(repository, fresh.challenge!), authenticated = try await repository.completeFace(fresh.challenge!, captures: receipts)
            let held = try await repository.faceLifecycleSummary()!; try require(authenticated.accountID == ProfileFixture.account && held.canRenewControl && held.authorityUnavailable && (try store.journal()).renewal == nil, "Validated fresh login does not automatically renew management or regrant consent")
            let renewed = try await repository.renewFaceControl(); try require(renewed.authenticated && !renewed.authorityUnavailable && signer.creates == 0, "Separate explicit renewal uses current face session and original key")
        }
        for removed in [false, true] {
            let (repository, fixture, _, _) = try await setup(); _ = try await repository.faceProfileAction(removed ? .remove : .withdrawAuthentication)
            await fixture.expireControl(); let before = await fixture.paths.filter { $0 == "/auth/face/challenge" }.count
            try await rejects("Ordinary expiry seam cannot bypass withdrawal/removal") { _ = try await repository.freshFaceProfileLogin() }
            let after = await fixture.paths.filter { $0 == "/auth/face/challenge" }.count
            try require(before == after, "Inactive reference/auth purpose never dispatches new ordinary capture")
            try await rejects("Inactive authority cannot renew") { _ = try await repository.renewFaceControl() }
        }
        do {
            let (repository, _, _, _) = try await setup(); _ = try await repository.faceProfileAction(.withdrawAuthentication)
            let paused = try await repository.faceProfileAction(.pause)
            try require(paused.metadata.profile == nil && paused.cleanupPending && !paused.metadata.authenticationEnabled && !paused.metadata.matchingEnabled, "Pausing last matching purpose after authentication withdrawal retires unauthorized reference")
        }
        do {
            let (repository, fixture, _, _) = try await setup(); let viewed = try await repository.faceLifecycleSummary()!
            await fixture.driftVersion(); let before = await fixture.actionBodies.count
            try await rejects("Rendered profile version cannot be silently advanced by status") { _ = try await repository.faceProfileAction(.pause, expectedVersion: viewed.metadata.version) }
            let after = await fixture.actionBodies.count; try require(before == after, "No action dispatched against a reference state not confirmed on screen")
        }
        for digest in [WireValue.null, WireValue.string(String(repeating: "f", count: 64))] {
            let (repository, fixture, store, signer) = try await setup(open: false)
            await fixture.override(["public_key_digest": digest]); let before = await fixture.paths.filter { $0 == "/auth/face/profile/control" }.count
            try await rejects("Initial GET requires exact original server digest") { _ = try await repository.openFaceLifecycle() }
            let after = await fixture.paths.filter { $0 == "/auth/face/profile/control" }.count
            try require((try store.read("face-profile-lifecycle")) == nil && before == after && signer.creates == 0 && signer.clears == 0, "Missing/wrong initial digest creates no journal/control/key or local identity substitute")
        }
        do {
            let (repository, fixture, store, _) = try await setup(open: false); store.fail("face-profile-lifecycle")
            let before = await fixture.paths.filter { $0 == "/auth/face/profile/control" }.count
            try await rejects("Control persistence before network") { _ = try await repository.openFaceLifecycle() }
            let after = await fixture.paths.filter { $0 == "/auth/face/profile/control" }.count; try require(before == after, "No control dispatch without durable private intent")
        }
    }
    static func main() async { do { try await run(); print("Native face-profile lifecycle controlled checks passed: \(checks). Host software fixtures only.") } catch { print("Native face-profile lifecycle checks FAILED: " + error.localizedDescription); exit(1) } }
}
