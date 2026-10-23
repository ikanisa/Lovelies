import Foundation
import CryptoKit

// Controlled failure, storage and protocol fixtures. These do not establish
// URLSession daemon scheduling, iOS UI, physical Keychain or real recognition.
private final class UploadSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock(); private var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; values[name] = data }
    func journal() throws -> [NativeResumableUploadBatch] { try JSONDecoder().decode([NativeResumableUploadBatch].self, from: read("resumable-photo-batches-v1")!) }
}
private struct UploadSigner: NativeDeviceSigner {
    let key = P256.Signing.PrivateKey()
    func sign(_ data: Data) throws -> String { try key.signature(for: data).rawRepresentation.base64URL }
    func sha256(_ data: Data) -> String { NativeUploadPrivateFiles.hash(data) }
    func clear() {}
    func hasRetainedKey() throws -> Bool { true }
}
private actor UploadFixture: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000091", device = "00000000-0000-4000-8000-000000000092"
    struct Asset { var reservation: WireValue, status = "uploading", offset = 0, bytes = Data(), attempt: String? = nil }
    private var assets: [String: Asset] = [:], operations: [String: WireValue] = [:]
    private var lose: String?, wrongDevice = false, consent = true, corrupted: String?
    private(set) var posts: [String: [String]] = [:], chunks: [Int] = [], paths: [String] = []
    private var accountID = UploadFixture.account
    nonisolated func cancelPending() {}
    func loseNext(_ value: String) { lose = value }
    func deviceMismatch() { wrongDevice = true }
    func denyConsent() { consent = false }
    func corrupt(_ value: String?) { corrupted = value }
    func useAccount(_ value: String) { accountID = value }
    func setStatus(_ asset: String, _ status: String, attempt: Bool = false) { assets[asset]!.status = status; if attempt { assets[asset]!.attempt = UUID().uuidString.lowercased() } }
    func counts() -> (reserves: Int, completes: Int, cancels: Int) { (posts["reserve", default: []].count, posts["complete", default: []].count, posts["cancel", default: []].count) }
    private func reply(_ value: WireValue, _ status: Int = 200) throws -> NativeHTTPReply { NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try value.encoded()) }
    private func state(_ id: String) -> WireValue {
        let asset = assets[id]!; var value = asset.reservation.object!
        value["status"] = .string(asset.status); value["bytes_received"] = .integer(asset.offset)
        value["attempt_id"] = asset.attempt.map(WireValue.string) ?? .null
        value["cleanup_pending"] = .bool(asset.status == "cancelled"); value["assembly_pending"] = .bool(false)
        value["error_code"] = asset.status == "failed" ? .string("fixture_terminal_failure") : .null
        if corrupted == "digest" { value["checksum_sha256"] = .string(String(repeating: "f", count: 64)) }
        if corrupted == "regression" { value["bytes_received"] = .integer(0) }
        if corrupted == "source" { value["source"] = .string("professional") }
        return .object(value)
    }
    private func maybeLose(_ kind: String) throws { if lose == kind { lose = nil; throw URLError(.networkConnectionLost) } }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        let body = request.httpBody.flatMap { try? WireValue.decoded($0) } ?? .null
        if path == "/me" { return try reply(.object(["user_id": .string(accountID), "authenticated": .bool(true), "auth_method": .string("registered_face")])) }
        if path == "/me/devices" { return try reply(.object(["items": .array([.object(["id": .string(wrongDevice ? UUID().uuidString.lowercased() : Self.device), "current": .bool(true), "status": .string("active")])])])) }
        if path == "/me/photo-preferences" { return try reply(.object(["processing_consent": .bool(consent), "policy_version": .string("fixture-v1")])) }
        if path == "/auth/logout" { return try reply(.object(["status": .string("logged_out")])) }
        if path == "/community/action", body["action"].string == "operation" { return try reply(operations[try body["payload"].text("operation_key")] ?? .object(["status": .string("unknown")])) }
        if path == "/uploads/session" {
            let key = try body.text("operation_key"); posts["reserve", default: []].append(key)
            if let previous = operations[key] { return try reply(previous, 201) }
            let id = UUID().uuidString.lowercased(), version = UUID().uuidString.lowercased()
            let expiry = ISO8601DateFormatter().string(from: Date().addingTimeInterval(604800))
            let value: WireValue = .object(["asset_id": .string(id), "version": .string(version), "source": .string("personal"), "status": .string("uploading"),
                "resumable": .bool(true), "maximum_chunk_bytes": .integer(262144), "bytes_received": .integer(0), "byte_size": body["byte_size"],
                "checksum_sha256": body["checksum_sha256"], "content_type": body["content_type"], "upload_batch_id": body["upload_batch_id"], "expires_at": .string(expiry),
                "processing_creates_access": .bool(false), "upload_url": .string("/uploads/" + id), "complete_url": .string("/uploads/" + id + "/complete"), "chunk_url": .string("/uploads/" + id + "/chunks")])
            assets[id] = Asset(reservation: value); operations[key] = value; try maybeLose("reserve"); return try reply(value, 201)
        }
        let parts = path.split(separator: "/"); guard parts.count == 3, parts[0] == "uploads", var asset = assets[String(parts[1])] else { throw NativeAPIError.invalidResponse }
        let id = String(parts[1]), action = String(parts[2])
        if action == "status" { return try reply(state(id)) }
        if action == "chunks" {
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!, offset = Int(components.queryItems!.first!.value!)!, bytes = request.httpBody!
            guard asset.status == "uploading", offset == asset.offset, bytes.count <= 262144,
                  NativeUploadPrivateFiles.hash(bytes) == request.value(forHTTPHeaderField: "X-Lovelies-Chunk-SHA256") else { throw NativeAPIError.invalidResponse }
            chunks.append(offset); asset.bytes.append(bytes); asset.offset += bytes.count
            if asset.offset == asset.reservation["byte_size"].integer {
                guard NativeUploadPrivateFiles.hash(asset.bytes) == asset.reservation["checksum_sha256"].string else { throw NativeAPIError.invalidResponse }; asset.status = "uploaded"
            }
            assets[id] = asset; try maybeLose("chunk")
            return try reply(.object(["asset_id": .string(id), "version": asset.reservation["version"], "status": .string(asset.status), "bytes_received": .integer(asset.offset), "byte_size": asset.reservation["byte_size"]]))
        }
        if action == "complete" {
            let key = try body.text("operation_key"); posts["complete", default: []].append(key)
            if let previous = operations[key] { return try reply(previous) }
            guard ["uploaded", "failed"].contains(asset.status), asset.offset == asset.reservation["byte_size"].integer else { throw NativeAPIError.invalidResponse }
            asset.status = "processing"; asset.attempt = UUID().uuidString.lowercased(); assets[id] = asset
            let value: WireValue = .object(["asset_id": .string(id), "version": asset.reservation["version"], "status": .string("processing"), "attempt_id": .string(asset.attempt!)])
            operations[key] = value; try maybeLose("complete"); return try reply(value, 202)
        }
        if action == "cancel" {
            let key = try body.text("operation_key"); posts["cancel", default: []].append(key)
            if let previous = operations[key] { return try reply(previous) }
            guard ["uploading", "uploaded"].contains(asset.status) else { return try reply(.object(["error": .object(["code": .string("upload_already_processing")])]), 409) }
            asset.status = "cancelled"; assets[id] = asset; let value = state(id); operations[key] = value
            try maybeLose("cancel"); return try reply(value)
        }
        throw NativeAPIError.invalidResponse
    }
}
private actor UploadEarlyCancelGate {
    private var entered = false
    private var continuation: CheckedContinuation<Void, Never>?
    func enter() async { entered = true; await withCheckedContinuation { continuation = $0 } }
    func waitUntilEntered() async { while !entered { try? await Task.sleep(for: .milliseconds(1)) } }
    func release() { continuation?.resume(); continuation = nil }
}
private final class UploadEarlyCancelObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Bool?
    func complete(_ error: Error?) { lock.lock(); defer { lock.unlock() }; result = error is CancellationError || (error as? URLError)?.code == .cancelled }
    func value() -> Bool? { lock.lock(); defer { lock.unlock() }; return result }
}
@main struct NativeUploadRecoveryTests {
    private static var checks = 0
    private static let origin = URL(string: "https://uploads.invalid")!
    private static func require(_ condition: @autoclosure () throws -> Bool, _ detail: String) throws { guard try condition() else { throw NativeAPIError.unsupported(detail) }; checks += 1 }
    private static func rejects(_ work: () async throws -> Void) async throws { var rejected = false; do { try await work() } catch { rejected = true }; try require(rejected, "Required upload rejection did not occur") }
    private static func rejectsOwner(_ work: () async throws -> Void) async throws {
        do { try await work(); throw NativeAPIError.unsupported("Stale picker ownership was accepted") }
        catch NativeAPIError.sessionChanged { checks += 1 }
    }
    private struct Fixture { let repository: BackendRepository, secrets: UploadSecrets, transport: UploadFixture, signer: UploadSigner, files: NativeUploadPrivateFiles, root: URL, source: NativeUploadSource }
    private static func credentials(account: String = UploadFixture.account) throws -> Data {
        let claims: WireValue = .object(["sub": .string(account), "auth_method": .string("registered_face"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return try JSONEncoder().encode(NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("fixture-refresh"), "account_id": .string(account), "auth_method": .string("registered_face"), "roles": .strings(["user"]), "expires_in": .integer(900)])))
    }
    private static func make() async throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-upload-controlled-" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("original.jpg"); var bytes = Data([0xff, 0xd8, 0xff]); bytes.append(Data(repeating: 65, count: 700000 - 3)); try bytes.write(to: source)
        let store = UploadSecrets(), signer = UploadSigner(), transport = UploadFixture(), files = NativeUploadPrivateFiles(root: root.appendingPathComponent("staged", isDirectory: true))
        try store.write("credentials", data: credentials())
        let device = RegisteredDevice(accountID: UploadFixture.account, faceHandle: "lfh_" + Data(repeating: 3, count: 32).base64URL, deviceID: UploadFixture.device,
            profileID: "00000000-0000-4000-8000-000000000093", profileRevision: "fixture-v1", modelID: "fixture-model")
        try store.write("registered-device", data: JSONEncoder().encode(device))
        let repository = BackendRepository(origin: origin, transport: transport, secrets: store, signer: signer, uploadFiles: files, uploadTransport: NativeForegroundUploadTransport(transport: transport))
        _ = try await repository.bootstrap()
        return Fixture(repository: repository, secrets: store, transport: transport, signer: signer, files: files, root: root,
            source: NativeUploadSource(id: UUID().uuidString.lowercased(), file: source, title: "Selected photo", width: 279, height: 428))
    }
    private static func restart(_ fixture: Fixture) async throws -> BackendRepository {
        let repository = BackendRepository(origin: origin, transport: fixture.transport, secrets: fixture.secrets, signer: fixture.signer, uploadFiles: fixture.files, uploadTransport: NativeForegroundUploadTransport(transport: fixture.transport))
        let session = try await repository.bootstrap(); try require(session?.authenticated == true && session?.accountID == UploadFixture.account, "Restart retains registered account")
        return repository
    }
    private static func run() async throws {
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let session = await f.repository.summary()!
            let owner = NativeMediaCaptureContext(accountID: session.accountID, sessionEpoch: session.epoch, publicationGeneration: 4, expiresAt: session.expiresAt)
            let original = try await f.repository.stagePhotoUpload([f.source], caption: "Keep original selection", expectedOwner: owner)
            let saved = try f.secrets.read("resumable-photo-batches-v1")
            let wrongAccount = NativeMediaCaptureContext(accountID: "00000000-0000-4000-8000-000000000099", sessionEpoch: session.epoch, publicationGeneration: 4, expiresAt: session.expiresAt)
            try await rejectsOwner { _ = try await f.repository.stagePhotoUpload([f.source], expectedOwner: wrongAccount) }
            let wrongEpoch = NativeMediaCaptureContext(accountID: session.accountID, sessionEpoch: session.epoch + 1, publicationGeneration: 4, expiresAt: session.expiresAt)
            try await rejectsOwner { _ = try await f.repository.stagePhotoUpload([f.source], expectedOwner: wrongEpoch) }
            let expired = NativeMediaCaptureContext(accountID: session.accountID, sessionEpoch: session.epoch, publicationGeneration: 4, expiresAt: .distantPast)
            try await rejectsOwner { _ = try await f.repository.stagePhotoUpload([f.source], expectedOwner: expired) }
            let gate = UploadEarlyCancelGate()
            let cancelled = Task {
                await gate.enter()
                do { _ = try await f.repository.stagePhotoUpload([f.source], expectedOwner: owner); return false }
                catch is CancellationError { return true }
                catch { return false }
            }
            await gate.waitUntilEntered(); cancelled.cancel(); await gate.release()
            let rejectedCancellation = await cancelled.value
            try require(rejectedCancellation, "Cancelled import work cannot persist a replacement selection")
            let retained = try await f.repository.uploadSummary()
            try require(try f.secrets.read("resumable-photo-batches-v1") == saved && retained?.batch.id == original.batch.id, "Rejected picker ownership preserves prior private staging and caption unchanged")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let opening = await f.repository.summary()!
            let oldPicker = NativeMediaCaptureContext(accountID: opening.accountID, sessionEpoch: opening.epoch, publicationGeneration: 1, expiresAt: opening.expiresAt)
            try await f.repository.logout()
            let other = "00000000-0000-4000-8000-000000000099"
            try f.secrets.write("credentials", data: credentials(account: other)); await f.transport.useAccount(other)
            let device = RegisteredDevice(accountID: other, faceHandle: "lfh_" + Data(repeating: 8, count: 32).base64URL, deviceID: UploadFixture.device,
                profileID: "00000000-0000-4000-8000-000000000098", profileRevision: "fixture-v1", modelID: "fixture-model")
            try f.secrets.write("registered-device", data: JSONEncoder().encode(device))
            let later = BackendRepository(origin: origin, transport: f.transport, secrets: f.secrets, signer: f.signer, uploadFiles: f.files, uploadTransport: NativeForegroundUploadTransport(transport: f.transport))
            let session = try await later.bootstrap()!
            let before = try f.secrets.read("resumable-photo-batches-v1")
            try await rejectsOwner { _ = try await later.stagePhotoUpload([f.source], expectedOwner: oldPicker) }
            let hidden = try await later.uploadSummary()
            try require(hidden == nil && (try f.secrets.read("resumable-photo-batches-v1")) == before, "A Photos/Files result completed after account switch creates no batch for the later account")
            let currentPicker = NativeMediaCaptureContext(accountID: session.accountID, sessionEpoch: session.epoch, publicationGeneration: 2, expiresAt: session.expiresAt)
            let accepted = try await later.stagePhotoUpload([f.source], expectedOwner: currentPicker)
            try require(accepted.batch.accountID == other, "A newly opened picker bound to the current account still stages normally")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let staged = try await f.repository.stagePhotoUpload([f.source], caption: "Saved caption")
            try require(staged.batch.selectedFiles.count == 1 && staged.batch.caption == "Saved caption", "Original selection and caption persist")
            try Data([9, 9, 9]).write(to: f.source.file)
            try require(try f.files.verifiedBytes(staged.batch.files[0], batch: staged.batch.id).count == 700000, "External imported source cannot replace stable private bytes")
            let restored = try await restart(f), recovered = try await restored.uploadSummary()!
            try require(recovered.batch.id == staged.batch.id && recovered.batch.files[0].reserveKey == staged.batch.files[0].reserveKey && recovered.batch.caption == staged.batch.caption, "Restart preserves exact batch keys and caption")
            let calls = await f.transport.counts(); try require(calls.reserves == 0, "Review and restart send no upload mutation")
            let secret = String(data: try f.secrets.read("resumable-photo-batches-v1")!, encoding: .utf8)!
            try require(!secret.contains("access_token") && !secret.contains("refresh_token") && !secret.contains("Bearer"), "Upload scheduling journal is token-free")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source]); await f.transport.loseNext("reserve")
            try await rejects { _ = try await f.repository.resumePhotoUpload(batchID: batch.batch.id) }
            let unknown = try f.secrets.journal()[0].files[0]
            try require(unknown.reserveDispatched && unknown.assetID == nil, "Unknown committed reserve is held before adopting an ID")
            let restored = try await restart(f), status = try await restored.checkPhotoUpload(batchID: batch.batch.id)
            try require(status.batch.files[0].assetID != nil && status.batch.files[0].reserveKey == unknown.reserveKey, "Operation recovery binds original reservation back into file journal")
            let paused = try await restored.resumePhotoUpload(batchID: batch.batch.id, maximumChunks: 1)
            try require(paused.batch.paused && paused.batch.acknowledgedBytes == 262144 && paused.batch.uploadProgress < 1 && !paused.batch.received, "Only accepted bytes advance progress and pause cannot claim processing")
            await f.transport.loseNext("chunk")
            try await rejects { _ = try await restored.resumePhotoUpload(batchID: batch.batch.id) }
            let second = try await restart(f), actual = try await second.checkPhotoUpload(batchID: batch.batch.id)
            try require(actual.batch.acknowledgedBytes == 524288 && actual.batch.files[0].assetID == status.batch.files[0].assetID, "Lost chunk reply reconciles contiguous accepted prefix after reconstruction")
            await f.transport.loseNext("complete")
            try await rejects { _ = try await second.resumePhotoUpload(batchID: batch.batch.id) }
            let third = try await restart(f), completed = try await third.checkPhotoUpload(batchID: batch.batch.id)
            try require(completed.batch.received && completed.batch.selectedFiles[0].phase == .processing, "Unknown completion is reconciled as processing, never shared")
            let again = try await third.resumePhotoUpload(batchID: batch.batch.id), counts = await f.transport.counts(), chunks = await f.transport.chunks
            try require(again.batch.files[0].assetID == completed.batch.files[0].assetID && counts.reserves == 1 && counts.completes == 1, "Restart causes neither duplicate asset nor duplicate processing operation")
            try require(chunks == [0, 262144, 524288], "Each remaining chunk alone is sent; acknowledged prefixes are not resent")
            try require(try f.secrets.journal()[0].files[0].completeKey == batch.batch.files[0].completeKey, "Ambiguous completion retains its exact key")
            let currentPaths = await f.transport.paths
            try require(!currentPaths.contains(where: { $0.contains("sharing") || $0.contains("/media/") }), "Photo upload cannot create or imply recipient access")
            await f.transport.setStatus(completed.batch.files[0].assetID!, "ready")
            f.files.remove(completed.batch.files[0], batch: batch.batch.id)
            let ready = try await third.resumePhotoUpload(batchID: batch.batch.id)
            try require(ready.batch.selectedFiles[0].phase == .ready, "Already uploaded ready file reconciles without opening deleted local bytes")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source]), paused = try await f.repository.resumePhotoUpload(batchID: batch.batch.id, maximumChunks: 1)
            await f.transport.loseNext("cancel")
            try await rejects { _ = try await f.repository.cancelPhotoUpload(batchID: batch.batch.id) }
            try await rejects { _ = try await f.repository.stagePhotoUpload([f.source]) }
            try require(try f.secrets.journal().count == 1 && f.secrets.journal()[0].id == batch.batch.id, "Unconfirmed cancellation cannot be hidden by selecting a replacement batch")
            let restored = try await restart(f), cancelled = try await restored.cancelPhotoUpload(batchID: batch.batch.id), counts = await f.transport.counts()
            try require(cancelled.batch.cancellationRequested && cancelled.batch.selectedFiles[0].phase == .cancelled && counts.cancels == 1, "Lost cancellation reply recovers authoritative cancellation with original key")
            try require(cancelled.batch.files[0].assetID == paused.batch.files[0].assetID && !FileManager.default.fileExists(atPath: try f.files.url(cancelled.batch.files[0], batch: batch.batch.id).path), "Confirmed cancellation removes only own staged pending photo")
            try await rejects { _ = try await restored.resumePhotoUpload(batchID: batch.batch.id) }
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source]), complete = try await f.repository.resumePhotoUpload(batchID: batch.batch.id)
            let asset = complete.batch.files[0].assetID!, old = complete.batch.files[0].completeKey
            await f.transport.setStatus(asset, "failed", attempt: true)
            let retried = try await f.repository.retryPhotoProcessing(batchID: batch.batch.id, fileID: f.source.id), counts = await f.transport.counts()
            try require(retried.batch.files[0].assetID == asset && retried.batch.files[0].reserveKey == batch.batch.files[0].reserveKey && retried.batch.files[0].completeKey != old && counts.completes == 2, "Definitive terminal processing failure alone authorizes new complete operation on same bytes")
            let cancel = try await f.repository.cancelPhotoUpload(batchID: batch.batch.id), after = await f.transport.counts()
            try require(cancel.batch.files[0].phase == .processing && after.cancels == 0 && FileManager.default.fileExists(atPath: try f.files.url(cancel.batch.files[0], batch: batch.batch.id).path), "Cancel pending does not silently delete an already processing photo")
        }
        for defect in ["digest", "source", "regression"] {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source]); _ = try await f.repository.resumePhotoUpload(batchID: batch.batch.id, maximumChunks: 1)
            let before = await f.transport.chunks; await f.transport.corrupt(defect)
            try await rejects { _ = try await f.repository.resumePhotoUpload(batchID: batch.batch.id) }
            let after = await f.transport.chunks; try require(before == after, "Mismatched server byte binding, source or regressing offset stops further bytes")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source]); await f.transport.deviceMismatch()
            try await rejects { _ = try await f.repository.resumePhotoUpload(batchID: batch.batch.id) }
            let count = await f.transport.counts(); try require(count.reserves == 0, "A different current device cannot resume old private staging")
            let journal = try f.secrets.journal(); try require(journal[0].id == batch.batch.id, "Device mismatch preserves recovery evidence")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source]); await f.transport.denyConsent()
            try await rejects { _ = try await f.repository.resumePhotoUpload(batchID: batch.batch.id) }
            let count = await f.transport.counts(); try require(count.reserves == 0, "Missing current processing consent does not reserve or transfer")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source]), paused = try await f.repository.resumePhotoUpload(batchID: batch.batch.id, maximumChunks: 1)
            let bytes = try f.files.url(paused.batch.files[0], batch: batch.batch.id); try Data([0xff, 0xd8, 0xff]).write(to: bytes)
            let before = await f.transport.chunks
            try await rejects { _ = try await f.repository.resumePhotoUpload(batchID: batch.batch.id) }
            let after = await f.transport.chunks; try require(before == after && paused.batch.files[0].assetID != nil, "Changed staging never replaces original bytes or creates another asset")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source]); _ = try await f.repository.resumePhotoUpload(batchID: batch.batch.id, maximumChunks: 1)
            try await f.repository.logout()
            try require(try f.secrets.journal()[0].paused && (try f.secrets.read("credentials")) == nil, "Logout durably pauses private work and retires bearer authority")
            let other = "00000000-0000-4000-8000-000000000099"; try f.secrets.write("credentials", data: credentials(account: other)); await f.transport.useAccount(other)
            let repository = BackendRepository(origin: origin, transport: f.transport, secrets: f.secrets, signer: f.signer, uploadFiles: f.files, uploadTransport: NativeForegroundUploadTransport(transport: f.transport)); _ = try await repository.bootstrap()
            let hidden = try await repository.uploadSummary(), before = await f.transport.chunks
            try require(hidden == nil, "Another account never sees the saved batch")
            try await rejects { _ = try await repository.resumePhotoUpload(batchID: batch.batch.id) }
            let after = await f.transport.chunks; try require(before == after && (try f.secrets.journal()[0].accountID) == UploadFixture.account, "Account change fences writes while preserving original recovery")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source]), partial = try await f.repository.resumePhotoUpload(batchID: batch.batch.id, maximumChunks: 1)
            let asset = partial.batch.files[0].assetID!, originalComplete = partial.batch.files[0].completeKey
            await f.transport.setStatus(asset, "failed")
            let rejected = try await f.repository.checkPhotoUpload(batchID: batch.batch.id)
            try require(rejected.batch.files[0].phase == .failed && rejected.batch.files[0].processingAttemptID == nil, "Authoritative source rejection is separate from a failed processing attempt")
            try await rejects { _ = try await f.repository.retryPhotoProcessing(batchID: batch.batch.id, fileID: f.source.id) }
            let retired = try await f.repository.cancelPhotoUpload(batchID: batch.batch.id)
            try require(retired.batch.finished && !retired.batch.received && retired.batch.files[0].discardedTerminalTransfer == true, "Explicit cancel retires a terminal rejected transfer hold without claiming successful upload")
            try require(retired.batch.files[0].assetID == asset && retired.batch.files[0].errorCode == rejected.batch.files[0].errorCode && retired.batch.files[0].completeKey == originalComplete, "Terminal source identity/error and original processing key are preserved")
            let corrected = NativeUploadSource(id: UUID().uuidString.lowercased(), file: f.source.file, title: "Corrected selected photo", width: f.source.width, height: f.source.height)
            let newBatch = try await f.repository.stagePhotoUpload([corrected])
            try require(newBatch.batch.id != batch.batch.id && newBatch.batch.files[0].reserveKey != partial.batch.files[0].reserveKey && f.secrets.journal().contains(where: { $0.id == batch.batch.id }), "Explicit corrected selection is allowed only after original source is definitively rejected and locally cancelled")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let gate = UploadEarlyCancelGate(), observed = UploadEarlyCancelObservation(), transport = NativeFileURLUploadTransport()
            let bytes = Data([0xff, 0xd8, 0xff, 0x42]), file = f.root.appendingPathComponent("early-cancel.chunk"), hash = NativeUploadPrivateFiles.hash(bytes)
            try bytes.write(to: file)
            var request = URLRequest(url: URL(string: "https://early-cancellation.invalid/uploads/00000000-0000-4000-8000-000000000101/chunks?offset=0")!)
            request.httpMethod = "PUT"; request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type"); request.setValue(hash, forHTTPHeaderField: "X-Lovelies-Chunk-SHA256")
            let prepared = request, key = UUID().uuidString.lowercased() + ":" + UUID().uuidString.lowercased() + ":0:" + hash
            let pending = Task {
                await gate.enter()
                do { _ = try await transport.send(prepared, file: file, taskKey: key, limit: 1024); observed.complete(nil) }
                catch { observed.complete(error) }
            }
            await gate.waitUntilEntered(); pending.cancel(); await gate.release()
            let deadline = Date().addingTimeInterval(3)
            while observed.value() == nil && Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
            try require(observed.value() == true, "Already-cancelled Swift task registers its URLSession continuation before cancellation and completes without a hang")
            await pending.value
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            let batch = try await f.repository.stagePhotoUpload([f.source])
            try require(!batch.batch.canRetryInBackground, "An unsubmitted selection never schedules automatic transfer")
            try await f.repository.allowBackgroundUpload(batchID: batch.batch.id)
            _ = try await f.repository.resumePhotoUpload(batchID: batch.batch.id, maximumChunks: 1)
            let suspended = try await f.repository.pausePhotoUpload(batchID: batch.batch.id, disableAutomaticRetry: false)
            try require(suspended.batch.canRetryInBackground, "OS suspension retains user-started retry eligibility")
            let cold = BackendRepository(origin: origin, transport: f.transport, secrets: f.secrets, signer: f.signer, uploadFiles: f.files, uploadTransport: NativeForegroundUploadTransport(transport: f.transport))
            let restored = try await cold.restoreBackgroundUpload()
            try require(restored?.batch.id == batch.batch.id && restored?.batch.canRetryInBackground == true, "Cold OS launch restores the exact account and upload journal without creating an account")
            for _ in 0..<5 { let admitted = try await cold.beginBackgroundUpload(batchID: batch.batch.id); try require(admitted, "Bounded automatic attempt admitted") }
            let exhausted = try await cold.beginBackgroundUpload(batchID: batch.batch.id)
            try require(!exhausted, "Automatic retries stop after five bounded attempts")
            try await cold.allowBackgroundUpload(batchID: batch.batch.id)
            let userPause = try await cold.pausePhotoUpload(batchID: batch.batch.id)
            try require(!userPause.batch.canRetryInBackground, "Explicit Pause disables automatic background retry")
            try f.secrets.write("ordinary-face-login-journal", data: Data([0]))
            let held = try await cold.restoreBackgroundUpload()
            try require(held == nil, "An unresolved authentication journal prevents background writes")
        }
        do {
            let secrets = UploadSecrets(), transport = UploadFixture()
            let repository = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: UploadSigner())
            let result = try await repository.restoreBackgroundUpload()
            try require(result == nil, "OS retry cannot create an anonymous or registered account")
            let paths = await transport.paths
            try require(paths.isEmpty, "Missing credentials perform no background network request")
        }
        do {
            let f = try await make(); defer { try? FileManager.default.removeItem(at: f.root) }
            for bytes in [Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), Data("RIFF1234WEBPfixture".utf8)] {
                let source = f.root.appendingPathComponent(UUID().uuidString); try bytes.write(to: source)
                let type = NativeUploadContentType.detect(bytes)!, batch = UUID().uuidString.lowercased()
                let file = try f.files.stage(NativeUploadSource(id: UUID().uuidString.lowercased(), file: source, title: "Original-format fixture", width: 10, height: 20), batch: batch)
                try require(file.mime == type.rawValue && file.stagedName.hasSuffix("." + type.fileExtension), "Upload journal retains the sniffed original MIME and canonical extension")
                try require(try f.files.verifiedBytes(file, batch: batch) == bytes, "Staged PNG/WebP bytes remain byte-identical")
                var substituted = file; substituted = NativeResumableUploadFile(id: file.id, stagedName: file.stagedName, sha256: file.sha256, byteSize: file.byteSize, mime: "image/jpeg", title: file.title, width: file.width, height: file.height, reserveKey: file.reserveKey, completeKey: file.completeKey, cancelKey: file.cancelKey, selected: true)
                var rejected = false; do { try substituted.validate() } catch { rejected = true }
                try require(rejected, "MIME and staged extension substitution is rejected")
            }
            try require(NativeUploadContentType.detect(Data("GIF89a".utf8)) == nil, "Unsupported processor format is not mislabeled as JPEG")
        }
        print("Native upload recovery checks passed: \(checks)")
    }
    static func main() async throws { try await run() }
}
