import Foundation
import CryptoKit

// Isolated protocol, protected-journal and actor-fence fixtures. These do not
// establish hosted guardian review, legal age, camera or physical-device proof.
private final class AudienceSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var refuseJournal = false
    func rejectJournalWrites() { lock.lock(); defer { lock.unlock() }; refuseJournal = true }
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if name == "audience-mutation-journal", data != nil, refuseJournal { throw NativeAPIError.unavailable("protected_storage") }
        values[name] = data
    }
}
private struct AudienceSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
}
private enum AudienceFixture {
    static let account = "00000000-0000-4000-8000-000000000091", other = "00000000-0000-4000-8000-000000000092"
    static let request = "00000000-0000-4000-8000-000000000093", device = "00000000-0000-4000-8000-000000000094", challenge = "00000000-0000-4000-8000-000000000095"
    static let origin = URL(string: "https://audience.invalid")!
    static func iso(_ date: Date) -> WireValue {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return .string(f.string(from: date))
    }
    static func capabilities(_ enabled: Bool) -> WireValue { .object(["face_authentication": .bool(enabled), "photo_matching": .bool(enabled), "photo_processing": .bool(enabled)]) }
    static func requestWire(state: String = "pending", enabled: Bool = false, child: String = account, expiry: Date = Date().addingTimeInterval(600)) -> WireValue {
        .object(["id": .string(request), "child_account_id": .string(child), "state": .string(state), "revision": .integer(1), "policy_version": .string(NativeAudienceProjection.policy), "created_at": iso(Date().addingTimeInterval(-60)), "expires_at": iso(expiry), "purposes": capabilities(enabled)])
    }
    static func projection(band: String = "unknown", status: String = "unknown", version: Int = 0, enabled: Bool = false, request: WireValue = .null, review: WireValue = .null, account: String = account) -> WireValue {
        .object(["protocol": .string(NativeAudienceProjection.protocolName), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(account),
                 "audience": .object(["age_band": .string(band), "status": .string(status), "version": .integer(version), "policy_version": band == "unknown" ? .null : .string(NativeAudienceProjection.policy), "next_review_at": review]),
                 "guardian_request": request, "capabilities": capabilities(enabled)])
    }
    static func credential(account: String = account, method: String = "anonymous") throws -> NativeCredentials {
        let claims: WireValue = .object(["sub": .string(account), "auth_method": .string(method), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("audience-fixture-refresh"), "account_id": .string(account), "auth_method": .string(method), "expires_in": .integer(900), "roles": .strings(["user"])]))
    }
    static func changing(_ value: WireValue, _ key: String, _ replacement: WireValue) -> WireValue { var v = value.object!; v[key] = replacement; return .object(v) }
    static func challengeWire(expiry: Date = Date().addingTimeInterval(100)) -> WireValue {
        .object(["protocol": .string("lovelies-face-auth-v1"), "purpose": .string("login"), "challenge_id": .string(challenge), "account_id": .string(account), "device_id": .string(device), "device_revision": .string(device),
                 "profile_id": .string(request), "profile_revision": .string("profile-v1"), "model_id": .string("model-v1"), "policy_version": .string("face-v1"), "nonce": .string("lfn_" + Data(repeating: 1, count: 32).base64URL),
                 "maximum_capture_bytes": .integer(8 * 1024 * 1024), "required_captures": .integer(1), "poses": .strings(["front"]), "expires_at": iso(expiry)])
    }
    static func authority(expiry: Date = Date().addingTimeInterval(90)) -> WireValue {
        .object(["protocol": .string("lovelies-audience-challenge-v1"), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(account), "challenge_id": .string(challenge), "device_id": .string(device), "purpose": .string("login"), "audience_version": .integer(1), "expires_at": iso(expiry)])
    }
}
private actor AudienceTransport: NativeTransport {
    let secrets: AudienceSecrets, method: String
    private var value: WireValue = AudienceFixture.projection()
    private var loseMutation = false, losePrivacy = false, changeProduct = false, foreignReply = false
    private var profileStatus = 200
    private var profileBody: WireValue = .object(["user_id": .string(AudienceFixture.account), "name": .string("Synthetic adult"), "profile_scope": .string("registered_face_profile")])
    private(set) var privacyBodies: [Data] = []
    private(set) var mutations: [Data] = [], paths: [String] = []
    private var acknowledged: [String: (Data, WireValue)] = [:]
    init(secrets: AudienceSecrets, method: String = "anonymous") { self.secrets = secrets; self.method = method }
    nonisolated func cancelPending() {}
    func interruptNextMutation() { loseMutation = true }
    func interruptNextPrivacy() { losePrivacy = true }
    func revokeAfterProductReply() { changeProduct = true }
    func setProjection(_ projection: WireValue) { value = projection }
    func respondAsOtherAccount() { foreignReply = true }
    func strongProfile(_ body: WireValue, status: Int = 200) { profileBody = body; profileStatus = status }
    private func reply(_ value: WireValue, status: Int = 200) throws -> NativeHTTPReply { .init(status: status, headers: ["content-type": "application/json"], data: try value.encoded()) }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        if path == "/me/profile" { return try reply(profileBody, status: profileStatus) }
        if path == "/me" { return try reply(.object(["user_id": .string(AudienceFixture.account), "authenticated": .bool(method == "registered_face"), "auth_method": .string(method)])) }
        if path == "/me/audience", request.httpMethod == "GET" {
            return try reply(foreignReply ? AudienceFixture.changing(value, "account_id", .string(AudienceFixture.other)) : value)
        }
        if path == "/me/audience", request.httpMethod == "PUT" {
            let data = request.httpBody!, body = try WireValue.decoded(data), key = try body.text("operation_key")
            guard let journalBytes = try secrets.read("audience-mutation-journal") else { throw NativeAPIError.unsupported("Mutation preceded durable journal") }
            let journal = try JSONDecoder().decode(NativeAudienceMutationRecord.self, from: journalBytes)
            guard journal.body == body, journal.path == path, journal.method == "PUT", journal.operationKey == key else { throw NativeAPIError.invalidResponse }
            mutations.append(data)
            if let saved = acknowledged[key] {
                guard saved.0 == data else { return try reply(.object(["error": .object(["code": .string("operation_key_conflict")])]), status: 409) }
                return try reply(saved.1)
            }
            let band = try body.text("age_band")
            value = AudienceFixture.projection(band: band, status: band == "under13" ? "blocked" : band == "13_17" ? "guardian_pending" : "eligible", version: 1, enabled: band == "18_plus")
            acknowledged[key] = (data, value)
            if loseMutation { loseMutation = false; throw URLError(.networkConnectionLost) }
            return try reply(value)
        }
        if path == "/product-fixture" {
            if changeProduct { value = AudienceFixture.projection(band: "18_plus", status: "suspended", version: 2) }
            return try reply(.object(["private_result": .string("must-not-publish-after-revocation")]))
        }
        if path == "/privacy/export" {
            let data = request.httpBody!, body = try WireValue.decoded(data)
            guard let intentsData = try secrets.read("operation-intents"), try JSONDecoder().decode([NativeOperationIntent].self, from: intentsData).contains(where: { $0.payload == body && $0.path == path }) else { throw NativeAPIError.invalidResponse }
            privacyBodies.append(data)
            if losePrivacy { losePrivacy = false; throw URLError(.networkConnectionLost) }
            return try reply(.object(["privacy_request": .object(["id": .string(AudienceFixture.request), "request_type": .string("export"), "status": .string("pending_approval")])]))
        }
        if path.hasPrefix("/privacy/operations/") { return try reply(.object(["status": .string("unknown")])) }
        if path == "/privacy/center" { return try reply(.object(["privacy_requests": .array([])])) }
        if path == "/auth/logout" { return try reply(.object(["status": .string("signed_out")])) }
        throw NativeAPIError.invalidResponse
    }
}
@main struct NativeAudienceTests {
    private static var checks = 0
    private static func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws { guard try condition() else { throw NativeAPIError.unsupported(label) }; checks += 1 }
    private static func rejects(_ label: String, _ work: () throws -> Void) throws { var rejected = false; do { try work() } catch { rejected = true }; try require(rejected, label) }
    private static func rejectsAsync(_ label: String, _ work: () async throws -> Void) async throws { var rejected = false; do { try await work() } catch { rejected = true }; try require(rejected, label) }
    private static func make(method: String = "anonymous") async throws -> (BackendRepository, AudienceSecrets, AudienceTransport) {
        let secrets = AudienceSecrets(), transport = AudienceTransport(secrets: secrets, method: method)
        try secrets.write("credentials", data: JSONEncoder().encode(AudienceFixture.credential(method: method)))
        let repository = BackendRepository(origin: AudienceFixture.origin, transport: transport, secrets: secrets, signer: AudienceSigner())
        _ = try await repository.bootstrap(); return (repository, secrets, transport)
    }
    static func main() async throws {
        let unknown = try NativeAudienceProjection(AudienceFixture.projection(), account: AudienceFixture.account)
        try require(unknown.ageBand == .unknown && unknown.version == 0, "Unknown became an adult declaration")
        try rejects("Unknown permitted face access") { try unknown.require(.faceAuthentication) }
        let adult = try NativeAudienceProjection(AudienceFixture.projection(band: "18_plus", status: "eligible", version: 1, enabled: true), account: AudienceFixture.account)
        try adult.require(.faceAuthentication); try adult.require(.photoProcessing); checks += 2
        try rejects("Foreign account projection accepted") { _ = try NativeAudienceProjection(AudienceFixture.projection(account: AudienceFixture.other), account: AudienceFixture.account) }
        try rejects("Unknown projection key accepted") { _ = try NativeAudienceProjection(AudienceFixture.changing(AudienceFixture.projection(), "admin", .bool(true)), account: AudienceFixture.account) }
        try rejects("Numeric capability accepted") { _ = try NativeAudienceCapabilities(.object(["face_authentication": .integer(1), "photo_matching": .bool(false), "photo_processing": .bool(false)])) }
        try rejects("Unknown adult defaults permitted") { _ = try NativeAudienceProjection(AudienceFixture.projection(status: "eligible", enabled: true), account: AudienceFixture.account) }
        let blocked = try NativeAudienceProjection(AudienceFixture.projection(band: "under13", status: "blocked", version: 1), account: AudienceFixture.account)
        try rejects("Under13 permitted processing") { try blocked.require(.photoProcessing) }
        let pending = try NativeAudienceProjection(AudienceFixture.projection(band: "13_17", status: "guardian_pending", version: 1, request: AudienceFixture.requestWire()), account: AudienceFixture.account)
        try rejects("Pending guardian permitted camera") { try pending.require(.faceAuthentication) }
        try rejects("Claim state activated a purpose") { _ = try NativeGuardianRequest(AudienceFixture.requestWire(state: "under_review", enabled: true)) }
        try rejects("Foreign child projection accepted") { _ = try NativeGuardianRequest(AudienceFixture.requestWire(child: AudienceFixture.other), child: AudienceFixture.account) }
        let expiry = Date().addingTimeInterval(500)
        let approved = try NativeAudienceProjection(AudienceFixture.projection(band: "13_17", status: "eligible", version: 1, enabled: true, request: AudienceFixture.requestWire(state: "approved", enabled: true, expiry: expiry), review: AudienceFixture.iso(expiry)), account: AudienceFixture.account)
        try approved.require(.faceAuthentication); checks += 1
        try rejects("Expired review permitted camera") { try approved.require(.faceAuthentication, now: expiry.addingTimeInterval(1)) }
        let suspended = try NativeAudienceProjection(AudienceFixture.projection(band: "18_plus", status: "suspended", version: 2), account: AudienceFixture.account)
        try rejects("Suspended adult permitted products") { try suspended.require(.photoMatching) }
        let challenge = try NativeFaceChallenge(AudienceFixture.challengeWire(), accountID: AudienceFixture.account, purpose: "login")
        let authority = try NativeAudienceChallengeAuthority(AudienceFixture.authority(), challenge: challenge)
        try authority.requireCurrent(); checks += 1
        for key in ["account_id", "challenge_id", "device_id"] {
            try rejects("Foreign challenge binding accepted: " + key) { _ = try NativeAudienceChallengeAuthority(AudienceFixture.changing(AudienceFixture.authority(), key, .string(AudienceFixture.other)), challenge: challenge) }
        }
        try rejects("Wrong challenge purpose accepted") { _ = try NativeAudienceChallengeAuthority(AudienceFixture.changing(AudienceFixture.authority(), "purpose", .string("registration")), challenge: challenge) }
        try rejects("Authority outlived challenge") { _ = try NativeAudienceChallengeAuthority(AudienceFixture.authority(expiry: challenge.expiresAt.addingTimeInterval(1)), challenge: challenge) }
        try rejects("Expired capture authority accepted") { try NativeAudienceChallengeAuthority(AudienceFixture.authority(expiry: Date().addingTimeInterval(-1)), challenge: challenge).requireCurrent() }
        let declaration: WireValue = .object(["age_band": .string("13_17"), "expected_version": .integer(0), "policy_version": .string(NativeAudienceProjection.policy)])
        let record = try NativeAudienceMutationRecord(origin: AudienceFixture.origin, accountID: AudienceFixture.account, path: "/me/audience", method: "PUT", body: declaration)
        try require(try JSONDecoder().decode(NativeAudienceMutationRecord.self, from: JSONEncoder().encode(record)) == record, "Exact journal did not survive restart encoding")
        try rejects("Journal origin substitution accepted") { try record.validate(origin: URL(string: "https://foreign.invalid")!) }
        try rejects("Duplicate guardian purposes accepted") { _ = try NativeAudienceMutationRecord(origin: AudienceFixture.origin, accountID: AudienceFixture.account, path: "/guardian-requests/" + AudienceFixture.request + "/claim", method: "POST", body: .object(["expected_revision": .integer(1), "policy_version": .string(NativeAudienceProjection.policy), "relationship_attested": .bool(true), "purposes": .strings(["face_authentication", "face_authentication"])])) }
        let (repo, secrets, transport) = try await make()
        _ = try await repo.audience(); await transport.interruptNextMutation()
        try await rejectsAsync("Lost declaration reply claimed success") { _ = try await repo.declareAudience(.adult, expectedVersion: 0) }
        let journal = try await repo.pendingAudienceMutation()
        try require(journal?.body["age_band"].string == "18_plus", "Original declaration key/body missing")
        try await rejectsAsync("New declaration replaced uncertain mutation") { _ = try await repo.declareAudience(.teen, expectedVersion: 0) }
        try require(try secrets.read("audience-mutation-journal") != nil, "Uncertain journal was removed")
        try await repo.logout()
        let heldSummary = await repo.summary(), logoutPaths = await transport.paths
        try require(heldSummary == nil && !logoutPaths.contains("/auth/logout"), "Logout revoked sole uncertain anonymous authority or published product session")
        try require(try secrets.read("audience-suspended-authority") != nil, "Suspended original credential context missing")
        try await rejectsAsync("Suspended age operation opened product scope") { _ = try await repo.protectedJSON("/product-fixture") }
        let restarted = BackendRepository(origin: AudienceFixture.origin, transport: transport, secrets: secrets, signer: AudienceSigner())
        _ = try await restarted.bootstrap()
        let heldBinding = await restarted.audienceSessionBinding()
        try require(heldBinding?.accountID == AudienceFixture.account && heldBinding?.registeredIdentity == false, "Restart changed original anonymous account")
        try await rejectsAsync("Restart bypassed suspended operation with face setup") { _ = try await restarted.startFace(consentPolicy: "face-v1", publicKey: .null) }
        let recovered = try await restarted.retryAudienceMutation()
        try require(recovered.ageBand == .adult, "Original declaration did not reconcile")
        let sent = await transport.mutations
        try require(sent.count == 2 && sent[0] == sent[1], "Retry changed exact body or operation key")
        try require(try secrets.read("audience-mutation-journal") == nil, "Confirmed journal did not retire")
        try require(try secrets.read("audience-suspended-authority") == nil && secrets.read("credentials") != nil, "Reconciled same-account authority was lost or remained frozen")
        await transport.revokeAfterProductReply()
        try await rejectsAsync("Private result published after audience revoke") { _ = try await restarted.protectedJSON("/product-fixture") }
        _ = try await restarted.protectedJSON("/privacy/center"); checks += 1
        await restarted.clearSession()
        try await rejectsAsync("Old projection survived logout epoch") { _ = try await restarted.audiencePresentation(recovered) }
        let (noWrite, brokenSecrets, brokenTransport) = try await make()
        brokenSecrets.rejectJournalWrites()
        try await rejectsAsync("Journal failure still dispatched mutation") { _ = try await noWrite.declareAudience(.adult, expectedVersion: 0) }
        let blockedCalls = await brokenTransport.mutations
        try require(blockedCalls.isEmpty, "Request was sent without durable operation")
        let (foreign, _, foreignTransport) = try await make()
        await foreignTransport.respondAsOtherAccount()
        try await rejectsAsync("Foreign current audience published") { _ = try await foreign.audience() }
        let (registered, _, registeredTransport) = try await make(method: "registered_face")
        await registeredTransport.setProjection(AudienceFixture.projection(band: "13_17", status: "guardian_pending", version: 1))
        _ = try await registered.protectedJSON("/privacy/center"); checks += 1
        try await rejectsAsync("Registered session bypassed pending audience") { _ = try await registered.protectedJSON("/product-fixture") }
        let (privacyOwner, privacySecrets, privacyTransport) = try await make(method: "registered_face")
        let productKey = UUID().uuidString.lowercased()
        let productIntent = NativeOperationIntent(key: productKey, accountID: AudienceFixture.account, source: "personal", action: "sharing.snapshot", payload: .object(["operation_key": .string(productKey)]), approvedPairs: nil)
        try privacySecrets.write("operation-intents", data: JSONEncoder().encode([productIntent]))
        let privacyRestart = BackendRepository(origin: AudienceFixture.origin, transport: privacyTransport, secrets: privacySecrets, signer: AudienceSigner())
        _ = privacyOwner // Independent repository intentionally reads the existing protected intent.
        _ = try await privacyRestart.bootstrap()
        await privacyTransport.setProjection(AudienceFixture.projection(band: "13_17", status: "guardian_pending", version: 1))
        await privacyTransport.interruptNextPrivacy()
        try await rejectsAsync("Lost privacy reply claimed success") { _ = try await privacyRestart.post("/privacy/export", payload: .object([:]), operation: "privacy.request.export") }
        let beforePrivacyReplay = await privacyRestart.pending()
        try require(beforePrivacyReplay.count == 2 && beforePrivacyReplay.contains(where: { $0.key == productKey }), "Privacy request replaced uncertain product operation")
        _ = try await privacyRestart.reconcilePrivacy(retryUnknown: true)
        let remaining = await privacyRestart.pending(), privacyBodies = await privacyTransport.privacyBodies
        try require(remaining.count == 1 && remaining.first?.key == productKey, "Privacy retry erased unrelated pending product request")
        try require(privacyBodies.count == 2 && privacyBodies[0] == privacyBodies[1], "Weaker privacy retry changed original key/body")
        let collectionRoot = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-audience-collection-" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: collectionRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: collectionRoot) }
        let selectedSource = collectionRoot.appendingPathComponent("synthetic-selected.jpg")
        try Data([0xff, 0xd8, 0xff, 1, 2, 3]).write(to: selectedSource)
        let privateFiles = NativeUploadPrivateFiles(root: collectionRoot.appendingPathComponent("private-staging", isDirectory: true))
        let collectionSecrets = AudienceSecrets(), collectionTransport = AudienceTransport(secrets: collectionSecrets, method: "registered_face")
        try collectionSecrets.write("credentials", data: JSONEncoder().encode(AudienceFixture.credential(method: "registered_face")))
        let collectionDevice = RegisteredDevice(accountID: AudienceFixture.account, faceHandle: "lfh_" + Data(repeating: 7, count: 32).base64URL, deviceID: AudienceFixture.device,
            profileID: AudienceFixture.request, profileRevision: "profile-v1", modelID: "synthetic-model")
        try collectionSecrets.write("registered-device", data: JSONEncoder().encode(collectionDevice))
        let collection = BackendRepository(origin: AudienceFixture.origin, transport: collectionTransport, secrets: collectionSecrets, signer: AudienceSigner(), uploadFiles: privateFiles)
        _ = try await collection.bootstrap()
        await collectionTransport.setProjection(AudienceFixture.projection(band: "18_plus", status: "eligible", version: 1, enabled: true))
        await collectionTransport.strongProfile(.object(["error": .object(["code": .string("registered_face_session_invalid")])]), status: 401)
        var collected = false
        do { _ = try await collection.requirePhotoCollection(); collected = true } catch { }
        try require(!collected, "Eligible audience/registered credential must not open collection when strong authority is denied")
        let selected = NativeUploadSource(id: UUID().uuidString.lowercased(), file: selectedSource, title: "Synthetic selected photo", width: 10, height: 20)
        try await rejectsAsync("Strong denial must reject private file staging") { _ = try await collection.stagePhotoUpload([selected]) }
        try require(!FileManager.default.fileExists(atPath: privateFiles.root.path) && (try collectionSecrets.read("resumable-photo-batches-v1")) == nil, "Denied collection created no private staging files or batch journal")
        let collectionPaths = await collectionTransport.paths
        try require(collectionPaths.filter { $0 == "/me/profile" }.count == 2, "Both collection and stage independently checked strong product authority")
        _ = try await collection.audience(); _ = try await collection.protectedJSON("/privacy/center"); checks += 2
        try require(try collectionSecrets.read("credentials") != nil, "Privacy-only durable credential was incorrectly erased by strong collection denial")
        let validProfile: WireValue = .object(["user_id": .string(AudienceFixture.account), "name": .string("Synthetic adult"), "profile_scope": .string("registered_face_profile")])
        for (label, body, status) in [
            ("foreign account", AudienceFixture.changing(validProfile, "user_id", .string(AudienceFixture.other)), 200),
            ("weak profile scope", AudienceFixture.changing(validProfile, "profile_scope", .string("anonymous_enrollment")), 200),
            ("missing profile scope", AudienceFixture.changing(validProfile, "profile_scope", .null), 200),
            ("unexpected authority field", AudienceFixture.changing(validProfile, "authenticated", .bool(true)), 200),
            ("unverified name body", AudienceFixture.changing(validProfile, "name", .object([:])), 200),
            ("unexpected success status", validProfile, 201)
        ] {
            await collectionTransport.strongProfile(body, status: status)
            try await rejectsAsync("Collection rejects " + label) { _ = try await collection.requirePhotoCollection() }
        }
        await collectionTransport.strongProfile(validProfile)
        let collectionApproval = try await collection.requirePhotoCollection()
        try require(collectionApproval.accountID == AudienceFixture.account && collectionApproval.capabilities.photoProcessing, "Exact current strong profile permits collection guard")
        print("Native audience checks passed: \(checks). Controlled fixtures only; no hosted, camera or guardian-review acceptance.")
    }
}
