import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Controlled private-cache/filesystem fixtures only. No live photos, Keychain,
// camera, physical background delivery or external share recipient is exercised.
private final class MediaClockFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var instant: NativePrivateMediaInstant
    init() { instant = .init(wall: Date(), uptime: 100) }
    func read() -> NativePrivateMediaInstant { lock.lock(); defer { lock.unlock() }; return instant }
    func advance(wall: TimeInterval, uptime: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        instant = .init(wall: instant.wall.addingTimeInterval(wall), uptime: instant.uptime + uptime)
    }
    func setWall(_ wall: Date) { lock.lock(); defer { lock.unlock() }; instant = .init(wall: wall, uptime: instant.uptime) }
    var clock: NativePrivateMediaClock { .init(read: { [self] in read() }) }
}
private final class MediaSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; values[name] = data }
    func names() -> Set<String> { lock.lock(); defer { lock.unlock() }; return Set(values.keys) }
}
private struct MediaSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
}
private actor MediaGate {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var release: CheckedContinuation<Void, Never>?
    func pause() async {
        started = true; startWaiters.forEach { $0.resume() }; startWaiters = []
        await withCheckedContinuation { release = $0 }
    }
    func reached() async { if !started { await withCheckedContinuation { startWaiters.append($0) } } }
    func open() { release?.resume(); release = nil }
}
private actor MediaTransport: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000081"
    private var validationDenied = false, validationHTTPDenied = false
    private var binaryGate: MediaGate?
    private(set) var binaryReads = 0
    nonisolated func cancelPending() {}
    func denyValidation(http: Bool = false) { validationDenied = !http; validationHTTPDenied = http }
    func delayNextBinary(_ gate: MediaGate) { binaryGate = gate }
    private func json(_ value: WireValue, status: Int = 200) throws -> NativeHTTPReply {
        .init(status: status, headers: ["content-type": "application/json"], data: try value.encoded())
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        switch request.url!.path {
        case "/me": return try json(.object(["user_id": .string(Self.account), "auth_method": .string("registered_face"), "authenticated": .bool(true)]))
        case "/me/audience":
            return try json(.object(["protocol": .string(NativeAudienceProjection.protocolName), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(Self.account),
                "audience": .object(["age_band": .string("18_plus"), "status": .string("eligible"), "version": .integer(1), "policy_version": .string(NativeAudienceProjection.policy), "next_review_at": .null]),
                "guardian_request": .null, "capabilities": .object(["face_authentication": .bool(true), "photo_matching": .bool(true), "photo_processing": .bool(true)])]))
        case "/community/action":
            let body = try WireValue.decoded(request.httpBody!)
            guard body["action"].string == "photos.validate", let ids = body["payload"]["asset_ids"].array else { throw NativeAPIError.invalidResponse }
            if validationHTTPDenied { validationHTTPDenied = false; return try json(.object(["error": .object(["code": .string("asset_unavailable")])]), status: 403) }
            let denied = validationDenied; validationDenied = false
            return try json(.object(["authorized_ids": .array(denied ? [] : ids)]))
        default:
            guard request.url!.path.hasPrefix("/community/media/"), request.url!.path.hasSuffix("/preview") else { throw NativeAPIError.invalidResponse }
            binaryReads += 1; let version = binaryReads
            if let gate = binaryGate { binaryGate = nil; await gate.pause() }
            return .init(status: 200, headers: ["content-type": "image/png"], data: Data([0x89, 0x50, 0x4e, 0x47, UInt8(version)]))
        }
    }
}
@main struct NativePrivateMediaTests {
    private static var checks = 0
    private static func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw NativeAPIError.unsupported("Private media check failed: " + label) }; checks += 1
    }
    private static func rejects(_ label: String, _ work: () throws -> Void) throws {
        do { try work() } catch { checks += 1; return }
        throw NativeAPIError.unsupported("Private media rejection missing: " + label)
    }
    private static func rejectsAsync(_ label: String, _ work: () async throws -> Void) async throws {
        do { try await work() } catch { checks += 1; return }
        throw NativeAPIError.unsupported("Private media rejection missing: " + label)
    }
    private static func photo(_ version: String = "v1", id: String = "00000000-0000-4000-8000-000000000082") throws -> NativePhoto {
        try NativePhoto(.object(["id": .string(id), "title": .string("Synthetic fixture"), "media_source": .string("personal"), "version": .string(version)]))
    }
    private static func make(clock: NativePrivateMediaClock = .live, lifetime: Int = 900) async throws -> (BackendRepository, MediaTransport, MediaSecrets) {
        let secrets = MediaSecrets(), transport = MediaTransport(), now = Date()
        let claims: WireValue = .object(["sub": .string(MediaTransport.account), "auth_method": .string("registered_face"), "exp": .integer(Int(now.timeIntervalSince1970) + lifetime + 1)])
        let credential = try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("synthetic-media-refresh"),
            "account_id": .string(MediaTransport.account), "auth_method": .string("registered_face"), "expires_in": .integer(lifetime), "roles": .strings(["user"])]), now: now)
        try secrets.write("credentials", data: JSONEncoder().encode(credential))
        let repository = BackendRepository(origin: URL(string: "https://media-fixture.invalid")!, transport: transport, secrets: secrets, signer: MediaSigner(), privateMediaClock: clock)
        _ = try await repository.bootstrap(); return (repository, transport, secrets)
    }
    static func main() async throws {
        let clock = MediaClockFixture(), created = clock.read(), key = NativePrivateMediaCache.Key(assetID: "synthetic-a", version: "v1")
        let deadline = NativePrivateMediaDeadline(created: created)
        var cache = NativePrivateMediaCache(); let bytes = Data([1, 2, 3])
        cache.insert(bytes, for: key, deadline: deadline, at: created)
        clock.advance(wall: 86_400, uptime: 86_400)
        try require(cache.value(for: key, at: clock.read()) == bytes, "fresh one-day lookup remains usable")
        clock.advance(wall: 86_400, uptime: 86_400)
        try require(cache.value(for: key, at: clock.read()) == nil && cache.retainedByteCount == 0, "a cache hit does not renew the two-day creation deadline")
        let exact = NativePrivateMediaDeadline(created: created, authorityExpiresAt: created.wall.addingTimeInterval(30))
        try require(exact.remaining(at: .init(wall: created.wall.addingTimeInterval(30), uptime: created.uptime + 30)) == 0, "session expiry is an earlier hard bound")
        try require(deadline.remaining(at: .init(wall: created.wall, uptime: created.uptime + 172_800)) == 0, "stalled wall clock cannot extend elapsed age")
        try require(deadline.remaining(at: .init(wall: created.wall.addingTimeInterval(-1), uptime: created.uptime + 1)) == 0, "wall rollback fails closed")
        try require(deadline.remaining(at: .init(wall: created.wall, uptime: created.uptime - 1)) == 0, "elapsed clock rollback fails closed")
        try require(deadline.remaining(at: .init(wall: created.wall, uptime: .nan)) == 0, "invalid clock fails closed")
        let secondKey = NativePrivateMediaCache.Key(assetID: "synthetic-a", version: "v2"), otherKey = NativePrivateMediaCache.Key(assetID: "synthetic-b", version: "v1")
        cache.insert(bytes, for: key, deadline: deadline, at: created); cache.insert(bytes, for: secondKey, deadline: deadline, at: created); cache.insert(bytes, for: otherKey, deadline: deadline, at: created)
        cache.remove(assetID: "synthetic-a")
        try require(cache.value(for: key, at: created) == nil && cache.value(for: secondKey, at: created) == nil && cache.value(for: otherKey, at: created) == bytes, "denial removes all versions of only the denied asset")
        cache.removeAll(); try require(cache.retainedByteCount == 0, "account/media retirement removes retained Data")
        let large = Data(repeating: 0x41, count: 6 * 1024 * 1024)
        cache.insert(large, for: key, deadline: deadline, at: created); cache.insert(large, for: secondKey, deadline: deadline, at: created); cache.insert(large, for: otherKey, deadline: deadline, at: created)
        try require(cache.retainedByteCount == 12 * 1024 * 1024 && cache.value(for: key, at: created) == nil && cache.value(for: otherKey, at: created) != nil, "creation deadlines preserve the existing sixteen-MiB aggregate memory bound")
        cache.removeAll()

        let repositoryClock = MediaClockFixture(), initialWall = repositoryClock.read().wall
        let (repository, transport, secrets) = try await make(clock: repositoryClock.clock)
        let first = try await repository.preview(photo()), repeated = try await repository.preview(photo())
        let firstReads = await transport.binaryReads
        try require(first == repeated && firstReads == 1, "authorized preview validates then reuses a live cache entry")
        _ = try await repository.preview(photo("v2")); await transport.denyValidation()
        try await rejectsAsync("denied asset-ID subset") { _ = try await repository.preview(photo("v2")) }
        let afterDenial = try await repository.preview(photo()), secondVersion = try await repository.preview(photo("v2"))
        let deniedReads = await transport.binaryReads
        try require(first != afterDenial && secondVersion != first && deniedReads == 4, "known denial evicts the actual versioned keys before reauthorization")
        await transport.denyValidation(http: true)
        try await rejectsAsync("explicit HTTP denial") { _ = try await repository.preview(photo()) }
        _ = try await repository.preview(photo()); _ = try await repository.preview(photo("v2"))
        let httpDeniedReads = await transport.binaryReads
        try require(httpDeniedReads == 6, "HTTP denial also evicts every cached version")
        repositoryClock.advance(wall: 0, uptime: 1000)
        await repository.expirePrivateMedia()
        let expiredBytes = await repository.retainedPrivateMediaBytes()
        try require(expiredBytes == 0, "elapsed expiry removes bytes even without another media access")
        _ = try await repository.preview(photo()); let expiryReads = await transport.binaryReads
        try require(expiryReads == 7, "expired bytes require a new authorized download")
        let delayed = MediaGate(); await transport.delayNextBinary(delayed)
        let late = Task { try await repository.preview(photo("v3")) }
        await delayed.reached(); repositoryClock.advance(wall: 172_801, uptime: 172_801); await delayed.open()
        try await rejectsAsync("late expired download publication") { _ = try await late.value }
        let lateBytes = await repository.retainedPrivateMediaBytes()
        try require(lateBytes == 0, "an expired late reply does not retain old or new private bytes")
        repositoryClock.setWall(initialWall)
        _ = try await repository.preview(photo("v3")); let recoveredReads = await transport.binaryReads
        try require(recoveredReads == 9, "a later authorized attempt refetches instead of resurrecting expired bytes")
        let retirement = MediaGate(); await transport.delayNextBinary(retirement)
        let retired = Task { try await repository.preview(photo("v4")) }
        await retirement.reached(); await repository.retireMedia(); await retirement.open()
        try await rejectsAsync("late media-generation publication") { _ = try await retired.value }
        _ = try await repository.preview(photo("v4")); let retiredReads = await transport.binaryReads
        try require(retiredReads == 11, "retired generation cannot populate the next cache")
        let restarted = BackendRepository(origin: URL(string: "https://media-fixture.invalid")!, transport: transport, secrets: secrets, signer: MediaSigner(), privateMediaClock: repositoryClock.clock)
        _ = try await restarted.bootstrap(); _ = try await restarted.preview(photo("v4"))
        let restartReads = await transport.binaryReads
        try require(restartReads == 12 && secrets.names() == ["credentials"], "restart retains no preview bytes in protected journals or disk")

        let (expiring, _, _) = try await make(lifetime: 3)
        _ = try await expiring.preview(photo())
        let retained = await expiring.retainedPrivateMediaBytes(); try require(retained > 0, "short authority fixture actually caches bytes")
        let timerEnd = Date().addingTimeInterval(6)
        while await expiring.retainedPrivateMediaBytes() > 0, Date() < timerEnd { try await Task.sleep(for: .milliseconds(20)) }
        let afterTimer = await expiring.retainedPrivateMediaBytes()
        try require(afterTimer == 0, "foreground timer retires Data at session expiry without a request or lifecycle event")
        await expiring.retireMedia(); await repository.retireMedia(); await restarted.retireMedia()

        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-private-media-tests-" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = NativeAuthorizedShareFiles(directory: root.appendingPathComponent("share", isDirectory: true))
        let shared = try files.create(Data("synthetic-private-share".utf8), extension: "jpg")
        let unknown = files.directory.appendingPathComponent("unrecognized-user-file.txt")
        try Data("preserve-unknown".utf8).write(to: unknown)
        let uploadDirectory = root.appendingPathComponent("LoveliesPrivateUploads", isDirectory: true)
        try FileManager.default.createDirectory(at: uploadDirectory, withIntermediateDirectories: true)
        let upload = uploadDirectory.appendingPathComponent(UUID().uuidString.lowercased() + ".jpg")
        let saved = root.appendingPathComponent("user-saved.jpg")
        try Data("preserve-seven-day-upload".utf8).write(to: upload); try Data("preserve-user-copy".utf8).write(to: saved)
        let symlink = files.directory.appendingPathComponent(UUID().uuidString.lowercased() + ".jpg")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: saved)
        try files.prune(keeping: shared)
        try require(FileManager.default.fileExists(atPath: shared.path), "current unexpired presentation survives foreground cleanup")
        let creation = try shared.resourceValues(forKeys: [.creationDateKey]).creationDate!
        try FileManager.default.setAttributes([.modificationDate: creation.addingTimeInterval(300_000)], ofItemAtPath: shared.path)
        try files.prune(keeping: shared, now: creation.addingTimeInterval(172_800))
        try require(!FileManager.default.fileExists(atPath: shared.path), "even a displayed file expires from creation; mtime does not renew it")
        try require(try Data(contentsOf: unknown) == Data("preserve-unknown".utf8) && Data(contentsOf: upload) == Data("preserve-seven-day-upload".utf8) && Data(contentsOf: saved) == Data("preserve-user-copy".utf8), "cleanup preserves unknown files, durable uploads and user-saved output")
        try require(try FileManager.default.destinationOfSymbolicLink(atPath: symlink.path) == saved.path, "cleanup does not follow or remove a symlink")
        let orphan = try files.create(Data("synthetic-unpublished-share".utf8), extension: "json")
        try NativeAuthorizedShareFiles(directory: files.directory).prune()
        try require(!FileManager.default.fileExists(atPath: orphan.path), "restart retires unpublished app-owned share copies")
        try rejects("unsupported share extension") { _ = try files.create(Data([1]), extension: "txt") }
        let linkedRoot = root.appendingPathComponent("linked-share", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: uploadDirectory)
        try rejects("share-root symlink cleanup") { try NativeAuthorizedShareFiles(directory: linkedRoot).prune() }
        try rejects("share-root symlink write") { _ = try NativeAuthorizedShareFiles(directory: linkedRoot).create(Data([9]), extension: "jpg") }
        let missingTarget = root.appendingPathComponent("never-create-this", isDirectory: true), danglingRoot = root.appendingPathComponent("dangling-share", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: danglingRoot, withDestinationURL: missingTarget)
        try rejects("dangling share-root write") { _ = try NativeAuthorizedShareFiles(directory: danglingRoot).create(Data([9]), extension: "jpg") }
        try require(!FileManager.default.fileExists(atPath: missingTarget.path) && (try Data(contentsOf: upload)) == Data("preserve-seven-day-upload".utf8), "root symlinks cannot create or mutate their destinations")
        print("Native private media checks passed: \(checks)")
    }
}
