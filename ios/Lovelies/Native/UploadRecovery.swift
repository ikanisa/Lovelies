import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum NativePrivacyExportPhase: String, Codable, Sendable {
    case prepared, open, staged, ackUnknown, sessionHeld, acknowledged, expiredLocal, retired, cleanup
}
struct NativePrivacyExportRecord: Codable, Equatable, Sendable {
    let apiOrigin: String, accountID: String, requestID: String, operationKey: String
    var delivery: WireValue?
    var nextPart = 0, byteCount = 0
    var chain: String
    var archiveSHA256: String?
    var phase: NativePrivacyExportPhase = .prepared
    init(origin: URL, account: String, request: String) {
        apiOrigin = origin.absoluteString; accountID = account; requestID = request
        operationKey = "ios-export-" + UUID().uuidString.lowercased()
        chain = Self.seed(request: request, account: account)
    }
    static let maximumPartBytes = 256 * 1024
    static func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func digest(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
    static func seed(request: String, account: String) -> String { hash(Data("lovelies-privacy-export-parts-v1\n\(request)\n\(account)".utf8)) }
    static func advance(_ chain: String, index: Int, bytes: Data) -> String { hash(Data("\(chain):\(index):\(bytes.count):\(hash(bytes))".utf8)) }
    var partCount: Int { delivery?["part_count"].integer ?? 0 }
    var totalBytes: Int { delivery?["total_bytes"].integer ?? 0 }
    var complete: Bool { [.staged, .ackUnknown, .sessionHeld, .acknowledged, .expiredLocal, .cleanup].contains(phase) }
    var usable: Bool { [.sessionHeld, .acknowledged, .expiredLocal].contains(phase) }
    var serverTerminal: Bool { [.acknowledged, .expiredLocal].contains(phase) }
    var path: String { "/privacy-exports/\(requestID)/delivery/\(delivery?["delivery_id"].string ?? "")" }
    func validate(origin: URL) throws {
        guard apiOrigin == origin.absoluteString, UUID(uuidString: accountID) != nil, UUID(uuidString: requestID) != nil,
              operationKey.range(of: "^[A-Za-z0-9._:-]{16,128}$", options: .regularExpression) != nil,
              (0...1_000_000).contains(nextPart), byteCount >= 0, Self.digest(chain) else { throw NativeAPIError.invalidResponse }
        if let delivery {
            try validateMetadata(delivery)
            guard phase != .prepared, nextPart <= partCount, byteCount <= totalBytes, byteCount >= nextPart else { throw NativeAPIError.invalidResponse }
            if complete { guard nextPart == partCount, byteCount == totalBytes, chain == delivery["manifest_sha256"].string,
                                let archiveSHA256, Self.digest(archiveSHA256) else { throw NativeAPIError.invalidResponse } }
            if phase == .acknowledged { guard delivery["status"].string == "acknowledged" else { throw NativeAPIError.invalidResponse } }
        } else if ![.prepared, .retired].contains(phase) || nextPart != 0 || byteCount != 0 { throw NativeAPIError.invalidResponse }
        if nextPart == 0 { guard byteCount == 0, chain == Self.seed(request: requestID, account: accountID) else { throw NativeAPIError.invalidResponse } }
        if let archiveSHA256 { guard Self.digest(archiveSHA256) else { throw NativeAPIError.invalidResponse } }
    }
    func validateMetadata(_ value: WireValue) throws {
        let required: Set<String> = ["protocol", "request_id", "delivery_id", "operation_key", "manifest_sha256", "part_count", "total_bytes", "expires_at", "status"]
        guard let keys = value.object.map({ Set($0.keys) }), required.isSubset(of: keys), keys.isSubset(of: required.union(["acknowledged_at"])),
              value["protocol"].string == "lovelies-privacy-export-delivery-v1", value["request_id"].string == requestID,
              value["operation_key"].string == operationKey, let manifest = value["manifest_sha256"].string, Self.digest(manifest),
              ["open", "acknowledged"].contains(value["status"].string ?? ""), let count = value["part_count"].integer, (1...1_000_000).contains(count),
              let total = value["total_bytes"].integer, (count...(count * Self.maximumPartBytes)).contains(total) else { throw NativeAPIError.invalidResponse }
        _ = try value.uuid("delivery_id"); _ = try NativeRefreshDeliveryRecord.date(value["expires_at"])
        if value["status"].string == "acknowledged" { _ = try NativeRefreshDeliveryRecord.date(value["acknowledged_at"]) }
        else if value["acknowledged_at"] != .null { throw NativeAPIError.invalidResponse }
        if let old = delivery {
            for key in required.subtracting(["status"]) where old[key] != value[key] { throw NativeAPIError.invalidResponse }
            if old["status"].string == "acknowledged", value["status"].string != "acknowledged" { throw NativeAPIError.invalidResponse }
        }
    }
    func validatePart(_ bytes: Data, headers: [String: String], index: Int) throws {
        guard (0..<partCount).contains(index), !bytes.isEmpty, bytes.count <= Self.maximumPartBytes,
              headers["x-lovelies-export-part-index"] == String(index), headers["x-lovelies-export-manifest"] == delivery?["manifest_sha256"].string,
              headers["x-lovelies-export-part-sha256"] == Self.hash(bytes) else { throw NativeAPIError.invalidResponse }
    }
}
struct NativePrivacyExportFile: Sendable {
    let accountID: String, requestID: String, operationKey: String, sha256: String, url: URL, expiresAt: Date
}

/// Private protected export staging is independent of expiring share-sheet
/// copies. UUID account/request directories and exact operation hashes prevent
/// another account's cleanup from erasing a retained archive.
struct NativePrivacyExportFiles: Sendable {
    let root: URL
    init(root: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("lovelies-privacy-exports", isDirectory: true)) {
        self.root = root.standardizedFileURL
    }
    private func directory(_ record: NativePrivacyExportRecord, create: Bool) throws -> URL? {
        guard let origin = URL(string: record.apiOrigin) else { throw NativeAPIError.invalidResponse }; try record.validate(origin: origin)
        var current = root
        let names = [NativePrivacyExportRecord.hash(Data(record.apiOrigin.utf8)), record.accountID, record.requestID,
                     NativePrivacyExportRecord.hash(Data(record.operationKey.utf8))]
        for name in [String?](arrayLiteral: nil) + names.map(Optional.some) {
            if let name { current.appendPathComponent(name, isDirectory: true) }
            guard (try? FileManager.default.destinationOfSymbolicLink(atPath: current.path)) == nil else { throw NativeAPIError.invalidResponse }
            if !FileManager.default.fileExists(atPath: current.path) {
                guard create else { return nil }
                try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            }
            let values = try current.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
            var noBackup = URLResourceValues(); noBackup.isExcludedFromBackup = true; try current.setResourceValues(noBackup)
        }
        return current
    }
    private func file(_ name: String, record: NativePrivacyExportRecord, create: Bool) throws -> URL {
        guard let directory = try directory(record, create: create) else { throw NativeAPIError.unavailable("privacy_export_local_unavailable") }
        let url = directory.appendingPathComponent(name)
        guard (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) == nil else { throw NativeAPIError.invalidResponse }
        if FileManager.default.fileExists(atPath: url.path) {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
        }
        return url
    }
    func stage(_ bytes: Data, index: Int, record: NativePrivacyExportRecord) throws {
        guard (0..<record.partCount).contains(index), !bytes.isEmpty, bytes.count <= NativePrivacyExportRecord.maximumPartBytes else { throw NativeAPIError.invalidResponse }
        let url = try file("\(index).part", record: record, create: true)
        try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }; try handle.synchronize()
        guard try read(index: index, record: record) == bytes else { throw NativeAPIError.unavailable("privacy_export_storage_unavailable") }
    }
    func read(index: Int, record: NativePrivacyExportRecord) throws -> Data {
        guard (0..<record.partCount).contains(index) else { throw NativeAPIError.invalidResponse }
        let url = try file("\(index).part", record: record, create: false)
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard (1...NativePrivacyExportRecord.maximumPartBytes).contains(size) else { throw NativeAPIError.invalidResponse }
        let bytes = try Data(contentsOf: url)
        guard bytes.count == size else { throw NativeAPIError.invalidResponse }; return bytes
    }
    func verifyPrefix(_ record: NativePrivacyExportRecord) throws {
        var chain = NativePrivacyExportRecord.seed(request: record.requestID, account: record.accountID), size = 0
        for index in 0..<record.nextPart {
            try Task.checkCancellation()
            let bytes = try read(index: index, record: record)
            chain = NativePrivacyExportRecord.advance(chain, index: index, bytes: bytes); size += bytes.count
        }
        guard chain == record.chain, size == record.byteCount else { throw NativeAPIError.invalidResponse }
    }
    func assemble(_ record: NativePrivacyExportRecord) throws -> (URL, String) {
        guard record.nextPart == record.partCount, record.byteCount == record.totalBytes,
              record.chain == record.delivery?["manifest_sha256"].string else { throw NativeAPIError.invalidResponse }
        let pending = try file("archive.pending", record: record, create: true)
        if FileManager.default.fileExists(atPath: pending.path) { try FileManager.default.removeItem(at: pending) }
        guard FileManager.default.createFile(atPath: pending.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]) else { throw NativeAPIError.unavailable("privacy_export_storage_unavailable") }
        let output = try FileHandle(forWritingTo: pending); var digest = SHA256()
        do {
            var chain = NativePrivacyExportRecord.seed(request: record.requestID, account: record.accountID), size = 0
            for index in 0..<record.nextPart {
                try Task.checkCancellation(); let bytes = try read(index: index, record: record)
                try output.write(contentsOf: bytes); digest.update(data: bytes)
                chain = NativePrivacyExportRecord.advance(chain, index: index, bytes: bytes); size += bytes.count
            }
            guard chain == record.chain, size == record.byteCount else { throw NativeAPIError.invalidResponse }
            try output.synchronize(); try output.close()
        } catch { try? output.close(); throw error }
        let url = try file("archive.json", record: record, create: true)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        try FileManager.default.moveItem(at: pending, to: url)
        let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
        try verifyArchive(url, byteCount: record.byteCount, sha256: hash)
        return (url, hash)
    }
    func verifiedArchive(_ record: NativePrivacyExportRecord) throws -> URL {
        guard record.complete, let hash = record.archiveSHA256 else { throw NativeAPIError.invalidResponse }
        let url = try file("archive.json", record: record, create: false)
        try verifyArchive(url, byteCount: record.byteCount, sha256: hash); return url
    }
    private func verifyArchive(_ url: URL, byteCount: Int, sha256: String) throws {
        guard try url.resourceValues(forKeys: [.fileSizeKey]).fileSize == byteCount else { throw NativeAPIError.invalidResponse }
        let input = try FileHandle(forReadingFrom: url); defer { try? input.close() }; var digest = SHA256(), size = 0
        while let bytes = try input.read(upToCount: NativePrivacyExportRecord.maximumPartBytes), !bytes.isEmpty {
            try Task.checkCancellation(); size += bytes.count; guard size <= byteCount else { throw NativeAPIError.invalidResponse }; digest.update(data: bytes)
        }
        guard size == byteCount, digest.finalize().map({ String(format: "%02x", $0) }).joined() == sha256 else { throw NativeAPIError.invalidResponse }
    }
    func erase(_ record: NativePrivacyExportRecord) throws {
        guard let directory = try directory(record, create: false) else { return }
        try FileManager.default.removeItem(at: directory)
        guard !FileManager.default.fileExists(atPath: directory.path) else { throw NativeAPIError.unavailable("privacy_export_cleanup_unavailable") }
    }
}

