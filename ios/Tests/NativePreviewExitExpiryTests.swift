import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Same-account synthetic memory fixture. It does not touch user photos,
// Keychain, a simulator, a provider, or share-owned files.
private final class PreviewClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant: NativePrivateMediaInstant = .init(wall: Date(), uptime: 100)
    func read() -> NativePrivateMediaInstant { lock.lock(); defer { lock.unlock() }; return instant }
    func advanceUptime(_ seconds: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        instant = .init(wall: instant.wall, uptime: instant.uptime + seconds)
    }
    var clock: NativePrivateMediaClock { .init(read: { [self] in read() }) }
}
private final class PreviewSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; values[name] = data }
}
private struct PreviewSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
}
private actor PreviewGate {
    private var started = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var release: CheckedContinuation<Void, Never>?
    func pause() async {
        started = true; waiters.forEach { $0.resume() }; waiters = []
        await withCheckedContinuation { release = $0 }
    }
    func reached() async { if !started { await withCheckedContinuation { waiters.append($0) } } }
    func open() { release?.resume(); release = nil }
}
private actor PreviewTransport: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000081"
    enum Outcome { case normal, network, malformed, denied, subset }
    private var binaryGate: PreviewGate?, validationGate: PreviewGate?
    private var binaryOutcome: Outcome = .normal, validationOutcome: Outcome = .normal
    private(set) var binaryReads = 0
    nonisolated func cancelPending() {}
    func delayBinary(_ gate: PreviewGate, outcome: Outcome) { binaryGate = gate; binaryOutcome = outcome }
    func delayValidation(_ gate: PreviewGate, outcome: Outcome) { validationGate = gate; validationOutcome = outcome }
    private func json(_ value: WireValue, status: Int = 200) throws -> NativeHTTPReply {
        .init(status: status, headers: ["content-type": "application/json"], data: try value.encoded())
    }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        switch request.url!.path {
        case "/me":
            return try json(.object(["user_id": .string(Self.account), "auth_method": .string("registered_face"), "authenticated": .bool(true)]))
        case "/me/audience":
            return try json(.object(["protocol": .string(NativeAudienceProjection.protocolName), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(Self.account),
                "audience": .object(["age_band": .string("18_plus"), "status": .string("eligible"), "version": .integer(1), "policy_version": .string(NativeAudienceProjection.policy), "next_review_at": .null]),
                "guardian_request": .null, "capabilities": .object(["face_authentication": .bool(true), "photo_matching": .bool(true), "photo_processing": .bool(true)])]))
        case "/community/action":
            let body = try WireValue.decoded(request.httpBody!)
            guard body["action"].string == "photos.validate", let ids = body["payload"]["asset_ids"].array else { throw NativeAPIError.invalidResponse }
            let outcome = validationOutcome; validationOutcome = .normal
            if let gate = validationGate { validationGate = nil; await gate.pause() }
            try Task.checkCancellation()
            switch outcome {
            case .network: throw URLError(.networkConnectionLost)
            case .denied: return try json(.object(["error": .object(["code": .string("asset_unavailable")])]), status: 403)
            case .subset: return try json(.object(["authorized_ids": .array([])]))
            default: return try json(.object(["authorized_ids": .array(ids)]))
            }
        default:
            guard request.url!.path.hasPrefix("/community/media/"), request.url!.path.hasSuffix("/preview") else { throw NativeAPIError.invalidResponse }
            binaryReads += 1; let version = binaryReads
            let outcome = binaryOutcome; binaryOutcome = .normal
            if let gate = binaryGate { binaryGate = nil; await gate.pause() }
            try Task.checkCancellation()
            if case .network = outcome { throw URLError(.networkConnectionLost) }
            if case .malformed = outcome { return .init(status: 200, headers: ["content-type": "text/plain"], data: Data("synthetic-invalid".utf8)) }
            return .init(status: 200, headers: ["content-type": "image/png"], data: Data([0x89, 0x50, 0x4e, 0x47, UInt8(version)]))
        }
    }
}

