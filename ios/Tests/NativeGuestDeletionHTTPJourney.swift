import Foundation
import CryptoKit

// Actual HTTP proof using BackendRepository and NativeURLTransport. Only host
// protected storage is substituted. No verifier, server, transport response,
// administrator approval or cleanup outcome is mocked or elevated.
private final class GuestHTTPSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; values[name] = data }
    func record() throws -> NativeGuestDeletionRecord {
        guard let bytes = try read("guest-deletion-receipt") else { throw NativeAPIError.invalidResponse }
        return try JSONDecoder().decode(NativeGuestDeletionRecord.self, from: bytes)
    }
}
private struct GuestHTTPNoEnrollmentSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.unsupported("This guest HTTP journey must not enroll a face") }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
}
private final class GuestHTTPTrace: NativeTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let live = NativeURLTransport()
    private let secrets: GuestHTTPSecrets
    private var paths: [String] = []
    private var statusBearerCount = 0
    init(secrets: GuestHTTPSecrets) { self.secrets = secrets }
    private func record(_ request: URLRequest) throws {
        guard let url = request.url, url.query == nil else { throw NativeAPIError.invalidResponse }
        if url.path == "/privacy/account-deletion" {
            guard let bytes = request.httpBody, try WireValue.decoded(bytes) == secrets.record().payload else { throw NativeAPIError.invalidResponse }
        }
        lock.lock(); defer { lock.unlock() }; paths.append(url.path)
        if url.path == "/privacy/account-deletion/status", request.value(forHTTPHeaderField: "Authorization") != nil { statusBearerCount += 1 }
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        try record(request)
        return try await live.send(request, limit: limit)
    }
    func cancelPending() { live.cancelPending() }
    func counts() -> (anonymous: Int, statusBearer: Int, forbiddenFace: Int) {
        lock.lock(); defer { lock.unlock() }
        return (paths.filter { $0 == "/auth/anonymous" }.count, statusBearerCount, paths.filter { $0.contains("/face/") || $0.lowercased().contains("otp") }.count)
    }
}
private struct GuestHTTPCheck: Encodable { let name: String, status: String }
private struct GuestHTTPReport: Encodable {
    let schema = 1
    let status: String, scope: String, transport: String, protected_storage: String
    let checks: [GuestHTTPCheck], assertions_passed: Int
    let failure_code: String?
    let does_not_establish: [String]
}

