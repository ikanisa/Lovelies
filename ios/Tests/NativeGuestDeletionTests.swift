import Foundation
import CryptoKit

// Controlled transport lifecycle proof. Production repository, protocol parser
// and OS randomness are exercised. This does not qualify a server, Keychain,
// Secure Enclave, iOS UI, physical device or completed private-file cleanup.
private final class GuestSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var failReceipt = false
    private var failDeletion: String?
    func failNextReceiptWrite() { lock.lock(); defer { lock.unlock() }; failReceipt = true }
    func failNextDeletion(_ name: String) { lock.lock(); defer { lock.unlock() }; failDeletion = name }
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if failReceipt && name == "guest-deletion-receipt" { failReceipt = false; throw NativeAPIError.unavailable("protected_storage") }
        if failDeletion == name && data == nil { failDeletion = nil; throw NativeAPIError.unavailable("protected_storage") }
        values[name] = data
    }
    func receipt() throws -> NativeGuestDeletionRecord {
        guard let data = try read("guest-deletion-receipt") else { throw NativeAPIError.invalidResponse }
        return try JSONDecoder().decode(NativeGuestDeletionRecord.self, from: data)
    }
}
private final class GuestSigner: NativeDeviceSigner, @unchecked Sendable {
    private let lock = NSLock()
    private var clearCount = 0
    func sign(_ data: Data) throws -> String { throw NativeAPIError.unsupported("Guest deletion must not request face signing") }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() { lock.lock(); defer { lock.unlock() }; clearCount += 1 }
    var clears: Int { lock.lock(); defer { lock.unlock() }; return clearCount }
}
private actor GuestGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var observers: [CheckedContinuation<Void, Never>] = []
    private var waiting = false
    func pause() async { waiting = true; observers.forEach { $0.resume() }; observers = []; await withCheckedContinuation { continuation = $0 } }
    func started() async { if !waiting { await withCheckedContinuation { observers.append($0) } } }
    func release() { continuation?.resume(); continuation = nil }
}
private actor GuestFixture: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000011"
    static let other = "00000000-0000-4000-8000-000000000012"
    static let requestID = "00000000-0000-4000-8000-000000000013"
    let secrets: GuestSecrets
    private(set) var paths: [String] = []
    private(set) var posts: [WireValue] = []
    private(set) var statusBearerCount = 0
    private(set) var anonymousCount = 0
    private(set) var refreshCount = 0
    private(set) var refusedRefreshCount = 0
    private var nextRefreshToken: String?
    private var consumedRefreshTokens: Set<String> = []
    private var failReceiptAfterRefresh = false
    private var currentAccount = GuestFixture.account
    private var created = Date()
    private var phase: NativeGuestDeletionPhase = .pendingApproval
    private var requestExpired = false
    private var exists = false
    private var method = "anonymous"
    private var loseBefore = false, loseAfter = false, statusMissing = false, denyCreation = false, denyCurrent = false, wrongCurrent = false
    private var overrides: [String: WireValue] = [:]
    private var requestGate: GuestGate?, statusGate: GuestGate?
    init(secrets: GuestSecrets) { self.secrets = secrets }
    nonisolated func cancelPending() {}
    func loseCreation(afterCommit: Bool) { if afterCommit { loseAfter = true } else { loseBefore = true } }
    func denyNextCreation() { denyCreation = true }
    func statusUnavailable(_ value: Bool = true) { statusMissing = value }
    func currentDenied(_ value: Bool = true) { denyCurrent = value }
    func currentWrongAccount() { wrongCurrent = true }
    func delayCreation(_ gate: GuestGate) { requestGate = gate }
    func delayStatus(_ gate: GuestGate) { statusGate = gate }
    func setRegistered() { method = "registered_face" }
    func setStatus(_ value: NativeGuestDeletionPhase, expired: Bool = false, age: TimeInterval? = nil) {
        phase = value; requestExpired = expired; if let age { created = Date().addingTimeInterval(-age) }
    }
    func setOverrides(_ values: [String: WireValue]) { overrides = values }
    func singleUseRefresh(_ token: String, failReceipt: Bool) { nextRefreshToken = token; failReceiptAfterRefresh = failReceipt }
    func consumed(_ token: String) -> Bool { consumedRefreshTokens.contains(token) }
    func credential(method: String = "anonymous", account: String? = nil, now: Date = Date()) throws -> WireValue {
        let account = account ?? currentAccount
        let claims: WireValue = .object(["sub": .string(account), "auth_method": .string(method), "exp": .integer(Int(now.timeIntervalSince1970) + 900)])
        return .object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("fixture-refresh-" + UUID().uuidString), "expires_in": .integer(900), "roles": .strings(["user"]), "account_id": .string(account), "auth_method": .string(method)])
    }
    private func reply(_ wire: WireValue, status: Int = 200) throws -> NativeHTTPReply {
        NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try wire.encoded())
    }
    private func problem(_ status: Int, _ code: String) throws -> NativeHTTPReply { try reply(.object(["error": .object(["code": .string(code)])]), status: status) }
    private func lifecycle(_ record: NativeGuestDeletionRecord) -> WireValue {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var value: [String: WireValue] = ["protocol": .string("lovelies-account-deletion-v1"), "source": .string("privacy"), "operation_key": .string(record.operationKey),
            "privacy_request": .object(["id": .string(Self.requestID), "request_type": .string("delete"), "status": .string(phase.rawValue), "created_at": .string(formatter.string(from: created)), "reviewed_at": phase == .pendingApproval ? .null : .string(formatter.string(from: Date())), "completed_at": phase == .completed ? .string(formatter.string(from: Date())) : .null, "failure_code": .null]),
            "deletion_status": .object(["expires_at": .string(formatter.string(from: created.addingTimeInterval(30 * 86400)))]), "deletion_completed": .bool(phase == .completed),
            "request_expires_at": .string(formatter.string(from: created.addingTimeInterval(7 * 86400))), "request_expired": .bool(requestExpired)]
        for (key, replacement) in overrides { value[key] = replacement }
        return .object(value)
    }
    private func deliveryReply(_ value: WireValue, body: WireValue) throws -> WireValue {
        guard body["protocol"].string == NativeRefreshDeliveryRecord.protocolName else { return value }
        var fields = value.object!
        let token = try value.text("access_token"), claims = try WireValue.decoded(Data(base64URL: String(token.split(separator: ".")[1]))!)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        fields["protocol"] = .string(NativeRefreshDeliveryRecord.protocolName); fields["rotation_key"] = body["rotation_key"]
        fields["access_expires_at"] = .string(formatter.string(from: Date(timeIntervalSince1970: Double(claims["exp"].integer!))))
        fields["refresh_expires_at"] = .string(formatter.string(from: Date().addingTimeInterval(7 * 86400)))
        fields["delivery_expires_at"] = .string(formatter.string(from: Date().addingTimeInterval(86400)))
        return .object(fields)
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        guard let url = request.url, url.query == nil, url.fragment == nil else { throw NativeAPIError.invalidResponse }
        let path = url.path; paths.append(path)
        let body = try request.httpBody.map(WireValue.decoded) ?? .null
        switch path {
        case "/auth/anonymous": anonymousCount += 1; if anonymousCount > 1 { currentAccount = Self.other }; return try reply(credential(), status: 201)
        case "/me":
            if denyCurrent { return try problem(401, "session_invalid") }
            return try reply(.object(["user_id": .string(wrongCurrent ? Self.other : currentAccount), "auth_method": .string(method), "authenticated": .bool(method == "registered_face")]))
        case "/auth/session/refresh":
            guard let token = body["refresh_token"].string else { throw NativeAPIError.invalidResponse }
            if let expected = nextRefreshToken {
                guard token == expected, !consumedRefreshTokens.contains(token) else { refusedRefreshCount += 1; return try problem(401, "session_invalid") }
                consumedRefreshTokens.insert(token)
            }
            let next = try credential()
            if nextRefreshToken != nil { nextRefreshToken = try next.text("refresh_token") }
            if failReceiptAfterRefresh { failReceiptAfterRefresh = false; secrets.failNextReceiptWrite() }
            refreshCount += 1; return try reply(deliveryReply(next, body: body))
        case "/auth/logout": return try reply(.object(["status": .string("logged_out")]))
        case "/privacy/account-deletion":
            guard request.httpMethod == "POST", request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true,
                  let keys = body.object?.keys, Set(keys).isSubset(of: ["operation_key", "status_token", "reason"]) else { throw NativeAPIError.invalidResponse }
            let record = try secrets.receipt()
            guard body == record.payload, record.originalCredentials?.account_id == Self.account,
                  record.statusToken.count == 68, record.statusToken.hasPrefix("lvd_"), record.statusToken.dropFirst(4).allSatisfy({ "0123456789abcdef".contains($0) }) else { throw NativeAPIError.invalidResponse }
            posts.append(body)
            if let requestGate { await requestGate.pause() }
            if denyCreation { denyCreation = false; return try problem(403, "guest_delete_denied") }
            if loseBefore { loseBefore = false; throw URLError(.timedOut) }
            exists = true
            if loseAfter { loseAfter = false; throw URLError(.timedOut) }
            return try reply(lifecycle(record), status: 201)
        case "/privacy/account-deletion/status":
            if request.value(forHTTPHeaderField: "Authorization") != nil { statusBearerCount += 1; throw NativeAPIError.invalidResponse }
            let record = try secrets.receipt()
            guard request.httpMethod == "POST", Set(body.object?.keys.map { $0 } ?? []) == ["status_token"], body["status_token"].string == record.statusToken else { throw NativeAPIError.invalidResponse }
            if let statusGate { await statusGate.pause() }
            if !exists || statusMissing { return try problem(404, "deletion_status_unavailable") }
            return try reply(lifecycle(record))
        default: throw NativeAPIError.unsupported("Unexpected guest wire route")
        }
    }
}

