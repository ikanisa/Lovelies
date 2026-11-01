import Foundation
import CryptoKit
import Dispatch

// Controlled consumer regressions. No StoreKit transaction, Apple provider,
// Keychain, camera, hosted backend or physical device is qualified by this file.
private final class ReadinessVault: NativeSecretStore, @unchecked Sendable {
    let authorityNamespace = "fixture-" + UUID().uuidString.lowercased()
    private let lock = NSRecursiveLock()
    private var slots: [String: Data] = [:]
    struct Block: @unchecked Sendable { let started = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0) }
    private var blockedRead: (String, Block)?
    private var blockedWrite: (String, Block)?
    private var failRemoval = false
    func blockNextRead(_ name: String) -> Block { lock.lock(); defer { lock.unlock() }; let block = Block(); blockedRead = (name, block); return block }
    func blockNextWrite(_ name: String) -> Block { lock.lock(); defer { lock.unlock() }; let block = Block(); blockedWrite = (name, block); return block }
    func failCredentialRemoval(_ value: Bool) { lock.lock(); defer { lock.unlock() }; failRemoval = value }
    func read(_ name: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        if let (target, block) = blockedRead, target == name { blockedRead = nil; block.started.signal(); block.release.wait() }
        return slots[name]
    }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; slots[name] = data }
    func compareAndSwap(_ name: String, expected: Data?, replacement: Data?) throws -> Bool {
        lock.lock()
        if let (target, block) = blockedWrite, target == name {
            blockedWrite = nil; lock.unlock(); block.started.signal(); block.release.wait(); lock.lock()
        }
        defer { lock.unlock() }
        if name == "credentials", replacement == nil, failRemoval { throw NativeAPIError.unavailable("fixture_keychain_delete_failed") }
        guard slots[name] == expected else { return false }; slots[name] = replacement; return true
    }
}
private actor ReadinessReplyGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var reached = false
    private var observers: [CheckedContinuation<Void, Never>] = []
    func hold() async {
        reached = true; observers.forEach { $0.resume() }; observers = []
        await withCheckedContinuation { continuation = $0 }
    }
    func started() async { if !reached { await withCheckedContinuation { observers.append($0) } } }
    func release() { continuation?.resume(); continuation = nil }
}
private struct ReadinessSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { NativeAppleStoreJournal.digest(data) }
    func clear() {}
}
private enum ReadinessData {
    static let account = "00000000-0000-4000-8000-000000000101"
    static let session = "00000000-0000-4000-8000-000000000102"
    static let request = "00000000-0000-4000-8000-000000000103"
    static let delivery = "00000000-0000-4000-8000-000000000104"
    static let origin = URL(string: "https://readiness.invalid")!
    static let product = "com.lovelies.memories.pro.monthly"
    static let export = Data("{\"synthetic_export\":true}".utf8)
    static func credential(suffix: String = "first", method: String = "registered_face") throws -> NativeCredentials {
        let claims: WireValue = .object(["sub": .string(account), "jti": .string(session), "auth_method": .string(method), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + "." + suffix), "refresh_token": .string("fixture-refresh-" + suffix),
            "account_id": .string(account), "auth_method": .string(method), "expires_in": .integer(900), "roles": .strings(["user"])]))
    }
    static func signed(transaction: String = "100") throws -> String {
        let claims: WireValue = .object(["productId": .string(product), "transactionId": .string(transaction), "originalTransactionId": .string("90"),
            "environment": .string("Sandbox"), "appAccountToken": .string(account)])
        return "fixture." + (try claims.encoded()).base64URL + ".signature"
    }
    static func result(_ journal: NativeAppleStoreJournal, newer: Bool = true) -> WireValue {
        .object(["provider": .string("apple_app_store"), "product_id": .string(journal.productID), "transaction_id": .string(newer ? "200" : journal.transactionID),
            "original_transaction_id": .string(journal.originalTransactionID), "billing_environment": .string("sandbox"), "financial_eligible": .bool(false),
            "active": .bool(false), "stale": .bool(newer), "expires_at": .string("2026-01-01T00:00:00.000Z"),
            "verified_submission": .object(["protocol": .string("lovelies-apple-submission-v2"), "product_id": .string(journal.productID),
                "transaction_id": .string(journal.transactionID), "original_transaction_id": .string(journal.originalTransactionID),
                "billing_environment": .string(journal.environment), "credential_sha256": .string(journal.credentialHash)])])
    }
    static func receipt(_ journal: NativeAppleStoreJournal) throws -> WireValue {
        .object(["protocol": .string("lovelies-store-operation-receipt-v1"), "actor_id": .string(journal.accountID), "operation_key": .string(journal.operationKey),
            "status": .string("committed"), "action": .string("store.apple"), "source": .string("store"), "input_scheme": .string("digest-v1"),
            "credential_sha256": .string(journal.credentialHash), "payload_hash": .string(try journal.inputHash(scheme: "digest-v1")),
            "receipt_scope": .string("historical"), "result": result(journal)])
    }
    static func delivery(_ journal: NativeExportDeliveryJournal, acknowledged: Bool = false) -> WireValue {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return .object(["protocol": .string("lovelies-privacy-export-delivery-v2"), "operation_key": .string(journal.operationKey), "request_id": .string(journal.requestID),
            "delivery_id": .string(delivery), "account_id": .string(journal.accountID), "session_id": .string(journal.sessionID),
            "state": .string(acknowledged ? "acknowledged" : "available"), "expires_at": .string(formatter.string(from: journal.preparedAt.addingTimeInterval(300))),
            "sha256": .string(NativeAppleStoreJournal.digest(export)), "bytes": .integer(export.count),
            "retrieve_path": .string("/privacy-exports/deliveries/" + delivery), "ack_path": .string("/privacy-exports/deliveries/" + delivery + "/ack")])
    }
}
private actor ReadinessTransport: NativeTransport {
    let vault: ReadinessVault
    private var store: NativeAppleStoreJournal?
    private var lostStoreReply = true, lostStoreLookup = true
    private var audienceVersion = 1
    private var profileCommittedKey: String?
    private var exportJournal: NativeExportDeliveryJournal?
    private var exportAcknowledged = false
    private var loseExportCreate = true, loseExportRead = true, loseExportAck = true
    private var anonymousGate: ReadinessReplyGate?
    private(set) var storePosts = 0, storeLookups = 0, genericStoreLookups = 0
    private(set) var exportReads = 0, exportAcks = 0
    init(vault: ReadinessVault) { self.vault = vault }
    nonisolated func cancelPending() {}
    func seedStore(_ journal: NativeAppleStoreJournal) { store = journal; lostStoreReply = false; lostStoreLookup = false }
    func delayAnonymous(_ gate: ReadinessReplyGate) { anonymousGate = gate }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path, body = try request.httpBody.map(WireValue.decoded) ?? .null
        func json(_ value: WireValue) throws -> NativeHTTPReply { .init(status: 200, headers: ["content-type": "application/json"], data: try value.encoded()) }
        switch path {
        case "/auth/anonymous":
            if let anonymousGate { await anonymousGate.hold() }
            let value = try ReadinessData.credential(suffix: "anonymous", method: "anonymous")
            return try json(.object(["access_token": .string(value.access_token), "refresh_token": .string(value.refresh_token), "account_id": .string(value.account_id),
                "auth_method": .string(value.auth_method), "roles": .strings(value.roles), "expires_in": .integer(value.expires_in)]))
        case "/auth/logout": return try json(.object(["logged_out": .bool(true)]))
        case "/me": return try json(.object(["user_id": .string(ReadinessData.account), "auth_method": .string("registered_face"), "authenticated": .bool(true)]))
        case "/me/audience":
            return try json(.object(["protocol": .string(NativeAudienceProjection.protocolName), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(ReadinessData.account),
                "audience": .object(["at_least_13": .bool(true), "guardian_required": .bool(false), "status": .string("eligible"), "version": .integer(audienceVersion), "policy_version": .string(NativeAudienceProjection.policy), "source": .string("self_declaration"), "rule_version": .string("audience-13-plus-guardian-v1"), "territory": .string("global"), "declared_at": .string(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-60))), "next_review_at": .string(ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))), "review_required": .bool(false)]),
                "authority_expires_at": .string(ISO8601DateFormatter().string(from: Date().addingTimeInterval(3500))), "guardian_request": .null, "capabilities": .object(["face_authentication": .bool(true), "photo_matching": .bool(true), "photo_processing": .bool(true)])]))
        case "/subscriptions/apple/transactions":
            storePosts += 1
            let journal = try NativeAppleStoreJournal(origin: ReadinessData.origin, account: ReadinessData.account, product: body.text("product_id"),
                transaction: "100", original: "90", signedTransaction: body.text("signed_transaction", maximum: 32768), operationKey: body.text("operation_key"))
            if let store { guard store.request == journal.request else { throw NativeAPIError.invalidResponse } } else { store = journal }
            if lostStoreReply { lostStoreReply = false; throw NativeAPIError.unavailable("fixture_lost_committed_reply") }
            return try json(ReadinessData.result(journal))
        case "/me/store-operations":
            storeLookups += 1
            if lostStoreLookup { lostStoreLookup = false; throw NativeAPIError.unavailable("fixture_status_outage") }
            guard let store, body["operation_key"].string == store.operationKey else { throw NativeAPIError.invalidResponse }
            return try json(ReadinessData.receipt(store))
        case "/me/profile":
            profileCommittedKey = try body.text("operation_key"); audienceVersion += 1
            return try json(.object(["saved": .bool(true)]))
        case "/community/action":
            guard body["action"].string == "operation" else { throw NativeAPIError.invalidResponse }
            if body["payload"]["operation_key"].string == store?.operationKey { genericStoreLookups += 1; throw NativeAPIError.invalidResponse }
            guard body["payload"]["operation_key"].string == profileCommittedKey else { throw NativeAPIError.invalidResponse }
            return try json(.object(["saved": .bool(true)]))
        case "/privacy-exports/" + ReadinessData.request + "/deliveries":
            let stored = try JSONDecoder().decode([NativeExportDeliveryJournal].self, from: vault.read("export-deliveries-v2")!)
            guard let journal = stored.first(where: { $0.operationKey == body["operation_key"].string }), journal.operationKey != journal.acknowledgementKey else { throw NativeAPIError.invalidResponse }
            if let exportJournal { guard exportJournal.operationKey == journal.operationKey else { throw NativeAPIError.invalidResponse } } else { exportJournal = journal }
            if loseExportCreate { loseExportCreate = false; throw NativeAPIError.unavailable("fixture_lost_delivery_reply") }
            return try json(ReadinessData.delivery(exportJournal!, acknowledged: exportAcknowledged))
        case "/privacy-exports/deliveries/" + ReadinessData.delivery:
            exportReads += 1
            guard !exportAcknowledged else { throw NativeAPIError.invalidResponse }
            if loseExportRead { loseExportRead = false; throw NativeAPIError.unavailable("fixture_lost_export_bytes") }
            return NativeHTTPReply(status: 200, headers: ["content-type": "application/json"], data: ReadinessData.export)
        case "/privacy-exports/deliveries/" + ReadinessData.delivery + "/ack":
            exportAcks += 1
            guard let journal = exportJournal, body["operation_key"].string == journal.acknowledgementKey,
                  body["sha256"].string == NativeAppleStoreJournal.digest(ReadinessData.export) else { throw NativeAPIError.invalidResponse }
            exportAcknowledged = true
            if loseExportAck { loseExportAck = false; throw NativeAPIError.unavailable("fixture_lost_ack_reply") }
            return try json(.object(["acknowledged": .bool(true), "delivery_id": .string(ReadinessData.delivery), "request_id": .string(ReadinessData.request)]))
        default: throw NativeAPIError.invalidResponse
        }
    }
}

