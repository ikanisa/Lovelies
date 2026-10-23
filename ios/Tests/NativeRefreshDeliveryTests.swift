import Foundation
import CryptoKit

private final class DeliverySecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock(); private var values: [String: Data] = [:]
    private var failName: String?, failRemoval = false
    func fail(_ name: String, removal: Bool = false) { lock.lock(); defer { lock.unlock() }; failName = name; failRemoval = removal }
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if name == failName, !failRemoval || data == nil { failName = nil; throw NativeAPIError.unavailable("controlled_storage_failure") }
        values[name] = data
    }
    func journal() throws -> NativeRefreshDeliveryRecord? { try read("refresh-delivery-journal-v1").map { try JSONDecoder().decode(NativeRefreshDeliveryRecord.self, from: $0) } }
    func credential() throws -> NativeCredentials? { try read("credentials").map { try JSONDecoder().decode(NativeCredentials.self, from: $0) } }
}
private struct DeliverySigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.unavailable("not_used") }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
}
private actor DeliveryGate {
    private var entered = false, released = false
    private var waiters: [CheckedContinuation<Void, Never>] = [], pending: CheckedContinuation<Void, Never>?
    func pause() async { entered = true; waiters.forEach { $0.resume() }; waiters = []; if !released { await withCheckedContinuation { pending = $0 } } }
    func wait() async { if !entered { await withCheckedContinuation { waiters.append($0) } } }
    func release() { released = true; pending?.resume(); pending = nil }
}
private actor DeliveryTransport: NativeTransport {
    static let account = "00000000-0000-4000-8000-0000000000f1"
    static let device = "00000000-0000-4000-8000-0000000000f2"
    let secrets: DeliverySecrets
    private var delivered: [String: WireValue] = [:], requests: [WireValue] = [], cancelled: Set<String> = []
    private var lose = false, loseCancel = false, expiredSuccessor = false, tamper: String?, errorCode: (Int, String)?, gate: DeliveryGate?
    private(set) var rotations = 0, anonymousCount = 0, cancellationCount = 0, preparedBeforeDispatch = true, firstSuccessorSavedBeforeSecond = true
    init(_ secrets: DeliverySecrets) { self.secrets = secrets }
    nonisolated func cancelPending() {}
    func loseNext() { lose = true }
    func loseCancellationNext() { loseCancel = true }
    func expiredNext() { expiredSuccessor = true }
    func tamperNext(_ field: String) { tamper = field }
    func reject(_ status: Int, _ code: String) { errorCode = (status, code) }
    func delay(_ gate: DeliveryGate) { self.gate = gate }
    func bodies() -> [WireValue] { requests }
    static func wire(method: String, refresh: String, expires: Date = Date().addingTimeInterval(900)) throws -> WireValue {
        let claims: WireValue = .object(["sub": .string(account), "auth_method": .string(method), "exp": .integer(Int(expires.timeIntervalSince1970))])
        return .object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".signature-" + refresh), "refresh_token": .string(refresh), "account_id": .string(account), "auth_method": .string(method), "roles": .strings(["user"]), "expires_in": .integer(900)])
    }
    private func reply(_ wire: WireValue, status: Int = 200) throws -> NativeHTTPReply { NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: try wire.encoded()) }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path, body = try request.httpBody.map(WireValue.decoded) ?? .null
        if path == "/auth/anonymous" { anonymousCount += 1; return try reply(Self.wire(method: "anonymous", refresh: "new-guest-forbidden")) }
        if path == "/auth/logout" { return try reply(.object(["status": .string("logged_out")])) }
        if path == "/me" {
            guard let token = request.value(forHTTPHeaderField: "Authorization")?.split(separator: " ").last,
                  let claimsBytes = token.split(separator: ".").dropFirst().first.flatMap({ Data(base64URL: String($0)) }), let claims = try? WireValue.decoded(claimsBytes) else { throw NativeAPIError.invalidResponse }
            return try reply(.object(["user_id": .string(Self.account), "auth_method": claims["auth_method"], "authenticated": .bool(claims["auth_method"].string == "registered_face")]))
        }
        if path == "/auth/session/refresh/cancel" {
            let key = try body.uuid("rotation_key"); cancelled.insert(key); cancellationCount += 1
            if loseCancel { loseCancel = false; throw URLError(.networkConnectionLost) }
            return try reply(.object(["protocol": .string(NativeRefreshDeliveryRecord.protocolName), "rotation_key": .string(key), "account_id": .string(Self.account), "status": .string("cancelled")]))
        }
        guard path == "/auth/session/refresh", body["protocol"].string == NativeRefreshDeliveryRecord.protocolName else { throw NativeAPIError.unsupported("Unexpected controlled refresh path") }
        requests.append(body)
        let key = try body.uuid("rotation_key"), secret = try body.text("delivery_secret"), old = try body.text("refresh_token")
        let saved = try secrets.journal()
        preparedBeforeDispatch = preparedBeforeDispatch && saved?.rotationKey == key && saved?.deliverySecret == secret && saved?.original.refresh_token == old
        if rotations == 1, delivered[key] == nil, old == "successor-1" { firstSuccessorSavedBeforeSecond = try secrets.credential()?.refresh_token == old }
        if let errorCode { return try reply(.object(["error": .object(["code": .string(errorCode.1)])]), status: errorCode.0) }
        if cancelled.contains(key) { return try reply(.object(["error": .object(["code": .string("refresh_invalid")])]), status: 401) }
        let result: WireValue
        if let previous = delivered[key] { result = previous }
        else {
            let original = try secrets.journal()!.original
            rotations += 1; let expiry = expiredSuccessor ? Date().addingTimeInterval(-20) : Date().addingTimeInterval(900); expiredSuccessor = false
            var fields = try Self.wire(method: original.auth_method, refresh: "successor-" + String(rotations), expires: expiry).object!
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            fields["protocol"] = .string(NativeRefreshDeliveryRecord.protocolName); fields["rotation_key"] = .string(key)
            fields["access_expires_at"] = .string(formatter.string(from: Date(timeIntervalSince1970: floor(expiry.timeIntervalSince1970))))
            fields["refresh_expires_at"] = .string(formatter.string(from: Date().addingTimeInterval(7 * 86400)))
            fields["delivery_expires_at"] = .string(formatter.string(from: Date().addingTimeInterval(86400)))
            result = .object(fields); delivered[key] = result
        }
        if lose { lose = false; throw URLError(.networkConnectionLost) }
        if let gate { self.gate = nil; await gate.pause() }
        if let field = tamper {
            tamper = nil; var value = result.object!
            value[field] = .string(field == "rotation_key" || field == "account_id" ? UUID().uuidString.lowercased() : "unsupported")
            return try reply(.object(value))
        }
        return try reply(result)
    }
}

