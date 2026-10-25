import Foundation
import CryptoKit

// Controlled production-client lifecycle proof; no server/model/Keychain/device
// or iOS SDK qualification. Exact signatures are validated with software P256.
private final class AccountSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock(); private var data: [String: Data] = [:]
    private var failed: String?, removing = false
    func fail(_ name: String, removal: Bool = false) { lock.lock(); defer { lock.unlock() }; failed = name; removing = removal }
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return data[name] }
    func write(_ name: String, data value: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if failed == name && (!removing || value == nil) { failed = nil; throw NativeAPIError.unavailable("protected_storage") }; data[name] = value
    }
    func journal() throws -> NativeAccountRecoveryRecord { guard let value = try read("account-recovery-journal") else { throw NativeAPIError.invalidResponse }; return try JSONDecoder().decode(NativeAccountRecoveryRecord.self, from: value) }
}
private final class AccountSigner: NativeDeviceSigner, @unchecked Sendable {
    private let lock = NSLock(); private var keys: [String: P256.Signing.PrivateKey] = [:]
    private(set) var cleared: [String] = []
    func publicJWK(alias: String, create: Bool) throws -> WireValue {
        lock.lock(); defer { lock.unlock() }
        guard NativeAccountRecoveryRecord.validAlias(alias) else { throw NativeAPIError.invalidResponse }
        if keys[alias] == nil && create { keys[alias] = P256.Signing.PrivateKey() }
        guard let key = keys[alias] else { throw NativeAPIError.unavailable("original_key_missing") }
        let bytes = key.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(bytes.subdata(in: 1..<33).base64URL), "y": .string(bytes.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
    func sign(_ bytes: Data) throws -> String { try sign(bytes, alias: NativeEnrollmentRecord.keyAlias) }
    func sign(_ bytes: Data, alias: String) throws -> String { lock.lock(); defer { lock.unlock() }; guard let key = keys[alias] else { throw NativeAPIError.unavailable("original_key_missing") }; return try key.signature(for: bytes).rawRepresentation.base64URL }
    func sha256(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    func clear() { clear(alias: NativeEnrollmentRecord.keyAlias) }
    func clear(alias: String) { lock.lock(); defer { lock.unlock() }; keys[alias] = nil; cleared.append(alias) }
    func hasRetainedKey() throws -> Bool { lock.lock(); defer { lock.unlock() }; return !keys.isEmpty }
    func replace(_ alias: String) { lock.lock(); defer { lock.unlock() }; keys[alias] = P256.Signing.PrivateKey() }
}
private actor AccountGate {
    private var waiting = false, continuation: CheckedContinuation<Void, Never>?
    private var observers: [CheckedContinuation<Void, Never>] = []
    func pause() async { waiting = true; observers.forEach { $0.resume() }; observers = []; await withCheckedContinuation { continuation = $0 } }
    func started() async { if !waiting { await withCheckedContinuation { observers.append($0) } } }
    func release() { continuation?.resume(); continuation = nil }
}
private actor AccountFixture: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000071", guest = "00000000-0000-4000-8000-000000000072"
    static let device = "00000000-0000-4000-8000-000000000073", revision = "00000000-0000-4000-8000-000000000074", profile = "00000000-0000-4000-8000-000000000075"
    static let policy = "registered-face-opencv-v1"
    private var currentDevice = AccountFixture.device, currentRevision = AccountFixture.revision
    private var store: AccountSecrets
    private var captureGate: AccountGate?
    private var key: WireValue?, base: WireValue?, challenge: WireValue = .null, rows: [WireValue] = []
    private var currentOverrides: [String: WireValue] = [:], deviceOverrides: [String: WireValue] = [:]
    private var usedRefresh: Set<String> = [], refreshBodies: [String] = [], failRefreshSlot = false
    private var committed = false, generation = 1, created = Date(), expired = false
    private var privateRecoveryKey: String?, wrongFace = false
    private var loss: (String, Bool)?, overrides: [String: WireValue] = [:], forced: String?, deniedStatus: (Int, String)?
    private var resumes: [String: WireValue] = [:]
    private(set) var paths: [String] = [], keyBodies: [WireValue] = [], startBodies: [WireValue] = [], signatures = 0, anonymousCount = 0, completionCount = 0
    private(set) var logoutTokens: [String] = [], logoutSawRetiredPromotion = false
    init(store: AccountSecrets) { self.store = store }
    nonisolated func cancelPending() {}
    func driftCurrent(_ values: [String: WireValue]) { currentOverrides = values }
    func driftDevice(_ values: [String: WireValue]) { deviceOverrides = values }
    func failNextRefreshSlot() { failRefreshSlot = true }
    func refreshed(_ token: String) -> Int { refreshBodies.filter { $0 == token }.count }
    func delayCapture(_ gate: AccountGate) { captureGate = gate }
    func consumer(_ value: AccountSecrets) { store = value }
    func lose(_ path: String, after: Bool = true) { loss = (path, after) }
    func status(_ value: String?) { forced = value }
    func override(_ values: [String: WireValue]) { overrides = values }
    func unavailable(_ status: Int, _ code: String) { deniedStatus = (status, code) }
    func rejectFace() { wrongFace = true }
    func expire(clean: Bool) { expired = true; if clean { rows = [] } }
    func credential(account: String = AccountFixture.account, method: String = "registered_face") throws -> WireValue {
        let claims: WireValue = .object(["sub": .string(account), "auth_method": .string(method), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return .object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("fixture-refresh-" + UUID().uuidString), "account_id": .string(account), "auth_method": .string(method), "expires_in": .integer(900), "roles": .strings(["user"])])
    }
    private func response(_ value: WireValue, _ status: Int = 200) throws -> NativeHTTPReply { NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try value.encoded()) }
    private func failure(_ status: Int, _ code: String) throws -> NativeHTTPReply { try response(.object(["error": .object(["code": .string(code)])]), status) }
    private func date(_ value: Date) -> WireValue { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return .string(f.string(from: value)) }
    private func lost(_ path: String, after: Bool) throws { if let loss, loss.0 == path && loss.1 == after { self.loss = nil; throw URLError(.timedOut) } }
    private func verify(_ raw: String?, body: WireValue, step: String) throws {
        let record = try store.journal(); var envelope = body.object!; envelope.removeValue(forKey: "device_signature")
        envelope["protocol"] = .string("lovelies-account-recovery-device-v1"); envelope["step"] = .string(step)
        guard let raw, let bytes = Data(base64URL: raw), bytes.count == 64,
              try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: bytes), for: WireValue.object(envelope).canonical()) else { throw NativeAPIError.invalidResponse }; signatures += 1
    }
    private func newChallenge(ordinary: Bool = false) -> WireValue {
        var value: [String: WireValue] = ["protocol": .string("lovelies-face-auth-v1"), "challenge_id": .string(UUID().uuidString.lowercased()), "nonce": .string("lfn_" + Data(repeating: UInt8(generation), count: 32).base64URL), "account_id": .string(Self.account), "device_id": .string(currentDevice), "device_revision": .string(currentRevision), "purpose": .string("login"), "profile_id": .string(Self.profile), "profile_revision": .string("profile-v1"), "model_id": .string("yunet-sface-v1"), "policy_version": .string(Self.policy), "required_captures": .integer(1), "poses": .strings(["front"]), "maximum_capture_bytes": .integer(8 * 1024 * 1024), "expires_at": date(Date().addingTimeInterval(100))]
        if !ordinary { value["recovery_request_id"] = base?["recovery_request_id"] ?? .null; value["recovery_generation"] = .integer(generation) }
        return audienceBoundChallenge(.object(value))
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
    // These named software actors are explicitly declared synthetic adults in
    // this fixture setup. This is neither a production default nor age proof.
    private func declaredAdultAudience(account: String) -> WireValue {
        .object(["protocol": .string("lovelies-audience-v1"), "policy_version": .string("audience-2026-10-24-v1"), "account_id": .string(account),
            "audience": .object(["age_band": .string("18_plus"), "status": .string("eligible"), "version": .integer(1), "policy_version": .string("audience-2026-10-24-v1"), "next_review_at": .null]),
            "guardian_request": .null, "capabilities": .object(["face_authentication": .bool(true), "photo_matching": .bool(true), "photo_processing": .bool(true)])])
    }
    private func audienceBoundChallenge(_ wire: WireValue) -> WireValue {
        var value = wire.object!
        value["audience_authority"] = .object(["protocol": .string("lovelies-audience-challenge-v1"), "policy_version": .string("audience-2026-10-24-v1"),
            "account_id": wire["account_id"], "challenge_id": wire["challenge_id"], "device_id": wire["device_id"], "purpose": wire["purpose"], "audience_version": .integer(1), "expires_at": wire["expires_at"]])
        return .object(value)
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path); try lost(path, after: false)
        let body = request.value(forHTTPHeaderField: "Content-Type") == "application/json" ? try request.httpBody.map(WireValue.decoded) ?? .null : .null
        switch path {
        case "/me/audience":
            guard let token = request.value(forHTTPHeaderField: "Authorization")?.split(separator: " ").last,
                  let payload = token.split(separator: ".").dropFirst().first.flatMap({ Data(base64URL: String($0)) }),
                  let claims = try? WireValue.decoded(payload), let account = claims["sub"].string,
                  [Self.account, Self.guest].contains(account) else { return try failure(401, "session_invalid") }
            return try response(declaredAdultAudience(account: account))
        case "/auth/anonymous": anonymousCount += 1; return try response(credential(account: Self.guest, method: "anonymous"), 201)
        case "/me":
            guard let token = request.value(forHTTPHeaderField: "Authorization")?.split(separator: " ").last,
                  let part = token.split(separator: ".").dropFirst().first, let bytes = Data(base64URL: String(part)) else { return try failure(401, "session_invalid") }
            let claims = try WireValue.decoded(bytes), method = claims["auth_method"].string!
            var result: [String: WireValue] = ["user_id": claims["sub"], "auth_method": .string(method), "authenticated": .bool(method == "registered_face"), "profile_id": .string(Self.profile), "profile_revision": .string("profile-v1")]
            currentOverrides.forEach { result[$0.key] = $0.value }; return try response(.object(result))
        case "/auth/session/refresh":
            let token = try body.text("refresh_token"); refreshBodies.append(token)
            guard !usedRefresh.contains(token) else { return try failure(401, "session_invalid") }; usedRefresh.insert(token)
            if failRefreshSlot { failRefreshSlot = false; store.fail("credentials") }; return try response(deliveryReply(credential(), body: body))
        case "/me/devices":
            var result: [String: WireValue] = ["id": .string(currentDevice), "current": .bool(true), "status": .string("active")]
            deviceOverrides.forEach { result[$0.key] = $0.value }; return try response(.object(["items": .array([.object(result)])]))
        case "/auth/logout":
            logoutTokens.append(request.value(forHTTPHeaderField: "Authorization") ?? "")
            if let data = try store.read("account-recovery-journal") {
                let record = try JSONDecoder().decode(NativeAccountRecoveryRecord.self, from: data)
                logoutSawRetiredPromotion = record.promotionCredentials == nil && record.promotionDevice == nil && record.state == .registered
            }
            return try response(.object(["status": .string("logged_out")]))
        case "/auth/face/policy": return try response(.object(["protocol": .string("lovelies-face-auth-v1"), "available": .bool(true), "policy_version": .string(Self.policy)]))
        case "/auth/face/recovery/key":
            if request.httpMethod == "GET" { return try response(key ?? .object(["protocol": .string("lovelies-account-recovery-v1"), "state": .string("unavailable"), "account_id": .string(Self.account)])) }
            if request.httpMethod == "DELETE" { key = nil; privateRecoveryKey = nil; return try response(.object(["protocol": .string("lovelies-account-recovery-v1"), "state": .string("revoked"), "account_id": .string(Self.account)])) }
            guard let saved = try store.read("recovery-key-backup") else { throw NativeAPIError.invalidResponse }
            let record = try JSONDecoder().decode(NativeRecoveryKeyRecord.self, from: saved)
            guard record.body == body else { throw NativeAPIError.invalidResponse }; keyBodies.append(body)
            if let previous = key, previous["operation_key"] == body["operation_key"] { try lost(path, after: true); return try response(previous, 201) }
            privateRecoveryKey = record.secret
            key = .object(["protocol": .string("lovelies-account-recovery-v1"), "state": .string("ready"), "account_id": .string(Self.account), "key_id": .string(UUID().uuidString.lowercased()), "operation_key": body["operation_key"], "expires_at": date(Date().addingTimeInterval(365 * 86400))])
            try lost(path, after: true); return try response(key!, 201)
        case "/auth/face/recovery/challenge", "/auth/face/recovery/status", "/auth/face/recovery/resume":
            guard request.value(forHTTPHeaderField: "Authorization") == nil else { throw NativeAPIError.invalidResponse }
            let step = path.hasSuffix("challenge") ? "start" : path.hasSuffix("resume") ? "resume" : "status"
            try verify(body["device_signature"].string, body: body, step: step)
            let record = try store.journal(); guard body["account_id"].string == Self.account, body["recovery_key"].string == record.recoveryKey,
                body["device_public_jwk"] == record.publicJWK, body["face_handle"].string == record.faceHandle else { throw NativeAPIError.invalidResponse }
            if let deniedStatus { return try failure(deniedStatus.0, deniedStatus.1) }
            guard body["recovery_key"].string == privateRecoveryKey else { return try failure(401, "account_recovery_unavailable") }
            if step == "start" {
                guard key != nil else { return try failure(401, "account_recovery_unavailable") }; startBodies.append(body)
                if let previous = base, previous["recovery_request_id"].string == record.requestID { guard previous == record.startBody else { return try failure(409, "account_recovery_binding_conflict") } }
                else { base = record.startBody; currentDevice = UUID().uuidString.lowercased(); currentRevision = UUID().uuidString.lowercased(); challenge = newChallenge(); rows = []; created = Date() }
                try lost(path, after: true); return try response(challenge, 201)
            }
            guard let base, base["recovery_request_id"].string == record.requestID else { return try failure(404, "account_recovery_not_found") }
            if step == "resume" {
                guard expired, forced == nil, let resume = body["resume_key"].string else { return try failure(409, "account_recovery_in_flight") }
                if let existing = resumes[resume] { return try response(existing, 201) }
                guard body["expected_generation"].integer == generation, body["expected_challenge_id"] == challenge["challenge_id"] else { return try failure(409, "account_recovery_predecessor_changed") }
                generation += 1; expired = false; rows = []; challenge = newChallenge(); resumes[resume] = challenge
                try lost(path, after: true); return try response(challenge, 201)
            }
            var plain = challenge.object!; plain.removeValue(forKey: "recovery_request_id"); plain.removeValue(forKey: "recovery_generation")
            var result: [String: WireValue] = ["protocol": .string("lovelies-account-recovery-v1"), "authenticated": .bool(false), "account_id": .string(Self.account), "recovery_request_id": base["recovery_request_id"], "device_id": .string(currentDevice), "device_revision": .string(currentRevision), "public_key_digest": .string(record.publicKeyDigest!), "policy_version": .string(Self.policy), "challenge_id": challenge["challenge_id"], "generation": .integer(generation), "request_nonce": body["request_nonce"], "expires_at": date(created.addingTimeInterval(7 * 86400)), "state": .string(committed ? "registered" : forced ?? (expired ? "restart_required" : "pending")), "challenge": committed || expired || forced != nil ? .null : .object(plain), "captures": .array(committed ? [] : rows), "profile": .object(["id": .string(Self.profile), "revision": .string("profile-v1"), "model_id": .string("yunet-sface-v1")])]
            overrides.forEach { result[$0.key] = $0.value }; return try response(.object(result))
        case "/auth/face/challenge":
            guard committed, body["face_handle"] == base?["face_handle"], body["device_id"].string == currentDevice else { return try failure(401, "face_handle_unavailable") }
            challenge = newChallenge(ordinary: true); rows = []; return try response(challenge)
        case "/auth/face/complete":
            let record = try store.journal(); guard record.state == .completionPending, rows.count == 1, body["challenge_id"] == challenge["challenge_id"] else { throw NativeAPIError.invalidResponse }
            var envelope = try NativeFaceChallenge(challenge, accountID: Self.account, purpose: "login").deviceEnvelope(); envelope["step"] = .string("complete"); envelope["capture_manifest"] = .array(rows)
            guard let raw = body["device_signature"].string.flatMap(Data.init(base64URL:)), try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: WireValue.object(envelope).canonical()) else { throw NativeAPIError.invalidResponse }
            if wrongFace { expired = true; return try failure(401, "face_verification_failed") }
            committed = true; completionCount += 1
            var result = try credential().object!; result["protocol"] = .string("lovelies-face-auth-v1"); result["status"] = .string("authenticated"); result["profile_id"] = .string(Self.profile); result["profile_revision"] = .string("profile-v1"); result["model_id"] = .string("yunet-sface-v1"); result["device_id"] = .string(currentDevice)
            try lost(path, after: true); return try response(.object(result))
        default:
            guard path.hasPrefix("/auth/face/proof/"), let bytes = request.httpBody else { throw NativeAPIError.invalidResponse }
            let record = try store.journal(); guard record.state == .capturePending, record.captures.count == 1, !record.captures[0].accepted, rows.isEmpty else { throw NativeAPIError.invalidResponse }
            var envelope = try NativeFaceChallenge(challenge, accountID: Self.account, purpose: "login").deviceEnvelope(); envelope["step"] = .string("capture"); envelope["capture_index"] = .integer(0); envelope["capture_sha256"] = .string(record.captures[0].sha256); envelope["mime"] = .string("image/jpeg"); envelope["byte_size"] = .integer(bytes.count)
            guard let raw = request.value(forHTTPHeaderField: "X-Lovelies-Device-Signature").flatMap(Data.init(base64URL:)), try record.publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: WireValue.object(envelope).canonical()) else { throw NativeAPIError.invalidResponse }
            rows = [record.captures[0].wire]
            let received = try response(.object(["protocol": .string("lovelies-face-auth-v1"), "status": .string("capture_received"), "challenge_id": challenge["challenge_id"], "capture_index": .integer(0), "capture_sha256": .string(record.captures[0].sha256), "byte_size": .integer(bytes.count)]))
            if let gate = captureGate { captureGate = nil; await gate.pause() }
            try lost(path, after: true); return received
        }
    }
}

