import Foundation
import CryptoKit

// Protocol-consumer fixtures only: no live camera, hosted worker, real account,
// biometric model, Keychain or physical Secure Enclave is qualified by this file.
private final class MemorySecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; values[name] = data }
}
private struct SoftwareSigner: NativeDeviceSigner, @unchecked Sendable {
    let key = P256.Signing.PrivateKey()
    func sign(_ data: Data) throws -> String { try key.signature(for: data).rawRepresentation.base64URL }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
    var jwk: WireValue {
        let bytes = key.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(bytes.subdata(in: 1..<33).base64URL), "y": .string(bytes.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
}
private actor ReadGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var waiting = false
    func pause() async { waiting = true; startWaiters.forEach { $0.resume() }; startWaiters = []; await withCheckedContinuation { continuation = $0 } }
    func started() async { if !waiting { await withCheckedContinuation { startWaiters.append($0) } } }
    func release() { continuation?.resume(); continuation = nil }
}
private actor ConnectionFixture: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000001"
    static let other = "00000000-0000-4000-8000-000000000002"
    static let device = "00000000-0000-4000-8000-000000000003"
    static let profile = "00000000-0000-4000-8000-000000000004"
    static let challengeID = "00000000-0000-4000-8000-000000000005"
    private let signer: SoftwareSigner
    private var registered = false
    private var captureRows: [WireValue] = []
    private var challengeWire: WireValue = .null
    private var enrollmentKey: String?, enrollmentDigest: String?
    private var faceHandle = "lfh_" + String(repeating: "H", count: 43)
    private var enrollmentCreated = Date()
    private var completionAccount = ConnectionFixture.account
    private var unavailable = false
    private var invalidatedAnonymous = false
    private var lostCompletion = false
    private var keyHistory: [String] = []
    private var snapshotAttempts = 0
    private var failSnapshot = false
    private var sharingSource: WireValue = .string("personal")
    private var inboxRows: [WireValue] = []
    private var profileGate: ReadGate?
    private var denial = false
    private(set) var paths: [String] = []
    private(set) var verifiedSignatures = 0
    init(signer: SoftwareSigner) { self.signer = signer }
    nonisolated func cancelPending() {}
    func useWrongAccount() { completionAccount = Self.other }
    func disableVerifier() { unavailable = true }
    func loseNextCompletion() { lostCompletion = true }
    func delayProfile(_ gate: ReadGate) { profileGate = gate }
    func denyNextProtectedRead() { denial = true }
    func failNextSnapshot() { failSnapshot = true }
    func useSharingSource(_ source: WireValue) { sharingSource = source }
    func useInboxRows(_ rows: [WireValue]) { inboxRows = rows }
    func keys() -> [String] { keyHistory }
    func credential(_ method: String, account: String = ConnectionFixture.account) throws -> WireValue {
        let claims: WireValue = .object(["sub": .string(account), "auth_method": .string(method), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return .object(["access_token": .string("fixture-header." + (try claims.encoded()).base64URL + ".fixture-signature"), "refresh_token": .string("fixture-refresh-token-" + UUID().uuidString), "expires_in": .integer(900), "roles": .strings(["user"]), "account_id": .string(account), "auth_method": .string(method)])
    }
    private func reply(_ wire: WireValue, status: Int = 200) throws -> NativeHTTPReply {
        NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try wire.encoded())
    }
    private func problem(_ status: Int, _ code: String) throws -> NativeHTTPReply { try reply(.object(["error": .object(["code": .string(code)])]), status: status) }
    private func validateSignature(_ raw: String?, envelope: WireValue) throws {
        guard let raw, let bytes = Data(base64URL: raw), bytes.count == 64,
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: bytes),
              signer.key.publicKey.isValidSignature(signature, for: try envelope.canonical()) else { throw NativeAPIError.invalidResponse }
        verifiedSignatures += 1
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        let body = request.value(forHTTPHeaderField: "Content-Type") == "application/json" ? try request.httpBody.map(WireValue.decoded) ?? .null : .null
        switch path {
        case "/auth/anonymous": return try reply(credential("anonymous"), status: 201)
        case "/me":
            let token = request.value(forHTTPHeaderField: "Authorization")?.split(separator: " ").last.map(String.init)
            let method = token?.split(separator: ".").dropFirst().first.flatMap { Data(base64URL: String($0)) }.flatMap { try? WireValue.decoded($0) }?["auth_method"].string
            if invalidatedAnonymous && method != "registered_face" { return try problem(401, "session_invalid") }
            return try reply(.object(["user_id": .string(Self.account), "name": .string("Fixture account"), "roles": .strings(["user"]), "auth_method": .string(registered ? "registered_face" : "anonymous"), "authenticated": .bool(registered),
                "profile_id": registered ? .string(Self.profile) : .null, "profile_revision": registered ? .string("fixture-profile-v1") : .null]))
        case "/me/devices": return try reply(.object(["items": .array([.object(["id": .string(Self.device), "current": .bool(true), "status": .string("active")])])]))
        case "/auth/face/policy": return try reply(.object(["protocol": .string("lovelies-face-auth-v1"), "policy_version": .string("registered-face-opencv-v1"), "required_captures": .integer(3), "poses": .strings(["front", "left", "right"]), "available": .bool(true)]))
        case "/auth/face/registration/challenge", "/auth/face/challenge":
            if unavailable { return try problem(503, "face_authentication_unavailable") }
            if path.contains("registration") {
                guard body["device_public_jwk"] == signer.jwk, body["consent"]["purpose"].string == "face_authentication", body["consent"]["granted"].bool == true, body["roles"] == .null else { throw NativeAPIError.invalidResponse }
                if body["enrollment_key"] != .null {
                    enrollmentKey = try body.uuid("enrollment_key"); faceHandle = try body.text("face_handle"); enrollmentDigest = signer.sha256(try signer.jwk.canonical())
                    let start: WireValue = .object(["protocol": .string("lovelies-face-enrollment-device-v1"), "step": .string("start"), "account_id": .string(Self.account), "enrollment_key": .string(enrollmentKey!), "face_handle": .string(faceHandle), "policy_version": body["consent"]["policy_version"], "device_public_jwk": signer.jwk])
                    try validateSignature(body["device_signature"].string, envelope: start)
                }
            } else {
                guard registered, body["face_handle"].string == faceHandle, body["device_id"].string == Self.device else { return try problem(401, "face_handle_unavailable") }
            }
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var row: [String: WireValue] = ["protocol": .string("lovelies-face-auth-v1"), "challenge_id": .string(Self.challengeID), "account_id": .string(Self.account), "device_id": .string(Self.device), "device_revision": .string(Self.device), "nonce": .string("lfn_" + String(repeating: "N", count: 43)), "purpose": .string(path.contains("registration") ? "registration" : "login"), "profile_id": registered ? .string(Self.profile) : .null, "profile_revision": registered ? .string("fixture-profile-v1") : .null, "model_id": registered ? .string("yunet-sface-v1") : .null, "policy_version": .string("registered-face-opencv-v1"), "required_captures": .integer(registered ? 1 : 3), "poses": .strings(registered ? ["front"] : ["front", "left", "right"]), "expires_at": .string(formatter.string(from: Date().addingTimeInterval(100))), "maximum_capture_bytes": .integer(8 * 1024 * 1024)]
            if path.contains("registration") {
                row["face_handle"] = .string(faceHandle)
                if let enrollmentKey, let enrollmentDigest { row["enrollment_key"] = .string(enrollmentKey); row["public_key_digest"] = .string(enrollmentDigest); row["enrollment_generation"] = .integer(1) }
            }
            challengeWire = .object(row); captureRows = []; return try reply(challengeWire)
        case "/auth/face/registration/recovery":
            guard let enrollmentKey, let enrollmentDigest, body["enrollment_key"].string == enrollmentKey,
                  body["account_id"].string == Self.account, body["face_handle"].string == faceHandle else { return try problem(404, "enrollment_recovery_unavailable") }
            var envelope = body.object!; envelope.removeValue(forKey: "device_signature"); envelope["protocol"] = .string("lovelies-face-enrollment-device-v1"); envelope["step"] = .string("status")
            try validateSignature(body["device_signature"].string, envelope: .object(envelope))
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return try reply(.object(["protocol": .string("lovelies-face-enrollment-v1"), "account_id": .string(Self.account), "enrollment_key": .string(enrollmentKey), "device_id": .string(Self.device), "device_revision": .string(Self.device), "challenge_id": .string(Self.challengeID), "public_key_digest": .string(enrollmentDigest), "policy_version": .string("registered-face-opencv-v1"), "enrollment_generation": .integer(1), "request_nonce": body["request_nonce"], "expires_at": .string(formatter.string(from: enrollmentCreated.addingTimeInterval(30 * 86400))), "authenticated": .bool(false), "state": .string(registered ? "registered" : "pending"), "challenge": registered ? .null : challengeWire, "captures": .array(registered ? [] : captureRows), "profile": registered ? .object(["id": .string(Self.profile), "revision": .string("fixture-profile-v1"), "model_id": .string("yunet-sface-v1")]) : .null]))
        case "/auth/face/registration/complete", "/auth/face/complete":
            let challenge = try NativeFaceChallenge(challengeWire, accountID: Self.account, purpose: challengeWire["purpose"].string!)
            guard captureRows.count == challenge.poses.count, body["challenge_id"].string == Self.challengeID else { throw NativeAPIError.invalidResponse }
            var envelope = challenge.deviceEnvelope(); envelope["step"] = .string("complete"); envelope["capture_manifest"] = .array(captureRows)
            try validateSignature(body["device_signature"].string, envelope: .object(envelope))
            if unavailable { return try problem(503, "face_authentication_unavailable") }
            registered = true
            var result = try credential("registered_face", account: completionAccount).object!
            result["protocol"] = .string("lovelies-face-auth-v1"); result["status"] = .string("authenticated"); result["profile_id"] = .string(Self.profile); result["profile_revision"] = .string("fixture-profile-v1"); result["model_id"] = .string("yunet-sface-v1"); result["device_id"] = .string(Self.device)
            if lostCompletion { lostCompletion = false; invalidatedAnonymous = true; throw URLError(.timedOut) }
            return try reply(.object(result))
        case "/auth/logout": return try reply(.object(["status": .string("logged_out")]))
        case "/me/profile":
            if let profileGate { await profileGate.pause() }
            if denial { denial = false; return try problem(401, "session_invalid") }
            return try reply(.object(["id": .string(Self.account), "name": .string("Fixture account")]))
        case "/community/action":
            switch body["action"].string {
            case "inbox": return try reply(.object(["items": .array(inboxRows)]))
            case "sharing.snapshot":
                let key = try body["payload"].text("operation_key"); keyHistory.append(key); snapshotAttempts += 1
                if failSnapshot && snapshotAttempts == 1 { throw URLError(.timedOut) }
                return try reply(.object(["protocol": .string("reviewed-sharing-v1"), "status": .string("ready"), "snapshot": .object(["id": .string(Self.challengeID), "version": .string("fixture-graph-v1"), "source": sharingSource, "expires_at": .string("2099-01-01T00:00:00.000Z"), "assets": .array([]), "recipients": .array([]), "pairs": .array([]), "scope": .object(["asset_limit": .integer(100), "recipient_limit": .integer(100), "pair_limit": .integer(1000), "has_more": .bool(false), "selection_limited": .bool(false)])])]))
            case "request.decide": return try reply(.object(["source": sharingSource, "request_id": body["payload"]["request_id"], "status": .string("accepted")]))
            case "operation": return try reply(.object(["protocol": .string("reviewed-sharing-v1"), "status": .string("unknown")]))
            default: throw NativeAPIError.invalidResponse
            }
        default:
            guard path.hasPrefix("/auth/face/proof/"), let index = Int(path.split(separator: "/").last!), let bytes = request.httpBody else { throw NativeAPIError.invalidResponse }
            let challenge = try NativeFaceChallenge(challengeWire, accountID: Self.account, purpose: challengeWire["purpose"].string!)
            let hash = signer.sha256(bytes); var envelope = challenge.deviceEnvelope()
            envelope["step"] = .string("capture"); envelope["capture_index"] = .integer(index); envelope["capture_sha256"] = .string(hash); envelope["mime"] = .string("image/jpeg"); envelope["byte_size"] = .integer(bytes.count)
            guard request.value(forHTTPHeaderField: "X-Lovelies-Capture-SHA256") == hash, request.value(forHTTPHeaderField: "X-Lovelies-Capture-Bytes") == String(bytes.count), index == captureRows.count else { throw NativeAPIError.invalidResponse }
            try validateSignature(request.value(forHTTPHeaderField: "X-Lovelies-Device-Signature"), envelope: .object(envelope))
            captureRows.append(.object(["index": .integer(index), "sha256": .string(hash), "mime": .string("image/jpeg"), "byte_size": .integer(bytes.count)]))
            return try reply(.object(["protocol": .string("lovelies-face-auth-v1"), "status": .string("capture_received"), "challenge_id": .string(Self.challengeID), "capture_index": .integer(index), "capture_sha256": .string(hash), "byte_size": .integer(bytes.count)]))
        }
    }
}

