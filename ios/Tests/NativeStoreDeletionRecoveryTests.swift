import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Controlled host fixtures exercise the actual repository, journal and private
// file code. They do not simulate StoreKit verification, a real Keychain, an OS
// share extension, a signed build or a physical-device lifecycle.
private let readinessAccount = "00000000-0000-4000-8000-000000000301"
private let readinessOther = "00000000-0000-4000-8000-000000000302"
private let readinessRequest = "00000000-0000-4000-8000-000000000303"
private let readinessDelivery = "00000000-0000-4000-8000-000000000304"
private let readinessOrigin = URL(string: "https://native-readiness.invalid")!
private let readinessProduct = "com.lovelies.fixture.monthly"

private final class ReadinessSecrets: NativeSecretStore, @unchecked Sendable {
    let authorityNamespace = "store-deletion-fixture-" + UUID().uuidString.lowercased()
    private let lock = NSRecursiveLock()
    private var slots: [String: Data] = [:]
    private var failing: String?
    private var loseReplacementAcknowledgment = false
    func fail(_ name: String?) { lock.lock(); defer { lock.unlock() }; failing = name }
    func loseReplacementWrite() { lock.lock(); defer { lock.unlock() }; loseReplacementAcknowledgment = true }
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return slots[name] }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if failing == name { throw NativeAPIError.unavailable("fixture_storage_failure") }; slots[name] = data
        if loseReplacementAcknowledgment, name == "store-apple-journal-v1", let data,
           let journal = try? JSONDecoder().decode(NativeApplePurchaseJournal.self, from: data), journal.records.count > 1, journal.records.last?.phase == .pending {
            loseReplacementAcknowledgment = false; throw NativeAPIError.unavailable("fixture_storage_ack_lost")
        }
    }
}
private final class ReadinessSigner: NativeDeviceSigner, @unchecked Sendable {
    var requiresLocalAuthentication = false
    var keys: [String: WireValue] = [:]
    var deleted: [String] = []
    var failRemoval = false
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { NativeApplePurchaseRecord.hash(data) }
    func clear() { keys.removeValue(forKey: NativeEnrollmentRecord.keyAlias) }
    func hasRetainedKey() throws -> Bool { keys[NativeEnrollmentRecord.keyAlias] != nil }
    func keyExists(alias: String) throws -> Bool { keys[alias] != nil }
    func publicJWK(alias: String, create: Bool) throws -> WireValue { guard let key = keys[alias] else { throw NativeAPIError.invalidResponse }; return key }
    func removeOwnedKey(alias: String, publicJWK: WireValue) throws {
        guard try self.publicJWK(alias: alias, create: false).canonical() == publicJWK.canonical() else { throw NativeAPIError.invalidResponse }
        try clearConfirmed(alias: alias)
    }
    func clearConfirmed(alias: String) throws {
        if failRemoval { throw NativeAPIError.unavailable("fixture_key_removal_failure") }
        keys.removeValue(forKey: alias); deleted.append(alias)
    }
}
private actor ReadinessUploadTransport: NativeUploadFileTransport {
    private var cancellations: [String] = []
    func send(_ request: URLRequest, file: URL, taskKey: String, limit: Int) async throws -> NativeHTTPReply { throw NativeAPIError.invalidResponse }
    func cancel(batch: String) async { cancellations.append(batch) }
    func cancelled() -> [String] { cancellations }
}
private func readinessAudience(account: String = readinessAccount, now: Date = Date(), teen: Bool = false, review: TimeInterval? = nil, guardian: TimeInterval = 120) -> WireValue {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let flags: WireValue = .object(["face_authentication": .bool(true), "photo_matching": .bool(true), "photo_processing": .bool(true)])
    let request: WireValue = teen ? .object(["id": .string(readinessDelivery), "child_account_id": .string(account), "state": .string("approved"),
        "revision": .integer(1), "policy_version": .string(NativeAudienceProjection.policy), "created_at": .string(formatter.string(from: now.addingTimeInterval(-60))),
        "expires_at": .string(formatter.string(from: now.addingTimeInterval(guardian))), "purposes": flags]) : .null
    return .object(["protocol": .string(NativeAudienceProjection.protocolName), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(account),
        "audience": .object(["at_least_13": .bool(true), "guardian_required": .bool(teen), "status": .string("eligible"), "version": .integer(1),
            "policy_version": .string(NativeAudienceProjection.policy), "source": .string("self_declaration"), "rule_version": .string("audience-13-plus-guardian-v1"), "territory": .string("global"), "declared_at": .string(formatter.string(from: now.addingTimeInterval(-60))), "next_review_at": .string(formatter.string(from: now.addingTimeInterval(review ?? 3600))), "review_required": .bool(false)]),
        "guardian_request": request, "capabilities": flags, "authority_expires_at": .string(formatter.string(from: now.addingTimeInterval(min(review ?? 3600, teen ? guardian : 3600))))])
}
private func readinessStoreResult(_ record: NativeApplePurchaseRecord, current: String = "1001", submitted: Bool = true) -> WireValue {
    var result: [String: WireValue] = ["provider": .string("apple_app_store"), "product_id": .string(record.productID), "active": .bool(true), "stale": .bool(current != record.transactionID),
        "transaction_id": .string(current), "original_transaction_id": .string(record.originalTransactionID), "billing_environment": .string(record.environment),
        "financial_eligible": .bool(record.environment == "production"), "expires_at": .string("2099-01-01T00:00:00.000Z")]
    if submitted { result["verified_submission"] = .object(["protocol": .string("lovelies-apple-submission-v2"), "product_id": .string(record.productID),
        "transaction_id": .string(record.transactionID), "original_transaction_id": .string(record.originalTransactionID), "billing_environment": .string(record.environment), "credential_sha256": .string(record.credentialSHA256)]) }
    return .object(result)
}
private func readinessStoreReceipt(_ record: NativeApplePurchaseRecord, current: String = "1001", submitted: Bool = true) -> WireValue {
    .object(["protocol": .string("lovelies-store-operation-receipt-v1"), "actor_id": .string(record.accountID), "operation_key": .string(record.operationKey), "status": .string("committed"),
        "action": .string("store.apple"), "source": .string("store"), "payload_hash": .string(record.digestInputHash), "result": readinessStoreResult(record, current: current, submitted: submitted),
        "input_scheme": .string("digest-v1"), "credential_sha256": .string(record.credentialSHA256), "receipt_scope": .string("historical")])
}
private actor ReadinessTransport: NativeTransport {
    var account = readinessAccount
    private var storeReceipts: [String: WireValue] = [:]
    private var delivery: WireValue?
    private var storePosts = 0, storeLookups = 0, exportParts = 0, exportAcks = 0, begins = 0
    private var dropStore = false, dropBeforeStore = false, dropAck = false, dropBeforeAck = false, dropStatus = false
    private var exportStatus: Int?
    private var failPart: Int?
    private var terminalStoreKeys: Set<String> = []
    private var terminalStorePosts = 0, terminalStoreLookups = false, unavailableStoreLookups = false
    private var terminalStatus = 409, terminalCode = "operation_recovered_without_result"
    private var pushFailure: (Int, String)?
    private(set) var pushBodies: [WireValue] = []
    private var storeLookupHook: (@Sendable () -> Void)?
    private let parts = [Data("{\"records\":".utf8), Data("[1,2,3]}".utf8)]
    nonisolated func cancelPending() {}
    func configure(store: Bool = false, beforeStore: Bool = false, ack: Bool = false, beforeAck: Bool = false, status: Bool = false, part: Int? = nil, statusCode: Int? = nil) {
        dropStore = store; dropBeforeStore = beforeStore; dropAck = ack; dropBeforeAck = beforeAck; dropStatus = status; failPart = part; exportStatus = statusCode
    }
    func counts() -> (Int, Int, Int, Int, Int) { (storePosts, storeLookups, exportParts, exportAcks, begins) }
    func configureStore(terminalPosts: Int = 0, terminalLookups: Bool = false, unavailableLookups: Bool = false) {
        terminalStorePosts = terminalPosts; terminalStoreLookups = terminalLookups; unavailableStoreLookups = unavailableLookups
    }
    func configureTerminal(status: Int, code: String) { terminalStatus = status; terminalCode = code }
    func configurePush(status: Int?, code: String = "operation_retired_by_recovery") { pushFailure = status.map { ($0, code) } }
    func terminalStore(_ key: String) { terminalStoreKeys.insert(key) }
    func setStoreReceipt(_ record: NativeApplePurchaseRecord, current: String) { storeReceipts[record.operationKey] = readinessStoreReceipt(record, current: current) }
    func onStoreLookup(_ hook: (@Sendable () -> Void)?) { storeLookupHook = hook }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        func reply(_ value: WireValue, status: Int = 200) throws -> NativeHTTPReply { .init(status: status, headers: ["content-type": "application/json"], data: try value.encoded()) }
        let path = request.url!.path, body = try request.httpBody.map(WireValue.decoded) ?? .object([:])
        switch path {
        case "/me": return try reply(.object(["user_id": .string(account), "authenticated": .bool(true), "auth_method": .string("registered_face")]))
        case "/me/audience": return try reply(readinessAudience(account: account))
        case "/me/entitlements": return try reply(.object(["download_photos": .bool(false)]))
        case "/me/profile": return try reply(.object(["name": .string("Fixture")]))
        case "/privacy/center": return try reply(.object(["requests": .array([])]))
        case "/me/push-devices":
            pushBodies.append(body)
            if let failure = pushFailure { return try reply(.object(["error": .object(["code": .string(failure.1)])]), status: failure.0) }
            return try reply(.object(["id": .string(readinessRequest), "platform": .string("ios"), "active": .bool(true)]))
        case "/community/action":
            guard body["action"].string == "operation" else { throw NativeAPIError.invalidResponse }
            return try reply(.object(["error": .object(["code": .string(terminalCode)])]), status: terminalStatus)
        case "/subscriptions/apple/transactions":
            storePosts += 1
            if dropBeforeStore { dropBeforeStore = false; throw NativeAPIError.unavailable("fixture_network") }
            let record = try NativeApplePurchaseRecord(account: account, product: body.text("product_id"), transaction: "1001", original: "1000", environment: "production",
                signedTransaction: body.text("signed_transaction"), operation: body.text("operation_key"))
            if terminalStorePosts > 0 {
                terminalStorePosts -= 1; terminalStoreKeys.insert(record.operationKey)
                return try reply(.object(["error": .object(["code": .string(terminalCode)])]), status: terminalStatus)
            }
            storeReceipts[record.operationKey] = readinessStoreReceipt(record, current: "2001")
            if dropStore { dropStore = false; throw NativeAPIError.unavailable("fixture_network") }
            return try reply(readinessStoreResult(record, current: "2001"))
        case "/me/store-operations":
            storeLookups += 1; let key = try body.text("operation_key")
            let hook = storeLookupHook; storeLookupHook = nil; hook?()
            if terminalStoreLookups || terminalStoreKeys.contains(key) {
                return try reply(.object(["error": .object(["code": .string(terminalCode)])]), status: terminalStatus)
            }
            if unavailableStoreLookups { throw NativeAPIError.unavailable("fixture_store_lookup_unavailable") }
            return try reply(storeReceipts[key] ?? .object(["protocol": .string("lovelies-store-operation-receipt-v1"), "actor_id": .string(account), "operation_key": .string(key), "status": .string("unknown")]))
        default: throw NativeAPIError.invalidResponse
        }
    }
}