@main struct NativeAccountRecoveryTests {
    private static let origin = URL(string: "https://native-account-recovery.invalid")!
    private static var checks = 0
    private static func require(_ value: @autoclosure () throws -> Bool, _ label: String) throws { guard try value() else { throw NativeAPIError.unsupported("Account recovery check failed: " + label) }; checks += 1 }
    private static func rejects(_ label: String, _ body: () async throws -> Void) async throws { do { try await body() } catch { checks += 1; return }; throw NativeAPIError.unsupported("Missing rejection: " + label) }
    private static func setup() async throws -> (BackendRepository, AccountFixture, AccountSecrets, AccountSigner, String) {
        let store = AccountSecrets(), signer = AccountSigner(), fixture = AccountFixture(store: store)
        let credentials = try NativeCredentials(await fixture.credential()); try store.write("credentials", data: JSONEncoder().encode(credentials))
        _ = try signer.publicJWK(alias: NativeEnrollmentRecord.keyAlias, create: true)
        try store.write("registered-device", data: JSONEncoder().encode(RegisteredDevice(accountID: AccountFixture.account, faceHandle: "lfh_" + Data(repeating: 9, count: 32).base64URL, deviceID: "00000000-0000-4000-8000-000000000079")))
        let repository = BackendRepository(origin: origin, transport: fixture, secrets: store, signer: signer); _ = try await repository.bootstrap()
        let backup = try await repository.createRecoveryKey(); return (repository, fixture, store, signer, backup)
    }
    private static func newDevice(_ fixture: AccountFixture) async -> (BackendRepository, AccountSecrets, AccountSigner) {
        let store = AccountSecrets(), signer = AccountSigner(); await fixture.consumer(store)
        return (BackendRepository(origin: origin, transport: fixture, secrets: store, signer: signer), store, signer)
    }
    private static func restart(_ fixture: AccountFixture, _ store: AccountSecrets, _ signer: AccountSigner) -> BackendRepository { BackendRepository(origin: origin, transport: fixture, secrets: store, signer: signer) }
    private static func run() async throws {
        do {
            let (owner, fixture, store, _, backup) = try await setup(); try require(try NativeAccountRecoveryRecord.backup(backup).0 == AccountFixture.account, "Backup names exact account")
            try require((try store.read("recovery-key-backup")) != nil, "Secret/operation persisted before any display")
            let again = try await owner.createRecoveryKey(); try require(again == backup, "Confirmed saved key can be explicitly viewed")
            await fixture.lose("/auth/face/recovery/key"); try await owner.revokeRecoveryKey()
            try await rejects("Key POST lost response") { _ = try await owner.createRecoveryKey() }
            let original = try store.read("recovery-key-backup")!, next = try await owner.createRecoveryKey()
            let record = try JSONDecoder().decode(NativeRecoveryKeyRecord.self, from: original)
            try require(next == record.backup, "Lost key response retries original private secret/operation")
            let bodies = await fixture.keyBodies; try require(bodies.suffix(2).first == bodies.last, "Key replay body unchanged")
        }
        for after in [true, false] {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            await fixture.lose("/auth/face/recovery/challenge", after: after)
            try await rejects("Start loss") { _ = try await device.startAccountRecovery(backup: backup) }
            let original = try store.journal(); try require(original.state == .starting && original.keyAlias != NativeEnrollmentRecord.keyAlias, "New alias/intent durable before start")
            let restored = restart(fixture, store, signer); _ = try await restored.bootstrap(); let status = try await restored.continueAccountRecovery()
            try require(status.accountID == original.accountID && (try store.journal()).requestID == original.requestID && (try store.journal()).publicJWK == original.publicJWK, "Start reconstruction keeps account/key/request")
            let anon = await fixture.anonymousCount; try require(anon == 0, "Pending recovery never bootstraps another guest")
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            let started = try await device.startAccountRecovery(backup: backup), challenge = started.challenge!
            await fixture.lose("/auth/face/proof/" + challenge.id + "/0")
            try await rejects("Capture loss") { _ = try await device.capture(Data([1, 2, 3]), index: 0, challenge: challenge) }
            try require((try store.journal()).state == .capturePending && !(try store.journal()).captures[0].accepted, "Only planned metadata persisted on ambiguous upload")
            let restored = restart(fixture, store, signer); _ = try await restored.bootstrap(); let status = try await restored.continueAccountRecovery()
            try require(status.receipts.count == 1 && status.challenge?.id == challenge.id, "Signed exact capture receipt restores original challenge")
            let reconciled = try store.journal(), plain = reconciled.challengeWire ?? .null
            try require(plain["recovery_request_id"] == .null && plain["challenge_id"].string == reconciled.predecessorID, "Plain readonly recovery challenge keeps its authoritative predecessor and remains eligible for status reconciliation")
            // An original start challenge and its signed plain status differ
            // only in the recovery wrapper. Wrong wrappers/authority must not
            // reach completion or consume this exact accepted capture.
            for (field, replacement) in [("recovery_request_id", WireValue.string(UUID().uuidString.lowercased())),
                                         ("recovery_generation", .integer(reconciled.generation + 1)),
                                         ("challenge_id", .string(UUID().uuidString.lowercased())),
                                         ("audience_authority", .object([:]))] {
                var altered = challenge.wire.object!; altered[field] = replacement
                let wrong = try NativeFaceChallenge(.object(altered), accountID: AccountFixture.account, purpose: "login")
                let before = await fixture.completionCount
                try await rejects("Original recovery challenge rejects wrong " + field) { _ = try await restored.completeFace(wrong, captures: status.receipts) }
                let after = await fixture.completionCount
                try require(before == after && (try store.journal()).state == .pending && (try store.journal()).captures.allSatisfy(\.accepted), "Wrong recovery wrapper/authority cannot dispatch completion or change accepted capture")
            }
            let completionsBeforeLoss = await fixture.completionCount
            await fixture.lose("/auth/face/complete")
            try await rejects("Completion loss") { _ = try await restored.completeFace(challenge, captures: status.receipts) }
            let completionsAfterLoss = await fixture.completionCount
            try require(completionsAfterLoss == completionsBeforeLoss + 1, "Lost completion reached and committed the fixture before its reply was lost")
            let final = restart(fixture, store, signer); let session = try await final.bootstrap(); let readonly = try await final.accountRecoverySummary()
            try require(session == nil && readonly?.state == .registered, "Committed readonly status gives no credentials")
            let fresh = try await final.continueAccountRecovery(), login = fresh.challenge!
            try require(login.id != challenge.id && login.poses == ["front"], "Lost completion uses ordinary fresh-one-selfie login")
            let capture = try await final.capture(Data([4, 5, 6]), index: 0, challenge: login), authenticated = try await final.completeFace(login, captures: [capture])
            try require(authenticated.accountID == AccountFixture.account && authenticated.authenticated && (try store.read("account-recovery-journal")) == nil, "Fresh comparison promotes exact original account")
            let known = try await final.device(); try require(known?.keyAlias?.hasPrefix(NativeAccountRecoveryRecord.aliasPrefix) == true, "Promoted alias survives for subsequent ordinary login")
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, _) = await newDevice(fixture)
            let wrong = "LVR1:" + AccountFixture.account + ":lfr_" + Data(repeating: 7, count: 32).base64URL
            try await rejects("Wrong private recovery key") { _ = try await device.startAccountRecovery(backup: wrong) }
            try require((try store.read("account-recovery-journal")) != nil, "Wrong key remains an unavailable explicit request; no replacement account")
            let old = try store.journal(); try await device.useAnotherRecoveryKey()
            let count = await device.retiredRecoveryCount(); try require(count == 1 && (try store.read("account-recovery-journal")) == nil, "Explicit replacement archives the prior private attempt")
            let corrected = try await device.startAccountRecovery(backup: backup), current = try store.journal()
            try require(corrected.accountID == old.accountID && current.requestID != old.requestID && current.keyAlias != old.keyAlias, "Corrected backup starts a distinct same-account request/alias")
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, _) = await newDevice(fixture)
            let first = try await device.startAccountRecovery(backup: backup), capture = try await device.capture(Data([1, 2]), index: 0, challenge: first.challenge!)
            await fixture.rejectFace(); try await rejects("Wrong fresh face") { _ = try await device.completeFace(first.challenge!, captures: [capture]) }
            let current = await device.summary(); try require(current == nil && (try store.journal()).promotionCredentials == nil, "Wrong face cannot mint/publish credentials")
            let resumed = try await device.recoverAccount(); try require(resumed.state == .restartRequired && resumed.receipts.isEmpty, "Terminal wrong-face attempt retires proof progress")
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            let first = try await device.startAccountRecovery(backup: backup), old = try store.journal(), gate = AccountGate()
            await fixture.delayCapture(gate)
            let pending = Task { try await device.capture(Data([1, 2]), index: 0, challenge: first.challenge!) }
            await gate.started(); try await device.useAnotherRecoveryKey()
            _ = try await device.startAccountRecovery(backup: backup); let new = try store.journal()
            await gate.release(); try await rejects("Late retired capture") { _ = try await pending.value }
            try require(new.requestID != old.requestID && new.keyAlias != old.keyAlias && (try store.journal()).captures.isEmpty, "Late callback cannot populate or promote corrected request")
            _ = try signer.publicJWK(alias: old.keyAlias, create: false)
            try require((try store.read("retired-account-recoveries")) != nil, "Retired original attempt/key remains recognized privately")
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, _) = await newDevice(fixture)
            _ = try await device.startAccountRecovery(backup: backup)
            var list = (0..<16).map { _ -> NativeAccountRecoveryRecord in
                let id = UUID().uuidString.lowercased()
                return NativeAccountRecoveryRecord(accountID: AccountFixture.account, apiOrigin: origin.absoluteString, recoveryKey: "lfr_" + Data(repeating: 2, count: 32).base64URL, requestID: id, faceHandle: "lfh_" + Data(repeating: 3, count: 32).base64URL, keyAlias: NativeAccountRecoveryRecord.aliasPrefix + id, policy: AccountFixture.policy, createdAt: Date())
            }
            let held = try store.journal(); list[0] = held
            try store.write("retired-account-recoveries", data: JSONEncoder().encode(list))
            // A duplicate active/history slot from interrupted archival is
            // retired during bootstrap before any callback or authentication.
            let signer = AccountSigner(), restored = restart(fixture, store, signer); _ = try await restored.bootstrap()
            try require((try store.read("account-recovery-journal")) == nil, "Archive-first interrupted removal cannot resume retired active intent")
            _ = try await restored.startAccountRecovery(backup: backup)
            try await rejects("Bounded retired-history capacity") { try await restored.useAnotherRecoveryKey() }
            try require((try store.read("account-recovery-journal")) != nil, "Capacity hold keeps active request instead of discarding private ownership")
        }
        for clean in [false, true] {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            let first = try await device.startAccountRecovery(backup: backup), challenge = first.challenge!
            _ = try await device.capture(Data([1, 2]), index: 0, challenge: challenge); await fixture.expire(clean: clean)
            let restored = restart(fixture, store, signer); _ = try await restored.bootstrap(); let next = try await restored.continueAccountRecovery()
            try require(next.challenge?.id != challenge.id && next.challenge?.deviceID == challenge.deviceID && next.receipts.isEmpty && (try store.journal()).generation == 2, "Terminal cleanup resumes same newdevice with fresh capture")
        }
        for state in ["capture_pending", "verifying"] {
            let (_, fixture, _, _, backup) = try await setup(); let (device, _, _) = await newDevice(fixture); let first = try await device.startAccountRecovery(backup: backup)
            await fixture.status(state); let status = try await device.recoverAccount(); try require(status.awaitingServer, "Unresolved status stays blocked")
            try await rejects("Direct capture while unresolved") { _ = try await device.capture(Data([1, 2]), index: 0, challenge: first.challenge!) }
            try await rejects("Guest deletion while recovery held") { _ = try await device.requestGuestDeletion() }
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            let first = try await device.startAccountRecovery(backup: backup), proof = try await device.capture(Data([1, 2]), index: 0, challenge: first.challenge!)
            await fixture.lose("/auth/face/complete")
            try await rejects("Prepare committed A02 response loss") { _ = try await device.completeFace(first.challenge!, captures: [proof]) }
            let recovered = restart(fixture, store, signer); _ = try await recovered.bootstrap()
            let login = try await recovered.continueAccountRecovery(); await fixture.lose("/auth/face/proof/" + login.challenge!.id + "/0")
            try await rejects("Interrupted ordinary current-target selfie inside A02 journal") { _ = try await recovered.capture(Data([8, 9]), index: 0, challenge: login.challenge!) }
            let again = restart(fixture, store, signer), publicSession = try await again.bootstrap(), held = try await again.continueAccountRecovery()
            try require(publicSession == nil && held.awaitingServer && (try store.journal()).challengeWire?["challenge_id"].string == login.challenge!.id, "A02 signed recovery metadata cannot clear unexpired ordinary target-login ambiguity")
            let cameraCheck = try await again.prepareFaceRetake(login.challenge!, terminalQualityFailure: false)
            try require(cameraCheck.awaitingServer && cameraCheck.challenge?.id == login.challenge?.id, "A02 camera retry retains exact ordinary target proof without requesting another account/key/challenge")
        }
        for boundary in ["registered-device", "credentials", "account-recovery-journal"] {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            let first = try await device.startAccountRecovery(backup: backup), capture = try await device.capture(Data([1, 2]), index: 0, challenge: first.challenge!)
            store.fail(boundary, removal: boundary == "account-recovery-journal")
            try await rejects("Promotion interruption") { _ = try await device.completeFace(first.challenge!, captures: [capture]) }
            try require((try store.journal()).promotionCredentials != nil, "Staged credentials survive separate slot failure")
            let restored = restart(fixture, store, signer), result = try await restored.bootstrap()
            try require(result?.accountID == AccountFixture.account && result?.authenticated == true && (try store.read("account-recovery-journal")) == nil, "Promotion repair authenticates original account then retires journal")
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            let first = try await device.startAccountRecovery(backup: backup), proof = try await device.capture(Data([1, 2]), index: 0, challenge: first.challenge!)
            store.fail("registered-device")
            try await rejects("A02 staged completion before current target device publication") { _ = try await device.completeFace(first.challenge!, captures: [proof]) }
            let original = try store.journal(), staged = original.promotionCredentials!
            try require((try store.read("registered-device")) == nil, "A02 staged ownership is original signed target journal, not a published or stale device DTO")
            await device.clearSession(); try await device.logout()
            let retired = try store.journal(), tokens = await fixture.logoutTokens, beforeAwait = await fixture.logoutSawRetiredPromotion
            try require(beforeAwait && tokens.contains("Bearer " + staged.access_token) && retired.promotionCredentials == nil && retired.promotionDevice == nil && retired.requestID == original.requestID && retired.keyAlias == original.keyAlias && retired.publicKeyDigest == original.publicKeyDigest, "A02 explicit logout retires target promotion before transport and revokes exact staged token without replacing key/account")
            let rebuilt = restart(fixture, store, signer), session = try await rebuilt.bootstrap()
            try require(session == nil && (try store.journal()).promotionCredentials == nil, "A02 restart cannot automatically publish explicitly retired staged authentication")
        }
        for drift in ["profile", "device", "inactive"] {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            let first = try await device.startAccountRecovery(backup: backup), capture = try await device.capture(Data([1, 2]), index: 0, challenge: first.challenge!)
            if drift == "profile" { await fixture.driftCurrent(["profile_revision": .string("changed")]) }
            else { await fixture.driftDevice(drift == "device" ? ["id": .string(AccountFixture.guest)] : ["status": .string("revoked")]) }
            try await rejects("Promotion current binding drift") { _ = try await device.completeFace(first.challenge!, captures: [capture]) }
            try require((try store.journal()).promotionCredentials != nil && (try store.read("registered-device")) == nil, "Drift/unavailable authority keeps staged journal and does not publish a new reference")
            await fixture.driftCurrent([:]); await fixture.driftDevice([:]); let restored = restart(fixture, store, signer)
            let recovered = try await restored.bootstrap(); try require(recovered?.authenticated == true, "Exact current profile/device enables promotion repair")
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            let first = try await device.startAccountRecovery(backup: backup), capture = try await device.capture(Data([1, 2]), index: 0, challenge: first.challenge!)
            store.fail("registered-device"); try await rejects("Prepare staged credential") { _ = try await device.completeFace(first.challenge!, captures: [capture]) }
            var record = try store.journal(); let previous = record.promotionCredentials!
            var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(previous)) as! [String: Any]
            object["expiresAt"] = Date().addingTimeInterval(-5).timeIntervalSinceReferenceDate
            record.promotionCredentials = try JSONDecoder().decode(NativeCredentials.self, from: JSONSerialization.data(withJSONObject: object))
            try store.write("account-recovery-journal", data: JSONEncoder().encode(record)); await fixture.failNextRefreshSlot()
            let failed = restart(fixture, store, signer); try await rejects("Refresh slot failure") { _ = try await failed.bootstrap() }
            let survivor = try store.journal().promotionCredentials!; try require(survivor.refresh_token != previous.refresh_token, "Journal-first promotion refresh survives stale slot")
            let restored = restart(fixture, store, signer); let result = try await restored.bootstrap()
            let count = await fixture.refreshed(previous.refresh_token)
            try require(count == 1 && result?.authenticated == true, "Restart never reuses the consumed promotion refresh")
        }
        let altered: [(String, WireValue)] = [("account_id", .string(AccountFixture.guest)), ("public_key_digest", .string(String(repeating: "f", count: 64))), ("policy_version", .string("wrong")), ("device_id", .string(AccountFixture.guest)), ("request_nonce", .string(AccountFixture.guest)), ("generation", .integer(2)), ("authenticated", .bool(true)), ("challenge_id", .string(AccountFixture.guest)), ("profile", .object(["id": .string(AccountFixture.profile), "revision": .string("changed"), "model_id": .string("yunet-sface-v1")]))]
        for (field, value) in altered {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, _) = await newDevice(fixture); _ = try await device.startAccountRecovery(backup: backup); let before = try store.journal()
            await fixture.override([field: value]); try await rejects("Status identity " + field) { _ = try await device.recoverAccount() }
            try require((try store.journal()).requestID == before.requestID, "Unverified status keeps original journal")
        }
        for (status, code) in [(503, "unavailable"), (401, "account_recovery_unavailable"), (404, "unknown")] {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture); _ = try await device.startAccountRecovery(backup: backup)
            await fixture.unavailable(status, code); let restored = restart(fixture, store, signer)
            try await rejects("Unknown/revoked/transient recovery") { _ = try await restored.bootstrap() }
            let anon = await fixture.anonymousCount; try require(anon == 0 && (try store.read("account-recovery-journal")) != nil, "No replacement account on unavailable authority")
        }
        for missing in [true, false] {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture); _ = try await device.startAccountRecovery(backup: backup); let alias = try store.journal().keyAlias
            if missing { signer.clear(alias: alias) } else { signer.replace(alias) }
            let paths = await fixture.paths.count, restored = restart(fixture, store, signer)
            try await rejects("Missing/replaced recovery key") { _ = try await restored.bootstrap() }
            let after = await fixture.paths.count; try require(paths == after, "No network/newkey after original recovery alias loss")
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture); store.fail("account-recovery-journal")
            try await rejects("Initial journal save failure") { _ = try await device.startAccountRecovery(backup: backup) }
            try require(!(try signer.hasRetainedKey()), "Failed preparation cannot allocate untracked new key")
            _ = try await device.startAccountRecovery(backup: backup); try require((try store.journal()).accountID == AccountFixture.account, "Preparation storage retry retains named original account")
        }
        do {
            let (_, fixture, _, _, backup) = try await setup(); let (device, store, signer) = await newDevice(fixture)
            let credential = try NativeCredentials(await fixture.credential(account: AccountFixture.guest, method: "anonymous"))
            let held = NativeGuestDeletionRecord(accountID: AccountFixture.guest, operationKey: UUID().uuidString.lowercased(), statusToken: "lvd_" + String(repeating: "c", count: 64), apiOrigin: origin.absoluteString, reason: nil, preparedAt: Date(), originalCredentials: credential)
            try store.write("guest-deletion-receipt", data: JSONEncoder().encode(held)); let restored = restart(fixture, store, signer); _ = try await restored.bootstrap()
            try await rejects("D04 priority") { _ = try await restored.startAccountRecovery(backup: backup) }
            try require((try store.read("account-recovery-journal")) == nil && !(try signer.hasRetainedKey()), "Deletion hold forbids new recovery intent/key")
        }
    }
    static func main() async { do { try await run(); print("Native account recovery controlled checks passed: \(checks). Host fixtures only.") } catch { print("Native account recovery checks FAILED: " + error.localizedDescription); exit(1) } }
}