@main struct NativeConnectionTests {
    static var checks = 0
    static func assert(_ condition: @autoclosure () -> Bool, _ label: String) throws {
        guard condition() else { throw NativeAPIError.unsupported("Native connection check failed: " + label) }; checks += 1
    }
    static func rejects(_ label: String, _ body: () async throws -> Void) async throws {
        do { try await body() } catch { checks += 1; return }
        throw NativeAPIError.unsupported("Native connection rejection missing: " + label)
    }
    private static func make() -> (BackendRepository, ConnectionFixture, MemorySecrets, SoftwareSigner) {
        let signer = SoftwareSigner(), secrets = MemorySecrets(), transport = ConnectionFixture(signer: signer)
        return (BackendRepository(origin: URL(string: "https://fixture.invalid")!, transport: transport, secrets: secrets, signer: signer), transport, secrets, signer)
    }
    private static func captures(_ repository: BackendRepository, signer: SoftwareSigner) async throws -> (NativeFaceChallenge, [WireValue]) {
        let challenge = try await repository.startFace(consentPolicy: "registered-face-opencv-v1", publicKey: signer.jwk)
        var receipts: [WireValue] = []
        for index in challenge.poses.indices { receipts.append(try await repository.capture(Data("synthetic-protocol-capture-\(index)".utf8), index: index, challenge: challenge)) }
        return (challenge, receipts)
    }
    private static func enrolled() async throws -> (BackendRepository, ConnectionFixture, MemorySecrets, SoftwareSigner) {
        let values = make(); _ = try await values.0.bootstrap(); let captured = try await captures(values.0, signer: values.3)
        _ = try await values.0.completeFace(captured.0, captures: captured.1); return values
    }
    static func main() async throws {
        let (repository, fixture, secrets, signer) = make()
        let initial = try await repository.bootstrap()
        try assert(initial?.accountID == ConnectionFixture.account && initial?.authenticated == false, "automatic anonymous bootstrap")
        try await rejects("anonymous cannot read protected gallery") { _ = try await repository.photos() }
        let captured = try await captures(repository, signer: signer)
        try assert(captured.0.poses.count == 3, "three ordinary enrollment captures")
        let upgraded = try await repository.completeFace(captured.0, captures: captured.1)
        try assert(upgraded.authenticated && upgraded.accountID == initial?.accountID, "completion automatically upgrades same account")
        let signatureCount = await fixture.verifiedSignatures
        try assert(signatureCount == 5, "start, three capture signatures and completion use cryptographically verified raw64 P256")
        let stored = try secrets.read("credentials"), reference = try await repository.device()
        try assert(stored != nil && reference?.profileID == ConnectionFixture.profile, "credentials and opaque device reference are retained privately")
        let visited = await fixture.paths
        try assert(!visited.contains(where: { $0.lowercased().contains("otp") }), "no OTP or extra sign-in wire")
        try await repository.logout()
        let loggedOut = await repository.summary(), retained = try await repository.device()
        try assert(loggedOut == nil && retained?.faceHandle == reference?.faceHandle, "logout clears credentials and retains only recovery identity")
        let recovery = try await captures(repository, signer: signer)
        try assert(recovery.0.purpose == "login" && recovery.0.poses == ["front"], "one fresh signed capture uses existing reference")
        let restored = try await repository.completeFace(recovery.0, captures: recovery.1)
        try assert(restored.authenticated && restored.accountID == ConnectionFixture.account, "fresh verification restores same account")

        let wrong = make(); _ = try await wrong.0.bootstrap(); let wrongCapture = try await captures(wrong.0, signer: wrong.3); await wrong.1.useWrongAccount()
        try await rejects("server verdict cannot switch account") { _ = try await wrong.0.completeFace(wrongCapture.0, captures: wrongCapture.1) }
        let wrongState = await wrong.0.summary()
        try assert(wrongState?.authenticated == false && wrongState?.accountID == ConnectionFixture.account, "wrong-account completion cannot publish credentials")

        let missing = make(); _ = try await missing.0.bootstrap(); await missing.1.disableVerifier()
        try await rejects("unavailable server verifier fails closed") { _ = try await missing.0.startFace(consentPolicy: "registered-face-opencv-v1", publicKey: missing.3.jwk) }
        let missingState = await missing.0.summary()
        let missingDevice = try missing.2.read("registered-device")
        try assert(missingState?.authenticated == false && missingDevice == nil, "provider absence never mints registered credentials")

        let timeout = make(); _ = try await timeout.0.bootstrap(); let timeoutCapture = try await captures(timeout.0, signer: timeout.3); await timeout.1.loseNextCompletion()
        try await rejects("lost completion reply cannot report authentication") { _ = try await timeout.0.completeFace(timeoutCapture.0, captures: timeoutCapture.1) }
        let timeoutState = await timeout.0.summary()
        try assert(timeoutState?.authenticated == false, "network ambiguity never becomes local verified success")
        let restarted = BackendRepository(origin: URL(string: "https://fixture.invalid")!, transport: timeout.1, secrets: timeout.2, signer: timeout.3)
        let resumed = try await restarted.bootstrap()
        try assert(resumed == nil, "ambiguous completed enrollment keeps its opaque recovery reference")
        let resumedCapture = try await captures(restarted, signer: timeout.3)
        let resumedState = try await restarted.completeFace(resumedCapture.0, captures: resumedCapture.1)
        try assert(resumedState.authenticated && resumedState.accountID == ConnectionFixture.account, "fresh proof recovers ambiguous server upgrade without anonymous account replacement")

        let race = try await enrolled(), gate = ReadGate(); await race.1.delayProfile(gate)
        let read = Task { try await race.0.protectedJSON("/me/profile") }
        await gate.started()
        try await race.0.logout(); await gate.release()
        try await rejects("late old-session result after logout") { _ = try await read.value }
        let raceState = await race.0.summary(); try assert(raceState == nil, "late read never repopulates old credentials")

        let denial = try await enrolled(); await denial.1.denyNextProtectedRead()
        try await rejects("authoritative authentication denial") { _ = try await denial.0.protectedJSON("/me/profile") }
        let deniedState = await denial.0.summary(); try assert(deniedState == nil, "authoritative 401 clears current credentials")

        let retry = try await enrolled(); await retry.1.failNextSnapshot()
        try await rejects("ambiguous write is retained") { _ = try await retry.0.snapshot() }
        let intents = await retry.0.pending(); try assert(intents.count == 1, "private account-bound intent is durable before dispatch")
        _ = try await retry.0.reconcile(retryUnknown: true)
        let keys = await retry.1.keys(), remaining = await retry.0.pending()
        try assert(keys.count == 2 && keys[0] == keys[1] && keys[0] == intents[0].key && remaining.isEmpty, "reconciliation replays exact original operation key")

        let personalOnly = try await enrolled(), beforeRetiredMode = await personalOnly.1.paths
        try await rejects("professional snapshot rejected locally") { _ = try await personalOnly.0.snapshot(source: "professional") }
        try await rejects("professional feed rejected locally") { _ = try await personalOnly.0.photos(source: "professional") }
        let afterRetiredMode = await personalOnly.1.paths, rejectedIntents = await personalOnly.0.pending()
        try assert(afterRetiredMode == beforeRetiredMode && rejectedIntents.isEmpty, "retired mode does not dispatch or persist an intent")
        let personalSnapshot = try await personalOnly.0.snapshot()
        try assert(personalSnapshot.source == "personal", "ordinary snapshot remains available")
        let decision = try await personalOnly.0.decide(ConnectionFixture.challengeID, decision: "accept")
        try assert(decision["source"].string == "personal", "ordinary decision requires explicit personal response")
        let personalInboxRow: WireValue = .object(["id": .string(ConnectionFixture.challengeID), "source": .string("personal")])
        await personalOnly.1.useInboxRows([personalInboxRow])
        let personalInbox = try await personalOnly.0.inbox()
        try assert(personalInbox == [personalInboxRow], "personal inbox rows reach the publication seam unchanged")
        for unsupportedRow in [WireValue.object(["source": .string("professional")]), .object([:])] {
            await personalOnly.1.useInboxRows([personalInboxRow, unsupportedRow])
            try await rejects("mixed inbox rejects retired or missing source before publication") { _ = try await personalOnly.0.inbox() }
        }
        await personalOnly.1.useInboxRows([])
        let emptyInbox = try await personalOnly.0.inbox()
        try assert(emptyInbox.isEmpty, "empty personal inbox remains supported")

        for responseSource in [WireValue.null, .string("professional")] {
            let wrongSnapshot = try await enrolled(); await wrongSnapshot.1.useSharingSource(responseSource)
            try await rejects("snapshot rejects absent or retired response source") { _ = try await wrongSnapshot.0.snapshot() }
            let unresolvedSnapshot = await wrongSnapshot.0.pending()
            try assert(unresolvedSnapshot.count == 1, "invalid snapshot response retains original operation")
            let wrongDecision = try await enrolled(); await wrongDecision.1.useSharingSource(responseSource)
            try await rejects("decision rejects absent or retired response source") { _ = try await wrongDecision.0.decide(ConnectionFixture.challengeID, decision: "accept") }
            let unresolvedDecision = await wrongDecision.0.pending()
            try assert(unresolvedDecision.count == 1, "invalid decision response retains original operation")
        }
        for retiredSource in [true, false] {
            let stored = try await enrolled()
            let payload: WireValue = .object(["source": retiredSource ? .string("personal") : .string("professional")])
            let retired = NativeOperationIntent(key: UUID().uuidString.lowercased(), accountID: ConnectionFixture.account,
                source: retiredSource ? "professional" : "personal", action: "sharing.snapshot", payload: payload, approvedPairs: nil)
            try stored.2.write("operation-intents", data: JSONEncoder().encode([retired]))
            let restarted = BackendRepository(origin: URL(string: "https://fixture.invalid")!, transport: stored.1, secrets: stored.2, signer: stored.3)
            _ = try await restarted.bootstrap(); let before = await stored.1.paths
            try await rejects("retired persisted intent cannot replay") { _ = try await restarted.reconcile(retryUnknown: true) }
            let after = await stored.1.paths, retained = await restarted.pending()
            try assert(after == before && retained.count == 1 && retained[0].key == retired.key, "retired intent is preserved without operation lookup or replay")
        }
        print("Native connection protocol checks passed: \(checks)")
    }
}