enum NativeUploadContentType: String, Sendable {
    case jpeg = "image/jpeg", png = "image/png", webp = "image/webp"
    var fileExtension: String { switch self { case .jpeg: return "jpg"; case .png: return "png"; case .webp: return "webp" } }
    static func detect(_ bytes: Data) -> Self? {
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { return .jpeg }
        if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) { return .png }
        if bytes.count >= 12, bytes.prefix(4) == Data("RIFF".utf8), bytes[8..<12] == Data("WEBP".utf8) { return .webp }
        return nil
    }
}

/// The upload journal contains no bearer credential or server object key. The
/// account/device binding is checked again before each current-session request.
enum NativeUploadPhase: String, Codable, Sendable {
    case draft, queued, reserving, uploading, completing, processing, ready, failed, cancelling, cancelled
    var bytesReceived: Bool { [.processing, .ready].contains(self) }
    var finished: Bool { self == .ready || self == .cancelled }
}
struct NativeUploadSource: Sendable {
    let id: String, file: URL, title: String, width: Int, height: Int
}
struct NativeResumableUploadFile: Codable, Sendable, Identifiable {
    let id: String, stagedName: String, sha256: String, byteSize: Int, mime: String, title: String, width: Int, height: Int
    let reserveKey: String
    var completeKey: String
    let cancelKey: String
    var selected: Bool
    var phase: NativeUploadPhase = .draft
    var assetID: String?, version: String?, processingAttemptID: String?
    var acknowledgedBytes = 0
    var reserveDispatched = false, completeDispatched = false, cancelDispatched = false
    var errorCode: String?
    var retryProcessingRequested = false
    var discardedTerminalTransfer: Bool? = nil
    var finished: Bool { phase.finished || discardedTerminalTransfer == true }
    var received: Bool { phase.bytesReceived || phase == .failed && acknowledgedBytes == byteSize && processingAttemptID != nil }
    var uploadProgress: Double { Double(acknowledgedBytes) / Double(max(1, byteSize)) }
    func validate() throws {
        guard let content = NativeUploadContentType(rawValue: mime), UUID(uuidString: id) != nil, stagedName == id + "." + content.fileExtension, Self.digest(sha256),
              (1...20 * 1024 * 1024).contains(byteSize), title.utf16.count <= 500,
              (1...100_000).contains(width), (1...100_000).contains(height),
              [reserveKey, completeKey, cancelKey].allSatisfy({ UUID(uuidString: $0) != nil }),
              Set([reserveKey, completeKey, cancelKey]).count == 3,
              acknowledgedBytes >= 0, acknowledgedBytes <= byteSize,
              errorCode == nil || errorCode!.count <= 100 else { throw NativeAPIError.invalidResponse }
        if let processingAttemptID { guard UUID(uuidString: processingAttemptID) != nil else { throw NativeAPIError.invalidResponse } }
        if let assetID { guard UUID(uuidString: assetID) != nil, let version, UUID(uuidString: version) != nil else { throw NativeAPIError.invalidResponse } }
        else { guard version == nil, acknowledgedBytes == 0, !completeDispatched, !cancelDispatched else { throw NativeAPIError.invalidResponse } }
        if phase.bytesReceived { guard assetID != nil, acknowledgedBytes == byteSize else { throw NativeAPIError.invalidResponse } }
        if discardedTerminalTransfer == true { guard phase == .failed, assetID != nil, processingAttemptID == nil, !retryProcessingRequested else { throw NativeAPIError.invalidResponse } }
    }
    static func digest(_ value: String) -> Bool { value.count == 64 && value.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) }
}
struct NativeResumableUploadBatch: Codable, Sendable, Identifiable {
    static let protocolName = "lovelies-native-upload-v1"
    let schema: Int, protocolName: String, id: String, apiOrigin: String, accountID: String, deviceID: String, createdAt: Date
    var caption: String
    var files: [NativeResumableUploadFile]
    var started = false, paused = true, cancellationRequested = false
    var revision = 0
    var backgroundRetryAllowed: Bool? = nil
    var backgroundRetryAttempts: Int? = nil
    var canRetryInBackground: Bool {
        backgroundRetryAllowed == true && (backgroundRetryAttempts ?? 0) < 5 && started && !finished && !received && !cancellationRequested &&
        !selectedFiles.isEmpty && !selectedFiles.contains { $0.phase == .failed || $0.phase == .cancelling }
    }
    var selectedFiles: [NativeResumableUploadFile] { files.filter { $0.selected } }
    var received: Bool { let kept = selectedFiles.filter { $0.phase != .cancelled && $0.discardedTerminalTransfer != true }; return !kept.isEmpty && kept.allSatisfy { $0.received } }
    var finished: Bool { !selectedFiles.isEmpty && selectedFiles.allSatisfy { $0.finished } }
    var acknowledgedBytes: Int { selectedFiles.reduce(0) { $0 + $1.acknowledgedBytes } }
    var totalBytes: Int { selectedFiles.reduce(0) { $0 + $1.byteSize } }
    var uploadProgress: Double { Double(acknowledgedBytes) / Double(max(1, totalBytes)) }
    init(id: String = UUID().uuidString.lowercased(), origin: URL, account: String, device: String, caption: String = "", files: [NativeResumableUploadFile]) {
        schema = 1; protocolName = Self.protocolName; self.id = id; apiOrigin = origin.absoluteString
        accountID = account; deviceID = device; createdAt = Date(); self.caption = caption; self.files = files
    }
    func validate(origin: URL) throws {
        guard schema == 1, protocolName == Self.protocolName, apiOrigin == origin.absoluteString,
              UUID(uuidString: id) != nil, UUID(uuidString: accountID) != nil, UUID(uuidString: deviceID) != nil,
              caption.utf16.count <= 500, (1...30).contains(files.count), Set(files.map(\.id)).count == files.count,
              Set(files.flatMap { [$0.reserveKey, $0.completeKey, $0.cancelKey] }).count == files.count * 3,
              revision >= 0, (0...5).contains(backgroundRetryAttempts ?? 0), createdAt <= Date().addingTimeInterval(120) else { throw NativeAPIError.invalidResponse }
        for file in files { try file.validate() }
        if started { guard !selectedFiles.isEmpty, !selectedFiles.contains(where: { $0.phase == .draft }) else { throw NativeAPIError.invalidResponse } }
    }
    mutating func revise() { revision += 1 }
}
struct NativeUploadSummary: Sendable {
    let batch: NativeResumableUploadBatch
    let sources: [NativeUploadSource]
    var uploadedIDs: [String] { batch.selectedFiles.compactMap { $0.received ? $0.assetID : nil } }
}