private struct ReadinessChunkedExport: Sendable {
    let data: Data, hash: String, root: String, pages: [Int: WireValue], count: Int
    let publication = "00000000-0000-4000-8000-000000000105"
    init(size: Int = 21 * 1024 * 1024 + 19) throws {
        var bytes = Data(repeating: 0x61, count: size)
        bytes.replaceSubrange(0..<10, with: Data("{\"value\":\"".utf8))
        bytes.replaceSubrange((bytes.count - 2)..<bytes.count, with: Data("\"}".utf8))
        bytes[1048575] = 0xe2; bytes[1048576] = 0x82; bytes[1048577] = 0xac
        data = bytes; hash = NativeAppleStoreJournal.digest(bytes); count = (bytes.count + 1048575) / 1048576
        var previous = try NativeExportManifestPage.seed(.object(["publication_id": .string(publication)])), descriptors: [WireValue] = []
        let seed = previous
        for index in 0..<count {
            let chunk = bytes.subdata(in: (index * 1048576)..<min(bytes.count, (index + 1) * 1048576)), digest = NativeAppleStoreJournal.digest(chunk)
            previous = try NativeExportManifestPage.nextRoot(previous, index: index, bytes: chunk.count, hash: digest)
            descriptors.append(.object(["index": .integer(index), "bytes": .integer(chunk.count), "sha256": .string(digest), "root_sha256": .string(previous),
                "retrieve_path": .string("/privacy-exports/deliveries/\(ReadinessData.delivery)/chunks/\(index)")]))
        }
        root = previous; var result: [Int: WireValue] = [:]
        for offset in stride(from: 0, to: count, by: 128) {
            let rows = Array(descriptors[offset..<min(count, offset + 128)])
            result[offset] = .object(["protocol": .string("lovelies-privacy-export-manifest-v1"), "publication_id": .string(publication),
                "total_bytes": .integer(bytes.count), "sha256": .string(hash), "chunk_count": .integer(count), "chunk_bytes": .integer(1048576),
                "manifest_sha256": .string(root), "offset": .integer(offset), "next_offset": offset + rows.count < count ? .integer(offset + rows.count) : .null,
                "previous_root": .string(offset == 0 ? seed : descriptors[offset - 1]["root_sha256"].string!), "chunks": .array(rows)])
        }
        pages = result
    }
    func delivery(_ journal: NativeExportDeliveryJournal, acknowledged: Bool) -> WireValue {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return .object(["protocol": .string("lovelies-privacy-export-delivery-v3"), "operation_key": .string(journal.operationKey), "request_id": .string(journal.requestID),
            "delivery_id": .string(ReadinessData.delivery), "account_id": .string(journal.accountID), "session_id": .string(journal.sessionID),
            "state": .string(acknowledged ? "acknowledged" : "available"), "expires_at": .string(formatter.string(from: journal.preparedAt.addingTimeInterval(300))),
            "sha256": .string(hash), "bytes": .integer(data.count), "retrieve_path": .string("/privacy-exports/deliveries/\(ReadinessData.delivery)/manifest?offset=0"),
            "ack_path": .string("/privacy-exports/deliveries/\(ReadinessData.delivery)/ack"), "publication_id": .string(publication),
            "chunk_count": .integer(count), "chunk_bytes": .integer(1048576), "manifest_sha256": .string(root)])
    }
}
private actor ReadinessChunkTransport: NativeTransport {
    let vault: ReadinessVault, fixture: ReadinessChunkedExport, fallback: ReadinessTransport
    var acknowledged = false, lostChunk = false, lostAck = false
    private(set) var chunkReads: [Int] = [], manifestReads = 0, acknowledgementKeys: [String] = []
    init(vault: ReadinessVault, fixture: ReadinessChunkedExport) { self.vault = vault; self.fixture = fixture; fallback = ReadinessTransport(vault: vault) }
    nonisolated func cancelPending() {}
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path
        func json(_ value: WireValue) throws -> NativeHTTPReply { .init(status: 200, headers: ["content-type": "application/json"], data: try value.encoded()) }
        if !path.hasPrefix("/privacy-exports/") { return try await fallback.send(request, limit: limit) }
        guard let bytes = try vault.read("export-deliveries-v2"), let journal = try JSONDecoder().decode([NativeExportDeliveryJournal].self, from: bytes).first else { throw NativeAPIError.invalidResponse }
        if path == "/privacy-exports/\(ReadinessData.request)/deliveries" { return try json(fixture.delivery(journal, acknowledged: acknowledged)) }
        if path.hasSuffix("/manifest") {
            guard !acknowledged, let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems,
                  let text = query.first(where: { $0.name == "offset" })?.value, let offset = Int(text), let page = fixture.pages[offset] else { throw NativeAPIError.invalidResponse }
            manifestReads += 1; return try json(page)
        }
        if path.contains("/chunks/") {
            guard !acknowledged, limit == 1048576, let index = Int(path.split(separator: "/").last!) else { throw NativeAPIError.invalidResponse }
            chunkReads.append(index)
            if index == 1, !lostChunk { lostChunk = true; throw NativeAPIError.unavailable("lost_chunk_reply") }
            return .init(status: 200, headers: ["content-type": "application/octet-stream"], data: fixture.data.subdata(in: (index * 1048576)..<min(fixture.data.count, (index + 1) * 1048576)))
        }
        if path.hasSuffix("/ack") {
            let body = try WireValue.decoded(request.httpBody!)
            guard journal.staged, body["sha256"].string == fixture.hash, body["operation_key"].string == journal.acknowledgementKey else { throw NativeAPIError.invalidResponse }
            acknowledgementKeys.append(journal.acknowledgementKey); acknowledged = true
            if !lostAck { lostAck = true; throw NativeAPIError.unavailable("lost_ack_reply") }
            return try json(.object(["acknowledged": .bool(true), "request_id": .string(journal.requestID), "delivery_id": .string(ReadinessData.delivery)]))
        }
        throw NativeAPIError.invalidResponse
    }
}

