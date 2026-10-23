import Foundation
import CryptoKit

// Controlled storage/transport fixtures. No model, camera, hosted authority,
// physical Keychain or iOS app execution is established by these checks.
private final class OrdinarySecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock(); private var values: [String: Data] = [:]
    private var failCredential = false
    func failNextCredential() { lock.lock(); defer { lock.unlock() }; failCredential = true }
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if name == "credentials", data != nil, failCredential { failCredential = false; throw NativeAPIError.unavailable("protected_storage") }
        values[name] = data
    }
    func journal() throws -> NativeOrdinaryLoginRecord { try JSONDecoder().decode(NativeOrdinaryLoginRecord.self, from: read("ordinary-face-login-journal")!) }
    func expireStaged() throws {
        let record = try journal(); var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as! [String: Any]
        var credential = value["promotionCredentials"] as! [String: Any]; credential["expiresAt"] = Date().addingTimeInterval(-5).timeIntervalSinceReferenceDate
        value["promotionCredentials"] = credential; try write("ordinary-face-login-journal", data: JSONSerialization.data(withJSONObject: value))
    }
}
private struct OrdinarySigner: NativeDeviceSigner, @unchecked Sendable {
    let key = P256.Signing.PrivateKey()
    func sign(_ bytes: Data) throws -> String { try key.signature(for: bytes).rawRepresentation.base64URL }
    func sha256(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
    func hasRetainedKey() throws -> Bool { true }
    var jwk: WireValue {
        let bytes = key.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(bytes.subdata(in: 1..<33).base64URL), "y": .string(bytes.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
}
private actor OrdinaryTransport: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000081", device = "00000000-0000-4000-8000-000000000082"
    static let profile = "00000000-0000-4000-8000-000000000083", revision = "reference-v1", model = "yunet-sface-v1", policy = "face-v1"
    private var challenge: WireValue = .null
    private var deniedCurrent = false, deviceStatus = "active", loseCapture = false, mismatch = false
    private(set) var paths: [String] = [], revokedTokens: [String] = []
    nonisolated func cancelPending() {}
    func currentDenied(_ value: Bool) { deniedCurrent = value }
    func status(_ value: String) { deviceStatus = value }
    func interruptCapture() { loseCapture = true }
    func rejectMismatch() { mismatch = true }
    private func reply(_ value: WireValue, _ status: Int = 200) throws -> NativeHTTPReply { NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try value.encoded()) }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        let dates = ISO8601DateFormatter(); dates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if path == "/auth/face/challenge" {
            challenge = .object(["protocol": .string("lovelies-face-auth-v1"), "purpose": .string("login"), "challenge_id": .string(UUID().uuidString.lowercased()),
                "account_id": .string(Self.account), "device_id": .string(Self.device), "device_revision": .string("00000000-0000-4000-8000-000000000084"),
                "profile_id": .string(Self.profile), "profile_revision": .string(Self.revision), "model_id": .string(Self.model), "policy_version": .string(Self.policy),
                "nonce": .string("lfn_" + Data(repeating: 5, count: 32).base64URL), "maximum_capture_bytes": .integer(8 * 1024 * 1024),
                "required_captures": .integer(1), "poses": .strings(["front"]), "expires_at": .string(dates.string(from: Date().addingTimeInterval(100)))])
            return try reply(challenge)
        }
        if path.hasPrefix("/auth/face/proof/") {
            if loseCapture { loseCapture = false; throw URLError(.networkConnectionLost) }
            return try reply(.object(["protocol": .string("lovelies-face-auth-v1"), "status": .string("capture_received"), "challenge_id": challenge["challenge_id"],
                "capture_index": .integer(0), "capture_sha256": .string(request.value(forHTTPHeaderField: "X-Lovelies-Capture-SHA256")!), "byte_size": .integer(request.httpBody!.count)]))
        }
        if path == "/auth/face/complete" {
            if mismatch { mismatch = false; return try reply(.object(["error": .object(["code": .string("face_verification_failed")])]), 401) }
            let claims: WireValue = .object(["sub": .string(Self.account), "auth_method": .string("registered_face"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
            return try reply(.object(["protocol": .string("lovelies-face-auth-v1"), "status": .string("authenticated"), "device_id": .string(Self.device),
                "profile_id": .string(Self.profile), "profile_revision": .string(Self.revision), "model_id": .string(Self.model), "account_id": .string(Self.account),
                "auth_method": .string("registered_face"), "roles": .strings(["user"]), "expires_in": .integer(900), "refresh_token": .string("fixture-refresh"),
                "access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture")]))
        }
        if path == "/me" {
            if deniedCurrent { return try reply(.object(["error": .object(["code": .string("unavailable")])]), 503) }
            return try reply(.object(["user_id": .string(Self.account), "authenticated": .bool(true), "auth_method": .string("registered_face"), "profile_id": .string(Self.profile), "profile_revision": .string(Self.revision)]))
        }
        if path == "/me/devices" {
            var row: [String: WireValue] = ["id": .string(Self.device), "current": .bool(true)]
            if deviceStatus != "missing" { row["status"] = .string(deviceStatus) }
            return try reply(.object(["items": .array([.object(row)])]))
        }
        if path == "/auth/logout" { revokedTokens.append(request.value(forHTTPHeaderField: "Authorization") ?? ""); return try reply(.object(["status": .string("signed_out")])) }
        throw NativeAPIError.invalidResponse
    }
}
@main struct NativeOrdinaryLoginTests {
    private static let origin = URL(string: "https://ordinary.invalid")!
    private static var checks = 0
    private static func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws { guard try condition() else { throw NativeAPIError.unsupported(label) }; checks += 1 }
    private static func rejects(_ work: () async throws -> Void) async throws { var rejected = false; do { try await work() } catch { rejected = true }; try require(rejected, "Required ordinary-login hold was bypassed") }
    private static func make() async throws -> (BackendRepository, OrdinarySecrets, OrdinarySigner, OrdinaryTransport, NativeFaceChallenge) {
        let store = OrdinarySecrets(), signer = OrdinarySigner(), transport = OrdinaryTransport()
        let device = RegisteredDevice(accountID: OrdinaryTransport.account, faceHandle: "lfh_" + Data(repeating: 8, count: 32).base64URL, deviceID: OrdinaryTransport.device,
            profileID: OrdinaryTransport.profile, profileRevision: OrdinaryTransport.revision, modelID: OrdinaryTransport.model)
        try store.write("registered-device", data: JSONEncoder().encode(device))
        let repository = BackendRepository(origin: origin, transport: transport, secrets: store, signer: signer)
        let session = try await repository.bootstrap(); try require(session == nil, "Retained device starts without creating a new guest")
        let challenge = try await repository.startFace(consentPolicy: OrdinaryTransport.policy, publicKey: signer.jwk)
        try require(try store.journal().publicJWK == signer.jwk, "Ordinary login journal is bound to original key before capture")
        return (repository, store, signer, transport, challenge)
    }
    private static func run() async throws {
        do {
            let (repository, store, _, transport, challenge) = try await make(); await transport.rejectMismatch()
            let originalDigest = try store.journal().publicKeyDigest
            let proof = try await repository.capture(Data([0xff, 0xd8, 0xff, 1]), index: 0, challenge: challenge)
            try await rejects { _ = try await repository.completeFace(challenge, captures: [proof]) }
            let held = try await repository.ordinaryLoginSummary()!
            try require(held.terminalMismatch && held.terminalQuality == nil && held.canRetry && challenge.expiresAt > Date(), "Exact terminal reference mismatch permits explicit retry and remains distinct from quality rejection")
            let fresh = try await repository.prepareFaceRetake(challenge, terminalQualityFailure: false)
            try require(fresh.challenge?.id != challenge.id && fresh.challenge?.accountID == OrdinaryTransport.account && fresh.challenge?.deviceID == OrdinaryTransport.device && fresh.receipts.isEmpty && (try store.journal()).publicKeyDigest == originalDigest, "Known terminal mismatch creates only a fresh same-account/device/key challenge")
        }
        for status in ["missing", "revoked", "unknown"] {
            let (repository, store, signer, transport, challenge) = try await make(); await transport.status(status)
            let proof = try await repository.capture(Data([0xff, 0xd8, 0xff, 1]), index: 0, challenge: challenge)
            try await rejects { _ = try await repository.completeFace(challenge, captures: [proof]) }
            let held = try store.journal(), publicSession = await repository.summary()
            try require(held.promotionCredentials != nil && publicSession == nil, "Missing/revoked/unknown current-device status retains staged hold without publishing")
            await transport.status("active")
            let rebuilt = BackendRepository(origin: origin, transport: transport, secrets: store, signer: signer), repaired = try await rebuilt.bootstrap()
            try require(repaired?.authenticated == true && repaired?.accountID == OrdinaryTransport.account && (try store.read("ordinary-face-login-journal")) == nil, "Only unique current active original device publishes repaired session")
        }
        do {
            let (repository, store, signer, transport, challenge) = try await make(); await transport.currentDenied(true)
            let proof = try await repository.capture(Data([0xff, 0xd8, 0xff, 1]), index: 0, challenge: challenge)
            try await rejects { _ = try await repository.completeFace(challenge, captures: [proof]) }
            let token = try store.journal().promotionCredentials!.access_token
            await repository.clearSession()
            let rebuilt = BackendRepository(origin: origin, transport: transport, secrets: store, signer: signer)
            try await rejects { _ = try await rebuilt.bootstrap() }
            try await rebuilt.logout()
            let held = try store.journal(), revoked = await transport.revokedTokens
            try require(held.promotionCredentials == nil && held.completionPending && held.originalDevice.deviceID == OrdinaryTransport.device && revoked.contains("Bearer " + token), "Explicit restart logout revokes staged JWT before retiring authority and keeps original proof/key metadata")
            let publicSession = await rebuilt.summary(); try require(publicSession == nil && (try store.read("credentials")) == nil, "Logout never publishes staged ordinary session")
        }
        do {
            let (repository, store, signer, transport, challenge) = try await make(); store.failNextCredential()
            let proof = try await repository.capture(Data([0xff, 0xd8, 0xff, 1]), index: 0, challenge: challenge)
            try await rejects { _ = try await repository.completeFace(challenge, captures: [proof]) }
            try require(try store.journal().promotionCredentials != nil, "Credential-slot failure retains private staged ordinary authority for repair")
            try store.expireStaged()
            let rebuilt = BackendRepository(origin: origin, transport: transport, secrets: store, signer: signer), restored = try await rebuilt.bootstrap()
            let held = try store.journal(), paths = await transport.paths
            try require(restored == nil && held.promotionCredentials == nil && held.completionPending && !paths.contains("/auth/session/refresh"), "Expired staged authority retires while original unexpired completion remains held")
            try await rejects { _ = try await rebuilt.prepareFaceRetake(challenge, terminalQualityFailure: false) }
            try require(try store.journal().challengeWire == challenge.wire, "Expired credential cannot bypass the original live challenge deadline")
        }
        do {
            let (repository, store, signer, transport, challenge) = try await make(); await transport.interruptCapture()
            try await rejects { _ = try await repository.capture(Data([0xff, 0xd8, 0xff, 1]), index: 0, challenge: challenge) }
            let rebuilt = BackendRepository(origin: origin, transport: transport, secrets: store, signer: signer), restored = try await rebuilt.bootstrap()
            let held = try await rebuilt.ordinaryLoginSummary()!
            try require(restored == nil && held.awaitingServer && held.challenge.id == challenge.id && (try store.journal()).captures[0].accepted == false, "Interrupted ordinary proof survives repository restart as exact protected ambiguity")
            try await rejects { _ = try await rebuilt.startFace(consentPolicy: OrdinaryTransport.policy, publicKey: signer.jwk) }
            try await rejects { _ = try await rebuilt.prepareFaceRetake(challenge, terminalQualityFailure: false) }
            let paths = await transport.paths; try require(paths.filter { $0 == "/auth/face/challenge" }.count == 1 && !paths.contains("/auth/anonymous"), "Unconfirmed ordinary proof never creates another challenge or account before expiry")
        }
    }
    static func main() async { do { try await run(); print("Native ordinary login recovery checks passed: \(checks)") } catch { print(error.localizedDescription); exit(1) } }
}
