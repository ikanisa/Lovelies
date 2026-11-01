import Foundation
import Security
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct NativeHTTPReply: Sendable { let status: Int, headers: [String: String], data: Data }
protocol NativeTransport: Sendable {
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply
    func cancelPending()
}
private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
final class NativeURLTransport: NativeTransport, @unchecked Sendable {
    private let session: URLSession
    private let redirects = RefuseRedirects()
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 20
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCache = nil
        session = URLSession(configuration: configuration)
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let (stream, response) = try await session.bytes(for: request, delegate: redirects)
        guard let response = response as? HTTPURLResponse else { throw NativeAPIError.invalidResponse }
        if response.expectedContentLength > Int64(limit) { throw NativeAPIError.invalidResponse }
        var data = Data(); data.reserveCapacity(min(limit, 64 * 1024))
        for try await byte in stream {
            guard data.count < limit else { throw NativeAPIError.invalidResponse }; data.append(byte)
            if Task.isCancelled { throw CancellationError() }
        }
        let headers = Dictionary(uniqueKeysWithValues: response.allHeaderFields.compactMap { key, value in
            guard let key = key as? String, let value = value as? String else { return nil as (String, String)? }; return (key.lowercased(), value)
        })
        return NativeHTTPReply(status: response.statusCode, headers: headers, data: data)
    }
    func cancelPending() { session.getAllTasks { $0.forEach { $0.cancel() } } }
}

enum NativeConfiguration {
    static func origin() throws -> URL {
        #if DEBUG && targetEnvironment(simulator)
        let configured = Bundle.main.object(forInfoDictionaryKey: "LoveliesAPIOrigin") as? String
        let value = configured.flatMap { $0.isEmpty || $0.contains("$(") ? nil : $0 } ?? "http://localhost:8787"
        #else
        let value = Bundle.main.object(forInfoDictionaryKey: "LoveliesAPIOrigin") as? String ?? ""
        #endif
        #if DEBUG && targetEnvironment(simulator)
        return try validatedOrigin(value, allowLocalHTTP: true)
        #else
        return try validatedOrigin(value)
        #endif
    }
    static func validatedOrigin(_ value: String, allowLocalHTTP: Bool = false) throws -> URL {
        guard value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.unicodeScalars.contains(where: { $0.value <= 32 }),
              let components = URLComponents(string: value), let url = components.url,
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.percentEncodedPath == components.path else {
            throw NativeAPIError.unsupported(String(localized: "Configure the Lovelies HTTPS API origin before connecting this app."))
        }
        let localHTTP = allowLocalHTTP && components.scheme == "http" && ["localhost", "127.0.0.1"].contains(host)
        let path = components.percentEncodedPath
        guard (components.scheme == "https" && (allowLocalHTTP || components.port == nil || components.port == 443)) || localHTTP,
              ["/functions/v1/lovelies-api", "/functions/v1/lovelies-api/"].contains(path) || allowLocalHTTP && ["", "/"].contains(path) else {
            throw NativeAPIError.unsupported(String(localized: "Use HTTPS for this API origin."))
        }
        var normalized = components
        if normalized.percentEncodedPath.hasSuffix("/") { normalized.percentEncodedPath.removeLast() }
        guard let result = normalized.url else { throw NativeAPIError.invalidResponse }
        return result
    }

}

/// App-owned media is bounded by both elapsed process time and wall time. A
/// clock rollback cannot extend a retained preview or a temporary share lease.
struct NativePrivateMediaInstant: Sendable {
    let wall: Date, uptime: TimeInterval
}
struct NativePrivateMediaClock: Sendable {
    let read: @Sendable () -> NativePrivateMediaInstant
    static let live = Self { .init(wall: Date(), uptime: ProcessInfo.processInfo.systemUptime) }
}
struct NativePrivateMediaDeadline: Sendable {
    static let maximumAge: TimeInterval = 2 * 24 * 60 * 60
    let created: NativePrivateMediaInstant
    private let lifetime: TimeInterval
    init(created: NativePrivateMediaInstant, authorityExpiresAt: Date? = nil) {
        self.created = created
        lifetime = min(Self.maximumAge, authorityExpiresAt.map { max(0, $0.timeIntervalSince(created.wall)) } ?? Self.maximumAge)
    }
    func remaining(at now: NativePrivateMediaInstant) -> TimeInterval {
        guard created.wall.timeIntervalSince1970.isFinite, created.uptime.isFinite, lifetime.isFinite,
              now.wall.timeIntervalSince1970.isFinite, now.uptime.isFinite,
              now.wall >= created.wall, now.uptime >= created.uptime else { return 0 }
        return max(0, min(lifetime - now.wall.timeIntervalSince(created.wall), lifetime - (now.uptime - created.uptime)))
    }
}
struct NativePrivateMediaCache: Sendable {
    struct Key: Hashable, Sendable { let assetID: String, version: String }
    private struct Entry: Sendable { let bytes: Data, deadline: NativePrivateMediaDeadline }
    private var entries: [Key: Entry] = [:], order: [Key] = []
    private let maximumBytes = 16 * 1024 * 1024
    var retainedByteCount: Int { entries.values.reduce(0) { $0 + $1.bytes.count } }
    mutating func removeAll() { entries.removeAll(); order.removeAll() }
    mutating func remove(assetID: String) {
        entries = entries.filter { $0.key.assetID != assetID }; order.removeAll { $0.assetID == assetID }
    }
    mutating func expire(at now: NativePrivateMediaInstant) {
        entries = entries.filter { $0.value.deadline.remaining(at: now) > 0 }
        order.removeAll { entries[$0] == nil }
    }
    mutating func value(for key: Key, at now: NativePrivateMediaInstant) -> Data? {
        expire(at: now); return entries[key]?.bytes
    }
    mutating func insert(_ bytes: Data, for key: Key, deadline: NativePrivateMediaDeadline, at now: NativePrivateMediaInstant) {
        expire(at: now)
        guard !bytes.isEmpty, bytes.count <= maximumBytes, deadline.remaining(at: now) > 0 else { return }
        order.removeAll { $0 == key }; entries[key] = Entry(bytes: bytes, deadline: deadline); order.append(key)
        while retainedByteCount > maximumBytes, let first = order.first { order.removeFirst(); entries.removeValue(forKey: first) }
    }
    func nextExpiryDelay(at now: NativePrivateMediaInstant) -> TimeInterval? {
        entries.values.map { $0.deadline.remaining(at: now) }.min()
    }
}

/// The only managed disk copies here are UUID-named files directly inside the
/// private share directory. Upload recovery and the user's Photos/Files are not
/// children of this directory and never participate in this cleanup.
struct NativeAuthorizedShareFiles: Sendable {
    let directory: URL
    static let extensions: Set<String> = ["json", "jpg", "png", "webp", "heic"]
    init(directory: URL = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-authorized-share", isDirectory: true)) {
        self.directory = directory.standardizedFileURL
    }
    private func verifiedDirectory(create: Bool) throws -> Bool {
        guard (try? FileManager.default.destinationOfSymbolicLink(atPath: directory.path)) == nil else { throw NativeAPIError.invalidResponse }
        if !FileManager.default.fileExists(atPath: directory.path) {
            guard create else { return false }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        }
        let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
        return true
    }
    private func ownedRegularFile(_ url: URL) throws -> Bool {
        guard url.standardizedFileURL.deletingLastPathComponent() == directory,
              UUID(uuidString: url.deletingPathExtension().lastPathComponent) != nil,
              Self.extensions.contains(url.pathExtension) else { return false }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        return values.isRegularFile == true && values.isSymbolicLink != true
    }
    func create(_ data: Data, extension ext: String) throws -> URL {
        guard Self.extensions.contains(ext), try verifiedDirectory(create: true) else { throw NativeAPIError.invalidResponse }
        let url = directory.appendingPathComponent(UUID().uuidString.lowercased()).appendingPathExtension(ext)
        try data.write(to: url, options: [.atomic, .completeFileProtection]); return url
    }
    func create(copying source: URL) throws -> URL {
        guard source.isFileURL, try verifiedDirectory(create: true),
              (try? FileManager.default.destinationOfSymbolicLink(atPath: source.path)) == nil else { throw NativeAPIError.invalidResponse }
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
        let destination = directory.appendingPathComponent(UUID().uuidString.lowercased()).appendingPathExtension("json")
        try FileManager.default.copyItem(at: source, to: destination)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: destination.path)
        return destination
    }
    /// Keep only a live, known presentation. Missing timestamps and files dated
    /// in the future fail closed; rewriting a file does not renew its birth time.
    func prune(keeping: URL? = nil, now: Date = Date()) throws {
        guard try verifiedDirectory(create: false) else { return }
        var firstFailure: (any Error)?
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.creationDateKey, .isRegularFileKey, .isSymbolicLinkKey]) {
            do {
                guard try ownedRegularFile(url) else { continue }
                let created = try url.resourceValues(forKeys: [.creationDateKey]).creationDate
                let age = created.map { now.timeIntervalSince($0) }
                let live = age.map { $0 >= 0 && $0 < NativePrivateMediaDeadline.maximumAge } ?? false
                if url.standardizedFileURL != keeping?.standardizedFileURL || !live { try FileManager.default.removeItem(at: url) }
            } catch { if firstFailure == nil { firstFailure = error } }
        }
        if let firstFailure { throw firstFailure }
    }
}

/// Export delivery uses a separate protected staging directory. A deterministic
/// file identity is journaled before bytes are written; a crash between the
/// atomic write and its journal update can rediscover exactly those bytes.
private enum NativeExportStagingLocks {
    static let registry = NSLock()
    nonisolated(unsafe) static var locks: [String: NSRecursiveLock] = [:]
    static func get(_ path: String) -> NSRecursiveLock {
        registry.lock(); defer { registry.unlock() }
        if let held = locks[path] { return held }
        let held = NSRecursiveLock(); locks[path] = held; return held
    }
}
struct NativeExportStagingFiles: Sendable {
    let directory: URL
    init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("lovelies-export-deliveries", isDirectory: true)) { self.directory = directory.standardizedFileURL }
    private func file(_ id: String, create: Bool) throws -> URL {
        guard UUID(uuidString: id) != nil, (try? FileManager.default.destinationOfSymbolicLink(atPath: directory.path)) == nil else { throw NativeAPIError.invalidResponse }
        if !FileManager.default.fileExists(atPath: directory.path), create {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            var root = directory; try root.setResourceValues(values)
        }
        if FileManager.default.fileExists(atPath: directory.path) {
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
        }
        return directory.appendingPathComponent(id.lowercased()).appendingPathExtension("json")
    }
    private var lock: NSRecursiveLock { NativeExportStagingLocks.get(directory.path) }
    func read(_ id: String, maximum: Int = 20 * 1024 * 1024) throws -> Data? {
        let lock = lock; lock.lock(); defer { lock.unlock() }
        let url = try file(id, create: false)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, let count = values.fileSize,
              maximum > 0, (1...maximum).contains(count) else { throw NativeAPIError.invalidResponse }
        let data = try Data(contentsOf: url)
        guard data.count == count else { throw NativeAPIError.invalidResponse }; return data
    }
    func stage(_ data: Data, id: String, maximum: Int = 20 * 1024 * 1024) throws {
        let lock = lock; lock.lock(); defer { lock.unlock() }
        guard maximum > 0, (1...maximum).contains(data.count) else { throw NativeAPIError.invalidResponse }
        let url = try file(id, create: true)
        if let saved = try read(id, maximum: maximum) { guard saved == data else { throw NativeAPIError.invalidResponse } }
        else { try data.write(to: url, options: [.atomic, .completeFileProtection]) }
        let handle = try FileHandle(forWritingTo: url)
        do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
        guard try read(id, maximum: maximum) == data else { throw NativeAPIError.unavailable("export_staging_unconfirmed") }
    }
    /// Resume a previous assembly only after checking every existing byte
    /// against the verified chunks. Unknown or corrupt bytes are never truncated.
    func assemble(id: String, bytes: Int, hash: String, current: () throws -> Void,
                  pump: (_ sink: (Data) throws -> Void) throws -> Void) throws -> URL {
        let lock = lock; lock.lock(); defer { lock.unlock() }
        guard bytes > 0, NativeExportManifestPage.validHash(hash) else { throw NativeAPIError.invalidResponse }
        try current()
        let url = try file(id, create: true)
        if !FileManager.default.fileExists(atPath: url.path) { try Data().write(to: url, options: [.withoutOverwriting, .completeFileProtection]) }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, let existing = values.fileSize,
              existing >= 0, existing <= bytes else { throw NativeAPIError.invalidResponse }
        let handle = try FileHandle(forUpdating: url)
        defer { try? handle.close() }
        var total = 0, digest = SHA256()
        do {
            try pump { data in
                try current()
                guard !data.isEmpty, data.count <= NativeExportManifestPage.chunkBytes, total <= bytes - data.count else { throw NativeAPIError.invalidResponse }
                let overlap = min(data.count, max(0, existing - total))
                if overlap > 0 {
                    var prefix = Data()
                    while prefix.count < overlap {
                        guard let part = try handle.read(upToCount: overlap - prefix.count), !part.isEmpty else { throw NativeAPIError.invalidResponse }
                        prefix.append(part)
                    }
                    guard prefix == data.prefix(overlap) else { throw NativeAPIError.invalidResponse }
                }
                try current()
                if overlap < data.count { try handle.write(contentsOf: data.dropFirst(overlap)) }
                digest.update(data: data); total += data.count
                try current()
            }
            guard total == bytes, digest.finalize().map({ String(format: "%02x", $0) }).joined() == hash else { throw NativeAPIError.invalidResponse }
            try current(); try handle.synchronize(); try handle.close()
        } catch { try? handle.synchronize(); throw error }
        return try verifiedURL(id, bytes: bytes, hash: hash, current: current)
    }
    func verifiedURL(_ id: String, bytes: Int, hash: String, current: () throws -> Void = {}) throws -> URL {
        let lock = lock; lock.lock(); defer { lock.unlock() }
        let url = try file(id, create: false)
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, values.fileSize == bytes, bytes > 0 else { throw NativeAPIError.invalidResponse }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var digest = SHA256(), count = 0
        while let data = try handle.read(upToCount: NativeExportManifestPage.chunkBytes), !data.isEmpty {
            try current(); guard count <= bytes - data.count else { throw NativeAPIError.invalidResponse }
            digest.update(data: data); count += data.count
        }
        guard count == bytes, digest.finalize().map({ String(format: "%02x", $0) }).joined() == hash else { throw NativeAPIError.invalidResponse }
        try current(); return url
    }
    func removeValidatedPrefix(_ id: String, maximum: Int, pump: (_ sink: (Data) throws -> Void) throws -> Void) throws {
        let lock = lock; lock.lock(); defer { lock.unlock() }
        let url = try file(id, create: false)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, let count = values.fileSize,
              count >= 0, count <= maximum else { throw NativeAPIError.invalidResponse }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var checked = 0
        try pump { data in
            let overlap = min(data.count, count - checked)
            if overlap > 0 {
                var prefix = Data()
                while prefix.count < overlap {
                    guard let part = try handle.read(upToCount: overlap - prefix.count), !part.isEmpty else { throw NativeAPIError.invalidResponse }
                    prefix.append(part)
                }
                guard prefix == data.prefix(overlap) else { throw NativeAPIError.invalidResponse }; checked += overlap
            }
        }
        guard checked == count else { throw NativeAPIError.invalidResponse }
        try handle.close(); try remove(id)
    }
    func removeVerifiedComplete(_ id: String, bytes: Int, hash: String) throws -> Bool {
        let lock = lock; lock.lock(); defer { lock.unlock() }
        let url = try file(id, create: false)
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
        guard values.fileSize == bytes else { return false }
        _ = try verifiedURL(id, bytes: bytes, hash: hash)
        try remove(id); return true
    }
    func remove(_ id: String) throws {
        let lock = lock; lock.lock(); defer { lock.unlock() }
        let url = try file(id, create: false)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw NativeAPIError.invalidResponse }
        try FileManager.default.removeItem(at: url)
    }
}

/// Process-local, single-use continuation identity. Receipt and credential
/// material remain inside the repository; a caller cannot manufacture a ticket.
struct NativeGuestSetupResumeTicket: Sendable {
    fileprivate let id: UUID
}
enum NativeLocalTransitionKind: Sendable { case accountRecoveryStart, profileCancellation }
struct NativeLocalTransitionTicket: Sendable { fileprivate let id: UUID }

/// Independent of the repository executor and protected-storage locks. Logout
/// can close publication/admission immediately while durable cleanup is queued.
final class NativeSessionRetirementFence: @unchecked Sendable {
    private let lock = NSLock()
    private let clock: NativeAuthorityClock
    private var retiring = false
    init(clock: NativeAuthorityClock = NativeAuthorityClock()) { self.clock = clock }
    func snapshot() -> (generation: Int, retiring: Bool) {
        lock.lock(); defer { lock.unlock() }; return (clock.snapshot(), retiring)
    }
    @discardableResult func retire() -> Int {
        lock.lock(); defer { lock.unlock() }
        let generation = retiring ? clock.snapshot() : clock.advance(); retiring = true; return generation
    }
    func complete(_ expected: Int) {
        lock.lock(); defer { lock.unlock() }; if clock.snapshot() == expected { retiring = false }
    }
    func permits(_ expected: Int) -> Bool {
        let state = snapshot(); return !state.retiring && state.generation == expected
    }
}

actor BackendRepository {
    private let origin: URL, transport: any NativeTransport, secrets: any NativeSecretStore, signer: any NativeDeviceSigner
    private let sessionRetirement: NativeSessionRetirementFence
    private let authorityLedger: NativeAuthorityLedger
    private var retiredCredentialDigests: Set<String> = []
    private var retirementPersistenceError: NativeAPIError?
    private var credentials: NativeCredentials? {
        didSet {
            if !Self.sameCredentials(oldValue, credentials) {
                invalidateLocalSigning(); localPromotionActivation = nil; preparedGuestResume = nil; preparedLocalTransition = nil
            }
        }
    }
    private var epoch = 0 { didSet { if oldValue != epoch { invalidateLocalSigning(); localPromotionActivation = nil; preparedGuestResume = nil; preparedLocalTransition = nil } } }
    private struct LocalPromotionActivation: Equatable {
        let intent: String, credential: String
        let epoch: Int
    }
    private var localPromotionActivation: LocalPromotionActivation?
    private var localSigningLease: NativeLocalSigningLease?
    private var localSigningCredentialDigest: String?
    private var preparedLocalSigning: NativeLocalAuthenticationBinding?
    private struct LocalTransitionPreparation {
        let ticket: NativeLocalTransitionTicket, kind: NativeLocalTransitionKind
        let account: String, alias: String, intent: String, stateDigest: String
        let epoch: Int, serial: Int, issuedAt: TimeInterval
    }
    private var preparedLocalTransition: LocalTransitionPreparation?
    private var intents: [NativeOperationIntent] = []
    private var appleStoreWork: Set<String> = []
    private var applePurchaseBusy: Set<String> = []
    private var applePurchaseUncertainRecords: [NativeApplePurchaseRecord] = []
    private var uploads: [NativeUploadRecord] = []
    private var uploadBatches: [NativeResumableUploadBatch] = []
    private var uploadSerial = 0, uploadBusy = false
    private var uploadRetirement: Task<Void, Never>?
    private var registeredDeletionCleanupBusy = false
    private let uploadFiles: NativeUploadPrivateFiles
    private let exportFiles: NativeExportStagingFiles
    private var exportWork: Set<String> = []
    private var exportExpiryTasks: [String: Task<Void, Never>] = [:]
    private let uploadTransport: any NativeUploadFileTransport
    private var guestDeletion: NativeGuestDeletionRecord?
    private var guestDeletionSerial = 0
    private var guestDeletionBusy = false
    private struct GuestResumePreparation {
        let ticket: NativeGuestSetupResumeTicket
        let scope: Scope
        let receiptDigest: String, stateDigest: String
        let serial: Int, issuedAt: TimeInterval
    }
    private var preparedGuestResume: GuestResumePreparation?
    private var enrollment: NativeEnrollmentRecord?
    private var enrollmentSerial = 0
    private var enrollmentBusy = false
    private var accountRecovery: NativeAccountRecoveryRecord?
    private var recoverySerial = 0, recoveryBusy = false
    private var recoveryArchives: [NativeAccountRecoveryRecord] = []
    private var faceLifecycle: NativeFaceLifecycleRecord?
    private var lifecycleArchives: [NativeFaceLifecycleRecord] = []
    private var lifecycleSerial = 0, lifecycleBusy = false
    private var ordinaryLogin: NativeOrdinaryLoginRecord?
    private var audienceProjection: NativeAudienceProjection?
    private var audienceProjectionEpoch: Int?
    private var audienceMutationBusy = false
    private var audienceSuspension: NativeAudienceSuspensionRecord?
    private var mediaEpoch = 0
    private var media = NativePrivateMediaCache()
    private var mediaExpiryTask: Task<Void, Never>?
    private let privateMediaClock: NativePrivateMediaClock
    init(origin: URL, transport: any NativeTransport = NativeURLTransport(), secrets: any NativeSecretStore = KeychainSecretStore(), signer: any NativeDeviceSigner = KeychainDeviceSigner(), uploadFiles: NativeUploadPrivateFiles = NativeUploadPrivateFiles(), uploadTransport: (any NativeUploadFileTransport)? = nil, privateMediaClock: NativePrivateMediaClock = .live, exportFiles: NativeExportStagingFiles = NativeExportStagingFiles()) {
        self.origin = origin; self.transport = transport; self.signer = signer; self.uploadFiles = uploadFiles
        let ledger = NativeAuthorityLedger(store: secrets, origin: origin)
        self.authorityLedger = ledger; self.sessionRetirement = NativeSessionRetirementFence(clock: ledger.clock)
        self.secrets = NativeOwnedSecretStore(base: secrets, ledger: ledger)
        self.exportFiles = exportFiles
        self.uploadTransport = uploadTransport ?? NativeFileURLUploadTransport.shared
        self.privateMediaClock = privateMediaClock
    }
    /// Reads existing vault slots only. No key or network work precedes the
    /// system's authorization of this exact interactive signing operation.
    func prepareLocalSigning(purpose: NativeLocalAuthenticationPurpose, operationID: UUID,
                             recoveryBackup: String? = nil, retainedEnrollmentOnly: Bool = false,
                             guestResume: NativeGuestSetupResumeTicket? = nil,
                             transition: NativeLocalTransitionTicket? = nil) throws -> NativeLocalAuthenticationBinding? {
        try authorityLedger.restore()
        localSigningLease?.retire(); localSigningLease = nil; localSigningCredentialDigest = nil; preparedLocalSigning = nil
        if let transition {
            guard guestResume == nil, !retainedEnrollmentOnly else { throw NativeLocalAuthenticationIssue.bindingChanged }
            let prepared = try requireLocalTransition(transition)
            guard purpose == (prepared.kind == .accountRecoveryStart ? .accountRecovery : .profileControl) else { throw NativeLocalAuthenticationIssue.bindingChanged }
            if prepared.kind == .accountRecoveryStart {
                guard let recoveryBackup, let record = accountRecovery else { throw NativeLocalAuthenticationIssue.bindingChanged }
                let parsed = try NativeAccountRecoveryRecord.backup(recoveryBackup)
                guard parsed.0 == record.accountID, parsed.1 == record.recoveryKey else { throw NativeLocalAuthenticationIssue.bindingChanged }
            } else if recoveryBackup != nil { throw NativeLocalAuthenticationIssue.bindingChanged }
            guard signer.requiresLocalAuthentication else { return nil }
            let binding = try NativeLocalAuthenticationBinding(operationID: operationID, purpose: purpose,
                accountID: prepared.account, epoch: epoch, aliases: [prepared.alias], stateDigest: prepared.stateDigest)
            preparedLocalSigning = binding; return binding
        }
        if let guestResume {
            guard purpose == .reconciliation, !retainedEnrollmentOnly, recoveryBackup == nil else { throw NativeLocalAuthenticationIssue.bindingChanged }
            let prepared = try requireGuestResume(guestResume)
            guard signer.requiresLocalAuthentication, let enrollment else { return nil }
            let binding = try NativeLocalAuthenticationBinding(operationID: operationID, purpose: purpose,
                accountID: prepared.scope.account!, epoch: epoch, aliases: [enrollment.keyAlias], stateDigest: prepared.stateDigest)
            preparedLocalSigning = binding; return binding
        }
        guard signer.requiresLocalAuthentication else { return nil }
        // Receipt recovery does not sign. Inspect its own bounded authority
        // before unrelated identity slots, which may be stale after deletion.
        if try registeredDeletionReceipt() != nil { return nil }
        for (name, maximum) in [("guest-deletion-receipt", 16 * 1024), ("audience-suspended-authority", 32 * 1024)] {
            if let bytes = try secrets.read(name) {
                guard bytes.count <= maximum else { throw NativeLocalAuthenticationIssue.bindingChanged }
                return nil
            }
        }
        let slots = try localSigningSlots()
        if retainedEnrollmentOnly {
            guard purpose == .reconciliation, recoveryBackup == nil else { throw NativeLocalAuthenticationIssue.bindingChanged }
            if slots["face-enrollment-journal"] == nil { return nil }
        }
        // These paths use their own existing private receipt/anonymous guards.
        // A face journal must not turn guest privacy into an OS-auth prerequisite.
        if slots["guest-deletion-receipt"] != nil || slots["registered-deletion-receipt"] != nil || slots["audience-suspended-authority"] != nil { return nil }
        let identities = try hydrateLocalSigningState(slots)
        if retainedEnrollmentOnly && enrollment == nil { return nil }
        if purpose == .connect && enrollment == nil && ordinaryLogin == nil && accountRecovery == nil && faceLifecycle == nil { return nil }
        let stored = try slots["credentials"].map { try JSONDecoder().decode(NativeCredentials.self, from: $0) }
        let recoveryAccount = try recoveryBackup.map { try NativeAccountRecoveryRecord.backup($0).0 }
        guard let account = recoveryAccount ?? identities.first?.account ?? credentials?.account_id ?? stored?.account_id else {
            throw NativeLocalAuthenticationIssue.bindingChanged
        }
        guard identities.allSatisfy({ $0.account == account }),
              credentials == nil || credentials?.account_id == account || credentials?.authenticated == false,
              stored == nil || stored?.account_id == account || stored?.authenticated == false else {
            throw NativeLocalAuthenticationIssue.bindingChanged
        }
        let retainedAlias = try device()?.keyAlias ?? NativeEnrollmentRecord.keyAlias
        var aliases: Set<String>
        switch purpose {
        case .enrollment: aliases = [enrollment?.keyAlias ?? ordinaryLogin?.keyAlias ?? retainedAlias]
        case .accountRecovery: aliases = [accountRecovery?.keyAlias ?? retainedAlias]
        case .profileControl: aliases = [faceLifecycle?.keyAlias ?? retainedAlias]
        case .capture:
            aliases = [accountRecovery?.keyAlias ?? faceLifecycle?.keyAlias ?? enrollment?.keyAlias ?? ordinaryLogin?.keyAlias ?? retainedAlias]
        case .connect, .reconciliation:
            aliases = Set(identities.map(\.alias)); if aliases.isEmpty { aliases.insert(retainedAlias) }
        }
        if retainedEnrollmentOnly, let enrollment { aliases = [enrollment.keyAlias] }
        if purpose == .accountRecovery, recoveryBackup != nil, accountRecovery == nil { throw NativeLocalAuthenticationIssue.required }
        let binding = try NativeLocalAuthenticationBinding(operationID: operationID, purpose: purpose,
            accountID: account, epoch: epoch, aliases: aliases, stateDigest: localSigningStateDigest(slots))
        preparedLocalSigning = binding; return binding
    }
    private func localSigningSlots() throws -> [String: Data] {
        var slots: [String: Data] = [:]
        let limits = ["credentials": 16 * 1024, "registered-device": 32 * 1024, "pending-face-device": 32 * 1024,
                      "face-enrollment-journal": 32 * 1024, "ordinary-face-login-journal": 32 * 1024,
                      "account-recovery-journal": 32 * 1024, "face-profile-lifecycle": 128 * 1024,
                      "retired-account-recoveries": 512 * 1024, "retired-face-profile-controls": 2 * 1024 * 1024,
                      "refresh-delivery-journal-v1": 128 * 1024, "guest-deletion-receipt": 16 * 1024,
                      "registered-deletion-receipt": NativeRegisteredDeletionRecord.maximumEncodedBytes, "audience-suspended-authority": 32 * 1024,
                      "audience-device-renewals": 256 * 1024]
        for (name, maximum) in limits {
            if let bytes = try secrets.read(name) {
                guard bytes.count <= maximum else { throw NativeLocalAuthenticationIssue.bindingChanged }
                slots[name] = bytes
            }
        }
        return slots
    }
    private static func sameCredentials(_ first: NativeCredentials?, _ second: NativeCredentials?) -> Bool {
        first?.account_id == second?.account_id && first?.access_token == second?.access_token &&
        first?.refresh_token == second?.refresh_token && first?.auth_method == second?.auth_method &&
        first?.expires_in == second?.expires_in && first?.expiresAt == second?.expiresAt && first?.roles == second?.roles &&
        first?.localAuthorityGeneration == second?.localAuthorityGeneration
    }
    private func localEncodedDigest<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return NativeLocalSigningLease.digest(try encoder.encode(value))
    }
    private func localPromotion<T: Encodable>(_ journal: T, credential: NativeCredentials) throws -> LocalPromotionActivation {
        LocalPromotionActivation(intent: String(describing: T.self) + ":" + (try localEncodedDigest(journal)), credential: try localEncodedDigest(credential), epoch: epoch)
    }
    /// Promote once for the exact staged journal and complete credential. A
    /// different intent, token, session, or repository epoch is a new transition.
    private func activateLocalPromotion<T: Encodable>(_ next: NativeCredentials, journal: T) throws {
        if signer.requiresLocalAuthentication,
           Self.sameCredentials(credentials, next), localPromotionActivation == (try localPromotion(journal, credential: next)) { return }
        guard credentialCurrent(next) else { throw NativeAPIError.sessionChanged }
        credentials = next; epoch += 1; retireMedia()
        if signer.requiresLocalAuthentication { localPromotionActivation = try localPromotion(journal, credential: next) }
    }
    private func requireLocalPromotionBinding() throws {
        guard let activation = localPromotionActivation else { return }
        let decoder = JSONDecoder()
        func require<T: Codable>(_ record: T, credential: NativeCredentials, slot: String) throws {
            guard Self.sameCredentials(credentials, credential),
                  try localPromotion(record, credential: credential) == activation,
                  let data = try secrets.read(slot),
                  try localPromotion(decoder.decode(T.self, from: data), credential: credential) == activation else {
                throw NativeLocalAuthenticationIssue.bindingChanged
            }
        }
        do {
            if let record = faceLifecycle, record.blocksAlternateRecovery || accountRecovery == nil,
               let staged = record.promotionCredentials { try require(record, credential: staged, slot: "face-profile-lifecycle") }
            else if let record = accountRecovery, let staged = record.promotionCredentials { try require(record, credential: staged, slot: "account-recovery-journal") }
            else if let record = enrollment, let staged = record.promotionCredentials { try require(record, credential: staged, slot: "face-enrollment-journal") }
            else if let record = ordinaryLogin, let staged = record.promotionCredentials { try require(record, credential: staged, slot: "ordinary-face-login-journal") }
            else { throw NativeLocalAuthenticationIssue.bindingChanged }
        } catch { invalidateLocalSigning(); throw error }
    }
    private func validLocalDevice(_ device: RegisteredDevice) throws {
        guard UUID(uuidString: device.accountID) != nil, device.accountID == device.accountID.lowercased(),
              UUID(uuidString: device.deviceID) != nil, NativeAccountRecoveryRecord.validSecret(device.faceHandle, prefix: "lfh_"),
              NativeAccountRecoveryRecord.validAlias(device.keyAlias ?? NativeEnrollmentRecord.keyAlias),
              (device.profileID == nil && device.profileRevision == nil && device.modelID == nil) ||
                (device.profileID.flatMap(UUID.init(uuidString:)) != nil && device.profileRevision?.isEmpty == false &&
                 device.modelID?.isEmpty == false && device.profileRevision!.count <= 512 && device.modelID!.count <= 512) else {
            throw NativeLocalAuthenticationIssue.bindingChanged
        }
    }
    private func sameLocalDevice(_ first: RegisteredDevice, _ second: RegisteredDevice, profile: Bool = true) -> Bool {
        first.accountID == second.accountID && first.deviceID == second.deviceID && first.faceHandle == second.faceHandle &&
        (first.keyAlias ?? NativeEnrollmentRecord.keyAlias) == (second.keyAlias ?? NativeEnrollmentRecord.keyAlias) &&
        (!profile || first.profileID == second.profileID && first.profileRevision == second.profileRevision && first.modelID == second.modelID)
    }
    /// Local-only restore precedes the OS prompt. Public journal signatures and
    /// complete shapes are validated here; private-key possession, fresh server
    /// status and all durable repairs remain in the original authenticated path.
    private func hydrateLocalSigningState(_ slots: [String: Data]) throws -> [(account: String, alias: String)] {
        let decoder = JSONDecoder()
        let stored = try slots["credentials"].map { try decoder.decode(NativeCredentials.self, from: $0) }
        let registered = try slots["registered-device"].map { try decoder.decode(RegisteredDevice.self, from: $0) }
        let pending = try slots["pending-face-device"].map { try decoder.decode(RegisteredDevice.self, from: $0) }
        for device in [registered, pending].compactMap({ $0 }) { try validLocalDevice(device) }
        var profile = try slots["face-profile-lifecycle"].map { try decoder.decode(NativeFaceLifecycleRecord.self, from: $0) }
        var recovery = try slots["account-recovery-journal"].map { try decoder.decode(NativeAccountRecoveryRecord.self, from: $0) }
        let setup = try slots["face-enrollment-journal"].map { try decoder.decode(NativeEnrollmentRecord.self, from: $0) }
        let login = try slots["ordinary-face-login-journal"].map { try decoder.decode(NativeOrdinaryLoginRecord.self, from: $0) }
        try profile?.validate(origin: origin); try recovery?.validate(origin: origin); try setup?.validate(origin: origin); try login?.validate(origin: origin)
        let oldProfiles = try slots["retired-face-profile-controls"].map { try decoder.decode([NativeFaceLifecycleRecord].self, from: $0) } ?? []
        let oldRecoveries = try slots["retired-account-recoveries"].map { try decoder.decode([NativeAccountRecoveryRecord].self, from: $0) } ?? []
        guard oldProfiles.count <= 16, oldRecoveries.count <= 16, Set(oldRecoveries.map(\.requestID)).count == oldRecoveries.count else { throw NativeLocalAuthenticationIssue.bindingChanged }
        for record in oldProfiles { try record.validate(origin: origin) }; for record in oldRecoveries { try record.validate(origin: origin) }
        if let active = profile, oldProfiles.contains(where: { $0.controlOperationKey == active.controlOperationKey }) { profile = nil }
        if let active = recovery, oldRecoveries.contains(where: { $0.requestID == active.requestID }) { recovery = nil }
        let retained = registered ?? pending
        if let login {
            guard let retained, sameLocalDevice(retained, login.originalDevice) else { throw NativeLocalAuthenticationIssue.bindingChanged }
        }
        if let profile, let retained {
            guard sameLocalDevice(retained, profile.originalDevice, profile: false),
                  retained.profileID == profile.originalDevice.profileID && retained.profileRevision == profile.originalDevice.profileRevision && retained.modelID == profile.originalDevice.modelID ||
                  retained.profileID == profile.promotionProfile?.id && retained.profileRevision == profile.promotionProfile?.revision && retained.modelID == profile.promotionProfile?.modelID ||
                  retained.profileID == profile.metadata.profile?.id && retained.profileRevision == profile.metadata.profile?.revision && retained.modelID == profile.metadata.profile?.modelID else { throw NativeLocalAuthenticationIssue.bindingChanged }
        }
        if let setup {
            for device in [registered, pending].compactMap({ $0 }) {
                guard device.accountID == setup.accountID, device.deviceID == setup.deviceID, device.faceHandle == setup.faceHandle,
                      (device.keyAlias ?? NativeEnrollmentRecord.keyAlias) == setup.keyAlias,
                      device.profileID == nil || device.profileID == setup.profile?.id && device.profileRevision == setup.profile?.revision && device.modelID == setup.profile?.modelID else { throw NativeLocalAuthenticationIssue.bindingChanged }
            }
        }
        var identities: [(account: String, alias: String)] = []
        if let profile { identities.append((profile.accountID, profile.keyAlias)) }
        if let recovery { identities.append((recovery.accountID, recovery.keyAlias)) }
        if let setup { identities.append((setup.accountID, setup.keyAlias)) }
        if let login { identities.append((login.originalDevice.accountID, login.keyAlias)) }
        identities += [registered, pending].compactMap { $0 }.map { ($0.accountID, $0.keyAlias ?? NativeEnrollmentRecord.keyAlias) }
        if let account = identities.first?.account {
            guard identities.allSatisfy({ $0.account == account }),
                  stored == nil || stored?.account_id == account || stored?.authenticated == false,
                  credentials == nil || credentials?.account_id == account || credentials?.authenticated == false else { throw NativeLocalAuthenticationIssue.bindingChanged }
        }
        let held: NativeCredentials?, promotion: LocalPromotionActivation?
        if let profile, profile.blocksAlternateRecovery || recovery == nil {
            held = profile.promotionCredentials ?? profile.credentials
            promotion = try profile.promotionCredentials.map { try localPromotion(profile, credential: $0) }
        } else if let recovery {
            held = recovery.promotionCredentials; promotion = try recovery.promotionCredentials.map { try localPromotion(recovery, credential: $0) }
        } else if let setup {
            held = setup.promotionCredentials ?? setup.originalAnonymous
            promotion = try setup.promotionCredentials.map { try localPromotion(setup, credential: $0) }
        } else if let login {
            held = login.promotionCredentials; promotion = try login.promotionCredentials.map { try localPromotion(login, credential: $0) }
        } else { held = stored; promotion = nil }
        // Assign only after every held shape and relationship has passed. Holds
        // remain installed so staged credentials cannot become a public session.
        faceLifecycle = profile; accountRecovery = recovery; enrollment = setup; ordinaryLogin = login
        lifecycleArchives = oldProfiles; recoveryArchives = oldRecoveries
        if let held, !credentialCurrent(held) { throw NativeAPIError.sessionChanged }
        if !Self.sameCredentials(credentials, held) { credentials = held; epoch += 1; retireMedia() }
        if let promotion, let old = localPromotionActivation, old.intent != promotion.intent || old.credential != promotion.credential { epoch += 1; retireMedia() }
        if let promotion { localPromotionActivation = LocalPromotionActivation(intent: promotion.intent, credential: promotion.credential, epoch: epoch) }
        else { localPromotionActivation = nil }
        return identities
    }
    private func localSigningStateDigest(_ slots: [String: Data]) -> String {
        let rows = slots.keys.sorted().map { $0 + ":" + NativeLocalSigningLease.digest(slots[$0]!) }.joined(separator: "\n")
        return NativeLocalSigningLease.digest(Data(rows.utf8))
    }
    func installLocalSigning(_ lease: NativeLocalSigningLease) throws {
        guard signer.requiresLocalAuthentication, preparedLocalSigning == lease.binding,
              lease.binding.epoch == epoch,
              lease.binding.stateDigest == (try localSigningStateDigest(localSigningSlots())) else {
            lease.invalidate(); throw NativeLocalAuthenticationIssue.bindingChanged
        }
        localSigningCredentialDigest = try secrets.read("credentials").map(NativeLocalSigningLease.digest)
        localSigningLease = lease; preparedLocalSigning = nil
    }
    func finishLocalSigning(operationID: UUID) {
        if localSigningLease?.binding.operationID == operationID { localSigningLease?.retire(); localSigningLease = nil; localSigningCredentialDigest = nil }
        else if preparedLocalSigning?.operationID == operationID { invalidateLocalSigning() }
    }
    private func invalidateLocalSigning() {
        localSigningLease?.invalidate(); localSigningLease = nil; localSigningCredentialDigest = nil; preparedLocalSigning = nil
    }
    private func makeLocalTransition(kind: NativeLocalTransitionKind, account: String, alias: String, intent: String, serial: Int) throws -> NativeLocalTransitionTicket {
        let now = ProcessInfo.processInfo.systemUptime
        guard now.isFinite, now >= 0 else { throw NativeLocalAuthenticationIssue.expired }
        let ticket = NativeLocalTransitionTicket(id: UUID())
        preparedLocalTransition = LocalTransitionPreparation(ticket: ticket, kind: kind, account: account, alias: alias,
            intent: intent, stateDigest: try localSigningStateDigest(localSigningSlots()), epoch: epoch, serial: serial, issuedAt: now)
        return ticket
    }
    private func requireLocalTransition(_ ticket: NativeLocalTransitionTicket) throws -> LocalTransitionPreparation {
        try Task.checkCancellation()
        let now = ProcessInfo.processInfo.systemUptime
        guard let prepared = preparedLocalTransition, prepared.ticket.id == ticket.id, prepared.epoch == epoch,
              now.isFinite, now >= prepared.issuedAt, now < prepared.issuedAt + NativeLocalSigningLease.maximumLifetime,
              prepared.stateDigest == (try localSigningStateDigest(localSigningSlots())) else { throw NativeLocalAuthenticationIssue.bindingChanged }
        switch prepared.kind {
        case .accountRecoveryStart:
            guard !recoveryBusy, recoverySerial == prepared.serial, let record = accountRecovery,
                  record.requestID == prepared.intent, record.accountID == prepared.account, record.keyAlias == prepared.alias else { throw NativeLocalAuthenticationIssue.bindingChanged }
            try record.validate(origin: origin)
        case .profileCancellation:
            guard !lifecycleBusy, lifecycleSerial == prepared.serial, let record = faceLifecycle,
                  record.accountID == prepared.account, record.keyAlias == prepared.alias,
                  record.controlOperationKey + ":" + (record.pending?.operationKey ?? "") == prepared.intent,
                  record.pending?.cancelRequested == true else { throw NativeLocalAuthenticationIssue.bindingChanged }
            try record.validate(origin: origin)
        }
        return prepared
    }
    private func requireLocalTransitionGrant(_ prepared: LocalTransitionPreparation, envelope: WireValue) throws {
        guard signer.requiresLocalAuthentication else { return }
        guard let lease = localSigningLease, lease.binding.epoch == epoch, lease.binding.accountID == prepared.account,
              lease.binding.aliases == [prepared.alias], lease.binding.stateDigest == prepared.stateDigest,
              lease.binding.purpose == (prepared.kind == .accountRecoveryStart ? .accountRecovery : .profileControl),
              let operation = NativeLocalSigningOperation.id else { throw NativeLocalAuthenticationIssue.required }
        _ = try lease.permit(envelope.canonical(), alias: prepared.alias, epoch: epoch, operationID: operation)
    }
    private func signDevice(_ bytes: Data, alias: String = NativeEnrollmentRecord.keyAlias) throws -> String {
        guard signer.requiresLocalAuthentication else { return try signer.sign(bytes, alias: alias) }
        guard let lease = localSigningLease, let operation = NativeLocalSigningOperation.id else { throw NativeLocalAuthenticationIssue.required }
        guard try secrets.read("credentials").map(NativeLocalSigningLease.digest) == localSigningCredentialDigest else {
            invalidateLocalSigning(); throw NativeLocalAuthenticationIssue.bindingChanged
        }
        try requireLocalPromotionBinding()
        let permit = try lease.permit(bytes, alias: alias, epoch: epoch, operationID: operation)
        let signature = try signer.sign(bytes, alias: alias, permit: permit)
        guard try secrets.read("credentials").map(NativeLocalSigningLease.digest) == localSigningCredentialDigest else {
            invalidateLocalSigning(); throw NativeLocalAuthenticationIssue.bindingChanged
        }
        try requireLocalPromotionBinding()
        return signature
    }
    struct Scope: Sendable { let epoch: Int, account: String?, token: String?, retirementGeneration: Int }
    nonisolated func retireSessionAuthority() {
        let generation = sessionRetirement.retire()
        authorityLedger.persistSoon(generation)
        transport.cancelPending()
    }
    private func credentialCurrent(_ value: NativeCredentials) -> Bool {
        (value.localAuthorityGeneration ?? 0) == authorityLedger.clock.snapshot() || retainedAnonymousCredential(value)
    }
    private func retainedAnonymousCredential(_ value: NativeCredentials) -> Bool {
        guard value.auth_method == "anonymous" else { return false }
        return [enrollment?.originalAnonymous, guestDeletion?.status?.completed == true ? nil : guestDeletion?.originalCredentials,
                audienceSuspension?.credentials].contains { Self.sameCredentials($0, value) }
    }
    private func hasAnonymousRecoveryHold(account: String) throws -> Bool {
        if let bytes = try secrets.read("guest-deletion-receipt") {
            let held = try JSONDecoder().decode(NativeGuestDeletionRecord.self, from: bytes); try held.validate(origin: origin)
            if held.accountID == account, held.status?.completed != true, held.originalCredentials != nil { return true }
        }
        if let bytes = try secrets.read("face-enrollment-journal") {
            let held = try JSONDecoder().decode(NativeEnrollmentRecord.self, from: bytes); try held.validate(origin: origin)
            if held.accountID == account, held.originalAnonymous != nil { return true }
        }
        if let bytes = try secrets.read("audience-suspended-authority") {
            let held = try JSONDecoder().decode(NativeAudienceSuspensionRecord.self, from: bytes); try held.validate(origin: origin)
            if held.credentials.account_id == account { return true }
        }
        return false
    }
    /// Restrictive server results close publication before a potentially blocked
    /// journal write. Their existing receipt/control stays available for retry.
    private func retireForRestriction(_ original: NativeCredentials? = nil) throws {
        let retired = original ?? credentials
        retireSessionAuthority()
        var generation = sessionRetirement.snapshot().generation
        credentials = nil; epoch += 1; audienceProjection = nil; audienceProjectionEpoch = nil
        retireMedia(); intents = []; uploads = []
        do {
            generation = try authorityLedger.persistRetirement(generation)
            try recordCredentialRetirement(retired)
            _ = try retireCredentialSlot(retired)
            if let retired, let session = try? sessionID(retired.access_token) { try retireExportFiles(account: retired.account_id, session: session) }
            sessionRetirement.complete(generation)
        } catch {
            retirementPersistenceError = .unavailable("session_retirement_unconfirmed")
            throw retirementPersistenceError!
        }
    }
    func summary() -> NativeSessionSummary? {
        guard !sessionRetirement.snapshot().retiring, credentials.map({ credentialCurrent($0) && !retiredCredentialDigests.contains(Self.credentialDigest($0)) }) ?? true else { return nil }
        if audienceSuspension != nil { return nil }
        if guestDeletion != nil || ordinaryLogin != nil || faceLifecycle?.activeHold == true || accountRecovery != nil || (enrollment != nil && credentials?.authenticated == true) || enrollment?.state == .registered || enrollment?.state == .promoting || (enrollment?.loginChallengeWire != nil && [.capturePending, .completionPending].contains(enrollment!.state)) { return nil }
        return credentials.map { NativeSessionSummary(accountID: $0.account_id, roles: $0.roles, authenticated: $0.authenticated, expiresAt: $0.expiresAt, epoch: epoch) }
    }
    func device() throws -> RegisteredDevice? {
        // A completion reply can be lost after the server upgraded the account.
        // Keep its opaque handle for a fresh signed challenge; the server alone
        // decides whether that handle belongs to an activated registered face.
        guard let data = try secrets.read("registered-device") ?? secrets.read("pending-face-device") else { return nil }
        return try JSONDecoder().decode(RegisteredDevice.self, from: data)
    }
    private func retireUnreferencedDeviceKey(alias: String, publicJWK expected: WireValue? = nil) throws {
        try NativeIdentityCustody.withLock {
            guard NativeAccountRecoveryRecord.validAlias(alias) else { throw NativeAPIError.invalidResponse }
            func references(_ value: WireValue) -> Bool {
                if let fields = value.object {
                    if fields["keyAlias"]?.string == alias { return true }
                    if fields["keyAlias"] == nil, fields["faceHandle"]?.string != nil, fields["deviceID"]?.string != nil,
                       fields["accountID"]?.string != nil, alias == NativeEnrollmentRecord.keyAlias { return true }
                    return fields.values.contains(where: references)
                }
                return value.array?.contains(where: references) ?? false
            }
            for name in NativeIdentityCustody.slots where name != "deleted-face-profile-controls" {
                if let bytes = try secrets.read(name) {
                    guard bytes.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
                    if references(try WireValue.decoded(bytes)) { return }
                }
            }
            guard try signer.hasKey(alias: alias) else { return }
            let proof = try expected ?? signer.publicJWK(alias: alias, create: false)
            try signer.removeOwnedKey(alias: alias, publicJWK: proof)
        }
    }
    private func retireDeviceReferences(account: String) throws {
        try NativeIdentityCustody.withLock {
            var aliases: Set<String> = []
            for name in ["registered-device", "pending-face-device"] {
                guard let bytes = try secrets.read(name) else { continue }
                let value = try JSONDecoder().decode(RegisteredDevice.self, from: bytes); try validLocalDevice(value)
                guard value.accountID == account else { continue }
                guard try secrets.compareAndSwap(name, expected: bytes, replacement: nil) else { throw NativeAPIError.unavailable("device_reference_retirement_unconfirmed") }
                aliases.insert(value.keyAlias ?? NativeEnrollmentRecord.keyAlias)
            }
            for alias in aliases { try retireUnreferencedDeviceKey(alias: alias) }
        }
    }
    func pending() -> [NativeOperationIntent] { intents.filter { $0.accountID == credentials?.account_id } }
    private func scope(anonymous: Bool = false, expired: Bool = false) throws -> Scope {
        let retirement = sessionRetirement.snapshot()
        guard !retirement.retiring else { throw NativeAPIError.sessionChanged }
        guard anonymous || (audienceSuspension == nil && ordinaryLogin == nil && enrollment == nil && accountRecovery == nil && faceLifecycle?.activeHold != true) else { throw NativeAPIError.authenticationRequired }
        guard let credentials, anonymous || credentials.authenticated else { throw NativeAPIError.authenticationRequired }
        guard credentialCurrent(credentials), !retiredCredentialDigests.contains(Self.credentialDigest(credentials)) else { throw NativeAPIError.authenticationRequired }
        guard expired || credentials.expiresAt > Date() else { throw NativeAPIError.authenticationRequired }
        return Scope(epoch: epoch, account: credentials.account_id, token: credentials.access_token, retirementGeneration: retirement.generation)
    }
    private func check(_ scope: Scope) throws {
        guard sessionRetirement.permits(scope.retirementGeneration), scope.epoch == epoch,
              scope.account == nil || (scope.account == credentials?.account_id && scope.token == credentials?.access_token) else { throw NativeAPIError.sessionChanged }
    }
    private func readyScope(anonymous: Bool = false) async throws -> Scope {
        let delivery = try readRefreshDelivery()?.record
        if let delivery, delivery.suspended, let current = credentials {
            let previousSuccessor = try delivery.response.map(delivery.successor)
            guard current.refresh_token != delivery.original.refresh_token, current.refresh_token != previousSuccessor?.refresh_token else { throw NativeAPIError.operationUnconfirmed(delivery.rotationKey) }
        }
        let refreshPending = delivery?.suspended == false
        if let previous = credentials, previous.expiresAt <= Date() || refreshPending {
            do { try await refresh() }
            catch NativeAPIError.sessionChanged {
                // Concurrent reads may share a single-use refresh token. Only an
                // already completed same-account rotation may satisfy this read.
                guard credentials?.account_id == previous.account_id, credentials?.auth_method == previous.auth_method,
                      let expiry = credentials?.expiresAt, expiry > Date() else { throw NativeAPIError.sessionChanged }
            }
        }
        let captured = try scope(anonymous: anonymous)
        intents = try readIntents(secrets.read("operation-intents"))
        try check(captured)
        return captured
    }
    private func readIntents(_ data: Data?) throws -> [NativeOperationIntent] {
        guard let data else { return [] }
        guard data.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        let rows = try JSONDecoder().decode([NativeOperationIntent].self, from: data)
        guard rows.count <= 100, Set(rows.map { $0.accountID + ":" + $0.key }).count == rows.count else { throw NativeAPIError.invalidResponse }
        return rows
    }
    private func replaceOwnedJournal<T: Encodable>(_ name: String, previous: T?, replacement: T?) throws {
        let generation = authorityLedger.clock.snapshot()
        let old = try secrets.read(name)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let expected = try previous.map { try WireValue.decoded(encoder.encode($0)).canonical() }
        let next = try replacement.map { try encoder.encode($0) }
        let actual = try old.map { try WireValue.decoded($0).canonical() }
        let desired = try next.map { try WireValue.decoded($0).canonical() }
        // Permit exact recovery of a lost write acknowledgement. Unknown fields
        // remain part of the comparison and cannot disappear through decoding.
        guard actual == expected || actual == desired else { throw NativeAPIError.unavailable("operation_storage_changed") }
        guard authorityLedger.clock.snapshot() == generation else { throw NativeAPIError.sessionChanged }
        guard try secrets.compareAndSwap(name, expected: old, replacement: next) else { throw NativeAPIError.unavailable("operation_storage_changed") }
        guard authorityLedger.clock.snapshot() == generation else { throw NativeAPIError.sessionChanged }
    }
    private func persistIntent(_ intent: NativeOperationIntent) throws {
        for _ in 0..<8 {
            let previous = try secrets.read("operation-intents")
            var rows = try readIntents(previous)
            if let existing = rows.first(where: { $0.key == intent.key && $0.accountID == intent.accountID }) {
                guard existing == intent else { throw NativeAPIError.sessionChanged }; intents = rows; return
            }
            guard rows.count < 100 else { throw NativeAPIError.operationUnconfirmed("operation_evidence_full") }
            rows.append(intent)
            if try secrets.compareAndSwap("operation-intents", expected: previous, replacement: JSONEncoder().encode(rows)) { intents = rows; return }
        }
        throw NativeAPIError.unavailable("operation_storage_changed")
    }
    private func terminalOperations() throws -> ([NativeOperationRetirementRecord], Data?) {
        guard let bytes = try secrets.read("operation-terminal-evidence") else { return ([], nil) }
        guard bytes.count <= 512 * 1024 else { throw NativeAPIError.invalidResponse }
        let rows = try JSONDecoder().decode([NativeOperationRetirementRecord].self, from: bytes)
        guard rows.count <= 256, Set(rows.map { $0.accountID + ":" + $0.operationKey }).count == rows.count else { throw NativeAPIError.invalidResponse }
        for row in rows { try row.validate(origin: origin) }
        return (rows, bytes)
    }
    private func retainTerminal(_ record: NativeOperationRetirementRecord) throws {
        try record.validate(origin: origin)
        for _ in 0..<8 {
            var (rows, bytes) = try terminalOperations()
            if let previous = rows.first(where: { $0.accountID == record.accountID && $0.operationKey == record.operationKey }) {
                guard previous.action == record.action, previous.path == record.path, previous.method == record.method, previous.inputSHA256 == record.inputSHA256 else { throw NativeAPIError.sessionChanged }
                return // Keep the first exact server observation, including its original 410/409 code.
            }
            guard rows.count < 256 else { throw NativeAPIError.unavailable("operation_evidence_full") }
            rows.append(record)
            if try secrets.compareAndSwap("operation-terminal-evidence", expected: bytes, replacement: JSONEncoder().encode(rows)) { return }
        }
        throw NativeAPIError.unavailable("operation_storage_changed")
    }
    private func retainTerminal(_ intent: NativeOperationIntent, status: Int, code: String) throws {
        try retainTerminal(NativeOperationRetirementRecord(origin: origin, account: intent.accountID, key: intent.key, action: intent.action,
            path: intent.path ?? "/community/action", method: intent.method ?? "POST", inputSHA256: NativeApplePurchaseRecord.hash(try intent.payload.canonical()), sourceStatus: status, sourceCode: code))
    }
    private func bindExplicitPushReplacement(account: String, key: String) throws {
        for _ in 0..<8 {
            var (rows, bytes) = try terminalOperations()
            for index in rows.indices where rows[index].accountID == account && rows[index].isPush && rows[index].replacementOperationKey == nil { rows[index].replacementOperationKey = key }
            if try secrets.compareAndSwap("operation-terminal-evidence", expected: bytes, replacement: JSONEncoder().encode(rows)) { return }
        }
        throw NativeAPIError.unavailable("operation_storage_changed")
    }
    /// A retiring repository may clear only the credential it actually held.
    /// Another instance's later rotation must survive an old request's 401.
    @discardableResult private func retireCredentialSlot(_ original: NativeCredentials?) throws -> Bool {
        guard let original, let bytes = try secrets.read("credentials") else { return false }
        let saved = try JSONDecoder().decode(NativeCredentials.self, from: bytes)
        guard Self.sameCredentials(original, saved) else { return false }
        return try secrets.compareAndSwap("credentials", expected: bytes, replacement: nil)
    }
    private static func credentialDigest(_ value: NativeCredentials) -> String {
        // Length prefixes make this injective even for an unexpected separator
        // inside an opaque credential; no raw token enters the tombstone slot.
        let fields = [value.account_id, value.auth_method, value.access_token, value.refresh_token]
        return NativeAppleStoreJournal.digest(Data(fields.map { String($0.utf8.count) + ":" + $0 }.joined().utf8))
    }
    private var credentialRetirementSlot: String { "credential-retirements-" + NativeAppleStoreJournal.digest(Data(origin.absoluteString.utf8)) }
    private func readCredentialRetirements(_ bytes: Data?) throws -> Set<String> {
        guard let bytes else { return [] }
        guard bytes.count <= 600000 else { throw NativeAPIError.invalidResponse }
        let values = try JSONDecoder().decode([String].self, from: bytes)
        guard values.count <= 8192, Set(values).count == values.count,
              values.allSatisfy({ $0.count == 64 && $0.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) }) else { throw NativeAPIError.invalidResponse }
        return Set(values)
    }
    private func recordCredentialRetirement(_ value: NativeCredentials?) throws {
        // Anonymous recovery credentials stay exclusively in their existing
        // guest/audience journals; they must still support explicit resolution.
        if let value, value.authenticated { retiredCredentialDigests.insert(Self.credentialDigest(value)) }
        guard !retiredCredentialDigests.isEmpty else { return }
        for _ in 0..<8 {
            let bytes = try secrets.read(credentialRetirementSlot)
            var rows = try readCredentialRetirements(bytes)
            if retiredCredentialDigests.isSubset(of: rows) { retiredCredentialDigests.formUnion(rows); return }
            rows.formUnion(retiredCredentialDigests)
            guard rows.count <= 8192 else { throw NativeAPIError.unavailable("session_retirement_storage_full") }
            if try secrets.compareAndSwap(credentialRetirementSlot, expected: bytes, replacement: JSONEncoder().encode(rows.sorted())) { retiredCredentialDigests.formUnion(rows); return }
        }
        throw NativeAPIError.unavailable("session_retirement_unconfirmed")
    }
    private func persistCredential(_ next: NativeCredentials) throws {
        let retirement = sessionRetirement.snapshot()
        guard !retirement.retiring else { throw NativeAPIError.sessionChanged }
        retiredCredentialDigests.formUnion(try readCredentialRetirements(secrets.read(credentialRetirementSlot)))
        guard credentialCurrent(next), !retiredCredentialDigests.contains(Self.credentialDigest(next)) else { throw NativeAPIError.sessionChanged }
        let previous = try secrets.read("credentials")
        if let previous {
            let stored = try JSONDecoder().decode(NativeCredentials.self, from: previous)
            let expected: [NativeCredentials?] = [credentials, next, enrollment?.originalAnonymous, enrollment?.promotionCredentials,
                accountRecovery?.promotionCredentials, faceLifecycle?.credentials, faceLifecycle?.promotionCredentials,
                ordinaryLogin?.promotionCredentials, audienceSuspension?.credentials, guestDeletion?.originalCredentials]
            guard expected.contains(where: { Self.sameCredentials($0, stored) }) else { throw NativeAPIError.sessionChanged }
        }
        guard sessionRetirement.permits(retirement.generation) else { throw NativeAPIError.sessionChanged }
        let replacement = try JSONEncoder().encode(next)
        guard try secrets.compareAndSwap("credentials", expected: previous, replacement: replacement) else { throw NativeAPIError.sessionChanged }
        guard sessionRetirement.permits(retirement.generation) else {
            // A write may have entered Keychain immediately before retirement.
            // Remove only that exact write, never another instance's successor,
            // and retain a nonauthorizing tombstone before reporting uncertainty.
            do {
                try recordCredentialRetirement(next)
                _ = try secrets.compareAndSwap("credentials", expected: replacement, replacement: nil)
            } catch { retirementPersistenceError = .unavailable("session_retirement_unconfirmed") }
            throw NativeAPIError.sessionChanged
        }
    }
    private func adopt(_ wire: WireValue, expected: String? = nil, method: String? = nil) throws {
        try adoptCredentials(NativeCredentials(wire), expected: expected, method: method)
    }
    private func adoptCredentials(_ next: NativeCredentials, expected: String? = nil, method: String? = nil) throws {
        guard expected == nil || expected == next.account_id, method == nil || method == next.auth_method else { throw NativeAPIError.sessionChanged }
        let previousCredential = credentials
        if var held = audienceSuspension {
            guard next.account_id == held.operation.accountID, next.auth_method == "anonymous" else { throw NativeAPIError.sessionChanged }
            held.credentials = next; try saveAudienceSuspension(held)
        } else if var held = guestDeletion {
            guard next.account_id == held.accountID, next.auth_method == "anonymous", held.status?.completed != true else { throw NativeAPIError.sessionChanged }
            held.originalCredentials = next; try saveGuestDeletion(held)
        } else if var record = faceLifecycle, accountRecovery == nil {
            guard next.account_id == record.accountID, next.authenticated else { throw NativeAPIError.sessionChanged }
            if record.promotionCredentials != nil { record.promotionCredentials = next } else { record.credentials = next }
            try saveFaceLifecycle(record)
        } else if var record = accountRecovery {
            guard next.account_id == record.accountID, next.authenticated, record.promotionDevice != nil else { throw NativeAPIError.sessionChanged }
            record.promotionCredentials = next; try saveAccountRecovery(record)
        } else if var record = enrollment {
            guard record.accountID == next.account_id else { throw NativeAPIError.sessionChanged }
            if next.authenticated { guard record.promotionDevice != nil else { throw NativeAPIError.invalidResponse }; record.promotionCredentials = next }
            else { record.originalAnonymous = next }
            try saveEnrollment(record)
        } else if var record = ordinaryLogin, record.promotionCredentials != nil {
            guard next.account_id == record.originalDevice.accountID, next.authenticated else { throw NativeAPIError.sessionChanged }
            record.promotionCredentials = next; try saveOrdinaryLogin(record)
        }
        try persistCredential(next); epoch += 1; credentials = next; audienceProjection = nil; audienceProjectionEpoch = nil; retireMedia()
        if let previousCredential, (try? sessionID(previousCredential.access_token)) != (try? sessionID(next.access_token)) {
            try? retireExportFiles(account: previousCredential.account_id, session: sessionID(previousCredential.access_token))
        }
    }
    func retireMedia() { mediaEpoch += 1; mediaExpiryTask?.cancel(); mediaExpiryTask = nil; media.removeAll() }
    func expirePrivateMedia() {
        media.expire(at: privateMediaClock.read()); scheduleMediaExpiry()
    }
    func retainedPrivateMediaBytes() -> Int { media.retainedByteCount }
    private func scheduleMediaExpiry() {
        mediaExpiryTask?.cancel(); mediaExpiryTask = nil
        guard let delay = media.nextExpiryDelay(at: privateMediaClock.read()) else { return }
        let capturedEpoch = mediaEpoch
        mediaExpiryTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, let self else { return }
                await self.expirePrivateMedia(expectedEpoch: capturedEpoch)
            } catch {}
        }
    }
    private func expirePrivateMedia(expectedEpoch: Int) {
        guard expectedEpoch == mediaEpoch else { return }; expirePrivateMedia()
    }
    private func request(_ path: String, method: String = "GET", body: WireValue? = nil, raw: Data? = nil,
                         headers: [String: String] = [:], scope captured: Scope? = nil, binary: Bool = false, preserveRefreshAuthority: Bool = false,
                         responseLimit: Int? = nil) async throws -> NativeHTTPReply {
        let captured = captured ?? Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation); try check(captured)
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains(".."), let url = URL(string: origin.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).isEmpty ? path : origin.path + path, relativeTo: origin)?.absoluteURL,
              url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port else { throw NativeAPIError.invalidResponse }
        let audienceFence = try await audienceRequestFence(path, method: method, body: body, captured: captured)
        try check(captured)
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 20; request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue(binary ? "application/octet-stream,image/*" : "application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if let token = captured.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try body.encoded() }
        else { request.httpBody = raw }
        let response: NativeHTTPReply
        let limit = responseLimit ?? (binary ? 32 * 1024 * 1024 : 2 * 1024 * 1024)
        guard limit > 0, limit <= 32 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        do { response = try await transport.send(request, limit: limit) }
        catch { try check(captured); if error is CancellationError { throw error }; throw NativeAPIError.unavailable("network") }
        try check(captured)
        guard response.data.count <= limit else { throw NativeAPIError.invalidResponse }
        guard (200..<300).contains(response.status) else {
            let problem = try? WireValue.decoded(response.data)
            let code = problem?["error"]["code"].string ?? "http_\(response.status)"
            if !preserveRefreshAuthority, ["registered_face_session_invalid", "face_handle_unavailable", "account_disabled"].contains(code) { clearSession(identity: true) }
            else if !preserveRefreshAuthority, response.status == 401, captured.account != nil, !["face_verification_failed", "device_proof_invalid"].contains(code) { clearSession() }
            if let retirementPersistenceError { throw retirementPersistenceError }
            throw NativeAPIError.denied(response.status, code)
        }
        if !binary, !(response.headers["content-type"] ?? "").lowercased().hasPrefix("application/json") { throw NativeAPIError.invalidResponse }
        if let audienceFence {
            do { try await recheckAudienceFence(audienceFence, captured: captured) }
            catch {
                // A server success preceded this local publication check. It
                // cannot be reclassified as a definitive pre-write 4xx refusal.
                // Preserve the original mutation identity for status recovery.
                let readOnlyAction = path == "/community/action" && ["photos", "photos.validate", "photos.lookup", "inbox", "history", "receipt", "operation"].contains(body?["action"].string ?? "")
                if !["GET", "HEAD"].contains(method), !readOnlyAction {
                    throw NativeAPIError.operationUnconfirmed(body?["operation_key"].string ?? body?["payload"]["operation_key"].string ?? "committed_publication_unavailable")
                }
                throw error
            }
        }
        return response
    }
    private func json(_ path: String, method: String = "GET", body: WireValue? = nil, scope: Scope? = nil, preserveRefreshAuthority: Bool = false) async throws -> WireValue {
        let captured = scope ?? Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation)
        let value = try WireValue.decoded(await request(path, method: method, body: body, scope: captured, preserveRefreshAuthority: preserveRefreshAuthority).data)
        try check(captured)
        if value["access_token"].string != nil {
            var retainedRefresh = false
            if path == "/auth/session/refresh", value["auth_method"].string == "anonymous", let current = credentials, retainedAnonymousCredential(current),
               let saved = try readRefreshDelivery()?.record, !saved.suspended, saved.rotationKey == body?["rotation_key"].string,
               saved.original.refresh_token == body?["refresh_token"].string { retainedRefresh = true }
            guard (authorityLedger.permitsRequest(body) || retainedRefresh), value["_lovelies_local_authority_generation"] == .null,
                  var fields = value.object else { throw NativeAPIError.sessionChanged }
            // This field comes exclusively from the fenced native response boundary.
            // Server JSON cannot choose a local authority generation.
            fields["_lovelies_local_authority_generation"] = .number(Double(captured.retirementGeneration))
            return .object(fields)
        }
        return value
    }
    func bootstrap() async throws -> NativeSessionSummary? {
        try authorityLedger.restore()
        if sessionRetirement.snapshot().retiring { clearSession(); if let retirementPersistenceError { throw retirementPersistenceError } }
        retiredCredentialDigests = try readCredentialRetirements(secrets.read(credentialRetirementSlot))
        if let bytes = try secrets.read("credentials") {
            let saved = try JSONDecoder().decode(NativeCredentials.self, from: bytes)
            let heldAnonymous = saved.auth_method == "anonymous" && (try hasAnonymousRecoveryHold(account: saved.account_id))
            if (!credentialCurrent(saved) && !heldAnonymous) || retiredCredentialDigests.contains(Self.credentialDigest(saved)) {
                guard try secrets.compareAndSwap("credentials", expected: bytes, replacement: nil) else { throw NativeAPIError.sessionChanged }
            }
        }
        try pruneExportDeliveries()
        // The deletion receipt is the restart authority, including when local
        // cleanup failed. Never restore a deleted face lifecycle first.
        if try registeredDeletionReceipt() != nil { return nil }
        try restoreUploadBatches()
        try restoreFaceLifecycle()
        try restoreAccountRecovery()
        try restoreEnrollment()
        try restoreOrdinaryLogin()
        // A saved deletion receipt precedes all account creation/recovery. A
        // missing result must never silently become a different guest account.
        if let data = try secrets.read("guest-deletion-receipt") {
            guard data.count <= 16 * 1024 else { throw NativeAPIError.invalidResponse }
            var restored = try JSONDecoder().decode(NativeGuestDeletionRecord.self, from: data)
            try restored.validate(origin: origin); guestDeletion = restored
            if let saved = try secrets.read("credentials") {
                guard saved.count <= 16 * 1024 else { throw NativeAPIError.invalidResponse }
                let previous = try JSONDecoder().decode(NativeCredentials.self, from: saved)
                guard previous.account_id == restored.accountID && previous.auth_method == "anonymous" else { throw NativeAPIError.sessionChanged }
                try previous.validateAnonymousRecovery(accountID: restored.accountID)
                if restored.status?.completed != true {
                    guard let original = restored.originalCredentials else { throw NativeAPIError.invalidResponse }
                    // adopt writes the rotated slot before receipt persistence.
                    // Recover that last durable rotation before freezing it;
                    // a consumed refresh must not replace a surviving new slot.
                    if original.access_token != previous.access_token || original.refresh_token != previous.refresh_token || original.expiresAt != previous.expiresAt {
                        restored.originalCredentials = previous; try saveGuestDeletion(restored)
                    }
                }
                // Completed receipts never import credentials. Unresolved
                // rotations are now durable in the receipt before slot removal.
                try retireCredentialSlot(previous)
            }
            guestDeletion = restored; credentials = nil
            if restored.status?.completed == true { try clearGuestDeviceReferences(account: restored.accountID, completed: true) }
            return nil
        }
        if try restoreAudienceSuspension() { return nil }
        try await restorePendingRefreshDelivery()
        if let lifecycle = faceLifecycle, lifecycle.blocksAlternateRecovery || accountRecovery == nil {
            // D04 precedes all lifecycle work. Signed lifecycle metadata never
            // substitutes for credentials or creates a replacement account.
            credentials = lifecycle.promotionCredentials ?? lifecycle.credentials
            if lifecycle.promotionCredentials != nil { return try await repairFaceLifecyclePromotion() }
            _ = try await checkFaceLifecycle()
            return summary()
        }
        if accountRecovery != nil {
            credentials = accountRecovery?.promotionCredentials; retireMedia()
            if accountRecovery?.promotionCredentials != nil { return try await repairAccountRecoveryPromotion() }
            _ = try await recoverAccount(); return nil
        }
        if var record = enrollment {
            if let data = try secrets.read("credentials") {
                guard data.count <= 16 * 1024 else { throw NativeAPIError.invalidResponse }
                let stored = try JSONDecoder().decode(NativeCredentials.self, from: data)
                guard stored.account_id == record.accountID else { throw NativeAPIError.sessionChanged }
                if stored.authenticated {
                    guard record.promotionCredentials != nil else { throw NativeAPIError.invalidResponse }
                    try stored.validateRegisteredRecovery(accountID: record.accountID)
                } else { try stored.validateAnonymousRecovery(accountID: record.accountID) }
                // Every A01 rotation is saved in the journal BEFORE the generic
                // slot. A failed slot write can leave an older, consumed token
                // there; it must never overwrite the surviving journal rotation.
            }
            credentials = record.promotionCredentials ?? record.originalAnonymous
            if record.promotionCredentials != nil { return try await repairEnrollmentPromotion() }
            _ = try await recoverEnrollment()
            return summary()
        }
        if let data = try secrets.read("operation-intents") { intents = try JSONDecoder().decode([NativeOperationIntent].self, from: data); guard intents.count <= 100 else { throw NativeAPIError.invalidResponse } }
        try migrateLegacyApplePurchases()
        if let data = try secrets.read("upload-stages") { uploads = try JSONDecoder().decode([NativeUploadRecord].self, from: data); guard uploads.count <= 100 else { throw NativeAPIError.invalidResponse } }
        if ordinaryLogin != nil {
            credentials = ordinaryLogin?.promotionCredentials; retireMedia()
            if ordinaryLogin?.promotionCredentials != nil { return try await repairOrdinaryLoginPromotion() }
            return nil
        }
        if let data = try secrets.read("credentials") {
            credentials = try JSONDecoder().decode(NativeCredentials.self, from: data)
            do { if credentials!.expiresAt <= Date() { try await refresh() }; _ = try await current(); return summary() }
            catch NativeAPIError.denied(let status, let code) where status == 401 { if try readRefreshDelivery() != nil { throw NativeAPIError.denied(status, code) }; clearSession() }
        }
        if let held = try pendingAudienceMutation() { throw NativeAPIError.operationUnconfirmed(held.operationKey) }
        if try device() != nil { return nil } // Fresh verification, never a new anonymous account, recovers this retained handle.
        if !recoveryArchives.isEmpty || !lifecycleArchives.isEmpty { return nil } // Retired attempts are known holds, never a reason to bootstrap another account.
        guard try !signer.hasRetainedKey() else { throw NativeAPIError.unsupported(String(localized: "This device has a retained face-verification key but its recovery record is unavailable. A replacement account cannot be created automatically.")) }
        let captured = Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation)
        let result = try await json("/auth/anonymous", method: "POST", body: .object([:]), scope: captured)
        try check(captured); try adopt(result, method: "anonymous"); return summary()
    }
    func current() async throws -> WireValue {
        let captured = try await readyScope(anonymous: true), value = try await json("/me", scope: captured)
        guard value["user_id"].string == captured.account, value["auth_method"].string == credentials?.auth_method,
              value["authenticated"].bool == credentials?.authenticated else { throw NativeAPIError.invalidResponse }; return value
    }
    private static let refreshDeliverySlot = "refresh-delivery-journal-v1"
    private func readRefreshDelivery() throws -> (record: NativeRefreshDeliveryRecord, bytes: Data)? {
        guard let data = try secrets.read(Self.refreshDeliverySlot) else { return nil }
        guard data.count <= 128 * 1024 else { throw NativeAPIError.invalidResponse }
        let value = try JSONDecoder().decode(NativeRefreshDeliveryRecord.self, from: data); try value.validate(origin: origin)
        return (value, data)
    }
    private func refreshBindings() throws -> (String, String) {
        let owner: String, boundDevice: RegisteredDevice?
        if let guestDeletion { owner = "guest:" + guestDeletion.operationKey; boundDevice = try device() }
        else if let record = faceLifecycle, accountRecovery == nil { owner = "profile:" + record.controlOperationKey + ":" + String(record.promotionCredentials != nil); boundDevice = record.originalDevice }
        else if let record = accountRecovery { owner = "recovery:" + record.requestID; boundDevice = try record.promotionDevice ?? device() }
        else if let record = enrollment { owner = "enrollment:" + record.enrollmentKey + ":" + String(record.promotionCredentials != nil); boundDevice = try record.promotionDevice ?? device() }
        else if let record = ordinaryLogin { owner = "login:" + record.originalDevice.deviceID + ":" + (record.challengeWire["challenge_id"].string ?? "none"); boundDevice = record.originalDevice }
        else { owner = "session"; boundDevice = try device() }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return (signer.sha256(Data(owner.utf8)), signer.sha256(try boundDevice.map { try encoder.encode($0) } ?? Data("no-device".utf8)))
    }
    private func assertRefreshOwner(_ record: NativeRefreshDeliveryRecord) throws {
        let bindings = try refreshBindings()
        guard !record.suspended, bindings.0 == record.ownerBinding, bindings.1 == record.deviceBinding,
              credentials?.account_id == record.original.account_id, credentials?.auth_method == record.original.auth_method else { throw NativeAPIError.sessionChanged }
        let successor = try record.response.map(record.successor)
        guard credentials?.refresh_token == record.original.refresh_token || credentials?.refresh_token == successor?.refresh_token else { throw NativeAPIError.sessionChanged }
    }
    private func encodedRefresh(_ value: NativeRefreshDeliveryRecord) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value)
    }
    private func retirePreviousRefresh(_ saved: (record: NativeRefreshDeliveryRecord, bytes: Data), replacing: NativeRefreshDeliveryRecord) throws {
        guard saved.record.suspended else { throw NativeAPIError.sessionChanged }
        let name = "retired-refresh-deliveries-v1"
        var rows = try secrets.read(name).map { try JSONDecoder().decode([NativeRefreshDeliveryRecord].self, from: $0) } ?? []
        if !rows.contains(where: { $0.rotationKey == saved.record.rotationKey }) { guard rows.count < 16 else { throw NativeAPIError.operationUnconfirmed(saved.record.rotationKey) }; rows.append(saved.record); try secrets.write(name, data: JSONEncoder().encode(rows)) }
        guard try secrets.compareAndSwap(Self.refreshDeliverySlot, expected: saved.bytes, replacement: encodedRefresh(replacing)) else { throw NativeAPIError.sessionChanged }
    }
    private func newRefreshRecord(_ original: NativeCredentials) throws -> NativeRefreshDeliveryRecord {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw NativeAPIError.unavailable("secure_random") }
        let binding = try refreshBindings()
        return NativeRefreshDeliveryRecord(origin: origin, original: original, owner: binding.0, device: binding.1, secret: Data(bytes).base64URL)
    }
    private func restorePendingRefreshDelivery() async throws {
        try retryArchivedRefreshCancellations()
        guard var saved = try readRefreshDelivery() else { return }
        if !credentialCurrent(saved.record.original), !saved.record.suspended {
            var retired = saved.record; retired.suspended = true
            let bytes = try encodedRefresh(retired)
            guard try secrets.compareAndSwap(Self.refreshDeliverySlot, expected: saved.bytes, replacement: bytes) else { throw NativeAPIError.sessionChanged }
            saved = (retired, bytes)
        }
        let slot = try secrets.read("credentials").map { try JSONDecoder().decode(NativeCredentials.self, from: $0) }
        let held: NativeCredentials?
        if let profile = faceLifecycle, accountRecovery == nil { held = profile.promotionCredentials ?? profile.credentials }
        else if let recovery = accountRecovery { held = recovery.promotionCredentials }
        else if let setup = enrollment { held = setup.promotionCredentials ?? setup.originalAnonymous }
        else if let login = ordinaryLogin { held = login.promotionCredentials }
        else { held = slot }
        if saved.record.suspended {
            if !saved.record.cancellationConfirmed { Task { await self.cancelSuspendedRefresh(saved.record) } }
            if let held, held.authenticated, held.refresh_token != saved.record.original.refresh_token,
               held.refresh_token != (try saved.record.response.map(saved.record.successor))?.refresh_token { return }
            // A failed secure-vault deletion may leave the logged-out slot or
            // promotion journal behind. Suspension outranks that stale token.
            if held != nil { throw NativeAPIError.operationUnconfirmed(saved.record.rotationKey) }
            if saved.record.cancellationConfirmed { return }
            // Keep the old identity and cancellation marker. Never bootstrap a
            // replacement guest or silently sign back in after explicit logout.
            if try device() != nil { return }
            throw NativeAPIError.operationUnconfirmed(saved.record.rotationKey)
        }
        guard let held else { throw NativeAPIError.operationUnconfirmed(saved.record.rotationKey) }
        credentials = held; epoch += 1; try await refresh()
    }
    func refresh() async throws {
        for _ in 0..<2 {
            let captured = try scope(anonymous: true, expired: true)
            guard let original = credentials else { throw NativeAPIError.authenticationRequired }
            let saved: (record: NativeRefreshDeliveryRecord, bytes: Data)
            if let existing = try readRefreshDelivery() {
                let oldSuccessor = try existing.record.response.map(existing.record.successor)
                let replacedByVerifiedSession = original.authenticated && original.refresh_token != existing.record.original.refresh_token && original.refresh_token != oldSuccessor?.refresh_token
                if existing.record.suspended || replacedByVerifiedSession {
                    guard replacedByVerifiedSession else { throw NativeAPIError.operationUnconfirmed(existing.record.rotationKey) }
                    var retired = existing.record; retired.suspended = true
                    let retiredBytes = try encodedRefresh(retired)
                    guard try secrets.compareAndSwap(Self.refreshDeliverySlot, expected: existing.bytes, replacement: retiredBytes) else { throw NativeAPIError.sessionChanged }
                    let retiredRecord = retired
                    Task { await self.cancelSuspendedRefresh(retiredRecord) }
                    let fresh = try newRefreshRecord(original); try retirePreviousRefresh((retired, retiredBytes), replacing: fresh)
                    saved = (fresh, try encodedRefresh(fresh))
                } else { saved = existing }
            } else {
                let fresh = try newRefreshRecord(original), bytes = try encodedRefresh(fresh)
                guard try secrets.compareAndSwap(Self.refreshDeliverySlot, expected: nil, replacement: bytes) else { throw NativeAPIError.sessionChanged }
                saved = (fresh, bytes)
            }
            try assertRefreshOwner(saved.record)
            let result: WireValue
            if let delivered = saved.record.response { result = delivered }
            else { result = try await json("/auth/session/refresh", method: "POST", body: saved.record.payload, scope: captured, preserveRefreshAuthority: true) }
            try check(captured); try assertRefreshOwner(saved.record)
            let next = try saved.record.successor(result)
            var delivered = saved.record; delivered.response = result
            let deliveredBytes = try encodedRefresh(delivered)
            guard deliveredBytes.count <= 128 * 1024 else { throw NativeAPIError.invalidResponse }
            guard try secrets.compareAndSwap(Self.refreshDeliverySlot, expected: saved.bytes, replacement: deliveredBytes) else { throw NativeAPIError.sessionChanged }
            try adoptCredentials(next, expected: saved.record.original.account_id, method: saved.record.original.auth_method)
            // Owner journal and generic credential are durable before the only
            // active receipt removal. Failed removal leaves the same successor.
            guard try secrets.compareAndSwap(Self.refreshDeliverySlot, expected: deliveredBytes, replacement: nil) else { throw NativeAPIError.sessionChanged }
            if next.expiresAt > Date() { return }
        }
        throw NativeAPIError.unavailable("refresh_delivery_reconciliation_required")
    }
    private func suspendRefreshForLogout() throws -> NativeRefreshDeliveryRecord? {
        guard let saved = try readRefreshDelivery() else { return nil }
        var next = saved.record; next.suspended = true
        guard try secrets.compareAndSwap(Self.refreshDeliverySlot, expected: saved.bytes, replacement: encodedRefresh(next)) else { throw NativeAPIError.sessionChanged }
        return next
    }
    private func retryArchivedRefreshCancellations() throws {
        guard let data = try secrets.read("retired-refresh-deliveries-v1") else { return }
        guard data.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        let rows = try JSONDecoder().decode([NativeRefreshDeliveryRecord].self, from: data)
        guard rows.count <= 16 else { throw NativeAPIError.invalidResponse }
        for record in rows.filter({ $0.apiOrigin == origin.absoluteString && $0.suspended && !$0.cancellationConfirmed }).prefix(4) {
            try record.validate(origin: origin)
            Task { await self.cancelSuspendedRefresh(record) }
        }
    }
    private func confirmRefreshCancellation(_ record: NativeRefreshDeliveryRecord) throws {
        if let saved = try readRefreshDelivery(), saved.record.rotationKey == record.rotationKey,
           saved.record.deliverySecret == record.deliverySecret, saved.record.suspended {
            var next = saved.record; next.cancellationConfirmed = true
            _ = try secrets.compareAndSwap(Self.refreshDeliverySlot, expected: saved.bytes, replacement: encodedRefresh(next)); return
        }
        let name = "retired-refresh-deliveries-v1"
        guard let bytes = try secrets.read(name) else { return }
        var rows = try JSONDecoder().decode([NativeRefreshDeliveryRecord].self, from: bytes)
        guard rows.count <= 16, let index = rows.firstIndex(where: { $0.rotationKey == record.rotationKey && $0.deliverySecret == record.deliverySecret && $0.suspended }) else { return }
        rows[index].cancellationConfirmed = true
        _ = try secrets.compareAndSwap(name, expected: bytes, replacement: JSONEncoder().encode(rows))
    }
    private func cancelSuspendedRefresh(_ record: NativeRefreshDeliveryRecord) async {
        do {
            let result = try await json("/auth/session/refresh/cancel", method: "POST", body: record.payload, preserveRefreshAuthority: true)
            guard result["protocol"].string == NativeRefreshDeliveryRecord.protocolName, result["rotation_key"].string == record.rotationKey,
                  result["account_id"].string == record.original.account_id, result["status"].string == "cancelled", result["access_token"] == .null, result["refresh_token"] == .null else { return }
            try confirmRefreshCancellation(record)
        } catch { /* Exact protected cancellation identity remains for retry. */ }
    }
    func clearSession(identity: Bool = false) {
        var retirement = sessionRetirement.retire()
        defer { if retirementPersistenceError == nil { sessionRetirement.complete(retirement) } }
        let retiredCredential = credentials
        // Close in-memory authority before the first vault or file operation.
        epoch += 1; credentials = nil; audienceProjection = nil; audienceProjectionEpoch = nil; intents = []; uploads = []; transport.cancelPending(); retireMedia()
        lifecycleSerial += 1; lifecycleBusy = false
        guestDeletionSerial += 1; guestDeletionBusy = false
        enrollmentSerial += 1; enrollmentBusy = false
        recoverySerial += 1; recoveryBusy = false
        retirementPersistenceError = nil
        do { retirement = try authorityLedger.persistRetirement(retirement) }
        catch { retirementPersistenceError = .unsupported(String(localized: "Sign-out is not durably confirmed. Unlock this device and retry before closing the app.")) }
        do { try recordCredentialRetirement(retiredCredential) }
        catch { retirementPersistenceError = .unsupported(String(localized: "Sign-out is not durably confirmed. Unlock this device and retry before closing the app.")) }
        do { try retireUploadWork() }
        catch { retirementPersistenceError = .unsupported(String(localized: "Sign-out is not durably confirmed. Unlock this device and retry before closing the app.")) }
        var removeCredentialSlot = true
        if var record = guestDeletion, record.status?.completed != true, let current = retiredCredential,
           current.account_id == record.accountID, current.auth_method == "anonymous" {
            do { try current.validateAnonymousRecovery(accountID: record.accountID); record.originalCredentials = current; try saveGuestDeletion(record) }
            catch { removeCredentialSlot = false; retirementPersistenceError = .unavailable("session_retirement_unconfirmed") } // Keep the surviving rotation for next restore.
        }
        if var record = faceLifecycle {
            record.credentials = nil
            do { try saveFaceLifecycle(record) } catch { removeCredentialSlot = false; retirementPersistenceError = .unavailable("session_retirement_unconfirmed") }
        }
        var removedCredential = false
        if removeCredentialSlot {
            do {
                removedCredential = try retireCredentialSlot(retiredCredential)
                // Retry an earlier failed exact-slot retirement without adopting
                // whatever newer credential another repository may have saved.
                if let bytes = try secrets.read("credentials") {
                    let saved = try JSONDecoder().decode(NativeCredentials.self, from: bytes)
                    if retiredCredentialDigests.contains(Self.credentialDigest(saved)) {
                        _ = try secrets.compareAndSwap("credentials", expected: bytes, replacement: nil)
                    }
                }
            } catch { retirementPersistenceError = .unsupported(String(localized: "Sign-out is not durably confirmed. Unlock this device and retry before closing the app.")) }
        }
        if let retiredCredential, let session = try? sessionID(retiredCredential.access_token) {
            do { try retireExportFiles(account: retiredCredential.account_id, session: session) }
            catch { retirementPersistenceError = .unavailable("private_export_cleanup_unconfirmed") }
        }
        // Pending intents and upload stages are nonauthorizing recovery evidence.
        // Keep their account binding on disk through logout/401. A later account
        // cannot consume them, and a fresh same-account session can reconcile.
        if identity && removedCredential {
            let audienceRecoveryHeld: Bool
            do { audienceRecoveryHeld = try secrets.read("audience-device-renewals") != nil } catch { audienceRecoveryHeld = true }
            if audienceRecoveryHeld { /* Preserve the exact signed renewal proof. */ }
            else if let guestDeletion { try? clearGuestDeviceReferences(account: guestDeletion.accountID) }
            else if enrollment != nil || accountRecovery != nil || faceLifecycle != nil || ordinaryLogin != nil { /* Preserve original recovery holds; never silently replace this account. */ }
            else if let retiredCredential {
                do { try retireDeviceReferences(account: retiredCredential.account_id) }
                catch { retirementPersistenceError = .unavailable("device_reference_retirement_unconfirmed") }
            }
        }
    }
    func logout() async throws {
        retireSessionAuthority()
        if let operation = try pendingAudienceMutation(), let original = credentials, original.auth_method == "anonymous", operation.accountID == original.account_id {
            // Preserve the sole anonymous authority before retiring UI/session
            // publication. Revoking it would make the exact uncertain operation
            // unrecoverable and must not create a different anonymous account.
            let held = try NativeAudienceSuspensionRecord(origin: origin, operation: operation, credentials: original)
            try saveAudienceSuspension(held); clearSession(); if let retirementPersistenceError { throw retirementPersistenceError }; return
        }
        if let original = credentials, retainedAnonymousCredential(original) {
            // This credential is the sole authority of a known setup/deletion
            // hold. Retire public admission while preserving its exact private
            // rotation for explicit same-account reconciliation.
            clearSession(); if let retirementPersistenceError { throw retirementPersistenceError }; return
        }
        // Persist suspension BEFORE changing any local authority. Cancellation
        // runs independently; logout never waits on provider/network recovery.
        let suspendedRefresh = try suspendRefreshForLogout()
        // An interrupted promotion may have retired the older public session
        // while retaining its newer credential only in the private journal.
        let staged: NativeCredentials?
        if let record = faceLifecycle, accountRecovery == nil, let candidate = record.promotionCredentials {
            try record.validate(origin: origin); try assertLifecycleKey(record); staged = candidate
        } else if let record = accountRecovery, let candidate = record.promotionCredentials {
            try record.validate(origin: origin); try assertRecoveryKey(record); staged = candidate
        } else if let record = enrollment, let candidate = record.promotionCredentials {
            try record.validate(origin: origin); try assertEnrollmentKey(record); staged = candidate
        } else if let record = ordinaryLogin, let candidate = record.promotionCredentials {
            try record.validate(origin: origin); try assertOrdinaryLoginKey(record); staged = candidate
        } else { staged = nil }
        let previous = staged ?? credentials ?? faceLifecycle?.credentials
        let published = credentials
        let pushDeviceID = try device()?.deviceID
        clearSession()
        if let retirementPersistenceError { throw retirementPersistenceError }
        if let suspendedRefresh { Task { await self.cancelSuspendedRefresh(suspendedRefresh) } }
        if var record = ordinaryLogin { record.promotionCredentials = nil; try saveOrdinaryLogin(record) }
        if var record = enrollment, record.promotionCredentials != nil {
            record.promotionCredentials = nil; record.promotionDevice = nil; record.originalAnonymous = nil; record.state = .registered
            record.loginChallengeWire = nil; record.loginTerminalCode = nil; record.loginCaptures = []
            try saveEnrollment(record)
        }
        if var record = accountRecovery, record.promotionCredentials != nil {
            record.promotionCredentials = nil; record.promotionDevice = nil; record.state = .registered
            if !record.captures.isEmpty { record.retiredCaptures = record.captures }
            record.captures = []; record.challengeWire = nil; record.loginTerminalCode = nil
            try saveAccountRecovery(record)
        }
        if var record = faceLifecycle {
            // Explicit logout retires authentication repair, unlike an internal
            // failure. Keep the signed control, original key and pending action
            // so read-only reconciliation can offer a fresh explicit login.
            record.credentials = nil; record.promotionCredentials = nil; record.promotionProfile = nil
            record.loginChallengeWire = nil; record.loginTerminalCode = nil; record.loginCaptures = []; record.loginCompletionPending = false
            record.stableControlLogin = false; record.currentAuthorityValidated = false
            try saveFaceLifecycle(record)
        }
        var cancellationError: Error?
        if faceLifecycle?.pending?.action.captures == true, faceLifecycle?.pending?.terminal != true {
            do {
                if signer.requiresLocalAuthentication {
                    // Logout has already retired its signing epoch. Preserve
                    // restrictive cancellation intent now; a later explicit
                    // status action obtains its own post-retirement OS grant.
                    _ = try prepareFaceProfileCancellation()
                } else { _ = try await cancelFaceProfileCapture() }
            } catch { cancellationError = error }
        }
        var pushCleanupError: Error?
        if let previous {
            let cleanup = Scope(epoch: epoch, account: nil, token: previous.access_token, retirementGeneration: sessionRetirement.snapshot().generation)
            // Restrictive cleanup uses only the captured retired session. It
            // cannot reopen normal repository admission or publish account data.
            if previous.authenticated, let pushDeviceID {
                do {
                    let rows = try await json("/me/push-devices", scope: cleanup)["items"].array ?? []
                    for row in rows where row["platform"].string == "ios" && row["auth_device_id"].string == pushDeviceID && row["active"].bool != false && row["active"].integer != 0 {
                        let id = try row.uuid("id")
                        let key = "ios-logout-" + NativeAppleStoreJournal.digest(Data((previous.account_id + ":" + previous.access_token + ":" + id).utf8))
                        _ = try await json("/me/push-devices/" + id, method: "DELETE", body: .object(["operation_key": .string(key)]), scope: cleanup)
                    }
                } catch { pushCleanupError = error }
            }
            _ = try await json("/auth/logout", method: "POST", body: .object([:]), scope: cleanup)
        }
        if let published, published.access_token != previous?.access_token {
            do { _ = try await json("/auth/logout", method: "POST", body: .object([:]), scope: Scope(epoch: epoch, account: nil, token: published.access_token, retirementGeneration: sessionRetirement.snapshot().generation)) }
            catch NativeAPIError.denied(401, _) { /* An already expired/revoked captured session has no remaining authority. */ }
        }
        if let cancellationError { throw cancellationError }
        if let retirementPersistenceError { throw retirementPersistenceError }
        if let pushCleanupError { throw pushCleanupError }
    }
    func policy() async throws -> String {
        let value = try await json("/auth/face/policy")
        guard value["protocol"].string == "lovelies-face-auth-v1", value["available"].bool == true else { throw NativeAPIError.invalidResponse }
        return try value.text("policy_version", maximum: 128)
    }
    func hasEnrollmentIntent() throws -> Bool { if enrollment != nil { return true }; return try secrets.read("face-enrollment-journal") != nil }
    func enrollmentSummary() throws -> NativeEnrollmentSummary? {
        guard guestDeletion == nil, let record = enrollment else { return nil }
        let wire = record.loginChallengeWire ?? record.challengeWire
        let challenge = try wire.map { try NativeFaceChallenge($0, accountID: record.accountID, purpose: record.loginChallengeWire == nil ? "registration" : "login", allowExpired: true) }
        let captures = record.loginChallengeWire == nil ? record.captures : record.loginCaptures
        let expiry = challenge?.expiresAt ?? Date.distantPast
        let check = (record.state != .pending && record.state != .registered) || captures.contains(where: { !$0.accepted }) || expiry <= Date()
        return NativeEnrollmentSummary(state: record.state, policy: record.policy, challenge: expiry > Date() ? challenge : nil,
            receipts: captures.filter(\.accepted).map(\.wire), requiresCheck: check)
    }
    private func restoreEnrollment() throws {
        guard let data = try secrets.read("face-enrollment-journal") else { enrollment = nil; return }
        guard data.count <= 32 * 1024 else { throw NativeAPIError.invalidResponse }
        var record = try JSONDecoder().decode(NativeEnrollmentRecord.self, from: data)
        try record.validate(origin: origin); enrollment = record
        if let staged = record.promotionCredentials, !credentialCurrent(staged) {
            record.promotionCredentials = nil; record.promotionDevice = nil; record.originalAnonymous = nil; record.state = .registered
            record.loginChallengeWire = nil; record.loginTerminalCode = nil; record.loginCaptures = []
            try saveEnrollment(record)
        }
    }
    private func saveEnrollment(_ record: NativeEnrollmentRecord) throws {
        try record.validate(origin: origin)
        let data = try JSONEncoder().encode(record); guard data.count <= 32 * 1024 else { throw NativeAPIError.invalidResponse }
        if let staged = record.promotionCredentials, !credentialCurrent(staged) { throw NativeAPIError.sessionChanged }
        try replaceOwnedJournal("face-enrollment-journal", previous: enrollment, replacement: record); enrollment = record
    }
    private func assertEnrollmentKey(_ record: NativeEnrollmentRecord) throws {
        let bytes = try record.startEnvelope.canonical(), raw = try signDevice(bytes)
        guard let data = Data(base64URL: raw), data.count == 64,
              try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: data), for: bytes) else {
            throw NativeAPIError.unsupported(String(localized: "The original enrollment key is unavailable. Recovery cannot replace it."))
        }
    }
    private func enrollmentLoginCurrent(_ record: NativeEnrollmentRecord) throws -> Bool {
        guard record.promotionCredentials == nil, record.loginTerminalCode == nil, let wire = record.loginChallengeWire else { return false }
        return try NativeFaceChallenge(wire, accountID: record.accountID, purpose: "login", allowExpired: true).expiresAt > Date()
    }
    private func enrollmentLoginHeld(_ record: NativeEnrollmentRecord) throws -> Bool {
        try enrollmentLoginCurrent(record) && (record.state != .registered || record.loginCaptures.contains(where: { !$0.accepted }))
    }
    private func beginEnrollmentWork(allowDeletionResume: Bool = false) throws -> Int {
        guard faceLifecycle == nil, !lifecycleBusy, accountRecovery == nil, !recoveryBusy, !enrollmentBusy, (!guestDeletionBusy && guestDeletion == nil) || allowDeletionResume else { throw NativeAPIError.unsupported(String(localized: "Check the current enrollment, account recovery or deletion request before continuing.")) }
        if allowDeletionResume { guard guestDeletionBusy, guestDeletionSummary()?.canResumeSetup == true, credentials?.authenticated == false, credentials?.account_id == enrollment?.accountID else { throw NativeAPIError.sessionChanged } }
        enrollmentBusy = true; enrollmentSerial += 1; return enrollmentSerial
    }
    private func endEnrollmentWork(_ serial: Int) { if enrollmentSerial == serial { enrollmentBusy = false } }
    private func checkEnrollment(_ record: NativeEnrollmentRecord, serial: Int, allowDeletionResume: Bool = false) throws {
        guard enrollmentSerial == serial, enrollment?.accountID == record.accountID, enrollment?.enrollmentKey == record.enrollmentKey,
              enrollment?.publicKeyDigest == record.publicKeyDigest, record.apiOrigin == origin.absoluteString,
              guestDeletion == nil || allowDeletionResume else { throw NativeAPIError.sessionChanged }
    }
    private func enrollmentRequest(_ record: NativeEnrollmentRecord, step: String, extra: [String: WireValue] = [:]) throws -> (WireValue, String) {
        try assertEnrollmentKey(record)
        let nonce = UUID().uuidString.lowercased()
        var body: [String: WireValue] = ["account_id": .string(record.accountID), "enrollment_key": .string(record.enrollmentKey), "face_handle": .string(record.faceHandle),
            "request_nonce": .string(nonce), "request_expires_at": .integer(Int(Date().addingTimeInterval(45).timeIntervalSince1970 * 1000))]
        for (key, value) in extra { body[key] = value }
        var envelope = body; envelope["protocol"] = .string("lovelies-face-enrollment-device-v1"); envelope["step"] = .string(step)
        body["device_signature"] = .string(try signDevice(WireValue.object(envelope).canonical()))
        return (.object(body), nonce)
    }
    private func acceptEnrollmentChallenge(_ value: WireValue, record: NativeEnrollmentRecord, successor: Bool = false) throws -> NativeFaceChallenge {
        guard value["enrollment_key"].string == record.enrollmentKey, value["public_key_digest"].string == record.publicKeyDigest,
              value["face_handle"].string == record.faceHandle, value["policy_version"].string == record.policy,
              let generation = value["enrollment_generation"].integer,
              generation == record.generation || (successor && generation == record.generation + 1) else { throw NativeAPIError.invalidResponse }
        let challenge = try NativeFaceChallenge(value, accountID: record.accountID, purpose: "registration", allowExpired: true)
        if let device = record.deviceID { guard challenge.deviceID == device, value["device_revision"].string == record.deviceRevision else { throw NativeAPIError.invalidResponse } }
        if generation == record.generation, let previous = record.predecessorID { guard challenge.id == previous else { throw NativeAPIError.invalidResponse } }
        var next = record; next.deviceID = challenge.deviceID; next.deviceRevision = try value.uuid("device_revision")
        if generation != record.generation { next.captures = []; next.retiredCaptures = []; next.loginCaptures = [] }
        next.generation = generation; next.challengeWire = value; next.predecessorID = challenge.id; next.resume = nil; next.state = .pending
        try saveEnrollment(next)
        try secrets.write("pending-face-device", data: JSONEncoder().encode(RegisteredDevice(accountID: record.accountID, faceHandle: record.faceHandle, deviceID: challenge.deviceID)))
        return challenge
    }
    func recoverEnrollment(retryStart: Bool = false) async throws -> NativeEnrollmentSummary {
        let serial = try beginEnrollmentWork(); defer { endEnrollmentWork(serial) }
        if let record = enrollment, try enrollmentLoginCurrent(record) { return try enrollmentSummary()! }
        if let record = enrollment, record.promotionCredentials != nil {
            _ = try await repairEnrollmentPromotion()
            return NativeEnrollmentSummary(state: .registered, policy: record.policy, challenge: nil, receipts: [], requiresCheck: false)
        }
        return try await reconcileEnrollment(serial: serial, retryStart: retryStart)
    }
    private func reconcileEnrollment(serial: Int, retryStart: Bool = false, allowDeletionResume: Bool = false) async throws -> NativeEnrollmentSummary {
        guard var record = enrollment else { throw NativeAPIError.invalidResponse }
        try checkEnrollment(record, serial: serial, allowDeletionResume: allowDeletionResume)
        // Confirming that a lost first start was absent requires a current
        // anonymous bearer. Rotate ONLY this retained account when no server
        // device has ever been adopted; a committed enrollment is recovered
        // by signed read-only proof even if its old guest session was revoked.
        if record.state == .starting, record.deviceID == nil, let current = credentials,
           !current.authenticated, current.account_id == record.accountID, current.expiresAt <= Date() {
            _ = try await readyScope(anonymous: true)
            try checkEnrollment(record, serial: serial, allowDeletionResume: allowDeletionResume)
            record = enrollment!
        }
        let signed = try enrollmentRequest(record, step: "status")
        let token = credentials.flatMap { $0.account_id == record.accountID && !$0.authenticated && $0.expiresAt > Date() ? $0.access_token : nil }
        let captured = Scope(epoch: epoch, account: nil, token: token, retirementGeneration: sessionRetirement.snapshot().generation)
        let value: WireValue
        do { value = try await json("/auth/face/registration/recovery", method: "POST", body: signed.0, scope: captured) }
        catch NativeAPIError.denied(404, "enrollment_not_found") {
            try checkEnrollment(record, serial: serial, allowDeletionResume: allowDeletionResume)
            guard token != nil, record.deviceID == nil, record.state == .starting else { throw NativeAPIError.invalidResponse }
            if allowDeletionResume {
                // Authoritative absence is harmless during explicit recovery of
                // a rejected/expired deletion. It does not dispatch enrollment
                // or release the higher-priority deletion hold here.
                return NativeEnrollmentSummary(state: .starting, policy: record.policy, challenge: nil, receipts: [], requiresCheck: true)
            }
            if retryStart {
                let current = try await readyScope(anonymous: true); try checkEnrollment(record, serial: serial)
                guard current.account == record.accountID, credentials?.authenticated == false else { throw NativeAPIError.sessionChanged }
                let start = try await json("/auth/face/registration/challenge", method: "POST", body: record.startBody, scope: current)
                try checkEnrollment(record, serial: serial); _ = try acceptEnrollmentChallenge(start, record: record)
            }
            return try enrollmentSummary()!
        }
        try checkEnrollment(record, serial: serial, allowDeletionResume: allowDeletionResume)
        guard value["protocol"].string == "lovelies-face-enrollment-v1", value["account_id"].string == record.accountID,
              value["enrollment_key"].string == record.enrollmentKey, value["public_key_digest"].string == record.publicKeyDigest,
              value["policy_version"].string == record.policy, value["request_nonce"].string == signed.1,
              value["authenticated"].bool == false, value["access_token"] == .null, value["refresh_token"] == .null,
              let state = value["state"].string.flatMap(NativeEnrollmentState.init(rawValue:)),
              [.pending, .capturePending, .verifying, .registered, .restartRequired].contains(state),
              let generation = value["enrollment_generation"].integer,
              generation == record.generation || (record.resume != nil && generation == record.generation + 1),
              let rows = value["captures"].array, rows.count <= 3 else { throw NativeAPIError.invalidResponse }
        try value.requireExpiry("expires_at")
        let dates = ISO8601DateFormatter(); dates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expires = dates.date(from: try value.text("expires_at")), expires <= record.createdAt.addingTimeInterval(30 * 86400 + 120),
              record.recoveryExpiresAt == nil || record.recoveryExpiresAt == expires else { throw NativeAPIError.invalidResponse }
        let device = try value.uuid("device_id"), revision = try value.uuid("device_revision")
        let predecessor = try value.uuid("challenge_id")
        if generation == record.generation, let previous = record.predecessorID { guard previous == predecessor else { throw NativeAPIError.invalidResponse } }
        if let previous = record.deviceID { guard previous == device, record.deviceRevision == revision else { throw NativeAPIError.invalidResponse } }
        var next = record; next.deviceID = device; next.deviceRevision = revision; next.recoveryExpiresAt = expires; next.predecessorID = predecessor
        if generation != record.generation { next.generation = generation; next.captures = []; next.retiredCaptures = []; next.resume = nil; next.challengeWire = nil }
        let accepted = try rows.map { try NativeEnrollmentCapture($0) }
        guard Set(accepted.map(\.index)).count == accepted.count else { throw NativeAPIError.invalidResponse }
        if [.pending, .capturePending, .verifying].contains(state) {
            guard accepted.enumerated().allSatisfy({ $0.offset == $0.element.index }),
                  next.captures.filter(\.accepted).allSatisfy({ previous in accepted.contains { $0.wire == previous.wire } }) else { throw NativeAPIError.invalidResponse }
        }
        for capture in accepted {
            let planned = (next.captures + (state == .restartRequired ? next.retiredCaptures : [])).first { $0.index == capture.index }
            guard planned?.wire == capture.wire else { throw NativeAPIError.invalidResponse }
        }
        if state == .registered {
            guard value["challenge"] == .null, rows.isEmpty, value["profile"] != .null else { throw NativeAPIError.invalidResponse }
            let profile = try NativeEnrollmentProfile(value["profile"])
            if let previous = record.profile { guard profile == previous else { throw NativeAPIError.invalidResponse } }
            next.profile = profile; next.challengeWire = nil; next.captures = []; next.retiredCaptures = []; next.loginChallengeWire = nil; next.loginTerminalCode = nil; next.loginCaptures = []; next.state = .registered
            if !allowDeletionResume, credentials != nil { try retireForRestriction() }
            try saveEnrollment(next)
            if !allowDeletionResume {
                try secrets.write("registered-device", data: JSONEncoder().encode(RegisteredDevice(accountID: next.accountID, faceHandle: next.faceHandle, deviceID: device, profileID: profile.id, profileRevision: profile.revision, modelID: profile.modelID)))
            }
        } else {
            guard value["profile"] == .null else { throw NativeAPIError.invalidResponse }
            if let base = value["challenge"].object {
                guard value["challenge"]["challenge_id"].string == predecessor else { throw NativeAPIError.invalidResponse }
                var enriched = base; enriched["enrollment_key"] = .string(record.enrollmentKey); enriched["public_key_digest"] = .string(record.publicKeyDigest)
                enriched["enrollment_generation"] = .integer(generation); enriched["face_handle"] = .string(record.faceHandle)
                next.challengeWire = .object(enriched)
            } else { guard value["challenge"] == .null, state != .pending else { throw NativeAPIError.invalidResponse } }
            if state == .restartRequired {
                // Physical cleanup of a terminal predecessor can leave empty
                // or sparse old proof rows. Their supplied identities are still
                // checked above, then retired as progress; only a same-device
                // successor with THREE fresh captures may complete enrollment.
                if !next.captures.isEmpty { next.retiredCaptures = next.captures }
                next.captures = []; next.challengeWire = nil
            }
            else if state == .pending { next.captures = accepted }
            else { for capture in accepted { next.captures[capture.index].accepted = true } }
            next.state = state; try saveEnrollment(next)
        }
        if allowDeletionResume {
            let challenge = try next.challengeWire.map { try NativeFaceChallenge($0, accountID: next.accountID, purpose: "registration", allowExpired: true) }
            return NativeEnrollmentSummary(state: next.state, policy: next.policy, challenge: challenge, receipts: next.captures.filter(\.accepted).map(\.wire), requiresCheck: true)
        }
        return try enrollmentSummary()!
    }
    private func resumeEnrollment(serial: Int) async throws -> NativeFaceChallenge {
        guard var record = enrollment, let predecessor = record.predecessorID, [.restartRequired, .pending].contains(record.state) else { throw NativeAPIError.invalidResponse }
        if record.resume == nil { record.resume = NativeEnrollmentResume(key: UUID().uuidString.lowercased(), generation: record.generation, challengeID: predecessor); try saveEnrollment(record) }
        let intent = record.resume!, current = try await readyScope(anonymous: true)
        try checkEnrollment(record, serial: serial)
        guard current.account == record.accountID, credentials?.authenticated == false else { throw NativeAPIError.sessionChanged }
        let signed = try enrollmentRequest(record, step: "resume", extra: ["resume_key": .string(intent.key), "expected_generation": .integer(intent.generation), "expected_challenge_id": .string(intent.challengeID)])
        let value = try await json("/auth/face/registration/resume", method: "POST", body: signed.0, scope: current)
        try checkEnrollment(record, serial: serial); return try acceptEnrollmentChallenge(value, record: enrollment!, successor: true)
    }
    private func repairEnrollmentPromotion() async throws -> NativeSessionSummary {
        guard let record = enrollment, let credential = record.promotionCredentials, let device = record.promotionDevice, guestDeletion == nil else { throw NativeAPIError.invalidResponse }
        try assertEnrollmentKey(record); try record.validate(origin: origin)
        try secrets.write("registered-device", data: JSONEncoder().encode(device))
        try activateLocalPromotion(credential, journal: record)
        if credential.expiresAt <= Date() { try await refresh() }
        let captured = try scope(anonymous: true), value = try await json("/me", scope: captured)
        guard value["user_id"].string == record.accountID, value["auth_method"].string == "registered_face", value["authenticated"].bool == true else { throw NativeAPIError.invalidResponse }
        try check(captured); guard guestDeletion == nil, enrollment?.enrollmentKey == record.enrollmentKey else { throw NativeAPIError.sessionChanged }
        try persistCredential(credentials!)
        try secrets.write("pending-face-device", data: nil); try secrets.write("face-enrollment-journal", data: nil); enrollment = nil
        return summary()!
    }
    func startFace(consentPolicy: String, publicKey: WireValue) async throws -> NativeFaceChallenge {
        if let held = audienceSuspension { throw NativeAPIError.operationUnconfirmed(held.operation.operationKey) }
        if faceLifecycle != nil, accountRecovery == nil {
            let recovered = try await freshFaceProfileLogin()
            guard let challenge = recovered.challenge else { throw NativeAPIError.authenticationRequired }; return challenge
        }
        let serial = try beginEnrollmentWork(); defer { endEnrollmentWork(serial) }
        if let saved = enrollment {
            guard publicKey == saved.publicJWK, consentPolicy == saved.policy else { throw NativeAPIError.unsupported(String(localized: "Use the original enrollment key and accepted policy to recover this account.")) }
            if try enrollmentLoginHeld(saved) { throw NativeAPIError.operationUnconfirmed(try saved.loginChallengeWire!.uuid("challenge_id")) }
            if try enrollmentLoginCurrent(saved) { return try NativeFaceChallenge(saved.loginChallengeWire!, accountID: saved.accountID, purpose: "login") }
            if saved.promotionCredentials != nil { _ = try await repairEnrollmentPromotion(); throw NativeAPIError.unsupported(String(localized: "Your account was recovered. Continue from the completed setup.")) }
            _ = try await reconcileEnrollment(serial: serial, retryStart: true)
            guard var current = enrollment else { throw NativeAPIError.invalidResponse }
            if current.state == .registered {
                let value = try await json("/auth/face/challenge", method: "POST", body: .object(["face_handle": .string(current.faceHandle), "device_id": .string(current.deviceID!)]))
                try checkEnrollment(current, serial: serial)
                let challenge = try NativeFaceChallenge(value, accountID: current.accountID, purpose: "login")
                guard value["profile_id"].string == current.profile?.id, value["profile_revision"].string == current.profile?.revision,
                      value["model_id"].string == current.profile?.modelID, value["device_revision"].string == current.deviceRevision,
                      value["policy_version"].string == current.policy else { throw NativeAPIError.invalidResponse }
                current.loginChallengeWire = value; current.loginTerminalCode = nil; current.loginCaptures = []; try saveEnrollment(current)
                return challenge
            }
            guard current.state == .pending || current.state == .restartRequired else { throw NativeAPIError.operationUnconfirmed(current.enrollmentKey) }
            let before = epoch; _ = try await readyScope(anonymous: true); try checkEnrollment(current, serial: serial)
            if epoch != before { _ = try await reconcileEnrollment(serial: serial); current = enrollment! }
            if current.state == .restartRequired { return try await resumeEnrollment(serial: serial) }
            guard current.state == .pending, let wire = current.challengeWire else { throw NativeAPIError.operationUnconfirmed(current.enrollmentKey) }
            let challenge = try NativeFaceChallenge(wire, accountID: current.accountID, purpose: "registration", allowExpired: true)
            if challenge.expiresAt <= Date() || current.resume != nil { return try await resumeEnrollment(serial: serial) }
            return challenge
        }
        if let saved = try device() {
            if let record = ordinaryLogin {
                try assertOrdinaryLoginKey(record)
                guard record.originalDevice.accountID == saved.accountID, record.originalDevice.deviceID == saved.deviceID, publicKey == record.publicJWK else { throw NativeAPIError.sessionChanged }
                let retained = try NativeFaceChallenge(record.challengeWire, accountID: saved.accountID, purpose: "login", allowExpired: true)
                if record.promotionCredentials != nil { _ = try await repairOrdinaryLoginPromotion(); throw NativeAPIError.unsupported(String(localized: "Your account was recovered. Continue from completed setup.")) }
                if record.terminalQualityCode == nil && record.terminalMismatch != true && retained.expiresAt > Date() {
                    guard !record.completionPending, record.captures.allSatisfy(\.accepted) else { throw NativeAPIError.operationUnconfirmed(retained.id) }
                    return retained
                }
            }
            let value = try await json("/auth/face/challenge", method: "POST", body: .object(["face_handle": .string(saved.faceHandle), "device_id": .string(saved.deviceID)]))
            guard guestDeletion == nil, enrollmentSerial == serial else { throw NativeAPIError.sessionChanged }
            let challenge = try NativeFaceChallenge(value, accountID: saved.accountID, purpose: "login")
            var record = NativeOrdinaryLoginRecord(apiOrigin: origin.absoluteString, originalDevice: saved, publicJWK: publicKey,
                publicKeyDigest: signer.sha256(try publicKey.canonical()), challengeWire: value, createdAt: Date(), bindingSignature: "")
            record.bindingSignature = try signDevice(record.binding.canonical(), alias: record.keyAlias)
            try saveOrdinaryLogin(record); return challenge
        }
        let captured = try await readyScope(anonymous: true)
        _ = try await requireAudience(.faceAuthentication, captured: captured)
        guard credentials?.authenticated == false, let original = credentials, enrollmentSerial == serial else { throw NativeAPIError.authenticationRequired }
        var random = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw NativeAPIError.unavailable("secure_random") }
        let handle = "lfh_" + Data(random).base64URL, key = UUID().uuidString.lowercased()
        let envelope: WireValue = .object(["protocol": .string("lovelies-face-enrollment-device-v1"), "step": .string("start"), "account_id": .string(original.account_id),
            "enrollment_key": .string(key), "face_handle": .string(handle), "policy_version": .string(consentPolicy), "device_public_jwk": publicKey])
        let record = NativeEnrollmentRecord(accountID: original.account_id, apiOrigin: origin.absoluteString, enrollmentKey: key, keyAlias: NativeEnrollmentRecord.keyAlias,
            publicJWK: publicKey, publicKeyDigest: signer.sha256(try publicKey.canonical()), faceHandle: handle, policy: consentPolicy, consent: true, createdAt: Date(),
            startSignature: try signDevice(envelope.canonical()), originalAnonymous: original)
        try saveEnrollment(record) // Identity and original signature precede all registration traffic.
        let value = try await json("/auth/face/registration/challenge", method: "POST", body: record.startBody, scope: captured)
        try checkEnrollment(record, serial: serial)
        return try acceptEnrollmentChallenge(value, record: record)
    }
    func capture(_ bytes: Data, index: Int, challenge: NativeFaceChallenge) async throws -> WireValue {
        try await requireFaceAudience(challenge)
        if faceLifecycle != nil, accountRecovery == nil { return try await captureFaceLifecycle(bytes, index: index, challenge: challenge) }
        if accountRecovery != nil { return try await captureAccountRecovery(bytes, index: index, challenge: challenge) }
        guard enrollment != nil || ordinaryLogin != nil else { throw NativeAPIError.operationUnconfirmed(challenge.id) }
        let serial = try beginEnrollmentWork(); defer { endEnrollmentWork(serial) }
        guard challenge.expiresAt > Date(), challenge.poses.indices.contains(index), !bytes.isEmpty, bytes.count <= 8 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        let captured = challenge.purpose == "registration" ? try await readyScope(anonymous: true) : Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation)
        let hash = signer.sha256(bytes), mime = "image/jpeg"
        if var record = ordinaryLogin, enrollment == nil {
            try assertOrdinaryLoginKey(record)
            guard record.challengeWire == challenge.wire, index == 0, record.captures.isEmpty, !record.completionPending, record.terminalQualityCode == nil else { throw NativeAPIError.operationUnconfirmed(challenge.id) }
            record.captures = [NativeEnrollmentCapture(index: index, sha256: hash, byteSize: bytes.count)]; try saveOrdinaryLogin(record)
        }
        if var record = enrollment {
            try checkEnrollment(record, serial: serial); try assertEnrollmentKey(record)
            guard record.state == (challenge.purpose == "registration" ? .pending : .registered) else { throw NativeAPIError.operationUnconfirmed(record.enrollmentKey) }
            let saved = challenge.purpose == "registration" ? record.challengeWire : record.loginChallengeWire
            guard saved?["challenge_id"].string == challenge.id else { throw NativeAPIError.invalidResponse }
            var captures = challenge.purpose == "registration" ? record.captures : record.loginCaptures
            guard captures.count == index, captures.allSatisfy(\.accepted), captures.reduce(0, { $0 + $1.byte_size }) + bytes.count <= 8 * 1024 * 1024 else { throw NativeAPIError.operationUnconfirmed(record.enrollmentKey) }
            captures.append(NativeEnrollmentCapture(index: index, sha256: hash, byteSize: bytes.count))
            if challenge.purpose == "registration" { record.captures = captures } else { record.loginCaptures = captures }
            record.state = .capturePending; try saveEnrollment(record)
        }
        var envelope = challenge.deviceEnvelope(); envelope["step"] = .string("capture"); envelope["capture_index"] = .integer(index)
        envelope["capture_sha256"] = .string(hash); envelope["mime"] = .string(mime); envelope["byte_size"] = .integer(bytes.count)
        let signature = try signDevice(WireValue.object(envelope).canonical(), alias: try device()?.keyAlias ?? NativeEnrollmentRecord.keyAlias)
        let reply = try await request("/auth/face/proof/\(challenge.id)/\(index)", method: "PUT", raw: bytes,
            headers: ["Content-Type": mime, "X-Lovelies-Capture-SHA256": hash, "X-Lovelies-Capture-Bytes": String(bytes.count), "X-Lovelies-Device-Signature": signature], scope: captured)
        guard guestDeletion == nil, enrollmentSerial == serial else { throw NativeAPIError.sessionChanged }
        let receipt = try WireValue.decoded(reply.data)
        guard receipt["protocol"].string == "lovelies-face-auth-v1", receipt["status"].string == "capture_received",
              receipt["challenge_id"].string == challenge.id, receipt["capture_index"].integer == index,
              receipt["capture_sha256"].string == hash, receipt["byte_size"].integer == bytes.count else { throw NativeAPIError.invalidResponse }
        if var record = enrollment {
            if challenge.purpose == "registration" { record.captures[index].accepted = true; record.state = .pending }
            else { record.loginCaptures[index].accepted = true; record.state = .registered }
            try saveEnrollment(record)
        }
        if var record = ordinaryLogin, enrollment == nil {
            guard record.challengeWire == challenge.wire, record.captures.count == 1, record.captures[0].sha256 == hash else { throw NativeAPIError.sessionChanged }
            record.captures[0].accepted = true; try saveOrdinaryLogin(record)
        }
        return .object(["index": .integer(index), "sha256": .string(hash), "mime": .string(mime), "byte_size": .integer(bytes.count)])
    }
    func completeFace(_ challenge: NativeFaceChallenge, captures: [WireValue]) async throws -> NativeSessionSummary {
        try await requireFaceAudience(challenge)
        if faceLifecycle != nil, accountRecovery == nil { return try await completeFaceLifecycle(challenge, captures: captures) }
        if accountRecovery != nil { return try await completeAccountRecovery(challenge, captures: captures) }
        guard enrollment != nil || ordinaryLogin != nil else { throw NativeAPIError.operationUnconfirmed(challenge.id) }
        let serial = try beginEnrollmentWork(); defer { endEnrollmentWork(serial) }
        guard captures.count == challenge.poses.count, challenge.expiresAt > Date() else { throw NativeAPIError.invalidResponse }
        if var record = ordinaryLogin, enrollment == nil {
            try assertOrdinaryLoginKey(record)
            guard record.challengeWire == challenge.wire, !record.completionPending, record.terminalQualityCode == nil,
                  record.captures.allSatisfy(\.accepted), record.captures.map(\.wire) == captures else { throw NativeAPIError.operationUnconfirmed(challenge.id) }
            record.completionPending = true; try saveOrdinaryLogin(record)
        }
        if var record = enrollment {
            try checkEnrollment(record, serial: serial); try assertEnrollmentKey(record)
            guard record.state == (challenge.purpose == "registration" ? .pending : .registered) else { throw NativeAPIError.operationUnconfirmed(record.enrollmentKey) }
            let planned = challenge.purpose == "registration" ? record.captures : record.loginCaptures
            guard planned.allSatisfy(\.accepted), planned.map(\.wire) == captures,
                  (challenge.purpose == "registration" ? record.challengeWire : record.loginChallengeWire)?["challenge_id"].string == challenge.id else { throw NativeAPIError.invalidResponse }
            record.state = .completionPending; try saveEnrollment(record)
        }
        let captured = challenge.purpose == "registration" ? try scope(anonymous: true) : Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation)
        var envelope = challenge.deviceEnvelope(); envelope["step"] = .string("complete"); envelope["capture_manifest"] = .array(captures)
        let signature = try signDevice(WireValue.object(envelope).canonical(), alias: try device()?.keyAlias ?? NativeEnrollmentRecord.keyAlias)
        let path = challenge.purpose == "registration" ? "/auth/face/registration/complete" : "/auth/face/complete"
        let value: WireValue
        do { value = try await json(path, method: "POST", body: .object(["challenge_id": .string(challenge.id), "device_signature": .string(signature)]), scope: captured) }
        catch {
            if let terminal = NativeFaceTerminalFailure.code(error), enrollmentSerial == serial {
                if var record = ordinaryLogin, record.challengeWire == challenge.wire {
                    if terminal == "face_verification_failed" { record.terminalMismatch = true } else { record.terminalQualityCode = terminal }
                    try saveOrdinaryLogin(record)
                } else if var record = enrollment, challenge.purpose == "login", record.loginChallengeWire == challenge.wire {
                    record.loginTerminalCode = terminal; try saveEnrollment(record)
                }
            }
            throw error
        }
        guard guestDeletion == nil, enrollmentSerial == serial else { throw NativeAPIError.sessionChanged }
        guard value["protocol"].string == "lovelies-face-auth-v1", value["status"].string == "authenticated", value["device_id"].string == challenge.deviceID else { throw NativeAPIError.invalidResponse }
        let profileID = try value.uuid("profile_id"), revision = try value.text("profile_revision"), model = try value.text("model_id")
        if challenge.wire["profile_id"] != .null, challenge.wire["profile_id"].string != profileID || challenge.wire["profile_revision"].string != revision || challenge.wire["model_id"].string != model { throw NativeAPIError.invalidResponse }
        try check(captured)
        if var record = enrollment {
            let profile = NativeEnrollmentProfile(id: profileID, revision: revision, modelID: model)
            if let previous = record.profile { guard previous == profile else { throw NativeAPIError.invalidResponse } }
            let credential = try NativeCredentials(value)
            guard credential.account_id == record.accountID, credential.authenticated else { throw NativeAPIError.sessionChanged }
            record.profile = profile; record.promotionCredentials = credential
            record.promotionDevice = RegisteredDevice(accountID: record.accountID, faceHandle: record.faceHandle, deviceID: challenge.deviceID, profileID: profileID, profileRevision: revision, modelID: model)
            record.state = .promoting; try saveEnrollment(record)
            return try await repairEnrollmentPromotion()
        }
        if var record = ordinaryLogin {
            guard record.challengeWire == challenge.wire, profileID == record.originalDevice.profileID,
                  revision == record.originalDevice.profileRevision, model == record.originalDevice.modelID else { throw NativeAPIError.sessionChanged }
            let next = try NativeCredentials(value); guard next.account_id == record.originalDevice.accountID, next.authenticated else { throw NativeAPIError.sessionChanged }
            record.promotionCredentials = next; try saveOrdinaryLogin(record)
            return try await repairOrdinaryLoginPromotion()
        }
        try adopt(value, expected: challenge.accountID, method: "registered_face")
        guard let savedData = try secrets.read("registered-device") ?? secrets.read("pending-face-device") else { throw NativeAPIError.invalidResponse }
        var saved = try JSONDecoder().decode(RegisteredDevice.self, from: savedData)
        guard saved.accountID == challenge.accountID, saved.deviceID == challenge.deviceID else { throw NativeAPIError.invalidResponse }
        saved.profileID = profileID; saved.profileRevision = revision; saved.modelID = model
        try secrets.write("registered-device", data: JSONEncoder().encode(saved)); try secrets.write("pending-face-device", data: nil)
        _ = try await current(); return summary()!
    }

    /// Explicit retake reconciles immutable signed receipts before considering a
    /// successor. It does not resubmit bytes or replace a previously accepted slot.
    func prepareFaceRetake(_ previous: NativeFaceChallenge, terminalQualityFailure: Bool) async throws -> NativeFaceRetakeResult {
        guard guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
        if let record = faceLifecycle, accountRecovery == nil {
            guard previous.accountID == record.accountID, previous.deviceID == record.originalDevice.deviceID else { throw NativeAPIError.sessionChanged }
            let checked = try await checkFaceLifecycle()
            guard faceLifecycle?.controlOperationKey == record.controlOperationKey, faceLifecycle?.accountID == record.accountID,
                  faceLifecycle?.originalDevice.deviceID == record.originalDevice.deviceID, faceLifecycle?.publicKeyDigest == record.publicKeyDigest else { throw NativeAPIError.sessionChanged }
            if let operation = checked.operation, operation.action.captures, previous.wire["lifecycle_operation_key"].string == operation.operationKey {
                guard operation.predecessorID == previous.id || operation.generation > (previous.wire["lifecycle_generation"].integer ?? 0) else { throw NativeAPIError.sessionChanged }
                if operation.serverState == "completed" {
                    if summary()?.authenticated == true { return NativeFaceRetakeResult(challenge: nil, receipts: [], awaitingServer: false) }
                    let login = try await freshFaceProfileLogin()
                    return try checkedRetake(previous, challenge: login.challenge, receipts: login.receipts, awaitingServer: login.awaitingServer, registeredTransition: true)
                }
                if ["restart_required", "failed"].contains(operation.serverState ?? "") {
                    let recovered = try await startFaceProfileCapture(operation.action, consentPolicy: operation.consent?["policy_version"].string ?? "", expectedVersion: checked.metadata.version)
                    return try checkedRetake(previous, challenge: recovered.challenge, receipts: recovered.receipts, awaitingServer: recovered.awaitingServer)
                }
                return try checkedRetake(previous, challenge: checked.challenge, receipts: checked.receipts, awaitingServer: checked.awaitingServer)
            }
            guard previous.purpose == "login", record.loginChallengeWire == previous.wire,
                  terminalQualityFailure || NativeFaceTerminalFailure.known(record.loginTerminalCode) || previous.expiresAt <= Date() else { throw NativeAPIError.operationUnconfirmed(previous.id) }
            let login = try await freshFaceProfileLogin()
            return try checkedRetake(previous, challenge: login.challenge, receipts: login.receipts, awaitingServer: login.awaitingServer)
        }
        if let record = accountRecovery {
            guard previous.accountID == record.accountID, previous.deviceID == record.deviceID else { throw NativeAPIError.sessionChanged }
            let recovered = try await continueAccountRecovery()
            if summary()?.authenticated == true && recovered.challenge == nil {
                guard summary()?.accountID == previous.accountID else { throw NativeAPIError.sessionChanged }
                return NativeFaceRetakeResult(challenge: nil, receipts: [], awaitingServer: false)
            }
            guard accountRecovery?.requestID == record.requestID, accountRecovery?.publicKeyDigest == record.publicKeyDigest else { throw NativeAPIError.sessionChanged }
            return try checkedRetake(previous, challenge: recovered.challenge, receipts: recovered.receipts, awaitingServer: recovered.awaitingServer)
        }
        if let record = enrollment {
            guard previous.accountID == record.accountID, previous.deviceID == record.deviceID else { throw NativeAPIError.sessionChanged }
            if previous.purpose == "login" {
                guard record.loginChallengeWire == previous.wire else { throw NativeAPIError.sessionChanged }
                if record.state == .registered, !record.loginCaptures.isEmpty, record.loginCaptures.allSatisfy(\.accepted), record.loginTerminalCode == nil, previous.expiresAt > Date() {
                    return NativeFaceRetakeResult(challenge: previous, receipts: record.loginCaptures.map(\.wire), awaitingServer: false)
                }
                if !terminalQualityFailure, !NativeFaceTerminalFailure.known(record.loginTerminalCode), previous.expiresAt > Date(), record.promotionCredentials == nil { throw NativeAPIError.operationUnconfirmed(previous.id) }
            }
            let recovered = try await recoverEnrollment()
            if recovered.awaitingServer { return NativeFaceRetakeResult(challenge: nil, receipts: recovered.receipts, awaitingServer: true) }
            if summary()?.authenticated == true {
                guard summary()?.accountID == previous.accountID else { throw NativeAPIError.sessionChanged }
                return NativeFaceRetakeResult(challenge: nil, receipts: [], awaitingServer: false)
            }
            guard let current = enrollment, current.accountID == record.accountID, current.enrollmentKey == record.enrollmentKey,
                  current.publicKeyDigest == record.publicKeyDigest else { throw NativeAPIError.sessionChanged }
            let challenge = try await startFace(consentPolicy: current.policy, publicKey: current.publicJWK)
            let latest = try enrollmentSummary()
            return try checkedRetake(previous, challenge: challenge, receipts: latest?.receipts ?? [], awaitingServer: latest?.awaitingServer ?? false, registeredTransition: recovered.state == .registered)
        }
        if let held = ordinaryLogin {
            let record = try retireExpiredOrdinaryPromotion(held)
            guard record.challengeWire == previous.wire else { throw NativeAPIError.sessionChanged }
            try assertOrdinaryLoginKey(record)
            if record.promotionCredentials != nil {
                _ = try await repairOrdinaryLoginPromotion(); return NativeFaceRetakeResult(challenge: nil, receipts: [], awaitingServer: false)
            }
            if record.terminalQualityCode == nil && record.terminalMismatch != true && previous.expiresAt > Date() {
                guard !record.completionPending, record.captures.allSatisfy(\.accepted) else { throw NativeAPIError.operationUnconfirmed(previous.id) }
                return NativeFaceRetakeResult(challenge: previous, receipts: record.captures.map(\.wire), awaitingServer: false)
            }
            let challenge = try await startFace(consentPolicy: try previous.wire.text("policy_version"), publicKey: record.publicJWK)
            return try checkedRetake(previous, challenge: challenge, receipts: [], awaitingServer: false)
        }
        guard previous.purpose == "login", terminalQualityFailure || previous.expiresAt <= Date(),
              let known = try device(), known.accountID == previous.accountID, known.deviceID == previous.deviceID else { throw NativeAPIError.operationUnconfirmed(previous.id) }
        let challenge = try await startFace(consentPolicy: try previous.wire.text("policy_version"), publicKey: signer.publicJWK(alias: known.keyAlias ?? NativeEnrollmentRecord.keyAlias, create: false))
        return try checkedRetake(previous, challenge: challenge, receipts: [], awaitingServer: false)
    }
    private func checkedRetake(_ previous: NativeFaceChallenge, challenge: NativeFaceChallenge?, receipts: [WireValue], awaitingServer: Bool, registeredTransition: Bool = false) throws -> NativeFaceRetakeResult {
        if let challenge {
            guard challenge.accountID == previous.accountID, challenge.deviceID == previous.deviceID,
                  challenge.wire["device_revision"] == previous.wire["device_revision"], challenge.wire["policy_version"] == previous.wire["policy_version"] else { throw NativeAPIError.sessionChanged }
            if registeredTransition {
                guard challenge.purpose == "login", let profile = faceLifecycle?.metadata.profile ?? enrollment?.profile,
                      challenge.wire["profile_id"].string == profile.id, challenge.wire["profile_revision"].string == profile.revision,
                      challenge.wire["model_id"].string == profile.modelID else { throw NativeAPIError.sessionChanged }
            } else {
                guard challenge.wire["profile_id"] == previous.wire["profile_id"], challenge.wire["profile_revision"] == previous.wire["profile_revision"] else { throw NativeAPIError.sessionChanged }
            }
        }
        return NativeFaceRetakeResult(challenge: challenge, receipts: receipts, awaitingServer: awaitingServer)
    }

    private func saveOrdinaryLogin(_ record: NativeOrdinaryLoginRecord) throws {
        try record.validate(origin: origin); let data = try JSONEncoder().encode(record)
        guard data.count <= 32 * 1024 else { throw NativeAPIError.invalidResponse }
        if let staged = record.promotionCredentials, !credentialCurrent(staged) { throw NativeAPIError.sessionChanged }
        try replaceOwnedJournal("ordinary-face-login-journal", previous: ordinaryLogin, replacement: record); ordinaryLogin = record
    }
    private func restoreOrdinaryLogin() throws {
        guard let data = try secrets.read("ordinary-face-login-journal") else { ordinaryLogin = nil; return }
        guard data.count <= 32 * 1024 else { throw NativeAPIError.invalidResponse }
        let record = try JSONDecoder().decode(NativeOrdinaryLoginRecord.self, from: data)
        try record.validate(origin: origin); try assertOrdinaryLoginKey(record)
        guard let saved = try device(), saved.accountID == record.originalDevice.accountID, saved.deviceID == record.originalDevice.deviceID,
              (saved.keyAlias ?? NativeEnrollmentRecord.keyAlias) == record.keyAlias, saved.faceHandle == record.originalDevice.faceHandle,
              saved.profileID == record.originalDevice.profileID, saved.profileRevision == record.originalDevice.profileRevision else { throw NativeAPIError.sessionChanged }
        ordinaryLogin = record
        if record.promotionCredentials.map({ !credentialCurrent($0) }) == true || authorityLedger.retiredChallenge(record.challengeWire["challenge_id"].string) {
            var archived = record; archived.promotionCredentials = nil
            let slot = "retired-ordinary-face-logins-v1"
            let previous = try secrets.read(slot)
            var rows = try previous.map { try JSONDecoder().decode([NativeOrdinaryLoginRecord].self, from: $0) } ?? []
            if !rows.contains(where: { $0.challengeWire["challenge_id"] == record.challengeWire["challenge_id"] }) {
                guard rows.count < 128 else { throw NativeAPIError.unavailable("session_retirement_storage_full") }; rows.append(archived)
            }
            guard try secrets.compareAndSwap(slot, expected: previous, replacement: JSONEncoder().encode(rows)),
                  try secrets.compareAndSwap("ordinary-face-login-journal", expected: data, replacement: nil) else { throw NativeAPIError.sessionChanged }
            ordinaryLogin = nil; return
        }
        _ = try retireExpiredOrdinaryPromotion(record)
    }
    private func assertOrdinaryLoginKey(_ record: NativeOrdinaryLoginRecord) throws {
        let binding = try record.binding.canonical(), signature = try signDevice(binding, alias: record.keyAlias)
        guard let raw = Data(base64URL: signature), raw.count == 64,
              try record.key().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: binding) else { throw NativeAPIError.sessionChanged }
    }
    func ordinaryLoginSummary() throws -> NativeOrdinaryLoginSummary? {
        guard guestDeletion == nil, enrollment == nil, accountRecovery == nil, faceLifecycle == nil, let record = ordinaryLogin else { return nil }
        let challenge = try NativeFaceChallenge(record.challengeWire, accountID: record.originalDevice.accountID, purpose: "login", allowExpired: true)
        return NativeOrdinaryLoginSummary(challenge: challenge, receipts: record.captures.filter(\.accepted).map(\.wire),
            awaitingServer: record.completionPending || record.captures.contains(where: { !$0.accepted }),
            terminalQuality: record.terminalQualityCode.flatMap(NativeFaceQualityFailure.init(rawValue:)), terminalMismatch: record.terminalMismatch == true)
    }
    func retainedFaceCaptureContext() throws -> NativeFaceChallenge? {
        guard guestDeletion == nil else { return nil }
        if let record = faceLifecycle, accountRecovery == nil, let wire = record.loginChallengeWire {
            return try NativeFaceChallenge(wire, accountID: record.accountID, purpose: "login", allowExpired: true)
        }
        if let record = accountRecovery, let wire = record.challengeWire { return try NativeFaceChallenge(wire, accountID: record.accountID, purpose: "login", allowExpired: true) }
        if let record = enrollment, let wire = record.loginChallengeWire { return try NativeFaceChallenge(wire, accountID: record.accountID, purpose: "login", allowExpired: true) }
        if let record = ordinaryLogin { return try NativeFaceChallenge(record.challengeWire, accountID: record.originalDevice.accountID, purpose: "login", allowExpired: true) }
        return nil
    }
    private func checkOrdinaryLogin(_ record: NativeOrdinaryLoginRecord, serial: Int) throws {
        guard guestDeletion == nil, enrollment == nil, accountRecovery == nil, faceLifecycle == nil, enrollmentSerial == serial, !Task.isCancelled,
              ordinaryLogin?.challengeWire == record.challengeWire, ordinaryLogin?.publicKeyDigest == record.publicKeyDigest,
              ordinaryLogin?.originalDevice.accountID == record.originalDevice.accountID else { throw NativeAPIError.sessionChanged }
    }
    private func retireExpiredOrdinaryPromotion(_ record: NativeOrdinaryLoginRecord) throws -> NativeOrdinaryLoginRecord {
        guard let staged = record.promotionCredentials, staged.expiresAt <= Date() else { return record }
        try retireForRestriction(staged)
        var held = record; held.promotionCredentials = nil; try saveOrdinaryLogin(held)
        return held
    }
    private func repairOrdinaryLoginPromotion() async throws -> NativeSessionSummary {
        guard let record = ordinaryLogin, let staged = record.promotionCredentials else { throw NativeAPIError.invalidResponse }
        let serial = enrollmentSerial; try assertOrdinaryLoginKey(record); try checkOrdinaryLogin(record, serial: serial)
        try activateLocalPromotion(staged, journal: record)
        if staged.expiresAt <= Date() { _ = try retireExpiredOrdinaryPromotion(record); throw NativeAPIError.operationUnconfirmed(try record.challengeWire.uuid("challenge_id")) }
        try checkOrdinaryLogin(record, serial: serial)
        let captured = try scope(anonymous: true), value = try await json("/me", scope: captured)
        try check(captured); try checkOrdinaryLogin(record, serial: serial)
        guard value["user_id"].string == record.originalDevice.accountID, value["auth_method"].string == "registered_face", value["authenticated"].bool == true,
              value["profile_id"].string == record.originalDevice.profileID, value["profile_revision"].string == record.originalDevice.profileRevision else { throw NativeAPIError.invalidResponse }
        let devices = try await json("/me/devices", scope: captured); try check(captured); try checkOrdinaryLogin(record, serial: serial)
        guard let rows = devices["items"].array, rows.filter({ $0["current"].bool == true }).count == 1,
              rows.filter({ $0["id"].string == record.originalDevice.deviceID }).count == 1,
              rows.contains(where: { $0["current"].bool == true && $0["id"].string == record.originalDevice.deviceID && $0["status"].string == "active" }) else { throw NativeAPIError.invalidResponse }
        try persistCredential(credentials!)
        try secrets.write("ordinary-face-login-journal", data: nil); ordinaryLogin = nil
        return summary()!
    }

    func guestDeletionSummary() -> NativeGuestDeletionSummary? {
        guard let record = guestDeletion, credentials == nil || (credentials?.account_id == record.accountID && credentials?.auth_method == "anonymous") else { return nil }
        let original = record.originalCredentials != nil
        let canRetry = record.status == nil && original && Date() < record.preparedAt.addingTimeInterval(30 * 86400)
        let receiptCurrent = record.status.map { $0.receiptExpiresAt > Date() } ?? false
        let unavailable = record.statusUnavailable || (record.status.map { $0.isTerminal && $0.receiptExpiresAt <= Date() } ?? false)
        let canResume = original && receiptCurrent && !unavailable && record.status?.completed != true &&
            (record.status?.requestExpired == true || [.rejected, .cancelled].contains(record.status?.phase ?? .pendingApproval))
        return NativeGuestDeletionSummary(status: record.status, statusUnavailable: unavailable, canRetryOriginal: canRetry, canResumeSetup: canResume)
    }
    private func beginGuestDeletionWork() throws -> Int {
        guard (faceLifecycle == nil || guestDeletion != nil), !lifecycleBusy, accountRecovery == nil, !recoveryBusy, !guestDeletionBusy, !enrollmentBusy else { throw NativeAPIError.unsupported(String(localized: "An enrollment, recovery or guest deletion check is already running.")) }
        guestDeletionBusy = true; guestDeletionSerial += 1; return guestDeletionSerial
    }
    private func endGuestDeletionWork(_ serial: Int) { if guestDeletionSerial == serial { guestDeletionBusy = false } }
    private func checkGuestDeletion(_ record: NativeGuestDeletionRecord, serial: Int) throws {
        guard guestDeletionSerial == serial, guestDeletion?.operationKey == record.operationKey,
              guestDeletion?.statusToken == record.statusToken, guestDeletion?.accountID == record.accountID,
              record.apiOrigin == origin.absoluteString,
              credentials == nil || (credentials?.account_id == record.accountID && credentials?.auth_method == "anonymous") else { throw NativeAPIError.sessionChanged }
    }
    private func saveGuestDeletion(_ record: NativeGuestDeletionRecord) throws {
        try record.validate(origin: origin)
        let data = try JSONEncoder().encode(record)
        guard data.count <= 16 * 1024 else { throw NativeAPIError.invalidResponse }
        try replaceOwnedJournal("guest-deletion-receipt", previous: guestDeletion, replacement: record); guestDeletion = record
    }
    private static func deletionToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw NativeAPIError.unavailable("secure_random") }
        return "lvd_" + bytes.map { String(format: "%02x", $0) }.joined()
    }
    /// Only this deletion creation method admits the current anonymous bearer.
    /// Protected gallery/export/sharing methods keep their registered guard.
    func requestGuestDeletion(reason: String? = nil) async throws -> NativeGuestDeletionSummary {
        if guestDeletion == nil { try restoreEnrollment() }
        if guestDeletion == nil, enrollment != nil {
            let status = try await recoverEnrollment()
            guard !status.awaitingServer, status.state != .registered, status.state != .promoting else {
                throw NativeAPIError.unsupported(String(localized: "Check and recover your current enrollment before requesting guest deletion. No deletion request has been sent."))
            }
        }
        let serial = try beginGuestDeletionWork(); defer { endGuestDeletionWork(serial) }
        if let saved = guestDeletion { return try await reconcileGuestDeletion(saved, serial: serial, retryOriginal: true) }
        let captured = try await readyScope(anonymous: true)
        guard guestDeletionSerial == serial, guestDeletionBusy else { throw NativeAPIError.sessionChanged }
        guard credentials?.auth_method == "anonymous", let original = credentials else { throw NativeAPIError.unsupported(String(localized: "Use the registered account privacy flow for this account.")) }
        try check(captured)
        let record = NativeGuestDeletionRecord(accountID: original.account_id, operationKey: UUID().uuidString.lowercased(),
            statusToken: try Self.deletionToken(), apiOrigin: origin.absoluteString, reason: reason, preparedAt: Date(), originalCredentials: original)
        try saveGuestDeletion(record) // Both the receipt and exact body precede dispatch.
        return try await submitGuestDeletion(record, serial: serial, captured: captured)
    }
    private func submitGuestDeletion(_ record: NativeGuestDeletionRecord, serial: Int, captured: Scope) async throws -> NativeGuestDeletionSummary {
        try checkGuestDeletion(record, serial: serial); try check(captured)
        let value = try await json("/privacy/account-deletion", method: "POST", body: record.payload, scope: captured)
        try checkGuestDeletion(record, serial: serial)
        try acceptGuestDeletion(value, record: record, serial: serial)
        return guestDeletionSummary()!
    }
    /// Status is a dedicated, non-bearer, read-only receipt exchange. Unknown or
    /// expired receipts never authorize new account creation or other APIs.
    func checkGuestDeletion(retryOriginal: Bool = false) async throws -> NativeGuestDeletionSummary {
        let serial = try beginGuestDeletionWork(); defer { endGuestDeletionWork(serial) }
        guard let record = guestDeletion else { throw NativeAPIError.invalidResponse }
        return try await reconcileGuestDeletion(record, serial: serial, retryOriginal: retryOriginal)
    }
    private func reconcileGuestDeletion(_ record: NativeGuestDeletionRecord, serial: Int, retryOriginal: Bool) async throws -> NativeGuestDeletionSummary {
        try record.validate(origin: origin); try checkGuestDeletion(record, serial: serial)
        let captured = Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation)
        do {
            let value = try await json("/privacy/account-deletion/status", method: "POST", body: .object(["status_token": .string(record.statusToken)]), scope: captured)
            try checkGuestDeletion(record, serial: serial)
            try acceptGuestDeletion(value, record: record, serial: serial)
            return guestDeletionSummary()!
        } catch NativeAPIError.denied(404, "deletion_status_unavailable") {
            try checkGuestDeletion(record, serial: serial)
            var unavailable = record; unavailable.statusUnavailable = true; try saveGuestDeletion(unavailable)
            if retryOriginal, record.status == nil, Date() < record.preparedAt.addingTimeInterval(30 * 86400), record.originalCredentials != nil {
                let originalScope = try await activateOriginalGuest(record, serial: serial)
                guard let current = guestDeletion else { throw NativeAPIError.sessionChanged }
                return try await submitGuestDeletion(current, serial: serial, captured: originalScope)
            }
            return guestDeletionSummary()!
        }
    }
    private func activateOriginalGuest(_ record: NativeGuestDeletionRecord, serial: Int) async throws -> Scope {
        try checkGuestDeletion(record, serial: serial)
        guard let original = guestDeletion?.originalCredentials, original.account_id == record.accountID, original.auth_method == "anonymous" else { throw NativeAPIError.unsupported(String(localized: "The original guest credentials are unavailable. Keep this deletion status receipt.")) }
        if credentials == nil { credentials = original; epoch += 1 }
        let captured = try await readyScope(anonymous: true)
        try checkGuestDeletion(record, serial: serial)
        // A refresh is single-use. Preserve the same-account rotation even if
        // the following account validation fails or loses its response.
        var refreshed = guestDeletion!; refreshed.originalCredentials = credentials; try saveGuestDeletion(refreshed)
        let current = try await json("/me", scope: captured)
        guard current["user_id"].string == record.accountID, current["auth_method"].string == "anonymous", current["authenticated"].bool == false else { throw NativeAPIError.sessionChanged }
        try checkGuestDeletion(record, serial: serial); try check(captured)
        return captured
    }
    private func acceptGuestDeletion(_ value: WireValue, record: NativeGuestDeletionRecord, serial: Int) throws {
        try checkGuestDeletion(record, serial: serial)
        let status = try NativeGuestDeletionStatus(value, record: record)
        if record.status?.completed == true, !status.completed { throw NativeAPIError.invalidResponse }
        var acknowledged = guestDeletion!; acknowledged.status = status; acknowledged.statusUnavailable = false
        if status.completed { acknowledged.originalCredentials = nil }
        else if let current = credentials { try current.validateAnonymousRecovery(accountID: record.accountID); acknowledged.originalCredentials = current }
        let retiringCredential = credentials
        retireSessionAuthority()
        if !status.completed { try saveGuestDeletion(acknowledged) }
        try retireForRestriction(retiringCredential)
        // Retire public guest authority immediately; the encrypted original
        // credential is retained solely for explicit same-account recovery.
        try clearGuestDeviceReferences(account: record.accountID, completed: status.completed)
        // Publish terminal completion only after the local original credential
        // and guest references have been removed successfully. A storage error
        // keeps the prior durable receipt available for another status check.
        if status.completed { try saveGuestDeletion(acknowledged) }
    }
    private func clearGuestDeviceReferences(account: String, completed: Bool = false) throws {
        try NativeIdentityCustody.withLock {
        if completed { try retireFaceLifecycleAfterDeletion(account: account); try retireAudienceAfterDeletion(account: account) }
        var removedOwnReference = false, anotherReference = false, canClearKey = false
        var ownedAlias: String?, ownedPublicJWK: WireValue?
        if let data = try secrets.read("face-enrollment-journal") {
            let held = try JSONDecoder().decode(NativeEnrollmentRecord.self, from: data); try held.validate(origin: origin)
            if held.accountID == account {
                guard completed else { return } // Private recovery survives rejected/expired deletion; no capture/session is published.
                // Server-confirmed deletion authorizes this cleanup. Comparing
                // public key material proves only exact local alias ownership;
                // it cannot authenticate, sign or elevate a retired session.
                let ownedKey = deletionOwnsKey(account: account, alias: held.keyAlias, publicJWK: held.publicJWK)
                canClearKey = ownedKey
                if ownedKey { ownedAlias = held.keyAlias; ownedPublicJWK = held.publicJWK }
                try secrets.write("face-enrollment-journal", data: nil)
                if enrollment?.accountID == account { enrollment = nil; enrollmentSerial += 1 }
                removedOwnReference = ownedKey
            } else { anotherReference = true }
        }
        for key in ["registered-device", "pending-face-device"] {
            if let data = try secrets.read(key) {
                let device = try JSONDecoder().decode(RegisteredDevice.self, from: data)
                if device.accountID == account { try secrets.write(key, data: nil); removedOwnReference = true }
                else { anotherReference = true }
            }
        }
        if removedOwnReference && !anotherReference && canClearKey, let ownedAlias { try retireUnreferencedDeviceKey(alias: ownedAlias, publicJWK: ownedPublicJWK) }
        }
    }
    private func deletionOwnsKey(account: String, alias: String, publicJWK: WireValue) -> Bool {
        guard NativeAccountRecoveryRecord.validAlias(alias),
              let expected = try? publicJWK.canonical(),
              let actual = try? signer.publicJWK(alias: alias, create: false).canonical() else { return false }
        guard expected == actual else { return false }
        do {
            let slots = try localSigningSlots(), decoder = JSONDecoder()
            for name in ["registered-device", "pending-face-device"] {
                if let bytes = slots[name] {
                    let reference = try decoder.decode(RegisteredDevice.self, from: bytes); try validLocalDevice(reference)
                    if (reference.keyAlias ?? NativeEnrollmentRecord.keyAlias) == alias && reference.accountID != account { return false }
                }
            }
            if let bytes = slots["face-enrollment-journal"] {
                let reference = try decoder.decode(NativeEnrollmentRecord.self, from: bytes); try reference.validate(origin: origin)
                if reference.keyAlias == alias && reference.accountID != account { return false }
            }
            if let bytes = slots["account-recovery-journal"] {
                let reference = try decoder.decode(NativeAccountRecoveryRecord.self, from: bytes); try reference.validate(origin: origin)
                if reference.keyAlias == alias && reference.accountID != account { return false }
            }
            if let bytes = slots["ordinary-face-login-journal"] {
                let reference = try decoder.decode(NativeOrdinaryLoginRecord.self, from: bytes); try reference.validate(origin: origin)
                if reference.keyAlias == alias && reference.originalDevice.accountID != account { return false }
            }
            if let bytes = slots["face-profile-lifecycle"] {
                let reference = try decoder.decode(NativeFaceLifecycleRecord.self, from: bytes); try reference.validate(origin: origin)
                if reference.keyAlias == alias && reference.accountID != account { return false }
            }
            return true
        } catch { return false } // Unknown/corrupt references never authorize key deletion.
    }
    /// Receipt/current-account preflight can retire/refresh the session. Finish
    /// that work before requesting OS authorization, then issue an opaque local
    /// ticket for the resulting exact epoch. This never signs a face request.
    func prepareGuestSetupResume() async throws -> NativeGuestSetupResumeTicket {
        preparedGuestResume = nil; invalidateLocalSigning()
        try Task.checkCancellation()
        let serial = try beginGuestDeletionWork(); defer { endGuestDeletionWork(serial) }
        guard let record = guestDeletion, guestDeletionSummary()?.canResumeSetup == true else { throw NativeAPIError.unsupported(String(localized: "Check the current deletion result before resuming this guest account.")) }
        try requireDurableGuestReceipt(record)
        let latest = try await reconcileGuestDeletion(record, serial: serial, retryOriginal: false)
        guard latest.canResumeSetup, let currentRecord = guestDeletion else { throw NativeAPIError.unsupported(String(localized: "This account cannot resume while its deletion outcome is unresolved.")) }
        let captured = try await activateOriginalGuest(currentRecord, serial: serial)
        try checkGuestDeletion(currentRecord, serial: serial); try check(captured); try Task.checkCancellation()
        guard let receipt = guestDeletion, let original = receipt.originalCredentials,
              Self.sameCredentials(credentials, original), original.auth_method == "anonymous",
              captured.account == receipt.accountID else { throw NativeAPIError.sessionChanged }
        try requireDurableGuestReceipt(receipt)
        let slots = try localSigningSlots()
        guard slots["account-recovery-journal"] == nil, slots["face-profile-lifecycle"] == nil,
              slots["ordinary-face-login-journal"] == nil else { throw NativeAPIError.sessionChanged }
        if let bytes = slots["face-enrollment-journal"] {
            let setup = try JSONDecoder().decode(NativeEnrollmentRecord.self, from: bytes); try setup.validate(origin: origin)
            guard setup.accountID == receipt.accountID else { throw NativeAPIError.sessionChanged }
            for name in ["registered-device", "pending-face-device"] {
                if let bytes = slots[name] {
                    let retained = try JSONDecoder().decode(RegisteredDevice.self, from: bytes); try validLocalDevice(retained)
                    guard retained.accountID == setup.accountID, retained.deviceID == setup.deviceID,
                          retained.faceHandle == setup.faceHandle, (retained.keyAlias ?? NativeEnrollmentRecord.keyAlias) == setup.keyAlias,
                          retained.profileID == nil || retained.profileID == setup.profile?.id && retained.profileRevision == setup.profile?.revision && retained.modelID == setup.profile?.modelID else { throw NativeAPIError.sessionChanged }
                }
            }
            enrollment = setup
        } else { enrollment = nil }
        let now = ProcessInfo.processInfo.systemUptime
        guard now.isFinite, now >= 0 else { throw NativeLocalAuthenticationIssue.expired }
        let ticket = NativeGuestSetupResumeTicket(id: UUID())
        preparedGuestResume = GuestResumePreparation(ticket: ticket, scope: captured,
            receiptDigest: try localEncodedDigest(receipt), stateDigest: localSigningStateDigest(slots), serial: serial, issuedAt: now)
        return ticket
    }
    private func requireDurableGuestReceipt(_ record: NativeGuestDeletionRecord) throws {
        try record.validate(origin: origin)
        guard let bytes = try secrets.read("guest-deletion-receipt"), bytes.count <= 16 * 1024,
              try localEncodedDigest(JSONDecoder().decode(NativeGuestDeletionRecord.self, from: bytes)) == localEncodedDigest(record) else { throw NativeAPIError.sessionChanged }
    }
    private func requireGuestResume(_ ticket: NativeGuestSetupResumeTicket) throws -> GuestResumePreparation {
        try Task.checkCancellation()
        let now = ProcessInfo.processInfo.systemUptime
        guard let prepared = preparedGuestResume, prepared.ticket.id == ticket.id,
              prepared.serial == guestDeletionSerial, !guestDeletionBusy,
              now.isFinite, now >= prepared.issuedAt, now < prepared.issuedAt + NativeLocalSigningLease.maximumLifetime,
              let receipt = guestDeletion, guestDeletionSummary()?.canResumeSetup == true,
              prepared.receiptDigest == (try localEncodedDigest(receipt)),
              receipt.accountID == prepared.scope.account, credentials?.auth_method == "anonymous",
              prepared.stateDigest == (try localSigningStateDigest(localSigningSlots())) else { throw NativeLocalAuthenticationIssue.bindingChanged }
        try check(prepared.scope); try requireDurableGuestReceipt(receipt)
        return prepared
    }
    func resumeGuestSetup() async throws -> NativeSessionSummary {
        try await resumeGuestSetup(prepareGuestSetupResume())
    }
    func resumeGuestSetup(_ ticket: NativeGuestSetupResumeTicket) async throws -> NativeSessionSummary {
        let prepared = try requireGuestResume(ticket)
        if signer.requiresLocalAuthentication, let enrollment {
            guard let lease = localSigningLease, lease.binding.purpose == .reconciliation,
                  lease.binding.accountID == prepared.scope.account, lease.binding.epoch == prepared.scope.epoch,
                  lease.binding.stateDigest == prepared.stateDigest, lease.binding.aliases == [enrollment.keyAlias],
                  let operation = NativeLocalSigningOperation.id else { throw NativeLocalAuthenticationIssue.required }
            _ = try lease.permit(enrollment.startEnvelope.canonical(), alias: enrollment.keyAlias, epoch: epoch, operationID: operation)
        }
        preparedGuestResume = nil // Single-use even if a subsequent reply is lost.
        let serial = try beginGuestDeletionWork(); defer { endGuestDeletionWork(serial) }
        guard let currentRecord = guestDeletion else { throw NativeAPIError.sessionChanged }
        let captured = prepared.scope
        try checkGuestDeletion(currentRecord, serial: serial); try check(captured)
        if enrollment != nil {
            let enrollmentTicket = try beginEnrollmentWork(allowDeletionResume: true)
            do {
                let restored = try await reconcileEnrollment(serial: enrollmentTicket, allowDeletionResume: true)
                endEnrollmentWork(enrollmentTicket)
                try checkGuestDeletion(currentRecord, serial: serial); try check(captured)
                guard !restored.awaitingServer, restored.state != .registered else { throw NativeAPIError.unsupported(String(localized: "Enrollment is still unresolved. Keep checking this account before resuming setup.")) }
            } catch { endEnrollmentWork(enrollmentTicket); throw error }
        }
        guard let current = credentials else { throw NativeAPIError.sessionChanged }
        try check(captured); try requireDurableGuestReceipt(currentRecord); try Task.checkCancellation()
        try persistCredential(current)
        try secrets.write("guest-deletion-receipt", data: nil); guestDeletion = nil
        return summary()!
    }
    func startAgainAfterGuestDeletion() async throws -> NativeSessionSummary? {
        guard let record = guestDeletion, record.status?.completed == true, record.originalCredentials == nil else { throw NativeAPIError.unsupported(String(localized: "A new account can start only after completed deletion is confirmed.")) }
        guard !guestDeletionBusy else { throw NativeAPIError.unsupported(String(localized: "Wait for the current deletion check to finish.")) }
        try record.validate(origin: origin)
        try secrets.write("guest-deletion-receipt", data: nil); guestDeletion = nil; guestDeletionSerial += 1
        return try await bootstrap()
    }
    func community(_ action: String, payload: WireValue) async throws -> WireValue {
        try await json("/community/action", method: "POST", body: .object(["action": .string(action), "payload": payload]), scope: readyScope())
    }
    func protectedJSON(_ path: String, method: String = "GET", body: WireValue? = nil) async throws -> WireValue { try await json(path, method: method, body: body, scope: readyScope(anonymous: Self.audienceWeakerPath(path, method: method))) }
    func photos(source: String = "all", cursor: WireValue? = nil, query: String = "", category: String = "all") async throws -> WireValue {
        guard ["all", "received", "contributions"].contains(source) else { throw NativeAPIError.invalidResponse }
        var payload: [String: WireValue] = ["source": .string(source), "limit": .integer(60)]
        guard ["all", "portraits", "landscapes"].contains(category) else { throw NativeAPIError.invalidResponse }
        if category != "all" { payload["category"] = .string(category) }
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { payload["query"] = .string(String(query.prefix(500))) }
        if let cursor { payload["before_at"] = cursor["before_at"]; payload["before_id"] = cursor["before_id"] }
        return try await community("photos", payload: .object(payload))
    }
    func photosByID(_ ids: [String], source: String = "all") async throws -> [NativePhoto] {
        guard ids.count <= 100, Set(ids).count == ids.count, ids.allSatisfy({ UUID(uuidString: $0) != nil }),
              ["all", "received", "contributions"].contains(source) else { throw NativeAPIError.invalidResponse }
        if ids.isEmpty { return [] }
        let response = try await community("photos.lookup", payload: .object(["source": .string(source), "asset_ids": .strings(ids)]))
        guard let items = response["items"].array, let unavailable = response["unavailable_ids"].array?.compactMap(\.string) else { throw NativeAPIError.invalidResponse }
        let photos = try items.map(NativePhoto.init), returned = Set(photos.map(\.id)), omitted = Set(unavailable), requested = Set(ids)
        guard photos.count == returned.count, unavailable.count == omitted.count, returned.isDisjoint(with: omitted),
              returned.union(omitted) == requested else { throw NativeAPIError.invalidResponse }
        let byID = Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0) })
        return ids.compactMap { byID[$0] }
    }
    func inbox() async throws -> [WireValue] {
        let value = try await community("inbox", payload: .object([:]))
        guard let rows = value["items"].array ?? value["requests"].array,
              rows.allSatisfy({ $0["source"].string == "personal" }) else { throw NativeAPIError.invalidResponse }
        return rows
    }
    func preview(_ photo: NativePhoto) async throws -> Data {
        defer { expirePrivateMedia() }
        guard photo.source == "personal" else { throw NativeAPIError.invalidResponse }
        let captured = try await readyScope(), capturedMediaEpoch = mediaEpoch
        let approval = try await requireAudience(.faceAuthentication, captured: captured)
        try check(captured)
        guard let expiresAt = credentials?.expiresAt else { throw NativeAPIError.authenticationRequired }
        let deadline = NativePrivateMediaDeadline(created: privateMediaClock.read(), authorityExpiresAt:
            try approval.authorityExpiresAt(sessionExpiresAt: expiresAt, purpose: .faceAuthentication, now: privateMediaClock.read().wall))
        expirePrivateMedia()
        let permission: WireValue
        do { permission = try await community("photos.validate", payload: .object(["asset_ids": .strings([photo.id])])) }
        catch {
            if case NativeAPIError.denied(let status, _) = error, [401, 403, 404, 410].contains(status) {
                media.remove(assetID: photo.id); scheduleMediaExpiry()
            }
            throw error
        }
        try check(captured)
        guard capturedMediaEpoch == mediaEpoch else { throw NativeAPIError.sessionChanged }
        guard permission["authorized_ids"].array?.compactMap(\.string) == [photo.id] else { media.remove(assetID: photo.id); scheduleMediaExpiry(); throw NativeAPIError.denied(403, "preview_access_unverified") }
        expirePrivateMedia()
        guard deadline.remaining(at: privateMediaClock.read()) > 0 else { throw NativeAPIError.sessionChanged }
        let cacheKey = NativePrivateMediaCache.Key(assetID: photo.id, version: photo.version)
        if let cached = media.value(for: cacheKey, at: privateMediaClock.read()) { scheduleMediaExpiry(); return cached }
        let reply: NativeHTTPReply
        do { reply = try await request("/community/media/\(photo.id)/preview", scope: captured, binary: true) }
        catch {
            if case NativeAPIError.denied(let status, _) = error, [401, 403, 404, 410].contains(status) {
                media.remove(assetID: photo.id); scheduleMediaExpiry()
            }
            throw error
        }
        guard !reply.data.isEmpty, reply.data.count <= 8 * 1024 * 1024, (reply.headers["content-type"] ?? "").hasPrefix("image/") else { throw NativeAPIError.invalidResponse }
        try check(captured)
        let now = privateMediaClock.read()
        media.expire(at: now); scheduleMediaExpiry()
        guard capturedMediaEpoch == mediaEpoch, deadline.remaining(at: now) > 0 else { throw NativeAPIError.sessionChanged }
        media.insert(reply.data, for: cacheKey, deadline: deadline, at: now); scheduleMediaExpiry()
        return reply.data
    }
    private func mutation(_ action: String, payload: WireValue, source: String = "personal", approved: Set<NativePair>? = nil) async throws -> (String, WireValue) {
        guard source == "personal", payload["source"] == .null || payload["source"].string == "personal" else { throw NativeAPIError.invalidResponse }
        let captured = try await readyScope()
        if let pending = pending().first { throw NativeAPIError.operationUnconfirmed(pending.key) }
        let key = UUID().uuidString.lowercased(); var body = payload.object ?? [:]; body["operation_key"] = .string(key)
        let intent = NativeOperationIntent(key: key, accountID: captured.account!, source: source, action: action, payload: .object(body), approvedPairs: approved)
        try persistIntent(intent)
        do { return (key, try await community(action, payload: intent.payload)) }
        catch NativeAPIError.denied(let status, let code) where NativeOperationRetirementRecord.isTerminal(status: status, code: code) {
            try check(captured); try retainTerminal(intent, status: status, code: code); try confirmed(key)
            throw NativeAPIError.denied(409, "operation_recovered_without_result")
        }
        catch NativeAPIError.denied(let status, let code) where (400..<500).contains(status) && ![408, 429].contains(status) && code != "operation_key_conflict" {
            try confirmed(key); throw NativeAPIError.denied(status, code)
        } catch { try check(captured); throw NativeAPIError.operationUnconfirmed(key) }
    }
    private func confirmed(_ key: String) throws {
        guard let intent = intents.first(where: { $0.key == key }) else { return }
        for _ in 0..<8 {
            let previous = try secrets.read("operation-intents")
            var rows = try readIntents(previous)
            guard let index = rows.firstIndex(where: { $0.key == key && $0.accountID == intent.accountID }) else { intents = rows; return }
            guard rows[index] == intent else { throw NativeAPIError.sessionChanged }
            rows.remove(at: index)
            if try secrets.compareAndSwap("operation-intents", expected: previous, replacement: JSONEncoder().encode(rows)) { intents = rows; return }
        }
        throw NativeAPIError.unavailable("operation_storage_changed")
    }
    func snapshot(assetIDs: [String]? = nil, source: String = "personal") async throws -> NativeSnapshot {
        guard source == "personal" else { throw NativeAPIError.invalidResponse }
        let body = assetIDs.map { ["asset_ids": WireValue.strings($0)] } ?? [:]
        let (key, value) = try await mutation("sharing.snapshot", payload: .object(body), source: source)
        let snapshot = try NativeSnapshot(value, source: source); try confirmed(key); return snapshot
    }
    func previewShare(_ snapshot: NativeSnapshot, draft: NativeShareDraft) async throws -> NativePreview {
        let (key, value) = try await mutation("sharing.preview", payload: draft.previewPayload(snapshot), source: snapshot.source)
        if value["status"].string == "changed" {
            try validateOutcome(value, intentKey: key, source: snapshot.source, pairs: draft.effective(snapshot))
            try confirmed(key); throw NativeAPIError.reviewChanged
        }
        let preview = try NativePreview(value, snapshot: snapshot, draft: draft); try confirmed(key); return preview
    }
    func commit(_ preview: NativePreview, snapshot: NativeSnapshot, draft: NativeShareDraft) async throws -> WireValue {
        try snapshot.wire.requireExpiry("expires_at"); try preview.wire.requireExpiry("expires_at")
        guard preview.draftVersion == draft.version, preview.pairs == draft.effective(snapshot) else { throw NativeAPIError.reviewChanged }
        let (key, value) = try await mutation("sharing.commit", payload: .object(["preview_id": .string(preview.id), "preview_version": .string(preview.version), "draft_version": .integer(preview.draftVersion)]), source: snapshot.source, approved: preview.pairs)
        try validateOutcome(value, intentKey: key, source: snapshot.source, pairs: preview.pairs); try confirmed(key); return value
    }
    private func validateOutcome(_ value: WireValue, intentKey: String, source: String, pairs: Set<NativePair>?) throws {
        guard source == "personal", value["protocol"].string == "reviewed-sharing-v1",
              let status = value["status"].string,
              value["source"].string == source else { throw NativeAPIError.invalidResponse }
        if status == "changed" {
            guard value["requires_review"].bool == true, value["grants_created"].integer == 0,
                  let rows = value["changed_pairs"].array else { throw NativeAPIError.invalidResponse }
            let changed = try Set(rows.map(NativePair.init))
            guard changed.count == rows.count, pairs == nil || changed.isSubset(of: pairs!) else { throw NativeAPIError.invalidResponse }
            return // A definitive changed result has no operation_key in the real wire contract.
        }
        guard value["operation_key"].string == intentKey else { throw NativeAPIError.invalidResponse }
        guard ["pending_acceptance", "access_available", "partial", "unavailable"].contains(status), let recipients = value["recipients"].array else { throw NativeAPIError.invalidResponse }
        if status == "pending_acceptance", value["grants_created"].integer != 0 { throw NativeAPIError.invalidResponse }
        let observed = try Set(recipients.flatMap { recipient -> [NativePair] in
            let id = try recipient.uuid("recipient_id"); guard let assets = recipient["asset_ids"].array else { throw NativeAPIError.invalidResponse }
            return try assets.map { guard let asset = $0.string, UUID(uuidString: asset) != nil else { throw NativeAPIError.invalidResponse }; return NativePair(asset: asset, recipient: id) }
        })
        if let pairs, observed != pairs { throw NativeAPIError.invalidResponse }
    }
    func reconcile(retryUnknown: Bool = false) async throws -> WireValue {
        guard let intent = pending().first else { throw NativeAPIError.invalidResponse }
        return try await reconcileIntent(intent, retryUnknown: retryUnknown)
    }
    func reconcilePrivacy(retryUnknown: Bool = false) async throws -> WireValue {
        guard let intent = pending().first(where: { $0.path.map(Self.privacyIntentPath) == true }) else { throw NativeAPIError.invalidResponse }
        return try await reconcileIntent(intent, retryUnknown: retryUnknown)
    }
    private static func privacyIntentPath(_ path: String) -> Bool { path.hasPrefix("/privacy/") || path.hasPrefix("/privacy-exports/") }
    private func reconcileIntent(_ intent: NativeOperationIntent, retryUnknown: Bool) async throws -> WireValue {
        if intent.action == "store.apple" {
            let captured = try await readyScope()
            let journal = try migrateAppleIntent(intent)
            return try await recoverAppleJournal(journal, captured: captured, retryUnknown: retryUnknown)
        }
        do { return try await reconcileIntentResult(intent, retryUnknown: retryUnknown) }
        catch NativeAPIError.denied(let status, let code) where NativeOperationRetirementRecord.isTerminal(status: status, code: code) {
            // Restrictive facts were recovered, but the original business
            // operation did not commit. This is terminal, never success or a
            // reason to manufacture a replacement key automatically.
            guard credentials?.account_id == intent.accountID else { throw NativeAPIError.sessionChanged }
            try check(scope(anonymous: true)); try retainTerminal(intent, status: status, code: code)
            try confirmed(intent.key); throw NativeAPIError.denied(409, "operation_recovered_without_result")
        }
    }
    private func reconcileIntentResult(_ intent: NativeOperationIntent, retryUnknown: Bool) async throws -> WireValue {
        guard intent.source == "personal", intent.payload["source"] == .null || intent.payload["source"].string == "personal" else { throw NativeAPIError.invalidResponse }
        let weakerPrivacy = intent.path.map { Self.audienceWeakerPath($0, method: intent.method ?? "POST") && ($0.hasPrefix("/privacy/") || $0.hasPrefix("/privacy-exports/")) } == true
        var result = weakerPrivacy ? try await json("/privacy/operations/" + intent.key, scope: readyScope(anonymous: true)) : try await community("operation", payload: .object(["operation_key": .string(intent.key)]))
        if result["status"].string == "unknown", retryUnknown {
            if let path = intent.path { result = try await json(path, method: intent.method ?? "POST", body: intent.payload, scope: readyScope(anonymous: Self.audienceWeakerPath(path, method: intent.method ?? "POST"))) }
            else { result = try await community(intent.action, payload: intent.payload) }
        }
        if result["status"].string == "unknown" { return result }
        if intent.action == "sharing.commit" { try validateOutcome(result, intentKey: intent.key, source: intent.source, pairs: intent.approvedPairs) }
        if intent.action == "sharing.snapshot" { _ = try NativeSnapshot(result, source: intent.source) }
        if intent.action == "sharing.preview" {
            let source = result["status"].string == "ready" ? result["preview"]["source"] : result["source"]
            guard source.string == "personal" else { throw NativeAPIError.invalidResponse }
        }
        if intent.action == "request.decide" { try validateDecision(result, requestID: intent.payload["request_id"].string) }
        try confirmed(intent.key); return result
    }
    private func validateDecision(_ value: WireValue, requestID: String?) throws {
        guard let requestID, value["source"].string == "personal", value["request_id"].string == requestID,
              value["status"].string != nil else { throw NativeAPIError.invalidResponse }
    }
    func decide(_ requestID: String, decision: String) async throws -> WireValue {
        let (key, value) = try await mutation("request.decide", payload: .object(["request_id": .string(requestID), "decision": .string(decision)]))
        try validateDecision(value, requestID: requestID); try confirmed(key); return value
    }
    func post(_ path: String, payload: WireValue, operation: String, method: String = "POST", allowNewAfterTerminal: Bool = false) async throws -> WireValue {
        guard !path.hasPrefix("/subscriptions/"), !operation.hasPrefix("store.") else { throw NativeAPIError.invalidResponse }
        let captured = try await readyScope(anonymous: Self.audienceWeakerPath(path, method: method)), key = UUID().uuidString.lowercased(); var body = payload.object ?? [:]; body["operation_key"] = .string(key)
        let push = path == "/me/push-devices" || path.hasPrefix("/me/push-devices/")
        guard !allowNewAfterTerminal || push else { throw NativeAPIError.invalidResponse }
        let terminalPush: Bool
        if push { terminalPush = try terminalOperations().0.contains { $0.accountID == captured.account && $0.isPush && $0.replacementOperationKey == nil } }
        else { terminalPush = false }
        if terminalPush && !allowNewAfterTerminal { throw NativeAPIError.denied(409, "operation_recovered_without_result") }
        // The private intent retains the original body for recovery; it can
        // contain sensitive values such as a provider token until retired.
        if let intent = pending().first(where: { existing in
            !Self.privacyIntentPath(path) || existing.path.map(Self.privacyIntentPath) == true
        }) { throw NativeAPIError.operationUnconfirmed(intent.key) }
        let intent = NativeOperationIntent(key: key, accountID: captured.account!, source: "personal", action: operation, payload: .object(body), approvedPairs: nil, path: path, method: method)
        try persistIntent(intent)
        // The replacement body is durable before its relationship is recorded.
        // A crash on either side retains a pending intent and cannot authorize a
        // foreground callback to invent another operation.
        if terminalPush { try bindExplicitPushReplacement(account: intent.accountID, key: intent.key) }
        do { let value = try await json(path, method: method, body: intent.payload, scope: captured); try confirmed(key); return value }
        catch NativeAPIError.denied(let status, let code) where NativeOperationRetirementRecord.isTerminal(status: status, code: code) {
            try check(captured); try retainTerminal(intent, status: status, code: code); try confirmed(key)
            throw NativeAPIError.denied(409, "operation_recovered_without_result")
        }
        catch NativeAPIError.denied(let status, let code) where (400..<500).contains(status) && ![408, 429].contains(status) && code != "operation_key_conflict" { try confirmed(key); throw NativeAPIError.denied(status, code) }
        catch { throw NativeAPIError.operationUnconfirmed(key) }
    }

    private func appleJournal(_ slot: String) throws -> NativeAppleStoreJournal? {
        guard let bytes = try secrets.read(slot) else { return nil }
        guard bytes.count <= 64000 else { throw NativeAPIError.invalidResponse }
        let value = try JSONDecoder().decode(NativeAppleStoreJournal.self, from: bytes)
        try value.validate(origin: origin)
        guard value.slot == slot else { throw NativeAPIError.invalidResponse }
        return value
    }
    private func saveAppleJournal(_ next: NativeAppleStoreJournal, expected: NativeAppleStoreJournal?) throws {
        try next.validate(origin: origin)
        let bytes = try secrets.read(next.slot)
        let current = try bytes.map { try JSONDecoder().decode(NativeAppleStoreJournal.self, from: $0) }
        guard current == expected, try secrets.compareAndSwap(next.slot, expected: bytes, replacement: JSONEncoder().encode(next)) else {
            throw NativeAPIError.operationUnconfirmed(next.operationKey)
        }
    }
    private func migrateAppleIntent(_ intent: NativeOperationIntent) throws -> NativeAppleStoreJournal {
        let candidate = try NativeAppleStoreJournal.legacy(intent, origin: origin)
        let journal: NativeAppleStoreJournal
        if let current = try appleJournal(candidate.slot) {
            guard current.operationKey == candidate.operationKey, current.request == candidate.request else { throw NativeAPIError.operationUnconfirmed(intent.key) }
            journal = current
        } else { try saveAppleJournal(candidate, expected: nil); journal = candidate }
        // Migration is durable before the older generic slot is retired.
        try confirmed(intent.key)
        return journal
    }
    private func recoverAppleJournal(_ initial: NativeAppleStoreJournal, captured: Scope, retryUnknown: Bool) async throws -> WireValue {
        guard initial.accountID == captured.account, appleStoreWork.insert(initial.slot).inserted else { throw NativeAPIError.operationUnconfirmed(initial.operationKey) }
        defer { appleStoreWork.remove(initial.slot) }
        var held = initial
        func persist(_ next: NativeAppleStoreJournal) throws {
            try check(captured); try saveAppleJournal(next, expected: held); held = next
        }
        func dispatch() async throws {
            var next = held; next.phase = .dispatched; try persist(next)
            let result = try await json("/subscriptions/apple/transactions", method: "POST", body: held.request, scope: captured)
            try check(captured); try held.validateResult(result)
            next = held; next.directResult = result; try persist(next)
        }
        let firstDispatch = held.phase == .prepared
        if firstDispatch {
            do { try await dispatch() }
            catch { try check(captured); try Task.checkCancellation() /* Lookup the original key after a lost reply. */ }
        }
        var receipt = try await json("/me/store-operations", method: "POST", body: .object(["operation_key": .string(held.operationKey)]), scope: captured)
        try check(captured)
        if try held.receiptResult(receipt) == nil, retryUnknown, !firstDispatch, held.receipt == nil, held.directResult == nil {
            // Retry only the exact saved input/key after authenticated unknown
            // status. The server's store operation boundary is idempotent; no
            // new purchase or new key is created by this recovery attempt.
            try await dispatch()
            receipt = try await json("/me/store-operations", method: "POST", body: .object(["operation_key": .string(held.operationKey)]), scope: captured)
            try check(captured)
        }
        guard let result = try held.receiptResult(receipt) else { throw NativeAPIError.operationUnconfirmed(held.operationKey) }
        if let previous = held.receipt, previous != receipt { throw NativeAPIError.invalidResponse }
        if held.receipt == nil {
            var next = held; next.receipt = receipt; next.phase = .verified; try persist(next)
        }
        return result
    }
    func verifyAppleTransaction(product: String, transaction: String, original: String, signedTransaction: String) async throws -> WireValue {
        let captured = try await readyScope()
        let candidate = try NativeAppleStoreJournal(origin: origin, account: captured.account!, product: product,
            transaction: transaction, original: original, signedTransaction: signedTransaction)
        for intent in pending().filter({ $0.action == "store.apple" }) {
            let legacy = try NativeAppleStoreJournal.legacy(intent, origin: origin)
            if legacy.transactionID == transaction { _ = try migrateAppleIntent(intent) }
        }
        let journal: NativeAppleStoreJournal
        if let saved = try appleJournal(candidate.slot) {
            guard saved.accountID == captured.account, saved.productID == product, saved.transactionID == transaction,
                  saved.originalTransactionID == original, saved.environment == candidate.environment else { throw NativeAPIError.invalidResponse }
            // A redelivery may carry a newly signed JWS. Recover the originally
            // submitted credential instead of overwriting its binding.
            journal = saved
        } else { try saveAppleJournal(candidate, expected: nil); journal = candidate }
        return try await recoverAppleJournal(journal, captured: captured, retryUnknown: true)
    }
    func markAppleTransactionFinishing(transaction: String, completed: Bool = false) async throws {
        let captured = try await readyScope()
        let slot = "store-apple-" + NativeAppleStoreJournal.digest(Data((origin.absoluteString + "|" + captured.account! + "|" + transaction).utf8))
        guard let journal = try appleJournal(slot), let receipt = journal.receipt,
              try journal.receiptResult(receipt) != nil else { throw NativeAPIError.invalidResponse }
        if journal.phase == .finished { return }
        guard !completed || journal.phase == .finishPending else { throw NativeAPIError.invalidResponse }
        var next = journal; next.phase = completed ? .finished : .finishPending
        try check(captured); try saveAppleJournal(next, expected: journal)
    }
    func upload(_ bytes: Data, mime: String, title: String, batch: String, localID: String) async throws -> String {
        let captured = try await readyScope(), checksum = signer.sha256(bytes)
        let id: String
        if let previous = uploads.first(where: { $0.localID == localID && $0.accountID == captured.account }) {
            guard previous.sha256 == checksum else { throw NativeAPIError.invalidResponse }; id = previous.assetID
        } else {
            let reserved = try await post("/uploads/session", payload: .object(["source": .string("personal"), "upload_batch_id": .string(batch),
                "byte_size": .integer(bytes.count), "content_type": .string(mime), "title": .string(title)]), operation: "photo.upload.reserve")
            id = try reserved.uuid("asset_id"); uploads.append(NativeUploadRecord(accountID: captured.account!, localID: localID, sha256: checksum, assetID: id, status: "uploading"))
            try secrets.write("upload-stages", data: JSONEncoder().encode(uploads))
        }
        let state = try await protectedJSON("/uploads/\(id)/status")
        if state["status"].string == "uploading" { _ = try await request("/uploads/\(id)", method: "PUT", raw: bytes, headers: ["Content-Type": mime], scope: captured) }
        if ["uploading", "uploaded"].contains(state["status"].string ?? "") { _ = try await post("/uploads/\(id)/complete", payload: .object([:]), operation: "photo.upload.complete") }
        else if !["processing", "ready"].contains(state["status"].string ?? "") { throw NativeAPIError.unsupported(String(localized: "The upload failed on the server. Keep this photo and review its current processing status.")) }
        try check(captured)
        if let index = uploads.firstIndex(where: { $0.localID == localID && $0.accountID == captured.account }) { uploads[index].status = "received" }
        try secrets.write("upload-stages", data: JSONEncoder().encode(uploads)); return id
    }
    func authorizedSaveBytes(_ photo: NativePhoto) async throws -> Data {
        // The backend owns the verified store entitlement and current grant decision.
        guard photo.source == "personal" else { throw NativeAPIError.invalidResponse }
        guard !photo.version.isEmpty else { throw NativeAPIError.unsupported(String(localized: "Return to your library and refresh current access.")) }
        let captured = try await readyScope()
        let signed = try await post("/downloads/sign", payload: .object(["asset_id": .string(photo.id)]), operation: "download.sign")
        guard signed["source_version"].string == photo.version else { throw NativeAPIError.unsupported(String(localized: "Return to your library and refresh current access.")) }
        guard signed["method"].string == "GET", let rawURL = signed["download_url"].string, let url = URL(string: rawURL),
              url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              (url.path.hasPrefix("/downloads/") || url.path.hasPrefix(origin.path + "/downloads/")),
              UUID(uuidString: url.lastPathComponent) != nil,
              let seconds = signed["expires_in"].integer, (1...300).contains(seconds) else { throw NativeAPIError.invalidResponse }
        let expiresAt = min(Date().addingTimeInterval(Double(seconds)), credentials!.expiresAt)
        let downloadPath = url.path.hasPrefix(origin.path + "/downloads/") ? String(url.path.dropFirst(origin.path.count)) : url.path
        let reply = try await request(downloadPath, scope: captured, binary: true)
        guard expiresAt > Date() else { throw NativeAPIError.denied(403, "download_expired") }
        guard (reply.headers["content-type"] ?? "").hasPrefix("image/"), !reply.data.isEmpty else { throw NativeAPIError.invalidResponse }
        return reply.data
    }
}

extension BackendRepository {
    private static func recoveryRandom(_ prefix: String) throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw NativeAPIError.unavailable("secure_random") }
        return prefix + Data(bytes).base64URL
    }
    func recoveryKeyMetadata() async throws -> NativeRecoveryKeyMetadata? {
        let captured = try await readyScope(), value = try await json("/auth/face/recovery/key", scope: captured)
        try check(captured)
        guard value["protocol"].string == "lovelies-account-recovery-v1", value["account_id"].string == captured.account else { throw NativeAPIError.invalidResponse }
        if value["state"].string == "unavailable" { return nil }
        return try NativeRecoveryKeyMetadata(value, account: captured.account!)
    }
    func createRecoveryKey() async throws -> String {
        let captured = try await readyScope(); guard accountRecovery == nil, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
        var record: NativeRecoveryKeyRecord
        if let data = try secrets.read("recovery-key-backup") {
            record = try JSONDecoder().decode(NativeRecoveryKeyRecord.self, from: data); try record.validate(origin: origin)
            guard record.accountID == captured.account else { throw NativeAPIError.sessionChanged }
            if let metadata = record.metadata, metadata.expiresAt > Date() {
                let current = try await recoveryKeyMetadata(); try check(captured)
                if current?.keyID == metadata.keyID && current?.operationKey == record.operationKey { return record.backup }
                throw NativeAPIError.unsupported(String(localized: "The saved recovery key is no longer current. Revoke it before creating a replacement."))
            }
        } else {
            record = NativeRecoveryKeyRecord(accountID: captured.account!, apiOrigin: origin.absoluteString, operationKey: UUID().uuidString.lowercased(), secret: try Self.recoveryRandom("lfr_"), createdAt: Date())
            try record.validate(origin: origin); try secrets.write("recovery-key-backup", data: JSONEncoder().encode(record))
        }
        let value = try await json("/auth/face/recovery/key", method: "POST", body: record.body, scope: captured)
        try check(captured); record.metadata = try NativeRecoveryKeyMetadata(value, account: record.accountID, operation: record.operationKey)
        try secrets.write("recovery-key-backup", data: JSONEncoder().encode(record)); return record.backup
    }
    func revokeRecoveryKey() async throws {
        let captured = try await readyScope(), value = try await json("/auth/face/recovery/key", method: "DELETE", scope: captured)
        guard value["protocol"].string == "lovelies-account-recovery-v1", value["state"].string == "revoked", value["account_id"].string == captured.account else { throw NativeAPIError.invalidResponse }
        try check(captured); try secrets.write("recovery-key-backup", data: nil)
    }
    private func restoreAccountRecovery() throws {
        if let data = try secrets.read("retired-account-recoveries") {
            guard data.count <= 512 * 1024 else { throw NativeAPIError.invalidResponse }
            recoveryArchives = try JSONDecoder().decode([NativeAccountRecoveryRecord].self, from: data)
            guard recoveryArchives.count <= 16, Set(recoveryArchives.map(\.requestID)).count == recoveryArchives.count else { throw NativeAPIError.invalidResponse }
            for record in recoveryArchives { try record.validate(origin: origin) }
        }
        guard let data = try secrets.read("account-recovery-journal") else { accountRecovery = nil; return }
        guard data.count <= 32 * 1024 else { throw NativeAPIError.invalidResponse }
        let record = try JSONDecoder().decode(NativeAccountRecoveryRecord.self, from: data); try record.validate(origin: origin)
        if recoveryArchives.contains(where: { $0.requestID == record.requestID }) {
            // History was durably saved but the following active-slot removal
            // failed. Never resume an explicitly retired request automatically.
            accountRecovery = nil; try secrets.write("account-recovery-journal", data: nil)
        } else {
            accountRecovery = record
            if record.promotionCredentials.map({ !credentialCurrent($0) }) == true {
                var retired = record
                retired.promotionCredentials = nil; retired.promotionDevice = nil; retired.state = .registered
                if !retired.captures.isEmpty { retired.retiredCaptures = retired.captures }
                retired.captures = []; retired.challengeWire = nil; retired.loginTerminalCode = nil
                try saveAccountRecovery(retired)
            }
        }
    }
    private func saveAccountRecovery(_ record: NativeAccountRecoveryRecord) throws {
        try record.validate(origin: origin); let data = try JSONEncoder().encode(record)
        guard data.count <= 32 * 1024 else { throw NativeAPIError.invalidResponse }
        if let staged = record.promotionCredentials, !credentialCurrent(staged) { throw NativeAPIError.sessionChanged }
        try replaceOwnedJournal("account-recovery-journal", previous: accountRecovery, replacement: record); accountRecovery = record
    }
    func accountRecoverySummary() throws -> NativeAccountRecoverySummary? {
        guard guestDeletion == nil, let record = accountRecovery else { return nil }
        let challenge = try record.challengeWire.map { try NativeFaceChallenge($0, accountID: record.accountID, purpose: "login", allowExpired: true) }
        return NativeAccountRecoverySummary(accountID: record.accountID, state: record.state, challenge: (challenge?.expiresAt ?? .distantPast) > Date() ? challenge : nil, receipts: record.captures.filter(\.accepted).map(\.wire))
    }
    private func recoveryLoginCurrent(_ record: NativeAccountRecoveryRecord) throws -> Bool {
        // Signed recovery status omits recovery_request_id from its plain
        // challenge. Only a new ID beyond that authoritative predecessor is
        // an ordinary login hold; the original still needs status reconciliation.
        guard record.promotionCredentials == nil, record.loginTerminalCode == nil, let wire = record.challengeWire,
              let predecessor = record.predecessorID, wire["recovery_request_id"] == .null,
              wire["challenge_id"].string != predecessor else { return false }
        return try NativeFaceChallenge(wire, accountID: record.accountID, purpose: "login", allowExpired: true).expiresAt > Date()
    }
    private func beginRecoveryWork() throws -> Int {
        guard ordinaryLogin == nil, faceLifecycle?.blocksAlternateRecovery != true, !lifecycleBusy, !recoveryBusy, !enrollmentBusy, !guestDeletionBusy, guestDeletion == nil else { throw NativeAPIError.unsupported(String(localized: "Check the current account or deletion request before recovering.")) }
        recoverySerial += 1; recoveryBusy = true; return recoverySerial
    }
    private func endRecoveryWork(_ serial: Int) { if recoverySerial == serial { recoveryBusy = false } }
    private func checkRecovery(_ record: NativeAccountRecoveryRecord, serial: Int) throws {
        guard recoverySerial == serial, guestDeletion == nil, accountRecovery?.requestID == record.requestID,
              accountRecovery?.accountID == record.accountID, accountRecovery?.keyAlias == record.keyAlias,
              accountRecovery?.publicKeyDigest == record.publicKeyDigest, record.apiOrigin == origin.absoluteString else { throw NativeAPIError.sessionChanged }
    }
    private func assertRecoveryKey(_ record: NativeAccountRecoveryRecord) throws {
        let bytes = try record.startEnvelope.canonical(), signature = try signDevice(bytes, alias: record.keyAlias)
        guard let raw = Data(base64URL: signature), raw.count == 64,
              try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: bytes) else { throw NativeAPIError.unsupported(String(localized: "The original recovery device key is missing. Keep your private backup and recovery status; this request cannot replace its key.")) }
    }
    private func prepareRecoveryKey(_ record: NativeAccountRecoveryRecord) throws -> NativeAccountRecoveryRecord {
        guard record.state == .preparingKey else { try assertRecoveryKey(record); return record }
        if signer.requiresLocalAuthentication {
            guard let lease = localSigningLease, let operation = NativeLocalSigningOperation.id,
                  try secrets.read("credentials").map(NativeLocalSigningLease.digest) == localSigningCredentialDigest else { throw NativeLocalAuthenticationIssue.required }
            _ = try lease.permit(record.startEnvelope.canonical(), alias: record.keyAlias, epoch: epoch, operationID: operation)
        }
        var next = record; next.publicJWK = try signer.publicJWK(alias: record.keyAlias, create: true)
        next.publicKeyDigest = signer.sha256(try next.publicJWK!.canonical())
        next.startSignature = try signDevice(next.startEnvelope.canonical(), alias: record.keyAlias); next.state = .starting
        try saveAccountRecovery(next); return next
    }
    private func recoveryRequest(_ record: NativeAccountRecoveryRecord, step: String, extra: [String: WireValue] = [:]) throws -> (WireValue, String) {
        try assertRecoveryKey(record); let nonce = UUID().uuidString.lowercased(); var body = record.base
        body["request_nonce"] = .string(nonce); body["request_expires_at"] = .integer(Int(Date().addingTimeInterval(45).timeIntervalSince1970 * 1000))
        extra.forEach { body[$0.key] = $0.value }; var envelope = body
        envelope["protocol"] = .string("lovelies-account-recovery-device-v1"); envelope["step"] = .string(step)
        body["device_signature"] = .string(try signDevice(WireValue.object(envelope).canonical(), alias: record.keyAlias)); return (.object(body), nonce)
    }
    private func acceptRecoveryChallenge(_ value: WireValue, record: NativeAccountRecoveryRecord, successor: Bool = false) throws -> NativeFaceChallenge {
        guard value["recovery_request_id"].string == record.requestID, let generation = value["recovery_generation"].integer,
              generation == record.generation || (successor && record.resume != nil && generation == record.generation + 1), value["policy_version"].string == record.policy else { throw NativeAPIError.invalidResponse }
        let challenge = try NativeFaceChallenge(value, accountID: record.accountID, purpose: "login", allowExpired: true)
        let profile = NativeEnrollmentProfile(id: try value.uuid("profile_id"), revision: try value.text("profile_revision"), modelID: try value.text("model_id"))
        if let previous = record.deviceID { guard previous == challenge.deviceID, record.deviceRevision == value["device_revision"].string else { throw NativeAPIError.invalidResponse } }
        if let previous = record.profile { guard previous == profile else { throw NativeAPIError.invalidResponse } }
        if generation == record.generation, let previous = record.predecessorID { guard previous == challenge.id else { throw NativeAPIError.invalidResponse } }
        var next = record; next.deviceID = challenge.deviceID; next.deviceRevision = try value.uuid("device_revision"); next.profile = profile
        if generation != next.generation { next.captures = []; next.retiredCaptures = [] }
        next.generation = generation; next.predecessorID = challenge.id; next.challengeWire = value; next.resume = nil; next.state = .pending
        try saveAccountRecovery(next); return challenge
    }
    /// Only a staged registered logout needs an earlier signing grant. Ordinary
    /// anonymous recovery does not prompt until its new request is durably held
    /// and the previous session epoch has been retired.
    func recoveryStartNeedsSignedRetirement(backup: String) throws -> Bool {
        let parsed = try NativeAccountRecoveryRecord.backup(backup)
        guard guestDeletion == nil, try secrets.read("guest-deletion-receipt") == nil else { throw NativeAPIError.authenticationRequired }
        if signer.requiresLocalAuthentication { _ = try hydrateLocalSigningState(localSigningSlots()) }
        if let lifecycle = faceLifecycle { guard lifecycle.accountID == parsed.0, !lifecycle.blocksAlternateRecovery else { throw NativeAPIError.sessionChanged } }
        if let current = credentials, current.authenticated, accountRecovery == nil {
            guard current.account_id == parsed.0 else { throw NativeAPIError.sessionChanged }
            return faceLifecycle?.promotionCredentials != nil || enrollment?.promotionCredentials != nil || ordinaryLogin?.promotionCredentials != nil
        }
        return false
    }
    func prepareAccountRecoveryStart(backup: String) async throws -> NativeLocalTransitionTicket {
        preparedLocalTransition = nil; invalidateLocalSigning()
        let parsed = try NativeAccountRecoveryRecord.backup(backup)
        guard try !recoveryStartNeedsSignedRetirement(backup: backup) else { throw NativeLocalAuthenticationIssue.required }
        if let current = credentials, current.authenticated, accountRecovery == nil {
            guard current.account_id == parsed.0 else { throw NativeAPIError.sessionChanged }
            try await logout()
        }
        let serial = try beginRecoveryWork(); defer { endRecoveryWork(serial) }
        if let saved = accountRecovery {
            guard saved.accountID == parsed.0, saved.recoveryKey == parsed.1 else { throw NativeAPIError.sessionChanged }
        } else { try await prepareAccountRecoveryRecord(parsed, serial: serial) }
        guard let record = accountRecovery else { throw NativeAPIError.invalidResponse }
        return try makeLocalTransition(kind: .accountRecoveryStart, account: record.accountID, alias: record.keyAlias, intent: record.requestID, serial: serial)
    }
    private func prepareAccountRecoveryRecord(_ parsed: (String, String), serial: Int) async throws {
        if let known = try device() { guard known.accountID == parsed.0 else { throw NativeAPIError.unsupported(String(localized: "This device retains another account's identity. Recovery cannot overwrite it.")) } }
        if let enrollment { guard enrollment.accountID == parsed.0 else { throw NativeAPIError.sessionChanged } }
        let policy = try await policy(); guard recoverySerial == serial, guestDeletion == nil, accountRecovery == nil else { throw NativeAPIError.sessionChanged }
        // The policy read awaited remote work. Revalidate held state before
        // allocating a request so a different actor's vault change cannot be
        // adopted as this recovery's superseded key/account.
        if signer.requiresLocalAuthentication {
            _ = try hydrateLocalSigningState(localSigningSlots())
            guard recoverySerial == serial, guestDeletion == nil, accountRecovery == nil else { throw NativeAPIError.sessionChanged }
        }
        let known = try device()
        if let known { guard known.accountID == parsed.0 else { throw NativeAPIError.sessionChanged } }
        if let enrollment { guard enrollment.accountID == parsed.0 else { throw NativeAPIError.sessionChanged } }
        let requestID = UUID().uuidString.lowercased()
        var record = NativeAccountRecoveryRecord(accountID: parsed.0, apiOrigin: origin.absoluteString, recoveryKey: parsed.1, requestID: requestID,
            faceHandle: try Self.recoveryRandom("lfh_"), keyAlias: NativeAccountRecoveryRecord.aliasPrefix + requestID, policy: policy, createdAt: Date())
        if let known { record.supersededAliases.append(known.keyAlias ?? NativeEnrollmentRecord.keyAlias) }
        if let enrollment, !record.supersededAliases.contains(enrollment.keyAlias) { record.supersededAliases.append(enrollment.keyAlias) }
        try saveAccountRecovery(record) // Original request/alias/secret precede key creation and every recovery POST.
        credentials = nil; epoch += 1; retireMedia(); intents = []; uploads = []
    }
    func startAccountRecovery(backup: String, transition: NativeLocalTransitionTicket? = nil) async throws -> NativeAccountRecoverySummary {
        let parsed = try NativeAccountRecoveryRecord.backup(backup)
        if let transition {
            let prepared = try requireLocalTransition(transition)
            guard prepared.kind == .accountRecoveryStart, let record = accountRecovery,
                  record.accountID == parsed.0, record.recoveryKey == parsed.1 else { throw NativeLocalAuthenticationIssue.bindingChanged }
            try requireLocalTransitionGrant(prepared, envelope: record.startEnvelope)
            preparedLocalTransition = nil
        } else if signer.requiresLocalAuthentication, accountRecovery == nil { throw NativeLocalAuthenticationIssue.required }
        guard guestDeletion == nil else { throw NativeAPIError.unsupported(String(localized: "Check the current deletion request before recovering.")) }
        if let lifecycle = faceLifecycle {
            guard lifecycle.accountID == parsed.0, !lifecycle.blocksAlternateRecovery else { throw NativeAPIError.unsupported(String(localized: "Check your face-profile action before recovering this account.")) }
        }
        if let credentials, credentials.authenticated, accountRecovery == nil {
            guard credentials.account_id == parsed.0 else { throw NativeAPIError.sessionChanged }
            try await logout() // Explicit recovery retires this user's existing session first; its key is retained.
        }
        let serial = try beginRecoveryWork(); defer { endRecoveryWork(serial) }
        if let saved = accountRecovery { guard saved.accountID == parsed.0, saved.recoveryKey == parsed.1 else { throw NativeAPIError.sessionChanged } }
        else { try await prepareAccountRecoveryRecord(parsed, serial: serial) }
        var record = try prepareRecoveryKey(accountRecovery!); try checkRecovery(record, serial: serial)
        if record.promotionCredentials != nil { _ = try await repairAccountRecoveryPromotion(); return NativeAccountRecoverySummary(accountID: record.accountID, state: .registered, challenge: nil, receipts: []) }
        if try recoveryLoginCurrent(record) { return try accountRecoverySummary()! }
        _ = try await reconcileAccountRecovery(serial: serial, retryStart: true); record = accountRecovery!
        if [.capturePending, .verifying].contains(record.state) { return try accountRecoverySummary()! }
        if record.state == .registered {
            let value = try await json("/auth/face/challenge", method: "POST", body: .object(["face_handle": .string(record.faceHandle), "device_id": .string(record.deviceID!)]))
            try checkRecovery(record, serial: serial)
            let challenge = try NativeFaceChallenge(value, accountID: record.accountID, purpose: "login")
            guard challenge.deviceID == record.deviceID, value["device_revision"].string == record.deviceRevision, value["policy_version"].string == record.policy,
                  value["profile_id"].string == record.profile?.id, value["profile_revision"].string == record.profile?.revision, value["model_id"].string == record.profile?.modelID else { throw NativeAPIError.invalidResponse }
            record.challengeWire = value; record.loginTerminalCode = nil; record.captures = []; try saveAccountRecovery(record); return try accountRecoverySummary()!
        }
        let challenge = try record.challengeWire.map { try NativeFaceChallenge($0, accountID: record.accountID, purpose: "login", allowExpired: true) }
        if record.state == .restartRequired || (challenge?.expiresAt ?? .distantPast) <= Date() || record.resume != nil { _ = try await resumeAccountRecovery(serial: serial) }
        return try accountRecoverySummary()!
    }
    func recoverAccount() async throws -> NativeAccountRecoverySummary {
        let serial = try beginRecoveryWork(); defer { endRecoveryWork(serial) }
        guard let saved = accountRecovery else { throw NativeAPIError.invalidResponse }
        _ = try prepareRecoveryKey(saved)
        if saved.promotionCredentials != nil { _ = try await repairAccountRecoveryPromotion(); return NativeAccountRecoverySummary(accountID: saved.accountID, state: .registered, challenge: nil, receipts: []) }
        if try recoveryLoginCurrent(saved) { return try accountRecoverySummary()! }
        return try await reconcileAccountRecovery(serial: serial)
    }
    private func reconcileAccountRecovery(serial: Int, retryStart: Bool = false) async throws -> NativeAccountRecoverySummary {
        guard let record = accountRecovery else { throw NativeAPIError.invalidResponse }; try checkRecovery(record, serial: serial)
        let signed = try recoveryRequest(record, step: "status"), captured = Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation)
        let value: WireValue
        do { value = try await json("/auth/face/recovery/status", method: "POST", body: signed.0, scope: captured) }
        catch NativeAPIError.denied(404, "account_recovery_not_found") {
            try checkRecovery(record, serial: serial)
            guard record.state == .starting, record.deviceID == nil else { throw NativeAPIError.invalidResponse }
            if retryStart {
                do { let start = try await json("/auth/face/recovery/challenge", method: "POST", body: record.startBody, scope: captured)
                    try checkRecovery(record, serial: serial); _ = try acceptRecoveryChallenge(start, record: record)
                } catch NativeAPIError.denied(409, "account_recovery_registered") { return try await reconcileAccountRecovery(serial: serial) }
            }
            return try accountRecoverySummary()!
        }
        try checkRecovery(record, serial: serial)
        guard value["protocol"].string == "lovelies-account-recovery-v1", value["account_id"].string == record.accountID,
              value["recovery_request_id"].string == record.requestID, value["public_key_digest"].string == record.publicKeyDigest,
              value["policy_version"].string == record.policy, value["request_nonce"].string == signed.1, value["authenticated"].bool == false,
              ["access_token", "refresh_token", "recovery_key", "face_handle", "device_public_jwk"].allSatisfy({ value[$0] == .null }),
              let state = value["state"].string.flatMap(NativeAccountRecoveryState.init(rawValue:)), [.pending, .capturePending, .verifying, .restartRequired, .registered].contains(state),
              let generation = value["generation"].integer, generation == record.generation || (record.resume != nil && generation == record.generation + 1),
              let rows = value["captures"].array, rows.count <= 1 else { throw NativeAPIError.invalidResponse }
        let expires = try NativeAccountRecoveryRecord.date(value["expires_at"])
        guard expires > Date(), expires <= record.createdAt.addingTimeInterval(7 * 86400 + 120), record.expiresAt == nil || record.expiresAt == expires else { throw NativeAPIError.invalidResponse }
        let device = try value.uuid("device_id"), revision = try value.uuid("device_revision"), predecessor = try value.uuid("challenge_id"), profile = try NativeEnrollmentProfile(value["profile"])
        if let previous = record.deviceID { guard device == previous, revision == record.deviceRevision else { throw NativeAPIError.invalidResponse } }
        if let previous = record.profile { guard previous == profile else { throw NativeAPIError.invalidResponse } }
        if generation == record.generation, let previous = record.predecessorID { guard previous == predecessor else { throw NativeAPIError.invalidResponse } }
        var next = record; next.deviceID = device; next.deviceRevision = revision; next.profile = profile; next.predecessorID = predecessor; next.expiresAt = expires
        if generation != next.generation { next.generation = generation; next.captures = []; next.retiredCaptures = []; next.challengeWire = nil; next.resume = nil }
        let accepted = try rows.map { try NativeEnrollmentCapture($0) }
        guard accepted.allSatisfy({ $0.index == 0 }) else { throw NativeAPIError.invalidResponse }
        for capture in accepted { guard (next.captures + (state == .restartRequired ? next.retiredCaptures : [])).contains(where: { $0.wire == capture.wire }) else { throw NativeAPIError.invalidResponse } }
        if [.pending, .capturePending, .verifying].contains(state) { guard next.captures.filter(\.accepted).allSatisfy({ old in accepted.contains { $0.wire == old.wire } }) else { throw NativeAPIError.invalidResponse } }
        if state == .registered {
            guard value["challenge"] == .null, accepted.isEmpty else { throw NativeAPIError.invalidResponse }
            next.challengeWire = nil; next.captures = []; next.retiredCaptures = []
        } else if state == .restartRequired {
            if !next.captures.isEmpty { next.retiredCaptures = next.captures }; next.captures = []; next.challengeWire = nil
        } else {
            if let base = value["challenge"].object {
                guard value["challenge"]["challenge_id"].string == predecessor else { throw NativeAPIError.invalidResponse }
                let challenge = try NativeFaceChallenge(.object(base), accountID: record.accountID, purpose: "login", allowExpired: true)
                guard challenge.deviceID == device, value["challenge"]["device_revision"].string == revision, value["challenge"]["policy_version"].string == record.policy,
                      value["challenge"]["profile_id"].string == profile.id, value["challenge"]["profile_revision"].string == profile.revision, value["challenge"]["model_id"].string == profile.modelID else { throw NativeAPIError.invalidResponse }
                next.challengeWire = .object(base)
            } else {
                guard value["challenge"] == .null, [.capturePending, .verifying].contains(state) else { throw NativeAPIError.invalidResponse }
            }
            if state == .pending { next.captures = accepted } else { for capture in accepted { next.captures[capture.index].accepted = true } }
        }
        next.state = state; try saveAccountRecovery(next); return try accountRecoverySummary()!
    }
    private func resumeAccountRecovery(serial: Int) async throws -> NativeFaceChallenge {
        guard var record = accountRecovery, [.pending, .restartRequired].contains(record.state), let previous = record.predecessorID else { throw NativeAPIError.invalidResponse }
        if record.resume == nil { record.resume = NativeEnrollmentResume(key: UUID().uuidString.lowercased(), generation: record.generation, challengeID: previous); try saveAccountRecovery(record) }
        let resume = record.resume!, signed = try recoveryRequest(record, step: "resume", extra: ["resume_key": .string(resume.key), "expected_generation": .integer(resume.generation), "expected_challenge_id": .string(resume.challengeID)])
        let value = try await json("/auth/face/recovery/resume", method: "POST", body: signed.0)
        try checkRecovery(record, serial: serial); return try acceptRecoveryChallenge(value, record: record, successor: true)
    }
    private func captureAccountRecovery(_ bytes: Data, index: Int, challenge: NativeFaceChallenge) async throws -> WireValue {
        let serial = try beginRecoveryWork(); defer { endRecoveryWork(serial) }
        guard var record = accountRecovery, [.pending, .registered].contains(record.state), index == 0, record.captures.isEmpty,
              challenge.id == record.challengeWire?["challenge_id"].string, challenge.expiresAt > Date(), !bytes.isEmpty, bytes.count <= 8 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        try assertRecoveryKey(record); let hash = signer.sha256(bytes)
        record.captures = [NativeEnrollmentCapture(index: 0, sha256: hash, byteSize: bytes.count)]; record.state = .capturePending; try saveAccountRecovery(record)
        var envelope = challenge.deviceEnvelope(); envelope["step"] = .string("capture"); envelope["capture_index"] = .integer(0); envelope["capture_sha256"] = .string(hash); envelope["mime"] = .string("image/jpeg"); envelope["byte_size"] = .integer(bytes.count)
        let signature = try signDevice(WireValue.object(envelope).canonical(), alias: record.keyAlias)
        let reply = try await request("/auth/face/proof/\(challenge.id)/0", method: "PUT", raw: bytes, headers: ["Content-Type": "image/jpeg", "X-Lovelies-Capture-SHA256": hash, "X-Lovelies-Capture-Bytes": String(bytes.count), "X-Lovelies-Device-Signature": signature])
        try checkRecovery(record, serial: serial); let value = try WireValue.decoded(reply.data)
        guard value["protocol"].string == "lovelies-face-auth-v1", value["status"].string == "capture_received", value["challenge_id"].string == challenge.id,
              value["capture_index"].integer == 0, value["capture_sha256"].string == hash, value["byte_size"].integer == bytes.count else { throw NativeAPIError.invalidResponse }
        record.captures[0].accepted = true; record.state = challenge.id == record.predecessorID ? .pending : .registered
        try saveAccountRecovery(record); return record.captures[0].wire
    }
    private func completeAccountRecovery(_ challenge: NativeFaceChallenge, captures: [WireValue]) async throws -> NativeSessionSummary {
        let serial = try beginRecoveryWork(); defer { endRecoveryWork(serial) }
        guard var record = accountRecovery, [.pending, .registered].contains(record.state), challenge.id == record.challengeWire?["challenge_id"].string,
              challenge.expiresAt > Date(), record.captures.count == 1, record.captures.allSatisfy(\.accepted), record.captures.map(\.wire) == captures else { throw NativeAPIError.invalidResponse }
        try assertRecoveryKey(record); record.state = .completionPending; try saveAccountRecovery(record)
        var envelope = challenge.deviceEnvelope(); envelope["step"] = .string("complete"); envelope["capture_manifest"] = .array(captures)
        let value: WireValue
        do { value = try await json("/auth/face/complete", method: "POST", body: .object(["challenge_id": .string(challenge.id), "device_signature": .string(try signDevice(WireValue.object(envelope).canonical(), alias: record.keyAlias))])) }
        catch {
            if challenge.wire["recovery_request_id"] == .null, let code = NativeFaceTerminalFailure.code(error), recoverySerial == serial, accountRecovery?.challengeWire == challenge.wire {
                record.loginTerminalCode = code; try saveAccountRecovery(record)
            }
            throw error
        }
        try checkRecovery(record, serial: serial)
        guard value["protocol"].string == "lovelies-face-auth-v1", value["status"].string == "authenticated", value["device_id"].string == record.deviceID,
              value["profile_id"].string == record.profile?.id, value["profile_revision"].string == record.profile?.revision, value["model_id"].string == record.profile?.modelID else { throw NativeAPIError.invalidResponse }
        let credentials = try NativeCredentials(value); guard credentials.account_id == record.accountID, credentials.authenticated else { throw NativeAPIError.sessionChanged }
        record.promotionCredentials = credentials; record.promotionDevice = RegisteredDevice(accountID: record.accountID, faceHandle: record.faceHandle, deviceID: record.deviceID!, profileID: record.profile!.id, profileRevision: record.profile!.revision, modelID: record.profile!.modelID, keyAlias: record.keyAlias); record.state = .promoting
        try saveAccountRecovery(record); return try await repairAccountRecoveryPromotion()
    }
    private func repairAccountRecoveryPromotion() async throws -> NativeSessionSummary {
        guard let record = accountRecovery, let promoted = record.promotionCredentials, let device = record.promotionDevice, guestDeletion == nil else { throw NativeAPIError.invalidResponse }
        let serial = recoverySerial
        try assertRecoveryKey(record); try record.validate(origin: origin)
        try activateLocalPromotion(promoted, journal: record)
        if promoted.expiresAt <= Date() { try await refresh() }
        guard recoverySerial == serial, accountRecovery?.requestID == record.requestID, guestDeletion == nil else { throw NativeAPIError.sessionChanged }
        let captured = try scope(anonymous: true), value = try await json("/me", scope: captured)
        guard value["user_id"].string == record.accountID, value["auth_method"].string == "registered_face", value["authenticated"].bool == true,
              value["profile_id"].string == record.profile?.id, value["profile_revision"].string == record.profile?.revision,
              recoverySerial == serial, accountRecovery?.requestID == record.requestID, guestDeletion == nil else { throw NativeAPIError.invalidResponse }; try check(captured)
        let devices = try await json("/me/devices", scope: captured)
        try check(captured)
        guard recoverySerial == serial, accountRecovery?.requestID == record.requestID, guestDeletion == nil, let rows = devices["items"].array,
              rows.filter({ $0["current"].bool == true }).count == 1,
              rows.contains(where: { $0["current"].bool == true && $0["id"].string == record.deviceID && $0["status"].string == "active" }) else { throw NativeAPIError.invalidResponse }
        // New credentials/reference are current before retiring the old original
        // journal/key. Every step is replayable from the staged A02 journal.
        try archiveFaceLifecycleForRecovery(account: record.accountID)
        let previous = try self.device()
        if let previous { guard previous.accountID == record.accountID else { throw NativeAPIError.sessionChanged } }
        try secrets.write("registered-device", data: JSONEncoder().encode(device)); try persistCredential(credentials!)
        if let enrollment, enrollment.accountID == record.accountID {
            try secrets.write("face-enrollment-journal", data: nil); self.enrollment = nil; enrollmentSerial += 1
            try retireUnreferencedDeviceKey(alias: enrollment.keyAlias, publicJWK: enrollment.publicJWK)
        }
        if let previous, previous.accountID == record.accountID, previous.keyAlias != device.keyAlias { try retireUnreferencedDeviceKey(alias: previous.keyAlias ?? NativeEnrollmentRecord.keyAlias) }
        for alias in record.supersededAliases { try retireUnreferencedDeviceKey(alias: alias) }
        if let data = try secrets.read("pending-face-device"), try JSONDecoder().decode(RegisteredDevice.self, from: data).accountID == record.accountID { try secrets.write("pending-face-device", data: nil) }
        try secrets.write("recovery-key-backup", data: nil) // The successful server comparison consumed this key.
        let retained = recoveryArchives.filter { $0.accountID != record.accountID }
        let retiring = recoveryArchives.filter { $0.accountID == record.accountID && $0.keyAlias != record.keyAlias }
        try secrets.write("retired-account-recoveries", data: JSONEncoder().encode(retained)); recoveryArchives = retained
        for retired in retiring { try retireUnreferencedDeviceKey(alias: retired.keyAlias, publicJWK: retired.publicJWK) }
        try secrets.write("account-recovery-journal", data: nil); accountRecovery = nil
        if let data = try secrets.read("operation-intents") { intents = try JSONDecoder().decode([NativeOperationIntent].self, from: data).filter { $0.accountID == record.accountID } }
        return summary()!
    }
}

extension BackendRepository {
    func continueAccountRecovery() async throws -> NativeAccountRecoverySummary {
        guard let saved = accountRecovery else { throw NativeAPIError.invalidResponse }
        return try await startAccountRecovery(backup: "LVR1:" + saved.accountID + ":" + saved.recoveryKey)
    }
}

extension BackendRepository {
    func retiredRecoveryCount() -> Int { recoveryArchives.count }
    /// Explicitly confirmed replacement archives metadata/key ownership. It does
    /// not claim the server cancelled the retired request or erased its proofs.
    func useAnotherRecoveryKey() async throws {
        guard guestDeletion == nil, !guestDeletionBusy, !enrollmentBusy else { throw NativeAPIError.unsupported(String(localized: "Check your deletion or enrollment request before replacing this recovery attempt.")) }
        if let current = credentials, current.authenticated { try await logout() }
        guard let record = accountRecovery else { throw NativeAPIError.invalidResponse }
        try record.validate(origin: origin)
        guard recoveryArchives.count < 16 else { throw NativeAPIError.unsupported(String(localized: "Sixteen earlier recovery attempts are retained. Keep their status; this device cannot create another attempt until your account is recovered and they can be retired safely.")) }
        var history = recoveryArchives; if !history.contains(where: { $0.requestID == record.requestID }) { history.append(record) }
        let data = try JSONEncoder().encode(history); guard data.count <= 512 * 1024 else { throw NativeAPIError.invalidResponse }
        try retireForRestriction()
        try secrets.write("retired-account-recoveries", data: data); recoveryArchives = history
        // Cancel local publication BEFORE clearing the active slot. A storage
        // interruption retains the archived record and alias, never old authority.
        recoverySerial += 1; recoveryBusy = false; epoch += 1; credentials = nil; accountRecovery = nil; retireMedia(); transport.cancelPending()
        try secrets.write("account-recovery-journal", data: nil)
    }
}

// A03 is a private, signed management capability. It is deliberately separate
// from generic protected requests, A01 enrollment and A02 account recovery.
extension BackendRepository {
    private func restoreFaceLifecycle() throws {
        if let data = try secrets.read("retired-face-profile-controls") {
            guard data.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
            lifecycleArchives = try JSONDecoder().decode([NativeFaceLifecycleRecord].self, from: data)
            guard lifecycleArchives.count <= 16 else { throw NativeAPIError.invalidResponse }
            for record in lifecycleArchives { try record.validate(origin: origin) }
        }
        guard let data = try secrets.read("face-profile-lifecycle") else { faceLifecycle = nil; return }
        guard data.count <= 128 * 1024 else { throw NativeAPIError.invalidResponse }
        let record = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: data); try record.validate(origin: origin)
        if lifecycleArchives.contains(where: { $0.controlOperationKey == record.controlOperationKey }) {
            // An interrupted archive never republishes the retired control.
            try secrets.write("face-profile-lifecycle", data: nil); faceLifecycle = nil
        } else {
            faceLifecycle = record
            if record.promotionCredentials.map({ !credentialCurrent($0) }) == true || record.credentials.map({ !credentialCurrent($0) }) == true {
                var retired = record
                retired.credentials = nil; retired.promotionCredentials = nil; retired.promotionProfile = nil
                retired.loginChallengeWire = nil; retired.loginTerminalCode = nil; retired.loginCaptures = []; retired.loginCompletionPending = false
                retired.stableControlLogin = false; retired.currentAuthorityValidated = false
                try saveFaceLifecycle(retired)
            }
        }
    }
    private func saveFaceLifecycle(_ record: NativeFaceLifecycleRecord) throws {
        try record.validate(origin: origin); let data = try JSONEncoder().encode(record)
        guard data.count <= 128 * 1024 else { throw NativeAPIError.invalidResponse }
        if let staged = record.promotionCredentials, !credentialCurrent(staged) { throw NativeAPIError.sessionChanged }
        if let active = record.credentials, !credentialCurrent(active) { throw NativeAPIError.sessionChanged }
        try replaceOwnedJournal("face-profile-lifecycle", previous: faceLifecycle, replacement: record); faceLifecycle = record
    }
    private func archiveFaceLifecycleForRecovery(account: String) throws {
        guard var record = faceLifecycle else { return }
        guard record.accountID == account, !record.blocksAlternateRecovery, lifecycleArchives.count < 16 else { throw NativeAPIError.sessionChanged }
        record.credentials = nil; record.promotionCredentials = nil; record.promotionProfile = nil; record.loginChallengeWire = nil; record.loginTerminalCode = nil; record.loginCaptures = []
        var history = lifecycleArchives
        if !history.contains(where: { $0.controlOperationKey == record.controlOperationKey }) { history.append(record) }
        let data = try JSONEncoder().encode(history); guard data.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        try secrets.write("retired-face-profile-controls", data: data); lifecycleArchives = history
        try secrets.write("face-profile-lifecycle", data: nil); faceLifecycle = nil; lifecycleSerial += 1
    }
    private func beginLifecycleWork() throws -> Int {
        guard ordinaryLogin == nil, guestDeletion == nil, !guestDeletionBusy, !lifecycleBusy, !recoveryBusy, !enrollmentBusy,
              accountRecovery == nil else { throw NativeAPIError.unsupported(String(localized: "Check the current account or deletion request before managing your face profile.")) }
        lifecycleSerial += 1; lifecycleBusy = true; return lifecycleSerial
    }
    private func endLifecycleWork(_ serial: Int) { if lifecycleSerial == serial { lifecycleBusy = false } }
    private func checkLifecycle(_ record: NativeFaceLifecycleRecord, serial: Int) throws {
        guard lifecycleSerial == serial, guestDeletion == nil, accountRecovery == nil,
              faceLifecycle?.controlOperationKey == record.controlOperationKey, faceLifecycle?.accountID == record.accountID,
              faceLifecycle?.keyAlias == record.keyAlias, faceLifecycle?.publicKeyDigest == record.publicKeyDigest,
              faceLifecycle?.controlKey == record.controlKey,
              faceLifecycle?.controlRecoveryRenewal?.operationKey == record.controlRecoveryRenewal?.operationKey,
              record.apiOrigin == origin.absoluteString, !Task.isCancelled else { throw NativeAPIError.sessionChanged }
    }
    private func assertLifecycleKey(_ record: NativeFaceLifecycleRecord) throws {
        let bytes = try record.controlEnvelope.canonical(), signature = try signDevice(bytes, alias: record.keyAlias)
        guard let raw = Data(base64URL: signature), raw.count == 64,
              try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: bytes) else {
            throw NativeAPIError.unsupported(String(localized: "The original device key is missing. Keep this face-profile record; another account or device key cannot replace it."))
        }
    }
    private func lifecycleRequest(_ record: NativeFaceLifecycleRecord, step: String, extra: [String: WireValue] = [:]) throws -> (WireValue, String) {
        try assertLifecycleKey(record); let nonce = UUID().uuidString.lowercased(); var body = record.base
        body["request_nonce"] = .string(nonce); body["request_expires_at"] = .integer(Int(Date().addingTimeInterval(45).timeIntervalSince1970 * 1000))
        extra.forEach { body[$0.key] = $0.value }; var envelope = body
        envelope["protocol"] = .string("lovelies-face-profile-device-v1"); envelope["step"] = .string(step)
        body["device_signature"] = .string(try signDevice(WireValue.object(envelope).canonical(), alias: record.keyAlias))
        return (.object(body), nonce)
    }
    func faceLifecycleSummary() throws -> NativeFaceLifecycleSummary? {
        guard guestDeletion == nil, accountRecovery == nil, let record = faceLifecycle else { return nil }
        let wire = record.loginChallengeWire ?? record.pending?.challengeWire
        let purpose = record.loginChallengeWire == nil ? record.pending?.action.purpose : "login"
        let challenge = try wire.map { try NativeFaceChallenge($0, accountID: record.accountID, purpose: purpose ?? "login", allowExpired: true) }
        let captures = record.loginChallengeWire == nil ? record.pending?.captures ?? [] : record.loginCaptures
        let checked = record.controlRecoveryRenewal != nil || record.metadata.controlRecovery.map({ $0.expiresAt <= Date() }) == true || record.authorityUnavailable && !record.stableControlLogin || record.pending?.awaitingServer == true || record.loginCompletionPending || record.promotionCredentials != nil || captures.contains(where: { !$0.accepted })
        return NativeFaceLifecycleSummary(metadata: record.metadata, operation: record.pending,
            challenge: !checked && (challenge?.expiresAt ?? .distantPast) > Date() ? challenge : nil,
            receipts: captures.filter(\.accepted).map(\.wire), authorityUnavailable: record.authorityUnavailable,
            authenticated: summary()?.authenticated == true,
            canRenewControl: record.authorityUnavailable && (record.authorityFailure == "face_profile_control_unavailable" || record.renewal != nil) && record.currentAuthorityValidated && record.credentials != nil && record.metadata.authenticationEnabled && (record.pending == nil || ["applied", "completed", "cancelled"].contains(record.pending?.serverState ?? "")),
            retainedControlRenewalPending: record.controlRecoveryRenewal != nil)
    }
    func openFaceLifecycle() async throws -> NativeFaceLifecycleSummary {
        if faceLifecycle != nil { return try await checkFaceLifecycle() }
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        let captured = try await readyScope(); guard let original = credentials, let device = try device(), device.accountID == original.account_id else { throw NativeAPIError.authenticationRequired }
        let alias = device.keyAlias ?? NativeEnrollmentRecord.keyAlias
        let jwk = try signer.publicJWK(alias: alias, create: false), digest = signer.sha256(try jwk.canonical())
        let current = try await json("/me/face-profile", scope: captured); try check(captured)
        guard lifecycleSerial == serial, guestDeletion == nil, current["device_id"].string == device.deviceID,
              current["public_key_digest"].string == digest,
              current["profile"]["id"].string == device.profileID, current["profile"]["revision"].string == device.profileRevision,
              current["profile"]["model_id"].string == device.modelID, current["authentication_enabled"].bool == true,
              let object = current.object else { throw NativeAPIError.invalidResponse }
        // The initial protected read must echo the actual original device key
        // digest. Never manufacture or backfill a server identity binding.
        let metadata = try NativeFaceProfileMetadata(.object(object), account: device.accountID, device: device.deviceID, digest: digest)
        let control = try Self.recoveryRandom("lfl_"), operation = UUID().uuidString.lowercased()
        var body: [String: WireValue] = ["account_id": .string(device.accountID), "device_id": .string(device.deviceID), "control_key": .string(control), "control_operation_key": .string(operation), "protocol": .string("lovelies-face-profile-device-v1"), "step": .string("control")]
        let signature = try signDevice(WireValue.object(body).canonical(), alias: alias)
        let record = NativeFaceLifecycleRecord(accountID: device.accountID, apiOrigin: origin.absoluteString, originalDevice: device, keyAlias: alias,
            publicJWK: jwk, publicKeyDigest: digest, controlKey: control, controlOperationKey: operation, controlSignature: signature, createdAt: Date(), metadata: metadata, credentials: original, currentAuthorityValidated: true)
        body.removeAll(); try saveFaceLifecycle(record) // Control intent precedes dispatch.
        let value = try await json("/auth/face/profile/control", method: "POST", body: record.controlBody, scope: captured)
        try checkLifecycle(record, serial: serial); try acceptLifecycleMetadata(value, record: record)
        return try faceLifecycleSummary()!
    }
    private func acceptLifecycleMetadata(_ value: WireValue, record: NativeFaceLifecycleRecord, nonce: String? = nil, includeOperation: Bool = false) throws {
        let metadata = try NativeFaceProfileMetadata(value, account: record.accountID, device: record.originalDevice.deviceID, digest: record.publicKeyDigest, nonce: nonce)
        guard metadata.deviceRevision == record.metadata.deviceRevision, metadata.version >= record.metadata.version else { throw NativeAPIError.invalidResponse }
        var next = record; next.metadata = metadata; next.controlReady = true; next.authorityUnavailable = false; next.authorityFailure = nil
        let operation = value["operation"]
        if includeOperation {
            guard var pending = record.pending, operation["operation_key"].string == pending.operationKey,
                  operation["action"].string == pending.action.rawValue else { throw NativeAPIError.invalidResponse }
            let generation = operation["generation"].integer!, state = operation["state"].string!
            guard generation == pending.generation || (pending.generation == 0 && generation == 1 && pending.action.captures) || (pending.resume != nil && generation == pending.generation + 1) else { throw NativeAPIError.invalidResponse }
            if let previous = pending.predecessorID, generation == pending.generation { guard operation["challenge_id"].string == previous else { throw NativeAPIError.invalidResponse } }
            let terminal = ["applied", "completed", "restart_required", "cancelled", "failed"].contains(state)
            let accepted = try operation["captures"].array!.map { try NativeEnrollmentCapture($0) }
            guard Set(accepted.map(\.index)).count == accepted.count else { throw NativeAPIError.invalidResponse }
            if generation != pending.generation { pending.captures = []; pending.retiredCaptures = []; pending.challengeWire = nil; pending.resume = nil }
            if !terminal {
                guard metadata.version == pending.expectedVersion, !pending.action.captures || pending.consent?["policy_version"].string == metadata.authPolicy else { throw NativeAPIError.reviewChanged }
                guard accepted.enumerated().allSatisfy({ $0.offset == $0.element.index }),
                      pending.captures.filter(\.accepted).allSatisfy({ old in accepted.contains { $0.wire == old.wire } }) else { throw NativeAPIError.invalidResponse }
            }
            guard accepted.reduce(0, { $0 + $1.byte_size }) <= 8 * 1024 * 1024, Set(accepted.map(\.sha256)).count == accepted.count else { throw NativeAPIError.invalidResponse }
            for capture in accepted {
                guard (pending.captures + (terminal ? pending.retiredCaptures : [])).contains(where: { $0.wire == capture.wire }) else { throw NativeAPIError.invalidResponse }
            }
            if pending.action.captures {
                pending.predecessorID = try operation.uuid("challenge_id")
                if let base = operation["challenge"].object {
                    var enriched = base; enriched["lifecycle_operation_key"] = .string(pending.operationKey); enriched["lifecycle_generation"] = .integer(generation)
                    if pending.action.purpose == "registration" { enriched["face_handle"] = .string(record.originalDevice.faceHandle) }
                    let wire = WireValue.object(enriched), challenge = try NativeFaceChallenge(wire, accountID: record.accountID, purpose: pending.action.purpose, allowExpired: true)
                    guard challenge.deviceID == record.originalDevice.deviceID, wire["device_revision"].string == metadata.deviceRevision,
                          wire["policy_version"].string == pending.consent?["policy_version"].string,
                          challenge.id == pending.predecessorID else { throw NativeAPIError.invalidResponse }
                    try checkLifecycleReference(challenge, action: pending.action, profile: record.metadata.profile)
                    pending.challengeWire = wire
                } else { guard operation["challenge"] == .null, state != "pending" else { throw NativeAPIError.invalidResponse } }
            } else { guard generation == 0, operation["challenge_id"] == .null, operation["challenge"] == .null, accepted.isEmpty else { throw NativeAPIError.invalidResponse } }
            pending.generation = generation; pending.serverState = state; pending.cleanupState = operation["cleanup_state"].string!; pending.missingOnServer = false
            if terminal {
                if !pending.captures.isEmpty { pending.retiredCaptures = pending.captures }
                pending.captures = []; pending.challengeWire = nil; pending.completionPending = false; pending.cancelRequested = false; next.loginChallengeWire = nil; next.loginTerminalCode = nil; next.loginCaptures = []; next.loginCompletionPending = false
            } else if state == "pending", operation["challenge"] != .null {
                // A signed settled manifest confirms exactly which slots exist.
                // No JPEG is persisted, and no old receipt is counted twice.
                pending.captures = accepted; pending.completionPending = false
            } else { for capture in accepted { if pending.captures.indices.contains(capture.index) { pending.captures[capture.index].accepted = true } } }
            next.pending = pending
        } else { guard operation == .null else { throw NativeAPIError.invalidResponse } }
        if includeOperation, next.pending?.serverState == "completed", let action = next.pending?.action {
            if action == .replace { guard metadata.profile?.id == record.metadata.profile?.id, (record.pending?.serverState == "completed" || metadata.profile?.revision != record.metadata.profile?.revision) else { throw NativeAPIError.invalidResponse } }
            if action == .restoreAuthentication { guard metadata.profile == record.metadata.profile else { throw NativeAPIError.invalidResponse } }
            if action == .enroll { guard metadata.profile != nil else { throw NativeAPIError.invalidResponse } }
        }
        let authorityRetired = !metadata.authenticationEnabled || metadata.profile != record.metadata.profile
        if authorityRetired {
            if credentials != nil || metadata.profile != record.metadata.profile { try retireForRestriction() }
            next.credentials = nil; next.promotionCredentials = nil; next.promotionProfile = nil; next.currentAuthorityValidated = false
        }
        try saveFaceLifecycle(next)
        if metadata.profile != record.metadata.profile || !metadata.authenticationEnabled {
            try retireOwnLifecycleIdentity(account: record.accountID)
        }
    }
    private func checkLifecycleReference(_ challenge: NativeFaceChallenge, action: NativeFaceProfileAction, profile: NativeEnrollmentProfile?) throws {
        if action == .enroll {
            guard challenge.wire["profile_id"] == .null, challenge.wire["profile_revision"] == .null, challenge.wire["model_id"] == .null, challenge.poses.count == 3 else { throw NativeAPIError.invalidResponse }
        } else {
            guard let profile, challenge.wire["profile_id"].string == profile.id, challenge.wire["profile_revision"].string == profile.revision,
                  challenge.wire["model_id"].string == profile.modelID,
                  challenge.poses.count == (action == .replace ? 3 : 1) else { throw NativeAPIError.invalidResponse }
        }
    }
    private func retireOwnLifecycleIdentity(account: String) throws {
        // Terminal profile authority retires obsolete journals/backups. Retain
        // encrypted history and the original signing key; never create an alias.
        var history: [WireValue] = []
        if let data = try secrets.read("face-lifecycle-retired-identities") { history = try JSONDecoder().decode([WireValue].self, from: data) }
        guard history.count <= 16 else { throw NativeAPIError.invalidResponse }
        for name in ["face-enrollment-journal", "account-recovery-journal", "recovery-key-backup"] {
            if let data = try secrets.read(name) {
                let value = try WireValue.decoded(data)
                let owned = value["accountID"].string == account
                if owned && !history.contains(where: { $0["kind"].string == name && $0["payload"] == value }) {
                    guard history.count < 16 else { throw NativeAPIError.unsupported(String(localized: "Private identity history is full. Keep this action status; it cannot discard earlier recovery records.")) }
                    history.append(.object(["kind": .string(name), "accountID": .string(account), "payload": value]))
                }
                if owned { try secrets.write("face-lifecycle-retired-identities", data: JSONEncoder().encode(history)); try secrets.write(name, data: nil) }
            }
        }
        if enrollment?.accountID == account { enrollment = nil; enrollmentSerial += 1 }
        if accountRecovery?.accountID == account { accountRecovery = nil; recoverySerial += 1 }
        if var device = try device(), device.accountID == account, let profile = faceLifecycle?.metadata.profile {
            device.profileID = profile.id; device.profileRevision = profile.revision; device.modelID = profile.modelID
            try secrets.write("registered-device", data: JSONEncoder().encode(device))
        }
    }
    private func lifecycleStatus(serial: Int, retryOriginal: Bool = false) async throws -> NativeFaceLifecycleSummary {
        guard let record = faceLifecycle else { throw NativeAPIError.invalidResponse }; try checkLifecycle(record, serial: serial)
        if let renewal = record.controlRecoveryRenewal { throw NativeAPIError.operationUnconfirmed(renewal.operationKey) }
        if record.renewal != nil { return try await reconcileControlRenewal(serial: serial, retry: retryOriginal) }
        let signed = try lifecycleRequest(record, step: "status", extra: record.pending.map { ["operation_key": .string($0.operationKey)] } ?? [:])
        let value: WireValue
        do { value = try await json("/auth/face/profile/status", method: "POST", body: signed.0) }
        catch NativeAPIError.denied(404, "face_profile_control_not_found") {
            try checkLifecycle(record, serial: serial)
            guard !record.controlReady, retryOriginal, let credential = record.credentials else { throw NativeAPIError.operationUnconfirmed(record.controlOperationKey) }
            credentials = credential; if credential.expiresAt <= Date() { try await refresh() }; try checkLifecycle(record, serial: serial)
            let captured = try scope(anonymous: true), current = try await json("/me", scope: captured); try check(captured); try checkLifecycle(record, serial: serial)
            guard current["user_id"].string == record.accountID, current["auth_method"].string == "registered_face", current["authenticated"].bool == true else { throw NativeAPIError.invalidResponse }
            let result = try await json("/auth/face/profile/control", method: "POST", body: record.controlBody, scope: captured)
            try checkLifecycle(record, serial: serial); try acceptLifecycleMetadata(result, record: faceLifecycle!); return try faceLifecycleSummary()!
        }
        catch NativeAPIError.denied(404, "face_profile_operation_not_found") {
            try checkLifecycle(record, serial: serial)
            let base = try lifecycleRequest(record, step: "status"), latest = try await json("/auth/face/profile/status", method: "POST", body: base.0)
            try checkLifecycle(record, serial: serial)
            try acceptLifecycleMetadata(latest, record: record, nonce: base.1)
            guard var next = faceLifecycle, var intent = next.pending else { throw NativeAPIError.invalidResponse }
            intent.missingOnServer = true; next.pending = intent; try saveFaceLifecycle(next)
            guard retryOriginal else { return try faceLifecycleSummary()! }
            guard next.metadata.version == intent.expectedVersion else { throw NativeAPIError.unsupported(String(localized: "Your face-profile state changed. Keep the original action record; it cannot be resent against a different version.")) }
            if intent.cancelRequested { return try await dispatchLifecycleCancellation(serial: serial) }
            return try await dispatchLifecycleIntent(serial: serial)
        }
        try checkLifecycle(record, serial: serial); try acceptLifecycleMetadata(value, record: record, nonce: signed.1, includeOperation: record.pending != nil)
        if retryOriginal, faceLifecycle?.pending?.cancelRequested == true { return try await dispatchLifecycleCancellation(serial: serial) }
        return try faceLifecycleSummary()!
    }
    func checkFaceLifecycle(retryOriginal: Bool = false) async throws -> NativeFaceLifecycleSummary {
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        do {
            guard let record = faceLifecycle else { throw NativeAPIError.invalidResponse }
            if record.promotionCredentials != nil { _ = try await repairFaceLifecyclePromotion(serial: serial); return try faceLifecycleSummary()! }
            let status = try await lifecycleStatus(serial: serial, retryOriginal: retryOriginal)
            if faceLifecycle?.credentials != nil, !faceLifecycle!.blocksAlternateRecovery { try await validateLifecycleCurrent(serial: serial) }
            return try faceLifecycleSummary() ?? status
        } catch {
            if var record = faceLifecycle, lifecycleSerial == serial {
                record.authorityUnavailable = true
                if case NativeAPIError.denied(_, let code) = error { record.authorityFailure = code }
                try? saveFaceLifecycle(record); retireMedia()
            }
            throw error
        }
    }
    func faceProfileAction(_ action: NativeFaceProfileAction, consentPolicy: String? = nil, expectedVersion: Int? = nil) async throws -> NativeFaceLifecycleSummary {
        guard !action.captures else { throw NativeAPIError.invalidResponse }
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        _ = try await lifecycleStatus(serial: serial)
        guard var record = faceLifecycle, record.controlReady, !record.authorityUnavailable else { throw NativeAPIError.authenticationRequired }
        guard expectedVersion == nil || expectedVersion == record.metadata.version else { throw NativeAPIError.reviewChanged }
        if let pending = record.pending, !["applied", "completed", "cancelled"].contains(pending.serverState ?? "") { throw NativeAPIError.operationUnconfirmed(pending.operationKey) }
        if action == .resume { guard consentPolicy == record.metadata.photoPolicy else { throw NativeAPIError.unsupported(String(localized: "Accept the current photo-matching policy to resume.")) } }
        if let previous = record.pending { guard record.history.count < 32 else { throw NativeAPIError.unsupported(String(localized: "Face-profile history is full. Keep the existing status.")) }; record.history.append(previous) }
        let consent: WireValue? = action == .resume ? .object(["purpose": .string("photo_matching"), "policy_version": .string(consentPolicy!), "granted": .bool(true)]) : nil
        record.pending = NativeFaceLifecycleIntent(operationKey: UUID().uuidString.lowercased(), action: action, expectedVersion: record.metadata.version, consent: consent, createdAt: Date())
        try saveFaceLifecycle(record)
        return try await dispatchLifecycleIntent(serial: serial)
    }
    private func dispatchLifecycleIntent(serial: Int) async throws -> NativeFaceLifecycleSummary {
        guard let record = faceLifecycle, let intent = record.pending else { throw NativeAPIError.invalidResponse }; try checkLifecycle(record, serial: serial)
        guard record.metadata.version == intent.expectedVersion else { throw NativeAPIError.reviewChanged }
        let signed = try lifecycleRequest(record, step: intent.action.captures ? "challenge" : "action", extra: intent.fields)
        let value = try await json(intent.action.captures ? "/auth/face/profile/challenge" : "/auth/face/profile/action", method: "POST", body: signed.0)
        try checkLifecycle(record, serial: serial)
        if intent.action.captures { _ = try acceptLifecycleChallenge(value, record: record) }
        else { try acceptLifecycleMetadata(value, record: record, nonce: signed.1, includeOperation: true) }
        return try faceLifecycleSummary()!
    }
    private func acceptLifecycleChallenge(_ value: WireValue, record: NativeFaceLifecycleRecord, successor: Bool = false) throws -> NativeFaceChallenge {
        guard var pending = record.pending, pending.action.captures,
              value["lifecycle_operation_key"].string == pending.operationKey,
              let generation = value["lifecycle_generation"].integer,
              generation == (successor ? pending.generation + 1 : max(1, pending.generation)),
              value["policy_version"].string == pending.consent?["policy_version"].string else { throw NativeAPIError.invalidResponse }
        var object = value.object!; if pending.action.purpose == "registration" { object["face_handle"] = .string(record.originalDevice.faceHandle) }
        let wire = WireValue.object(object), challenge = try NativeFaceChallenge(wire, accountID: record.accountID, purpose: pending.action.purpose, allowExpired: true)
        guard challenge.deviceID == record.originalDevice.deviceID, value["device_revision"].string == record.metadata.deviceRevision else { throw NativeAPIError.invalidResponse }
        try checkLifecycleReference(challenge, action: pending.action, profile: record.metadata.profile)
        if generation == pending.generation, let previous = pending.predecessorID { guard previous == challenge.id else { throw NativeAPIError.invalidResponse } }
        if successor { guard pending.resume != nil else { throw NativeAPIError.invalidResponse }; pending.captures = []; pending.retiredCaptures = [] }
        pending.generation = generation; pending.predecessorID = challenge.id; pending.challengeWire = wire; pending.resume = nil; pending.serverState = "pending"; pending.completionPending = false; pending.missingOnServer = false
        var next = record; next.pending = pending; next.authorityUnavailable = false; try saveFaceLifecycle(next); return challenge
    }
    func startFaceProfileCapture(_ action: NativeFaceProfileAction, consentPolicy: String, expectedVersion: Int? = nil) async throws -> NativeFaceLifecycleSummary {
        guard action.captures else { throw NativeAPIError.invalidResponse }
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        _ = try await lifecycleStatus(serial: serial)
        guard var record = faceLifecycle, !record.authorityUnavailable, consentPolicy == record.metadata.authPolicy else { throw NativeAPIError.unsupported(String(localized: "Accept the current face-authentication policy before capturing.")) }
        guard expectedVersion == nil || expectedVersion == record.metadata.version else { throw NativeAPIError.reviewChanged }
        if let pending = record.pending, !["applied", "completed", "cancelled"].contains(pending.serverState ?? "") {
            guard pending.action == action else { throw NativeAPIError.operationUnconfirmed(pending.operationKey) }
            if ["restart_required", "failed"].contains(pending.serverState ?? "") { return try await resumeLifecycleIntent(serial: serial) }
            guard !pending.awaitingServer else { return try faceLifecycleSummary()! }
            return try faceLifecycleSummary()!
        }
        if action == .enroll { guard record.metadata.profile == nil, record.metadata.removalState == "completed" else { throw NativeAPIError.unsupported(String(localized: "Wait for confirmed reference cleanup before enrolling again.")) } }
        else { guard record.metadata.profile != nil else { throw NativeAPIError.unsupported(String(localized: "This reference was removed. Confirm cleanup before enrolling again.")) } }
        if action == .replace { guard record.metadata.authenticationEnabled else { throw NativeAPIError.authenticationRequired } }
        if action == .restoreAuthentication { guard !record.metadata.authenticationEnabled else { throw NativeAPIError.unsupported(String(localized: "Face authentication is already enabled.")) } }
        if let previous = record.pending { guard record.history.count < 32 else { throw NativeAPIError.invalidResponse }; record.history.append(previous) }
        let consent: WireValue = .object(["purpose": .string("face_authentication"), "policy_version": .string(consentPolicy), "granted": .bool(true)])
        record.pending = NativeFaceLifecycleIntent(operationKey: UUID().uuidString.lowercased(), action: action, expectedVersion: record.metadata.version, consent: consent, createdAt: Date())
        record.loginChallengeWire = nil; record.loginTerminalCode = nil; record.loginCaptures = []; try saveFaceLifecycle(record)
        return try await dispatchLifecycleIntent(serial: serial)
    }
    private func resumeLifecycleIntent(serial: Int) async throws -> NativeFaceLifecycleSummary {
        guard var record = faceLifecycle, var intent = record.pending, intent.action.captures,
              ["restart_required", "failed"].contains(intent.serverState ?? ""), let challenge = intent.predecessorID,
              record.metadata.version == intent.expectedVersion else { throw NativeAPIError.operationUnconfirmed(faceLifecycle?.pending?.operationKey ?? "") }
        if intent.resume == nil { intent.resume = NativeEnrollmentResume(key: UUID().uuidString.lowercased(), generation: intent.generation, challengeID: challenge); record.pending = intent; try saveFaceLifecycle(record) }
        let resume = intent.resume!, signed = try lifecycleRequest(record, step: "resume", extra: ["operation_key": .string(intent.operationKey), "resume_key": .string(resume.key), "expected_generation": .integer(resume.generation), "expected_challenge_id": .string(resume.challengeID)])
        let value = try await json("/auth/face/profile/resume", method: "POST", body: signed.0)
        try checkLifecycle(record, serial: serial); _ = try acceptLifecycleChallenge(value, record: faceLifecycle!, successor: true)
        return try faceLifecycleSummary()!
    }
    func freshFaceProfileLogin() async throws -> NativeFaceLifecycleSummary {
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        if let record = faceLifecycle, record.promotionCredentials == nil, record.loginTerminalCode == nil, let wire = record.loginChallengeWire {
            let current = try NativeFaceChallenge(wire, accountID: record.accountID, purpose: "login", allowExpired: true)
            if current.expiresAt > Date() {
                guard !record.loginCompletionPending, record.loginCaptures.allSatisfy(\.accepted) else { throw NativeAPIError.operationUnconfirmed(current.id) }
                return try faceLifecycleSummary()!
            }
        }
        do { _ = try await lifecycleStatus(serial: serial) }
        catch NativeAPIError.denied(401, "face_profile_control_unavailable") {
            guard var held = faceLifecycle, held.metadata.authenticationEnabled,
                  held.pending == nil || ["applied", "completed", "cancelled"].contains(held.pending!.serverState ?? ""), held.renewal == nil else { throw NativeAPIError.authenticationRequired }
            // Explicit ordinary authentication is still enforced by the server.
            // This saved seam grants/regrants no consent and renews no control.
            held.authorityUnavailable = true; held.authorityFailure = "face_profile_control_unavailable"; held.stableControlLogin = true; held.loginChallengeWire = nil; held.loginTerminalCode = nil; held.loginCaptures = []; held.loginCompletionPending = false; try saveFaceLifecycle(held)
        }
        guard var record = faceLifecycle, record.metadata.authenticationEnabled, let profile = record.metadata.profile,
              record.pending == nil || ["applied", "completed", "cancelled"].contains(record.pending!.serverState ?? ""), record.promotionCredentials == nil else { throw NativeAPIError.authenticationRequired }
        try assertLifecycleKey(record)
        let value = try await json("/auth/face/challenge", method: "POST", body: .object(["face_handle": .string(record.originalDevice.faceHandle), "device_id": .string(record.originalDevice.deviceID)]))
        try checkLifecycle(record, serial: serial)
        let challenge = try NativeFaceChallenge(value, accountID: record.accountID, purpose: "login")
        guard challenge.deviceID == record.originalDevice.deviceID, value["device_revision"].string == record.metadata.deviceRevision,
              value["profile_id"].string == profile.id, value["profile_revision"].string == profile.revision,
              value["model_id"].string == profile.modelID, value["policy_version"].string == record.metadata.authPolicy else { throw NativeAPIError.invalidResponse }
        record.loginChallengeWire = value; record.loginTerminalCode = nil; record.loginCaptures = []; record.loginCompletionPending = false; if !record.stableControlLogin { record.authorityUnavailable = false }; try saveFaceLifecycle(record)
        return try faceLifecycleSummary()!
    }
    private func captureFaceLifecycle(_ bytes: Data, index: Int, challenge: NativeFaceChallenge) async throws -> WireValue {
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        guard var record = faceLifecycle, (!record.authorityUnavailable || record.stableControlLogin && challenge.purpose == "login"), challenge.expiresAt > Date(), challenge.poses.indices.contains(index), !bytes.isEmpty, bytes.count <= 8 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        try assertLifecycleKey(record); let login = challenge.purpose == "login"
        let saved = login ? record.loginChallengeWire : record.pending?.challengeWire
        guard saved == challenge.wire else { throw NativeAPIError.sessionChanged }
        var captures = login ? record.loginCaptures : record.pending!.captures
        guard captures.count == index, captures.allSatisfy(\.accepted), captures.reduce(0, { $0 + $1.byte_size }) + bytes.count <= 8 * 1024 * 1024,
              !captures.contains(where: { $0.sha256 == signer.sha256(bytes) }) else { throw NativeAPIError.invalidResponse }
        if !login { guard record.pending?.awaitingServer == false, record.pending?.completionPending == false, record.pending?.serverState == "pending" else { throw NativeAPIError.operationUnconfirmed(record.pending!.operationKey) } }
        let hash = signer.sha256(bytes); captures.append(NativeEnrollmentCapture(index: index, sha256: hash, byteSize: bytes.count))
        if login { record.loginCaptures = captures } else { record.pending!.captures = captures }
        try saveFaceLifecycle(record)
        var envelope = challenge.deviceEnvelope(); envelope["step"] = .string("capture"); envelope["capture_index"] = .integer(index); envelope["capture_sha256"] = .string(hash); envelope["mime"] = .string("image/jpeg"); envelope["byte_size"] = .integer(bytes.count)
        let signature = try signDevice(WireValue.object(envelope).canonical(), alias: record.keyAlias)
        let reply = try await request("/auth/face/proof/\(challenge.id)/\(index)", method: "PUT", raw: bytes, headers: ["Content-Type": "image/jpeg", "X-Lovelies-Capture-SHA256": hash, "X-Lovelies-Capture-Bytes": String(bytes.count), "X-Lovelies-Device-Signature": signature])
        try checkLifecycle(record, serial: serial); let receipt = try WireValue.decoded(reply.data)
        guard receipt["protocol"].string == "lovelies-face-auth-v1", receipt["status"].string == "capture_received", receipt["challenge_id"].string == challenge.id,
              receipt["capture_index"].integer == index, receipt["capture_sha256"].string == hash, receipt["byte_size"].integer == bytes.count else { throw NativeAPIError.invalidResponse }
        if login { record.loginCaptures[index].accepted = true } else { record.pending!.captures[index].accepted = true }
        try saveFaceLifecycle(record); return captures[index].wire
    }
    private func completeFaceLifecycle(_ challenge: NativeFaceChallenge, captures: [WireValue]) async throws -> NativeSessionSummary {
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        guard var record = faceLifecycle, (!record.authorityUnavailable || record.stableControlLogin && challenge.purpose == "login"), challenge.expiresAt > Date() else { throw NativeAPIError.invalidResponse }
        try assertLifecycleKey(record); let login = challenge.purpose == "login", planned = login ? record.loginCaptures : record.pending?.captures ?? []
        guard (login ? record.loginChallengeWire : record.pending?.challengeWire) == challenge.wire,
              planned.count == challenge.poses.count, planned.allSatisfy(\.accepted), planned.map(\.wire) == captures else { throw NativeAPIError.invalidResponse }
        if login { record.loginCompletionPending = true } else { record.pending!.completionPending = true }; try saveFaceLifecycle(record)
        var envelope = challenge.deviceEnvelope(); envelope["step"] = .string("complete"); envelope["capture_manifest"] = .array(captures)
        let value: WireValue
        do { value = try await json(login ? "/auth/face/complete" : "/auth/face/profile/complete", method: "POST", body: .object(["challenge_id": .string(challenge.id), "device_signature": .string(try signDevice(WireValue.object(envelope).canonical(), alias: record.keyAlias))])) }
        catch {
            if login, let code = NativeFaceTerminalFailure.code(error), lifecycleSerial == serial, faceLifecycle?.loginChallengeWire == challenge.wire {
                record.loginTerminalCode = code; try saveFaceLifecycle(record)
            }
            throw error
        }
        try checkLifecycle(record, serial: serial)
        guard value["protocol"].string == "lovelies-face-auth-v1", value["status"].string == "authenticated", value["device_id"].string == record.originalDevice.deviceID else { throw NativeAPIError.invalidResponse }
        let profile = NativeEnrollmentProfile(id: try value.uuid("profile_id"), revision: try value.text("profile_revision"), modelID: try value.text("model_id"))
        if login || record.pending?.action == .restoreAuthentication { guard profile == record.metadata.profile else { throw NativeAPIError.invalidResponse } }
        if record.pending?.action == .replace, !login { guard profile.id == record.metadata.profile?.id, profile.revision != record.metadata.profile?.revision else { throw NativeAPIError.invalidResponse } }
        let next = try NativeCredentials(value); guard next.authenticated, next.account_id == record.accountID else { throw NativeAPIError.sessionChanged }
        record.promotionCredentials = next; record.promotionProfile = profile; try saveFaceLifecycle(record)
        return try await repairFaceLifecyclePromotion(serial: serial)
    }
    private func validateLifecycleCurrent(serial: Int) async throws {
        guard let record = faceLifecycle, let saved = record.credentials, record.metadata.authenticationEnabled, let profile = record.metadata.profile else { throw NativeAPIError.authenticationRequired }
        credentials = saved
        if saved.expiresAt <= Date() { try await refresh() }; try checkLifecycle(record, serial: serial)
        let captured = try scope(anonymous: true), value = try await json("/me", scope: captured)
        try check(captured); try checkLifecycle(record, serial: serial)
        guard value["user_id"].string == record.accountID, value["auth_method"].string == "registered_face", value["authenticated"].bool == true,
              value["profile_id"].string == profile.id, value["profile_revision"].string == profile.revision else { throw NativeAPIError.invalidResponse }
        let devices = try await json("/me/devices", scope: captured); try check(captured); try checkLifecycle(record, serial: serial)
        guard let rows = devices["items"].array, rows.filter({ $0["current"].bool == true }).count == 1,
              rows.contains(where: { $0["current"].bool == true && $0["id"].string == record.originalDevice.deviceID && $0["status"].string == "active" }) else { throw NativeAPIError.invalidResponse }
        var validated = faceLifecycle!; validated.currentAuthorityValidated = true; try saveFaceLifecycle(validated)
    }
    private func repairFaceLifecyclePromotion(serial: Int? = nil) async throws -> NativeSessionSummary {
        let serial = serial ?? lifecycleSerial
        guard var record = faceLifecycle, let staged = record.promotionCredentials, let profile = record.promotionProfile else { throw NativeAPIError.invalidResponse }
        try checkLifecycle(record, serial: serial); try assertLifecycleKey(record)
        try activateLocalPromotion(staged, journal: record)
        if staged.expiresAt <= Date() { try await refresh() }; try checkLifecycle(record, serial: serial)
        let captured = try scope(anonymous: true), value = try await json("/me", scope: captured); try check(captured); try checkLifecycle(record, serial: serial)
        guard value["user_id"].string == record.accountID, value["auth_method"].string == "registered_face", value["authenticated"].bool == true,
              value["profile_id"].string == profile.id, value["profile_revision"].string == profile.revision else { throw NativeAPIError.invalidResponse }
        let devices = try await json("/me/devices", scope: captured); try check(captured); try checkLifecycle(record, serial: serial)
        guard let rows = devices["items"].array, rows.filter({ $0["current"].bool == true }).count == 1,
              rows.contains(where: { $0["current"].bool == true && $0["id"].string == record.originalDevice.deviceID && $0["status"].string == "active" }) else { throw NativeAPIError.invalidResponse }
        if record.stableControlLogin {
            let metadata = try await json("/me/face-profile", scope: captured); try check(captured); try checkLifecycle(record, serial: serial)
            try acceptLifecycleMetadata(metadata, record: faceLifecycle!)
            var held = faceLifecycle!; held.authorityUnavailable = true; held.authorityFailure = "face_profile_control_unavailable"; held.currentAuthorityValidated = true; try saveFaceLifecycle(held)
        } else { _ = try await lifecycleStatus(serial: serial); try checkLifecycle(record, serial: serial) }
        record = faceLifecycle!
        guard record.metadata.profile == profile, record.metadata.authenticationEnabled else { throw NativeAPIError.invalidResponse }
        let credential = record.promotionCredentials!
        var device = record.originalDevice; device.profileID = profile.id; device.profileRevision = profile.revision; device.modelID = profile.modelID
        // Staged journal and current server device checks precede every durable
        // publication. A failed slot write is repairable from this journal.
        try secrets.write("registered-device", data: JSONEncoder().encode(device)); try persistCredential(credential)
        record.credentials = credential; record.promotionCredentials = nil; record.promotionProfile = nil; record.loginChallengeWire = nil; record.loginTerminalCode = nil; record.loginCaptures = []; record.loginCompletionPending = false; record.authorityUnavailable = record.stableControlLogin; record.currentAuthorityValidated = true; record.stableControlLogin = false
        try saveFaceLifecycle(record); credentials = credential
        try retireOwnLifecycleIdentity(account: record.accountID)
        if record.authorityUnavailable { return NativeSessionSummary(accountID: credential.account_id, roles: credential.roles, authenticated: true, expiresAt: credential.expiresAt, epoch: epoch) }
        guard let result = summary() else { throw NativeAPIError.invalidResponse }; return result
    }
}

extension BackendRepository {
    func prepareFaceProfileCancellation() throws -> NativeLocalTransitionTicket {
        guard guestDeletion == nil, !guestDeletionBusy, accountRecovery == nil, let saved = faceLifecycle, saved.pending?.action.captures == true else { throw NativeAPIError.authenticationRequired }
        try saved.validate(origin: origin)
        guard let bytes = try secrets.read("face-profile-lifecycle"), bytes.count <= 128 * 1024,
              try localEncodedDigest(JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: bytes)) == localEncodedDigest(saved) else { throw NativeAPIError.sessionChanged }
        // Fence an older shutter/verifier reply before awaiting its cancellation.
        lifecycleSerial += 1; lifecycleBusy = false; epoch += 1; transport.cancelPending(); retireMedia()
        var record = saved; record.pending!.cancelRequested = true; record.authorityUnavailable = false; try saveFaceLifecycle(record)
        return try makeLocalTransition(kind: .profileCancellation, account: record.accountID, alias: record.keyAlias,
            intent: record.controlOperationKey + ":" + record.pending!.operationKey, serial: lifecycleSerial)
    }
    func cancelFaceProfileCapture(transition: NativeLocalTransitionTicket? = nil) async throws -> NativeFaceLifecycleSummary {
        let ticket = try transition ?? prepareFaceProfileCancellation()
        let prepared = try requireLocalTransition(ticket)
        guard prepared.kind == .profileCancellation, let record = faceLifecycle else { throw NativeLocalAuthenticationIssue.bindingChanged }
        try requireLocalTransitionGrant(prepared, envelope: record.controlEnvelope)
        preparedLocalTransition = nil
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        return try await dispatchLifecycleCancellation(serial: serial)
    }
    private func dispatchLifecycleCancellation(serial: Int) async throws -> NativeFaceLifecycleSummary {
        guard let record = faceLifecycle, let intent = record.pending, intent.action.captures, intent.cancelRequested else { throw NativeAPIError.invalidResponse }
        let signed = try lifecycleRequest(record, step: "cancel", extra: ["operation_key": .string(intent.operationKey)])
        let value = try await json("/auth/face/profile/cancel", method: "POST", body: signed.0)
        try checkLifecycle(record, serial: serial)
        guard ["cancelled", "completed"].contains(value["operation"]["state"].string ?? "") else { throw NativeAPIError.invalidResponse }
        try acceptLifecycleMetadata(value, record: record, nonce: signed.1, includeOperation: true)
        return try faceLifecycleSummary()!
    }
}

extension BackendRepository {
    private func retireFaceLifecycleAfterDeletion(account: String) throws {
        guard let data = try secrets.read("face-profile-lifecycle") else { return }
        var record = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: data); try record.validate(origin: origin)
        guard record.accountID == account else { return } // Never remove another account's retained alias/control.
        record.credentials = nil; record.promotionCredentials = nil; record.promotionProfile = nil; record.loginChallengeWire = nil; record.loginTerminalCode = nil; record.loginCaptures = []
        var history: [NativeFaceLifecycleRecord] = []
        if let existing = try secrets.read("deleted-face-profile-controls") { guard existing.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }; history = try JSONDecoder().decode([NativeFaceLifecycleRecord].self, from: existing) }
        if !history.contains(where: { $0.controlOperationKey == record.controlOperationKey }) { guard history.count < 16 else { throw NativeAPIError.unsupported(String(localized: "Deleted-account private history is full. Keep the deletion receipt.")) }; history.append(record) }
        try secrets.write("deleted-face-profile-controls", data: JSONEncoder().encode(history))
        try secrets.write("face-profile-lifecycle", data: nil); faceLifecycle = nil; lifecycleSerial += 1
        // The server-completed deletion is the authority for retiring this exact
        // owned alias. The archive cannot authenticate or trigger new setup.
        if deletionOwnsKey(account: account, alias: record.keyAlias, publicJWK: record.publicJWK) { try retireUnreferencedDeviceKey(alias: record.keyAlias, publicJWK: record.publicJWK) }
    }
}

extension BackendRepository {
    /// Expired-control status proves only ownership of this retained management
    /// secret and device. It never rotates a key or installs a product session.
    func checkRetainedFaceControl() async throws -> NativeFaceLifecycleSummary {
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        guard let record = faceLifecycle, record.renewal == nil else { throw NativeAPIError.invalidResponse }
        try checkLifecycle(record, serial: serial)
        let signed = try lifecycleRequest(record, step: "control-status")
        let value = try await json("/auth/face/profile/control/status", method: "POST", body: signed.0, preserveRefreshAuthority: true)
        try checkLifecycle(record, serial: serial)
        let metadata = try NativeFaceProfileMetadata(value, account: record.accountID, device: record.originalDevice.deviceID, digest: record.publicKeyDigest, nonce: signed.1)
        guard metadata.version >= record.metadata.version, metadata.deviceRevision == record.metadata.deviceRevision,
              let recovery = metadata.controlRecovery, value["operation"] == .null else { throw NativeAPIError.invalidResponse }
        try acceptLifecycleMetadata(value, record: record, nonce: signed.1)
        var next = faceLifecycle!; next.authorityUnavailable = recovery.expiresAt <= Date() || next.controlRecoveryRenewal != nil
        if next.authorityUnavailable { next.authorityFailure = "face_profile_control_unavailable" }
        try saveFaceLifecycle(next); retireMedia()
        return try faceLifecycleSummary()!
    }
    /// The immutable review binding, policy and operation key precede dispatch;
    /// fresh nonce/signature are produced for every replay of the original input.
    func renewRetainedFaceControl(consentPolicy: String?, retryOriginal: Bool = false) async throws -> NativeFaceLifecycleSummary {
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        guard var record = faceLifecycle, record.renewal == nil else { throw NativeAPIError.invalidResponse }
        try checkLifecycle(record, serial: serial)
        let operation: NativeFaceControlRecoveryRenewal
        if retryOriginal {
            guard let original = record.controlRecoveryRenewal else { throw NativeAPIError.invalidResponse }; operation = original
        } else {
            guard record.controlRecoveryRenewal == nil, let consentPolicy else { throw NativeAPIError.invalidResponse }
            operation = try NativeFaceControlRecoveryRenewal(metadata: record.metadata, consentPolicy: consentPolicy)
            record.controlRecoveryRenewal = operation; try saveFaceLifecycle(record)
        }
        let signed = try lifecycleRequest(record, step: "control-renew", extra: operation.fields)
        let value = try await json("/auth/face/profile/control/renew", method: "POST", body: signed.0, preserveRefreshAuthority: true)
        try checkLifecycle(record, serial: serial)
        let metadata = try NativeFaceProfileMetadata(value, account: record.accountID, device: record.originalDevice.deviceID, digest: record.publicKeyDigest, nonce: signed.1)
        guard metadata.version >= record.metadata.version, metadata.deviceRevision == record.metadata.deviceRevision,
              let recovery = metadata.controlRecovery, value["operation"] == .null else { throw NativeAPIError.invalidResponse }
        try operation.receipt(value["control_renewal"], current: recovery)
        // Keep the receipt's original dates separate from current metadata. A
        // later state may have advanced; it grants no historical eligibility.
        try acceptLifecycleMetadata(value, record: record, nonce: signed.1)
        var next = faceLifecycle!; next.controlRecoveryRenewal = nil
        next.authorityUnavailable = recovery.expiresAt <= Date(); next.authorityFailure = next.authorityUnavailable ? "face_profile_control_unavailable" : nil
        try saveFaceLifecycle(next); retireMedia()
        return try faceLifecycleSummary()!
    }
    private func renewalCandidate(_ record: NativeFaceLifecycleRecord) throws -> NativeFaceLifecycleRecord {
        guard let renewal = record.renewal, renewal.previousOperationKey == record.controlOperationKey else { throw NativeAPIError.invalidResponse }
        var next = record; next.controlKey = renewal.key; next.controlOperationKey = renewal.operationKey
        next.previousControlOperationKey = renewal.previousOperationKey; next.controlSignature = renewal.signature; next.createdAt = renewal.createdAt
        next.renewal = nil; next.controlReady = false; try next.validate(origin: origin); return next
    }
    private func finishControlRenewal(_ value: WireValue, record: NativeFaceLifecycleRecord, nonce: String? = nil) throws {
        var next = try renewalCandidate(record)
        let metadata = try NativeFaceProfileMetadata(value, account: record.accountID, device: record.originalDevice.deviceID, digest: record.publicKeyDigest, nonce: nonce)
        guard metadata.deviceRevision == record.metadata.deviceRevision, metadata.version >= record.metadata.version,
              metadata.authenticationEnabled, metadata.profile == record.metadata.profile, value["operation"] == .null,
              record.controlHistory.count < 8 else { throw NativeAPIError.invalidResponse }
        next.controlHistory.append(record.controlBinding); next.metadata = metadata; next.controlReady = true; next.authorityUnavailable = false; next.authorityFailure = nil
        try saveFaceLifecycle(next) // The old binding is retained privately in this same durable record.
    }
    private func dispatchControlRenewal(serial: Int) async throws -> NativeFaceLifecycleSummary {
        guard let record = faceLifecycle, record.renewal != nil, let original = record.credentials else { throw NativeAPIError.authenticationRequired }
        try assertLifecycleKey(record); credentials = original
        if original.expiresAt <= Date() { try await refresh() }; try checkLifecycle(record, serial: serial)
        // An expired capability cannot create/regrant account authority. Only
        // current registered credentials on the exact original device qualify.
        let captured = try scope(anonymous: true), current = try await json("/me", scope: captured); try check(captured); try checkLifecycle(record, serial: serial)
        guard current["user_id"].string == record.accountID, current["auth_method"].string == "registered_face", current["authenticated"].bool == true,
              current["profile_id"].string == record.metadata.profile?.id, current["profile_revision"].string == record.metadata.profile?.revision else { throw NativeAPIError.authenticationRequired }
        let devices = try await json("/me/devices", scope: captured); try check(captured); try checkLifecycle(record, serial: serial)
        guard let rows = devices["items"].array, rows.filter({ $0["current"].bool == true }).count == 1,
              rows.contains(where: { $0["current"].bool == true && $0["id"].string == record.originalDevice.deviceID && $0["status"].string == "active" }) else { throw NativeAPIError.invalidResponse }
        let candidate = try renewalCandidate(faceLifecycle!), value = try await json("/auth/face/profile/control", method: "POST", body: candidate.controlBody, scope: captured)
        try check(captured); try checkLifecycle(record, serial: serial); try finishControlRenewal(value, record: faceLifecycle!)
        return try faceLifecycleSummary()!
    }
    private func reconcileControlRenewal(serial: Int, retry: Bool) async throws -> NativeFaceLifecycleSummary {
        guard let record = faceLifecycle, record.renewal != nil else { throw NativeAPIError.invalidResponse }
        let candidate = try renewalCandidate(record), signed = try lifecycleRequest(candidate, step: "status")
        do {
            let value = try await json("/auth/face/profile/status", method: "POST", body: signed.0)
            try checkLifecycle(record, serial: serial); try finishControlRenewal(value, record: faceLifecycle!, nonce: signed.1)
            if faceLifecycle?.credentials != nil { try await validateLifecycleCurrent(serial: serial) }
            return try faceLifecycleSummary()!
        } catch NativeAPIError.denied(401, "face_profile_control_unavailable") {
            try checkLifecycle(record, serial: serial)
            guard retry else { throw NativeAPIError.operationUnconfirmed(record.renewal!.operationKey) }
            return try await dispatchControlRenewal(serial: serial)
        }
    }
    func renewFaceControl() async throws -> NativeFaceLifecycleSummary {
        let serial = try beginLifecycleWork(); defer { endLifecycleWork(serial) }
        guard var record = faceLifecycle, record.metadata.authenticationEnabled, record.credentials != nil,
              record.pending == nil || ["applied", "completed", "cancelled"].contains(record.pending!.serverState ?? "") else { throw NativeAPIError.authenticationRequired }
        if record.renewal != nil { return try await reconcileControlRenewal(serial: serial, retry: true) }
        guard record.authorityUnavailable, record.authorityFailure == "face_profile_control_unavailable", record.controlHistory.count < 8 else { throw NativeAPIError.unsupported(String(localized: "Check the expired control and your current face session before explicitly renewing it.")) }
        try assertLifecycleKey(record); credentials = record.credentials
        if credentials!.expiresAt <= Date() { try await refresh() }; try checkLifecycle(record, serial: serial)
        let captured = try scope(anonymous: true), current = try await json("/me/face-profile", scope: captured); try check(captured); try checkLifecycle(record, serial: serial)
        let metadata = try NativeFaceProfileMetadata(current, account: record.accountID, device: record.originalDevice.deviceID, digest: record.publicKeyDigest)
        guard metadata.deviceRevision == record.metadata.deviceRevision, metadata.authenticationEnabled, metadata.profile == record.metadata.profile else { throw NativeAPIError.invalidResponse }
        record = faceLifecycle!; record.metadata = metadata
        let key = try Self.recoveryRandom("lfl_"), operation = UUID().uuidString.lowercased()
        var body: [String: WireValue] = ["account_id": .string(record.accountID), "device_id": .string(record.originalDevice.deviceID), "control_key": .string(key), "control_operation_key": .string(operation), "renew": .bool(true), "previous_control_operation_key": .string(record.controlOperationKey), "protocol": .string("lovelies-face-profile-device-v1"), "step": .string("control")]
        let signature = try signDevice(WireValue.object(body).canonical(), alias: record.keyAlias); body.removeAll()
        record.renewal = NativeFaceControlBinding(key: key, operationKey: operation, previousOperationKey: record.controlOperationKey, signature: signature, createdAt: Date())
        record.currentAuthorityValidated = false; try saveFaceLifecycle(record) // New secret/body precedes renewal traffic; old binding remains.
        return try await dispatchControlRenewal(serial: serial)
    }
}

// Durable ordinary personal uploads. A05 has its own token-free operation
// journal, so a recovered reservation is adopted before any subsequent write.
extension BackendRepository {
    private func uploadBatchJournal() throws -> ([NativeResumableUploadBatch], Data?) {
        guard let bytes = try secrets.read("resumable-photo-batches-v1") else { return ([], nil) }
        guard bytes.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        let values = try JSONDecoder().decode([NativeResumableUploadBatch].self, from: bytes)
        guard values.count <= 10, Set(values.map(\.id)).count == values.count else { throw NativeAPIError.invalidResponse }
        for value in values { try value.validate(origin: origin) }
        return (values, bytes)
    }
    private func restoreUploadBatches() throws {
        uploadBatches = try uploadBatchJournal().0
    }
    private func retireDeletedAccountUploads(_ account: String) async throws {
        // Bootstrap intentionally does not restore uploads while a deletion
        // receipt exists. The durable roster, never an empty fresh cache, owns
        // cleanup. Foreign-account rows retain every byte and revision.
        var (batches, bytes) = try uploadBatchJournal()
        let ids = batches.filter { $0.accountID == account }.map(\.id)
        for index in batches.indices where batches[index].accountID == account {
            batches[index].paused = true; batches[index].backgroundRetryAllowed = false; batches[index].revise()
            try batches[index].validate(origin: origin)
        }
        if !ids.isEmpty {
            do {
                guard try secrets.compareAndSwap("resumable-photo-batches-v1", expected: bytes, replacement: JSONEncoder().encode(batches)) else { throw NativeAPIError.sessionChanged }
            } catch {
                // A storage failure must not keep sending a deleted account's
                // bytes. Cancellation is nondestructive; files/roster stay held.
                let stop = scheduleUploadCancellation(ids); await stop.value; throw error
            }
        }
        uploadBatches = batches
        let stop = scheduleUploadCancellation(ids); await stop.value
    }
    private func saveUploadBatches() throws {
        for value in uploadBatches { try value.validate(origin: origin) }
        try secrets.write("resumable-photo-batches-v1", data: JSONEncoder().encode(uploadBatches))
    }
    private func uploadOwner(_ batch: NativeResumableUploadBatch) throws {
        guard let credentials, credentials.authenticated, credentials.account_id == batch.accountID,
              let device = try device(), device.accountID == batch.accountID, device.deviceID == batch.deviceID else { throw NativeAPIError.sessionChanged }
    }
    private func validateUploadDevice(_ batch: NativeResumableUploadBatch, captured: Scope) async throws {
        try uploadOwner(batch)
        let value = try await json("/me/devices", scope: captured); try check(captured)
        guard let rows = value["items"].array, rows.filter({ $0["current"].bool == true }).count == 1,
              rows.contains(where: { $0["current"].bool == true && $0["id"].string == batch.deviceID && $0["status"].string == "active" }) else { throw NativeAPIError.sessionChanged }
    }
    private func uploadIndex(_ id: String) throws -> Int {
        guard let index = uploadBatches.firstIndex(where: { $0.id == id }) else { throw NativeAPIError.invalidResponse }
        try uploadOwner(uploadBatches[index]); return index
    }
    func uploadSummary(batchID: String? = nil) throws -> NativeUploadSummary? {
        guard summary()?.authenticated == true, let device = try device() else { return nil }
        guard let batch = uploadBatches.last(where: { $0.accountID == credentials?.account_id && $0.deviceID == device.deviceID && (batchID == nil || $0.id == batchID!) }) else { return nil }
        try batch.validate(origin: origin)
        return NativeUploadSummary(batch: batch, sources: try batch.files.map { file in NativeUploadSource(id: file.id, file: try uploadFiles.url(file, batch: batch.id), title: file.title, width: file.width, height: file.height) })
    }
    func stagePhotoUpload(_ sources: [NativeUploadSource], caption: String = "", expectedOwner: NativeMediaCaptureContext? = nil) async throws -> NativeUploadSummary {
        if let expectedOwner, !expectedOwner.ownsSession(summary()) { throw NativeAPIError.sessionChanged }
        let captured = try await readyScope()
        _ = try await requirePhotoCollection(captured: captured, expectedOwner: expectedOwner)
        try Task.checkCancellation()
        if let expectedOwner, !expectedOwner.ownsSession(summary()) { throw NativeAPIError.sessionChanged }
        guard !uploadBusy, let device = try device(), device.accountID == captured.account, (1...30).contains(sources.count), caption.utf16.count <= 500,
              Set(sources.map(\.id)).count == sources.count else { throw NativeAPIError.invalidResponse }
        if let previous = try uploadSummary(), previous.batch.started && !previous.batch.received && !previous.batch.finished {
            throw NativeAPIError.unsupported(String(localized: "Resume or cancel the saved upload before selecting another batch."))
        }
        var nextBatches = uploadBatches
        var retired: [NativeResumableUploadBatch] = []
        if let previous = try uploadSummary(), !previous.batch.started {
            retired.append(previous.batch); nextBatches.removeAll { $0.id == previous.batch.id }
        }
        // Keep finished batch identities for review/history. Bound private
        // metadata by retiring only the oldest finished own-account records.
        if nextBatches.count >= 10 {
            let removable = nextBatches.filter { $0.accountID == captured.account && $0.finished }
            for value in removable where nextBatches.count >= 10 {
                retired.append(value); nextBatches.removeAll { $0.id == value.id }
            }
        }
        guard nextBatches.count < 10 else { throw NativeAPIError.unsupported(String(localized: "Check the saved uploads before adding another batch.")) }
        let id = UUID().uuidString.lowercased()
        do {
            var files: [NativeResumableUploadFile] = []
            for (index, source) in sources.enumerated() {
                if index > 0 { _ = try await requirePhotoCollection(captured: captured, expectedOwner: expectedOwner) }
                try Task.checkCancellation(); try check(captured)
                files.append(try uploadFiles.stage(source, batch: id))
            }
            _ = try await requirePhotoCollection(captured: captured, expectedOwner: expectedOwner)
            try Task.checkCancellation(); try check(captured)
            if let expectedOwner, !expectedOwner.ownsSession(summary()) { throw NativeAPIError.sessionChanged }
            let batch = NativeResumableUploadBatch(id: id, origin: origin, account: captured.account!, device: device.deviceID, caption: caption, files: files)
            try batch.validate(origin: origin); nextBatches.append(batch)
            for next in nextBatches { try next.validate(origin: origin) }
            // New source validation and the atomic protected metadata write
            // precede retiring an earlier unsubmitted selection.
            try secrets.write("resumable-photo-batches-v1", data: JSONEncoder().encode(nextBatches)); uploadBatches = nextBatches
            for old in retired { uploadFiles.removeBatch(old.id) }
            return try uploadSummary(batchID: id)!
        } catch { uploadFiles.removeBatch(id); throw error }
    }
    func editPhotoUpload(batchID: String, selected: Set<String>, caption: String) throws -> NativeUploadSummary {
        let index = try uploadIndex(batchID)
        guard !uploadBusy, !uploadBatches[index].started, caption.utf16.count <= 500, selected.isSubset(of: Set(uploadBatches[index].files.map(\.id))) else { throw NativeAPIError.invalidResponse }
        uploadBatches[index].caption = caption
        for slot in uploadBatches[index].files.indices { uploadBatches[index].files[slot].selected = selected.contains(uploadBatches[index].files[slot].id) }
        uploadBatches[index].revise(); try saveUploadBatches(); return try uploadSummary(batchID: batchID)!
    }
    private func retireUploadWork() throws {
        uploadSerial += 1; uploadBusy = false
        for index in uploadBatches.indices { uploadBatches[index].paused = true; uploadBatches[index].revise() }
        _ = scheduleUploadCancellation(uploadBatches.map(\.id))
        try saveUploadBatches()
    }
    private func scheduleUploadCancellation(_ ids: [String]) -> Task<Void, Never> {
        let previous = uploadRetirement, transport = uploadTransport
        let stop = Task { await previous?.value; for id in ids { await transport.cancel(batch: id) } }
        uploadRetirement = stop; return stop
    }
    func pausePhotoUpload(batchID: String, disableAutomaticRetry: Bool = true) async throws -> NativeUploadSummary {
        let index = try uploadIndex(batchID); uploadSerial += 1; uploadBusy = false
        uploadBatches[index].paused = true
        if disableAutomaticRetry { uploadBatches[index].backgroundRetryAllowed = false }
        uploadBatches[index].revise(); try saveUploadBatches()
        let stop = scheduleUploadCancellation([batchID]); await stop.value
        return try uploadSummary(batchID: batchID)!
    }
    /// Restore only an existing registered session. OS retries never create an
    /// anonymous account, repair an authentication flow, or alter purpose consent.
    func restoreBackgroundUpload() async throws -> NativeUploadSummary? {
        for name in ["registered-deletion-receipt", "guest-deletion-receipt", "face-profile-lifecycle", "account-recovery-journal", "face-enrollment-journal", "ordinary-face-login-journal"] {
            if try secrets.read(name) != nil { return nil }
        }
        if credentials == nil {
            guard let data = try secrets.read("credentials"), data.count <= 16 * 1024 else { return nil }
            let saved = try JSONDecoder().decode(NativeCredentials.self, from: data)
            guard saved.authenticated else { return nil }
            try saved.validateRegisteredRecovery(accountID: saved.account_id)
            try restoreUploadBatches(); credentials = saved
            if let data = try secrets.read("operation-intents") { intents = try JSONDecoder().decode([NativeOperationIntent].self, from: data); guard intents.count <= 100 else { throw NativeAPIError.invalidResponse } }
        }
        guard summary()?.authenticated == true, pending().isEmpty else { return nil }
        _ = try await current() // Current server session must still authorize work.
        return try uploadSummary()
    }
    func allowBackgroundUpload(batchID: String) throws {
        let index = try uploadIndex(batchID)
        uploadBatches[index].backgroundRetryAllowed = true; uploadBatches[index].backgroundRetryAttempts = 0
        uploadBatches[index].revise(); try saveUploadBatches()
    }
    func beginBackgroundUpload(batchID: String) throws -> Bool {
        let index = try uploadIndex(batchID)
        guard !uploadBusy, uploadBatches[index].canRetryInBackground else { return false }
        uploadBatches[index].backgroundRetryAttempts = (uploadBatches[index].backgroundRetryAttempts ?? 0) + 1
        uploadBatches[index].revise(); try saveUploadBatches(); return true
    }
    private func uploadCheck(_ batchID: String, serial: Int, captured: Scope) throws -> Int {
        try check(captured); try Task.checkCancellation()
        let index = try uploadIndex(batchID)
        guard serial == uploadSerial, !uploadBatches[index].paused else { throw CancellationError() }
        return index
    }
    private func uploadJSON(_ path: String, body: WireValue? = nil, captured: Scope) async throws -> WireValue {
        try await json(path, method: body == nil ? "GET" : "POST", body: body, scope: captured)
    }
    private func originalUploadOperation(_ key: String, captured: Scope) async throws -> WireValue {
        try await uploadJSON("/community/action", body: .object(["action": .string("operation"), "payload": .object(["operation_key": .string(key)])]), captured: captured)
    }
    private func applyUploadStatus(_ value: WireValue, batchID: String, fileID: String, reservation: Bool = false) throws -> NativeResumableUploadStatus {
        let index = try uploadIndex(batchID), slot = uploadBatches[index].files.firstIndex(where: { $0.id == fileID })!
        let status = try NativeResumableUploadStatus(value, batch: uploadBatches[index], file: uploadBatches[index].files[slot], reservation: reservation)
        if reservation {
            guard value["upload_url"].string == "/uploads/" + (try value.uuid("asset_id")), value["chunk_url"].string == "/uploads/" + (try value.uuid("asset_id")) + "/chunks",
                  value["complete_url"].string == "/uploads/" + (try value.uuid("asset_id")) + "/complete" else { throw NativeAPIError.invalidResponse }
            uploadBatches[index].files[slot].assetID = try value.uuid("asset_id"); uploadBatches[index].files[slot].version = try value.uuid("version")
        }
        if value["attempt_id"] != .null { uploadBatches[index].files[slot].processingAttemptID = try value.uuid("attempt_id") }
        uploadBatches[index].files[slot].acknowledgedBytes = max(uploadBatches[index].files[slot].acknowledgedBytes, status.bytesReceived)
        uploadBatches[index].files[slot].phase = status.phase; uploadBatches[index].files[slot].errorCode = status.errorCode
        uploadBatches[index].revise(); try saveUploadBatches(); return status
    }
    private func reserveResumablePhoto(batchID: String, fileID: String, serial: Int, captured: Scope) async throws {
        let index = try uploadCheck(batchID, serial: serial, captured: captured), slot = uploadBatches[index].files.firstIndex(where: { $0.id == fileID })!
        let batch = uploadBatches[index], file = batch.files[slot]
        guard file.assetID == nil else { return }
        if file.reserveDispatched {
            let recovered = try await originalUploadOperation(file.reserveKey, captured: captured)
            _ = try uploadCheck(batchID, serial: serial, captured: captured)
            if recovered["status"].string != "unknown" { _ = try applyUploadStatus(recovered, batchID: batchID, fileID: fileID, reservation: true); return }
        }
        _ = try uploadFiles.verifiedBytes(file, batch: batchID)
        uploadBatches[index].files[slot].reserveDispatched = true; uploadBatches[index].files[slot].phase = .reserving; uploadBatches[index].revise(); try saveUploadBatches()
        let payload: WireValue = .object(["operation_key": .string(file.reserveKey), "source": .string("personal"), "upload_batch_id": .string(batch.id),
            "byte_size": .integer(file.byteSize), "content_type": .string(file.mime), "title": .string(batch.caption.isEmpty ? file.title : batch.caption),
            "resumable": .bool(true), "checksum_sha256": .string(file.sha256)])
        let value = try await uploadJSON("/uploads/session", body: payload, captured: captured)
        _ = try uploadCheck(batchID, serial: serial, captured: captured)
        _ = try applyUploadStatus(value, batchID: batchID, fileID: fileID, reservation: true)
    }
    private func sendUploadChunk(batchID: String, fileID: String, offset: Int, count: Int, serial: Int, captured: Scope) async throws {
        let index = try uploadCheck(batchID, serial: serial, captured: captured), file = uploadBatches[index].files.first(where: { $0.id == fileID })!
        guard let asset = file.assetID, let version = file.version, let token = captured.token,
              let url = URL(string: (origin.path == "/" ? "" : origin.path) + "/uploads/\(asset)/chunks?offset=\(offset)", relativeTo: origin)?.absoluteURL,
              url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port else { throw NativeAPIError.invalidResponse }
        let audienceFence = try await requireAudience(.photoProcessing, captured: captured)
        _ = try uploadCheck(batchID, serial: serial, captured: captured)
        let (chunk, hash) = try uploadFiles.chunk(file, batch: batchID, offset: offset, count: count)
        var request = URLRequest(url: url); request.httpMethod = "PUT"; request.timeoutInterval = 60; request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization"); request.setValue(file.mime, forHTTPHeaderField: "Content-Type")
        request.setValue(String(count), forHTTPHeaderField: "Content-Length"); request.setValue(hash, forHTTPHeaderField: "X-Lovelies-Chunk-SHA256")
        request.setValue("application/json", forHTTPHeaderField: "Accept"); request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        // The opaque task key is credential-free and stable over a restart.
        let taskKey = batchID + ":" + fileID + ":" + String(offset) + ":" + hash
        let reply: NativeHTTPReply
        do { reply = try await uploadTransport.send(request, file: chunk, taskKey: taskKey, limit: 2 * 1024 * 1024) }
        catch { _ = try uploadCheck(batchID, serial: serial, captured: captured); throw NativeAPIError.unavailable("upload_result_unconfirmed") }
        _ = try uploadCheck(batchID, serial: serial, captured: captured)
        guard (200..<300).contains(reply.status) else {
            let code = (try? WireValue.decoded(reply.data))?["error"]["code"].string ?? "http_\(reply.status)"
            if reply.status == 401 { clearSession() }
            throw NativeAPIError.denied(reply.status, code)
        }
        guard (reply.headers["content-type"] ?? "").lowercased().hasPrefix("application/json") else { throw NativeAPIError.invalidResponse }
        let value = try WireValue.decoded(reply.data)
        guard value["asset_id"].string == asset, value["version"].string == version, value["byte_size"].integer == file.byteSize,
              let received = value["bytes_received"].integer, received >= offset + count, received <= file.byteSize,
              ["uploading", "uploaded"].contains(value["status"].string ?? "") else { throw NativeAPIError.invalidResponse }
        try await recheckAudienceFence(audienceFence, captured: captured, purpose: .photoProcessing)
        let current = try uploadCheck(batchID, serial: serial, captured: captured), slot = uploadBatches[current].files.firstIndex(where: { $0.id == fileID })!
        uploadBatches[current].files[slot].acknowledgedBytes = received; uploadBatches[current].revise(); try saveUploadBatches()
        uploadFiles.removeChunk(chunk, batch: batchID)
    }
    private func completeResumablePhoto(batchID: String, fileID: String, serial: Int, captured: Scope) async throws {
        let index = try uploadCheck(batchID, serial: serial, captured: captured), slot = uploadBatches[index].files.firstIndex(where: { $0.id == fileID })!
        let file = uploadBatches[index].files[slot]; guard let asset = file.assetID, file.acknowledgedBytes == file.byteSize else { throw NativeAPIError.invalidResponse }
        if file.completeDispatched {
            let recovered = try await originalUploadOperation(file.completeKey, captured: captured)
            _ = try uploadCheck(batchID, serial: serial, captured: captured)
            if recovered["status"].string != "unknown" {
                guard recovered["asset_id"].string == asset, recovered["version"].string == file.version,
                      ["processing", "ready"].contains(recovered["status"].string ?? "") else { throw NativeAPIError.invalidResponse }
                // A cached processing acknowledgement is not current status.
                let current = try await uploadJSON("/uploads/\(asset)/status", captured: captured)
                _ = try uploadCheck(batchID, serial: serial, captured: captured)
                let status = try applyUploadStatus(current, batchID: batchID, fileID: fileID)
                if [.processing, .ready, .failed].contains(status.phase) { return }
                throw NativeAPIError.operationUnconfirmed(file.completeKey)
            }
        }
        uploadBatches[index].files[slot].completeDispatched = true; uploadBatches[index].files[slot].retryProcessingRequested = false; uploadBatches[index].files[slot].phase = .completing; uploadBatches[index].revise(); try saveUploadBatches()
        let value = try await uploadJSON("/uploads/\(asset)/complete", body: .object(["operation_key": .string(file.completeKey)]), captured: captured)
        _ = try uploadCheck(batchID, serial: serial, captured: captured)
        guard value["asset_id"].string == asset, value["version"].string == file.version,
              ["processing", "ready"].contains(value["status"].string ?? "") else { throw NativeAPIError.invalidResponse }
        let current = try await uploadJSON("/uploads/\(asset)/status", captured: captured)
        _ = try uploadCheck(batchID, serial: serial, captured: captured); _ = try applyUploadStatus(current, batchID: batchID, fileID: fileID)
    }
    func resumePhotoUpload(batchID: String, maximumChunks: Int? = nil, progress: (@Sendable (NativeUploadSummary) async -> Void)? = nil) async throws -> NativeUploadSummary {
        // A previous logout/pause cancellation must finish before a newer task
        // for this same batch can be admitted to either platform transport.
        await uploadRetirement?.value; try Task.checkCancellation()
        let captured = try await readyScope(), index = try uploadIndex(batchID)
        guard !uploadBusy, !uploadBatches[index].cancellationRequested, !uploadBatches[index].selectedFiles.isEmpty,
              maximumChunks == nil || maximumChunks! > 0 else { throw NativeAPIError.invalidResponse }
        guard pending().isEmpty else { throw NativeAPIError.operationUnconfirmed(pending()[0].key) }
        uploadSerial += 1; let serial = uploadSerial; uploadBusy = true
        uploadBatches[index].started = true; uploadBatches[index].paused = false
        for slot in uploadBatches[index].files.indices where uploadBatches[index].files[slot].selected && uploadBatches[index].files[slot].phase == .draft { uploadBatches[index].files[slot].phase = .queued }
        uploadBatches[index].revise(); try saveUploadBatches()
        defer { if serial == uploadSerial { uploadBusy = false } }
        var chunks = 0
        do {
            try await validateUploadDevice(uploadBatches[index], captured: captured)
            _ = try uploadCheck(batchID, serial: serial, captured: captured)
            let preferences = try await json("/me/photo-preferences", scope: captured)
            _ = try uploadCheck(batchID, serial: serial, captured: captured)
            guard preferences["processing_consent"].bool == true || preferences["processing_enabled"].bool == true else { throw NativeAPIError.denied(403, "processing_consent_required") }
            let ids = uploadBatches[index].selectedFiles.map(\.id)
            for id in ids {
                _ = try uploadCheck(batchID, serial: serial, captured: captured)
                try await reserveResumablePhoto(batchID: batchID, fileID: id, serial: serial, captured: captured)
                if let progress, let summary = try uploadSummary(batchID: batchID) { await progress(summary) }
                while true {
                    let current = try uploadCheck(batchID, serial: serial, captured: captured), file = uploadBatches[current].files.first(where: { $0.id == id })!
                    guard let asset = file.assetID else { throw NativeAPIError.invalidResponse }
                    let value = try await uploadJSON("/uploads/\(asset)/status", captured: captured)
                    _ = try uploadCheck(batchID, serial: serial, captured: captured)
                    let status = try applyUploadStatus(value, batchID: batchID, fileID: id)
                    if let progress, let summary = try uploadSummary(batchID: batchID) { await progress(summary) }
                    if [.processing, .ready, .cancelled].contains(status.phase) { break }
                    if status.phase == .failed {
                        if file.retryProcessingRequested && file.acknowledgedBytes == file.byteSize && file.processingAttemptID != nil {
                            try await completeResumablePhoto(batchID: batchID, fileID: id, serial: serial, captured: captured); break
                        }
                        throw NativeAPIError.unsupported(String(localized: "This photo failed on the server. Check its status and choose Retry for that photo."))
                    }
                    if status.phase == .completing { try await completeResumablePhoto(batchID: batchID, fileID: id, serial: serial, captured: captured); break }
                    guard status.expiresAt > Date() else { throw NativeAPIError.denied(409, "upload_expired") }
                    let offset = status.bytesReceived == file.byteSize ? ((file.byteSize - 1) / status.maximumChunkBytes) * status.maximumChunkBytes : status.bytesReceived
                    let count = min(status.maximumChunkBytes, file.byteSize - offset)
                    try await sendUploadChunk(batchID: batchID, fileID: id, offset: offset, count: count, serial: serial, captured: captured)
                    chunks += 1
                    if let progress, let summary = try uploadSummary(batchID: batchID) { await progress(summary) }
                    if let maximumChunks, chunks >= maximumChunks {
                        let final = try uploadCheck(batchID, serial: serial, captured: captured); uploadBatches[final].paused = true; uploadBatches[final].revise(); try saveUploadBatches()
                        return try uploadSummary(batchID: batchID)!
                    }
                }
            }
            let final = try uploadCheck(batchID, serial: serial, captured: captured); uploadBatches[final].paused = true; uploadBatches[final].revise(); try saveUploadBatches()
            return try uploadSummary(batchID: batchID)!
        } catch {
            if serial == uploadSerial, let index = uploadBatches.firstIndex(where: { $0.id == batchID }) {
                uploadBatches[index].paused = true; uploadBatches[index].revise(); try? saveUploadBatches()
            }
            throw error
        }
    }
    func checkPhotoUpload(batchID: String) async throws -> NativeUploadSummary {
        let captured = try await readyScope(), index = try uploadIndex(batchID)
        guard !uploadBusy else { return try uploadSummary(batchID: batchID)! }
        try await validateUploadDevice(uploadBatches[index], captured: captured)
        let files = uploadBatches[index].selectedFiles
        for file in files {
            try check(captured)
            if file.assetID == nil, file.reserveDispatched {
                let value = try await originalUploadOperation(file.reserveKey, captured: captured); try check(captured)
                if value["status"].string != "unknown" { _ = try applyUploadStatus(value, batchID: batchID, fileID: file.id, reservation: true) }
            }
            let current = try uploadIndex(batchID), latest = uploadBatches[current].files.first(where: { $0.id == file.id })!
            if let asset = latest.assetID {
                let value = try await uploadJSON("/uploads/\(asset)/status", captured: captured); try check(captured)
                _ = try applyUploadStatus(value, batchID: batchID, fileID: file.id)
            }
        }
        return try uploadSummary(batchID: batchID)!
    }
    func retryPhotoProcessing(batchID: String, fileID: String) async throws -> NativeUploadSummary {
        let current = try await checkPhotoUpload(batchID: batchID), index = try uploadIndex(batchID)
        guard !uploadBusy, let slot = current.batch.files.firstIndex(where: { $0.id == fileID }),
              current.batch.files[slot].phase == .failed, current.batch.files[slot].received else { throw NativeAPIError.invalidResponse }
        // Only authoritative terminal processing failure permits a new attempt.
        // Ambiguous reservation, chunk or completion keeps its original keys.
        uploadBatches[index].files[slot].completeKey = UUID().uuidString.lowercased(); uploadBatches[index].files[slot].completeDispatched = false
        uploadBatches[index].files[slot].phase = .completing; uploadBatches[index].files[slot].errorCode = nil; uploadBatches[index].files[slot].retryProcessingRequested = true
        uploadBatches[index].revise(); try saveUploadBatches()
        return try await resumePhotoUpload(batchID: batchID)
    }
    func cancelPhotoUpload(batchID: String) async throws -> NativeUploadSummary {
        let initial = try uploadIndex(batchID)
        uploadBatches[initial].cancellationRequested = true; uploadBatches[initial].revise(); try saveUploadBatches()
        _ = try await pausePhotoUpload(batchID: batchID)
        let captured = try await readyScope(), index = try uploadIndex(batchID)
        try await validateUploadDevice(uploadBatches[index], captured: captured)
        for id in uploadBatches[index].selectedFiles.map(\.id) {
            let current = try uploadIndex(batchID), slot = uploadBatches[current].files.firstIndex(where: { $0.id == id })!, file = uploadBatches[current].files[slot]
            try check(captured)
            if file.assetID == nil {
                if file.reserveDispatched {
                    let result = try await originalUploadOperation(file.reserveKey, captured: captured); try check(captured)
                    if result["status"].string != "unknown" { _ = try applyUploadStatus(result, batchID: batchID, fileID: id, reservation: true) }
                    else {
                        // An unknown original reserve may still be in flight.
                        // Resolve by replaying its exact operation, then cancel.
                        let batch = uploadBatches[current]
                        let payload: WireValue = .object(["operation_key": .string(file.reserveKey), "source": .string("personal"), "upload_batch_id": .string(batch.id), "byte_size": .integer(file.byteSize), "content_type": .string(file.mime), "title": .string(batch.caption.isEmpty ? file.title : batch.caption), "resumable": .bool(true), "checksum_sha256": .string(file.sha256)])
                        let reserved = try await uploadJSON("/uploads/session", body: payload, captured: captured); try check(captured)
                        _ = try applyUploadStatus(reserved, batchID: batchID, fileID: id, reservation: true)
                    }
                } else {
                    uploadBatches[current].files[slot].phase = .cancelled; uploadBatches[current].revise(); try saveUploadBatches(); uploadFiles.remove(file, batch: batchID); continue
                }
            }
            let updated = try uploadIndex(batchID), bound = uploadBatches[updated].files[slot], asset = bound.assetID!
            let state = try await uploadJSON("/uploads/\(asset)/status", captured: captured); try check(captured)
            let status = try applyUploadStatus(state, batchID: batchID, fileID: id)
            if [.processing, .ready].contains(status.phase) { continue }
            if status.phase == .failed {
                let terminal = uploadBatches[updated].files[slot]
                if terminal.processingAttemptID == nil {
                    // A definitive rejected source cannot become processing.
                    // Explicit cancellation retires only its local staging and
                    // selection hold; server failure identity/error stay intact.
                    uploadBatches[updated].files[slot].discardedTerminalTransfer = true
                    uploadBatches[updated].revise(); try saveUploadBatches()
                    uploadFiles.remove(terminal, batch: batchID)
                }
                continue
            }
            if status.phase != .cancelled {
                if bound.cancelDispatched {
                    let result = try await originalUploadOperation(bound.cancelKey, captured: captured); try check(captured)
                    if result["status"].string != "unknown" { guard result["asset_id"].string == asset, result["status"].string == "cancelled" else { throw NativeAPIError.invalidResponse } }
                    else { _ = try await uploadJSON("/uploads/\(asset)/cancel", body: .object(["operation_key": .string(bound.cancelKey)]), captured: captured) }
                } else {
                    uploadBatches[updated].files[slot].cancelDispatched = true; uploadBatches[updated].files[slot].phase = .cancelling; uploadBatches[updated].revise(); try saveUploadBatches()
                    _ = try await uploadJSON("/uploads/\(asset)/cancel", body: .object(["operation_key": .string(bound.cancelKey)]), captured: captured)
                }
                try check(captured)
                let final = try await uploadJSON("/uploads/\(asset)/status", captured: captured); try check(captured)
                guard try applyUploadStatus(final, batchID: batchID, fileID: id).phase == .cancelled else { throw NativeAPIError.invalidResponse }
            }
            uploadFiles.remove(bound, batch: batchID)
        }
        return try uploadSummary(batchID: batchID)!
    }
}


extension BackendRepository {
    private static let applePurchaseSlot = "store-apple-journal-v1"
    private func applePurchaseJournal() throws -> (NativeApplePurchaseJournal, Data?) {
        let bytes = try secrets.read(Self.applePurchaseSlot)
        guard (bytes?.count ?? 0) <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        var value = try bytes.map { try JSONDecoder().decode(NativeApplePurchaseJournal.self, from: $0) } ?? NativeApplePurchaseJournal(apiOrigin: origin.absoluteString)
        try value.validate(origin: origin)
        for uncertain in applePurchaseUncertainRecords {
            if let index = value.records.firstIndex(where: { $0.operationKey == uncertain.operationKey }) {
                value.records[index] = try value.records[index].retaining(uncertain)
            } else { value.records.append(uncertain) }
        }
        try value.validate(origin: origin); return (value, bytes)
    }
    private func saveApplePurchases(_ value: NativeApplePurchaseJournal, replacing bytes: Data?) throws {
        try value.validate(origin: origin)
        let encoded = try JSONEncoder().encode(value)
        guard encoded.count <= 2 * 1024 * 1024 else { throw NativeAPIError.unavailable("store_operation_storage_changed") }
        let before = try bytes.map { try JSONDecoder().decode(NativeApplePurchaseJournal.self, from: $0) }
        var held = applePurchaseUncertainRecords
        for record in value.records where before?.records.first(where: { $0.operationKey == record.operationKey }) != record {
            if let index = held.firstIndex(where: { $0.operationKey == record.operationKey }) { held[index] = try held[index].retaining(record) }
            else { held.append(record) }
        }
        // Retain stronger observations before attempting storage. A lost write
        // acknowledgment cannot admit a replacement or erase receipt evidence.
        applePurchaseUncertainRecords = held
        guard try secrets.compareAndSwap(Self.applePurchaseSlot, expected: bytes, replacement: encoded) else { throw NativeAPIError.unavailable("store_operation_storage_changed") }
        applePurchaseUncertainRecords = []
    }
    /// Old generic store intents were already potentially dispatched. Import
    /// their original key and input solely for typed receipt reconciliation.
    /// Parsing an old JWS here is binding metadata, never signature acceptance.
    private func migrateLegacyApplePurchases() throws {
        guard let bytes = try secrets.read("operation-intents") else { return }
        var old = try JSONDecoder().decode([NativeOperationIntent].self, from: bytes)
        let legacy = old.filter { $0.action == "store.apple" || $0.path == "/subscriptions/apple/transactions" }
        guard !legacy.isEmpty else { return }
        var (journal, saved) = try applePurchaseJournal()
        for intent in legacy {
            guard intent.action == "store.apple", intent.path == "/subscriptions/apple/transactions", intent.method == "POST",
                  intent.payload["operation_key"].string == intent.key, let jws = intent.payload["signed_transaction"].string,
                  jws.utf8.count <= 32768, let product = intent.payload["product_id"].string else { throw NativeAPIError.invalidResponse }
            let parts = jws.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 3, let payload = Data(base64URL: String(parts[1])) else { throw NativeAPIError.invalidResponse }
            let claims = try WireValue.decoded(payload)
            guard claims["appAccountToken"].string?.lowercased() == intent.accountID, claims["productId"].string == product,
                  let transaction = claims["transactionId"].string, let original = claims["originalTransactionId"].string,
                  let environment = claims["environment"].string?.lowercased() else { throw NativeAPIError.invalidResponse }
            let record = try NativeApplePurchaseRecord(account: intent.accountID, product: product, transaction: transaction, original: original,
                environment: environment, signedTransaction: jws, operation: intent.key)
            if let existing = journal.records.first(where: { $0.operationKey == record.operationKey }) {
                guard existing.accountID == record.accountID, existing.credentialSHA256 == record.credentialSHA256 else { throw NativeAPIError.invalidResponse }
            } else { journal.records.append(record) }
        }
        try saveApplePurchases(journal, replacing: saved)
        old.removeAll { value in legacy.contains(where: { $0.key == value.key }) }
        guard try secrets.compareAndSwap("operation-intents", expected: bytes, replacement: old.isEmpty ? nil : JSONEncoder().encode(old)) else { throw NativeAPIError.sessionChanged }
        intents.removeAll { value in legacy.contains(where: { $0.key == value.key }) }
    }
    private func migrateCompleteApplePurchase(account: String, transaction: String) throws {
        let slot = "store-apple-" + NativeAppleStoreJournal.digest(Data((origin.absoluteString + "|" + account + "|" + transaction).utf8))
        guard let originalBytes = try secrets.read(slot) else { return }
        guard originalBytes.count <= 64000 else { throw NativeAPIError.invalidResponse }
        let original = try JSONDecoder().decode(NativeAppleStoreJournal.self, from: originalBytes)
        try original.validate(origin: origin)
        guard original.slot == slot, original.accountID == account, original.transactionID == transaction else { throw NativeAPIError.invalidResponse }
        var (journal, bytes) = try applePurchaseJournal()
        let existingIndex = journal.records.firstIndex(where: { $0.operationKey == original.operationKey })
        var record = try NativeApplePurchaseRecord(account: original.accountID, product: original.productID,
            transaction: original.transactionID, original: original.originalTransactionID, environment: original.environment,
            signedTransaction: original.signedTransaction, operation: original.operationKey,
            createdAt: existingIndex.map { journal.records[$0].createdAt } ?? original.preparedAt)
        if let receipt = original.receipt {
            guard try record.result(from: receipt) != nil else { throw NativeAPIError.invalidResponse }
            record.receipt = receipt; record.phase = original.phase == .finished ? .finishObserved : .providerConfirmed
            record.signedTransaction = nil
        }
        if let result = original.directResult { record.directResultSHA256 = NativeApplePurchaseRecord.hash(try result.canonical()) }
        try record.validate()
        if let index = existingIndex { journal.records[index] = try journal.records[index].retaining(record) }
        else { journal.records.append(record) }
        try saveApplePurchases(journal, replacing: bytes)
        // The bounded roster now durably contains the strongest exact evidence.
        // Remove only the copied old bytes so terminal credential erasure cannot
        // leave an authorizing JWS stranded in the preceding per-transaction slot.
        // A lost removal acknowledgement safely repeats this merge on restart.
        guard try secrets.compareAndSwap(slot, expected: originalBytes, replacement: nil) else { throw NativeAPIError.sessionChanged }
    }
    func reserveApplePurchase(product: String) async throws -> NativeApplePurchaseReservation {
        let captured = try await readyScope(); _ = try await json("/me", scope: captured); try check(captured)
        try migrateLegacyApplePurchases()
        var (journal, bytes) = try applePurchaseJournal()
        let unresolvedTerminal = journal.records.contains { ended in
            guard ended.accountID == captured.account, ended.productID == product, ended.phase == .recoveredWithoutResult,
                  let latest = journal.records.last(where: { $0.accountID == ended.accountID && $0.productID == ended.productID && $0.transactionID == ended.transactionID && $0.environment == ended.environment }) else { return false }
            return ![.providerConfirmed, .finishObserved, .entitlementRefresh, .complete].contains(latest.phase) || latest.receipt == nil
        }
        guard !unresolvedTerminal else {
            throw NativeAPIError.denied(409, "operation_recovered_without_result")
        }
        if let held = journal.reservations.first(where: { $0.accountID == captured.account && $0.productID == product }) { return held }
        // Never evict an unresolved purchase to open another payment sheet.
        while journal.records.count + journal.reservations.count >= 64,
              let index = journal.disposableRecordIndex { journal.records.remove(at: index) }
        guard journal.records.count + journal.reservations.count < 64,
              (try JSONEncoder().encode(journal)).count < 2 * 1024 * 1024 - 48 * 1024 else { throw NativeAPIError.unavailable("store_recovery_capacity_full") }
        let reservation = NativeApplePurchaseReservation(accountID: captured.account!, productID: product, id: UUID().uuidString.lowercased())
        journal.reservations.append(reservation); try saveApplePurchases(journal, replacing: bytes); return reservation
    }
    func releaseApplePurchaseReservation(_ reservation: NativeApplePurchaseReservation) throws {
        var (journal, bytes) = try applePurchaseJournal()
        journal.reservations.removeAll { $0.id == reservation.id && $0.accountID == reservation.accountID && $0.productID == reservation.productID }
        try saveApplePurchases(journal, replacing: bytes)
    }
    func verifyApplePurchase(account: String, product: String, transaction: String, original: String, environment: String, signedTransaction: String,
                             allowTerminalReplacement: Bool = false, expectedEpoch: Int? = nil) async throws -> NativeApplePurchaseRecord {
        let initiated = try await readyScope()
        guard initiated.account == account, expectedEpoch == nil || initiated.epoch == expectedEpoch else { throw NativeAPIError.sessionChanged }
        do { return try await verifyApplePurchaseAttempt(account: account, product: product, transaction: transaction, original: original, environment: environment, signedTransaction: signedTransaction, expectedScope: initiated) }
        catch NativeAPIError.denied(409, "operation_recovered_without_result") where allowTerminalReplacement {
            try check(initiated)
            guard let ended = try applePurchaseJournal().0.records.last(where: { $0.accountID == account && $0.productID == product && $0.transactionID == transaction && $0.environment == environment }),
                  ended.phase == .recoveredWithoutResult, ended.originalTransactionID == original else { throw NativeAPIError.sessionChanged }
            // StoreKit independently verified the same transaction identity. Its
            // refreshed JWS may differ; the old operation is already terminal.
            return try await verifyApplePurchaseAttempt(account: account, product: product, transaction: transaction, original: original, environment: environment,
                signedTransaction: signedTransaction, expectedScope: initiated, replacingTerminal: ended.operationKey)
        }
    }
    private func retireApplePurchaseWithoutResult(_ expected: NativeApplePurchaseRecord, captured: Scope, status: Int = 409, code: String = "operation_recovered_without_result") throws {
        try check(captured)
        var (journal, bytes) = try applePurchaseJournal()
        guard let index = journal.records.firstIndex(where: { $0.operationKey == expected.operationKey && $0.accountID == captured.account }),
              journal.records[index].credentialSHA256 == expected.credentialSHA256,
              [.pending, .recoveredWithoutResult].contains(journal.records[index].phase), journal.records[index].receipt == nil,
              journal.records[index].directResultSHA256 == nil else { throw NativeAPIError.invalidResponse }
        try retainTerminal(NativeOperationRetirementRecord(origin: origin, account: expected.accountID, key: expected.operationKey, action: "store.apple",
            path: "/subscriptions/apple/transactions", method: "POST", inputSHA256: expected.legacyInputHash, sourceStatus: status, sourceCode: code))
        journal.records[index].phase = .recoveredWithoutResult; journal.records[index].signedTransaction = nil
        try saveApplePurchases(journal, replacing: bytes)
    }
    private func verifyApplePurchaseAttempt(account: String, product: String, transaction: String, original: String, environment: String, signedTransaction: String,
                                            expectedScope: Scope, replacingTerminal: String? = nil) async throws -> NativeApplePurchaseRecord {
        let captured = try await readyScope()
        try check(expectedScope)
        guard captured.account == account else { throw NativeAPIError.sessionChanged }
        try migrateLegacyApplePurchases()
        try migrateCompleteApplePurchase(account: account, transaction: transaction)
        var (journal, bytes) = try applePurchaseJournal()
        let proposed = try NativeApplePurchaseRecord(account: account, product: product, transaction: transaction, original: original, environment: environment, signedTransaction: signedTransaction)
        var firstDispatch = false
        let existing = journal.records.last(where: { $0.accountID == account && $0.productID == product && $0.transactionID == transaction && $0.environment == environment })
        if let replacingTerminal {
            guard existing?.operationKey == replacingTerminal, existing?.phase == .recoveredWithoutResult,
                  existing?.originalTransactionID == original else { throw NativeAPIError.sessionChanged }
        }
        var record: NativeApplePurchaseRecord
        if let existing, replacingTerminal == nil {
            guard existing.originalTransactionID == original, existing.phase != .retired else { throw NativeAPIError.sessionChanged }
            record = existing
        } else {
            journal.reservations.removeAll { $0.accountID == account && $0.productID == product }
            while journal.records.count + journal.reservations.count >= 64,
                  let index = journal.disposableRecordIndex { journal.records.remove(at: index) }
            guard journal.records.count + journal.reservations.count < 64 else { throw NativeAPIError.unavailable("store_recovery_capacity_full") }
            journal.records.append(proposed)
            try saveApplePurchases(journal, replacing: bytes) // potentially-dispatched marker precedes the sole POST
            record = proposed; firstDispatch = true
        }
        guard applePurchaseBusy.insert(record.operationKey).inserted else { throw NativeAPIError.operationUnconfirmed(record.operationKey) }
        defer { applePurchaseBusy.remove(record.operationKey) }
        if record.phase == .recoveredWithoutResult {
            try retireApplePurchaseWithoutResult(record, captured: captured)
            throw NativeAPIError.denied(409, "operation_recovered_without_result")
        }
        var direct: WireValue?
        if firstDispatch {
            guard let payload = record.dispatchPayload else { throw NativeAPIError.invalidResponse }
            do { direct = try await json("/subscriptions/apple/transactions", method: "POST", body: payload, scope: captured) }
            catch NativeAPIError.denied(let status, let code) where NativeOperationRetirementRecord.isTerminal(status: status, code: code) {
                try retireApplePurchaseWithoutResult(record, captured: captured, status: status, code: code); throw NativeAPIError.denied(409, "operation_recovered_without_result")
            }
            catch { try check(captured); try Task.checkCancellation() /* Recovery below never resends the JWS. */ }
            if let direct {
                try check(captured); try record.validateResult(direct)
                var (observed, observedBytes) = try applePurchaseJournal()
                guard let index = observed.records.firstIndex(where: { $0.operationKey == record.operationKey && $0.accountID == captured.account }),
                      observed.records[index].phase == .pending else { throw NativeAPIError.invalidResponse }
                record.directResultSHA256 = NativeApplePurchaseRecord.hash(try direct.canonical())
                observed.records[index] = try observed.records[index].retaining(record)
                try saveApplePurchases(observed, replacing: observedBytes)
            }
        }
        let receipt: WireValue
        do { receipt = try await json("/me/store-operations", method: "POST", body: .object(["operation_key": .string(record.operationKey)]), scope: captured) }
        catch NativeAPIError.denied(let status, let code) where NativeOperationRetirementRecord.isTerminal(status: status, code: code) {
            try check(captured); guard direct == nil else { throw NativeAPIError.invalidResponse }
            try retireApplePurchaseWithoutResult(record, captured: captured, status: status, code: code); throw NativeAPIError.denied(409, "operation_recovered_without_result")
        }
        try check(captured)
        guard let confirmed = try record.result(from: receipt) else { throw NativeAPIError.operationUnconfirmed(record.operationKey) }
        if let direct { guard direct == confirmed else { throw NativeAPIError.invalidResponse } }
        if let prior = record.receipt { guard prior == receipt else { throw NativeAPIError.invalidResponse } }
        var (current, currentBytes) = try applePurchaseJournal()
        guard let index = current.records.firstIndex(where: { $0.operationKey == record.operationKey && $0.accountID == account }),
              ![.retired, .recoveredWithoutResult].contains(current.records[index].phase) else { throw NativeAPIError.sessionChanged }
        record = current.records[index]; record.receipt = receipt; record.signedTransaction = nil
        if record.phase == .pending { record.phase = .providerConfirmed }
        current.records[index] = record; try saveApplePurchases(current, replacing: currentBytes)
        return record
    }
    /// StoreKit finishing can complete while a scene/account is retiring. Save
    /// that historical observation in its original slot without granting any
    /// current account authority, making process death around finish repeatable.
    func applePurchaseFinishObserved(_ operation: String, account: String) throws {
        var (journal, bytes) = try applePurchaseJournal()
        guard let index = journal.records.firstIndex(where: { $0.operationKey == operation && $0.accountID == account }),
              [.providerConfirmed, .finishObserved, .entitlementRefresh, .complete].contains(journal.records[index].phase),
              let receipt = journal.records[index].receipt, try journal.records[index].result(from: receipt) != nil else { throw NativeAPIError.sessionChanged }
        if !journal.records[index].finished { journal.records[index].phase = .finishObserved; try saveApplePurchases(journal, replacing: bytes) }
    }
    func unfinishedApplePurchaseIDs(includeTerminal: Bool = false) async throws -> Set<String> {
        let captured = try await readyScope(); try migrateLegacyApplePurchases()
        return Set(try applePurchaseJournal().0.records.filter { $0.accountID == captured.account &&
            ([.pending, .providerConfirmed].contains($0.phase) || includeTerminal && $0.phase == .recoveredWithoutResult) }.map(\.transactionID))
    }
    func refreshedAppleEntitlements() async throws -> WireValue {
        let captured = try await readyScope()
        var (journal, bytes) = try applePurchaseJournal()
        for index in journal.records.indices where journal.records[index].accountID == captured.account && journal.records[index].phase == .finishObserved { journal.records[index].phase = .entitlementRefresh }
        try saveApplePurchases(journal, replacing: bytes)
        let value = try await json("/me/entitlements", scope: captured); try check(captured)
        var (current, currentBytes) = try applePurchaseJournal()
        for index in current.records.indices where current.records[index].accountID == captured.account && current.records[index].phase == .entitlementRefresh { current.records[index].phase = .complete }
        try saveApplePurchases(current, replacing: currentBytes); return value
    }
    private func retireApplePurchasesAfterDeletion(account: String) throws {
        var (journal, bytes) = try applePurchaseJournal()
        // Payment recovery identity remains minimized and non-dispatchable; no
        // signed receipt, entitlement or account credential survives deletion.
        for index in journal.records.indices where journal.records[index].accountID == account {
            journal.records[index].phase = .retired; journal.records[index].signedTransaction = nil; journal.records[index].receipt = nil; journal.records[index].directResultSHA256 = nil
        }
        journal.reservations.removeAll { $0.accountID == account }
        try saveApplePurchases(journal, replacing: bytes)
    }
}

extension BackendRepository {
    /// The Keychain slot is namespaced by current account. Restored selections
    /// are intent only; a fresh snapshot and preview still authorize sharing.
    func libraryState() async throws -> NativeLibraryState {
        let captured = try await readyScope()
        guard let data = try secrets.read("library-state-" + captured.account!) else { return NativeLibraryState(accountID: captured.account!) }
        let value = try JSONDecoder().decode(NativeLibraryState.self, from: data)
        guard value.accountID == captured.account, value.favoriteIDs.count <= 10000, value.query.utf16.count <= 200, ["all", "received", "contributions"].contains(value.source), value.category == nil || ["all", "portraits", "landscapes"].contains(value.category!) else { throw NativeAPIError.invalidResponse }
        return value
    }
    func saveLibraryState(_ value: NativeLibraryState) async throws {
        try Task.checkCancellation()
        let captured = try await readyScope()
        guard value.accountID == captured.account, value.favoriteIDs.count <= 10000, value.query.utf16.count <= 200, ["all", "received", "contributions"].contains(value.source), value.category == nil || ["all", "portraits", "landscapes"].contains(value.category!) else { throw NativeAPIError.sessionChanged }
        try secrets.write("library-state-" + captured.account!, data: JSONEncoder().encode(value))
    }
    func retainedPrivacyExportRequests() throws -> Set<String> {
        try pruneExportDeliveries()
        guard let credentials, let session = try? sessionID(credentials.access_token) else { return [] }
        return Set(try exportJournals(secrets.read("export-deliveries-v2")).filter {
            $0.apiOrigin == origin.absoluteString && $0.accountID == credentials.account_id && $0.sessionID == session
        }.map(\.requestID))
    }
    private func eraseDeletedAccountExports(_ account: String) throws {
        for row in try exportJournals(secrets.read("export-deliveries-v2")) where row.accountID == account {
            try retireExportFiles(account: account, session: row.sessionID)
        }
    }
    private func sessionID(_ token: String) throws -> String {
        let parts = token.split(separator: ".")
        guard parts.count == 3, let bytes = Data(base64URL: String(parts[1])) else { throw NativeAPIError.invalidResponse }
        // JWT claims bind the local handoff; all requests still require the
        // server's live session authorization. They are not local authority.
        return try WireValue.decoded(bytes).uuid("jti")
    }
    private func exportJournals(_ bytes: Data?) throws -> [NativeExportDeliveryJournal] {
        guard let bytes else { return [] }
        guard bytes.count <= 256 * 1024 else { throw NativeAPIError.invalidResponse }
        let rows = try JSONDecoder().decode([NativeExportDeliveryJournal].self, from: bytes)
        guard rows.count <= 32, Set(rows.map(\.operationKey)).count == rows.count, Set(rows.map(\.fileID)).count == rows.count else { throw NativeAPIError.invalidResponse }
        for row in rows {
            guard let ownOrigin = URL(string: row.apiOrigin), ownOrigin.host != nil else { throw NativeAPIError.invalidResponse }
            try row.validate(origin: ownOrigin)
        }
        return rows
    }
    private func saveExportJournal(_ next: NativeExportDeliveryJournal, expected: NativeExportDeliveryJournal?) throws {
        try next.validate(origin: origin)
        for _ in 0..<8 {
            let bytes = try secrets.read("export-deliveries-v2")
            var rows = try exportJournals(bytes)
            if let index = rows.firstIndex(where: { $0.operationKey == next.operationKey }) {
                guard rows[index] == expected else { throw NativeAPIError.operationUnconfirmed(next.operationKey) }; rows[index] = next
            } else {
                guard expected == nil, rows.count < 32 else { throw NativeAPIError.operationUnconfirmed(next.operationKey) }
                if let existing = rows.first(where: { $0.apiOrigin == next.apiOrigin && $0.accountID == next.accountID && $0.sessionID == next.sessionID && $0.requestID == next.requestID }) {
                    throw NativeAPIError.operationUnconfirmed(existing.operationKey)
                }
                rows.append(next)
            }
            if try secrets.compareAndSwap("export-deliveries-v2", expected: bytes, replacement: JSONEncoder().encode(rows)) { return }
        }
        throw NativeAPIError.unavailable("export_storage_changed")
    }
    private func pruneExportDeliveries() throws {
        let bytes = try secrets.read("export-deliveries-v2"), now = Date()
        let rows = try exportJournals(bytes)
        var retained: [NativeExportDeliveryJournal] = []
        for row in rows {
            let expiry = try row.delivery.map { try NativeRefreshDeliveryRecord.date($0["expires_at"]) } ?? row.preparedAt.addingTimeInterval(86400)
            if expiry <= now { try removeExportFiles(row) } else { retained.append(row) }
        }
        if retained.count != rows.count { _ = try secrets.compareAndSwap("export-deliveries-v2", expected: bytes, replacement: JSONEncoder().encode(retained)) }
    }
    private func retireExportFiles(account: String, session: String) throws {
        for row in try exportJournals(secrets.read("export-deliveries-v2")) where row.apiOrigin == origin.absoluteString && row.accountID == account && row.sessionID == session {
            exportExpiryTasks.removeValue(forKey: row.operationKey)?.cancel()
            try removeExportFiles(row)
        }
    }
    private func scheduleExportExpiry(_ journal: NativeExportDeliveryJournal, expiresAt: Date) {
        exportExpiryTasks[journal.operationKey]?.cancel()
        exportExpiryTasks[journal.operationKey] = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(max(0, expiresAt.timeIntervalSinceNow)))
                guard !Task.isCancelled, let self else { return }
                await self.expireExportFile(journal)
            } catch {}
        }
    }
    private func expireExportFile(_ journal: NativeExportDeliveryJournal) {
        // The file ID is immutable per delivery. A later session or delivery
        // owns a different ID and cannot be removed by this old expiry task.
        try? removeExportFiles(journal)
        exportExpiryTasks.removeValue(forKey: journal.operationKey)
    }
    private func cachedExportPage(_ journal: NativeExportDeliveryJournal, offset: Int, previous: String) throws -> NativeExportManifestPage {
        guard let delivery = journal.delivery,
              let data = try exportFiles.read(journal.childFileID(kind: "manifest", index: offset), maximum: 512 * 1024) else {
            throw NativeAPIError.unavailable("export_staged_copy_unavailable")
        }
        return try NativeExportManifestPage(WireValue.decoded(data), delivery: delivery, offset: offset, previous: previous)
    }
    private func pumpExportChunks(_ journal: NativeExportDeliveryJournal, current: () throws -> Void,
                                  sink: (Data) throws -> Void) throws {
        guard let delivery = journal.delivery, let count = delivery["chunk_count"].integer, let total = delivery["bytes"].integer else { throw NativeAPIError.invalidResponse }
        var offset = 0, root = try NativeExportManifestPage.seed(delivery), bytes = 0, digest = SHA256()
        while offset < count {
            try current()
            let page = try cachedExportPage(journal, offset: offset, previous: root)
            for chunk in page.chunks {
                try current()
                guard let data = try exportFiles.read(journal.childFileID(kind: "chunk", index: chunk.index), maximum: NativeExportManifestPage.chunkBytes) else {
                    throw NativeAPIError.unavailable("export_staged_copy_unavailable")
                }
                try chunk.validate(data)
                guard bytes <= total - data.count else { throw NativeAPIError.invalidResponse }
                digest.update(data: data); bytes += data.count
                try current(); try sink(data); try current()
            }
            root = page.chunks.last!.root; offset = page.next ?? count
        }
        guard bytes == total, root == delivery["manifest_sha256"].string,
              digest.finalize().map({ String(format: "%02x", $0) }).joined() == delivery["sha256"].string else { throw NativeAPIError.invalidResponse }
        try current()
    }
    private func removeExportFiles(_ journal: NativeExportDeliveryJournal) throws {
        guard let delivery = journal.delivery else { return }
        if !journal.chunked {
            if let data = try exportFiles.read(journal.fileID) { try journal.validateBytes(data); try exportFiles.remove(journal.fileID) }
            return
        }
        guard let count = delivery["chunk_count"].integer, let total = delivery["bytes"].integer else { throw NativeAPIError.invalidResponse }
        // A crash may leave a verified prefix of the assembled file. Match it
        // against the independently verified chunks before removing it.
        if try !exportFiles.removeVerifiedComplete(journal.fileID, bytes: total, hash: delivery.text("sha256")) {
            try exportFiles.removeValidatedPrefix(journal.fileID, maximum: total) { sink in
                try pumpExportChunks(journal, current: {}, sink: sink)
            }
        }
        var offset = 0, root = try NativeExportManifestPage.seed(delivery), lastManifest: Int?
        while offset < count {
            let id = try journal.childFileID(kind: "manifest", index: offset)
            guard let bytes = try exportFiles.read(id, maximum: 512 * 1024) else { break }
            let page = try NativeExportManifestPage(WireValue.decoded(bytes), delivery: delivery, offset: offset, previous: root)
            for chunk in page.chunks {
                let chunkID = try journal.childFileID(kind: "chunk", index: chunk.index)
                if let data = try exportFiles.read(chunkID, maximum: NativeExportManifestPage.chunkBytes) { try chunk.validate(data); try exportFiles.remove(chunkID) }
            }
            lastManifest = offset; root = page.chunks.last!.root; offset = page.next ?? count
        }
        // Keep every descriptor until all its chunks are gone, then retire
        // pages from the end. Interrupted cleanup retains a verifiable prefix.
        while let offset = lastManifest {
            try exportFiles.remove(journal.childFileID(kind: "manifest", index: offset))
            lastManifest = offset == 0 ? nil : offset - NativeExportManifestPage.pageSize
        }
    }
    /// The live app receives a protected file URL, never a full in-memory large
    /// export. Its lease is bounded by both this delivery and the current session.
    func exportFile(requestID: String) async throws -> (file: URL, expiresAt: Date) {
        guard UUID(uuidString: requestID) != nil else { throw NativeAPIError.invalidResponse }
        let captured = try await readyScope(anonymous: true), session = try sessionID(captured.token!)
        try pruneExportDeliveries()
        let rows = try exportJournals(secrets.read("export-deliveries-v2"))
        var held: NativeExportDeliveryJournal
        if let existing = rows.first(where: { $0.apiOrigin == origin.absoluteString && $0.accountID == captured.account && $0.sessionID == session && $0.requestID == requestID }) { held = existing }
        else {
            held = NativeExportDeliveryJournal(origin: origin, account: captured.account!, session: session, request: requestID)
            try saveExportJournal(held, expected: nil)
        }
        guard exportWork.insert(held.operationKey).inserted else { throw NativeAPIError.operationUnconfirmed(held.operationKey) }
        defer { exportWork.remove(held.operationKey) }
        func persist(_ next: NativeExportDeliveryJournal) throws {
            try check(captured); try Task.checkCancellation(); try saveExportJournal(next, expected: held); held = next
        }
        // Creation/recovery is an exact-key exchange. No export capability is
        // carried in a URL, and its journal never occupies generic editing state.
        let delivery = try await json("/privacy-exports/\(requestID)/deliveries", method: "POST",
            body: .object(["operation_key": .string(held.operationKey)]), scope: captured)
        try check(captured); try held.validateDelivery(delivery)
        var next = held; next.delivery = delivery; try persist(next); try held.requireLive()
        let expiry = min(try NativeRefreshDeliveryRecord.date(delivery["expires_at"]), credentials?.expiresAt ?? .distantPast)
        guard expiry > Date() else { throw NativeAPIError.sessionChanged }
        scheduleExportExpiry(held, expiresAt: expiry)
        func current() throws {
            try check(captured); try Task.checkCancellation(); try held.requireLive()
            guard expiry > Date() else { throw NativeAPIError.sessionChanged }
        }
        let file: URL
        if held.chunked {
            let count = delivery["chunk_count"].integer!
            var offset = 0, root = try NativeExportManifestPage.seed(delivery)
            let deliveryID = try delivery.uuid("delivery_id")
            while offset < count {
                try current()
                let pageID = try held.childFileID(kind: "manifest", index: offset)
                if try exportFiles.read(pageID, maximum: 512 * 1024) == nil {
                    guard delivery["state"].string == "available", !held.staged, !held.acknowledged else { throw NativeAPIError.unavailable("export_staged_copy_unavailable") }
                    let value = try await json("/privacy-exports/deliveries/\(deliveryID)/manifest?offset=\(offset)", scope: captured)
                    _ = try NativeExportManifestPage(value, delivery: delivery, offset: offset, previous: root)
                    try current(); try exportFiles.stage(value.encoded(), id: pageID, maximum: 512 * 1024)
                }
                let page = try cachedExportPage(held, offset: offset, previous: root)
                for chunk in page.chunks {
                    try current()
                    let id = try held.childFileID(kind: "chunk", index: chunk.index)
                    if let data = try exportFiles.read(id, maximum: NativeExportManifestPage.chunkBytes) { try chunk.validate(data) }
                    else {
                        guard delivery["state"].string == "available", !held.staged, !held.acknowledged else { throw NativeAPIError.unavailable("export_staged_copy_unavailable") }
                        let reply = try await request(chunk.path, scope: captured, binary: true, responseLimit: NativeExportManifestPage.chunkBytes)
                        try current()
                        guard (reply.headers["content-type"] ?? "").lowercased().split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespaces) == "application/octet-stream" else { throw NativeAPIError.invalidResponse }
                        try chunk.validate(reply.data); try exportFiles.stage(reply.data, id: id, maximum: NativeExportManifestPage.chunkBytes)
                        guard let confirmed = try exportFiles.read(id, maximum: NativeExportManifestPage.chunkBytes) else { throw NativeAPIError.unavailable("export_staging_unconfirmed") }
                        try chunk.validate(confirmed)
                    }
                }
                root = page.chunks.last!.root; offset = page.next ?? count
            }
            file = try exportFiles.assemble(id: held.fileID, bytes: delivery["bytes"].integer!, hash: try delivery.text("sha256"), current: current) { sink in
                try pumpExportChunks(held, current: current, sink: sink)
            }
        } else if let staged = try exportFiles.read(held.fileID) {
            try held.validateBytes(staged)
            file = try exportFiles.verifiedURL(held.fileID, bytes: staged.count, hash: try delivery.text("sha256"), current: current)
        } else {
            guard delivery["state"].string == "available", !held.acknowledged else {
                throw NativeAPIError.unsupported(String(localized: "This export was already delivered and its local copy is unavailable. Request a new export from the privacy center."))
            }
            let reply = try await request(try delivery.text("retrieve_path"), scope: captured, binary: true)
            try check(captured); try Task.checkCancellation(); try held.requireLive()
            guard (reply.headers["content-type"] ?? "").lowercased().hasPrefix("application/json") else { throw NativeAPIError.invalidResponse }
            try held.validateBytes(reply.data)
            try exportFiles.stage(reply.data, id: held.fileID)
            file = try exportFiles.verifiedURL(held.fileID, bytes: reply.data.count, hash: try delivery.text("sha256"), current: current)
        }
        if !held.staged { next = held; next.staged = true; try persist(next) }
        if !held.acknowledged {
            let acknowledgement = try await json(try delivery.text("ack_path"), method: "POST",
                body: .object(["operation_key": .string(held.acknowledgementKey), "sha256": delivery["sha256"]]), scope: captured)
            try check(captured); try held.requireLive()
            guard Set(acknowledgement.object?.keys.map { $0 } ?? []) == ["acknowledged", "delivery_id", "request_id"],
                  acknowledgement["acknowledged"].bool == true, acknowledgement["delivery_id"] == delivery["delivery_id"],
                  acknowledgement["request_id"].string == requestID else { throw NativeAPIError.invalidResponse }
            next = held; next.acknowledged = true
            var acknowledgedDelivery = delivery.object!; acknowledgedDelivery["state"] = .string("acknowledged"); next.delivery = .object(acknowledgedDelivery)
            try persist(next)
        }
        try current()
        _ = try exportFiles.verifiedURL(held.fileID, bytes: delivery["bytes"].integer!, hash: try delivery.text("sha256"), current: current)
        return (file, expiry)
    }
    /// Bounded compatibility helper for controlled v2 consumers. The app uses
    /// exportFile so a large export cannot accidentally allocate a full Data.
    func exportBytes(requestID: String) async throws -> (bytes: Data, expiresAt: Date) {
        let result = try await exportFile(requestID: requestID)
        let values = try result.file.resourceValues(forKeys: [.fileSizeKey])
        guard let count = values.fileSize, (1...20 * 1024 * 1024).contains(count) else { throw NativeAPIError.invalidResponse }
        let bytes = try Data(contentsOf: result.file)
        guard bytes.count == count, result.expiresAt > Date() else { throw NativeAPIError.sessionChanged }
        return (bytes, result.expiresAt)
    }
}


extension BackendRepository {
    func registeredDeletionReceipt() throws -> NativeRegisteredDeletionRecord? {
        guard let data = try secrets.read("registered-deletion-receipt") else { return nil }
        guard data.count <= NativeRegisteredDeletionRecord.maximumEncodedBytes else { throw NativeAPIError.invalidResponse }
        let record = try JSONDecoder().decode(NativeRegisteredDeletionRecord.self, from: data)
        try record.validate(origin: origin); return record
    }
    func requestRegisteredDeletion(retry: Bool = false) async throws -> NativeRegisteredDeletionRecord {
        let captured = try await readyScope(anonymous: true)
        guard credentials?.authenticated == true else { throw NativeAPIError.authenticationRequired }
        var record: NativeRegisteredDeletionRecord
        if let existing = try registeredDeletionReceipt() {
            guard existing.accountID == captured.account else { throw NativeAPIError.sessionChanged }
            if !retry || existing.response != nil { return try await checkRegisteredDeletion() }
            record = existing
        } else {
            record = NativeRegisteredDeletionRecord(accountID: captured.account!, operationKey: UUID().uuidString.lowercased(), statusToken: try Self.deletionToken(), apiOrigin: origin.absoluteString, preparedAt: Date())
            try secrets.write("registered-deletion-receipt", data: JSONEncoder().encode(record))
        }
        let value = try await json("/privacy/account-deletion", method: "POST", body: record.payload, scope: captured)
        try check(captured); try record.validateResponse(value); record.response = value
        try saveRegisteredDeletion(record)
        if record.completed { return try await cleanupRegisteredDeletion(record) }; return record
    }
    func checkRegisteredDeletion() async throws -> NativeRegisteredDeletionRecord {
        guard var record = try registeredDeletionReceipt() else { throw NativeAPIError.invalidResponse }
        if record.completed { return try await cleanupRegisteredDeletion(record) }
        let value = try await json("/privacy/account-deletion/status", method: "POST", body: .object(["status_token": .string(record.statusToken)]), scope: Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation))
        try record.validateResponse(value); record.response = value
        try saveRegisteredDeletion(record)
        if record.completed { return try await cleanupRegisteredDeletion(record) }
        return record
    }
    func finishRegisteredDeletionReceipt() async throws -> NativeSessionSummary? {
        guard let record = try registeredDeletionReceipt(), record.completed else { throw NativeAPIError.unsupported(String(localized: "The server must confirm completed deletion before starting again.")) }
        let cleaned = try await cleanupRegisteredDeletion(record)
        guard cleaned.localCleanupComplete == true,
              let saved = try secrets.read("registered-deletion-receipt"),
              try JSONDecoder().decode(NativeRegisteredDeletionRecord.self, from: saved).operationKey == cleaned.operationKey,
              try secrets.compareAndSwap("registered-deletion-receipt", expected: saved, replacement: nil) else { throw NativeAPIError.sessionChanged }
        return try await bootstrap()
    }
    func continueRegisteredAccount() throws {
        guard let record = try registeredDeletionReceipt(), ["rejected", "cancelled"].contains(record.response?["privacy_request"]["status"].string ?? "") else { throw NativeAPIError.unsupported(String(localized: "Keep this receipt until the deletion request is resolved.")) }
        try secrets.write("registered-deletion-receipt", data: nil)
    }
    private func saveRegisteredDeletion(_ record: NativeRegisteredDeletionRecord) throws {
        try record.validate(origin: origin)
        guard let bytes = try secrets.read("registered-deletion-receipt"), bytes.count <= NativeRegisteredDeletionRecord.maximumEncodedBytes else { throw NativeAPIError.sessionChanged }
        let current = try JSONDecoder().decode(NativeRegisteredDeletionRecord.self, from: bytes)
        let encoded = try JSONEncoder().encode(record)
        guard current.operationKey == record.operationKey, current.accountID == record.accountID, current.statusToken == record.statusToken,
              !current.completed || record.completed, encoded.count <= NativeRegisteredDeletionRecord.maximumEncodedBytes,
              try secrets.compareAndSwap("registered-deletion-receipt", expected: bytes, replacement: encoded) else { throw NativeAPIError.sessionChanged }
    }
    /// Completed server erasure authorizes only this account's local retirement.
    /// Every removal is acknowledged; the receipt survives a failed write, a
    /// failed key/file deletion or process termination at any step.
    private func cleanupRegisteredDeletion(_ original: NativeRegisteredDeletionRecord) async throws -> NativeRegisteredDeletionRecord {
        try original.validate(origin: origin)
        guard original.completed else { throw NativeAPIError.invalidResponse }
        guard !registeredDeletionCleanupBusy else { throw NativeAPIError.unavailable("deletion_cleanup_in_progress") }
        registeredDeletionCleanupBusy = true; defer { registeredDeletionCleanupBusy = false }
        let account = original.accountID
        // Bootstrap deliberately stops at the deletion receipt, so the durable
        // credential may not yet be in memory. Retire that exact authority before
        // deleting its slot. The independent generation defeats a late write or
        // restoration of those bytes after a cleanup failure or process restart.
        // Credential writers share this custody gate; a newer foreign account
        // must neither be removed nor have its authority generation invalidated.
        try NativeIdentityCustody.withLock {
            let stored: NativeCredentials?
            if let bytes = try secrets.read("credentials") {
                guard bytes.count <= 16 * 1024 else { throw NativeAPIError.invalidResponse }
                stored = try JSONDecoder().decode(NativeCredentials.self, from: bytes)
            } else { stored = nil }
            let liveOwner = credentials?.account_id == account ? credentials : nil
            let storedOwner = stored?.account_id == account ? stored : nil
            let foreignLive = credentials != nil && liveOwner == nil
            let foreignStored = stored != nil && storedOwner == nil
            if liveOwner != nil { uploadSerial += 1; uploadBusy = false }
            if (liveOwner != nil || storedOwner != nil) && !foreignLive && !foreignStored {
                try retireForRestriction(storedOwner ?? liveOwner)
            } else if liveOwner != nil {
                epoch += 1; credentials = nil; audienceProjection = nil; audienceProjectionEpoch = nil
                transport.cancelPending(); retireMedia()
            }
            try recordCredentialRetirement(liveOwner)
            try recordCredentialRetirement(storedOwner)
            if let storedOwner { _ = try retireCredentialSlot(storedOwner) }
        }
        _ = try uploadBatchJournal() // Validate all durable upload owners before their retirement writes.
        try await retireDeletedAccountUploads(account)
        guard var record = try registeredDeletionReceipt(), record.operationKey == original.operationKey, record.completed else { throw NativeAPIError.sessionChanged }
        let decoder = JSONDecoder(), encoder = JSONEncoder()
        func read<T: Decodable>(_ name: String, _ type: T.Type) throws -> T? {
            guard let bytes = try secrets.read(name) else { return nil }
            guard bytes.count <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
            return try decoder.decode(type, from: bytes)
        }
        var references: [(account: String, alias: String, jwk: WireValue?)] = []
        for name in ["registered-device", "pending-face-device"] {
            if let value = try read(name, RegisteredDevice.self) { try validLocalDevice(value); references.append((value.accountID, value.keyAlias ?? NativeEnrollmentRecord.keyAlias, nil)) }
        }
        if let value = try read("face-enrollment-journal", NativeEnrollmentRecord.self) { try value.validate(origin: origin); references.append((value.accountID, value.keyAlias, value.publicJWK)) }
        if let value = try read("ordinary-face-login-journal", NativeOrdinaryLoginRecord.self) { try value.validate(origin: origin); references.append((value.originalDevice.accountID, value.keyAlias, value.publicJWK)) }
        if let value = try read("account-recovery-journal", NativeAccountRecoveryRecord.self) { try value.validate(origin: origin); references.append((value.accountID, value.keyAlias, value.publicJWK)); references += value.supersededAliases.map { (value.accountID, $0, nil) } }
        if let value = try read("face-profile-lifecycle", NativeFaceLifecycleRecord.self) { try value.validate(origin: origin); references.append((value.accountID, value.keyAlias, value.publicJWK)) }
        for value in try audienceDeviceRenewals().0 { references.append((value.accountID, value.keyAlias, nil)) }
        for value in try read("retired-account-recoveries", [NativeAccountRecoveryRecord].self) ?? [] { try value.validate(origin: origin); references.append((value.accountID, value.keyAlias, value.publicJWK)); references += value.supersededAliases.map { (value.accountID, $0, nil) } }
        for name in ["retired-face-profile-controls", "deleted-face-profile-controls"] {
            for value in try read(name, [NativeFaceLifecycleRecord].self) ?? [] { try value.validate(origin: origin); references.append((value.accountID, value.keyAlias, value.publicJWK)) }
        }
        // Lifecycle archives can retain recovery credentials as well as signing
        // aliases. Validate owner and payload together before collecting keys or
        // dropping any reference, including references belonging to other users.
        let archivedIdentities = try read("face-lifecycle-retired-identities", [WireValue].self) ?? []
        guard archivedIdentities.count <= 16 else { throw NativeAPIError.invalidResponse }
        for row in archivedIdentities {
            guard Set(row.object?.keys.map { $0 } ?? []) == ["kind", "accountID", "payload"],
                  let owner = row["accountID"].string, UUID(uuidString: owner) != nil,
                  row["payload"]["accountID"].string == owner else { throw NativeAPIError.invalidResponse }
            let payload = try row["payload"].encoded()
            switch row["kind"].string {
            case "face-enrollment-journal":
                let value = try decoder.decode(NativeEnrollmentRecord.self, from: payload); try value.validate(origin: origin)
                references.append((owner, value.keyAlias, value.publicJWK))
            case "account-recovery-journal":
                let value = try decoder.decode(NativeAccountRecoveryRecord.self, from: payload); try value.validate(origin: origin)
                references.append((owner, value.keyAlias, value.publicJWK)); references += value.supersededAliases.map { (owner, $0, nil) }
            case "recovery-key-backup":
                let value = try decoder.decode(NativeRecoveryKeyRecord.self, from: payload); try value.validate(origin: origin)
            default: throw NativeAPIError.invalidResponse
            }
        }
        var planned = record.cleanupKeys ?? []
        for reference in references where reference.account == account && !references.contains(where: { $0.alias == reference.alias && $0.account != account }) {
            if !planned.contains(where: { $0.alias == reference.alias }), try signer.keyExists(alias: reference.alias) {
                let current = try signer.publicJWK(alias: reference.alias, create: false)
                if let expected = reference.jwk, try expected.canonical() != current.canonical() { throw NativeAPIError.unavailable("deletion_key_binding_changed") }
                planned.append(.init(alias: reference.alias, publicJWK: current))
            }
        }
        record.cleanupKeys = planned; record.localCleanupComplete = false
        try saveRegisteredDeletion(record) // Key ownership survives erasing its journals.
        func removeOwned<T: Codable>(_ name: String, _ type: T.Type, accountOf: (T) -> String) throws {
            guard let bytes = try secrets.read(name) else { return }
            let value = try decoder.decode(type, from: bytes)
            if accountOf(value) == account {
                guard try secrets.compareAndSwap(name, expected: bytes, replacement: nil) else { throw NativeAPIError.sessionChanged }
            }
        }
        func filterOwned<T: Codable>(_ name: String, _ type: T.Type, accountOf: (T) -> String) throws {
            guard let bytes = try secrets.read(name) else { return }
            let values = try decoder.decode([T].self, from: bytes), kept = values.filter { accountOf($0) != account }
            if values.count != kept.count {
                guard try secrets.compareAndSwap(name, expected: bytes, replacement: kept.isEmpty ? nil : encoder.encode(kept)) else { throw NativeAPIError.sessionChanged }
            }
        }
        // Delete files before their durable roster. A crash can repeat removal;
        // it can never leave unowned staging bytes behind a completed receipt.
        let (batches, batchBytes) = try uploadBatchJournal()
        if let bytes = batchBytes {
            for batch in batches where batch.accountID == account {
                guard batch.paused, batch.backgroundRetryAllowed == false else { throw NativeAPIError.sessionChanged }
                try uploadFiles.removeBatchConfirmed(batch.id)
            }
            let kept = batches.filter { $0.accountID != account }
            guard try secrets.compareAndSwap("resumable-photo-batches-v1", expected: bytes, replacement: kept.isEmpty ? nil : encoder.encode(kept)) else { throw NativeAPIError.sessionChanged }
            uploadBatches = kept
        }
        try removeOwned("credentials", NativeCredentials.self) { $0.account_id }
        for name in ["registered-device", "pending-face-device"] { try removeOwned(name, RegisteredDevice.self) { $0.accountID } }
        try removeOwned("face-enrollment-journal", NativeEnrollmentRecord.self) { $0.accountID }
        try removeOwned("ordinary-face-login-journal", NativeOrdinaryLoginRecord.self) { $0.originalDevice.accountID }
        try removeOwned("account-recovery-journal", NativeAccountRecoveryRecord.self) { $0.accountID }
        try removeOwned("face-profile-lifecycle", NativeFaceLifecycleRecord.self) { $0.accountID }
        try removeOwned("recovery-key-backup", NativeRecoveryKeyRecord.self) { $0.accountID }
        try removeOwned(Self.refreshDeliverySlot, NativeRefreshDeliveryRecord.self) { $0.original.account_id }
        try removeOwned("audience-mutation-journal", NativeAudienceMutationRecord.self) { $0.accountID }
        try removeOwned("audience-suspended-authority", NativeAudienceSuspensionRecord.self) { $0.operation.accountID }
        try filterOwned("operation-intents", NativeOperationIntent.self) { $0.accountID }
        try filterOwned("operation-terminal-evidence", NativeOperationRetirementRecord.self) { $0.accountID }
        try filterOwned("upload-stages", NativeUploadRecord.self) { $0.accountID }
        try filterOwned("retired-account-recoveries", NativeAccountRecoveryRecord.self) { $0.accountID }
        try filterOwned("face-lifecycle-retired-identities", WireValue.self) { $0["accountID"].string ?? "" }
        for name in ["retired-face-profile-controls", "deleted-face-profile-controls"] { try filterOwned(name, NativeFaceLifecycleRecord.self) { $0.accountID } }
        try filterOwned("retired-refresh-deliveries-v1", NativeRefreshDeliveryRecord.self) { $0.original.account_id }
        try filterOwned("audience-operations-retired-after-deletion", NativeAudienceMutationRecord.self) { $0.accountID }
        try filterOwned("audience-device-renewals", NativeAudienceDeviceRenewalRecord.self) { $0.accountID }
        try retireApplePurchasesAfterDeletion(account: account)
        try eraseDeletedAccountExports(account)
        if let bytes = try secrets.read("guardian-bound-reference"), try WireValue.decoded(bytes)["account_id"].string == account {
            guard try secrets.compareAndSwap("guardian-bound-reference", expected: bytes, replacement: nil) else { throw NativeAPIError.sessionChanged }
        }
        let library = "library-state-" + account
        if let bytes = try secrets.read(library) { guard try secrets.compareAndSwap(library, expected: bytes, replacement: nil) else { throw NativeAPIError.sessionChanged } }
        for key in planned where !references.contains(where: { $0.alias == key.alias && $0.account != account }) {
            guard try signer.keyExists(alias: key.alias) else { continue }
            // Another key at a reused alias belongs to its newer lifecycle.
            if try signer.publicJWK(alias: key.alias, create: false).canonical() == key.publicJWK.canonical() { try signer.removeOwnedKey(alias: key.alias, publicJWK: key.publicJWK) }
        }
        if enrollment?.accountID == account { enrollment = nil; enrollmentSerial += 1; enrollmentBusy = false }
        if ordinaryLogin?.originalDevice.accountID == account { ordinaryLogin = nil }
        if accountRecovery?.accountID == account { accountRecovery = nil; recoverySerial += 1; recoveryBusy = false }
        if faceLifecycle?.accountID == account { faceLifecycle = nil; lifecycleSerial += 1; lifecycleBusy = false }
        if audienceSuspension?.operation.accountID == account { audienceSuspension = nil }
        intents.removeAll { $0.accountID == account }; uploads.removeAll { $0.accountID == account }
        recoveryArchives.removeAll { $0.accountID == account }; lifecycleArchives.removeAll { $0.accountID == account }
        record.cleanupKeys = []; record.localCleanupComplete = true
        try saveRegisteredDeletion(record); return record
    }
}


extension BackendRepository {
    // This allow-list permits safety/privacy work under a current durable session
    // even when an audience hold blocks all product work. It grants no backend authority.
    private func audienceDeviceOwner(_ captured: Scope) throws -> RegisteredDevice {
        try check(captured)
        guard guestDeletion == nil, try registeredDeletionReceipt() == nil,
              let bytes = try secrets.read("registered-device"), bytes.count <= 32 * 1024 else { throw NativeAPIError.authenticationRequired }
        let owner = try JSONDecoder().decode(RegisteredDevice.self, from: bytes); try validLocalDevice(owner)
        guard credentials == nil || credentials?.account_id == owner.accountID,
              [enrollment?.accountID, accountRecovery?.accountID, faceLifecycle?.accountID].compactMap({ $0 }).allSatisfy({ $0 == owner.accountID }) else { throw NativeAPIError.sessionChanged }
        return owner
    }
    private func checkAudienceDevice(_ owner: RegisteredDevice, captured: Scope) throws {
        let current = try audienceDeviceOwner(captured)
        guard try localEncodedDigest(current) == localEncodedDigest(owner) else { throw NativeAPIError.sessionChanged }
    }
    private func audienceDeviceRenewals() throws -> ([NativeAudienceDeviceRenewalRecord], Data?) {
        guard let bytes = try secrets.read("audience-device-renewals") else { return ([], nil) }
        guard bytes.count <= 256 * 1024 else { throw NativeAPIError.invalidResponse }
        let rows = try JSONDecoder().decode([NativeAudienceDeviceRenewalRecord].self, from: bytes)
        guard rows.count <= 32, Set(rows.map(\.accountID)).count == rows.count else { throw NativeAPIError.invalidResponse }
        for row in rows {
            let owner = RegisteredDevice(accountID: row.accountID, faceHandle: row.faceHandle, deviceID: row.deviceID, keyAlias: row.keyAlias)
            try row.validate(origin: origin, device: owner)
        }
        return (rows, bytes)
    }
    func pendingAudienceDeviceRenewal() throws -> Bool {
        let account: String?
        if let current = credentials?.account_id { account = current } else { account = try device()?.accountID }
        return try audienceDeviceRenewals().0.contains { $0.accountID == account }
    }
    func audienceDeviceBinding(_ status: NativeAudienceDeviceStatus) throws -> NativeAudienceSessionBinding {
        let captured = Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation), owner = try audienceDeviceOwner(captured)
        guard owner.accountID == status.accountID, owner.deviceID == status.deviceID else { throw NativeAPIError.sessionChanged }
        return NativeAudienceSessionBinding(accountID: owner.accountID, epoch: epoch, registeredIdentity: false, deviceOnly: true)
    }
    private func signedAudienceDevice(_ owner: RegisteredDevice, captured: Scope, step: String, operation: NativeAudienceDeviceRenewalRecord? = nil) async throws -> NativeAudienceDeviceStatus {
        try checkAudienceDevice(owner, captured: captured)
        let nonce = UUID().uuidString.lowercased()
        var fields: [String: WireValue] = ["account_id": .string(owner.accountID), "device_id": .string(owner.deviceID), "face_handle": .string(owner.faceHandle),
            "request_nonce": .string(nonce), "request_expires_at": .integer(Int(Date().timeIntervalSince1970 * 1000) + 55_000)]
        if let operation { try operation.validate(origin: origin, device: owner); fields.merge(operation.decisionBody) { _, new in new } }
        let envelope = WireValue.object(fields.merging(["protocol": .string("lovelies-audience-device-v1"), "step": .string(step)]) { _, new in new })
        fields["device_signature"] = .string(try signDevice(envelope.canonical(), alias: owner.keyAlias ?? NativeEnrollmentRecord.keyAlias))
        try checkAudienceDevice(owner, captured: captured)
        let value = try await json("/auth/face/audience/" + step, method: "POST", body: .object(fields), scope: captured, preserveRefreshAuthority: true)
        try checkAudienceDevice(owner, captured: captured)
        return try NativeAudienceDeviceStatus(value, account: owner.accountID, device: owner.deviceID, nonce: nonce, operation: operation)
    }
    func signedAudienceStatus() async throws -> NativeAudienceDeviceStatus {
        let captured = Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation)
        return try await signedAudienceDevice(audienceDeviceOwner(captured), captured: captured, step: "status")
    }
    func renewDeviceAudience(expectedVersion: Int, consentPolicy: String?, guardianRequired: Bool = false, retryOriginal: Bool = false) async throws -> NativeAudienceDeviceStatus {
        guard !audienceMutationBusy else { throw NativeAPIError.operationUnconfirmed("audience_mutation_busy") }
        audienceMutationBusy = true; defer { audienceMutationBusy = false }
        let captured = Scope(epoch: epoch, account: nil, token: nil, retirementGeneration: sessionRetirement.snapshot().generation), owner = try audienceDeviceOwner(captured)
        guard try pendingAudienceMutation() == nil else { throw NativeAPIError.operationUnconfirmed("audience_mutation_pending") }
        let (rows, bytes) = try audienceDeviceRenewals()
        let record: NativeAudienceDeviceRenewalRecord
        if let existing = rows.first(where: { $0.accountID == owner.accountID }) {
            guard retryOriginal else { throw NativeAPIError.operationUnconfirmed(existing.operationKey) }
            try existing.validate(origin: origin, device: owner); record = existing
        } else {
            guard !retryOriginal, rows.count < 32 else { throw NativeAPIError.invalidResponse }
            record = try NativeAudienceDeviceRenewalRecord(origin: origin, device: owner, expectedVersion: expectedVersion, consentPolicy: consentPolicy, guardianRequired: guardianRequired)
            guard try secrets.compareAndSwap("audience-device-renewals", expected: bytes, replacement: JSONEncoder().encode(rows + [record])) else { throw NativeAPIError.sessionChanged }
        }
        // Errors retain the original exact key and reviewed decision. A fresh
        // nonce authenticates recovery; it never substitutes a second mutation.
        let step = record.guardianRequired ? "guardian-review" : "renew"
        let result: NativeAudienceDeviceStatus
        do { result = try await signedAudienceDevice(owner, captured: captured, step: step, operation: record) }
        catch NativeAPIError.denied(let status, let code) where NativeOperationRetirementRecord.isTerminal(status: status, code: code) {
            try checkAudienceDevice(owner, captured: captured)
            try retainTerminal(NativeOperationRetirementRecord(origin: origin, account: record.accountID, key: record.operationKey, action: "audience.device." + step,
                path: "/auth/face/audience/" + step, method: "POST", inputSHA256: NativeApplePurchaseRecord.hash(try WireValue.object(record.decisionBody).canonical()), sourceStatus: status, sourceCode: code))
            let (retained, retainedBytes) = try audienceDeviceRenewals()
            guard retained.filter({ $0 == record }).count == 1 else { throw NativeAPIError.sessionChanged }
            let remaining = retained.filter { $0 != record }
            guard try secrets.compareAndSwap("audience-device-renewals", expected: retainedBytes, replacement: remaining.isEmpty ? nil : JSONEncoder().encode(remaining)) else { throw NativeAPIError.sessionChanged }
            audienceProjection = nil; audienceProjectionEpoch = nil; retireMedia()
            throw NativeAPIError.denied(409, "audience_operation_recovered_without_result")
        }
        try checkAudienceDevice(owner, captured: captured)
        let (current, currentBytes) = try audienceDeviceRenewals()
        guard current.filter({ $0 == record }).count == 1 else { throw NativeAPIError.sessionChanged }
        let retained = current.filter { $0 != record }
        guard try secrets.compareAndSwap("audience-device-renewals", expected: currentBytes, replacement: retained.isEmpty ? nil : JSONEncoder().encode(retained)) else { throw NativeAPIError.sessionChanged }
        audienceProjection = nil; audienceProjectionEpoch = nil; retireMedia()
        return result
    }
    private static func audienceWeakerPath(_ path: String, method: String = "GET") -> Bool {
        path == "/me" || path == "/me/audience" || path == "/me/audience/renew" || path.hasPrefix("/me/guardian-requests") || path.hasPrefix("/guardian-requests/") ||
        path == "/me/devices" || path == "/me/sessions" || path == "/me/photo-preferences" || path == "/auth/session/revoke" || path == "/auth/device/revoke" ||
        path.hasPrefix("/privacy/") || path.hasPrefix("/privacy-requests/") || path.hasPrefix("/privacy-exports/") ||
        path == "/auth/logout" || (path.hasPrefix("/uploads/") && path.hasSuffix("/cancel"))
    }
    private func fetchAudience(_ captured: Scope) async throws -> NativeAudienceProjection {
        guard let account = captured.account, captured.token != nil else { throw NativeAPIError.authenticationRequired }
        let value = try await json("/me/audience", scope: captured)
        try check(captured)
        let parsed = try NativeAudienceProjection(value, account: account)
        if let previous = audienceProjection, audienceProjectionEpoch == captured.epoch, previous.accountID == account {
            guard parsed.version >= previous.version else { throw NativeAPIError.denied(409, "audience_version_changed") }
        }
        audienceProjection = parsed; audienceProjectionEpoch = captured.epoch
        return parsed
    }
    func audienceSessionBinding() -> NativeAudienceSessionBinding? {
        guard !sessionRetirement.snapshot().retiring else { return nil }
        return credentials.flatMap { !credentialCurrent($0) || retiredCredentialDigests.contains(Self.credentialDigest($0)) ? nil : NativeAudienceSessionBinding(accountID: $0.account_id, epoch: epoch, registeredIdentity: $0.authenticated) }
    }
    func audiencePresentation(_ value: NativeAudienceProjection) throws -> NativeAudienceSessionBinding {
        guard audienceProjection == value, audienceProjectionEpoch == epoch, value.accountID == credentials?.account_id, let binding = audienceSessionBinding() else { throw NativeAPIError.sessionChanged }
        return binding
    }
    func audience() async throws -> NativeAudienceProjection {
        try await fetchAudience(readyScope(anonymous: true))
    }
    private func requireAudience(_ purpose: NativeAudiencePurpose, captured: Scope) async throws -> NativeAudienceProjection {
        if try pendingAudienceDeviceRenewal() { throw NativeAPIError.operationUnconfirmed("audience_renewal_pending") }
        let value = try await fetchAudience(captured); try value.require(purpose); return value
    }
    func requireAudience(_ purpose: NativeAudiencePurpose) async throws -> NativeAudienceProjection {
        try await requireAudience(purpose, captured: readyScope(anonymous: true))
    }
    /// Fresh own product authority before local personal-photo collection.
    /// An eligible audience and registered credential method alone do not mean
    /// the registered reference/subject consent is still usable. Strong denial
    /// retires collection, while the same durable session may still use privacy.
    func requirePhotoCollection(expectedOwner: NativeMediaCaptureContext? = nil) async throws -> NativeAudienceProjection {
        try await requirePhotoCollection(captured: readyScope(), expectedOwner: expectedOwner)
    }
    private func requirePhotoCollection(captured: Scope, expectedOwner: NativeMediaCaptureContext?) async throws -> NativeAudienceProjection {
        try check(captured); try Task.checkCancellation()
        if let expectedOwner, !expectedOwner.ownsSession(summary()) { throw NativeAPIError.sessionChanged }
        let approval = try await requireAudience(.photoProcessing, captured: captured)
        // assertActor on this existing backend route checks the current
        // registered reference before and after its private profile read.
        // A privacy-only durable credential is deliberately retained on 401;
        // this response grants no local product/collection authority.
        let reply: NativeHTTPReply
        do { reply = try await request("/me/profile", scope: captured, preserveRefreshAuthority: true) }
        catch { retireMedia(); throw error }
        guard reply.status == 200 else { throw NativeAPIError.invalidResponse }
        let value = try WireValue.decoded(reply.data)
        try NativeAudienceProjection.keys(value, ["user_id", "profile_scope", "name"])
        guard try value.uuid("user_id") == captured.account, value["profile_scope"].string == "registered_face_profile",
              let name = value["name"].string, name.utf8.count <= 480 else { throw NativeAPIError.invalidResponse }
        try await recheckAudienceFence(approval, captured: captured, purpose: .photoProcessing)
        try check(captured); try Task.checkCancellation()
        if let expectedOwner, !expectedOwner.ownsSession(summary()) { throw NativeAPIError.sessionChanged }
        return approval
    }
    private func audienceRequestFence(_ path: String, method: String, body: WireValue?, captured: Scope) async throws -> NativeAudienceProjection? {
        let preferenceEnable = path == "/me/photo-preferences" && method != "GET" && ["photo_matching_consent", "processing_consent", "receive_matches"].contains(where: { body?[$0].bool == true })
        guard captured.account != nil, !path.hasPrefix("/auth/"), preferenceEnable || !Self.audienceWeakerPath(path, method: method) else { return nil }
        let purpose: NativeAudiencePurpose = path.hasPrefix("/uploads") ? .photoProcessing : .faceAuthentication
        let value = try await requireAudience(purpose, captured: captured)
        if path == "/community/action", let action = body?["action"].string,
           !["photos", "photos.validate", "photos.lookup", "inbox", "history", "operation"].contains(action) { try value.require(.photoMatching) }
        return value
    }
    private func recheckAudienceFence(_ previous: NativeAudienceProjection, captured: Scope, purpose: NativeAudiencePurpose = .faceAuthentication) async throws {
        let current = try await requireAudience(purpose, captured: captured)
        guard current == previous else { retireMedia(); throw NativeAPIError.denied(409, "audience_version_changed") }
    }
    private func faceAudienceRetains(_ challenge: NativeFaceChallenge) -> Bool {
        guard guestDeletion == nil else { return false }
        if let record = faceLifecycle, accountRecovery == nil { return record.loginChallengeWire == challenge.wire || record.pending?.challengeWire == challenge.wire }
        if let record = accountRecovery {
            if record.challengeWire == challenge.wire { return true }
            // Recovery start/resume adds request metadata; signed readonly
            // status returns the same plain challenge. Normalize only that
            // known wrapper for its exact authoritative predecessor. Every
            // remaining field, including audience authority, must still match.
            guard let retained = record.challengeWire, retained["recovery_request_id"] == .null,
                  retained["recovery_generation"] == .null, challenge.accountID == record.accountID,
                  challenge.deviceID == record.deviceID, challenge.id == record.predecessorID,
                  challenge.wire["recovery_request_id"].string == record.requestID,
                  challenge.wire["recovery_generation"].integer == record.generation,
                  var plain = challenge.wire.object else { return false }
            plain.removeValue(forKey: "recovery_request_id"); plain.removeValue(forKey: "recovery_generation")
            return retained == .object(plain)
        }
        if let record = enrollment { return record.challengeWire == challenge.wire || record.loginChallengeWire == challenge.wire }
        return ordinaryLogin?.challengeWire == challenge.wire
    }
    func requireFaceAudience(_ challenge: NativeFaceChallenge) async throws {
        if let held = audienceSuspension { throw NativeAPIError.operationUnconfirmed(held.operation.operationKey) }
        guard challenge.expiresAt > Date() else { throw NativeAPIError.reviewChanged }
        guard faceAudienceRetains(challenge) else { throw NativeAPIError.sessionChanged }
        let authority = try NativeAudienceChallengeAuthority(challenge.wire["audience_authority"], challenge: challenge)
        try authority.requireCurrent()
        if challenge.purpose == "registration", credentials?.account_id == challenge.accountID {
            let captured = try await readyScope(anonymous: true)
            guard captured.account == challenge.accountID else { throw NativeAPIError.sessionChanged }
            let current = try await requireAudience(.faceAuthentication, captured: captured)
            guard current.version == authority.audienceVersion else { throw NativeAPIError.denied(409, "audience_version_changed") }
            guard faceAudienceRetains(challenge) else { throw NativeAPIError.sessionChanged }
        } else {
            // A known signed login/recovery challenge is issued by the server
            // only after its target account's audience check. Never ask a new
            // anonymous account to declare an age for that different target.
            try NativeAudienceChallengeAuthority(challenge.wire["audience_authority"], challenge: challenge).requireCurrent()
            if credentials?.account_id == challenge.accountID, (credentials?.expiresAt ?? .distantPast) > Date() {
                let current = try await requireAudience(.faceAuthentication, captured: readyScope(anonymous: true))
                guard current.version == authority.audienceVersion else { throw NativeAPIError.denied(409, "audience_version_changed") }
            }
        }
    }
    private func retireAudienceAfterDeletion(account: String) throws {
        if let operation = try pendingAudienceMutation(), operation.accountID == account {
            let slot = "audience-operations-retired-after-deletion"
            var archive = try secrets.read(slot).map { try JSONDecoder().decode([NativeAudienceMutationRecord].self, from: $0) } ?? []
            if !archive.contains(operation) { guard archive.count < 32 else { throw NativeAPIError.invalidResponse }; archive.append(operation); try secrets.write(slot, data: JSONEncoder().encode(archive)) }
            guard let data = try secrets.read("audience-mutation-journal"), try JSONDecoder().decode(NativeAudienceMutationRecord.self, from: data) == operation,
                  try secrets.compareAndSwap("audience-mutation-journal", expected: data, replacement: nil) else { throw NativeAPIError.sessionChanged }
        }
        if let data = try secrets.read("audience-suspended-authority") {
            let held = try JSONDecoder().decode(NativeAudienceSuspensionRecord.self, from: data); try held.validate(origin: origin)
            if held.operation.accountID == account { try secrets.write("audience-suspended-authority", data: nil); audienceSuspension = nil }
        }
    }
    private func saveAudienceSuspension(_ held: NativeAudienceSuspensionRecord) throws {
        try held.validate(origin: origin)
        try replaceOwnedJournal("audience-suspended-authority", previous: audienceSuspension, replacement: held); audienceSuspension = held
    }
    private func restoreAudienceSuspension() throws -> Bool {
        guard let bytes = try secrets.read("audience-suspended-authority") else { return false }
        guard bytes.count <= 32768 else { throw NativeAPIError.invalidResponse }
        let held = try JSONDecoder().decode(NativeAudienceSuspensionRecord.self, from: bytes); try held.validate(origin: origin)
        guard enrollment == nil, accountRecovery == nil, ordinaryLogin == nil, faceLifecycle == nil else { throw NativeAPIError.sessionChanged }
        if let saved = try secrets.read("credentials") {
            let current = try JSONDecoder().decode(NativeCredentials.self, from: saved)
            guard current.account_id == held.operation.accountID, current.auth_method == "anonymous" else { throw NativeAPIError.sessionChanged }
        }
        let pending = try pendingAudienceMutation()
        guard pending == held.operation || pending == nil && held.resolved else { throw NativeAPIError.sessionChanged }
        credentials = held.credentials; audienceSuspension = held; epoch += 1; retireMedia()
        if held.resolved && pending == nil {
            try persistCredential(held.credentials)
            try secrets.write("audience-suspended-authority", data: nil); audienceSuspension = nil; return false
        }
        return true
    }
    func pendingAudienceMutation() throws -> NativeAudienceMutationRecord? {
        guard let bytes = try secrets.read("audience-mutation-journal") else { return nil }
        guard bytes.count <= 8192 else { throw NativeAPIError.invalidResponse }
        let record = try JSONDecoder().decode(NativeAudienceMutationRecord.self, from: bytes)
        try record.validate(origin: origin); return record
    }
    private func audienceMutation(path: String, method: String = "POST", body: WireValue, retryOriginal: Bool = false) async throws -> WireValue {
        guard !audienceMutationBusy else { throw NativeAPIError.operationUnconfirmed("audience_mutation_busy") }
        guard try !pendingAudienceDeviceRenewal() else { throw NativeAPIError.operationUnconfirmed("audience_renewal_pending") }
        audienceMutationBusy = true; defer { audienceMutationBusy = false }
        let captured = try await readyScope(anonymous: true)
        let record: NativeAudienceMutationRecord
        if let existing = try pendingAudienceMutation() {
            guard existing.accountID == captured.account else { throw NativeAPIError.sessionChanged }
            guard retryOriginal else { throw NativeAPIError.operationUnconfirmed(existing.operationKey) }
            record = existing
        } else {
            guard !retryOriginal, let account = captured.account else { throw NativeAPIError.invalidResponse }
            record = try NativeAudienceMutationRecord(origin: origin, accountID: account, path: path, method: method, body: body)
            guard try secrets.compareAndSwap("audience-mutation-journal", expected: nil, replacement: JSONEncoder().encode(record)) else { throw NativeAPIError.operationUnconfirmed("audience_mutation_busy") }
        }
        do {
            let value = try await json(record.path, method: record.method, body: record.body, scope: captured)
            try check(captured)
            if record.path == "/me/audience" { _ = try NativeAudienceProjection(value, account: record.accountID, allowLegacyReceipt: record.body["age_band"].string != nil) }
            else if record.path == "/me/audience/renew" {
                guard var projection = value.object else { throw NativeAPIError.invalidResponse }
                projection.removeValue(forKey: "renewal")
                let current = try NativeAudienceProjection(.object(projection), account: record.accountID)
                try NativeAudienceDeviceStatus.validateReceipt(value["renewal"], key: record.operationKey,
                    expectedVersion: record.body["expected_version"].integer ?? -1, currentVersion: current.version)
            }
            else if record.path == "/me/guardian-requests" {
                let full = try NativeAudienceProjection(value["audience"], account: record.accountID)
                let request = try NativeGuardianRequest(value["guardian_request"], child: record.accountID)
                guard full.guardianRequest == request else { throw NativeAPIError.invalidResponse }
            } else {
                let id = String(record.path.split(separator: "/")[1])
                let request = try NativeGuardianRequest(value["guardian_request"], id: id)
                guard request.revision > (record.body["expected_revision"].integer ?? Int.max) else { throw NativeAPIError.invalidResponse }
                if record.path.hasSuffix("/claim") {
                    guard request.childAccountID != record.accountID, request.state != .pending else { throw NativeAPIError.invalidResponse }
                    try secrets.write("guardian-bound-reference", data: WireValue.object(["account_id": .string(record.accountID), "request_id": .string(request.id)]).encoded())
                }
            }
            // A response whose binding cannot be checked never retires the key.
            try retireAudienceMutation(record)
            audienceProjection = nil; audienceProjectionEpoch = nil; retireMedia()
            return value
        } catch NativeAPIError.denied(let status, let code) where NativeOperationRetirementRecord.isTerminal(status: status, code: code) {
            try check(captured)
            try retainTerminal(NativeOperationRetirementRecord(origin: origin, account: record.accountID, key: record.operationKey, action: "audience." + record.path,
                path: record.path, method: record.method, inputSHA256: NativeApplePurchaseRecord.hash(try record.body.canonical()), sourceStatus: status, sourceCode: code))
            try retireAudienceMutation(record)
            audienceProjection = nil; audienceProjectionEpoch = nil; retireMedia()
            throw NativeAPIError.denied(409, "audience_operation_recovered_without_result")
        } catch NativeAPIError.denied(let status, let code) where (400..<500).contains(status) && ![408, 429].contains(status) && !["operation_key_conflict", "explicit_auth_consent_required", "face_policy_changed", "consent_policy_changed", "audience_policy_changed"].contains(code) {
            try check(captured)
            try retireAudienceMutation(record)
            throw NativeAPIError.denied(status, code)
        } catch { throw NativeAPIError.operationUnconfirmed(record.operationKey) }
    }
    private func retireAudienceMutation(_ record: NativeAudienceMutationRecord) throws {
        if var held = audienceSuspension {
            guard held.operation == record, let current = credentials, current.account_id == record.accountID else { throw NativeAPIError.sessionChanged }
            held.credentials = current; held.resolved = true; try saveAudienceSuspension(held)
            try persistCredential(current)
        }
        guard let data = try secrets.read("audience-mutation-journal"),
              try JSONDecoder().decode(NativeAudienceMutationRecord.self, from: data) == record,
              try secrets.compareAndSwap("audience-mutation-journal", expected: data, replacement: nil) else { throw NativeAPIError.sessionChanged }
        if audienceSuspension != nil { try secrets.write("audience-suspended-authority", data: nil); audienceSuspension = nil }
    }
    func retryAudienceMutation() async throws -> NativeAudienceProjection {
        let isRenewal = try pendingAudienceMutation()?.path == "/me/audience/renew"
        let result = try await audienceMutation(path: "", body: .null, retryOriginal: true)
        var current = try await audience()
        if isRenewal { current.renewalNextStep = result["renewal"]["next_step"].string; audienceProjection = current }
        return current
    }
    func declareAudience(_ band: NativeAgeBand, expectedVersion: Int) async throws -> NativeAudienceProjection {
        guard band != .unknown else { throw NativeAPIError.invalidResponse }
        _ = try await audienceMutation(path: "/me/audience", method: "PUT", body: .object(["at_least_13": .bool(band != .under13), "guardian_required": .bool(band == .teen), "policy_version": .string(NativeAudienceProjection.policy), "expected_version": .integer(expectedVersion)]))
        return try await audience()
    }
    func renewAudience(expectedVersion: Int, consentPolicy: String) async throws -> NativeAudienceProjection {
        guard expectedVersion > 0, !consentPolicy.isEmpty, consentPolicy.utf8.count <= 128 else { throw NativeAPIError.invalidResponse }
        let result = try await audienceMutation(path: "/me/audience/renew", body: .object(["at_least_13": .bool(true), "guardian_required": .bool(false), "policy_version": .string(NativeAudienceProjection.policy), "expected_version": .integer(expectedVersion), "consent": .object(["purpose": .string("face_authentication"), "policy_version": .string(consentPolicy), "granted": .bool(true)])]))
        var current = try await audience(); current.renewalNextStep = result["renewal"]["next_step"].string; audienceProjection = current
        return current
    }
    func createGuardianRequest(expectedVersion: Int) async throws -> NativeAudienceProjection {
        _ = try await audienceMutation(path: "/me/guardian-requests", body: .object(["expected_version": .integer(expectedVersion), "policy_version": .string(NativeAudienceProjection.policy)]))
        return try await audience()
    }
    func guardianRequest(_ id: String) async throws -> NativeGuardianRequest {
        guard UUID(uuidString: id) != nil else { throw NativeAPIError.invalidResponse }
        let captured = try await readyScope(anonymous: true)
        let value = try await json("/me/guardian-requests/" + id, scope: captured)
        return try NativeGuardianRequest(value["guardian_request"], id: id)
    }
    func claimGuardianRequest(id: String, revision: Int, purposes: Set<NativeAudiencePurpose>, relationshipAttested: Bool) async throws -> NativeGuardianRequest {
        let captured = try await readyScope(), own = try await fetchAudience(captured)
        guard own.ageBand == .adult, own.status == .eligible, relationshipAttested, !purposes.isEmpty, UUID(uuidString: id) != nil else { throw NativeAPIError.denied(403, "guardian_adult_required") }
        let value = try await audienceMutation(path: "/guardian-requests/" + id + "/claim", body: .object(["expected_revision": .integer(revision), "policy_version": .string(NativeAudienceProjection.policy), "relationship_attested": .bool(true), "purposes": .strings(purposes.map(\.rawValue).sorted())]))
        let request = try NativeGuardianRequest(value["guardian_request"], id: id)
        guard request.childAccountID != captured.account, request.state != .pending else { throw NativeAPIError.invalidResponse }
        return request
    }
    func retainedGuardianClaim() async throws -> NativeGuardianRequest? {
        guard let data = try secrets.read("guardian-bound-reference") else { return nil }
        guard data.count <= 1024 else { throw NativeAPIError.invalidResponse }
        let value = try WireValue.decoded(data)
        try NativeAudienceProjection.keys(value, ["account_id", "request_id"])
        let captured = try await readyScope(anonymous: true)
        guard try value.uuid("account_id") == captured.account else { return nil }
        return try await guardianRequest(value.uuid("request_id"))
    }
    func withdrawGuardianRequest(_ request: NativeGuardianRequest) async throws -> NativeGuardianRequest {
        let value = try await audienceMutation(path: "/guardian-requests/" + request.id + "/withdraw", body: .object(["expected_revision": .integer(request.revision)]))
        return try NativeGuardianRequest(value["guardian_request"], id: request.id)
    }
}