@main struct NativeStoreDeletionRecoveryTests {
    private static var checks = 0
    private static func require(_ value: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try value() else { throw NativeAPIError.unsupported("Native readiness fixture failed: " + label) }; checks += 1
    }
    private static func credentials(_ account: String = readinessAccount) throws -> NativeCredentials {
        let expiry = Int(Date().timeIntervalSince1970) + 901
        let claims: WireValue = .object(["sub": .string(account), "jti": .string(readinessDelivery), "auth_method": .string("registered_face"), "exp": .integer(expiry)])
        return try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("fixture-refresh-" + account),
            "account_id": .string(account), "auth_method": .string("registered_face"), "expires_in": .integer(900), "roles": .strings(["user"])]))
    }
    private static func repository(_ secrets: ReadinessSecrets, _ transport: ReadinessTransport, _ root: URL, signer: ReadinessSigner = ReadinessSigner(),
                                   uploadFiles: NativeUploadPrivateFiles? = nil, uploadTransport: (any NativeUploadFileTransport)? = nil) -> BackendRepository {
        BackendRepository(origin: readinessOrigin, transport: transport, secrets: secrets, signer: signer,
            uploadFiles: uploadFiles ?? NativeUploadPrivateFiles(root: root.appendingPathComponent("uploads")), uploadTransport: uploadTransport,
            exportFiles: NativeExportStagingFiles(directory: root.appendingPathComponent("exports")))
    }
    private static func deletion() -> NativeRegisteredDeletionRecord {
        var value = NativeRegisteredDeletionRecord(accountID: readinessAccount, operationKey: UUID().uuidString.lowercased(), statusToken: "lvd_" + String(repeating: "a", count: 64), apiOrigin: readinessOrigin.absoluteString, preparedAt: Date())
        value.response = .object(["protocol": .string("lovelies-account-deletion-v1"), "source": .string("privacy"), "operation_key": .string(value.operationKey),
            "deletion_completed": .bool(true), "privacy_request": .object(["id": .string(readinessRequest), "request_type": .string("delete"), "status": .string("completed")])])
        return value
    }
    private static func enrollment() throws -> NativeEnrollmentRecord {
        let key = P256.Signing.PrivateKey(), raw = key.publicKey.x963Representation
        let jwk: WireValue = .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(raw.subdata(in: 1..<33).base64URL),
            "y": .string(raw.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
        let request = UUID().uuidString.lowercased(), handle = "lfh_" + Data(repeating: 1, count: 32).base64URL, policy = "fixture-policy"
        let envelope: WireValue = .object(["protocol": .string("lovelies-face-enrollment-device-v1"), "step": .string("start"), "account_id": .string(readinessAccount),
            "enrollment_key": .string(request), "face_handle": .string(handle), "policy_version": .string(policy), "device_public_jwk": jwk])
        let value = NativeEnrollmentRecord(accountID: readinessAccount, apiOrigin: readinessOrigin.absoluteString, enrollmentKey: request,
            keyAlias: NativeEnrollmentRecord.keyAlias, publicJWK: jwk, publicKeyDigest: NativeApplePurchaseRecord.hash(try jwk.canonical()), faceHandle: handle,
            policy: policy, consent: true, createdAt: Date(), startSignature: try key.signature(for: envelope.canonical()).rawRepresentation.base64URL)
        try value.validate(origin: readinessOrigin); return value
    }
    private static func recovery(_ owner: String) -> NativeAccountRecoveryRecord {
        let id = UUID().uuidString.lowercased()
        return NativeAccountRecoveryRecord(accountID: owner, apiOrigin: readinessOrigin.absoluteString, recoveryKey: "lfr_" + Data(repeating: 2, count: 32).base64URL,
            requestID: id, faceHandle: "lfh_" + Data(repeating: 3, count: 32).base64URL, keyAlias: NativeAccountRecoveryRecord.aliasPrefix + id, policy: "fixture-policy", createdAt: Date())
    }
    private static func archived<T: Encodable>(_ kind: String, owner: String, value: T) throws -> WireValue {
        .object(["kind": .string(kind), "accountID": .string(owner), "payload": try WireValue.decoded(JSONEncoder().encode(value))])
    }
    private static func purchase(_ repository: BackendRepository, signed: String = "fixture.signed-transaction.receipt", restore: Bool = false, epoch: Int? = nil) async throws -> NativeApplePurchaseRecord {
        try await repository.verifyApplePurchase(account: readinessAccount, product: readinessProduct, transaction: "1001", original: "1000", environment: "production", signedTransaction: signed,
            allowTerminalReplacement: restore, expectedEpoch: epoch)
    }
    private static func appleJournal(_ vault: ReadinessSecrets) throws -> NativeApplePurchaseJournal {
        try JSONDecoder().decode(NativeApplePurchaseJournal.self, from: vault.read("store-apple-journal-v1")!)
    }
    private static func saveApple(_ vault: ReadinessSecrets, _ records: [NativeApplePurchaseRecord]) throws {
        var journal = NativeApplePurchaseJournal(apiOrigin: readinessOrigin.absoluteString); journal.records = records
        try journal.validate(origin: readinessOrigin); try vault.write("store-apple-journal-v1", data: JSONEncoder().encode(journal))
    }
    private static func terminalStore(_ operation: () async throws -> Void) async throws {
        do { try await operation(); throw NativeAPIError.unsupported("Expected terminal store recovery") }
        catch NativeAPIError.denied(409, "operation_recovered_without_result") { checks += 1 }
    }
    private static func invalidStore(_ operation: () async throws -> Void) async throws {
        do { try await operation(); throw NativeAPIError.unsupported("Expected contradictory store evidence to be held") }
        catch NativeAPIError.invalidResponse { checks += 1 }
    }
    private static func storeTerminalFixtures(_ root: URL) async throws {
        let original = try NativeApplePurchaseRecord(account: readinessAccount, product: readinessProduct, transaction: "1001", original: "1000", environment: "production", signedTransaction: "fixture.signed-transaction.receipt")
        var ended = original; ended.phase = .recoveredWithoutResult; ended.signedTransaction = nil
        var confirmed = original; confirmed.phase = .providerConfirmed; confirmed.signedTransaction = nil; confirmed.receipt = readinessStoreReceipt(original)
        try require(try original.retaining(ended) == ended && ended.retaining(original) == ended, "terminal outcome wins over weaker pending storage copies")
        try require((try? confirmed.retaining(ended)) == nil && (try? ended.result(from: readinessStoreReceipt(original))) == nil, "terminal cannot admit or overwrite committed evidence")
        var observed = original; observed.directResultSHA256 = NativeApplePurchaseRecord.hash(try readinessStoreResult(original).canonical())
        try require((try? observed.retaining(ended)) == nil, "persisted direct success prevents terminal downgrade")
        let budget = NativeAppleRestoreAttempt()
        try require(budget.claim(account: readinessAccount, product: readinessProduct, transaction: "1001", original: "1000", environment: "production") &&
            !budget.claim(account: readinessAccount, product: readinessProduct, transaction: "1001", original: "1000", environment: "production"), "one explicit restore permission spans every enumeration of the same identity")
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(), location = root.appendingPathComponent("store-terminal-direct")
            try vault.write("credentials", data: JSONEncoder().encode(credentials())); await transport.configureStore(terminalPosts: 1)
            let repo = repository(vault, transport, location); _ = try await repo.bootstrap()
            try await terminalStore { _ = try await purchase(repo) }
            let retired = try appleJournal(vault).records[0], before = await transport.counts()
            try require(retired.phase == .recoveredWithoutResult && retired.signedTransaction == nil && retired.receipt == nil && retired.dispatchPayload == nil && before.0 == 1 && before.1 == 0, "direct terminal is durable and credential-free without receipt or lookup")
            let restarted = repository(vault, transport, location); _ = try await restarted.bootstrap()
            try await terminalStore { _ = try await purchase(restarted, signed: "fixture.refreshed-transaction.receipt") }
            try await terminalStore { _ = try await restarted.reserveApplePurchase(product: readinessProduct) }
            var finishRejected = false
            do { try await restarted.applePurchaseFinishObserved(retired.operationKey, account: readinessAccount) } catch NativeAPIError.sessionChanged { finishRejected = true }
            let heldCounts = await transport.counts(); try require(finishRejected && heldCounts.0 == 1 && heldCounts.1 == 0, "automatic callback/restart cannot verify or finish a terminal purchase")
            let replacement = try await purchase(restarted, signed: "fixture.refreshed-transaction.receipt", restore: true)
            let replaced = try appleJournal(vault), after = await transport.counts()
            try require(replacement.operationKey != retired.operationKey && replacement.credentialSHA256 != retired.credentialSHA256 && replacement.phase == .providerConfirmed &&
                replaced.records.count == 2 && replaced.records[0] == retired && after.0 == 2, "explicit restore admits one refreshed JWS for the same transaction while retaining its old terminal marker")
            try await restarted.applePurchaseFinishObserved(replacement.operationKey, account: readinessAccount); _ = try await restarted.refreshedAppleEntitlements()
            let reservation = try await restarted.reserveApplePurchase(product: readinessProduct); try await restarted.releaseApplePurchaseReservation(reservation)
            var capacity = try appleJournal(vault)
            var disposable = try NativeApplePurchaseRecord(account: readinessAccount, product: "com.lovelies.other", transaction: "3000", original: "3000", environment: "production", signedTransaction: "fixture.other.receipt")
            disposable.phase = .complete; disposable.signedTransaction = nil; disposable.receipt = readinessStoreReceipt(disposable, current: "3000")
            capacity.records.append(disposable)
            capacity.reservations = (0..<61).map { .init(accountID: readinessAccount, productID: "fixture.capacity.\($0)", id: UUID().uuidString.lowercased()) }
            try capacity.validate(origin: readinessOrigin); try vault.write("store-apple-journal-v1", data: JSONEncoder().encode(capacity))
            let full = repository(vault, transport, location); _ = try await full.bootstrap()
            let admitted = try await full.reserveApplePurchase(product: readinessProduct)
            let kept = try appleJournal(vault)
            try require(kept.records.contains(where: { $0.operationKey == retired.operationKey }) && kept.records.contains(where: { $0.operationKey == replacement.operationKey }) &&
                !kept.records.contains(where: { $0.operationKey == disposable.operationKey }), "capacity preserves completed successor proof and its terminal ancestor")
            try await full.releaseApplePurchaseReservation(admitted)
            _ = try await full.reserveApplePurchase(product: readinessProduct)
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(), location = root.appendingPathComponent("store-terminal-lookup")
            try vault.write("credentials", data: JSONEncoder().encode(credentials())); try saveApple(vault, [original]); await transport.terminalStore(original.operationKey)
            let repo = repository(vault, transport, location); _ = try await repo.bootstrap()
            vault.fail("store-apple-journal-v1")
            do { _ = try await purchase(repo, restore: true); throw NativeAPIError.unsupported("Expected failed terminal write") } catch NativeAPIError.unavailable {}
            let failed = try appleJournal(vault), failedCounts = await transport.counts()
            try require(failed.records == [original] && failedCounts.0 == 0 && failedCounts.1 == 1, "failed terminal storage holds exact old operation and cannot admit replacement")
            vault.fail(nil); await transport.configureStore(terminalPosts: 1)
            try await terminalStore { _ = try await purchase(repo, restore: true) }
            let terminal = try appleJournal(vault), counts = await transport.counts()
            try require(terminal.records.count == 2 && terminal.records.allSatisfy({ $0.phase == .recoveredWithoutResult && $0.signedTransaction == nil }) && counts.0 == 1 && counts.1 == 1,
                "acknowledged local terminal permits one child only; a terminal child stops this restore")
            var stale = false
            do { _ = try await purchase(repo, restore: true, epoch: -1) } catch NativeAPIError.sessionChanged { stale = true }
            let unchanged = await transport.counts(); try require(stale && unchanged.0 == 1, "retired explicit user scope cannot authorize a replacement after actor scheduling")
            var foreign = false
            do { _ = try await repo.verifyApplePurchase(account: readinessOther, product: readinessProduct, transaction: "1001", original: "1000", environment: "production", signedTransaction: "fixture.foreign.receipt", allowTerminalReplacement: true) }
            catch NativeAPIError.sessionChanged { foreign = true }
            try require(try foreign && appleJournal(vault).records == terminal.records, "another account cannot consume the terminal restore permission")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(), location = root.appendingPathComponent("store-replacement-write")
            try vault.write("credentials", data: JSONEncoder().encode(credentials())); try saveApple(vault, [ended])
            let repo = repository(vault, transport, location); _ = try await repo.bootstrap(); vault.loseReplacementWrite()
            do { _ = try await purchase(repo, restore: true); throw NativeAPIError.unsupported("Expected lost replacement write acknowledgment") } catch NativeAPIError.unavailable {}
            let written = try appleJournal(vault), key = try appleJournal(vault).records.last!.operationKey
            try require(written.records.count == 2 && written.records.last?.phase == .pending, "replacement marker survives lost write acknowledgment before dispatch")
            do { _ = try await purchase(repo, restore: true); throw NativeAPIError.unsupported("Expected exact new-key lookup hold") } catch NativeAPIError.operationUnconfirmed {}
            let restarted = repository(vault, transport, location); _ = try await restarted.bootstrap()
            do { _ = try await purchase(restarted, restore: true); throw NativeAPIError.unsupported("Expected restart lookup hold") } catch NativeAPIError.operationUnconfirmed {}
            try await terminalStore { _ = try await restarted.reserveApplePurchase(product: readinessProduct) }
            let counts = await transport.counts(); try require(try appleJournal(vault).records.last?.operationKey == key && counts.0 == 0 && counts.1 == 2, "ambiguous replacement never creates or dispatches a second new key")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(), location = root.appendingPathComponent("store-direct-proof")
            try vault.write("credentials", data: JSONEncoder().encode(credentials())); await transport.configureStore(unavailableLookups: true)
            let repo = repository(vault, transport, location); _ = try await repo.bootstrap()
            do { _ = try await purchase(repo); throw NativeAPIError.unsupported("Expected unavailable store lookup") } catch NativeAPIError.unavailable {}
            let held = try appleJournal(vault).records[0]
            try require(held.phase == .pending && held.directResultSHA256 != nil, "successful direct result is durably retained before lookup")
            let restarted = repository(vault, transport, location); _ = try await restarted.bootstrap()
            await transport.configureStore(terminalLookups: true)
            try await invalidStore { _ = try await purchase(restarted, restore: true) }
            await transport.configureStore(); await transport.setStoreReceipt(held, current: "3001")
            try await invalidStore { _ = try await purchase(restarted) }
            try require(try appleJournal(vault).records[0] == held, "restart cannot admit a terminal or changed committed result over retained direct success")
            await transport.setStoreReceipt(held, current: "2001"); await transport.onStoreLookup { vault.fail("store-apple-journal-v1") }
            do { _ = try await purchase(restarted); throw NativeAPIError.unsupported("Expected receipt write failure") } catch NativeAPIError.unavailable {}
            vault.fail(nil); await transport.configureStore(terminalLookups: true)
            try await invalidStore { _ = try await purchase(restarted, restore: true) }
            await transport.configureStore(); let admitted = try await purchase(restarted)
            await transport.configureStore(terminalLookups: true); try await invalidStore { _ = try await purchase(restarted, restore: true) }
            let counts = await transport.counts()
            try require(try appleJournal(vault).records[0] == admitted && admitted.receipt != nil && counts.0 == 1, "failed receipt write preserves stronger evidence; terminal contradiction cannot erase admitted receipt or trigger another POST")
        }
    }
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("native-readiness-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); defer { try? FileManager.default.removeItem(at: root) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try require(WireValue.number(Double(Int.max)).integer == nil, "out-of-range server integer cannot trap before metadata validation")
        let teen = try NativeAudienceProjection(readinessAudience(now: now, teen: true, review: 45, guardian: 60), account: readinessAccount)
        try require(try teen.authorityExpiresAt(sessionExpiresAt: now.addingTimeInterval(500), purpose: .faceAuthentication, now: now) == now.addingTimeInterval(45), "teen media expires at earlier audience review")
        try require(try teen.authorityExpiresAt(sessionExpiresAt: now.addingTimeInterval(20), purpose: .photoProcessing, now: now) == now.addingTimeInterval(20), "session expiry still wins")
        try require((try? teen.require(.faceAuthentication, now: now.addingTimeInterval(45))) == nil, "approval cannot outlive review")
        let adult = try NativeAudienceProjection(readinessAudience(now: now, review: -1), account: readinessAccount)
        try require((try? adult.require(.faceAuthentication, now: now)) == nil, "expired adult review is not current authority")
        let lease = NativePrivateMediaDeadline(created: .init(wall: now, uptime: 100), authorityExpiresAt: now.addingTimeInterval(45))
        try require(lease.remaining(at: .init(wall: now.addingTimeInterval(46), uptime: 101)) == 0 && lease.remaining(at: .init(wall: now.addingTimeInterval(-1), uptime: 101)) == 0, "wall jump and rollback retire media")
        let permit = NativeAccountPublicationPermit(generation: 7, accountID: readinessAccount, sessionEpoch: 2)
        try require(permit.permits(generation: 7, accountID: readinessAccount, sessionEpoch: 2, foreground: true, cancelled: false), "same publication owner remains live")
        for rejected in [(8, readinessAccount, 2, true, false), (7, readinessOther, 2, true, false), (7, readinessAccount, 3, true, false), (7, readinessAccount, 2, false, false), (7, readinessAccount, 2, true, true)] {
            try require(!permit.permits(generation: rejected.0, accountID: rejected.1, sessionEpoch: rejected.2, foreground: rejected.3, cancelled: rejected.4), "stale UI generation/account/scene cannot publish")
        }
        let original = try NativeApplePurchaseRecord(account: readinessAccount, product: readinessProduct, transaction: "1001", original: "1000", environment: "production", signedTransaction: "fixture.signed-transaction.receipt")
        try require(try original.result(from: readinessStoreReceipt(original, current: "2001")) != nil, "submitted older transaction is distinct from current subscription transaction")
        try require((try? original.result(from: readinessStoreReceipt(original, current: "2001", submitted: false))) == nil, "flat historical receipt cannot prove a different submitted transaction")
        var foreign = readinessStoreReceipt(original).object!; foreign["actor_id"] = .string(readinessOther)
        try require((try? original.result(from: .object(foreign))) == nil, "another actor receipt cannot confirm purchase")
        try await storeTerminalFixtures(root)

        for (status, code) in [(409, "operation_recovered_without_result"), (410, "operation_retired_by_recovery")] {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(), location = root.appendingPathComponent("terminal-push-\(status)")
            try vault.write("credentials", data: JSONEncoder().encode(credentials())); await transport.configurePush(status: status, code: code)
            let repo = repository(vault, transport, location); _ = try await repo.bootstrap()
            let payload: WireValue = .object(["platform": .string("ios"), "push_token": .string("synthetic-native-push-token-0001")])
            try await terminalStore { _ = try await repo.post("/me/push-devices", payload: payload, operation: "notification.device.register") }
            let terminal = try JSONDecoder().decode([NativeOperationRetirementRecord].self, from: vault.read("operation-terminal-evidence")!).first!
            let first = await transport.pushBodies
            try require(terminal.sourceStatus == status && terminal.sourceCode == code && terminal.operationKey == first[0]["operation_key"].string,
                        "push terminal source code and exact operation identity survive")
            try require(terminal.inputSHA256 == NativeApplePurchaseRecord.hash(try first[0].canonical()) && terminal.replacementOperationKey == nil,
                        "push terminal retains input digest without storing provider token")
            let restarted = repository(vault, transport, location); _ = try await restarted.bootstrap()
            try await terminalStore { _ = try await restarted.post("/me/push-devices", payload: payload, operation: "notification.device.register") }
            let beforeExplicit = await transport.pushBodies
            try require(beforeExplicit.count == 1, "foreground/token callback cannot silently replace terminal registration")
            await transport.configurePush(status: nil)
            _ = try await restarted.post("/me/push-devices", payload: payload, operation: "notification.device.register", allowNewAfterTerminal: true)
            let after = await transport.pushBodies, archive = try JSONDecoder().decode([NativeOperationRetirementRecord].self, from: vault.read("operation-terminal-evidence")!)
            try require(after.count == 2 && after[1]["operation_key"].string != terminal.operationKey && archive.count == 1 && archive[0].replacementOperationKey == after[1]["operation_key"].string,
                        "explicit replacement binds its new key while retaining original negative receipt")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(); try vault.write("credentials", data: JSONEncoder().encode(credentials()))
            let repo = repository(vault, transport, root.appendingPathComponent("terminal-push-storage")); _ = try await repo.bootstrap()
            vault.fail("operation-terminal-evidence"); await transport.configurePush(status: 410)
            do { _ = try await repo.post("/me/push-devices", payload: .object(["platform": .string("ios"), "push_token": .string("synthetic-native-push-token-0002")]), operation: "notification.device.register"); throw NativeAPIError.invalidResponse }
            catch NativeAPIError.unavailable {}
            let held = await repo.pending()
            try require(held.count == 1 && (try vault.read("operation-terminal-evidence")) == nil, "negative evidence failure preserves exact pending token and key")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(); try vault.write("credentials", data: JSONEncoder().encode(credentials()))
            await transport.configureStore(terminalPosts: 1); await transport.configureTerminal(status: 410, code: "operation_retired_by_recovery")
            let repo = repository(vault, transport, root.appendingPathComponent("terminal-store-410")); _ = try await repo.bootstrap()
            try await terminalStore { _ = try await purchase(repo) }
            let negative = try JSONDecoder().decode([NativeOperationRetirementRecord].self, from: vault.read("operation-terminal-evidence")!).first!
            let retained = try appleJournal(vault).records.first!, counts = await transport.counts()
            try require(negative.sourceStatus == 410 && negative.sourceCode == "operation_retired_by_recovery" && negative.inputSHA256 == retained.legacyInputHash && retained.phase == .recoveredWithoutResult && retained.signedTransaction == nil && counts.0 == 1 && counts.1 == 0,
                        "store 410 is terminal only after original code, digest and credential retirement are durable")
        }

        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(); try vault.write("credentials", data: JSONEncoder().encode(credentials()))
            await transport.configure(store: true)
            let repo = repository(vault, transport, root.appendingPathComponent("store")); _ = try await repo.bootstrap()
            _ = try await repo.reserveApplePurchase(product: readinessProduct)
            let confirmed = try await purchase(repo), counts = await transport.counts()
            try require(confirmed.phase == .providerConfirmed && confirmed.signedTransaction == nil && counts.0 == 1 && counts.1 == 1, "lost purchase response reconciles typed exact receipt and wipes JWS")
            let restarted = repository(vault, transport, root.appendingPathComponent("store")); _ = try await restarted.bootstrap()
            let retained = try await restarted.unfinishedApplePurchaseIDs(); try require(retained == ["1001"], "finish-before-journal restart remains explicitly recoverable")
            _ = try await purchase(restarted); let after = await transport.counts(); try require(after.0 == 1, "restart never reposts saved purchase credential")
            try await restarted.applePurchaseFinishObserved(confirmed.operationKey, account: readinessAccount)
            let current = try await restarted.refreshedAppleEntitlements()
            let journal = try JSONDecoder().decode(NativeApplePurchaseJournal.self, from: vault.read("store-apple-journal-v1")!)
            try require(current["download_photos"].bool == false && journal.records.first?.phase == .complete, "historical purchase does not override authoritative current entitlement")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(); try vault.write("credentials", data: JSONEncoder().encode(credentials()))
            await transport.configure(beforeStore: true)
            let repo = repository(vault, transport, root.appendingPathComponent("held-store")); _ = try await repo.bootstrap()
            do { _ = try await purchase(repo); throw NativeAPIError.invalidResponse } catch NativeAPIError.operationUnconfirmed {}
            do { _ = try await purchase(repo); throw NativeAPIError.invalidResponse } catch NativeAPIError.operationUnconfirmed {}
            let counts = await transport.counts(); try require(counts.0 == 1 && counts.1 == 2, "typed unknown retains original store key without automatic resend")
            _ = try await repo.post("/me/profile", payload: .object(["name": .string("Fixture")]), operation: "account.profile.update", method: "PATCH")
            let pending = await repo.pending(); try require(pending.isEmpty, "held purchase does not occupy generic action journal")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(); try vault.write("credentials", data: JSONEncoder().encode(credentials()))
            let intent = NativeOperationIntent(key: UUID().uuidString.lowercased(), accountID: readinessAccount, source: "personal", action: "photo.preferences", payload: .object([:]), approvedPairs: nil)
            try vault.write("operation-intents", data: JSONEncoder().encode([intent]))
            let repo = repository(vault, transport, root.appendingPathComponent("terminal")); _ = try await repo.bootstrap()
            do { _ = try await repo.reconcile(); throw NativeAPIError.invalidResponse } catch NativeAPIError.denied(409, "operation_recovered_without_result") {}
            let pending = await repo.pending(); try require(pending.isEmpty, "terminal restrictive recovery removes original generic body")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(), uploads = ReadinessUploadTransport()
            let folder = root.appendingPathComponent("delete-upload-restart"), files = NativeUploadPrivateFiles(root: folder.appendingPathComponent("files"))
            let source = root.appendingPathComponent("fixture.jpg"); try Data([0xff, 0xd8, 0xff, 0x01]).write(to: source)
            func batch(_ owner: String) throws -> NativeResumableUploadBatch {
                let id = UUID().uuidString.lowercased()
                var file = try files.stage(.init(id: UUID().uuidString.lowercased(), file: source, title: "Fixture", width: 1, height: 1), batch: id); file.phase = .queued
                var value = NativeResumableUploadBatch(id: id, origin: readinessOrigin, account: owner, device: readinessDelivery, files: [file])
                value.started = true; value.paused = false; value.backgroundRetryAllowed = true
                try value.validate(origin: readinessOrigin); return value
            }
            let own = try batch(readinessAccount), foreign = try batch(readinessOther)
            let originalRoster = try JSONEncoder().encode([own, foreign]), foreignBytes = try files.verifiedBytes(foreign.files[0], batch: foreign.id)
            try vault.write("resumable-photo-batches-v1", data: originalRoster)
            try vault.write("registered-deletion-receipt", data: JSONEncoder().encode(deletion()))
            let first = repository(vault, transport, folder, uploadFiles: files, uploadTransport: uploads)
            _ = try await first.bootstrap(); vault.fail("resumable-photo-batches-v1")
            do { _ = try await first.checkRegisteredDeletion(); throw NativeAPIError.invalidResponse } catch NativeAPIError.unavailable {}
            let cancelled = await uploads.cancelled()
            try require(try vault.read("resumable-photo-batches-v1") == originalRoster && files.verifiedBytes(own.files[0], batch: own.id).count == 4,
                        "failed durable pause preserves both account rosters and original files")
            try require(cancelled == [own.id], "storage failure still cancels only deleted-account transport")
            vault.fail("registered-deletion-receipt")
            let afterFailure = repository(vault, transport, folder, uploadFiles: files, uploadTransport: uploads); _ = try await afterFailure.bootstrap()
            do { _ = try await afterFailure.checkRegisteredDeletion(); throw NativeAPIError.invalidResponse } catch NativeAPIError.unavailable {}
            let paused = try JSONDecoder().decode([NativeResumableUploadBatch].self, from: vault.read("resumable-photo-batches-v1")!)
            try require(paused.first?.paused == true && paused.first?.backgroundRetryAllowed == false,
                        "deleted upload retirement is durable before cleanup may erase its files")
            try require(try WireValue.decoded(JSONEncoder().encode(paused[1])) == WireValue.decoded(JSONEncoder().encode(foreign)), "foreign batch revision, retry setting and content remain untouched")
            vault.fail(nil)
            let restarted = repository(vault, transport, folder, uploadFiles: files, uploadTransport: uploads); _ = try await restarted.bootstrap()
            let done = try await restarted.checkRegisteredDeletion()
            let kept = try JSONDecoder().decode([NativeResumableUploadBatch].self, from: vault.read("resumable-photo-batches-v1")!)
            let allCancelled = await uploads.cancelled()
            try require(done.localCleanupComplete == true && kept.map(\.id) == [foreign.id] && !FileManager.default.fileExists(atPath: files.root.appendingPathComponent(own.id).path),
                        "fresh-repository deletion removes only exact owned upload files and roster")
            try require(try files.verifiedBytes(foreign.files[0], batch: foreign.id) == foreignBytes && Set(allCancelled) == [own.id],
                        "foreign upload bytes and transports survive repeated cleanup")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(), signer = ReadinessSigner()
            let setup = try enrollment(), foreign = recovery(readinessOther)
            var own = recovery(readinessAccount)
            let superseded = NativeAccountRecoveryRecord.aliasPrefix + UUID().uuidString.lowercased()
            own.supersededAliases = [superseded, foreign.keyAlias]
            let ownBackup = NativeRecoveryKeyRecord(accountID: readinessAccount, apiOrigin: readinessOrigin.absoluteString, operationKey: UUID().uuidString.lowercased(),
                secret: "lfr_" + Data(repeating: 4, count: 32).base64URL, createdAt: Date())
            let foreignBackup = NativeRecoveryKeyRecord(accountID: readinessOther, apiOrigin: readinessOrigin.absoluteString, operationKey: UUID().uuidString.lowercased(),
                secret: "lfr_" + Data(repeating: 5, count: 32).base64URL, createdAt: Date())
            let foreignRows = try [archived("account-recovery-journal", owner: readinessOther, value: foreign), archived("recovery-key-backup", owner: readinessOther, value: foreignBackup)]
            let rows = try [archived("face-enrollment-journal", owner: readinessAccount, value: setup), archived("account-recovery-journal", owner: readinessAccount, value: own),
                archived("recovery-key-backup", owner: readinessAccount, value: ownBackup)] + foreignRows
            try vault.write("face-lifecycle-retired-identities", data: JSONEncoder().encode(rows))
            try vault.write("registered-deletion-receipt", data: JSONEncoder().encode(deletion()))
            signer.keys = [setup.keyAlias: setup.publicJWK, own.keyAlias: .object(["fixture": .string("owned")]), superseded: .object(["fixture": .string("old")]), foreign.keyAlias: .object(["fixture": .string("foreign")])]
            signer.failRemoval = true
            let first = repository(vault, transport, root.appendingPathComponent("delete-archive"), signer: signer); _ = try await first.bootstrap()
            do { _ = try await first.checkRegisteredDeletion(); throw NativeAPIError.invalidResponse } catch NativeAPIError.unavailable {}
            let held = try await first.registeredDeletionReceipt()
            let archivedBytes = try vault.read("face-lifecycle-retired-identities")!
            let kept = try JSONDecoder().decode([WireValue].self, from: archivedBytes)
            try require(kept == foreignRows && archivedBytes.range(of: Data(ownBackup.secret.utf8)) == nil,
                        "deletion removes archived own recovery secrets and preserves exact foreign identities")
            try require(Set(held?.cleanupKeys?.map(\.alias) ?? []) == [setup.keyAlias, own.keyAlias, superseded],
                        "archived enrollment/recovery aliases persist in cleanup plan before archive removal")
            signer.failRemoval = false
            let restarted = repository(vault, transport, root.appendingPathComponent("delete-archive"), signer: signer); _ = try await restarted.bootstrap()
            let done = try await restarted.checkRegisteredDeletion()
            try require(done.localCleanupComplete == true && Set(signer.deleted) == [setup.keyAlias, own.keyAlias, superseded] && signer.keys[foreign.keyAlias] != nil,
                        "restart cleans archived owned aliases while foreign shared references keep their key")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(), signer = ReadinessSigner(); signer.requiresLocalAuthentication = true
            let jwk = try enrollment().publicJWK
            var receipt = deletion()
            receipt.cleanupKeys = (0..<256).map { _ in .init(alias: NativeAccountRecoveryRecord.aliasPrefix + UUID().uuidString.lowercased(), publicJWK: jwk) }
            let bytes = try JSONEncoder().encode(receipt)
            try require(bytes.count > 32 * 1024 && bytes.count <= NativeRegisteredDeletionRecord.maximumEncodedBytes, "fixture spans the supported larger deletion receipt")
            try vault.write("registered-deletion-receipt", data: bytes)
            try vault.write("face-profile-lifecycle", data: Data(repeating: 0xff, count: 129 * 1024))
            let restarted = repository(vault, transport, root.appendingPathComponent("large-delete"), signer: signer)
            let binding = try await restarted.prepareLocalSigning(purpose: .connect, operationID: UUID())
            let session = try await restarted.bootstrap()
            try require(binding == nil && session == nil, "production local-auth mode resumes deletion before unrelated oversized signing slots")
            try vault.write("face-profile-lifecycle", data: nil)
            let done = try await restarted.checkRegisteredDeletion()
            try require(done.localCleanupComplete == true && signer.deleted.isEmpty, "large cleanup receipt remains recoverable without signing or creating keys")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport()
            let stale = try JSONEncoder().encode(credentials())
            try vault.write("credentials", data: stale)
            try vault.write("registered-deletion-receipt", data: JSONEncoder().encode(deletion()))
            let first = repository(vault, transport, root.appendingPathComponent("delete-authority"))
            let session = try await first.bootstrap()
            try require(session == nil, "deletion restart does not adopt the stored deleted-account credential")
            vault.fail("registered-deletion-receipt")
            do { _ = try await first.checkRegisteredDeletion(); throw NativeAPIError.invalidResponse } catch NativeAPIError.unavailable {}
            let ledger = NativeAuthorityLedger(store: vault, origin: readinessOrigin)
            try ledger.restore()
            let ledgerSlot = "session-authority-v1-" + NativeAppleStoreJournal.digest(Data(readinessOrigin.absoluteString.utf8))
            let durableGeneration = try WireValue.decoded(vault.read(ledgerSlot) ?? Data())["generation"].integer
            let removedCredential = try vault.read("credentials")
            try require((durableGeneration ?? 0) > 0 && ledger.clock.snapshot() == durableGeneration && removedCredential == nil,
                        "completed deletion durably retires stored authority before cleanup can fail")
            vault.fail(nil)
            // A stale writer or restored vault must not make this credential live.
            try vault.write("credentials", data: stale)
            let restarted = repository(vault, transport, root.appendingPathComponent("delete-authority"))
            _ = try await restarted.bootstrap()
            try require(try vault.read("credentials") == nil,
                        "independent retirement rejects deleted-account credential bytes after restart")
            let finished = try await restarted.checkRegisteredDeletion()
            try require(finished.localCleanupComplete == true, "exact completed deletion cleanup remains resumable after authority retirement")
        }
        do {
            let vault = ReadinessSecrets(), transport = ReadinessTransport(), signer = ReadinessSigner()
            var deletion = NativeRegisteredDeletionRecord(accountID: readinessAccount, operationKey: UUID().uuidString.lowercased(), statusToken: "lvd_" + String(repeating: "a", count: 64), apiOrigin: readinessOrigin.absoluteString, preparedAt: Date())
            deletion.response = .object(["protocol": .string("lovelies-account-deletion-v1"), "source": .string("privacy"), "operation_key": .string(deletion.operationKey),
                "deletion_completed": .bool(true), "privacy_request": .object(["id": .string(readinessRequest), "request_type": .string("delete"), "status": .string("completed")])])
            try vault.write("registered-deletion-receipt", data: JSONEncoder().encode(deletion))
            // The deletion receipt must be read before even malformed stale face state.
            try vault.write("face-profile-lifecycle", data: Data("malformed stale lifecycle".utf8))
            let repo = repository(vault, transport, root.appendingPathComponent("delete"), signer: signer)
            let restored = try await repo.bootstrap(); try require(restored == nil, "deletion receipt precedes every face-lifecycle restore")
            try vault.write("face-profile-lifecycle", data: nil)
            let alias = NativeEnrollmentRecord.keyAlias
            signer.keys[alias] = .object(["synthetic_public_key": .string("original")])
            try vault.write("registered-device", data: JSONEncoder().encode(RegisteredDevice(accountID: readinessAccount, faceHandle: "lfh_" + Data(repeating: 1, count: 32).base64URL,
                deviceID: readinessDelivery, keyAlias: alias)))
            try vault.write("credentials", data: JSONEncoder().encode(credentials(readinessOther)))
            try vault.write("library-state-" + readinessAccount, data: JSONEncoder().encode(NativeLibraryState(accountID: readinessAccount)))
            let otherLibrary = try JSONEncoder().encode(NativeLibraryState(accountID: readinessOther)); try vault.write("library-state-" + readinessOther, data: otherLibrary)
            signer.failRemoval = true
            do { _ = try await repo.checkRegisteredDeletion(); throw NativeAPIError.invalidResponse } catch NativeAPIError.unavailable {}
            let failed = try await repo.registeredDeletionReceipt()
            try require(failed?.completed == true && failed?.localCleanupComplete != true && failed?.cleanupKeys?.count == 1, "failed key removal retains exact deletion cleanup proof")
            signer.failRemoval = false
            let complete = try await repo.checkRegisteredDeletion()
            try require(complete.localCleanupComplete == true && signer.keys[alias] == nil, "acknowledged exact key cleanup can resume")
            try require(try vault.read("library-state-" + readinessAccount) == nil && vault.read("library-state-" + readinessOther) == otherLibrary,
                        "deletion removes only matching account library state")
            let preserved = try JSONDecoder().decode(NativeCredentials.self, from: vault.read("credentials")!)
            let retainedReceipt = try vault.read("registered-deletion-receipt")
            try require(preserved.account_id == readinessOther && retainedReceipt != nil, "newer account credentials and final cleanup receipt survive")
            let ledger = NativeAuthorityLedger(store: vault, origin: readinessOrigin); try ledger.restore()
            try require(ledger.clock.snapshot() == (preserved.localAuthorityGeneration ?? 0),
                        "deletion cleanup does not retire the newer foreign account's authority generation")
        }
        print("Native store and deletion recovery checks passed: \(checks)")
    }
}
