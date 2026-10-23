import Foundation
import CryptoKit
import ImageIO

// Six actual processes use BackendRepository and actual HTTP. The trace wrapper
// drops four already accepted replies; it never replaces a server/model result.
// Host protected file storage/software keys substitute device Keychain/Enclave.
// Inputs are explicit static test JPEGs. This cannot qualify iOS UI, a camera,
// Keychain, Secure Enclave, civil identity, deployment or store release.
private struct UploadHTTPFixtureAccount: Decodable { let selfies: [String], fresh_selfie: String }
private struct UploadHTTPFixturePhoto: Decodable { let name: String, path: String, matches: [String] }
private struct UploadHTTPFixtureExclusion: Decodable { let photo: String, recipient: String }
private struct UploadHTTPFixtureFile: Decodable { let path: String, sha256: String, bytes: Int }
private struct UploadHTTPFixtureConfig: Decodable {
    let api_origin: String, scope: String
    let owner: UploadHTTPFixtureAccount
    let recipients: [String: UploadHTTPFixtureAccount]
    let photos: [UploadHTTPFixturePhoto]
    let exclusions: [UploadHTTPFixtureExclusion]
    let global_excluded_photos: [String]?
    let approved: [String: [String]]
    let files: [UploadHTTPFixtureFile]
    let strict_isolation: Bool?
    let camera_quality_recovery_selfies: [String]?
}
private enum UploadHTTPJourneyFailure: Error, LocalizedError {
    case check(String)
    var errorDescription: String? { if case .check(let value) = self { return value }; return nil }
}
private final class UploadHTTPMemorySecrets: NativeSecretStore, @unchecked Sendable {
    let root: URL
    init(root: URL) throws { self.root = root; try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path) }
    func read(_ name: String) throws -> Data? {
        guard name.range(of: "^[a-zA-Z0-9._-]{1,100}$", options: .regularExpression) != nil else { throw NativeAPIError.invalidResponse }
        let file = root.appendingPathComponent(name + ".private")
        return FileManager.default.fileExists(atPath: file.path) ? try Data(contentsOf: file) : nil
    }
    func write(_ name: String, data: Data?) throws {
        guard name.range(of: "^[a-zA-Z0-9._-]{1,100}$", options: .regularExpression) != nil else { throw NativeAPIError.invalidResponse }
        let file = root.appendingPathComponent(name + ".private")
        if let data { try data.write(to: file, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
        else if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
    func credential() throws -> NativeCredentials {
        guard let bytes = try read("credentials") else { throw NativeAPIError.authenticationRequired }
        return try JSONDecoder().decode(NativeCredentials.self, from: bytes)
    }
}
private struct UploadHTTPSoftwareSigner: NativeDeviceSigner, @unchecked Sendable {
    let privateKey: P256.Signing.PrivateKey
    let keyFile: URL
    init(root: URL, create: Bool) throws {
        let file = root.appendingPathComponent("device-key.private"); keyFile = file
        if FileManager.default.fileExists(atPath: file.path) { privateKey = try P256.Signing.PrivateKey(derRepresentation: Data(contentsOf: file)) }
        else { guard create else { throw NativeAPIError.invalidResponse }; privateKey = P256.Signing.PrivateKey() }
    }
    private func retainEnrollmentKey() throws {
        if !FileManager.default.fileExists(atPath: keyFile.path) { try privateKey.derRepresentation.write(to: keyFile, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyFile.path) }
    }
    func sign(_ data: Data) throws -> String { try retainEnrollmentKey(); return try privateKey.signature(for: data).rawRepresentation.base64URL }
    func sha256(_ data: Data) -> String { NativeUploadPrivateFiles.hash(data) }
    func clear() {}
    func hasRetainedKey() throws -> Bool { FileManager.default.fileExists(atPath: keyFile.path) }
    var jwk: WireValue {
        get throws {
        try retainEnrollmentKey()
        let data = privateKey.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(data.subdata(in: 1..<33).base64URL), "y": .string(data.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
        }
    }
}
private struct UploadHTTPTraceEvent: Codable {
    let method: String, path: String, offset: Int?, operationKey: String?, status: Int, interruptedReply: Bool
}
private final class UploadHTTPTraceTransport: NativeTransport, @unchecked Sendable {
    private let live = NativeURLTransport(), lock = NSLock(), trace: URL
    private var loss: String?
    init(trace: URL, loss: String? = nil) { self.trace = trace; self.loss = loss }
    func cancelPending() { live.cancelPending() }
    func record(_ request: URLRequest, reply: NativeHTTPReply) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        let path = request.url!.path
        let kind = path == "/uploads/session" ? "reserve" : path.hasSuffix("/chunks") ? "chunk" : path.hasSuffix("/complete") && path.hasPrefix("/uploads/") ? "complete" : path.hasSuffix("/cancel") ? "cancel" : nil
        let interrupt = kind != nil && loss == kind && (200..<300).contains(reply.status)
        if interrupt { loss = nil }
        guard path.hasPrefix("/uploads/") || path == "/auth/anonymous" else { return interrupt }
        var events = FileManager.default.fileExists(atPath: trace.path) ? try JSONDecoder().decode([UploadHTTPTraceEvent].self, from: Data(contentsOf: trace)) : []
        let offset = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "offset" })?.value.flatMap(Int.init)
        let key = request.httpBody.flatMap { try? WireValue.decoded($0) }?["operation_key"].string
        events.append(UploadHTTPTraceEvent(method: request.httpMethod ?? "GET", path: path, offset: offset, operationKey: key, status: reply.status, interruptedReply: interrupt))
        try JSONEncoder().encode(events).write(to: trace, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: trace.path)
        return interrupt
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let reply = try await live.send(request, limit: limit)
        if try record(request, reply: reply) { throw URLError(.networkConnectionLost) }
        return reply
    }
}
private struct UploadHTTPFileReplyLossTransport: NativeUploadFileTransport {
    let trace: UploadHTTPTraceTransport
    func send(_ request: URLRequest, file: URL, taskKey: String, limit: Int) async throws -> NativeHTTPReply {
        let reply = try await NativeFileURLUploadTransport.shared.send(request, file: file, taskKey: taskKey, limit: limit)
        if try trace.record(request, reply: reply) { throw URLError(.networkConnectionLost) }
        return reply
    }
    func cancel(batch: String) async { await NativeFileURLUploadTransport.shared.cancel(batch: batch) }
}
private struct UploadHTTPProcessState: Codable {
    let accountID: String, deviceID: String, keyDigest: String, batchID: String, largeFileID: String, reserveKey: String, completeKey: String, caption: String
    let photoNames: [String: String]
    var assetID: String?, photoIDs: [String: String] = [:], cancellationBatchID: String?
}
private struct UploadHTTPPrincipal {
    let key: String, repository: BackendRepository, secrets: UploadHTTPMemorySecrets, signer: UploadHTTPSoftwareSigner, accountID: String
}
private struct UploadHTTPCheck: Codable { let name: String, status: String }
private struct UploadHTTPInputBinding: Codable { let path: String, sha256: String, bytes: Int }
private struct UploadHTTPRunReport: Codable {
    let schema: Int, verified_at: String, status: String, scope: String
    let transport: String, model_authority: String, device_proof: String
    let checks: [UploadHTTPCheck], assertions_passed: Int
    let candidate_scope: String, candidate_pairs: Int?, approved_pairs: Int?, recipients: Int?
    let configuration: UploadHTTPInputBinding, inputs: [UploadHTTPInputBinding]
    let failure_stage: String?, failure_code: String?
    let does_not_establish: [String]
}
private struct UploadHTTPRequestPair: Hashable { let photo: String, recipient: String }

