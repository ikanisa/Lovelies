import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Root supplies private synthetic credentials/media for an isolated real local
// handler/PG/journal. This is HTTP integration evidence, never a Photos, device,
// store, production recognition or provider completion result.
private final class DownloadHTTPVault: NativeSecretStore, @unchecked Sendable {
    let root: URL
    init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    private func file(_ name: String) throws -> URL {
        guard !name.isEmpty, name.utf8.count <= 100, name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { throw NativeAPIError.invalidResponse }
        return root.appendingPathComponent(name + ".json")
    }
    func read(_ name: String) throws -> Data? {
        let path = try file(name)
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        let values = try path.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? Int.max) <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        return try Data(contentsOf: path)
    }
    func write(_ name: String, data: Data?) throws {
        let path = try file(name)
        if let data {
            #if os(iOS)
            try data.write(to: path, options: [.atomic, .completeFileProtection])
            #else
            try data.write(to: path, options: .atomic)
            #endif
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        } else if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
    }
}
private struct DownloadHTTPSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { NativeDownloadRecord.hash(data) }
    func clear() {}
}
@MainActor @main struct NativeDownloadRecoveryHTTPJourney {
    private static var checks = 0
    private static func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw NativeAPIError.unsupported("Download HTTP journey: " + label) }; checks += 1; print("PASS " + label)
    }
    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { throw NativeAPIError.invalidResponse }
        let config = try WireValue.decoded(Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        guard let origin = URL(string: try config.text("api_origin")), ["http", "https"].contains(origin.scheme ?? ""), origin.query == nil, origin.fragment == nil,
              origin.user == nil, origin.password == nil else { throw NativeAPIError.invalidResponse }
        let credentials = try NativeCredentials(config["credentials"]), asset = try config.uuid("asset_id"), version = try config.text("source_version", maximum: 512), expectedHash = try config.text("sha256", maximum: 64)
        guard NativeResumableUploadFile.digest(expectedHash) else { throw NativeAPIError.invalidResponse }
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-download-http-" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: scratch) } // Newly allocated synthetic fixture tree only.
        let vault = try DownloadHTTPVault(root: scratch.appendingPathComponent("vault", isDirectory: true))
        try vault.write("credentials", data: JSONEncoder().encode(credentials))
        let files = NativeUploadPrivateFiles(root: scratch.appendingPathComponent("staging", isDirectory: true))
        func repository() -> BackendRepository { BackendRepository(origin: origin, transport: NativeURLTransport(), secrets: vault, signer: DownloadHTTPSigner(), uploadFiles: files) }
        func journal() throws -> NativeDownloadJournal { try JSONDecoder().decode(NativeDownloadJournal.self, from: vault.read("download-delivery-v2")!) }
        let photo = try NativePhoto(.object(["id": .string(asset), "title": .string("Declared synthetic HTTP fixture"), "media_source": .string("personal"), "version": .string(version)]))
        let first = repository(); _ = try await first.bootstrap()
        let prepared = try await first.prepareDownload(photo, purpose: .photos)
        try require(NativeDownloadRecord.hash(prepared.bytes) == expectedHash, "real content matches independently supplied fixture hash")
        let before = try journal().operations.last!
        try require(before.phase == .staged && before.effectID == nil, "recorded issuance/content never claim an external save")
        try require(try vault.read("operation-intents") == nil, "canonical download leaves generic mutation lookup unused")
        // Restore the protected journal through a fresh actor and transport.
        let restarted = repository(); _ = try await restarted.bootstrap()
        let phase = try await restarted.downloadStatus(key: before.key)
        try require(phase == .staged, "fresh actor resolves exact original status")
        let resumed = try await restarted.prepareDownload(photo, purpose: .photos)
        let after = try journal().operations.last!
        try require(after.key == before.key && after.capability == before.capability && after.issuedAt == before.issuedAt && after.expiresAt == before.expiresAt,
                    "restart repeats same immutable key/capability/deadline")
        try require(NativeDownloadRecord.hash(resumed.bytes) == expectedHash, "repeat content rechecks actual authority and identical bytes")
        // Simulate process interruption at the durable boundary; no OS call is made.
        let effect = try await restarted.beginDownloadEffect(resumed)
        try require(try journal().operations.last!.phase == .externalStarted, "pre-effect content reauthorization precedes durable external ownership")
        let interrupted = repository(); _ = try await interrupted.bootstrap()
        var blocked = false
        do { _ = try await interrupted.prepareDownload(photo, purpose: .photos) } catch { blocked = true }
        try require(blocked, "restart never automatically repeats an ambiguous external attempt")
        try await restarted.finishDownloadEffect(effect, completed: false)
        try require(try journal().operations.last!.phase == .externalUncertain, "simulated interrupted effect remains unknown, never saved")
        print("Native download HTTP checks passed: \(checks). Local declared synthetic integration; no external save performed.")
    }
}