@main struct NativeReadinessRecoveryTests {
    static var checks = 0
    static func expect(_ condition: Bool, _ message: String) throws {
        guard condition else { throw NativeAPIError.unsupported("Readiness regression: " + message) }; checks += 1
    }
    static func rejects(_ message: String, _ body: () throws -> Void) throws {
        do { try body() } catch { checks += 1; return }
        throw NativeAPIError.unsupported("Missing rejection: " + message)
    }
    static func main() async throws {
        try contracts()
        try await completeStoreJournalMigration()
        try await recovery()
        try await nonblockingRetirement()
        try authorityReservations()
        try await durableWriterRetirement()
        try await chunkedExports()
        try interruptedAssembly()
        print("Native readiness recovery checks passed: \(checks)")
    }
    static func authorityReservations() throws {
        let vault = ReadinessVault(), origin = ReadinessData.origin
        let ledger = NativeAuthorityLedger(store: vault, origin: origin); try ledger.restore()
        let first = NativeOwnedSecretStore(base: vault, ledger: ledger)
        let old: WireValue = .object(["challenge_id": .string("old-challenge"), "rotation_key": .string("old-rotation")])
        try first.write("ordinary-face-login-journal", data: old.encoded())
        let generation = ledger.clock.advance(); try ledger.persistRetirement(generation)
        let restored = NativeAuthorityLedger(store: vault, origin: origin); try restored.restore()
        try expect(!restored.permitsRequest(old), "retirement blocks challenge and refresh replay across repository restart")
        let fresh: WireValue = .object(["challenge_id": .string("fresh-challenge")])
        let second = NativeOwnedSecretStore(base: vault, ledger: restored)
        _ = try second.read("ordinary-face-login-journal"); try second.write("ordinary-face-login-journal", data: fresh.encoded())
        // A delayed retry of the same retirement cannot retire a new-generation challenge.
        try ledger.persistRetirement(generation)
        try expect(restored.permitsRequest(fresh), "late retirement confirmation preserves a later fresh challenge")
        try rejects("an old repository cannot overwrite a competing journal") { try first.write("ordinary-face-login-journal", data: old.encoded()) }
        try expect(try vault.read("ordinary-face-login-journal") == fresh.encoded(), "failed CAS preserves the newer exact journal")
        try vault.write("face-profile-lifecycle", data: WireValue.object(["challenge_id": .string("unreserved-late-challenge")]).encoded())
        let restarted = NativeAuthorityLedger(store: vault, origin: origin); try restarted.restore()
        try expect(!restarted.permitsRequest(.object(["challenge_id": .string("unreserved-late-challenge")])), "late unreserved old journal cannot be relabelled as current authority")
        try expect(WireValue.number(Double(Int.max)).integer == nil, "integer overflow is rejected without trapping")
        let coldVault = ReadinessVault()
        let marker = "session-authority-v1-" + NativeAppleStoreJournal.digest(Data(origin.absoluteString.utf8))
        try coldVault.write(marker, data: WireValue.object(["version": .integer(1), "origin": .string(origin.absoluteString), "generation": .integer(7),
            "challenges": .array([]), "rotations": .array([])]).encoded())
        let cold = NativeAuthorityLedger(store: coldVault, origin: origin), coldFence = NativeSessionRetirementFence(clock: NativeAuthorityClock.shared(coldVault.authorityNamespace + ":" + origin.absoluteString))
        let proposed = coldFence.retire(), actual = try cold.persistRetirement(proposed)
        try expect(actual == 8 && cold.clock.snapshot() == 8, "retirement before bootstrap advances the durable generation rather than resetting it")
    }
    static func durableWriterRetirement() async throws {
        let vault = ReadinessVault()
        let authority = NativeAuthorityLedger(store: vault, origin: ReadinessData.origin); try authority.restore()
        let writer = NativeOwnedSecretStore(base: vault, ledger: authority), fence = NativeSessionRetirementFence(clock: authority.clock)
        let data = try WireValue.object(["challenge_id": .string("blocked-before-retirement"), "completionPending": .bool(true)]).encoded()
        let block = vault.blockNextWrite("ordinary-face-login-journal")
        let oldWrite = Task.detached { Result { try writer.write("ordinary-face-login-journal", data: data) } }
        let started = await withCheckedContinuation { continuation in
            DispatchQueue.global().async { continuation.resume(returning: block.started.wait(timeout: .now() + 5) == .success) }
        }
        guard started else { block.release.signal(); throw NativeAPIError.unavailable("fixture_write_not_blocked") }
        let generation = fence.retire()
        do { try authority.persistRetirement(generation) } catch { block.release.signal(); throw error }
        // Independent marker durability and the publication fence complete while
        // the old ordinary journal write is still physically blocked.
        try expect(!fence.permits(generation - 1), "retirement does not wait for a blocked journal writer")
        block.release.signal()
        switch await oldWrite.value { case .failure: checks += 1; case .success: throw NativeAPIError.invalidResponse }
        try expect(try vault.read("ordinary-face-login-journal") == data, "late durable evidence is retained even though publication was rejected")
        let restarted = NativeAuthorityLedger(store: vault, origin: ReadinessData.origin); try restarted.restore()
        try expect(!restarted.permitsRequest(.object(["challenge_id": .string("blocked-before-retirement")])), "restart cannot replay a challenge from a late old-generation write")
    }
    static func chunkedExports() async throws {
        let vault = ReadinessVault(), fixture = try ReadinessChunkedExport(), transport = ReadinessChunkTransport(vault: vault, fixture: fixture)
        try vault.write("credentials", data: JSONEncoder().encode(ReadinessData.credential()))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-chunk-regression-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        func repository() -> BackendRepository { BackendRepository(origin: ReadinessData.origin, transport: transport, secrets: vault, signer: ReadinessSigner(), exportFiles: .init(directory: directory)) }
        let first = repository(); _ = try await first.bootstrap()
        do { _ = try await first.exportFile(requestID: ReadinessData.request); throw NativeAPIError.invalidResponse } catch NativeAPIError.unavailable { checks += 1 }
        let second = repository(); _ = try await second.bootstrap()
        do { _ = try await second.exportFile(requestID: ReadinessData.request); throw NativeAPIError.invalidResponse } catch NativeAPIError.unavailable { checks += 1 }
        let third = repository(); _ = try await third.bootstrap()
        let delivery = try await third.exportFile(requestID: ReadinessData.request)
        try expect(try delivery.file.resourceValues(forKeys: [.fileSizeKey]).fileSize == fixture.data.count, "large export is published as an exact protected file")
        let reads = await transport.chunkReads, keys = await transport.acknowledgementKeys
        try expect(reads.filter { $0 == 0 }.count == 1 && reads.filter { $0 == 1 }.count == 2 && reads.count == fixture.count + 1, "restart downloads only the missing chunk")
        try expect(await transport.manifestReads == 1 && keys.count == 2 && Set(keys).count == 1, "lost ACK resumes from protected files with its original identity")
        var journal = try JSONDecoder().decode([NativeExportDeliveryJournal].self, from: vault.read("export-deliveries-v2")!).first!
        let proof = journal.delivery!, page = fixture.pages[0]!
        _ = try NativeExportManifestPage(page, delivery: proof, offset: 0, previous: NativeExportManifestPage.seed(proof)); checks += 1
        var malformed = page.object!; malformed["next_offset"] = .integer(128)
        try rejects("manifest cannot invent a continuation") { _ = try NativeExportManifestPage(.object(malformed), delivery: proof, offset: 0, previous: NativeExportManifestPage.seed(proof)) }
        let files = NativeExportStagingFiles(directory: directory), firstID = try journal.childFileID(kind: "chunk", index: 0)
        try files.remove(firstID)
        do { _ = try await third.exportFile(requestID: ReadinessData.request); throw NativeAPIError.invalidResponse } catch NativeAPIError.unavailable { checks += 1 }
        try expect(await transport.chunkReads == reads, "missing acknowledged bytes do not reread a retired publication")
        journal.delivery = fixture.delivery(journal, acknowledged: true)
        try rejects("large delivery cannot exceed its one-hour local lifetime") { try journal.requireLive(now: journal.preparedAt.addingTimeInterval(3601)) }
        try await third.logout()
        try expect(!FileManager.default.fileExists(atPath: delivery.file.path), "logout removes a verified complete export even when one cached chunk is missing")
    }
    static func interruptedAssembly() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-assembly-regression-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let files = NativeExportStagingFiles(directory: directory), id = UUID().uuidString.lowercased()
        let pieces = [Data(repeating: 0x61, count: 1048576), Data(repeating: 0x62, count: 17)], bytes = pieces.reduce(0) { $0 + $1.count }
        let hash = NativeAppleStoreJournal.digest(pieces.reduce(Data(), +))
        try rejects("interrupted assembly preserves its verified prefix") {
            _ = try files.assemble(id: id, bytes: bytes, hash: hash, current: {}) { sink in try sink(pieces[0]); throw NativeAPIError.unavailable("interrupted") }
        }
        let file = try files.assemble(id: id, bytes: bytes, hash: hash, current: {}) { sink in for piece in pieces { try sink(piece) } }
        try expect(try file.resourceValues(forKeys: [.fileSizeKey]).fileSize == bytes, "assembly resumes a validated prefix")
        let handle = try FileHandle(forUpdating: file); try handle.write(contentsOf: Data([0])); try handle.close()
        try rejects("corrupt assembled prefix is preserved without truncation") { _ = try files.assemble(id: id, bytes: bytes, hash: hash, current: {}) { sink in for piece in pieces { try sink(piece) } } }
        try expect(try Data(contentsOf: file).first == 0, "rejected assembly leaves unknown bytes intact")
    }
    static func contracts() throws {
        let journal = try NativeAppleStoreJournal(origin: ReadinessData.origin, account: ReadinessData.account, product: ReadinessData.product,
            transaction: "100", original: "90", signedTransaction: ReadinessData.signed())
        let receipt = try ReadinessData.receipt(journal)
        let historical = try journal.receiptResult(receipt)
        try expect(historical?["active"].bool == false && historical?["transaction_id"].string == "200", "older verified submission must not revive a newer revoked entitlement")
        for (field, wrong) in [("actor_id", WireValue.string(UUID().uuidString)), ("operation_key", .string(UUID().uuidString)),
                               ("payload_hash", .string(String(repeating: "0", count: 64))), ("credential_sha256", .string(String(repeating: "0", count: 64))), ("receipt_scope", .string("current"))] {
            var mutated = receipt.object!; mutated[field] = wrong
            try rejects("store receipt " + field) { _ = try journal.receiptResult(.object(mutated)) }
        }
        var current = ReadinessData.result(journal).object!, binding = current["verified_submission"]!.object!
        binding["transaction_id"] = .string("999"); current["verified_submission"] = .object(binding)
        try rejects("submission must name exact transaction") { try journal.validateResult(.object(current)) }
        current.removeValue(forKey: "verified_submission")
        try rejects("newer current transaction is not a legacy submission receipt") { try journal.validateResult(.object(current)) }
        current["transaction_id"] = .string("100"); try journal.validateResult(.object(current)); checks += 1
        let unknown: WireValue = .object(["protocol": receipt["protocol"], "actor_id": receipt["actor_id"], "operation_key": receipt["operation_key"], "status": .string("unknown")])
        try expect(try journal.receiptResult(unknown) == nil, "unknown is unresolved, not success")
        var extra = unknown.object!; extra["result"] = ReadinessData.result(journal)
        try rejects("unknown cannot smuggle a result") { _ = try journal.receiptResult(.object(extra)) }
        var durable = journal; durable.receipt = receipt; durable.phase = .finishPending
        let restored = try JSONDecoder().decode(NativeAppleStoreJournal.self, from: JSONEncoder().encode(durable))
        try restored.validate(origin: ReadinessData.origin)
        try expect(restored == durable, "finish interruption preserves exact receipt and original credential")
        try rejects("another deployment cannot consume store evidence") { try restored.validate(origin: URL(string: "https://other.invalid")!) }

        var delivery = NativeExportDeliveryJournal(origin: ReadinessData.origin, account: ReadinessData.account, session: ReadinessData.session, request: ReadinessData.request)
        delivery.delivery = ReadinessData.delivery(delivery); try delivery.validate(origin: ReadinessData.origin); try delivery.validateBytes(ReadinessData.export)
        try expect(delivery.operationKey != delivery.acknowledgementKey, "create and ACK retain separate operation identities")
        for field in ["request_id", "session_id", "account_id", "operation_key", "delivery_id"] {
            var value = delivery.delivery!.object!; value[field] = .string(UUID().uuidString.lowercased())
            try rejects("delivery binds " + field) { try delivery.validateDelivery(.object(value)) }
        }
        var redirected = delivery.delivery!.object!; redirected["retrieve_path"] = .string("https://other.invalid/export?grant=secret")
        try rejects("no capability or off-origin retrieval") { try delivery.validateDelivery(.object(redirected)) }
        try rejects("different bytes cannot be acknowledged") { try delivery.validateBytes(Data("wrong".utf8)) }
        try rejects("expired staging cannot publish") { try delivery.requireLive(now: delivery.preparedAt.addingTimeInterval(301)) }
        delivery.acknowledged = true
        try rejects("ACK without a staged copy is invalid") { try delivery.validate(origin: ReadinessData.origin) }
        delivery.staged = true
        var acknowledged = delivery.delivery!.object!; acknowledged["state"] = .string("acknowledged"); delivery.delivery = .object(acknowledged)
        try delivery.validate(origin: ReadinessData.origin)
        let resumed = try JSONDecoder().decode(NativeExportDeliveryJournal.self, from: JSONEncoder().encode(delivery))
        try expect(resumed.operationKey == delivery.operationKey && resumed.acknowledgementKey == delivery.acknowledgementKey && resumed.fileID == delivery.fileID, "all handoff identities survive restart")

        let one: WireValue = .object(["id": .string(ReadinessData.account), "source": .string("personal")])
        let two: WireValue = .object(["id": .string(ReadinessData.request), "source": .string("personal")])
        let page = try NativeAccountPage(.object(["items": .array([one, two]), "page": .object(["limit": .integer(25), "total": .integer(150), "next_cursor": .string("opaque+&?/cursor")])]), personalOnly: true)
        try expect(page.appending(to: [one]).count == 2 && page.nextCursor != nil, "history beyond 100 can append without duplicate rows")
        let encoded = try NativeAccountPage.path("/me/notifications", cursor: page.nextCursor)
        try expect(URLComponents(string: encoded)?.queryItems?.first(where: { $0.name == "cursor" })?.value == page.nextCursor, "opaque cursor retains exact value")
        try rejects("duplicate page IDs fail closed") { _ = try NativeAccountPage(.object(["items": .array([one, one])])) }
        let legacy = (0..<100).map { number in WireValue.object(["id": .string(String(format: "00000000-0000-4000-8000-%012d", number))]) }
        try rejects("capped legacy history cannot claim completion") { _ = try NativeAccountPage(.object(["items": .array(legacy)])) }
    }
    static func completeStoreJournalMigration() async throws {
        let vault = ReadinessVault(), transport = ReadinessTransport(vault: vault)
        let credential = try ReadinessData.credential()
        try vault.write("credentials", data: JSONEncoder().encode(credential))
        var old = try NativeAppleStoreJournal(origin: ReadinessData.origin, account: ReadinessData.account, product: ReadinessData.product,
            transaction: "100", original: "90", signedTransaction: ReadinessData.signed())
        old.receipt = try ReadinessData.receipt(old); old.phase = .finished
        try vault.write(old.slot, data: JSONEncoder().encode(old)); await transport.seedStore(old)
        let repository = BackendRepository(origin: ReadinessData.origin, transport: transport, secrets: vault, signer: ReadinessSigner())
        _ = try await repository.bootstrap()
        let migrated = try await repository.verifyApplePurchase(account: ReadinessData.account, product: ReadinessData.product,
            transaction: "100", original: "90", environment: "sandbox", signedTransaction: ReadinessData.signed())
        try expect(migrated.operationKey == old.operationKey && migrated.credentialSHA256 == old.credentialHash, "Complete StoreKit journal migrates exact key and original credential binding")
        try expect(migrated.finished && migrated.receipt == old.receipt, "StoreKit finish and typed receipt survive migration")
        try expect(migrated.createdAt == old.preparedAt && migrated.signedTransaction == nil && vault.read(old.slot) == nil,
                   "durable migration keeps original chronology and removes the superseded signed credential copy")
        try expect(await transport.storePosts == 0, "migration reconciles without a second verification POST")
    }
    static func recovery() async throws {
        let vault = ReadinessVault(), transport = ReadinessTransport(vault: vault)
        let credential = try ReadinessData.credential(); try vault.write("credentials", data: JSONEncoder().encode(credential))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-readiness-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        func repository() -> BackendRepository { BackendRepository(origin: ReadinessData.origin, transport: transport, secrets: vault, signer: ReadinessSigner(), exportFiles: NativeExportStagingFiles(directory: directory)) }
        let first = repository(); _ = try await first.bootstrap()
        do { _ = try await first.verifyAppleTransaction(product: ReadinessData.product, transaction: "100", original: "90", signedTransaction: ReadinessData.signed()); throw NativeAPIError.invalidResponse }
        catch NativeAPIError.unavailable { checks += 1 }
        let restarted = repository(); _ = try await restarted.bootstrap()
        let response = try await restarted.verifyAppleTransaction(product: ReadinessData.product, transaction: "100", original: "90", signedTransaction: ReadinessData.signed())
        try expect(response["active"].bool == false, "typed historical recovery does not grant current originals")
        let storePosts = await transport.storePosts, genericLookups = await transport.genericStoreLookups
        try expect(storePosts == 1 && genericLookups == 0, "restart uses typed lookup without duplicate POST or generic store lookup")
        try expect(await restarted.pending().isEmpty, "store recovery does not block unrelated generic editing")
        try await restarted.markAppleTransactionFinishing(transaction: "100")
        let finishRestart = repository(); _ = try await finishRestart.bootstrap()
        _ = try await finishRestart.verifyAppleTransaction(product: ReadinessData.product, transaction: "100", original: "90", signedTransaction: ReadinessData.signed())
        try await finishRestart.markAppleTransactionFinishing(transaction: "100", completed: true)

        do { _ = try await finishRestart.post("/me/profile", payload: .object(["name": .string("Synthetic")]), operation: "account.profile.update", method: "PATCH"); throw NativeAPIError.invalidResponse }
        catch NativeAPIError.operationUnconfirmed { checks += 1 }
        let beforeRetirement = try JSONDecoder().decode([NativeOperationIntent].self, from: vault.read("operation-intents")!)
        try expect(beforeRetirement.count == 1, "post-2xx audience change preserves original mutation")
        let newer = try ReadinessData.credential(suffix: "newer"), newerBytes = try JSONEncoder().encode(newer)
        try vault.write("credentials", data: newerBytes)
        let other = NativeOperationIntent(key: UUID().uuidString.lowercased(), accountID: UUID().uuidString.lowercased(), source: "personal", action: "fixture", payload: .object([:]), approvedPairs: nil)
        try vault.write("operation-intents", data: JSONEncoder().encode(beforeRetirement + [other]))
        try vault.write("upload-stages", data: Data("[]".utf8))
        await finishRestart.clearSession()
        try expect(try vault.read("credentials") == newerBytes, "old retirement cannot erase newer same-account credential")
        try expect(try JSONDecoder().decode([NativeOperationIntent].self, from: vault.read("operation-intents")!).count == 2, "retirement preserves both instances' unresolved evidence")
        try expect(try vault.read("upload-stages") != nil, "retirement preserves upload-stage evidence")
        let current = repository(); _ = try await current.bootstrap()
        _ = try await current.reconcile()
        let surviving = try JSONDecoder().decode([NativeOperationIntent].self, from: vault.read("operation-intents")!)
        try expect(surviving == [other], "confirmation removes only its original record")

        // Lose create, bytes and ACK replies on successive restart attempts.
        for _ in 0..<3 {
            let attempt = repository(); _ = try await attempt.bootstrap()
            do { _ = try await attempt.exportBytes(requestID: ReadinessData.request); throw NativeAPIError.invalidResponse }
            catch NativeAPIError.unavailable { checks += 1 }
        }
        let exportRestart = repository(); _ = try await exportRestart.bootstrap()
        let delivered = try await exportRestart.exportBytes(requestID: ReadinessData.request)
        try expect(delivered.bytes == ReadinessData.export, "ACK reply loss recovers the exact durable staged export")
        let reads = await transport.exportReads, acks = await transport.exportAcks
        try expect(reads == 2 && acks == 2, "lost GET repeats before ACK; lost ACK replays without reading consumed bytes")
        await exportRestart.clearSession()
        try expect((try? FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty) == true, "logout removes only owned staged export files")
    }
    static func nonblockingRetirement() async throws {
        let vault = ReadinessVault(), transport = ReadinessTransport(vault: vault)
        try vault.write("credentials", data: JSONEncoder().encode(ReadinessData.credential()))
        let repository = BackendRepository(origin: ReadinessData.origin, transport: transport, secrets: vault, signer: ReadinessSigner())
        _ = try await repository.bootstrap()
        let blocked = vault.blockNextRead("operation-intents")
        let oldRead = Task { try await repository.protectedJSON("/me/photo-preferences") }
        let reached = await withCheckedContinuation { continuation in
            DispatchQueue.global().async { continuation.resume(returning: blocked.started.wait(timeout: .now() + 5) == .success) }
        }
        guard reached else { blocked.release.signal(); throw NativeAPIError.unavailable("fixture_read_not_blocked") }
        // This call must complete before releasing the executor's blocked vault
        // read. An actor-isolated retirement call would deadlock this ordering.
        repository.retireSessionAuthority()
        blocked.release.signal()
        do { _ = try await oldRead.value; throw NativeAPIError.invalidResponse }
        catch NativeAPIError.sessionChanged { checks += 1 }
        try expect(await repository.summary() == nil, "retirement closes public authority before durable cleanup")
        await repository.clearSession()

        let delayedVault = ReadinessVault(), delayedTransport = ReadinessTransport(vault: delayedVault), gate = ReadinessReplyGate()
        await delayedTransport.delayAnonymous(gate)
        let delayed = BackendRepository(origin: ReadinessData.origin, transport: delayedTransport, secrets: delayedVault, signer: ReadinessSigner())
        let bootstrap = Task { try await delayed.bootstrap() }
        await gate.started()
        let newerBytes = try JSONEncoder().encode(ReadinessData.credential(suffix: "independent-newer"))
        try delayedVault.write("credentials", data: newerBytes)
        delayed.retireSessionAuthority(); await gate.release()
        do { _ = try await bootstrap.value; throw NativeAPIError.invalidResponse }
        catch NativeAPIError.sessionChanged { checks += 1 }
        try expect(try delayedVault.read("credentials") == newerBytes, "late old bootstrap cannot overwrite newer independent credentials")
        await delayed.clearSession()
        try expect(try delayedVault.read("credentials") == newerBytes, "retirement without ownership cannot delete another instance's credential")

        let failingVault = ReadinessVault(), failingTransport = ReadinessTransport(vault: failingVault)
        try failingVault.write("credentials", data: JSONEncoder().encode(ReadinessData.credential(suffix: "delete-failure")))
        let failing = BackendRepository(origin: ReadinessData.origin, transport: failingTransport, secrets: failingVault, signer: ReadinessSigner())
        _ = try await failing.bootstrap(); failingVault.failCredentialRemoval(true)
        do { try await failing.logout(); throw NativeAPIError.invalidResponse }
        catch NativeAPIError.unsupported { checks += 1 }
        try expect(await failing.summary() == nil, "a failed durable logout still retires public authority")
        try expect(try failingVault.read("credentials") != nil, "fixture really retained the failed-to-delete slot")
        failingVault.failCredentialRemoval(false)
        let recovered = BackendRepository(origin: ReadinessData.origin, transport: failingTransport, secrets: failingVault, signer: ReadinessSigner())
        _ = try await recovered.bootstrap()
        let saved = try failingVault.read("credentials").map { try JSONDecoder().decode(NativeCredentials.self, from: $0) }
        try expect(saved?.authenticated != true, "durable tombstone prevents restart from restoring retired registered authority")
    }
}