/// Stable application-support files, excluded from backup. Cache eviction and a
/// revoked Photos/Files selection cannot silently replace already staged bytes.
final class NativeUploadPrivateFiles: @unchecked Sendable {
    let root: URL
    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LoveliesPrivateUploads", isDirectory: true)
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func directory(_ batch: String) throws -> URL {
        guard UUID(uuidString: batch) != nil else { throw NativeAPIError.invalidResponse }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var value = root; var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true; try value.setResourceValues(excluded)
        let rootState = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootState.isDirectory == true, rootState.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
        let result = root.appendingPathComponent(batch, isDirectory: true)
        try FileManager.default.createDirectory(at: result, withIntermediateDirectories: true)
        let state = try result.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard state.isDirectory == true, state.isSymbolicLink != true,
              result.resolvingSymlinksInPath() == root.resolvingSymlinksInPath().appendingPathComponent(batch, isDirectory: true) else { throw NativeAPIError.invalidResponse }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: result.path)
        return result
    }
    private func write(_ bytes: Data, to file: URL) throws {
        #if os(iOS)
        try bytes.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try bytes.write(to: file, options: [.atomic])
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        var value = file; var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true; try value.setResourceValues(excluded)
    }
    func stage(_ source: NativeUploadSource, batch: String) throws -> NativeResumableUploadFile {
        guard UUID(uuidString: source.id) != nil, source.title.utf16.count <= 500,
              let metadata = try? source.file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              metadata.isRegularFile == true, metadata.isSymbolicLink != true,
              let count = metadata.fileSize, (1...20 * 1024 * 1024).contains(count) else { throw NativeAPIError.unsupported(String(localized: "This selected photo is unavailable. Select it again before starting an upload.")) }
        let bytes = try Data(contentsOf: source.file, options: .mappedIfSafe)
        guard bytes.count == count, let content = NativeUploadContentType.detect(bytes) else { throw NativeAPIError.invalidResponse }
        let name = source.id + "." + content.fileExtension, target = try directory(batch).appendingPathComponent(name)
        let checksum = Self.hash(bytes)
        if FileManager.default.fileExists(atPath: target.path) {
            guard try Data(contentsOf: target) == bytes else { throw NativeAPIError.invalidResponse }
        } else { try write(bytes, to: target) }
        let result = NativeResumableUploadFile(id: source.id, stagedName: name, sha256: checksum, byteSize: count, mime: content.rawValue, title: source.title,
            width: source.width, height: source.height, reserveKey: UUID().uuidString.lowercased(), completeKey: UUID().uuidString.lowercased(), cancelKey: UUID().uuidString.lowercased(), selected: true)
        try result.validate(); return result
    }
    func url(_ file: NativeResumableUploadFile, batch: String) throws -> URL {
        try file.validate(); return try directory(batch).appendingPathComponent(file.stagedName)
    }
    func verifiedBytes(_ file: NativeResumableUploadFile, batch: String) throws -> Data {
        let source = try url(file, batch: batch)
        guard let metadata = try? source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]), metadata.isRegularFile == true,
              metadata.isSymbolicLink != true, metadata.fileSize == file.byteSize else { throw NativeAPIError.unsupported(String(localized: "The saved photo is unavailable. Keep this upload's status; its bytes cannot be replaced.")) }
        let bytes = try Data(contentsOf: source, options: .mappedIfSafe)
        guard bytes.count == file.byteSize, Self.hash(bytes) == file.sha256 else { throw NativeAPIError.unsupported(String(localized: "The saved photo changed. Its original upload cannot use different bytes.")) }
        return bytes
    }
    func chunk(_ file: NativeResumableUploadFile, batch: String, offset: Int, count: Int) throws -> (URL, String) {
        let bytes = try verifiedBytes(file, batch: batch)
        guard offset >= 0, count > 0, offset + count <= bytes.count else { throw NativeAPIError.invalidResponse }
        let chunk = bytes.subdata(in: offset..<(offset + count)), hash = Self.hash(chunk)
        let target = try directory(batch).appendingPathComponent(file.id + "-" + String(offset) + ".chunk")
        try write(chunk, to: target); return (target, hash)
    }
    func removeChunk(_ url: URL, batch: String) { guard let folder = try? directory(batch), url.deletingLastPathComponent().standardizedFileURL == folder.standardizedFileURL, url.pathExtension == "chunk" else { return }; try? FileManager.default.removeItem(at: url) }
    func remove(_ file: NativeResumableUploadFile, batch: String) {
        guard let url = try? url(file, batch: batch) else { return }
        try? FileManager.default.removeItem(at: url)
        let folder = url.deletingLastPathComponent()
        for chunk in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            where chunk.lastPathComponent.hasPrefix(file.id + "-") && chunk.pathExtension == "chunk" { try? FileManager.default.removeItem(at: chunk) }
    }
    func removeBatch(_ batch: String) { guard UUID(uuidString: batch) != nil else { return }; try? FileManager.default.removeItem(at: root.appendingPathComponent(batch, isDirectory: true)) }
    func removeBatchConfirmed(_ batch: String) throws {
        guard UUID(uuidString: batch) != nil else { throw NativeAPIError.invalidResponse }
        guard FileManager.default.fileExists(atPath: root.path) else { return }
        let rootState = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootState.isDirectory == true, rootState.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
        let folder = root.appendingPathComponent(batch, isDirectory: true)
        guard FileManager.default.fileExists(atPath: folder.path) else { return }
        let state = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard state.isDirectory == true, state.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
        try FileManager.default.removeItem(at: folder)
        guard !FileManager.default.fileExists(atPath: folder.path) else { throw NativeAPIError.unavailable("private_file_cleanup") }
    }
}

