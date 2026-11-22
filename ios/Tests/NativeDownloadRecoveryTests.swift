import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Actual repository, wire parser and private files; all remote/OS effects are
// declared synthetic. No Keychain, provider, Photos, share target or server runs.
private final class DownloadSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var slots: [String: Data] = [:]
    var failingSlot: String?
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return slots[name] }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if failingSlot == name { throw NativeAPIError.unavailable("synthetic_vault_failure") }
        slots[name] = data
    }
}
private struct DownloadSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { NativeDownloadRecord.hash(data) }
    func clear() {}
}
private enum DownloadFixture {
    static let account = "00000000-0000-4000-8000-000000000291"
    static let session = "00000000-0000-4000-8000-000000000292"
    static let renewed = "00000000-0000-4000-8000-000000000293"
    static let asset = "00000000-0000-4000-8000-000000000294"
    static let origin = URL(string: "https://download-recovery.invalid")!
    static let bytes = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    static func credentials(_ session: String = DownloadFixture.session) throws -> NativeCredentials {
        let claims: WireValue = .object(["sub": .string(account), "jti": .string(session), "auth_method": .string("registered_face"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("synthetic-download-refresh-" + session),
            "account_id": .string(account), "auth_method": .string("registered_face"), "expires_in": .integer(900), "roles": .strings(["user"])]))
    }
    static func photo() throws -> NativePhoto {
        try NativePhoto(.object(["id": .string(asset), "title": .string("Synthetic photo"), "media_source": .string("personal"), "version": .string("source-v1")]))
    }
    static func audience(_ eligible: Bool) -> WireValue {
        .object(["protocol": .string(NativeAudienceProjection.protocolName), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(account),
            "audience": .object(["age_band": .string("18_plus"), "status": .string(eligible ? "eligible" : "suspended"), "version": .integer(eligible ? 1 : 2), "policy_version": .string(NativeAudienceProjection.policy), "next_review_at": .null]),
            "guardian_request": .null, "capabilities": .object(["face_authentication": .bool(eligible), "photo_matching": .bool(eligible), "photo_processing": .bool(eligible)])])
    }
}
private actor DownloadGate {
    private var entered = false, released = false
    private var entrants: [CheckedContinuation<Void, Never>] = []
    private var waiter: CheckedContinuation<Void, Never>?
    func block() async {
        entered = true; entrants.forEach { $0.resume() }; entrants = []
        if !released { await withCheckedContinuation { waiter = $0 } }
    }
    func waitUntilEntered() async { if !entered { await withCheckedContinuation { entrants.append($0) } } }
    func release() { released = true; waiter?.resume(); waiter = nil }
}
private actor DownloadTransport: NativeTransport {
    let vault: DownloadSecrets
    private var responses: [String: WireValue] = [:]
    private var capabilities: [String: String] = [:]
    private var signCount = 0, statusCount = 0, contentCount = 0
    private var loseSign = false, noIssue = false, loseContent = false, eligible = true
    private var responseChange: (String, WireValue)?
    private var contentFault: String?
    private var gate: DownloadGate?
    private var imageBytes = DownloadFixture.bytes, imageMime = "image/png"
    func image(_ bytes: Data, mime: String) { imageBytes = bytes; imageMime = mime }
    init(_ vault: DownloadSecrets) { self.vault = vault }
    nonisolated func cancelPending() {}
    func configure(loseSign: Bool = false, noIssue: Bool = false, loseContent: Bool = false, fault: String? = nil, change: (String, WireValue)? = nil, gate: DownloadGate? = nil) {
        self.loseSign = loseSign; self.noIssue = noIssue; self.loseContent = loseContent; self.contentFault = fault; self.responseChange = change; self.gate = gate
    }
    func suspendAudience() { eligible = false }
    func counts() -> (Int, Int, Int) { (signCount, statusCount, contentCount) }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        func json(_ value: WireValue, status: Int = 200) throws -> NativeHTTPReply { .init(status: status, headers: ["content-type": "application/json"], data: try value.encoded()) }
        guard request.url?.host == DownloadFixture.origin.host, request.url?.query == nil else { throw NativeAPIError.invalidResponse }
        switch request.url!.path {
        case "/me": return try json(.object(["user_id": .string(DownloadFixture.account), "auth_method": .string("registered_face"), "authenticated": .bool(true)]))
        case "/me/audience": return try json(DownloadFixture.audience(eligible))
        case "/downloads/v2/sign", "/downloads/v2/status", "/downloads/v2/content":
            guard request.httpMethod == "POST", let data = request.httpBody, let header = request.value(forHTTPHeaderField: "X-Lovelies-Download-Capability") else { throw NativeAPIError.invalidResponse }
            let body = try WireValue.decoded(data)
            guard Set(body.object!.keys) == Set(["protocol", "operation_key", "original_session_id", "asset_id", "source_version"]),
                  body["protocol"].string == "lovelies-download-input-v2", let key = body["operation_key"].string,
                  body["asset_id"].string == DownloadFixture.asset, body["source_version"].string == "source-v1",
                  let saved = try vault.read("download-delivery-v2"), let record = try JSONDecoder().decode(NativeDownloadJournal.self, from: saved).operations.first(where: { $0.key == key }),
                  record.capability == header, record.body == body else { throw NativeAPIError.invalidResponse }
            if let previous = capabilities[key] { guard previous == header else { throw NativeAPIError.invalidResponse } }
            let route = request.url!.lastPathComponent
            if route == "sign" {
                guard record.phase == .signing, responses[key] == nil else { throw NativeAPIError.invalidResponse }
                signCount += 1; capabilities[key] = header
                var result = body.object!; result["protocol"] = .string("lovelies-download-operation-v2"); result["account_id"] = .string(DownloadFixture.account)
                result["status"] = .string(noIssue ? "not_issued" : "recorded")
                if !noIssue { let now = Int(Date().timeIntervalSince1970 * 1000); result["created_at"] = .integer(now); result["expires_at"] = .integer(now + 110_000) }
                responses[key] = .object(result)
                if let gate { self.gate = nil; await gate.block() }
                if loseSign { loseSign = false; throw URLError(.networkConnectionLost) }
            } else if route == "status" { statusCount += 1 }
            if route != "content" {
                guard var response = responses[key]?.object else { return try json(.object(["error": .string("download_operation_outcome_unresolved")]), status: 503) }
                if let responseChange { response[responseChange.0] = responseChange.1 }
                return try json(.object(response))
            }
            guard record.phase == .contentStarted, responses[key]?["status"].string == "recorded" else { throw NativeAPIError.invalidResponse }
            contentCount += 1
            if loseContent { loseContent = false; throw URLError(.networkConnectionLost) }
            let bytes = imageBytes
            var headers = ["content-type": imageMime, "content-length": String(bytes.count), "x-lovelies-source-version": "source-v1", "x-lovelies-content-sha256": NativeDownloadRecord.hash(bytes)]
            switch contentFault {
            case "hash": headers["x-lovelies-content-sha256"] = String(repeating: "0", count: 64)
            case "length": headers["content-length"] = String(bytes.count + 1)
            case "mime": headers["content-type"] = "image/jpeg"
            case "source": headers["x-lovelies-source-version"] = "source-v2"
            default: break
            }
            return .init(status: 200, headers: headers, data: bytes)
        default: throw NativeAPIError.unsupported("Unexpected synthetic route")
        }
    }
}
private struct DownloadHarness {
    let vault: DownloadSecrets, transport: DownloadTransport, root: URL
    func repository() -> BackendRepository { BackendRepository(origin: DownloadFixture.origin, transport: transport, secrets: vault, signer: DownloadSigner(), uploadFiles: NativeUploadPrivateFiles(root: root)) }
    func journal() throws -> NativeDownloadJournal { try JSONDecoder().decode(NativeDownloadJournal.self, from: vault.read("download-delivery-v2")!) }
    static func make() throws -> Self {
        let vault = DownloadSecrets(), root = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-download-test-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try vault.write("credentials", data: JSONEncoder().encode(DownloadFixture.credentials()))
        return .init(vault: vault, transport: DownloadTransport(vault), root: root)
    }
    func cleanup() { try? FileManager.default.removeItem(at: root) } // Only this newly created fixture tree.
}
@MainActor @main struct NativeDownloadRecoveryTests {
    private static var checks = 0
    private static func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw NativeAPIError.unsupported("Download recovery: " + label) }; checks += 1; print("PASS " + label)
    }
    private static func fails(_ label: String, expected: NativeDownloadIssue? = nil, _ work: () async throws -> Void) async throws {
        var failure: (any Error)?
        do { try await work() } catch { failure = error }
        try require(failure != nil, label)
        if let expected, let failure { try require(failure as? NativeDownloadIssue == expected, label + " retains its recovery boundary") }
    }
    static func main() async throws {
        let photo = try DownloadFixture.photo()
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }
            let repo = h.repository(); _ = try await repo.bootstrap()
            let prepared = try await repo.prepareDownload(photo, purpose: .photos)
            try require(prepared.bytes == DownloadFixture.bytes, "matching bytes are verified through protected staging")
            try require(try h.journal().operations.last!.phase == .staged, "issuance/content do not claim Photos saved")
            let effect = try await repo.beginDownloadEffect(prepared)
            try require(try h.journal().operations.last!.phase == .externalStarted, "effect intent is durable before the external call")
            try await fails("a second effect cannot reuse the same staged handle") { _ = try await repo.beginDownloadEffect(prepared) }
            try await repo.checkDownloadEffect(effect)
            try await repo.finishDownloadEffect(effect, completed: false)
            try require(try h.journal().operations.last!.phase == .externalUncertain, "false callback retains uncertainty")
            let restarted = h.repository(); _ = try await restarted.bootstrap()
            try await fails("restart does not automatically repeat ambiguous Photos", expected: .externalUnconfirmed) { _ = try await restarted.prepareDownload(photo, purpose: .photos) }
            var counts = await h.transport.counts(); try require(counts.0 == 1 && counts.2 == 2, "external reauthorization repeats only original content")
            _ = try await restarted.prepareDownload(photo, purpose: .photos, explicitNewAction: true)
            counts = await h.transport.counts(); try require(counts.0 == 2, "only explicit new action allocates a new effect intent")
            try require(try h.journal().operations.first!.phase == .externalUncertain, "new action preserves prior uncertain effect")
            try await repo.finishDownloadEffect(effect, completed: true)
            try require(try h.journal().operations.first!.phase == .externalCompleted, "late positive OS receipt settles only original effect")
        }
        // Complete synthetic 1x1 GIF original: no upload route or conversion.
        let gif87 = Data([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
                          0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b])
        for signature in ["GIF87a", "GIF89a"] {
            var gif = gif87; gif.replaceSubrange(0..<6, with: Data(signature.utf8))
            let h = try DownloadHarness.make(); defer { h.cleanup() }; await h.transport.image(gif, mime: "image/gif")
            let repo = h.repository(); _ = try await repo.bootstrap()
            let prepared = try await repo.prepareDownload(photo, purpose: .share)
            let record = try h.journal().operations.last!
            try require(prepared.bytes == gif && prepared.mime == "image/gif" && prepared.fileExtension == "gif", signature + " original is preserved without re-encoding")
            try require(record.phase == .staged && record.sha256 == NativeDownloadRecord.hash(gif), signature + " protected record binds actual bytes")
            let files = NativeDownloadPrivateFiles(root: h.root.appendingPathComponent("download-staging-v2", isDirectory: true))
            try require(try files.verifiedBytes(record) == gif, signature + " protected disk read verifies the original hash")
            let status = try await repo.downloadStatus(key: record.key)
            try require(status == .staged, signature + " status confirms issuance without claiming external delivery")
            let restarted = h.repository(); _ = try await restarted.bootstrap()
            let resumed = try await restarted.prepareDownload(photo, purpose: .share)
            let recovered = try h.journal().operations.last!
            try require(resumed.bytes == gif && recovered.key == record.key && recovered.capability == record.capability, signature + " restart uses the same protected original intent")
            let counts = await h.transport.counts()
            try require(counts.0 == 1 && counts.1 == 2 && counts.2 == 2, signature + " recovery uses status/repeat content without re-signing")
        }
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }; await h.transport.image(gif87, mime: "image/png")
            let repo = h.repository(); _ = try await repo.bootstrap()
            try await fails("GIF bytes with the wrong response MIME never enter staging", expected: .deliveryUnconfirmed) { _ = try await repo.prepareDownload(photo, purpose: .share) }
            let record = try h.journal().operations.last!
            try require(record.phase == .contentStarted && record.sha256 == nil, "wrong-MIME GIF has no accepted local bytes")
            let target = h.root.appendingPathComponent("download-staging-v2").appendingPathComponent(record.key + ".download")
            try require(!FileManager.default.fileExists(atPath: target.path), "wrong-MIME GIF creates no protected staged file")
        }
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }; await h.transport.configure(loseSign: true)
            let repo = h.repository(); _ = try await repo.bootstrap()
            try await fails("lost sign reply is unconfirmed", expected: .issuanceUnconfirmed) { _ = try await repo.prepareDownload(photo, purpose: .share) }
            let original = try h.journal().operations.last!
            try require(original.phase == .signing, "pre-dispatch signing context survives lost response")
            let restarted = h.repository(); _ = try await restarted.bootstrap()
            _ = try await restarted.prepareDownload(photo, purpose: .share)
            let counts = await h.transport.counts()
            try require(counts.0 == 1 && counts.1 == 1 && counts.2 == 1, "restart uses exact status then content without re-signing")
            try require(try h.journal().operations.last!.key == original.key && h.journal().operations.last!.capability == original.capability, "lost delivery retains original key/capability")
        }
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }; await h.transport.configure(loseSign: true, noIssue: true)
            let repo = h.repository(); _ = try await repo.bootstrap()
            try await fails("lost no-issuance reply stays pending", expected: .issuanceUnconfirmed) { _ = try await repo.prepareDownload(photo, purpose: .share) }
            try await fails("not-issued status stops the current action", expected: .notIssued) { _ = try await repo.prepareDownload(photo, purpose: .share, explicitNewAction: true) }
            try require(try h.journal().operations.last!.phase == .notIssued, "terminal not-issued omits issuance dates")
            try await fails("automatic retry cannot replace not-issued", expected: .notIssued) { _ = try await repo.prepareDownload(photo, purpose: .share) }
            await h.transport.configure()
            _ = try await repo.prepareDownload(photo, purpose: .share, explicitNewAction: true)
            let counts = await h.transport.counts(); try require(counts.0 == 2, "next explicit action may create a fresh request")
        }
        for (field, value) in [("account_id", WireValue.string(DownloadFixture.renewed)), ("operation_key", .string(DownloadFixture.renewed)),
            ("original_session_id", .string(DownloadFixture.renewed)), ("asset_id", .string(DownloadFixture.renewed)), ("source_version", .string("changed")),
            ("protocol", .string("legacy")), ("download_url", .string("https://untrusted.invalid")), ("expires_at", .number(9_007_199_254_740_992))] {
            let h = try DownloadHarness.make(); defer { h.cleanup() }; await h.transport.configure(change: (field, value))
            let repo = h.repository(); _ = try await repo.bootstrap()
            try await fails("response substitution rejected: " + field) { _ = try await repo.prepareDownload(photo, purpose: .bytes) }
            try require(try h.journal().operations.last!.phase == .signing, "invalid reply never becomes a recorded delivery: " + field)
        }
        for fault in ["hash", "length", "mime", "source"] {
            let h = try DownloadHarness.make(); defer { h.cleanup() }; await h.transport.configure(fault: fault)
            let repo = h.repository(); _ = try await repo.bootstrap()
            try await fails("corrupt content rejected: " + fault) { _ = try await repo.prepareDownload(photo, purpose: .bytes) }
            try require(try h.journal().operations.last!.phase == .contentStarted, "content failure remains distinct from downloaded/saved: " + fault)
        }
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }; await h.transport.configure(loseContent: true)
            let repo = h.repository(); _ = try await repo.bootstrap()
            try await fails("lost content reply preserves attempt", expected: .deliveryUnconfirmed) { _ = try await repo.prepareDownload(photo, purpose: .bytes) }
            let key = try h.journal().operations.last!.key
            let restarted = h.repository(); _ = try await restarted.bootstrap()
            _ = try await restarted.prepareDownload(photo, purpose: .bytes)
            let counts = await h.transport.counts(); try require(counts.0 == 1 && counts.1 == 1 && counts.2 == 2, "content loss retries same immutable content via status")
            try require(try h.journal().operations.last!.key == key, "content recovery keeps original key")
        }
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }
            // The fixture creates an unusable staging root, then repairs only
            // its own file. Production never cleans unknown installed files.
            let blocked = h.root.appendingPathComponent("blocked")
            try Data([1]).write(to: blocked)
            let broken = BackendRepository(origin: DownloadFixture.origin, transport: h.transport, secrets: h.vault, signer: DownloadSigner(), uploadFiles: NativeUploadPrivateFiles(root: blocked))
            _ = try await broken.bootstrap()
            try await fails("staging disk failure retains bound expected bytes") { _ = try await broken.prepareDownload(photo, purpose: .bytes) }
            try require(try h.journal().operations.last!.sha256 == NativeDownloadRecord.hash(DownloadFixture.bytes), "hash binding precedes staging write")
            try FileManager.default.removeItem(at: blocked)
            let restarted = BackendRepository(origin: DownloadFixture.origin, transport: h.transport, secrets: h.vault, signer: DownloadSigner(), uploadFiles: NativeUploadPrivateFiles(root: blocked))
            _ = try await restarted.bootstrap(); _ = try await restarted.prepareDownload(photo, purpose: .bytes)
            let counts = await h.transport.counts(); try require(counts.0 == 1, "staging recovery never signs another capability")
        }
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }
            let repo = h.repository(); _ = try await repo.bootstrap(); let prepared = try await repo.prepareDownload(photo, purpose: .photos)
            let key = try h.journal().operations.last!.key
            await repo.clearSession()
            try require(try h.journal().operations.last!.stagingRetired, "logout removes only known staged bytes and retains metadata")
            try await fails("old prepared bytes cannot trigger Photos after logout") { _ = try await repo.beginDownloadEffect(prepared) }
            try h.vault.write("credentials", data: JSONEncoder().encode(DownloadFixture.credentials(DownloadFixture.renewed)))
            let renewed = h.repository(); _ = try await renewed.bootstrap()
            let phase = try await renewed.downloadStatus(key: key); try require(phase == .staged, "renewed own-account session may inspect historical issuance")
            try await fails("renewed session cannot redeem original content") { _ = try await renewed.prepareDownload(photo, purpose: .photos) }
            let counts = await h.transport.counts(); try require(counts.0 == 1 && counts.2 == 1, "renewal never re-signs/redeems the old capability")
            await h.transport.suspendAudience(); _ = try? await renewed.requireAudience(.faceAuthentication)
            let retired = try await renewed.downloadStatus(key: key); try require(retired == .retired, "historical status remains available during audience hold")
        }
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }
            let repo = h.repository(); _ = try await repo.bootstrap(); let prepared = try await repo.prepareDownload(photo, purpose: .photos)
            let record = try h.journal().operations.last!
            let file = h.root.appendingPathComponent("download-staging-v2").appendingPathComponent(record.key + ".download")
            try Data([9, 8, 7]).write(to: file)
            try await fails("corrupt local staging cannot authorize an external effect") { _ = try await repo.beginDownloadEffect(prepared) }
            await repo.clearSession()
            try require(FileManager.default.fileExists(atPath: file.path), "cleanup preserves a replaced unverified file")
            try require(try h.journal().operations.last!.phase != .externalStarted, "corrupt staging never reaches external-start")
        }
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }
            let legacy = NativeOperationIntent(key: UUID().uuidString.lowercased(), accountID: DownloadFixture.account, source: "mixed-legacy-source", action: "download.sign",
                payload: .object(["asset_id": .string(DownloadFixture.asset)]), approvedPairs: nil, path: "/downloads/sign", method: "POST")
            let other = NativeOperationIntent(key: UUID().uuidString.lowercased(), accountID: DownloadFixture.account, source: "personal", action: "unrelated", payload: .object([:]), approvedPairs: nil)
            let old = try JSONEncoder().encode([legacy, other]); try h.vault.write("operation-intents", data: old); h.vault.failingSlot = "download-delivery-v2"
            try await fails("failed durable adoption cannot free legacy generic slot") { _ = try await h.repository().bootstrap() }
            try require(try h.vault.read("operation-intents") == old, "legacy evidence remains intact on adoption failure")
            h.vault.failingSlot = nil
            let repo = h.repository(); _ = try await repo.bootstrap()
            let generic = try JSONDecoder().decode([NativeOperationIntent].self, from: h.vault.read("operation-intents")!)
            try require(generic.count == 1 && generic.first!.key == other.key, "adoption removes only the exact legacy generic entries")
            try require(try h.journal().legacy.first!.key == legacy.key && h.journal().legacy.first!.source == legacy.source, "mixed legacy source remains unknown evidence, never v2 proof")
            let counts = await h.transport.counts(); try require(counts.0 == 0 && counts.1 == 0 && counts.2 == 0, "legacy adoption performs no lookup/sign/content")
        }
        do {
            let h = try DownloadHarness.make(); defer { h.cleanup() }; let gate = DownloadGate(); await h.transport.configure(gate: gate)
            let first = h.repository(), second = h.repository(); _ = try await first.bootstrap(); _ = try await second.bootstrap()
            let task = Task { try await first.prepareDownload(photo, purpose: .bytes) }
            await gate.waitUntilEntered()
            // Status may already see committed issuance, but cannot rewrite a
            // different record revision or create a second signing intent.
            _ = try? await second.prepareDownload(photo, purpose: .bytes)
            await gate.release(); _ = try? await task.value
            let counts = await h.transport.counts(); try require(try counts.0 == 1 && h.journal().operations.count == 1, "concurrent repositories share one CAS-bound signing intent")
        }
        print("Native download recovery checks passed: \(checks). Synthetic local evidence only.")
    }
}