@main struct NativeGuestDeletionTests {
    private static var checks = 0
    private static let origin = URL(string: "https://fixture.invalid")!
    private static func require(_ value: Bool, _ label: String) throws {
        guard value else { throw NativeAPIError.unsupported("Guest deletion check failed: " + label) }; checks += 1
    }
    private static func rejects(_ label: String, _ body: () async throws -> Void) async throws {
        do { try await body() } catch { checks += 1; return }
        throw NativeAPIError.unsupported("Guest deletion rejection missing: " + label)
    }
    private static func make() -> (BackendRepository, GuestFixture, GuestSecrets, GuestSigner) {
        let secrets = GuestSecrets(), signer = GuestSigner(), fixture = GuestFixture(secrets: secrets)
        return (BackendRepository(origin: origin, transport: fixture, secrets: secrets, signer: signer), fixture, secrets, signer)
    }
    private static func restart(_ values: (BackendRepository, GuestFixture, GuestSecrets, GuestSigner)) -> BackendRepository {
        BackendRepository(origin: origin, transport: values.1, secrets: values.2, signer: values.3)
    }
    static func main() async throws {
        let fence = NativePublicationFence(generation: 4)
        try require(fence.permits(currentGeneration: 4, cancelled: false), "current UI generation may publish")
        try require(!fence.permits(currentGeneration: 5, cancelled: false), "already-returned old UI response cannot publish after logout generation")
        try require(!fence.permits(currentGeneration: 4, cancelled: true), "cancelled UI work cannot publish a status or error")
        let normal = make(); let initial = try await normal.0.bootstrap()
        try require(initial?.authenticated == false, "anonymous initial account")
        try await rejects("anonymous protected gallery") { _ = try await normal.0.photos() }
        try await rejects("anonymous generic export") { _ = try await normal.0.post("/privacy/export", payload: .object([:]), operation: "privacy.request.export") }
        try await rejects("anonymous generic deletion remains registered-only") { _ = try await normal.0.post("/privacy/account-deletion", payload: .object([:]), operation: "privacy.request.delete") }
        let pending = try await normal.0.requestGuestDeletion(reason: "Delete this guest account")
        try require(pending.status?.phase == .pendingApproval && !pending.completed && !pending.canResumeSetup, "pending is not completed or resumable")
        let saved = try normal.2.receipt(), retired = await normal.0.summary()
        try require(retired == nil && saved.originalCredentials?.account_id == initial?.accountID && (try normal.2.read("credentials")) == nil, "ack freezes encrypted same-account credentials and retires presentation")
        let replay = restart(normal); let recovered = try await replay.bootstrap()
        let recoveredAnonymousCount = await normal.1.anonymousCount
        try require(recovered == nil && recoveredAnonymousCount == 1, "receipt restored before new anonymous bootstrap")
        let checked = try await replay.checkGuestDeletion()
        try require(checked.status?.requestID == pending.status?.requestID && !checked.completed, "same receipt read-only status")
        try await rejects("new guest before completed deletion") { _ = try await replay.startAgainAfterGuestDeletion() }
        try await rejects("pending resume") { _ = try await replay.resumeGuestSetup() }
        try await rejects("pending face setup") { _ = try await replay.startFace(consentPolicy: "unused", publicKey: .object([:])) }
        let paths = await normal.1.paths, bearers = await normal.1.statusBearerCount
        try require(bearers == 0 && !paths.contains(where: { $0.contains("/face/") || $0.lowercased().contains("otp") }), "no bearer status, enrollment or OTP")

        let lost = make(); _ = try await lost.0.bootstrap(); await lost.1.loseCreation(afterCommit: true)
        try await rejects("lost acknowledgement") { _ = try await lost.0.requestGuestDeletion() }
        let unknown = await lost.0.guestDeletionSummary()
        try require(unknown?.status == nil && unknown?.canRetryOriginal == true, "lost response retains private original intent")
        let restoredLost = restart(lost); _ = try await restoredLost.bootstrap(); let found = try await restoredLost.checkGuestDeletion(retryOriginal: true)
        let lostPosts = await lost.1.posts
        try require(found.status?.phase == .pendingApproval && lostPosts.count == 1, "status reconciles committed request without resend")

        let notSent = make(); _ = try await notSent.0.bootstrap(); await notSent.1.loseCreation(afterCommit: false)
        try await rejects("timeout before server submission") { _ = try await notSent.0.requestGuestDeletion(reason: "Original reason") }
        let restoredNotSent = restart(notSent); _ = try await restoredNotSent.bootstrap()
        let missing = try await restoredNotSent.checkGuestDeletion()
        try require(missing.statusUnavailable && !missing.completed, "unknown receipt is not deletion")
        let retried = try await restoredNotSent.checkGuestDeletion(retryOriginal: true), exactPosts = await notSent.1.posts
        try require(retried.status?.phase == .pendingApproval && exactPosts.count == 2 && exactPosts[0] == exactPosts[1], "retry keeps exact original operation key, token and body")
        try require((await notSent.1.anonymousCount) == 1, "retry validates existing guest without replacement")

        let denied = make(); _ = try await denied.0.bootstrap(); await denied.1.denyNextCreation()
        try await rejects("HTTP denial does not fabricate acknowledgement") { _ = try await denied.0.requestGuestDeletion() }
        try require((await denied.0.guestDeletionSummary())?.completed == false, "denied creation remains unresolved")

        let registered = make(); await registered.1.setRegistered()
        let registeredWire = try await registered.1.credential(method: "registered_face")
        try registered.2.write("credentials", data: JSONEncoder().encode(NativeCredentials(registeredWire)))
        _ = try await registered.0.bootstrap()
        try await rejects("guest method rejects registered authority") { _ = try await registered.0.requestGuestDeletion() }
        try require((await registered.1.posts).isEmpty, "registered account must use existing registered privacy flow")

        let storage = make(); _ = try await storage.0.bootstrap(); storage.2.failNextReceiptWrite()
        try await rejects("receipt write must precede dispatch") { _ = try await storage.0.requestGuestDeletion() }
        try require((await storage.1.posts).isEmpty, "protected-storage failure sends no deletion mutation")

        let mismatch = BackendRepository(origin: URL(string: "https://different.invalid")!, transport: normal.1, secrets: normal.2, signer: normal.3)
        let beforeOrigin = await normal.1.paths.count
        try await rejects("receipt origin binding") { _ = try await mismatch.bootstrap() }
        try require((await normal.1.paths.count) == beforeOrigin, "wrong endpoint sends no request or bootstrap")

        let foreign = make(); _ = try await foreign.0.bootstrap()
        let otherDevice = RegisteredDevice(accountID: GuestFixture.other, faceHandle: "lfh_other_account", deviceID: UUID().uuidString.lowercased())
        try foreign.2.write("registered-device", data: JSONEncoder().encode(otherDevice))
        _ = try await foreign.0.requestGuestDeletion()
        let kept = try await foreign.0.device()
        try require(kept?.accountID == GuestFixture.other && foreign.3.clears == 0, "guest acknowledgement preserves another account's device key and handle")

        let corrupt = make(); _ = try await corrupt.0.bootstrap(); await corrupt.1.loseCreation(afterCommit: false)
        try await rejects("prepare corrupt restore fixture") { _ = try await corrupt.0.requestGuestDeletion() }
        let goodRecord = try corrupt.2.receipt(); var invalidWire = try WireValue.decoded(JSONEncoder().encode(goodRecord)).object!
        invalidWire["statusToken"] = .string("lvd_" + String(repeating: "A", count: 64))
        try corrupt.2.write("guest-deletion-receipt", data: WireValue.object(invalidWire).encoded())
        try await rejects("malformed private receipt is never used") { _ = try await restart(corrupt).bootstrap() }
        try require((await corrupt.1.anonymousCount) == 1, "corrupt restore does not replace the account")

        for (label, field, replacement) in [
            ("protocol", "protocol", WireValue.string("wrong")), ("source", "source", .string("community")),
            ("operation key", "operation_key", .string(UUID().uuidString.lowercased())), ("completion boolean", "deletion_completed", .bool(true)),
            ("expiry type", "request_expired", .string("true")), ("missing expiry", "request_expires_at", .null)
        ] {
            let bad = make(); _ = try await bad.0.bootstrap(); await bad.1.setOverrides([field: replacement])
            try await rejects("wrong " + label) { _ = try await bad.0.requestGuestDeletion() }
            try require((await bad.0.guestDeletionSummary())?.status == nil, "invalid " + label + " never acknowledged")
        }

        let expiry = make(); _ = try await expiry.0.bootstrap(); await expiry.1.setStatus(.pendingApproval, expired: true, age: 8 * 86400)
        let expired = try await expiry.0.requestGuestDeletion()
        try require(expired.requestExpired && !expired.completed && expired.canResumeSetup, "day eight approval expiry is not deletion")
        let resumed = try await expiry.0.resumeGuestSetup()
        let expiryAnonymousCount = await expiry.1.anonymousCount
        try require(resumed.accountID == GuestFixture.account && !resumed.authenticated && expiryAnonymousCount == 1, "explicit expiry recovery restores same guest")
        try require((try expiry.2.read("guest-deletion-receipt")) == nil && (try expiry.2.read("credentials")) != nil, "successful resume retires old receipt after authority validation")

        let rejection = make(); _ = try await rejection.0.bootstrap(); await rejection.1.setStatus(.rejected)
        let rejected = try await rejection.0.requestGuestDeletion()
        try require(!rejected.completed && rejected.canResumeSetup, "rejection keeps account recoverable")
        await rejection.1.currentDenied()
        try await rejects("revoked original guest cannot resume") { _ = try await rejection.0.resumeGuestSetup() }
        let rejectionAnonymousCount = await rejection.1.anonymousCount
        try require((try rejection.2.read("guest-deletion-receipt")) != nil && rejectionAnonymousCount == 1, "failed recovery keeps status without new account")

        let wrongAccount = make(); _ = try await wrongAccount.0.bootstrap(); await wrongAccount.1.setStatus(.cancelled)
        _ = try await wrongAccount.0.requestGuestDeletion(); await wrongAccount.1.currentWrongAccount()
        try await rejects("recovery account mismatch") { _ = try await wrongAccount.0.resumeGuestSetup() }
        try require((await wrongAccount.0.guestDeletionSummary())?.status?.phase == .cancelled, "mismatched account cannot retire original receipt")

        let refresh = make(); _ = try await refresh.0.bootstrap(); await refresh.1.setStatus(.cancelled)
        _ = try await refresh.0.requestGuestDeletion()
        var refreshRecord = try refresh.2.receipt()
        let oldNow = Date().addingTimeInterval(-1800), oldWire = try await refresh.1.credential(now: oldNow)
        refreshRecord.originalCredentials = try NativeCredentials(oldWire, now: oldNow)
        try refresh.2.write("guest-deletion-receipt", data: JSONEncoder().encode(refreshRecord))
        let refreshRestart = restart(refresh); _ = try await refreshRestart.bootstrap(); let refreshed = try await refreshRestart.resumeGuestSetup()
        let refreshCount = await refresh.1.refreshCount, refreshAnonymousCount = await refresh.1.anonymousCount
        try require(refreshed.accountID == GuestFixture.account && refreshCount == 1 && refreshAnonymousCount == 1, "expired original credential rotates within the same anonymous account")

        // A single-use refresh commits and adopt saves its new credential slot,
        // then receipt persistence fails. Restart must recover that durable
        // rotation before removing the slot or using the spent original token.
        let rotation = make(); _ = try await rotation.0.bootstrap(); await rotation.1.setStatus(.cancelled)
        _ = try await rotation.0.requestGuestDeletion()
        var oldRotation = try rotation.2.receipt()
        let oldRotationWire = try await rotation.1.credential(now: oldNow)
        oldRotation.originalCredentials = try NativeCredentials(oldRotationWire, now: oldNow)
        let consumedOriginal = oldRotation.originalCredentials!.refresh_token
        try rotation.2.write("guest-deletion-receipt", data: JSONEncoder().encode(oldRotation))
        await rotation.1.singleUseRefresh(consumedOriginal, failReceipt: true)
        let rotationBeforeCrash = restart(rotation); _ = try await rotationBeforeCrash.bootstrap()
        try await rejects("receipt-write failure after committed single-use rotation") { _ = try await rotationBeforeCrash.resumeGuestSetup() }
        let newSlot = try JSONDecoder().decode(NativeCredentials.self, from: rotation.2.read("credentials")!)
        try require(newSlot.refresh_token != consumedOriginal && (try rotation.2.receipt()).originalCredentials?.refresh_token == consumedOriginal, "failure leaves surviving new slot and older consumed receipt token")
        try require(await rotation.1.consumed(consumedOriginal), "fixture enforces actual single-use refresh consumption")
        let rotationAfterCrash = restart(rotation); rotation.2.failNextReceiptWrite()
        try await rejects("restore journal write failure") { _ = try await rotationAfterCrash.bootstrap() }
        try require((try rotation.2.read("credentials")) != nil, "failed reconciliation never removes surviving rotated slot")
        let heldRotation = try await rotationAfterCrash.bootstrap(), mergedRotation = try rotation.2.receipt()
        try require(heldRotation == nil && mergedRotation.originalCredentials?.refresh_token == newSlot.refresh_token && (try rotation.2.read("credentials")) == nil, "validated same-account rotation is durable before frozen slot retirement")
        try require(mergedRotation.operationKey == oldRotation.operationKey && mergedRotation.statusToken == oldRotation.statusToken && mergedRotation.status?.requestID == oldRotation.status?.requestID, "rotation changes no deletion receipt identity")
        var expiredRotation = mergedRotation
        let rotatedWire: WireValue = .object(["access_token": .string(newSlot.access_token), "refresh_token": .string(newSlot.refresh_token), "account_id": .string(newSlot.account_id), "auth_method": .string(newSlot.auth_method), "expires_in": .integer(newSlot.expires_in), "roles": .strings(newSlot.roles)])
        expiredRotation.originalCredentials = try NativeCredentials(rotatedWire, now: oldNow)
        try rotation.2.write("guest-deletion-receipt", data: JSONEncoder().encode(expiredRotation))
        let rotatedResume = restart(rotation); _ = try await rotatedResume.bootstrap(); let rotationResult = try await rotatedResume.resumeGuestSetup()
        let rotationCount = await rotation.1.refreshCount, refusedRotationCount = await rotation.1.refusedRefreshCount, rotationAccounts = await rotation.1.anonymousCount
        try require(rotationResult.accountID == GuestFixture.account && !rotationResult.authenticated && rotationCount == 2 && refusedRotationCount == 0 && rotationAccounts == 1, "restart uses new single-use refresh and same account, never the spent original")

        let liveRotation = make(); _ = try await liveRotation.0.bootstrap(); await liveRotation.1.setStatus(.cancelled)
        _ = try await liveRotation.0.requestGuestDeletion()
        var liveOld = try liveRotation.2.receipt()
        liveOld.originalCredentials = try NativeCredentials(try await liveRotation.1.credential(now: oldNow), now: oldNow)
        try liveRotation.2.write("guest-deletion-receipt", data: JSONEncoder().encode(liveOld))
        await liveRotation.1.singleUseRefresh(liveOld.originalCredentials!.refresh_token, failReceipt: true)
        let stillRunning = restart(liveRotation); _ = try await stillRunning.bootstrap()
        try await rejects("prepare in-process receipt write failure") { _ = try await stillRunning.resumeGuestSetup() }
        let liveSlot = try JSONDecoder().decode(NativeCredentials.self, from: liveRotation.2.read("credentials")!)
        _ = try await stillRunning.checkGuestDeletion()
        try require((try liveRotation.2.receipt()).originalCredentials?.refresh_token == liveSlot.refresh_token && (try liveRotation.2.read("credentials")) == nil, "in-process status freezes current rotation before deleting its slot")
        let liveResumed = try await stillRunning.resumeGuestSetup(), liveRefusals = await liveRotation.1.refusedRefreshCount
        try require(liveResumed.accountID == GuestFixture.account && liveRefusals == 0, "in-process status recovery never uses spent original refresh")

        // Local session retirement during that failure window also keeps a
        // surviving rotation if freezing it cannot update the receipt. Server
        // logout/revocation can still deny subsequent same-account recovery.
        let logoutRotation = make(); _ = try await logoutRotation.0.bootstrap(); await logoutRotation.1.setStatus(.rejected)
        _ = try await logoutRotation.0.requestGuestDeletion()
        var logoutOld = try logoutRotation.2.receipt()
        logoutOld.originalCredentials = try NativeCredentials(try await logoutRotation.1.credential(now: oldNow), now: oldNow)
        try logoutRotation.2.write("guest-deletion-receipt", data: JSONEncoder().encode(logoutOld))
        await logoutRotation.1.singleUseRefresh(logoutOld.originalCredentials!.refresh_token, failReceipt: true)
        let logoutBeforeCrash = restart(logoutRotation); _ = try await logoutBeforeCrash.bootstrap()
        try await rejects("prepare logout rotation failure") { _ = try await logoutBeforeCrash.resumeGuestSetup() }
        logoutRotation.2.failNextReceiptWrite(); await logoutBeforeCrash.clearSession()
        let retiredRotationSummary = await logoutBeforeCrash.summary()
        try require((try logoutRotation.2.read("credentials")) != nil && retiredRotationSummary == nil, "local retirement keeps surviving slot after journal failure without public authority")
        let logoutRecovery = restart(logoutRotation); _ = try await logoutRecovery.bootstrap(); let logoutResumed = try await logoutRecovery.resumeGuestSetup()
        let logoutRefusals = await logoutRotation.1.refusedRefreshCount, logoutAccounts = await logoutRotation.1.anonymousCount
        try require(logoutResumed.accountID == GuestFixture.account && logoutRefusals == 0 && logoutAccounts == 1, "local retirement/restart recovery preserves original-account rotation")

        // The slot is recovery material only for this exact anonymous account.
        for (label, slotWire) in [
            ("different account", try await normal.1.credential(account: GuestFixture.other)),
            ("registered auth method", try await normal.1.credential(method: "registered_face"))
        ] {
            let mismatched = make(); _ = try await mismatched.0.bootstrap(); _ = try await mismatched.0.requestGuestDeletion()
            let slot = try JSONEncoder().encode(NativeCredentials(slotWire))
            try mismatched.2.write("credentials", data: slot)
            try await rejects("restore slot " + label) { _ = try await restart(mismatched).bootstrap() }
            let mismatchAccounts = await mismatched.1.anonymousCount
            try require((try mismatched.2.read("credentials")) == slot && mismatchAccounts == 1, "mismatched slot is neither imported, deleted nor replaced")
        }
        let jwtMismatch = make(); _ = try await jwtMismatch.0.bootstrap(); _ = try await jwtMismatch.0.requestGuestDeletion()
        let originalJWTRecord = try jwtMismatch.2.receipt()
        var contradictory = try WireValue.decoded(JSONEncoder().encode(originalJWTRecord.originalCredentials!)).object!
        contradictory["access_token"] = try await jwtMismatch.1.credential(account: GuestFixture.other)["access_token"]
        try jwtMismatch.2.write("credentials", data: WireValue.object(contradictory).encoded())
        try await rejects("slot JWT subject mismatch") { _ = try await restart(jwtMismatch).bootstrap() }
        let jwtAccounts = await jwtMismatch.1.anonymousCount
        try require((try jwtMismatch.2.receipt()).originalCredentials?.access_token == originalJWTRecord.originalCredentials?.access_token && jwtAccounts == 1, "corrupt slot cannot replace receipt credentials or start an account")

        let statusMissing = make(); _ = try await statusMissing.0.bootstrap(); _ = try await statusMissing.0.requestGuestDeletion()
        await statusMissing.1.statusUnavailable(); let unavailable = try await statusMissing.0.checkGuestDeletion(retryOriginal: true)
        let unavailablePostCount = await statusMissing.1.posts.count
        try require(unavailable.statusUnavailable && !unavailable.completed && !unavailable.canResumeSetup && unavailablePostCount == 1, "acknowledged expired or revoked receipt cannot resubmit or resume")

        let completed = make(); _ = try await completed.0.bootstrap(); _ = try await completed.0.requestGuestDeletion()
        let completedOriginal = try completed.2.receipt().originalCredentials!
        await completed.1.setStatus(.completed); completed.2.failNextDeletion("credentials")
        try await rejects("local credential cleanup failure") { _ = try await completed.0.checkGuestDeletion() }
        try require((try completed.2.receipt()).status?.completed == false && (try completed.2.receipt()).originalCredentials != nil, "failed local cleanup retains recovery receipt without published completion")
        let done = try await completed.0.checkGuestDeletion()
        try require(done.completed && (try completed.2.receipt()).originalCredentials == nil, "only confirmed server completion discards original credential")
        try completed.2.write("credentials", data: JSONEncoder().encode(completedOriginal))
        let completeRestart = restart(completed); let completedHeld = try await completeRestart.bootstrap()
        try require(completedHeld == nil && (try completed.2.read("credentials")) == nil && (try completed.2.receipt()).originalCredentials == nil, "completed receipt cannot resurrect a surviving same-account credential slot")
        try require((await completed.1.anonymousCount) == 1, "completed receipt still does not auto-start a guest")
        let fresh = try await completeRestart.startAgainAfterGuestDeletion()
        let completeAnonymousCount = await completed.1.anonymousCount
        try require(fresh?.accountID == GuestFixture.other && completeAnonymousCount == 2, "explicit start again after verified completion creates a fresh guest")

        let race = make(); _ = try await race.0.bootstrap(); let gate = GuestGate(); await race.1.delayCreation(gate)
        let request = Task { try await race.0.requestGuestDeletion() }; await gate.started()
        try await race.0.logout(); await gate.release()
        try await rejects("late deletion reply after logout") { _ = try await request.value }
        let raceSummary = await race.0.summary()
        try require((try race.2.receipt()).status == nil && raceSummary == nil, "logout fences late acknowledgement and retains unresolved receipt")

        let statusRace = make(); _ = try await statusRace.0.bootstrap(); _ = try await statusRace.0.requestGuestDeletion()
        let statusGate = GuestGate(); await statusRace.1.delayStatus(statusGate)
        let oldStatus = Task { try await statusRace.0.checkGuestDeletion() }; await statusGate.started()
        await statusRace.0.clearSession(); await statusGate.release()
        try await rejects("late receipt reply after logout boundary") { _ = try await oldStatus.value }
        print("Native guest deletion controlled checks passed: \(checks)")
    }
}
