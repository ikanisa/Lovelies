import Foundation
import CryptoKit
import ImageIO

// Actual HTTP/process-rehydration consumer journey. Only host file-backed
// original-device-key/storage substitutes are used. The wrapper discards real successful
// replies to model response loss; it never replaces a server/model result.
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
}
private enum LiveJourneyFailure: Error, LocalizedError {
    case check(String)
    var errorDescription: String? { if case .check(let value) = self { return value }; return nil }
}
// PRIVATE host-only fixture vault. These files are outside public reports and
// contain no JPEGs. AES.GCM +0700/0600 fixture files exercise process persistence;
// this is not a Keychain or Secure Enclave implementation/qualification.
private final class LiveMemorySecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private let directory: URL?, encryptionKey: SymmetricKey?
    init() { directory = nil; encryptionKey = nil }
    init(privateDirectory: URL, create: Bool) throws {
        let manager = FileManager.default
        if !manager.fileExists(atPath: privateDirectory.path) {
            guard create else { throw LiveJourneyFailure.check("Private checkpoint vault is unavailable") }
            try manager.createDirectory(at: privateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let attributes = try manager.attributesOfItem(atPath: privateDirectory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700 else { throw LiveJourneyFailure.check("Private checkpoint directory permissions are not0700") }
        let keyURL = privateDirectory.appendingPathComponent("vault.key")
        let key: Data
        if manager.fileExists(atPath: keyURL.path) { key = try Self.privateRead(keyURL, maximum: 32) }
        else {
            guard create else { throw LiveJourneyFailure.check("Original fixture vault key is missing") }
            key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
            try key.write(to: keyURL, options: .atomic); try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyURL.path)
        }
        guard key.count == 32 else { throw LiveJourneyFailure.check("Fixture vault key size changed") }
        directory = privateDirectory; encryptionKey = SymmetricKey(data: key)
    }
    private static func privateRead(_ url: URL, maximum: Int) throws -> Data {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attrs[.type] as? FileAttributeType == .typeRegular,
              (attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              let size = (attrs[.size] as? NSNumber)?.intValue, (1...maximum).contains(size) else { throw LiveJourneyFailure.check("Private fixture file permissions/type/size changed") }
        return try Data(contentsOf: url)
    }
    private func file(_ name: String) throws -> URL {
        guard let directory, name.range(of: "^[a-z0-9-]{1,64}$", options: .regularExpression) != nil else { throw LiveJourneyFailure.check("Invalid private fixture slot") }
        return directory.appendingPathComponent(name + ".sealed")
    }
    func read(_ name: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard let encryptionKey else { return values[name] }
        let url = try file(name); guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let sealed = try Self.privateRead(url, maximum: 2 * 1024 * 1024 + 64)
        return try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: encryptionKey)
    }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        guard let encryptionKey else { values[name] = data; return }
        let url = try file(name)
        guard let data else { if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }; return }
        guard data.count <= 2 * 1024 * 1024, let sealed = try AES.GCM.seal(data, using: encryptionKey).combined else { throw LiveJourneyFailure.check("Private fixture slot too large") }
        try sealed.write(to: url, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func credential() throws -> NativeCredentials {
        guard let data = try read("credentials") else { throw LiveJourneyFailure.check("Missing current private credentials") }
        let value = try JSONDecoder().decode(NativeCredentials.self, from: data)
        guard value.expiresAt > Date() else { throw LiveJourneyFailure.check("Current fixture credentials expired") }; return value
    }
    func journal() throws -> NativeFaceLifecycleRecord {
        guard let data = try read("face-profile-lifecycle") else { throw LiveJourneyFailure.check("Production recovery journal is missing") }
        return try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: data)
    }
}
private final class LiveSoftwareSigner: NativeDeviceSigner, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: P256.Signing.PrivateKey] = [:]
    private let store: LiveMemorySecrets?, allowCreate: Bool
    init() { keys[NativeEnrollmentRecord.keyAlias] = P256.Signing.PrivateKey(); store = nil; allowCreate = true }
    init(store: LiveMemorySecrets, create: Bool) throws {
        self.store = store; allowCreate = create
        if let bytes = try store.read("device-keys") {
            let values = try JSONDecoder().decode([String: Data].self, from: bytes)
            guard values.count <= 20, !values.isEmpty else { throw LiveJourneyFailure.check("Original host software key map changed") }
            for (alias, data) in values { guard NativeAccountRecoveryRecord.validAlias(alias) else { throw LiveJourneyFailure.check("Unknown software key alias") }; keys[alias] = try P256.Signing.PrivateKey(rawRepresentation: data) }
        } else { guard create else { throw LiveJourneyFailure.check("Original software device keys are missing; replacement prohibited") } }
    }
    private func save() throws { if let store { try store.write("device-keys", data: JSONEncoder().encode(keys.mapValues(\.rawRepresentation))) } }
    private func activeAlias() throws -> String {
        if let store, let data = try store.read("registered-device") { return try JSONDecoder().decode(RegisteredDevice.self, from: data).keyAlias ?? NativeEnrollmentRecord.keyAlias }
        return NativeEnrollmentRecord.keyAlias
    }
    func publicJWK(alias: String, create: Bool) throws -> WireValue {
        lock.lock(); defer { lock.unlock() }
        guard NativeAccountRecoveryRecord.validAlias(alias) else { throw LiveJourneyFailure.check("Invalid private fixture alias") }
        if keys[alias] == nil && create && allowCreate { keys[alias] = P256.Signing.PrivateKey(); try save() }
        guard let key = keys[alias] else { throw LiveJourneyFailure.check("Original software device key unavailable") }
        let data = key.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(data.subdata(in: 1..<33).base64URL), "y": .string(data.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
    func sign(_ data: Data) throws -> String { try sign(data, alias: activeAlias()) }
    func sign(_ data: Data, alias: String) throws -> String { lock.lock(); defer { lock.unlock() }; guard let key = keys[alias] else { throw LiveJourneyFailure.check("Original software key missing") }; return try key.signature(for: data).rawRepresentation.base64URL }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func hasRetainedKey() throws -> Bool { lock.lock(); defer { lock.unlock() }; return store != nil && !keys.isEmpty }
    func clear() { if let alias = try? activeAlias() { clear(alias: alias) } }
    func clear(alias: String) { lock.lock(); defer { lock.unlock() }; keys[alias] = nil; try? save() }
    var jwk: WireValue { get throws { try publicJWK(alias: activeAlias(), create: true) } }
}
private struct LiveCheckpoint: Codable {
    let configHash: String, accountID: String, originalProfileID: String, originalRevision: String
    let deviceID: String, keyAlias: String, digest: String, handle: String
    var phase: String, operationKey: String?, challengeID: String?, captureHash: String?
}
// Every request reaches the ACTUAL transport/backend. Loss is injected only
// AFTER its actual successful reply, never synthesized success/identity/graph.
private actor DropRealReply: NativeTransport {
    private let actual = NativeURLTransport()
    private var armed: String?, dropped = false
    init(path: String?) { armed = path }
    nonisolated func cancelPending() {}
    func didDrop() -> Bool { dropped }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let reply = try await actual.send(request, limit: limit)
        if !dropped, let armed, request.url?.path == armed, (200..<300).contains(reply.status) {
            dropped = true; self.armed = nil; throw URLError(.timedOut)
        }
        return reply
    }
}
private struct LivePrincipal {
    let key: String, repository: BackendRepository, secrets: LiveMemorySecrets, signer: LiveSoftwareSigner, accountID: String
}
private struct LiveCheck: Codable { let name: String, status: String }
private struct LiveInputBinding: Codable { let path: String, sha256: String, bytes: Int }
private struct LiveRunReport: Codable {
    let schema: Int, verified_at: String, status: String, scope: String, process_phase: String
    let transport: String, model_authority: String, device_proof: String
    let checks: [LiveCheck], assertions_passed: Int
    let candidate_scope: String, candidate_pairs: Int?, approved_pairs: Int?, recipients: Int?
    let configuration: LiveInputBinding, inputs: [LiveInputBinding]
    let failure_stage: String?, failure_code: String?
    let does_not_establish: [String]
}
private struct LiveRequestPair: Hashable { let photo: String, recipient: String }