@main struct NativeGuestDeletionHTTPJourney {
    private static var checks: [GuestHTTPCheck] = []
    private static var assertions = 0
    private static func require(_ condition: Bool, _ label: String) throws {
        guard condition else { throw NativeAPIError.unsupported("Guest HTTP check failed: " + label) }; assertions += 1
    }
    private static func rejects(_ label: String, _ work: () async throws -> Void) async throws {
        do { try await work() } catch { assertions += 1; return }
        throw NativeAPIError.unsupported("Guest HTTP rejection missing: " + label)
    }
    private static func passed(_ label: String) { checks.append(GuestHTTPCheck(name: label, status: "passed")); print("guest-native-http: " + label) }
    private static func report(status: String, failure: String?) -> GuestHTTPReport {
        GuestHTTPReport(status: status, scope: "Actual anonymous own-account deletion creation, restart and read-only recovery; no privileged approval", transport: "Production NativeURLTransport / URLSession against explicit local Cloudflare HTTP", protected_storage: "Host in-memory substitute; Keychain is not qualified", checks: checks, assertions_passed: assertions, failure_code: failure,
            does_not_establish: ["iOS SDK application build", "iOS UI or physical device", "Keychain or Secure Enclave", "administrator approval", "completed deletion or private R2 cleanup", "face enrollment", "hosted deployment or store submission"])
    }
    static func main() async throws {
        guard CommandLine.arguments.count == 3, let origin = URL(string: CommandLine.arguments[1]), origin.scheme == "http",
              ["localhost", "127.0.0.1"].contains(origin.host ?? ""), origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil, ["", "/"].contains(origin.path) else { throw NativeAPIError.unsupported("Usage: guest-http http://127.0.0.1:18887 output.json") }
        let output = URL(fileURLWithPath: CommandLine.arguments[2])
        do {
            let secrets = GuestHTTPSecrets(), transport = GuestHTTPTrace(secrets: secrets), signer = GuestHTTPNoEnrollmentSigner()
            let repository = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer)
            let guest = try await repository.bootstrap(), current = try await repository.current()
            try require(guest?.authenticated == false && guest?.roles == ["user"], "actual anonymous bootstrap")
            try require(current["user_id"].string == guest?.accountID && current["authenticated"].bool == false && current["auth_method"].string == "anonymous", "actual same-account current session")
            passed("anonymous-current-session")
            try await rejects("protected gallery") { _ = try await repository.photos() }
            try await rejects("generic privacy export") { _ = try await repository.post("/privacy/export", payload: .object([:]), operation: "privacy.request.export") }
            try await rejects("generic deletion remains registered-only") { _ = try await repository.post("/privacy/account-deletion", payload: .object([:]), operation: "privacy.request.delete") }
            let tokenData = try secrets.read("credentials")!
            let anonymousCredential = try JSONDecoder().decode(NativeCredentials.self, from: tokenData)
            var denied = URLRequest(url: URL(string: "/community/action", relativeTo: origin)!.absoluteURL)
            denied.httpMethod = "POST"; denied.setValue("application/json", forHTTPHeaderField: "Content-Type")
            denied.setValue("Bearer " + anonymousCredential.access_token, forHTTPHeaderField: "Authorization")
            denied.httpBody = try WireValue.object(["action": .string("photos"), "payload": .object([:])]).encoded()
            let serverDenied = try await NativeURLTransport().send(denied, limit: 2 * 1024 * 1024)
            let denialWire = try WireValue.decoded(serverDenied.data)
            try require(serverDenied.status == 403 && denialWire["error"]["code"].string == "registered_face_required", "actual server rejects anonymous media authority")
            passed("registered-authority-denied")
            let pending = try await repository.requestGuestDeletion(), record = try secrets.record(), retired = await repository.summary()
            try require(pending.status?.phase == .pendingApproval && !pending.completed && !pending.requestExpired, "actual request is pending approval")
            try require(record.accountID == guest?.accountID && record.originalCredentials?.account_id == guest?.accountID && record.statusToken.count == 68, "bound receipt and encrypted-store data contract")
            try require(record.status?.requestID == pending.status?.requestID && retired == nil && (try secrets.read("credentials")) == nil, "acknowledgement retires public guest session")
            passed("dedicated-deletion-created")
            let restored = BackendRepository(origin: origin, transport: transport, secrets: secrets, signer: signer)
            let restartSession = try await restored.bootstrap(), status = try await restored.checkGuestDeletion()
            try require(restartSession == nil && status.status?.requestID == pending.status?.requestID && status.status?.phase == .pendingApproval && !status.completed, "actual read-only receipt restores original request")
            try require(status.status?.receiptExpiresAt == pending.status?.receiptExpiresAt && status.status?.requestExpiresAt == pending.status?.requestExpiresAt, "polling renews neither receipt nor approval deadline")
            try await rejects("automatic replacement guest") { _ = try await restored.startAgainAfterGuestDeletion() }
            try await rejects("resume while pending") { _ = try await restored.resumeGuestSetup() }
            try await rejects("pending record has no protected access") { _ = try await restored.protectedJSON("/privacy/center") }
            passed("receipt-before-bootstrap-and-status")
            try await restored.logout()
            let afterLogout = try await restored.checkGuestDeletion(), trace = transport.counts()
            try require(afterLogout.status?.requestID == pending.status?.requestID && !afterLogout.completed, "receipt status survives retired bearer")
            try require(trace.anonymous == 1 && trace.statusBearer == 0 && trace.forbiddenFace == 0, "no new bootstrap, status bearer, face enrollment or OTP calls")
            try require((try secrets.record()).originalCredentials?.account_id == guest?.accountID, "unresolved request retains original guest recovery credentials")
            passed("logout-read-only-recovery")
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(report(status: "passed", failure: nil)).write(to: output, options: .atomic)
            print("Native guest deletion actual HTTP assertions passed: \(assertions)")
        } catch {
            let safe: String
            switch error {
            case NativeAPIError.denied(let status, let code): safe = "http_\(status):\(code)"
            case NativeAPIError.invalidResponse: safe = "native_contract_rejected"
            case NativeAPIError.sessionChanged: safe = "session_changed"
            case NativeAPIError.unsupported(let detail): safe = detail
            default: safe = "native_http_unavailable"
            }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(report(status: "failed", failure: safe)).write(to: output, options: .atomic)
            throw error
        }
    }
}