protocol NativeUploadFileTransport: Sendable {
    func send(_ request: URLRequest, file: URL, taskKey: String, limit: Int) async throws -> NativeHTTPReply
    func cancel(batch: String) async
}
/// Host verification uses the same HTTP request/file bytes with its explicitly
/// declared transport. iOS chooses the background-file URLSession adapter.
final class NativeForegroundUploadTransport: NativeUploadFileTransport, @unchecked Sendable {
    let transport: any NativeTransport
    private let lock = NSLock()
    private var active: [String: Task<NativeHTTPReply, Error>] = [:]
    init(transport: any NativeTransport) { self.transport = transport }
    private func retain(_ task: Task<NativeHTTPReply, Error>?, key: String) { lock.lock(); defer { lock.unlock() }; active[key] = task }
    private func matching(_ batch: String) -> [Task<NativeHTTPReply, Error>] { lock.lock(); defer { lock.unlock() }; return active.filter { $0.key.hasPrefix(batch + ":") }.map(\.value) }
    func send(_ request: URLRequest, file: URL, taskKey: String, limit: Int) async throws -> NativeHTTPReply {
        var value = request; value.httpBody = try Data(contentsOf: file)
        let prepared = value, transport = transport
        let task = Task { try await transport.send(prepared, limit: limit) }; retain(task, key: taskKey)
        defer { retain(nil, key: taskKey) }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
    func cancel(batch: String) async { for task in matching(batch) { task.cancel() } }
}

struct NativeResumableUploadStatus: Sendable {
    let phase: NativeUploadPhase, bytesReceived: Int, maximumChunkBytes: Int, expiresAt: Date
    let assemblyPending: Bool, cleanupPending: Bool, errorCode: String?
    init(_ value: WireValue, batch: NativeResumableUploadBatch, file: NativeResumableUploadFile, reservation: Bool = false) throws {
        guard value["source"].string == "personal", value["resumable"].bool == true,
              value["upload_batch_id"].string == batch.id, value["byte_size"].integer == file.byteSize,
              value["content_type"].string == file.mime, value["checksum_sha256"].string == file.sha256,
              value["maximum_chunk_bytes"].integer == 262144, value["processing_creates_access"].bool == false,
              let received = value["bytes_received"].integer, received <= file.byteSize,
              let state = value["status"].string, ["uploading", "uploaded", "processing", "ready", "failed", "cancelled"].contains(state),
              let expiry = Self.date(value["expires_at"].string),
              value["error_code"] == .null || value["error_code"].string.map({ $0.count <= 100 }) == true else { throw NativeAPIError.invalidResponse }
        let id = try value.uuid("asset_id"), version = try value.uuid("version")
        if !reservation { guard id == file.assetID, version == file.version else { throw NativeAPIError.invalidResponse } }
        guard state == "cancelled" || received >= file.acknowledgedBytes else { throw NativeAPIError.invalidResponse }
        if ["uploaded", "processing", "ready"].contains(state) { guard received == file.byteSize else { throw NativeAPIError.invalidResponse } }
        if state == "uploading" { guard received == file.byteSize || received % 262144 == 0 else { throw NativeAPIError.invalidResponse } }
        phase = state == "uploaded" ? .completing : NativeUploadPhase(rawValue: state)!
        bytesReceived = received; maximumChunkBytes = 262144; expiresAt = expiry
        assemblyPending = value["assembly_pending"].bool == true; cleanupPending = value["cleanup_pending"].bool == true
        errorCode = value["error_code"].string
        if assemblyPending { guard state == "uploading", received == file.byteSize else { throw NativeAPIError.invalidResponse } }
    }
    static func date(_ text: String?) -> Date? {
        guard let text else { return nil }; let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