@main struct NativeFaceProfileLifecycleHTTPJourney {
    private static var processPhase = "configuration"
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
        let repository = BackendRepository(origin: endpoint, transport: NativeURLTransport(), secrets: secrets, signer: signer)
        guard let guest = try await repository.bootstrap() else { throw LiveJourneyFailure.check("Fresh account did not bootstrap anonymously") }
        try require(!guest.authenticated && guest.roles == ["user"], "Fresh anonymous authority must be ordinary and unauthenticated")
        let provisional = LivePrincipal(key: key, repository: repository, secrets: secrets, signer: signer, accountID: guest.accountID)
        let denial = try await raw("/community/action", origin: endpoint, principal: provisional, method: "POST", body: .object(["action": .string("photos"), "payload": .object(["source": .string("all")])]))
        try require(denial.status == 403, "Anonymous server gallery access must be denied")
        try await declareSyntheticAdult(repository, accountID: guest.accountID)
        let policy = try await repository.policy()
        let challenge = try await repository.startFace(consentPolicy: policy, publicKey: signer.jwk)
        try require(challenge.accountID == guest.accountID && challenge.purpose == "registration" && challenge.poses == ["front", "left", "right"], "Initial enrollment must bind three ordinary poses to the anonymous account")
        try require(account.selfies.count == 3, "Enrollment fixture must supply exactly three JPEGs")
        let bytes = try account.selfies.map { try jpeg($0, config: config, maximum: 8 * 1024 * 1024) }
        try require(Set(bytes.map(hash)).count == 3 && bytes.reduce(0, { $0 + $1.count }) <= 8 * 1024 * 1024, "Capture hashes must be distinct and bounded for one challenge")
        var receipts: [WireValue] = []
        for index in bytes.indices { receipts.append(try await repository.capture(bytes[index], index: index, challenge: challenge)) }
        let authenticated = try await repository.completeFace(challenge, captures: receipts)
        try require(authenticated.authenticated && authenticated.accountID == guest.accountID, "Backend must automatically upgrade the same account")
        let current = try await repository.current()
        try require(current["user_id"].string == guest.accountID && current["authenticated"].bool == true && current["auth_method"].string == "registered_face", "Current authenticated server authority must agree with native credentials")
        passed("Actual signed three-capture enrollment upgrades " + key + " without OTP")
        return provisional
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
    private static func runSharing(_ config: LiveFixtureConfig, endpoint: URL, owner: LivePrincipal) async throws {
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
        try await owner.repository.logout()
        let loggedOut = await owner.repository.summary()
        try require(loggedOut == nil && (try owner.secrets.read("credentials")) == nil, "Logout must retire session credentials")
        let policy = try await owner.repository.policy()
        let login = try await owner.repository.startFace(consentPolicy: policy, publicKey: owner.signer.jwk)
        try require(login.purpose == "login" && login.accountID == owner.accountID && login.poses == ["front"], "Retained opaque identity must challenge the original registered account")
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
    private static func checkpoint(_ store: LiveMemorySecrets) throws -> LiveCheckpoint {
        guard let data = try store.read("process-checkpoint") else { throw LiveJourneyFailure.check("Private original-account checkpoint is missing") }
        return try JSONDecoder().decode(LiveCheckpoint.self, from: data)
    }
    private static func saveCheckpoint(_ value: LiveCheckpoint, store: LiveMemorySecrets) throws { try store.write("process-checkpoint", data: JSONEncoder().encode(value)) }
    private static func assertOriginal(_ marker: LiveCheckpoint, store: LiveMemorySecrets, signer: LiveSoftwareSigner, endpoint: URL) throws {
        let record = try store.journal(); try record.validate(origin: endpoint)
        try require(record.accountID == marker.accountID && record.originalDevice.deviceID == marker.deviceID && record.originalDevice.faceHandle == marker.handle, "Lifecycle must retain original account/device/opaque handle across processes")
        try require(record.keyAlias == marker.keyAlias && record.publicKeyDigest == marker.digest && record.publicJWK == signer.publicJWK(alias: marker.keyAlias, create: false), "Original P256 alias/public-key digest cannot be replaced on restart")
        if let operation = marker.operationKey { try require(record.pending?.operationKey == operation, "Interrupted lifecycle operation retains original key") }
    }
    private static func expectRealLoss(_ transport: DropRealReply, _ body: () async throws -> Void) async throws {
        do { try await body() }
        catch NativeAPIError.unavailable { let dropped = await transport.didDrop(); try require(dropped, "Loss follows an actual successful backend response"); return }
        throw LiveJourneyFailure.check("Expected loss of an actual successful response did not occur")
    }
    private static func grantIndependentPurposes(_ principal: LivePrincipal, matching: Bool, processing: Bool) async throws {
        let value = try await principal.repository.protectedJSON("/me/photo-preferences"), policy = try value.text("policy_version")
        _ = try await principal.repository.post("/me/photo-preferences", payload: .object(["policy_version": .string(policy), "photo_matching_consent": .bool(matching), "receive_matches": .bool(matching), "processing_consent": .bool(processing)]), operation: "photo.preferences")
        let current = try await principal.repository.protectedJSON("/me/photo-preferences")
        try require(current["matching_enabled"].bool == matching && current["processing_enabled"].bool == processing && current["receive_matches"].bool == matching, "Photo matching, receiving and processing are separate explicit grants")
    }
    private static func obsoleteSessionDenied(_ data: Data, endpoint: URL) async throws {
        let credential = try JSONDecoder().decode(NativeCredentials.self, from: data)
        var request = URLRequest(url: endpoint.appendingPathComponent("me")); request.setValue("Bearer " + credential.access_token, forHTTPHeaderField: "Authorization")
        let result = try await NativeURLTransport().send(request, limit: 2 * 1024 * 1024)
        try require([401, 403].contains(result.status), "A terminal lifecycle change must revoke the actual obsolete account session")
    }
    private static func fullCapture(_ repository: BackendRepository, challenge: NativeFaceChallenge, paths: [String], config: LiveFixtureConfig) async throws -> [WireValue] {
        try require(paths.count == challenge.poses.count, "Fresh fixtures match actual capture count")
        let data = try paths.map { try jpeg($0, config: config, maximum: 8 * 1024 * 1024) }
        try require(Set(data.map(hash)).count == data.count && data.reduce(0, { $0 + $1.count }) <= 8 * 1024 * 1024, "One challenge has bounded distinct real JPEG proofs")
        var captures: [WireValue] = []
        for index in data.indices { captures.append(try await repository.capture(data[index], index: index, challenge: challenge)) }
        return captures
    }
    private static func phase(_ name: String, config: LiveFixtureConfig, endpoint: URL, directory: URL) async throws {
        processPhase = name; stage = "face-profile-checkpoint:" + name
        let manager = FileManager.default
        if !manager.fileExists(atPath: directory.path) { guard name == "owner" else { throw LiveJourneyFailure.check("Original private fixture root is missing") }; try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        let attrs = try manager.attributesOfItem(atPath: directory.path)
        try require(attrs[.type] as? FileAttributeType == .typeDirectory && (attrs[.posixPermissions] as? NSNumber)?.intValue == 0o700, "Fixture root remains a private0700 directory")
        let store = try LiveMemorySecrets(privateDirectory: directory.appendingPathComponent("owner"), create: name == "owner")
        let signer = try LiveSoftwareSigner(store: store, create: name == "owner")
        let transport = DropRealReply(path: name == "replace" ? "/auth/face/profile/challenge" : name == "complete" ? "/auth/face/profile/complete" : nil)
        let repository = BackendRepository(origin: endpoint, transport: transport, secrets: store, signer: signer)
        guard let configured else { throw LiveJourneyFailure.check("Frozen config unavailable") }
        if name == "owner" {
            try require((try store.read("process-checkpoint")) == nil && (try store.read("credentials")) == nil, "Owner phase requires a new isolated private vault")
            guard let anonymous = try await repository.bootstrap() else { throw LiveJourneyFailure.check("Actual anonymous-first bootstrap unavailable") }
            try require(!anonymous.authenticated && anonymous.roles == ["user"], "Owner begins ordinary anonymous with no role upgrade")
            try await declareSyntheticAdult(repository, accountID: anonymous.accountID)
            let policy = try await repository.policy(), challenge = try await repository.startFace(consentPolicy: policy, publicKey: signer.jwk)
            try require(challenge.accountID == anonymous.accountID && challenge.poses == ["front", "left", "right"], "Initial enrollment uses three signed ordinary poses on same account")
            let captures = try await fullCapture(repository, challenge: challenge, paths: config.owner.selfies, config: config)
            let authenticated = try await repository.completeFace(challenge, captures: captures)
            let device = try await repository.device()!
            try require(authenticated.accountID == anonymous.accountID && authenticated.authenticated && device.profileID != nil, "Actual face verification automatically upgrades the existing anonymous account")
            let owner = LivePrincipal(key: "lifecycle-owner", repository: repository, secrets: store, signer: signer, accountID: authenticated.accountID)
            try await grantIndependentPurposes(owner, matching: true, processing: true)
            let opened = try await repository.openFaceLifecycle(), record = try store.journal()
            try require(opened.metadata.profile?.id == device.profileID && record.originalDevice.deviceID == device.deviceID, "Management capability binds current original account/profile/device")
            _ = try await repository.createRecoveryKey()
            if let backup = try store.read("recovery-key-backup") { try store.write("before-lifecycle-backup", data: backup) }
            let paused = try await repository.faceProfileAction(.pause)
            try require(!paused.metadata.matchingEnabled && !paused.metadata.receiveMatches && paused.metadata.authenticationEnabled && paused.metadata.processingEnabled, "Actual pause withdraws only matching and receiving")
            let resumed = try await repository.faceProfileAction(.resume, consentPolicy: paused.metadata.photoPolicy)
            try require(resumed.metadata.matchingEnabled && resumed.metadata.receiveMatches && resumed.metadata.authenticationEnabled && resumed.metadata.processingEnabled && resumed.metadata.version > paused.metadata.version, "Actual resume creates a new explicit current-policy matching episode")
            let cancelling = try await repository.startFaceProfileCapture(.replace, consentPolicy: resumed.metadata.authPolicy)
            try require(cancelling.challenge?.purpose == "replacement" && cancelling.challenge?.poses.count == 3, "Replacement uses registered-reference comparison with three ordinary poses")
            let cancelled = try await repository.cancelFaceProfileCapture()
            try require(cancelled.operation?.serverState == "cancelled" && cancelled.receipts.isEmpty && cancelled.metadata.profile?.id == device.profileID && cancelled.metadata.authenticationEnabled, "Actual signed explicit cancel stops exact challenge while retaining original authority/profile")
            let marker = LiveCheckpoint(configHash: configured.sha256, accountID: authenticated.accountID, originalProfileID: device.profileID!, originalRevision: device.profileRevision!, deviceID: device.deviceID, keyAlias: record.keyAlias, digest: record.publicKeyDigest, handle: device.faceHandle, phase: "control-ready", operationKey: nil, challengeID: nil, captureHash: nil)
            try saveCheckpoint(marker, store: store)
            passed("Actual anonymous enrollment and original-key control manage independent pause/resume and signed capture cancellation")
            return
        }
        var marker = try checkpoint(store)
        try require(marker.configHash == configured.sha256, "Config/fixture hashes stay frozen across processes")
        let expected = ["replace": "control-ready", "capture": "replace-lost", "complete": "capture-lost", "finish": "completion-lost"]
        try require(expected[name] == marker.phase, "Lifecycle phases cannot run out of order or replay checkpoints")
        try assertOriginal(marker, store: store, signer: signer, endpoint: endpoint)
        let restored = try await repository.bootstrap()
        try assertOriginal(marker, store: store, signer: signer, endpoint: endpoint)
        if name == "replace" {
            try require(restored?.authenticated == true && restored?.accountID == marker.accountID, "Current original registered credentials remain valid before replacement")
            guard let old = try store.read("credentials") else { throw LiveJourneyFailure.check("Original session unavailable") }; try store.write("before-replacement-session", data: old)
            let current = try await repository.faceLifecycleSummary()!
            try await expectRealLoss(transport) { _ = try await repository.startFaceProfileCapture(.replace, consentPolicy: current.metadata.authPolicy) }
            let pending = try store.journal().pending!
            try require(pending.serverState == nil && pending.generation == 0 && pending.action == .replace, "Unacknowledged start remains original exact pre-dispatch journal")
            marker.operationKey = pending.operationKey; marker.phase = "replace-lost"; try saveCheckpoint(marker, store: store)
            passed("Actual replacement challenge committed; successful reply discarded; original key/account/operation survive process exit")
            return
        }
        try require(restored == nil, "Interrupted replacement/status cannot authenticate or create another account")
        let status = try await repository.faceLifecycleSummary()!
        if name == "capture" {
            let started = try await repository.startFaceProfileCapture(.replace, consentPolicy: status.metadata.authPolicy), challenge = started.challenge!
            try require(challenge.wire["profile_id"].string == marker.originalProfileID && challenge.wire["profile_revision"].string == marker.originalRevision && challenge.deviceID == marker.deviceID, "Recovered replacement challenge compares exact original reference/device")
            let loss = DropRealReply(path: "/auth/face/proof/" + challenge.id + "/0")
            let active = BackendRepository(origin: endpoint, transport: loss, secrets: store, signer: signer); _ = try await active.bootstrap()
            let again = try await active.startFaceProfileCapture(.replace, consentPolicy: status.metadata.authPolicy)
            try require(again.challenge?.id == challenge.id, "Production reconstruction retains usable original challenge")
            let bytes = try jpeg(config.owner.selfies[0], config: config, maximum: 8 * 1024 * 1024)
            try await expectRealLoss(loss) { _ = try await active.capture(bytes, index: 0, challenge: again.challenge!) }
            let pending = try store.journal().pending!
            try require(pending.captures.count == 1 && !pending.captures[0].accepted && pending.captures[0].sha256 == hash(bytes), "Lost actual capture keeps metadata ambiguous without storing JPEGs")
            marker.phase = "capture-lost"; marker.challengeID = challenge.id; marker.captureHash = hash(bytes); try saveCheckpoint(marker, store: store)
            passed("Actual original-key pose proof accepted; successful reply discarded; private journal survives separate process")
            return
        }
        if name == "complete" {
            let continued = try await repository.startFaceProfileCapture(.replace, consentPolicy: status.metadata.authPolicy), challenge = continued.challenge!
            try require(challenge.id == marker.challengeID && continued.receipts.count == 1 && continued.receipts[0]["sha256"].string == marker.captureHash, "Signed manifest reconstructs exactly accepted first proof")
            var receipts = continued.receipts
            for index in 1..<3 { receipts.append(try await repository.capture(jpeg(config.owner.selfies[index], config: config, maximum: 8 * 1024 * 1024), index: index, challenge: challenge)) }
            try await expectRealLoss(transport) { _ = try await repository.completeFace(challenge, captures: receipts) }
            let record = try store.journal(); try require(record.pending?.completionPending == true && record.promotionCredentials == nil, "Lost committed completion cannot fabricate received credentials")
            marker.phase = "completion-lost"; try saveCheckpoint(marker, store: store)
            passed("Actual three-reference comparison and derived replacement commit; successful credential reply discarded")
            return
        }
        guard name == "finish" else { throw LiveJourneyFailure.check("Unknown process phase") }
        try require(status.operation?.serverState == "completed" && status.metadata.profile?.id == marker.originalProfileID && status.metadata.profile?.revision != marker.originalRevision && status.challenge == nil && status.receipts.isEmpty && !status.authenticated, "Signed completed replacement updates current reference but grants no credentials")
        let fresh = try await repository.freshFaceProfileLogin(), login = fresh.challenge!
        try require(login.purpose == "login" && login.poses == ["front"] && login.deviceID == marker.deviceID && login.wire["profile_revision"].string == status.metadata.profile?.revision, "Lost completion requires one fresh ordinary selfie against current reference on original key")
        let freshProof = try await fullCapture(repository, challenge: login, paths: [config.owner.fresh_selfie], config: config)
        let authenticated = try await repository.completeFace(login, captures: freshProof)
        try require(authenticated.authenticated && authenticated.accountID == marker.accountID, "Exact current /me and active device validation restore original account after loss")
        if let old = try store.read("before-replacement-session") { try await obsoleteSessionDenied(old, endpoint: endpoint) }
        let owner = LivePrincipal(key: "lifecycle-owner", repository: repository, secrets: store, signer: signer, accountID: marker.accountID)
        if let old = try store.read("before-lifecycle-backup") {
            let backup = try JSONDecoder().decode(NativeRecoveryKeyRecord.self, from: old), reply = try await raw("/auth/face/recovery/key", origin: endpoint, principal: owner, method: "POST", body: backup.body)
            try require(reply.status == 401 && (try WireValue.decoded(reply.data))["error"]["code"].string == "account_recovery_unavailable", "Replacement revokes actual prior backup without historical-ready replay")
        }
        passed("Separate process observes actual committed replacement; fresh same-key login restores original account and old session/backup are revoked")
        stage = "authentication-withdrawal"
        guard let beforeWithdrawal = try store.read("credentials") else { throw LiveJourneyFailure.check("Current original session unavailable") }
        let withdrawn = try await repository.faceProfileAction(.withdrawAuthentication)
        try require(!withdrawn.metadata.authenticationEnabled && withdrawn.metadata.matchingEnabled && withdrawn.metadata.processingEnabled && withdrawn.metadata.profile != nil, "Actual authentication withdrawal retains reference only for current independently granted matching")
        let unavailable = await repository.summary(); try require(unavailable == nil && (try store.read("credentials")) == nil, "Withdrawal retires native account/gallery/credential publication")
        try await obsoleteSessionDenied(beforeWithdrawal, endpoint: endpoint)
        var protectedDenied = false
        do { _ = try await repository.protectedJSON("/me/photo-preferences") }
        catch NativeAPIError.authenticationRequired { protectedDenied = true }
        try require(protectedDenied, "Withdrawn account cannot use generic protected routes")
        let regrant = try await repository.startFaceProfileCapture(.restoreAuthentication, consentPolicy: withdrawn.metadata.authPolicy)
        try require(regrant.challenge?.purpose == "registration" && regrant.challenge?.poses == ["front"] && regrant.challenge?.wire["profile_id"].string == withdrawn.metadata.profile?.id, "Retained reference restoration uses one current explicit-consent comparison")
        let regrantProof = try await fullCapture(repository, challenge: regrant.challenge!, paths: [config.owner.fresh_selfie], config: config)
        let restoredAuth = try await repository.completeFace(regrant.challenge!, captures: regrantProof), restoredMeta = try await repository.faceLifecycleSummary()!
        try require(restoredAuth.accountID == marker.accountID && restoredMeta.metadata.matchingEnabled && restoredMeta.metadata.processingEnabled, "Restore preserves independent matching/processing without automatic purpose changes")
        passed("Actual withdrawal revokes credentials; explicit one-selfie restore compares retained reference and preserves separate purposes")
        stage = "private-reference-removal"
        let removed = try await repository.faceProfileAction(.remove)
        try require(!removed.metadata.authenticationEnabled && !removed.metadata.matchingEnabled && !removed.metadata.receiveMatches && removed.metadata.processingEnabled && removed.metadata.profile == nil, "Actual removal stops auth/matching/receive while account processing remains")
        var cleanup = try await repository.checkFaceLifecycle(); let deadline = Date().addingTimeInterval(45)
        while cleanup.metadata.removalState != "completed" && Date() < deadline { try await Task.sleep(for: .milliseconds(500)); cleanup = try await repository.checkFaceLifecycle() }
        try require(cleanup.metadata.removalState == "completed" && cleanup.metadata.profile == nil && !cleanup.authenticated, "Private reference cleanup is completed only by actual verified backend deletion")
        passed("Actual signed removal status confirms exact private-reference cleanup before any re-enrollment")
        stage = "same-account-re-enrollment"
        let enrolling = try await repository.startFaceProfileCapture(.enroll, consentPolicy: cleanup.metadata.authPolicy)
        try require(enrolling.challenge?.poses == ["front", "left", "right"] && enrolling.challenge?.deviceID == marker.deviceID && enrolling.challenge?.accountID == marker.accountID && enrolling.challenge?.wire["profile_id"] == .null, "Verified cleanup allows three ordinary poses on same account/key with no old-reference comparison claim")
        let reenrollmentProofs = try await fullCapture(repository, challenge: enrolling.challenge!, paths: config.owner.selfies, config: config)
        let reauthenticated = try await repository.completeFace(enrolling.challenge!, captures: reenrollmentProofs), next = try await repository.faceLifecycleSummary()!
        try require(reauthenticated.accountID == marker.accountID && reauthenticated.authenticated && next.metadata.profile != nil && next.metadata.profile?.id != marker.originalProfileID && !next.metadata.matchingEnabled && next.metadata.processingEnabled, "Re-enrollment preserves same account while creating a new confirmed reference and no automatic matching grant")
        let currentDevice = try await repository.device()!
        try require(currentDevice.deviceID == marker.deviceID && currentDevice.faceHandle == marker.handle && (currentDevice.keyAlias ?? NativeEnrollmentRecord.keyAlias) == marker.keyAlias && signer.publicJWK(alias: marker.keyAlias, create: false) == store.journal().publicJWK, "All actual lifecycle steps retain original registered device/key/handle")
        passed("Actual verified cleanup followed by three-selfie enrollment retains original account/key and separate consent")
        try await runSharing(config, endpoint: endpoint, owner: owner)
        marker.phase = "complete"; try saveCheckpoint(marker, store: store)
        passed("Original lifecycle-managed account completes exact candidate/exclusion/approval/private rendition/entitlement-denial journey")
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
        let value = LiveRunReport(schema: 1, verified_at: ISO8601DateFormatter().string(from: Date()), status: success ? "passed" : "failed", scope: scopeDescription, process_phase: processPhase,
            transport: "Actual BackendRepository and NativeURLTransport / URLSession to explicit loopback Lovelies API", model_authority: "Actual configured Lovelies API and private ML service; database, Storage and loaded engine identities are recorded separately by the runtime owner; no test verifier or processing replacement", device_proof: "Actual CryptoKit software P256 raw64 signature; original-device lifecycle control, exact action/challenge metadata and credentials retained in private encrypted0700/0600 host fixture files across separate processes; recipient stores in memory",
            checks: checks, assertions_passed: assertions, candidate_scope: strictIsolation ? "Complete isolated graph equality" : "Exact edges for principals created by this run; all other recipients excluded from final preview", candidate_pairs: candidateCount, approved_pairs: approvedCount, recipients: recipientCount,
            configuration: configured, inputs: bindings, failure_stage: success ? nil : stage, failure_code: failure.map(safeFailure), does_not_establish: ["iOS SDK app compilation or SwiftUI interaction", "Live camera input or sensor provenance", "Physical Keychain or Secure Enclave behavior", "Civil identity, liveness or camera attestation", "Hosted deployment, production store entitlement or release acceptance"])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let url = URL(fileURLWithPath: path); try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(value).write(to: url, options: .atomic)
    }
    static func main() async {
        let arguments = CommandLine.arguments
        guard arguments.count == 5, ["owner", "replace", "capture", "complete", "finish"].contains(arguments[3]) else { print("Usage: NativeFaceProfileLifecycleHTTPJourney <fixture-config.json> <PRIVATE-vault-directory> <owner|replace|capture|complete|finish> <result.json> (run each phase in a separate process from repository root)"); exit(2) }
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
            try await phase(arguments[3], config: config, endpoint: endpoint, directory: URL(fileURLWithPath: arguments[2], isDirectory: true))
            try report(arguments[4], success: true)
            print("Actual native face-profile lifecycle HTTP/process phase passed: \(checks.count) stages, \(assertions) assertions. Static fixtures; host SDK only.")
        } catch {
            try? report(arguments[4], success: false, failure: error)
            print("Actual native face-profile lifecycle HTTP/process phase failed at " + stage + ": " + safeFailure(error)); exit(1)
        }
    }
}