@main struct NativePreviewExitExpiryTests {
    private static var checks = 0
    private static func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw NativeAPIError.unsupported("Preview exit check failed: " + label) }; checks += 1
    }
    private static func photo(_ version: String = "v1", id: String = "00000000-0000-4000-8000-000000000082") throws -> NativePhoto {
        try NativePhoto(.object(["id": .string(id), "title": .string("Synthetic fixture"), "media_source": .string("personal"), "version": .string(version)]))
    }
    private static func make(_ clock: PreviewClock) async throws -> (BackendRepository, PreviewTransport) {
        let secrets = PreviewSecrets(), transport = PreviewTransport(), now = Date(), lifetime = 900
        let claims: WireValue = .object(["sub": .string(PreviewTransport.account), "auth_method": .string("registered_face"), "exp": .integer(Int(now.timeIntervalSince1970) + lifetime + 1)])
        let credential = try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("synthetic-preview-refresh"),
            "account_id": .string(PreviewTransport.account), "auth_method": .string("registered_face"), "expires_in": .integer(lifetime), "roles": .strings(["user"])]), now: now)
        try secrets.write("credentials", data: JSONEncoder().encode(credential))
        let repository = BackendRepository(origin: URL(string: "https://preview-fixture.invalid")!, transport: transport, secrets: secrets, signer: PreviewSigner(), privateMediaClock: clock.clock)
        _ = try await repository.bootstrap(); return (repository, transport)
    }
    private static func failed(_ task: Task<Data, Error>, label: String, cancellation: Bool = false) async throws {
        var failure: Error?
        do { _ = try await task.value } catch { failure = error }
        try require(failure != nil, "\(label) must fail")
        if cancellation { try require(failure is CancellationError, "\(label) must preserve CancellationError") }
    }
    static func main() async throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments == ["--baseline"] || arguments == ["--fixed"] else { throw NativeAPIError.invalidResponse }
        let expectBaseline = arguments == ["--baseline"]
        let outcomes = ["download-network", "download-malformed", "validation-network", "validation-denied", "validation-subset", "cancelled"]
        for outcome in outcomes {
            let clock = PreviewClock(), gate = PreviewGate()
            let (repo, transport) = try await make(clock)
            let old = try await repo.preview(photo())
            let initiallyRetained = await repo.retainedPrivateMediaBytes()
            try require(initiallyRetained == old.count && !old.isEmpty, "\(outcome) starts with cached bytes")
            switch outcome {
            case "download-network": await transport.delayBinary(gate, outcome: .network)
            case "download-malformed": await transport.delayBinary(gate, outcome: .malformed)
            case "validation-network": await transport.delayValidation(gate, outcome: .network)
            case "validation-denied": await transport.delayValidation(gate, outcome: .denied)
            case "validation-subset": await transport.delayValidation(gate, outcome: .subset)
            default: await transport.delayBinary(gate, outcome: .normal)
            }
            let pending = Task { try await repo.preview(photo("v1", id: "00000000-0000-4000-8000-000000000083")) }
            await gate.reached(); clock.advanceUptime(1000)
            if outcome == "cancelled" { pending.cancel() }
            await gate.open()
            try await failed(pending, label: outcome, cancellation: outcome == "cancelled")
            let remaining = await repo.retainedPrivateMediaBytes()
            if expectBaseline && ["validation-denied", "validation-subset"].contains(outcome) {
                // The predecessor schedules a zero-delay timer for explicit
                // denial. Its actor may run before this observation, so this
                // is not a deterministic baseline leak counterexample.
                try require(remaining == 0 || remaining == old.count, "\(outcome) baseline retains only the expected entry or its timer has run")
            } else {
                try require(remaining == (expectBaseline ? old.count : 0), "\(outcome) must \(expectBaseline ? "expose the original expired entry" : "remove the expired entry")")
            }
            await repo.retireMedia()
        }
        do {
            let clock = PreviewClock(), gate = PreviewGate()
            let (repo, transport) = try await make(clock)
            _ = try await repo.preview(photo())
            await transport.delayBinary(gate, outcome: .network)
            let older = Task { try await repo.preview(photo("v1", id: "00000000-0000-4000-8000-000000000083")) }
            await gate.reached(); clock.advanceUptime(1000)
            let fresh = try await repo.preview(photo("v2", id: "00000000-0000-4000-8000-000000000083"))
            await gate.open(); try await failed(older, label: "older overlap")
            let retained = await repo.retainedPrivateMediaBytes(), before = await transport.binaryReads
            let cached = try await repo.preview(photo("v2", id: "00000000-0000-4000-8000-000000000083")), after = await transport.binaryReads
            try require(retained == fresh.count && cached == fresh && before == after, "older failure preserves and reuses newer valid same-asset cache")
            await repo.retireMedia()
        }
        print("Preview exit expiry checks passed: \(checks); mode=\(expectBaseline ? "baseline" : "fixed")")
    }
}