@main struct NativeRefreshDeliveryTests {
    private static var checks = 0
    private static let origin = URL(string: "https://refresh.invalid")!, signer = DeliverySigner()
    private static func expect(_ value: Bool, _ detail: String) throws { guard value else { throw NativeAPIError.unsupported("Refresh delivery check: " + detail) }; checks += 1 }
    private static func reject(_ work: () async throws -> Void) async throws { do { try await work() } catch { checks += 1; return }; throw NativeAPIError.unsupported("Expected refresh rejection") }
    private static func expired(_ method: String) throws -> NativeCredentials {
        let credential = try NativeCredentials(DeliveryTransport.wire(method: method, refresh: "original-refresh"))
        var values = try JSONSerialization.jsonObject(with: JSONEncoder().encode(credential)) as! [String: Any]
        values["expiresAt"] = Date().addingTimeInterval(-5).timeIntervalSinceReferenceDate
        return try JSONDecoder().decode(NativeCredentials.self, from: JSONSerialization.data(withJSONObject: values))
    }
    private static func fixture(_ method: String = "anonymous") throws -> (DeliverySecrets, DeliveryTransport, BackendRepository) {
        let secrets = DeliverySecrets(); try secrets.write("credentials", data: JSONEncoder().encode(expired(method)))
        if method == "registered_face" {
            let device = RegisteredDevice(accountID: DeliveryTransport.account, faceHandle: "lfh_" + Data(repeating: 1, count: 32).base64URL, deviceID: DeliveryTransport.device, profileID: UUID().uuidString.lowercased(), profileRevision: "current", modelID: "controlled")
            try secrets.write("registered-device", data: JSONEncoder().encode(device))
        }
        let transport = DeliveryTransport(secrets), repository = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer)
        return (secrets, transport, repository)
    }
    static func main() async throws {
        for method in ["anonymous", "registered_face"] {
            let (secrets, transport, repository) = try fixture(method); await transport.loseNext()
            try await reject { _ = try await repository.bootstrap() }
            let saved = try secrets.journal()!
            try expect(saved.original.refresh_token == "original-refresh" && saved.response == nil, "committed/lost response retains exact private original request")
            let restarted = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer)
            let restored = try await restarted.bootstrap()
            let bodies = await transport.bodies(), rotations = await transport.rotations, anonymous = await transport.anonymousCount, prepared = await transport.preparedBeforeDispatch
            try expect(restored?.accountID == DeliveryTransport.account && restored?.authenticated == (method == "registered_face"), "restart resumes same account/method")
            try expect(bodies.count == 2 && bodies[0] == bodies[1] && rotations == 1, "identical request replay produces exactly one successor")
            try expect(anonymous == 0 && prepared && (try secrets.journal()) == nil, "prepare is durable before dispatch and unknown never creates replacement identity")
        }
        for boundary in ["refresh-delivery-journal-v1", "credentials"] {
            let (secrets, transport, repository) = try fixture(); secrets.fail(boundary)
            try await reject { _ = try await repository.bootstrap() }
            let rotations = await transport.rotations
            try expect(rotations == (boundary == "credentials" ? 1 : 0), "private preparation failure cannot send; credential failure keeps delivered successor")
            let restarted = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer)
            let result = try await restarted.bootstrap(); try expect(result?.accountID == DeliveryTransport.account, "storage failure repairs original rotation")
            try expect(await transport.rotations == 1, "repair does not rotate consumed original again")
        }
        do {
            let (secrets, transport, repository) = try fixture(); secrets.fail("refresh-delivery-journal-v1", removal: true)
            try await reject { _ = try await repository.bootstrap() }
            try expect(try secrets.credential()?.refresh_token == "successor-1" && secrets.journal()?.response != nil, "failed retirement retains durable successor and receipt")
            let restarted = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer); _ = try await restarted.bootstrap()
            try expect(try secrets.journal() == nil, "restart retires only after successor is durable")
            try expect(await transport.rotations == 1, "retirement failure never causes second rotation")
        }
        do {
            let (secrets, transport, repository) = try fixture(); await transport.expiredNext(); let result = try await repository.bootstrap()
            let bodies = await transport.bodies(), rotations = await transport.rotations, saved = await transport.firstSuccessorSavedBeforeSecond
            try expect(rotations == 2 && bodies.count == 2 && bodies[0]["rotation_key"] != bodies[1]["rotation_key"], "expired original access delivery rotates successor using fresh key")
            try expect(saved && bodies[1]["refresh_token"].string == "successor-1", "expired delivered successor is durable before next dispatch")
            try expect(result!.expiresAt > Date() && (try secrets.credential())?.refresh_token == "successor-2", "replayed expires_in never extends expired access")
        }
        for field in ["rotation_key", "account_id", "auth_method"] {
            let (secrets, transport, repository) = try fixture(); await transport.tamperNext(field)
            try await reject { _ = try await repository.bootstrap() }
            try expect(try secrets.credential()?.refresh_token == "original-refresh" && secrets.journal() != nil, "wrong response binding cannot replace retained authority")
        }
        for (status, code) in [(401, "refresh_invalid"), (410, "refresh_delivery_expired"), (503, "refresh_delivery_unavailable")] {
            let (secrets, transport, repository) = try fixture(); await transport.reject(status, code)
            try await reject { _ = try await repository.bootstrap() }
            try expect(try secrets.credential()?.account_id == DeliveryTransport.account && secrets.journal() != nil, "server rejection/expired receipt retains original reconciliation identity")
            try expect(await transport.anonymousCount == 0, "rejection cannot fall through to replacement guest")
        }
        do {
            let (secrets, transport, repository) = try fixture("registered_face"), gate = DeliveryGate(); await transport.delay(gate)
            let pending = Task { try await repository.bootstrap() }; await gate.wait()
            try await repository.logout(); try expect(try secrets.journal()?.suspended == true && secrets.credential() == nil, "explicit logout persists suspension before local authority removal")
            await gate.release(); try await reject { _ = try await pending.value }
            try expect(await repository.summary() == nil && (try secrets.credential()) == nil, "late refresh cannot restore logged-out authority")
            let restarted = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer); let result = try await restarted.bootstrap()
            try expect(result == nil && (try secrets.journal())?.suspended == true, "restart never replays suspended authority")
        }
        do {
            let (secrets, transport, repository) = try fixture("registered_face"); await transport.loseNext(); try await reject { _ = try await repository.bootstrap() }
            secrets.fail("refresh-delivery-journal-v1"); try await reject { try await repository.logout() }
            try expect(try secrets.credential() != nil && secrets.journal()?.suspended == false, "logout marker storage failure cannot clear authority first")
        }
        do {
            let (secrets, transport, repository) = try fixture(); await transport.loseNext(); try await reject { _ = try await repository.bootstrap() }
            let record = try secrets.journal()!
            try expect(record.deliverySecret.count == 43 && Data(base64URL: record.deliverySecret)?.count == 32 && Data(base64URL: record.deliverySecret)?.base64URL == record.deliverySecret, "delivery secret is canonical random32-byte base64url")
            let other = BackendRepository(origin: URL(string: "https://other-deployment.invalid")!, transport: transport, secrets: secrets, signer: signer)
            try await reject { _ = try await other.bootstrap() }
            try expect(await transport.anonymousCount == 0, "another deployment cannot adopt pending refresh or create guest")
        }
        do {
            let (secrets, transport, repository) = try fixture("registered_face"), gate = DeliveryGate(); await transport.delay(gate)
            let pending = Task { try await repository.bootstrap() }; await gate.wait()
            var device = try JSONDecoder().decode(RegisteredDevice.self, from: secrets.read("registered-device")!); device.profileRevision = "changed-current-device"
            try secrets.write("registered-device", data: JSONEncoder().encode(device)); await gate.release()
            try await reject { _ = try await pending.value }
            try expect(try secrets.credential()?.refresh_token == "original-refresh", "changed device/profile binding fences late delivery adoption")
        }
        do {
            let (secrets, transport, repository) = try fixture(), gate = DeliveryGate(); await transport.delay(gate)
            let pending = Task { try await repository.bootstrap() }; await gate.wait()
            let previous = try secrets.journal()!
            let replacement = NativeRefreshDeliveryRecord(origin: origin, original: previous.original, owner: previous.ownerBinding, device: previous.deviceBinding, secret: Data(repeating: 7, count: 32).base64URL)
            try secrets.write("refresh-delivery-journal-v1", data: JSONEncoder().encode(replacement)); await gate.release()
            try await reject { _ = try await pending.value }
            try expect(try secrets.journal()?.rotationKey == replacement.rotationKey && secrets.credential()?.refresh_token == "original-refresh", "stale response cannot overwrite or clear a newer local CAS record")
        }
        do {
            let (secrets, transport, repository) = try fixture("registered_face"); await transport.loseNext(); try await reject { _ = try await repository.bootstrap() }
            await transport.loseCancellationNext(); try await repository.logout()
            for _ in 0..<100 { if await transport.cancellationCount >= 1 { break }; try await Task.sleep(for: .milliseconds(2)) }
            try expect(try secrets.journal()?.suspended == true && secrets.journal()?.cancellationConfirmed == false && secrets.credential() == nil, "lost cancellation reply retains suspension and never restores credentials")
            let restarted = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer); let resumed = try await restarted.bootstrap()
            for _ in 0..<100 { if try secrets.journal()?.cancellationConfirmed == true { break }; try await Task.sleep(for: .milliseconds(2)) }
            try expect(resumed == nil && (try secrets.journal())?.cancellationConfirmed == true, "restart retries the exact suspended cancellation and persists bound acknowledgement")
            let finalRotations = await transport.rotations, finalBodies = await transport.bodies()
            try expect(finalRotations == 1 && finalBodies.count == 1, "cancel reconciliation never replays retired rotation")
        }
        do {
            let (secrets, transport, repository) = try fixture("registered_face"); await transport.loseNext(); try await reject { _ = try await repository.bootstrap() }
            let previous = try secrets.journal()!
            // Emulate the canonical fresh-face completion's durable credential
            // publication. Its new session must never adopt the old response.
            let verified = try NativeCredentials(DeliveryTransport.wire(method: "registered_face", refresh: "fresh-verified-face-session"))
            try secrets.write("credentials", data: JSONEncoder().encode(verified))
            let restarted = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer); let resumed = try await restarted.bootstrap()
            let history = try JSONDecoder().decode([NativeRefreshDeliveryRecord].self, from: secrets.read("retired-refresh-deliveries-v1")!)
            try expect(resumed?.authenticated == true && (try secrets.credential())?.refresh_token == "successor-2", "fresh verified session replaces local scope without adopting retired successor")
            try expect(history.contains(where: { $0.rotationKey == previous.rotationKey && $0.deliverySecret == previous.deliverySecret && $0.suspended }), "old cancellation authority survives in protected archive")
            try expect(try secrets.journal() == nil, "new scope clears only its durably adopted delivery record")
            let finalRepository = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer); _ = try await finalRepository.bootstrap()
            for _ in 0..<100 {
                let rows = try JSONDecoder().decode([NativeRefreshDeliveryRecord].self, from: secrets.read("retired-refresh-deliveries-v1")!)
                if rows.first(where: { $0.rotationKey == previous.rotationKey })?.cancellationConfirmed == true { break }
                try await Task.sleep(for: .milliseconds(2))
            }
            let confirmed = try JSONDecoder().decode([NativeRefreshDeliveryRecord].self, from: secrets.read("retired-refresh-deliveries-v1")!)
            try expect(confirmed.first(where: { $0.rotationKey == previous.rotationKey })?.cancellationConfirmed == true, "archive cancellation reconciles across restart without touching fresh credentials")
            try expect(try secrets.credential()?.refresh_token == "successor-2", "old cancellation acknowledgement cannot overwrite fresh session")
        }
        do {
            let (secrets, transport, repository) = try fixture("registered_face"); await transport.loseNext(); try await reject { _ = try await repository.bootstrap() }
            secrets.fail("credentials", removal: true); try await repository.logout()
            try expect(try secrets.credential() != nil && secrets.journal()?.suspended == true, "failed vault deletion retains a retired slot without public authority")
            let restarted = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer)
            try await reject { _ = try await restarted.bootstrap() }
            try expect(await restarted.summary() == nil, "suspension outranks stale credential/promotion slot after restart")
        }
        print("Native refresh delivery checks passed: \(checks)")
    }
}