@main struct NativeUploadRecoveryHTTPJourney {
    private static var checks: [UploadHTTPCheck] = []
    private static var assertions = 0
    private static var stage = "configuration"
    private static var workspace = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    private static var bindings: [UploadHTTPInputBinding] = []
    private static var configured: UploadHTTPInputBinding?
    private static var scopeDescription = "Static reference fixtures over actual local Cloudflare HTTP"
    private static var candidateCount: Int?, approvedCount: Int?, recipientCount: Int?
    private static var strictIsolation = false
    private static var vaultRoot = URL(fileURLWithPath: "/unconfigured-upload-fixture")
    private static var processPhase = "unconfigured"
    private static var traceTransport: UploadHTTPTraceTransport!
    private static func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw UploadHTTPJourneyFailure.check(label) }; assertions += 1
    }
    private static func passed(_ name: String) { checks.append(UploadHTTPCheck(name: name, status: "passed")); print("native-http: " + name) }
    private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func jpeg(_ path: String, config: UploadHTTPFixtureConfig, maximum: Int) throws -> Data {
        guard let expected = config.files.first(where: { $0.path == path }), expected.bytes > 0, expected.bytes <= maximum else { throw UploadHTTPJourneyFailure.check("Fixture is missing from the frozen input list") }
        let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : workspace.appendingPathComponent(path)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard (attributes[.size] as? NSNumber)?.intValue == expected.bytes else { throw UploadHTTPJourneyFailure.check("Fixture byte count changed") }
        let data = try Data(contentsOf: url)
        guard data.count == expected.bytes, hash(data) == expected.sha256, data.starts(with: [0xff, 0xd8, 0xff]) else { throw UploadHTTPJourneyFailure.check("Fixture digest or JPEG declaration changed") }
        return data
    }
    private static func origin(_ value: String) throws -> URL {
        guard let url = URL(string: value), url.scheme == "http", ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host ?? ""), url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else { throw UploadHTTPJourneyFailure.check("An explicitly configured loopback HTTP API is required") }
        return url
    }
    private static func raw(_ path: String, origin: URL, principal: UploadHTTPPrincipal, method: String = "GET", body: WireValue? = nil, image: Bool = false) async throws -> NativeHTTPReply {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.host == origin.host, url.scheme == origin.scheme, url.port == origin.port else { throw UploadHTTPJourneyFailure.check("Private test request left the configured origin") }
        let credential = try principal.secrets.credential()
        guard credential.account_id == principal.accountID else { throw UploadHTTPJourneyFailure.check("Private request account changed") }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 20
        request.setValue("Bearer " + credential.access_token, forHTTPHeaderField: "Authorization")
        request.setValue(image ? "image/*" : "application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let body { request.httpBody = try body.encoded(); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return try await NativeURLTransport().send(request, limit: image ? 8 * 1024 * 1024 : 2 * 1024 * 1024)
    }
    private static func principal(_ key: String, endpoint: URL, create: Bool) async throws -> UploadHTTPPrincipal {
        let folder = vaultRoot.appendingPathComponent(key, isDirectory: true)
        let secrets = try UploadHTTPMemorySecrets(root: folder), signer = try UploadHTTPSoftwareSigner(root: folder, create: create)
        let repository = BackendRepository(origin: endpoint, transport: traceTransport, secrets: secrets, signer: signer,
            uploadFiles: NativeUploadPrivateFiles(root: folder.appendingPathComponent("staged", isDirectory: true)), uploadTransport: UploadHTTPFileReplyLossTransport(trace: traceTransport))
        guard let session = try await repository.bootstrap() else { throw UploadHTTPJourneyFailure.check("Expected original same-account session after restart") }
        if !create { try require(session.authenticated, "Restored face session must remain registered") }
        return UploadHTTPPrincipal(key: key, repository: repository, secrets: secrets, signer: signer, accountID: session.accountID)
    }
    private static func enroll(_ key: String, account: UploadHTTPFixtureAccount, config: UploadHTTPFixtureConfig, endpoint: URL) async throws -> UploadHTTPPrincipal {
        stage = "enrollment:" + key
        let principal = try await principal(key, endpoint: endpoint, create: true), repository = principal.repository
        let guest = await repository.summary()!
        try require(!guest.authenticated && guest.roles == ["user"], "Fresh accounts begin anonymous without OTP")
        let denial = try await raw("/community/action", origin: endpoint, principal: principal, method: "POST", body: .object(["action": .string("photos"), "payload": .object(["source": .string("all")])]))
        try require(denial.status == 403, "Anonymous server media authority is denied")
        let policy = try await repository.policy(), challenge = try await repository.startFace(consentPolicy: policy, publicKey: principal.signer.jwk)
        try require(challenge.accountID == guest.accountID && challenge.poses == ["front", "left", "right"] && account.selfies.count == 3, "Enrollment retains original anonymous account and exactly three ordinary captures")
        var receipts: [WireValue] = []
        for index in 0..<3 { receipts.append(try await repository.capture(jpeg(account.selfies[index], config: config, maximum: 8 * 1024 * 1024), index: index, challenge: challenge)) }
        let upgraded = try await repository.completeFace(challenge, captures: receipts)
        try require(upgraded.authenticated && upgraded.accountID == guest.accountID, "Actual registered-reference backend upgrades same account without OTP")
        passed("Actual signed three-capture enrollment upgrades " + key + " without OTP")
        return principal
    }
    private static func preferences(_ principal: UploadHTTPPrincipal, receive: Bool, config: UploadHTTPFixtureConfig) async throws {
        stage = "consent:" + principal.key
        let current = try await principal.repository.protectedJSON("/me/photo-preferences")
        let policy = try current.text("policy_version")
        _ = try await principal.repository.post("/me/photo-preferences", payload: .object(["policy_version": .string(policy), "photo_matching_consent": .bool(receive), "receive_matches": .bool(receive), "processing_consent": .bool(!receive)]), operation: "photo.preferences")
        let observed = try await principal.repository.protectedJSON("/me/photo-preferences")
        try require(observed["policy_version"].string == policy && observed["matching_enabled"].bool == receive && observed["receive_matches"].bool == receive && observed["processing_enabled"].bool == !receive, "Matching, processing and receiving purposes must be granted separately")
        passed("Separate current photo consent for " + principal.key)
    }
    private static func waitForProcessing(_ principal: UploadHTTPPrincipal, assets: [String]) async throws {
        stage = "real-photo-processing"
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            var ready = 0
            for id in assets {
                let state = try await principal.repository.protectedJSON("/uploads/" + id + "/status")
                try require(state["asset_id"].string == id && state["processing_creates_access"].bool == false, "Processing status must remain source-bound and cannot create access")
                if state["status"].string == "ready" { try require(state["candidates_ready"].bool == true, "Ready source must have real candidates evaluated"); ready += 1 }
                else if ["failed", "rejected", "erased", "unavailable"].contains(state["status"].string ?? "") { throw UploadHTTPJourneyFailure.check("Real photo processing failed instead of yielding a ready source") }
            }
            if ready == assets.count { passed("Actual queue/model processing publishes all fixture sources without grants"); return }
            try await Task.sleep(for: .seconds(1))
        }
        throw UploadHTTPJourneyFailure.check("Real photo processing exceeded its bounded wait")
    }
    private static func approvedPairs(_ config: UploadHTTPFixtureConfig, photoIDs: [String: String], principals: [String: UploadHTTPPrincipal]) throws -> Set<NativePair> {
        var result: Set<NativePair> = []
        for (key, photos) in config.approved {
            guard let principal = principals[key] else { throw UploadHTTPJourneyFailure.check("Unknown approved recipient alias") }
            for photo in photos { guard let id = photoIDs[photo] else { throw UploadHTTPJourneyFailure.check("Unknown approved photo alias") }; result.insert(NativePair(asset: id, recipient: principal.accountID)) }
        }
        return result
    }
    private static func wirePairs(_ value: WireValue) throws -> Set<NativePair> {
        guard let recipients = value["recipients"].array else { throw UploadHTTPJourneyFailure.check("Confirmed result omitted actual recipient subsets") }
        var pairs: Set<NativePair> = []
        for recipient in recipients {
            let id = try recipient.uuid("recipient_id")
            guard let photos = recipient["asset_ids"].array, photos.allSatisfy({ $0.string != nil }), recipient["photo_count"].integer == photos.count else { throw UploadHTTPJourneyFailure.check("Confirmed result subset count is inaccurate") }
            for photo in photos { let wire: WireValue = .object(["asset_id": photo, "recipient_id": .string(id)]); try require(pairs.insert(try NativePair(wire)).inserted, "Confirmed result cannot repeat a pair") }
        }
        return pairs
    }
    private static func assertPrivateDenied(_ photo: NativePhoto, principal: UploadHTTPPrincipal, endpoint: URL) async throws {
        let result = try await raw("/community/media/" + photo.id + "/preview", origin: endpoint, principal: principal, image: true)
        try require([403, 404].contains(result.status), "Private rendition must be denied by the real backend before or outside exact approval")
        do { _ = try await principal.repository.preview(photo) }
        catch NativeAPIError.denied(let status, _) where [403, 404].contains(status) { assertions += 1; return }
        throw UploadHTTPJourneyFailure.check("Native permission validation allowed an unapproved photo")
    }
    private static func assertRendition(_ photo: NativePhoto, principal: UploadHTTPPrincipal) async throws {
        let data = try await principal.repository.preview(photo)
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight as String] as? NSNumber else { throw UploadHTTPJourneyFailure.check("Approved protected bytes are not a decodable real rendition") }
        try require(!data.isEmpty && width.intValue == photo.width && height.intValue == photo.height, "Protected rendition pixels must match current server metadata")
    }
    private static func proveOriginalDenied(_ photo: NativePhoto, principal: UploadHTTPPrincipal) async throws {
        let entitlement = try await principal.repository.protectedJSON("/me/entitlements")
        try require(entitlement["pro_active"].bool == false && entitlement["download_photos"].bool == false, "Fixture must not acquire a fabricated store entitlement")
        do { _ = try await principal.repository.authorizedSaveBytes(photo) }
        catch NativeAPIError.denied(let status, let code) where status == 403 && code == "missing_entitlement" { assertions += 1; return }
        throw UploadHTTPJourneyFailure.check("Approved recipient original download bypassed the real entitlement gate")
    }
    private static func stateURL() -> URL { vaultRoot.appendingPathComponent("process-state.json") }
    private static func saveState(_ value: UploadHTTPProcessState) throws { try JSONEncoder().encode(value).write(to: stateURL(), options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL().path) }
    private static func loadState() throws -> UploadHTTPProcessState { try JSONDecoder().decode(UploadHTTPProcessState.self, from: Data(contentsOf: stateURL())) }
    private static func boundOwner(_ endpoint: URL, state: UploadHTTPProcessState) async throws -> UploadHTTPPrincipal {
        let owner = try await principal("owner", endpoint: endpoint, create: false), device = try await owner.repository.device()!
        try require(owner.accountID == state.accountID && device.deviceID == state.deviceID && hash(try owner.signer.jwk.canonical()) == state.keyDigest, "Process restart preserves original account, device and private signing key")
        return owner
    }
    private static func journal(_ principal: UploadHTTPPrincipal, id: String) throws -> NativeResumableUploadBatch {
        guard let bytes = try principal.secrets.read("resumable-photo-batches-v1"), let batch = try JSONDecoder().decode([NativeResumableUploadBatch].self, from: bytes).first(where: { $0.id == id }) else { throw UploadHTTPJourneyFailure.check("Original durable batch is missing") }; return batch
    }
    private static func expectInterrupted(_ work: () async throws -> Void) async throws {
        var rejected = false; do { try await work() } catch { rejected = true }
        try require(rejected, "The already committed actual HTTP reply must be interrupted before consumer acknowledgement")
    }
    private static func run(_ config: UploadHTTPFixtureConfig, endpoint: URL) async throws {
        if processPhase == "reserve" {
            try require(!FileManager.default.fileExists(atPath: stateURL().path), "Initial process requires fresh isolated host fixture storage")
            let owner = try await enroll("owner", account: config.owner, config: config, endpoint: endpoint)
            for key in config.recipients.keys.sorted() { let person = try await enroll(key, account: config.recipients[key]!, config: config, endpoint: endpoint); try await preferences(person, receive: true, config: config) }
            try await preferences(owner, receive: false, config: config)
            let incoming = vaultRoot.appendingPathComponent("incoming", isDirectory: true); try FileManager.default.createDirectory(at: incoming, withIntermediateDirectories: true)
            let ordered = config.photos.sorted { lhs, rhs in lhs.name == "P2" && rhs.name != "P2" ? true : rhs.name == "P2" && lhs.name != "P2" ? false : lhs.name < rhs.name }
            var sources: [NativeUploadSource] = [], names: [String: String] = [:]
            for photo in ordered {
                let bytes = try jpeg(photo.path, config: config, maximum: 20 * 1024 * 1024), id = UUID().uuidString.lowercased(), file = incoming.appendingPathComponent(id + ".jpg")
                try bytes.write(to: file, options: .atomic)
                guard let image = CGImageSourceCreateWithData(bytes as CFData, nil), let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [String: Any], let width = properties[kCGImagePropertyPixelWidth as String] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight as String] as? NSNumber else { throw UploadHTTPJourneyFailure.check("Declared actual source could not be decoded") }
                sources.append(NativeUploadSource(id: id, file: file, title: photo.name, width: width.intValue, height: height.intValue)); names[id] = photo.name
            }
            let batch = try await owner.repository.stagePhotoUpload(sources, caption: "Retained selection and caption across process restarts"), first = batch.batch.files[0], device = try await owner.repository.device()!
            try require(first.byteSize > 524288 && names[first.id] == "P2" && batch.batch.selectedFiles.count == 4, "First declared positive JPEG spans three chunks and all four sources remain selected")
            try saveState(UploadHTTPProcessState(accountID: owner.accountID, deviceID: device.deviceID, keyDigest: hash(try owner.signer.jwk.canonical()), batchID: batch.batch.id, largeFileID: first.id, reserveKey: first.reserveKey, completeKey: first.completeKey, caption: batch.batch.caption, photoNames: names))
            try FileManager.default.removeItem(at: incoming)
            try await expectInterrupted { _ = try await owner.repository.resumePhotoUpload(batchID: batch.batch.id) }
            let held = try journal(owner, id: batch.batch.id).files[0]
            try require(held.reserveDispatched && held.assetID == nil && held.reserveKey == first.reserveKey, "Lost committed reserve preserves exact original operation before unknown asset adoption")
            passed("Actual reserve committed then reply interrupted; original private batch, selection, caption and operation persist before process exit")
            return
        }
        var state = try loadState(); let owner = try await boundOwner(endpoint, state: state)
        let saved = try journal(owner, id: state.batchID)
        try require(saved.caption == state.caption && saved.files[0].id == state.largeFileID && saved.files[0].reserveKey == state.reserveKey && saved.files[0].completeKey == state.completeKey && Set(saved.selectedFiles.map(\.id)) == Set(state.photoNames.keys), "Every process restores the exact original batch and selected subset")
        if processPhase == "chunk" {
            let recovered = try await owner.repository.checkPhotoUpload(batchID: state.batchID), asset = recovered.batch.files[0].assetID!
            state.assetID = asset; try saveState(state)
            let paused = try await owner.repository.resumePhotoUpload(batchID: state.batchID, maximumChunks: 1)
            try require(paused.batch.files[0].assetID == asset && paused.batch.acknowledgedBytes == 262144 && !paused.batch.received && paused.batch.paused, "First durable accepted chunk and explicit pause are distinct from processing")
            passed("New process adopts original operation result, sends first accepted chunk and pauses at exactly 262144 bytes")
            return
        }
        if processPhase == "chunk-loss" {
            try await expectInterrupted { _ = try await owner.repository.resumePhotoUpload(batchID: state.batchID) }
            let held = try journal(owner, id: state.batchID).files[0]
            try require(held.assetID == state.assetID && held.acknowledgedBytes == 262144 && held.phase == .uploading, "Interrupted second chunk reply does not invent locally acknowledged progress")
            passed("Actual second chunk accepted then reply interrupted; existing asset and prior acknowledged progress survive process exit")
            return
        }
        if processPhase == "complete-loss" {
            let recovered = try await owner.repository.checkPhotoUpload(batchID: state.batchID)
            try require(recovered.batch.files[0].assetID == state.assetID && recovered.batch.acknowledgedBytes == 524288, "Current server status recovers actual second-chunk acceptance after process restart")
            try await expectInterrupted { _ = try await owner.repository.resumePhotoUpload(batchID: state.batchID) }
            let current = try await owner.repository.protectedJSON("/uploads/" + state.assetID! + "/status")
            try require(current["status"].string == "processing" || current["status"].string == "ready", "Interrupted original completion was actually committed by Cloudflare")
            passed("New process sends only remaining final bytes; original processing completion accepted before interrupted reply")
            return
        }
        if processPhase == "cancel-loss" {
            let recovered = try await owner.repository.checkPhotoUpload(batchID: state.batchID)
            try require(recovered.batch.files[0].assetID == state.assetID && recovered.batch.files[0].received, "Lost completion reconciles same uploaded file without sending bytes again")
            let complete = try await owner.repository.resumePhotoUpload(batchID: state.batchID)
            for file in complete.batch.selectedFiles { guard let asset = file.assetID, let name = state.photoNames[file.id] else { throw UploadHTTPJourneyFailure.check("Remaining source did not retain original metadata") }; state.photoIDs[name] = asset }
            try require(state.photoIDs.count == 4 && Set(state.photoIDs.values).count == 4 && state.photoIDs["P2"] == state.assetID, "Only original four intended assets become processing sources")
            try await waitForProcessing(owner, assets: Array(state.photoIDs.values)); _ = try await owner.repository.checkPhotoUpload(batchID: state.batchID)
            let large = config.photos.first(where: { $0.name == "P2" })!, bytes = try jpeg(large.path, config: config, maximum: 20 * 1024 * 1024)
            let incoming = vaultRoot.appendingPathComponent("cancel-import.jpg"); try bytes.write(to: incoming, options: .atomic)
            let pending = try await owner.repository.stagePhotoUpload([NativeUploadSource(id: UUID().uuidString.lowercased(), file: incoming, title: "Explicit pending cancellation fixture", width: 279, height: 428)])
            try FileManager.default.removeItem(at: incoming); state.cancellationBatchID = pending.batch.id; try saveState(state)
            _ = try await owner.repository.resumePhotoUpload(batchID: pending.batch.id, maximumChunks: 1)
            try await expectInterrupted { _ = try await owner.repository.cancelPhotoUpload(batchID: pending.batch.id) }
            let held = try journal(owner, id: pending.batch.id)
            try require(held.cancellationRequested && held.files[0].cancelDispatched, "Unknown cancellation retains original cancel operation durably")
            passed("Original four source uploads finish real processing; separate pending upload cancellation commits before interrupted reply and process exit")
            return
        }
        guard processPhase == "finish", let cancellation = state.cancellationBatchID else { throw UploadHTTPJourneyFailure.check("Unknown or out-of-order process phase") }
        let cancelled = try await owner.repository.cancelPhotoUpload(batchID: cancellation)
        try require(cancelled.batch.files[0].phase == .cancelled && cancelled.batch.cancellationRequested, "Restart recovers original cancellation without deleting completed photos")
        let events = try JSONDecoder().decode([UploadHTTPTraceEvent].self, from: Data(contentsOf: vaultRoot.appendingPathComponent("http-trace.json")))
        let original = "/uploads/" + state.assetID!
        try require(events.filter({ $0.path == original + "/chunks" }).compactMap(\.offset) == [0, 262144, 524288], "Original large file sends each remaining chunk exactly once across real process exits")
        try require(events.filter({ $0.path == "/uploads/session" && $0.operationKey == state.reserveKey }).count == 1 && events.filter({ $0.path == original + "/complete" && $0.operationKey == state.completeKey }).count == 1, "Lost committed operations never create duplicate reservation or processing")
        try require(events.filter({ $0.path == "/auth/anonymous" }).count == 3, "Six processes create only the original owner and two recipient accounts, with no replacement guest")
        try require(events.filter(\.interruptedReply).count == 4, "Four actual accepted HTTP replies were deliberately interrupted")
        passed("Six process phases preserve original account/key, immutable source identities, exact remaining-byte recovery and cancellation")
        var recipients: [String: UploadHTTPPrincipal] = [:]
        for key in config.recipients.keys.sorted() { recipients[key] = try await principal(key, endpoint: endpoint, create: false) }
        let photoIDs = state.photoIDs
        stage = "gallery-and-snapshot"
        let gallery = try await owner.repository.photos(source: "contributions")
        guard let galleryRows = gallery["items"].array else { throw UploadHTTPJourneyFailure.check("Native gallery metadata was unavailable") }
        let galleryPhotos = try galleryRows.map { try NativePhoto($0) }
        try require(Set(photoIDs.values).isSubset(of: Set(galleryPhotos.map(\.id))), "Native owner gallery must contain all actual uploaded sources")
        let snapshot = try await owner.repository.snapshot(assetIDs: config.photos.map { photoIDs[$0.name]! })
        try require(Set(snapshot.photos.map(\.id)) == Set(photoIDs.values), "Snapshot must retain exact requested sources")
        let configuredRecipientIDs = Set(recipients.values.map(\.accountID))
        var expectedCandidates: Set<NativePair> = []
        for photo in config.photos { for key in photo.matches { guard let person = recipients[key] else { throw UploadHTTPJourneyFailure.check("Unknown expected candidate alias") }; expectedCandidates.insert(NativePair(asset: photoIDs[photo.name]!, recipient: person.accountID)) } }
        let observedCandidates = snapshot.pairs.filter { configuredRecipientIDs.contains($0.recipient_id) }
        try require(observedCandidates == expectedCandidates && configuredRecipientIDs.isSubset(of: Set(snapshot.people.map(\.id))) && !snapshot.limited, "Actual model candidates for this run must exactly match frozen fixture expectations")
        if strictIsolation { try require(snapshot.pairs == expectedCandidates, "Fresh isolated server must contain no other matched principals") }
        candidateCount = observedCandidates.count; recipientCount = recipients.count
        passed("Actual gallery/snapshot contains expected real-model candidate graph")
        stage = "exclusions-and-final-review"
        var draft = NativeShareDraft(snapshot: snapshot)
        draft.selectedPeople = configuredRecipientIDs; draft.version += 1
        for alias in config.global_excluded_photos ?? [] {
            guard let photo = photoIDs[alias] else { throw UploadHTTPJourneyFailure.check("Unknown global photo-exclusion alias") }
            draft.selectedPhotos.remove(photo); draft.version += 1
        }
        for exclusion in config.exclusions {
            guard let photo = photoIDs[exclusion.photo], let person = recipients[exclusion.recipient] else { throw UploadHTTPJourneyFailure.check("Unknown pair-exclusion alias") }
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
        guard let committedRecipients = commit["recipients"].array else { throw UploadHTTPJourneyFailure.check("Commit omitted recipient requests") }
        var acceptedPairCount = 0
        for key in recipients.keys.sorted() {
            let principal = recipients[key]!, selected = approved.filter { $0.recipient_id == principal.accountID }
            guard let issued = committedRecipients.first(where: { $0["recipient_id"].string == principal.accountID }) else { throw UploadHTTPJourneyFailure.check("Commit omitted an approved recipient") }
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
            guard let rows = received["items"].array else { throw UploadHTTPJourneyFailure.check("Accepted received gallery omitted metadata") }
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
        stage = "complete"
    }
    private static func safeFailure(_ error: Error) -> String {
        if let failure = error as? UploadHTTPJourneyFailure { return failure.localizedDescription }
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
        guard let configured else { throw UploadHTTPJourneyFailure.check("Configuration could not be source-bound") }
        let value = UploadHTTPRunReport(schema: 1, verified_at: ISO8601DateFormatter().string(from: Date()), status: success ? "passed" : "failed", scope: scopeDescription,
            transport: "Actual BackendRepository and NativeURLTransport / URLSession to explicit loopback Cloudflare API", model_authority: "Root-owned actual workerd/SQLite/R2/Queue/private ML service; no test verifier or processing replacement", device_proof: "Actual retained CryptoKit software P256 raw64 signature; protected host file storage across six process phases, not device Keychain",
            checks: checks, assertions_passed: assertions, candidate_scope: strictIsolation ? "Complete isolated graph equality" : "Exact edges for principals created by this run; all other recipients excluded from final preview", candidate_pairs: candidateCount, approved_pairs: approvedCount, recipients: recipientCount,
            configuration: configured, inputs: bindings, failure_stage: success ? nil : stage, failure_code: failure.map(safeFailure), does_not_establish: ["iOS SDK app compilation or SwiftUI interaction", "UploadHTTP camera input or sensor provenance", "Physical Keychain or Secure Enclave behavior", "Civil identity, liveness or camera attestation", "Hosted deployment, production store entitlement or release acceptance"])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let url = URL(fileURLWithPath: path); try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(value).write(to: url, options: .atomic)
    }
    static func main() async {
        let arguments = CommandLine.arguments
        guard arguments.count == 5 else { print("Usage: NativeUploadRecoveryHTTPJourney <fixture-config.json> <private-vault-root> <reserve|chunk|chunk-loss|complete-loss|cancel-loss|finish> <result.json>"); exit(2) }
        let output = arguments[4]
        do {
            processPhase = arguments[3]; stage = processPhase; vaultRoot = URL(fileURLWithPath: arguments[2], isDirectory: true)
            guard ["reserve", "chunk", "chunk-loss", "complete-loss", "cancel-loss", "finish"].contains(processPhase) else { throw UploadHTTPJourneyFailure.check("Unknown recovery checkpoint") }
            try FileManager.default.createDirectory(at: vaultRoot, withIntermediateDirectories: true); try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: vaultRoot.path)
            let bytes = try Data(contentsOf: URL(fileURLWithPath: arguments[1])); configured = UploadHTTPInputBinding(path: arguments[1], sha256: hash(bytes), bytes: bytes.count)
            let config = try JSONDecoder().decode(UploadHTTPFixtureConfig.self, from: bytes); scopeDescription = config.scope + "; process phase " + processPhase; strictIsolation = config.strict_isolation ?? false
            try require(config.recipients.count == 2 && config.photos.count == 4 && Set(config.photos.map(\.name)).count == 4, "Declared fixture retains four photos and two recipients")
            bindings = config.files.map { UploadHTTPInputBinding(path: $0.path, sha256: $0.sha256, bytes: $0.bytes) }
            for file in config.files { _ = try jpeg(file.path, config: config, maximum: 20 * 1024 * 1024) }
            let loss: String? = processPhase == "reserve" ? "reserve" : processPhase == "chunk-loss" ? "chunk" : processPhase == "complete-loss" ? "complete" : processPhase == "cancel-loss" ? "cancel" : nil
            traceTransport = UploadHTTPTraceTransport(trace: vaultRoot.appendingPathComponent("http-trace.json"), loss: loss)
            try await run(config, endpoint: origin(config.api_origin))
            try report(output, success: true)
            print("Native resumable upload actual HTTP checkpoint passed: \(processPhase), \(assertions) assertions")
        } catch {
            try? report(output, success: false, failure: error)
            print("Native resumable upload actual HTTP checkpoint failed at " + stage + ": " + safeFailure(error)); exit(1)
        }
    }
}
