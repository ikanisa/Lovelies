import Foundation
import CryptoKit

// Real NativeURLTransport and repository against the isolated production API.
// This substitutes only host storage/signing; no guardian is approved or enrolled.
private final class AudienceHTTPSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; values[name] = data }
}
private struct AudienceHTTPNoEnrollment: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.unsupported("This journey cannot enroll a face") }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
}

@main struct NativeAudienceHTTPJourney {
    private static var assertions = 0
    private static var checks: [String] = []
    private static func require(_ value: Bool, _ label: String) throws {
        guard value else { throw NativeAPIError.unsupported(label) }; assertions += 1
    }
    private static func denied(_ code: String, _ action: () async throws -> Void) async throws {
        do { try await action() }
        catch NativeAPIError.denied(403, let actual) { try require(actual == code, "Unexpected purpose denial"); return }
        throw NativeAPIError.unsupported("Purpose gate did not reject")
    }
    private static func control(_ action: String, origin: URL, secret: String) async throws -> WireValue {
        var request = URLRequest(url: origin.appendingPathComponent("control"))
        request.httpMethod = "POST"; request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(secret, forHTTPHeaderField: "X-Lovelies-Fixture-Control")
        request.httpBody = try WireValue.object(["action": .string(action)]).encoded()
        let (bytes, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw NativeAPIError.invalidResponse }
        return try WireValue.decoded(bytes)
    }
    private static func make(_ origin: URL) -> (BackendRepository, AudienceHTTPSecrets) {
        let secrets = AudienceHTTPSecrets()
        return (BackendRepository(origin: origin, transport: NativeURLTransport(), secrets: secrets, signer: AudienceHTTPNoEnrollment()), secrets)
    }
    static func main() async throws {
        guard CommandLine.arguments.count == 4,
              let origin = URL(string: CommandLine.arguments[1]), let controller = URL(string: CommandLine.arguments[2]),
              origin.port != controller.port,
              let secret = ProcessInfo.processInfo.environment["LOVELIES_NATIVE_AUDIENCE_CONTROL_SECRET"], secret.count >= 32 else { throw NativeAPIError.invalidResponse }
        for url in [origin, controller] {
            guard url.scheme == "http", url.host == "127.0.0.1" else { throw NativeAPIError.invalidResponse }
            guard url.port != nil, url.query == nil, url.fragment == nil else { throw NativeAPIError.invalidResponse }
            guard url.user == nil, url.password == nil else { throw NativeAPIError.invalidResponse }
        }
        let output = URL(fileURLWithPath: CommandLine.arguments[3])
        do {
            let (child, _) = make(origin)
            guard let first = try await child.bootstrap() else { throw NativeAPIError.invalidResponse }
            let unknown = try await child.audience()
            try require(!first.authenticated && unknown.accountID == first.accountID && unknown.ageBand == .unknown && !unknown.capabilities.any, "Default must be the same unknown anonymous account")
            let blocked = try await child.declareAudience(.under13, expectedVersion: 0)
            try require(blocked.accountID == first.accountID && blocked.status == .blocked && !blocked.capabilities.any, "Under13 cannot receive a purpose")
            try await denied("age_not_supported") { _ = try await child.requireAudience(.faceAuthentication) }
            try await denied("age_not_supported") { _ = try await child.requireAudience(.photoProcessing) }
            _ = try await child.protectedJSON("/privacy/center")
            checks.append("Under13 retains its anonymous account and privacy access while purpose gates deny")

            let (teen, _) = make(origin)
            guard let teenSession = try await teen.bootstrap() else { throw NativeAPIError.invalidResponse }
            let pending = try await teen.declareAudience(.teen, expectedVersion: 0)
            try require(pending.accountID == teenSession.accountID && pending.status == .guardianPending && !pending.capabilities.any, "Teen declaration is gated")
            let requested = try await teen.createGuardianRequest(expectedVersion: pending.version)
            guard let guardian = requested.guardianRequest else { throw NativeAPIError.invalidResponse }
            try require(guardian.state == .pending && guardian.revision == 1 && guardian.childAccountID == teenSession.accountID && !guardian.purposes.any, "Pending guardian request grants nothing")
            try await denied("guardian_approval_required") { _ = try await teen.requireAudience(.photoMatching) }
            let readback = try await teen.guardianRequest(guardian.id)
            try require(readback == guardian, "Own request readback must be exact")
            checks.append("Teen pending guardian request and own readback grant zero purpose authority")

            let withdrawn = try await teen.withdrawGuardianRequest(guardian)
            let afterWithdrawal = try await teen.audience()
            try require(withdrawn.id == guardian.id && withdrawn.state == .withdrawn && withdrawn.revision == 2 && !withdrawn.purposes.any && !afterWithdrawal.capabilities.any, "Withdrawal must advance the exact request without a grant")
            try await denied("guardian_approval_required") { _ = try await teen.requireAudience(.photoProcessing) }
            _ = try await teen.protectedJSON("/privacy/center")
            checks.append("Withdrawal keeps the teen gated and preserves guest privacy access")

            let (adult, secrets) = make(origin)
            guard let adultSession = try await adult.bootstrap(), let originalCredentials = try secrets.read("credentials") else { throw NativeAPIError.invalidResponse }
            _ = try await control("schema_unavailable", origin: controller, secret: secret)
            do { _ = try await adult.declareAudience(.adult, expectedVersion: 0); throw NativeAPIError.invalidResponse }
            catch NativeAPIError.operationUnconfirmed { assertions += 1 }
            guard let original = try await adult.pendingAudienceMutation() else { throw NativeAPIError.invalidResponse }
            try require(original.accountID == adultSession.accountID && original.body["age_band"].string == "18_plus", "Unconfirmed mutation must retain its original account/body/key")
            try require(try secrets.read("credentials") == originalCredentials, "503 must not clear or replace credentials")
            let restarted = BackendRepository(origin: origin, transport: NativeURLTransport(), secrets: secrets, signer: AudienceHTTPNoEnrollment())
            do { _ = try await restarted.bootstrap() } catch NativeAPIError.denied(503, "database_schema_not_ready") { assertions += 1 }
            let surviving = try await restarted.pendingAudienceMutation()
            try require(surviving == original && (try secrets.read("credentials")) == originalCredentials, "Actor reconstruction preserves the exact mutation and credentials")
            let unavailable = try await control("summary", origin: controller, secret: secret)
            try require(unavailable["accounts"].integer == 3 && unavailable["declared_accounts"].integer == 2, "Unavailable API must not create a new account or acknowledge a declaration")
            checks.append("Schema503 and actor reconstruction preserve the original anonymous credentials and mutation key")

            _ = try await control("schema_restore", origin: controller, secret: secret)
            _ = try await restarted.bootstrap()
            let recovered = try await restarted.retryAudienceMutation()
            let finalBinding = await restarted.audienceSessionBinding()
            let retired = try await restarted.pendingAudienceMutation()
            try require(recovered.ageBand == .adult && recovered.status == .eligible && recovered.accountID == adultSession.accountID && finalBinding?.accountID == adultSession.accountID && finalBinding?.registeredIdentity == false && retired == nil, "Retry must acknowledge the original key on the same anonymous account")
            try require(recovered.capabilities.any, "Adult eligibility should recover without manufacturing subject consent")
            checks.append("After fixture repair the original mutation retries on the same anonymous account")

            try await child.logout(); try await teen.logout(); try await restarted.logout()
            let summary = try await control("summary", origin: controller, secret: secret)
            for key in ["active_sessions", "consents", "guardian_approvals", "media_grants", "face_profiles", "auth_devices", "auth_challenges"] {
                try require(summary[key].integer == 0, "Unexpected authority after isolated native journey: " + key)
            }
            try require(summary["accounts"].integer == 3 && summary["declared_accounts"].integer == 3 && summary["withdrawn_guardian_requests"].integer == 1, "Unexpected final account/request cardinality")
            checks.append("Independent database readback has three accounts, one withdrawn request and zero live purpose/session/media authority")
            let result: [String: Any] = ["status": "passed", "checks": checks, "assertions_passed": assertions,
                "scope": "Production Swift repository/URLSession and isolated actual API HTTP; host memory storage, no enrollment/guardian approval",
                "physical_or_hosted_acceptance": false, "actor_reconstruction_is_process_death": false]
            try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: output)
        } catch {
            let code: String
            switch error {
            case NativeAPIError.unsupported(let message): code = message
            case NativeAPIError.denied(let status, let value): code = "http_\(status):\(value)"
            default: code = "native_audience_http_unconfirmed"
            }
            try JSONSerialization.data(withJSONObject: ["status": "failed", "completed_checks": checks, "assertions_passed": assertions, "failure_code": code], options: [.prettyPrinted, .sortedKeys]).write(to: output)
            throw NativeAPIError.unsupported(code)
        }
    }
}
