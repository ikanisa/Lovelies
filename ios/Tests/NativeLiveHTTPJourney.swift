import Foundation
import CryptoKit
import ImageIO

// Actual HTTP consumer journey. Only host device-key/storage substitutes are
// used; there is no replacement transport, server, verifier, processor or graph.
// Inputs are explicit static test JPEGs. This cannot qualify iOS UI, a camera,
// Keychain, Secure Enclave, civil identity, deployment or store release.
private struct LiveFixtureAccount: Decodable { let selfies: [String], fresh_selfie: String }
private struct LiveFixturePhoto: Decodable { let name: String, path: String, matches: [String] }
private struct LiveFixtureExclusion: Decodable { let photo: String, recipient: String }
private struct LiveFixtureFile: Decodable { let path: String, sha256: String, bytes: Int }
private struct LiveFixtureConfig: Decodable {
    let api_origin: String, scope: String
    let owner: LiveFixtureAccount
    let recipients: [String: LiveFixtureAccount]
    let photos: [LiveFixturePhoto]
    let exclusions: [LiveFixtureExclusion]
    let global_excluded_photos: [String]?
    let approved: [String: [String]]
    let files: [LiveFixtureFile]
    let strict_isolation: Bool?
    let camera_quality_recovery_selfies: [String]?
}
private enum LiveJourneyFailure: Error, LocalizedError {
    case check(String)
    var errorDescription: String? { if case .check(let value) = self { return value }; return nil }
}
private final class LiveMemorySecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; values[name] = data }
    func credential() throws -> NativeCredentials {
        guard let data = try read("credentials") else { throw LiveJourneyFailure.check("Missing current private credentials") }
        let value = try JSONDecoder().decode(NativeCredentials.self, from: data)
        guard value.expiresAt > Date() else { throw LiveJourneyFailure.check("Current fixture credentials expired") }
        return value
    }
}
private struct LiveSoftwareSigner: NativeDeviceSigner, @unchecked Sendable {
    let privateKey = P256.Signing.PrivateKey()
    func sign(_ data: Data) throws -> String { try privateKey.signature(for: data).rawRepresentation.base64URL }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
    var jwk: WireValue {
        let data = privateKey.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(data.subdata(in: 1..<33).base64URL), "y": .string(data.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
}
private struct LivePrincipal {
    let key: String, repository: BackendRepository, secrets: LiveMemorySecrets, signer: LiveSoftwareSigner, accountID: String
}
private struct LiveCheck: Codable { let name: String, status: String }
private struct LiveInputBinding: Codable { let path: String, sha256: String, bytes: Int }
private struct LiveRunReport: Codable {
    let schema: Int, verified_at: String, status: String, scope: String
    let transport: String, model_authority: String, device_proof: String
    let checks: [LiveCheck], assertions_passed: Int
    let candidate_scope: String, candidate_pairs: Int?, approved_pairs: Int?, recipients: Int?
    let configuration: LiveInputBinding, inputs: [LiveInputBinding]
    let failure_stage: String?, failure_code: String?
    let does_not_establish: [String]
}
private struct LiveRequestPair: Hashable { let photo: String, recipient: String }

/// Sends the actual request and drops one already committed reply. This changes
/// only what the native consumer observes, never the server/model verdict.
private actor LiveCameraReplyLossTransport: NativeTransport {
    private var loseFirstCapture = true
    nonisolated func cancelPending() {}
    func interruptNextCapture() { loseFirstCapture = true }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let reply = try await NativeURLTransport().send(request, limit: limit)
        if loseFirstCapture, request.httpMethod == "PUT", request.url?.path.hasPrefix("/auth/face/proof/") == true, (200..<300).contains(reply.status) {
            loseFirstCapture = false; throw URLError(.networkConnectionLost)
        }
        return reply
    }
}

@main struct NativeLiveHTTPJourney {
    private static var checks: [LiveCheck] = []
    private static var assertions = 0
    private static var stage = "configuration"
    private static var workspace = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    private static var bindings: [LiveInputBinding] = []
    private static var configured: LiveInputBinding?
    private static var scopeDescription = "Static reference fixtures over actual local Lovelies HTTP"
    private static var candidateCount: Int?, approvedCount: Int?, recipientCount: Int?
    private static var strictIsolation = false
    private static func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw LiveJourneyFailure.check(label) }; assertions += 1
    }
    private static func passed(_ name: String) { checks.append(LiveCheck(name: name, status: "passed")); print("native-http: " + name) }
    private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func jpeg(_ path: String, config: LiveFixtureConfig, maximum: Int) throws -> Data {
        guard let expected = config.files.first(where: { $0.path == path }), expected.bytes > 0, expected.bytes <= maximum else { throw LiveJourneyFailure.check("Fixture is missing from the frozen input list") }
        let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : workspace.appendingPathComponent(path)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard (attributes[.size] as? NSNumber)?.intValue == expected.bytes else { throw LiveJourneyFailure.check("Fixture byte count changed") }
        let data = try Data(contentsOf: url)
        guard data.count == expected.bytes, hash(data) == expected.sha256, data.starts(with: [0xff, 0xd8, 0xff]) else { throw LiveJourneyFailure.check("Fixture digest or JPEG declaration changed") }
        return data
    }
    private static func origin(_ value: String) throws -> URL {
        guard let url = URL(string: value), url.scheme == "http", ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host ?? ""), url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else { throw LiveJourneyFailure.check("An explicitly configured loopback HTTP API is required") }
        return url
    }
    private static func raw(_ path: String, origin: URL, principal: LivePrincipal, method: String = "GET", body: WireValue? = nil, image: Bool = false) async throws -> NativeHTTPReply {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.host == origin.host, url.scheme == origin.scheme, url.port == origin.port else { throw LiveJourneyFailure.check("Private test request left the configured origin") }
        let credential = try principal.secrets.credential()
        guard credential.account_id == principal.accountID else { throw LiveJourneyFailure.check("Private request account changed") }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 20
        request.setValue("Bearer " + credential.access_token, forHTTPHeaderField: "Authorization")
        request.setValue(image ? "image/*" : "application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let body { request.httpBody = try body.encoded(); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return try await NativeURLTransport().send(request, limit: image ? 8 * 1024 * 1024 : 2 * 1024 * 1024)
    }
    /// These declared engineering accounts represent adults; admission still uses
    /// the public, journaled production operation on the original anonymous account.
    private static func declareSyntheticAdult(_ repository: BackendRepository, accountID: String) async throws {
        let unknown = try await repository.audience()
        try require(unknown.accountID == accountID && unknown.ageBand == .unknown && unknown.status == .unknown && unknown.version == 0 && !unknown.capabilities.any, "Fresh synthetic account remains undeclared before explicit public admission")
        let adult = try await repository.declareAudience(.adult, expectedVersion: 0)
        try require(adult.accountID == accountID && adult.ageBand == .adult && adult.status == .eligible && adult.version == 1 && adult.policyVersion == NativeAudienceProjection.policy && adult.guardianRequest == nil, "Explicit synthetic adult declaration returns the current eligible projection for the same account")
        try adult.require(.faceAuthentication)
        try adult.require(.photoMatching)
        try adult.require(.photoProcessing)
        let pending = try await repository.pendingAudienceMutation()
        try require(pending == nil, "Acknowledged public audience operation retires its original durable mutation journal")
        let session = await repository.summary()
        try require(session?.accountID == accountID && session?.authenticated == false, "Audience admission neither replaces the anonymous account nor authenticates it")
    }
    private static func enroll(_ key: String, account: LiveFixtureAccount, config: LiveFixtureConfig, endpoint: URL) async throws -> LivePrincipal {
        stage = "enrollment:" + key
        let signer = LiveSoftwareSigner(), secrets = LiveMemorySecrets()
        let exerciseCameraRecovery = key == "owner" && config.camera_quality_recovery_selfies != nil
        let transport: NativeTransport = exerciseCameraRecovery ? LiveCameraReplyLossTransport() : NativeURLTransport()
        var repository = BackendRepository(origin: endpoint, transport: transport, secrets: secrets, signer: signer)
        guard let guest = try await repository.bootstrap() else { throw LiveJourneyFailure.check("Fresh account did not bootstrap anonymously") }
        try require(!guest.authenticated && guest.roles == ["user"], "Fresh anonymous authority must be ordinary and unauthenticated")
        let provisional = LivePrincipal(key: key, repository: repository, secrets: secrets, signer: signer, accountID: guest.accountID)
        let denial = try await raw("/community/action", origin: endpoint, principal: provisional, method: "POST", body: .object(["action": .string("photos"), "payload": .object(["source": .string("all")])]))
        try require(denial.status == 403, "Anonymous server gallery access must be denied")
        try await declareSyntheticAdult(repository, accountID: guest.accountID)
        let policy = try await repository.policy()
        var challenge = try await repository.startFace(consentPolicy: policy, publicKey: signer.jwk)
        try require(challenge.accountID == guest.accountID && challenge.purpose == "registration" && challenge.poses == ["front", "left", "right"], "Initial enrollment must bind three ordinary poses to the anonymous account")
        try require(challenge.wire["protocol"].string == "lovelies-face-auth-v1" && challenge.wire["maximum_capture_bytes"].integer == 8 * 1024 * 1024 && challenge.expiresAt > Date() && challenge.expiresAt <= Date().addingTimeInterval(125), "Integrated private engine retains the native still protocol, exact 8 MiB bound and short server challenge horizon")
        try require(account.selfies.count == 3, "Enrollment fixture must supply exactly three JPEGs")
        if exerciseCameraRecovery {
            stage = "camera-quality-recovery"
            guard let paths = config.camera_quality_recovery_selfies, paths.count == 3 else { throw LiveJourneyFailure.check("Quality recovery requires three distinct declared negative JPEGs") }
            let invalidSelfies = try paths.map { try jpeg($0, config: config, maximum: 8 * 1024 * 1024) }
            try require(Set(invalidSelfies.map(hash)).count == 3, "Negative sequence still respects distinct signed captures")
            let camera = NativeCameraAuthority()
            try require(camera.start(permission: .denied, foreground: true) == nil && !camera.snapshot.ready, "Camera permission policy holds denied capture before any signed upload")
            let initialized = camera.start(permission: .authorized, foreground: true)!
            try require(camera.didStart(initialized, running: true), "Current allowed initialization opens the test policy gate")
            var review = try NativeSelfieCandidate(bytes: invalidSelfies[0], challenge: challenge, index: 0, publicationGeneration: 1, sessionEpoch: guest.epoch, cameraGeneration: camera.snapshot.generation)
            review.retire()
            let unsent = try await repository.enrollmentSummary()!
            try require(review.bytes.isEmpty && unsent.receipts.isEmpty, "Retaking local review sends no bytes and advances no signed manifest")
            var interruptedReview = try NativeSelfieCandidate(bytes: invalidSelfies[0], challenge: challenge, index: 0, publicationGeneration: 2, sessionEpoch: guest.epoch, cameraGeneration: camera.snapshot.generation)
            try interruptedReview.requireCurrent(challenge: challenge, receipts: [], publicationGeneration: 2, sessionEpoch: guest.epoch, camera: camera.snapshot, foreground: true)
            var lost = false
            do { _ = try await repository.capture(interruptedReview.bytes, index: 0, challenge: challenge) }
            catch NativeAPIError.unavailable { lost = true }
            interruptedReview.retire()
            try require(lost, "Actual proof accepted, reply intentionally interrupted for consumer")
            let reconciled = try await repository.prepareFaceRetake(challenge, terminalQualityFailure: false)
            try require(reconciled.challenge?.id == challenge.id && reconciled.receipts.count == 1 && !reconciled.awaitingServer && reconciled.receipts[0]["sha256"].string == hash(invalidSelfies[0]), "Signed recovery retains exact accepted first capture after interrupted response")
            var replayDenied = false
            do { _ = try await repository.capture(invalidSelfies[1], index: 0, challenge: challenge) }
            catch { replayDenied = true }
            try require(replayDenied, "Accepted signed index cannot be overwritten by a retake")
            var negativeReceipts = reconciled.receipts
            for index in 1..<3 {
                var candidate = try NativeSelfieCandidate(bytes: invalidSelfies[index], challenge: challenge, index: index, publicationGeneration: index + 1, sessionEpoch: guest.epoch, cameraGeneration: camera.snapshot.generation)
                try candidate.requireCurrent(challenge: challenge, receipts: negativeReceipts, publicationGeneration: index + 1, sessionEpoch: guest.epoch, camera: camera.snapshot, foreground: true)
                negativeReceipts.append(try await repository.capture(candidate.bytes, index: index, challenge: challenge)); candidate.retire()
            }
            var rejected = false
            do { _ = try await repository.completeFace(challenge, captures: negativeReceipts) }
            catch { rejected = NativeFaceQualityFailure.from(error) == .noFace }
            try require(rejected, "Actual private model rejects three no-face captures with terminal quality code")
            let unchangedGuest = await repository.summary()
            try require(unchangedGuest?.accountID == guest.accountID && unchangedGuest?.authenticated == false, "Quality rejection preserves original anonymous authority and never reports verified")
            let recovered = try await repository.prepareFaceRetake(challenge, terminalQualityFailure: true)
            guard let successor = recovered.challenge else { throw LiveJourneyFailure.check("Explicit rejected-sequence recovery did not return a current same-device challenge") }
            try require(successor.id != challenge.id && successor.accountID == challenge.accountID && successor.deviceID == challenge.deviceID && successor.wire["public_key_digest"] == challenge.wire["public_key_digest"] && successor.wire["enrollment_key"] == challenge.wire["enrollment_key"] && successor.wire["enrollment_generation"].integer == (challenge.wire["enrollment_generation"].integer ?? 0) + 1 && recovered.receipts.isEmpty, "Rejected terminal sequence requires three fresh same-account/key captures and a signed successor")
            challenge = successor
            passed("Actual interrupted capture reconciles immutable prefix; no-face verdict and explicit signed successor preserve original anonymous account/key")
        }
        let bytes = try account.selfies.map { try jpeg($0, config: config, maximum: 8 * 1024 * 1024) }
        try require(Set(bytes.map(hash)).count == 3 && bytes.reduce(0, { $0 + $1.count }) <= 8 * 1024 * 1024, "Capture hashes must be distinct and bounded for one challenge")
        var receipts: [WireValue] = []
        let capturePolicy = NativeCameraAuthority(), captureStart = capturePolicy.start(permission: .authorized, foreground: true)!
        _ = capturePolicy.didStart(captureStart, running: true)
        for index in bytes.indices {
            var candidate = try NativeSelfieCandidate(bytes: bytes[index], challenge: challenge, index: index, publicationGeneration: index + 1, sessionEpoch: guest.epoch, cameraGeneration: capturePolicy.snapshot.generation)
            try candidate.requireCurrent(challenge: challenge, receipts: receipts, publicationGeneration: index + 1, sessionEpoch: guest.epoch, camera: capturePolicy.snapshot, foreground: true)
            receipts.append(try await repository.capture(candidate.bytes, index: index, challenge: challenge)); candidate.retire()
        }
        try require(receipts.count == 3 && receipts.enumerated().allSatisfy({ $0.element["index"].integer == $0.offset && $0.element["mime"].string == "image/jpeg" && $0.element["sha256"].string == hash(bytes[$0.offset]) && $0.element["byte_size"].integer == bytes[$0.offset].count }), "Signed still receipts retain exact submitted JPEG bytes, order and length through private inference")
        let authenticated = try await repository.completeFace(challenge, captures: receipts)
        try require(authenticated.authenticated && authenticated.accountID == guest.accountID, "Backend must automatically upgrade the same account")
        let current = try await repository.current()
        try require(current["user_id"].string == guest.accountID && current["authenticated"].bool == true && current["auth_method"].string == "registered_face", "Current authenticated server authority must agree with native credentials")
        passed("Actual signed three-capture enrollment upgrades " + key + " without OTP")
        if exerciseCameraRecovery {
            stage = "ordinary-camera-interruption"
            let originalDevice = try await repository.device()!
            try await repository.logout()
            let login = try await repository.startFace(consentPolicy: policy, publicKey: signer.jwk)
            guard let interrupted = transport as? LiveCameraReplyLossTransport else { throw LiveJourneyFailure.check("Expected real HTTP reply-loss wrapper") }
            await interrupted.interruptNextCapture()
            var lost = false
            do { _ = try await repository.capture(try jpeg(account.fresh_selfie, config: config, maximum: 8 * 1024 * 1024), index: 0, challenge: login) }
            catch NativeAPIError.unavailable { lost = true }
            try require(lost, "Actual ordinary registered-reference selfie reply was interrupted after proof acceptance")
            repository = BackendRepository(origin: endpoint, transport: transport, secrets: secrets, signer: signer)
            let restored = try await repository.bootstrap(), held = try await repository.ordinaryLoginSummary()!
            try require(restored == nil && held.awaitingServer && held.challenge.id == login.id && held.challenge.accountID == guest.accountID && held.challenge.deviceID == originalDevice.deviceID, "Repository restart restores original generic login hold without new authority")
            var premature = false
            do { _ = try await repository.prepareFaceRetake(login, terminalQualityFailure: false) }
            catch NativeAPIError.operationUnconfirmed { premature = true }
            try require(premature, "Unknown ordinary proof cannot be resent or replaced before actual challenge expiry")
            passed("Actual ordinary proof reply loss survives repository reconstruction and holds the same account/device/key until its real challenge deadline")
            while Date() <= login.expiresAt { try await Task.sleep(for: .milliseconds(500)) }
            let retake = try await repository.prepareFaceRetake(login, terminalQualityFailure: false)
            guard let fresh = retake.challenge else { throw LiveJourneyFailure.check("Expired ordinary proof did not offer an explicit fresh challenge") }
            try require(fresh.id != login.id && fresh.accountID == guest.accountID && fresh.deviceID == originalDevice.deviceID && fresh.wire["profile_id"].string == originalDevice.profileID && retake.receipts.isEmpty, "Only real expiry allows a new signed selfie against the same original reference")
            let receipt = try await repository.capture(try jpeg(account.fresh_selfie, config: config, maximum: 8 * 1024 * 1024), index: 0, challenge: fresh)
            let recovered = try await repository.completeFace(fresh, captures: [receipt]), currentDevice = try await repository.device()!
            try require(recovered.authenticated && recovered.accountID == guest.accountID && currentDevice.deviceID == originalDevice.deviceID && currentDevice.keyAlias == originalDevice.keyAlias && currentDevice.faceHandle == originalDevice.faceHandle && (try secrets.read("ordinary-face-login-journal")) == nil, "Fresh backend comparison plus current active-device validation clears original generic login hold without account/key replacement")
            passed("Actual challenge expiry and fresh same-key comparison recover ordinary authentication before approved sharing")
        }
        return LivePrincipal(key: key, repository: repository, secrets: secrets, signer: signer, accountID: guest.accountID)
    }
    private static func preferences(_ principal: LivePrincipal, receive: Bool, config: LiveFixtureConfig) async throws {
        stage = "consent:" + principal.key
        let current = try await principal.repository.protectedJSON("/me/photo-preferences")
        let policy = try current.text("policy_version")
        _ = try await principal.repository.post("/me/photo-preferences", payload: .object(["policy_version": .string(policy), "photo_matching_consent": .bool(receive), "receive_matches": .bool(receive), "processing_consent": .bool(!receive)]), operation: "photo.preferences")
        let observed = try await principal.repository.protectedJSON("/me/photo-preferences")
        try require(observed["policy_version"].string == policy && observed["matching_enabled"].bool == receive && observed["receive_matches"].bool == receive && observed["processing_enabled"].bool == !receive, "Matching, processing and receiving purposes must be granted separately")
        passed("Separate current photo consent for " + principal.key)
    }
    private static func waitForProcessing(_ principal: LivePrincipal, assets: [String]) async throws {
        stage = "real-photo-processing"
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            var ready = 0
            for id in assets {
                let state = try await principal.repository.protectedJSON("/uploads/" + id + "/status")
                try require(state["asset_id"].string == id && state["processing_creates_access"].bool == false, "Processing status must remain source-bound and cannot create access")
                if state["status"].string == "ready" { try require(state["candidates_ready"].bool == true, "Ready source must have real candidates evaluated"); ready += 1 }
                else if ["failed", "rejected", "erased", "unavailable"].contains(state["status"].string ?? "") { throw LiveJourneyFailure.check("Real photo processing failed instead of yielding a ready source") }
            }
            if ready == assets.count { passed("Actual queue/model processing publishes all fixture sources without grants"); return }
            try await Task.sleep(for: .seconds(1))
        }
        throw LiveJourneyFailure.check("Real photo processing exceeded its bounded wait")
    }
    private static func approvedPairs(_ config: LiveFixtureConfig, photoIDs: [String: String], principals: [String: LivePrincipal]) throws -> Set<NativePair> {
        var result: Set<NativePair> = []
        for (key, photos) in config.approved {
            guard let principal = principals[key] else { throw LiveJourneyFailure.check("Unknown approved recipient alias") }
            for photo in photos { guard let id = photoIDs[photo] else { throw LiveJourneyFailure.check("Unknown approved photo alias") }; result.insert(NativePair(asset: id, recipient: principal.accountID)) }
        }
        return result
    }
    private static func wirePairs(_ value: WireValue) throws -> Set<NativePair> {
        guard let recipients = value["recipients"].array else { throw LiveJourneyFailure.check("Confirmed result omitted actual recipient subsets") }
        var pairs: Set<NativePair> = []
        for recipient in recipients {
            let id = try recipient.uuid("recipient_id")
            guard let photos = recipient["asset_ids"].array, photos.allSatisfy({ $0.string != nil }), recipient["photo_count"].integer == photos.count else { throw LiveJourneyFailure.check("Confirmed result subset count is inaccurate") }
            for photo in photos { let wire: WireValue = .object(["asset_id": photo, "recipient_id": .string(id)]); try require(pairs.insert(try NativePair(wire)).inserted, "Confirmed result cannot repeat a pair") }
        }
        return pairs
    }
    private static func assertPrivateDenied(_ photo: NativePhoto, principal: LivePrincipal, endpoint: URL) async throws {
        let result = try await raw("/community/media/" + photo.id + "/preview", origin: endpoint, principal: principal, image: true)
        try require([403, 404].contains(result.status), "Private rendition must be denied by the real backend before or outside exact approval")
        do { _ = try await principal.repository.preview(photo) }
        catch NativeAPIError.denied(let status, _) where [403, 404].contains(status) { assertions += 1; return }
        throw LiveJourneyFailure.check("Native permission validation allowed an unapproved photo")
    }
    private static func assertRendition(_ photo: NativePhoto, principal: LivePrincipal) async throws {
        let data = try await principal.repository.preview(photo)
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight as String] as? NSNumber else { throw LiveJourneyFailure.check("Approved protected bytes are not a decodable real rendition") }
        try require(!data.isEmpty && width.intValue == photo.width && height.intValue == photo.height, "Protected rendition pixels must match current server metadata")
    }
    private static func proveOriginalDenied(_ photo: NativePhoto, principal: LivePrincipal) async throws {
        let entitlement = try await principal.repository.protectedJSON("/me/entitlements")
        try require(entitlement["pro_active"].bool == false && entitlement["download_photos"].bool == false, "Fixture must not acquire a fabricated store entitlement")
        do { _ = try await principal.repository.authorizedSaveBytes(photo) }
        catch NativeAPIError.denied(let status, let code) where status == 403 && code == "missing_entitlement" { assertions += 1; return }
        throw LiveJourneyFailure.check("Approved recipient original download bypassed the real entitlement gate")
    }
    private static func run(_ config: LiveFixtureConfig, endpoint: URL) async throws {
        let owner = try await enroll("owner", account: config.owner, config: config, endpoint: endpoint)
        var recipients: [String: LivePrincipal] = [:]
        for key in config.recipients.keys.sorted() { recipients[key] = try await enroll(key, account: config.recipients[key]!, config: config, endpoint: endpoint) }
        try require(Set(recipients.values.map(\.accountID)).count == recipients.count && !recipients.values.contains(where: { $0.accountID == owner.accountID }), "Ordinary test principals must remain isolated accounts")
        try await preferences(owner, receive: false, config: config)
        for key in recipients.keys.sorted() { try await preferences(recipients[key]!, receive: true, config: config) }
        stage = "source-upload"
        let batch = UUID().uuidString.lowercased(); var photoIDs: [String: String] = [:]
        for source in config.photos {
            let data = try jpeg(source.path, config: config, maximum: 20 * 1024 * 1024)
            photoIDs[source.name] = try await owner.repository.upload(data, mime: "image/jpeg", title: "Native HTTP fixture", batch: batch, localID: UUID().uuidString.lowercased())
        }
        try require(Set(photoIDs.values).count == config.photos.count, "Uploads must yield distinct authoritative source IDs")
        try await waitForProcessing(owner, assets: Array(photoIDs.values))
        stage = "gallery-and-snapshot"
        let gallery = try await owner.repository.photos(source: "contributions")
        guard let galleryRows = gallery["items"].array else { throw LiveJourneyFailure.check("Native gallery metadata was unavailable") }
        let galleryPhotos = try galleryRows.map { try NativePhoto($0) }
        try require(Set(photoIDs.values).isSubset(of: Set(galleryPhotos.map(\.id))), "Native owner gallery must contain all actual uploaded sources")
        let snapshot = try await owner.repository.snapshot(assetIDs: config.photos.map { photoIDs[$0.name]! })
        try require(Set(snapshot.photos.map(\.id)) == Set(photoIDs.values), "Snapshot must retain exact requested sources")
        let configuredRecipientIDs = Set(recipients.values.map(\.accountID))
        var expectedCandidates: Set<NativePair> = []
        for photo in config.photos { for key in photo.matches { guard let person = recipients[key] else { throw LiveJourneyFailure.check("Unknown expected candidate alias") }; expectedCandidates.insert(NativePair(asset: photoIDs[photo.name]!, recipient: person.accountID)) } }
        let observedCandidates = snapshot.pairs.filter { configuredRecipientIDs.contains($0.recipient_id) }
        try require(observedCandidates == expectedCandidates && configuredRecipientIDs.isSubset(of: Set(snapshot.people.map(\.id))) && !snapshot.limited, "Actual model candidates for this run must exactly match frozen fixture expectations")
        if strictIsolation { try require(snapshot.pairs == expectedCandidates, "Fresh isolated server must contain no other matched principals") }
        candidateCount = observedCandidates.count; recipientCount = recipients.count
        passed("Actual gallery/snapshot contains expected real-model candidate graph")
        stage = "exclusions-and-final-review"
        var draft = NativeShareDraft(snapshot: snapshot)
        draft.selectedPeople = configuredRecipientIDs; draft.version += 1
        for alias in config.global_excluded_photos ?? [] {
            guard let photo = photoIDs[alias] else { throw LiveJourneyFailure.check("Unknown global photo-exclusion alias") }
            draft.selectedPhotos.remove(photo); draft.version += 1
        }
        for exclusion in config.exclusions {
            guard let photo = photoIDs[exclusion.photo], let person = recipients[exclusion.recipient] else { throw LiveJourneyFailure.check("Unknown pair-exclusion alias") }
            let pair = NativePair(asset: photo, recipient: person.accountID)
            try require(snapshot.pairs.contains(pair), "Pair exclusion must refer to an actual eligible match")
            draft.excludedPairs.insert(pair); draft.version += 1
        }
        let retainedExclusions = draft.excludedPairs
        if let photo = draft.selectedPhotos.sorted().last {
            draft.selectedPhotos.remove(photo); draft.version += 1
            try require(!draft.effective(snapshot).contains(where: { $0.asset_id == photo }), "Global photo exclusion must remove that photo for every recipient")
            draft.selectedPhotos.insert(photo); draft.version += 1
        }
        if let person = recipients.values.map(\.accountID).sorted().last {
            draft.selectedPeople.remove(person); draft.version += 1
            try require(!draft.effective(snapshot).contains(where: { $0.recipient_id == person }), "Global recipient exclusion must remove that recipient from every photo")
            draft.selectedPeople.insert(person); draft.version += 1
        }
        let approved = try approvedPairs(config, photoIDs: photoIDs, principals: recipients)
        try require(draft.excludedPairs == retainedExclusions && draft.effective(snapshot) == approved && !approved.isEmpty, "Editing global selections must retain pair-only exclusions and exact final subsets")
        let preview = try await owner.repository.previewShare(snapshot, draft: draft)
        try require(preview.pairs == approved && preview.draftVersion == draft.version, "Server final preview must verify the exact approved graph")
        approvedCount = approved.count
        passed("Global/pair exclusions and final server preview preserve exact recipient subsets")
        for principal in recipients.values { for photo in snapshot.photos { try await assertPrivateDenied(photo, principal: principal, endpoint: endpoint) } }
        passed("Actual private rendition endpoint denies all recipients before approval")
        stage = "explicit-sharing-commit"
        let commit = try await owner.repository.commit(preview, snapshot: snapshot, draft: draft)
        try require(commit["status"].string == "pending_acceptance" && commit["grants_created"].integer == 0, "Sharing submission cannot claim delivery or create preacceptance grants")
        let committedPairs = try wirePairs(commit)
        try require(committedPairs == approved, "Commit must retain each exact approved subset without an extra recipient")
        let operationKey = try commit.text("operation_key")
        let replay = try await owner.repository.community("operation", payload: .object(["operation_key": .string(operationKey)]))
        let replayPairs = try wirePairs(replay)
        try require(replay["status"].string == "pending_acceptance" && replay["grants_created"].integer == 0 && replayPairs == approved, "Original-key operation reconciliation must preserve exact pending approval")
        passed("Explicit commit and original-key receipt remain pending with zero grants")
        stage = "recipient-acceptance"
        guard let committedRecipients = commit["recipients"].array else { throw LiveJourneyFailure.check("Commit omitted recipient requests") }
        var acceptedPairCount = 0
        for key in recipients.keys.sorted() {
            let principal = recipients[key]!, selected = approved.filter { $0.recipient_id == principal.accountID }
            guard let issued = committedRecipients.first(where: { $0["recipient_id"].string == principal.accountID }) else { throw LiveJourneyFailure.check("Commit omitted an approved recipient") }
            let requestID = try issued.uuid("request_id")
            let inbox = try await principal.repository.community("inbox", payload: .object([:]))
            try require(inbox["items"].array?.contains(where: { $0["id"].string == requestID && $0["status"].string == "requested" }) == true, "Actual recipient inbox must contain the pending request")
            let pending = try await principal.repository.community("receipt", payload: .object(["request_id": .string(requestID)]))
            try require(pending["sender"].bool == false && pending["asset_ids"].array?.isEmpty == true && pending["available_count"].integer == 0 && pending["photo_count"].integer == selected.count, "Pending recipient receipt must disclose counts without photo access")
            for photo in snapshot.photos { try await assertPrivateDenied(photo, principal: principal, endpoint: endpoint) }
            let accepted = try await principal.repository.decide(requestID, decision: "accept")
            try require(accepted["status"].string == "accepted" && accepted["available_count"].integer == selected.count, "Actual recipient acceptance must release its exact approved count")
            acceptedPairCount += selected.count
            let receipt = try await principal.repository.community("receipt", payload: .object(["request_id": .string(requestID)]))
            try require(Set(receipt["asset_ids"].array?.compactMap(\.string) ?? []) == Set(selected.map(\.asset_id)) && receipt["available_count"].integer == selected.count, "Accepted receipt must reveal only the exact approved subset")
            let received = try await principal.repository.photos(source: "received")
            guard let rows = received["items"].array else { throw LiveJourneyFailure.check("Accepted received gallery omitted metadata") }
            let receivedPhotos = try rows.map { try NativePhoto($0) }
            try require(Set(receivedPhotos.map(\.id)) == Set(selected.map(\.asset_id)), "Actual received gallery must contain no unapproved photo")
            for photo in snapshot.photos {
                if selected.contains(where: { $0.asset_id == photo.id }) { try await assertRendition(photo, principal: principal) }
                else { try await assertPrivateDenied(photo, principal: principal, endpoint: endpoint) }
            }
            if let photo = snapshot.photos.first(where: { selected.contains(NativePair(asset: $0.id, recipient: principal.accountID)) }) { try await proveOriginalDenied(photo, principal: principal) }
            let inBetween = try await owner.repository.community("operation", payload: .object(["operation_key": .string(operationKey)]))
            let currentPairs = try wirePairs(inBetween)
            try require(currentPairs == approved && inBetween["grants_created"].integer == acceptedPairCount && inBetween["status"].string == (acceptedPairCount == approved.count ? "access_available" : "partial"), "Partial and completed acceptance must retain the original manifest and actual grant counts")
            passed("Actual acceptance/private preview/excluded-photo/original entitlement fences for " + key)
        }
        let final = try await owner.repository.community("operation", payload: .object(["operation_key": .string(operationKey)]))
        let finalPairs = try wirePairs(final)
        try require(final["status"].string == "access_available" && final["grants_created"].integer == approved.count && finalPairs == approved, "Final server result must report only actual approved access after acceptance")
        passed("Final original-key result confirms only current approved access")
        stage = "fresh-reference-authentication"
        guard let registeredDevice = try await owner.repository.device() else { throw LiveJourneyFailure.check("Current registered reference is unavailable") }
        try await owner.repository.logout()
        let loggedOut = await owner.repository.summary()
        try require(loggedOut == nil && (try owner.secrets.read("credentials")) == nil, "Logout must retire session credentials")
        let policy = try await owner.repository.policy()
        let login = try await owner.repository.startFace(consentPolicy: policy, publicKey: owner.signer.jwk)
        try require(login.purpose == "login" && login.accountID == owner.accountID && login.poses == ["front"], "Retained opaque identity must challenge the original registered account")
        try require(login.deviceID == registeredDevice.deviceID && login.wire["profile_id"].string == registeredDevice.profileID && login.wire["profile_revision"].string == registeredDevice.profileRevision && login.wire["model_id"].string == registeredDevice.modelID && login.wire["policy_version"].string == policy, "Returning comparison binds the exact retained device/profile/model and current policy without an OpenFace account")
        let fresh = try jpeg(config.owner.fresh_selfie, config: config, maximum: 8 * 1024 * 1024)
        let capture = try await owner.repository.capture(fresh, index: 0, challenge: login)
        let restored = try await owner.repository.completeFace(login, captures: [capture])
        try require(restored.authenticated && restored.accountID == owner.accountID, "Fresh registered-reference comparison must restore the original account")
        var envelope = login.deviceEnvelope(); envelope["step"] = .string("complete"); envelope["capture_manifest"] = .array([capture])
        let reused = try await raw("/auth/face/complete", origin: endpoint, principal: owner, method: "POST", body: .object(["challenge_id": .string(login.id), "device_signature": .string(try owner.signer.sign(WireValue.object(envelope).canonical()))]))
        try require([401, 409].contains(reused.status), "Consumed capture challenge must reject an exact signed replay")
        let stillCurrent = try await owner.repository.current()
        try require(stillCurrent["authenticated"].bool == true && stillCurrent["user_id"].string == owner.accountID, "Replay rejection cannot switch or replace the current account")
        passed("Actual logout/fresh comparison restores same account and consumes one-use challenge")
        stage = "complete"
    }
    private static func safeFailure(_ error: Error) -> String {
        if let failure = error as? LiveJourneyFailure { return failure.localizedDescription }
        if let failure = error as? NativeAPIError {
            switch failure {
            case .denied(let status, let code): return "native_http_denied_\(status):" + (code.range(of: "^[a-zA-Z0-9_.:-]{1,100}$", options: .regularExpression) != nil ? code : "unclassified")
            case .unavailable: return "native_connection_unavailable"
            case .operationUnconfirmed: return "native_original_operation_unconfirmed"
            case .sessionChanged: return "native_session_changed"
            case .authenticationRequired: return "native_authentication_required"
            case .reviewChanged: return "native_review_changed"
            default: return "native_contract_rejected"
            }
        }
        return "host_fixture_or_transport_error"
    }
    private static func report(_ path: String, success: Bool, failure: Error? = nil) throws {
        guard let configured else { throw LiveJourneyFailure.check("Configuration could not be source-bound") }
        let value = LiveRunReport(schema: 1, verified_at: ISO8601DateFormatter().string(from: Date()), status: success ? "passed" : "failed", scope: scopeDescription,
            transport: "Actual BackendRepository and NativeURLTransport / URLSession to explicit loopback Lovelies API", model_authority: "Actual configured Lovelies API and private ML service; database, Storage and loaded engine identities are recorded separately by the runtime owner; no test verifier or processing replacement", device_proof: "Actual CryptoKit software P256 raw64 signature; in-memory credential storage on macOS host",
            checks: checks, assertions_passed: assertions, candidate_scope: strictIsolation ? "Complete isolated graph equality" : "Exact edges for principals created by this run; all other recipients excluded from final preview", candidate_pairs: candidateCount, approved_pairs: approvedCount, recipients: recipientCount,
            configuration: configured, inputs: bindings, failure_stage: success ? nil : stage, failure_code: failure.map(safeFailure), does_not_establish: ["iOS SDK app compilation or SwiftUI interaction", "Live camera input or sensor provenance", "Physical Keychain or Secure Enclave behavior", "Civil identity, liveness or camera attestation", "Hosted deployment, production store entitlement or release acceptance"])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let url = URL(fileURLWithPath: path); try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(value).write(to: url, options: .atomic)
    }
    static func main() async {
        let arguments = CommandLine.arguments
        guard arguments.count == 3 else { print("Usage: NativeLiveHTTPJourney <fixture-config.json> <result.json> (run from repository root)"); exit(2) }
        do {
            let configURL = URL(fileURLWithPath: arguments[1]), bytes = try Data(contentsOf: configURL)
            configured = LiveInputBinding(path: arguments[1], sha256: hash(bytes), bytes: bytes.count)
            let config = try JSONDecoder().decode(LiveFixtureConfig.self, from: bytes); scopeDescription = config.scope; strictIsolation = config.strict_isolation ?? false
            try require(!config.scope.isEmpty && config.recipients.count >= 2 && config.photos.count >= 3 && Set(config.photos.map(\.name)).count == config.photos.count, "Frozen fixture scenario needs at least two isolated recipients and three real sources")
            try require(Set(config.approved.keys) == Set(config.recipients.keys) && config.approved.values.allSatisfy({ !$0.isEmpty }), "Every fixture recipient must have an explicit nonempty approved subset")
            try require(Set(config.files.map(\.path)).count == config.files.count, "Frozen input paths must be unique")
            bindings = config.files.map { LiveInputBinding(path: $0.path, sha256: $0.sha256, bytes: $0.bytes) }
            for file in config.files { _ = try jpeg(file.path, config: config, maximum: 20 * 1024 * 1024) }
            let endpoint = try origin(config.api_origin)
            try await run(config, endpoint: endpoint)
            try report(arguments[2], success: true)
            print("Actual native HTTP journey passed: \(checks.count) stages, \(assertions) assertions. Static fixtures; host SDK only.")
        } catch {
            try? report(arguments[2], success: false, failure: error)
            print("Actual native HTTP journey failed at " + stage + ": " + safeFailure(error)); exit(1)
        }
    }
}
