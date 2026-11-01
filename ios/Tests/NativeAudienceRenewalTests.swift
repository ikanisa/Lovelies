import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Actual repository calls with an in-memory vault and a P-256 fixture signer.
// Authoring this source does not establish Apple SDK, Keychain or device execution.
private let reviewAccount = "00000000-0000-4000-8000-000000000701"
private let reviewDeviceID = "00000000-0000-4000-8000-000000000702"
private let reviewRequestID = "00000000-0000-4000-8000-000000000703"
private let reviewOther = "00000000-0000-4000-8000-000000000704"
private let reviewOrigin = URL(string: "https://audience-renewal.invalid")!
private let reviewPolicy = "face-fixture-policy-v1"
private func reviewDate(_ date: Date) -> WireValue {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return .string(formatter.string(from: date))
}
private func reviewDecision(minor: Bool = false, expired: Bool = true, version: Int = 1) -> WireValue {
    .object(["at_least_13": .bool(true), "guardian_required": .bool(minor), "status": .string(minor ? "guardian_pending" : expired ? "suspended" : "eligible"),
        "version": .integer(version), "policy_version": .string(NativeAudienceProjection.policy), "source": .string("self_declaration"),
        "rule_version": .string("audience-13-plus-guardian-v1"), "territory": .string("global"), "declared_at": reviewDate(Date().addingTimeInterval(-60)),
        "next_review_at": reviewDate(Date().addingTimeInterval(expired ? -1 : 3600)), "review_required": .bool(expired)])
}
private final class ReviewSecrets: NativeSecretStore, @unchecked Sendable {
    let authorityNamespace = "audience-renewal-fixture-" + UUID().uuidString.lowercased()
    private let lock = NSRecursiveLock(); private var slots: [String: Data] = [:], failure: String?
    func fail(_ name: String?) { lock.lock(); defer { lock.unlock() }; failure = name }
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return slots[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; if failure == name { throw NativeAPIError.unavailable("fixture_write_failure") }; slots[name] = data }
}
private final class ReviewSigner: NativeDeviceSigner, @unchecked Sendable {
    private let key = P256.Signing.PrivateKey(); private let lock = NSLock(); private(set) var signatures = 0, cleared = false
    func sign(_ data: Data) throws -> String { lock.lock(); defer { lock.unlock() }; guard !cleared else { throw NativeAPIError.invalidResponse }; signatures += 1; return try key.signature(for: data).rawRepresentation.base64URL }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() { lock.lock(); defer { lock.unlock() }; cleared = true }
    func hasRetainedKey() throws -> Bool { !cleared }
    func publicJWK(alias: String, create: Bool) throws -> WireValue {
        guard alias == NativeEnrollmentRecord.keyAlias, !create, !cleared else { throw NativeAPIError.invalidResponse }
        let bytes = key.publicKey.x963Representation
        return .object(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(bytes.subdata(in: 1..<33).base64URL),
            "y": .string(bytes.subdata(in: 33..<65).base64URL), "ext": .bool(true), "key_ops": .strings(["verify"])])
    }
    func verifies(_ bytes: Data, signature: String) throws -> Bool {
        guard let raw = Data(base64URL: signature) else { return false }
        return try key.publicKey.isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: bytes)
    }
}
private actor ReviewTransport: NativeTransport {
    let secrets: ReviewSecrets, signer: ReviewSigner
    private var decision = reviewDecision(), nextStep = "audience_review", guardian: WireValue = .null
    private var lost = false, badNonce = false, receipts: [String: WireValue] = [:], originals: [String: WireValue] = [:]
    private var mutationFailure: (Int, String)?
    private var controlExpiry = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970) - 60)
    private(set) var sent: [WireValue] = [], paths: [String] = []
    init(secrets: ReviewSecrets, signer: ReviewSigner) { self.secrets = secrets; self.signer = signer }
    nonisolated func cancelPending() {}
    func loseNext() { lost = true }
    func corruptNonce(_ value: Bool) { badNonce = value }
    func setMinor() { decision = reviewDecision(minor: true); nextStep = "guardian_review" }
    func advance() { decision = reviewDecision(version: 3); nextStep = "audience_review" }
    func failMutation(status: Int?, code: String = "operation_retired_by_recovery") { mutationFailure = status.map { ($0, code) } }
    private func response(_ value: WireValue) throws -> NativeHTTPReply { .init(status: 200, headers: ["content-type": "application/json"], data: try value.encoded()) }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        let path = request.url!.path; paths.append(path)
        guard request.value(forHTTPHeaderField: "Authorization") == nil else { throw NativeAPIError.invalidResponse }
        if path == "/auth/face/policy" { return try response(.object(["protocol": .string("lovelies-face-auth-v1"), "available": .bool(true), "policy_version": .string(reviewPolicy)])) }
        guard request.httpMethod == "POST", let data = request.httpBody, let input = try WireValue.decoded(data).object else { throw NativeAPIError.invalidResponse }
        let body = WireValue.object(input); sent.append(body)
        let control = path.hasPrefix("/auth/face/profile/control/")
        let step = control ? (path.hasSuffix("/status") ? "control-status" : "control-renew") : String(path.split(separator: "/").last!)
        var envelope = input; envelope.removeValue(forKey: "device_signature")
        envelope["protocol"] = .string(control ? "lovelies-face-profile-device-v1" : "lovelies-audience-device-v1"); envelope["step"] = .string(step)
        guard try signer.verifies(WireValue.object(envelope).canonical(), signature: body.text("device_signature")),
              body["account_id"].string == reviewAccount, body["device_id"].string == reviewDeviceID,
              let expiry = body["request_expires_at"].integer, Double(expiry) > Date().timeIntervalSince1970 * 1000,
              Double(expiry) <= Date().addingTimeInterval(60).timeIntervalSince1970 * 1000 else { throw NativeAPIError.invalidResponse }
        _ = try body.uuid("request_nonce")
        if control {
            guard let bytes = try secrets.read("face-profile-lifecycle") else { throw NativeAPIError.invalidResponse }
            let record = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: bytes)
            guard body["control_key"].string == record.controlKey, body["face_handle"] == .null else { throw NativeAPIError.invalidResponse }
            var result = record.metadata.wire.object!
            result["request_nonce"] = body["request_nonce"]
            if step == "control-renew" {
                guard let operation = record.controlRecoveryRenewal else { throw NativeAPIError.invalidResponse }
                for (key, value) in operation.fields { guard body[key] == value else { throw NativeAPIError.invalidResponse } }
                if receipts[operation.operationKey] == nil {
                    let before = controlExpiry; controlExpiry = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970) + 365 * 86400)
                    receipts[operation.operationKey] = .object(["operation_key": .string(operation.operationKey), "from_expires_at": reviewDate(before), "to_expires_at": reviewDate(controlExpiry)])
                }
                result["control_renewal"] = receipts[operation.operationKey]
                if lost { lost = false; throw URLError(.networkConnectionLost) }
            }
            result["control_recovery"] = .object(["binding": .string(String(repeating: "c", count: 64)), "expires_at": reviewDate(controlExpiry)])
            return try response(.object(result))
        }
        guard body["face_handle"].string == "lfh_" + Data(repeating: 1, count: 32).base64URL else { throw NativeAPIError.invalidResponse }
        var receipt: WireValue?
        if step != "status" {
            guard let bytes = try secrets.read("audience-device-renewals"),
                  let operation = try JSONDecoder().decode([NativeAudienceDeviceRenewalRecord].self, from: bytes).first(where: { $0.accountID == reviewAccount }) else { throw NativeAPIError.invalidResponse }
            for (key, value) in operation.decisionBody { guard body[key] == value else { throw NativeAPIError.invalidResponse } }
            if let failure = mutationFailure { return .init(status: failure.0, headers: ["content-type": "application/json"], data: try WireValue.object(["error": .object(["code": .string(failure.1)])]).encoded()) }
            let key = operation.operationKey, canonicalInput = WireValue.object(operation.decisionBody)
            if let original = originals[key] { guard original == canonicalInput else { throw NativeAPIError.invalidResponse } }
            if receipts[key] == nil {
                originals[key] = canonicalInput; let minor = operation.guardianRequired
                guard step == (minor ? "guardian-review" : "renew"), minor ? body["consent"] == .null : body["consent"]["policy_version"].string == reviewPolicy else { throw NativeAPIError.invalidResponse }
                decision = reviewDecision(minor: minor, expired: false, version: operation.expectedVersion + 1)
                nextStep = minor ? "guardian_review" : "profile_recovery"
                guardian = minor ? .object(["id": .string(reviewRequestID), "revision": .integer(1), "state": .string("pending"), "policy_version": .string(NativeAudienceProjection.policy), "expires_at": reviewDate(Date().addingTimeInterval(600))]) : .null
                var fields: [String: WireValue] = ["operation_key": .string(key), "from_version": .integer(operation.expectedVersion), "to_version": .integer(operation.expectedVersion + 1), "next_step": .string(nextStep)]
                if minor { fields["guardian_request_id"] = .string(reviewRequestID) }; receipts[key] = .object(fields)
            }
            receipt = receipts[key]
            if lost { lost = false; throw URLError(.networkConnectionLost) }
        }
        var result: [String: WireValue] = ["protocol": .string("lovelies-audience-device-v1"), "account_id": .string(reviewAccount), "device_id": .string(reviewDeviceID),
            "request_nonce": badNonce ? .string(reviewOther) : body["request_nonce"], "audience": decision, "renewal_available": .bool(decision["guardian_required"].bool == false), "guardian_review_available": .bool(decision["guardian_required"].bool == true),
            "next_step": .string(nextStep), "guardian_request": guardian, "authority_expires_at": .null]
        if let receipt { result["renewal"] = receipt }; return try response(.object(result))
    }
}
@main struct NativeAudienceRenewalTests {
    static var checks = 0
    static func require(_ condition: Bool, _ label: String) throws { guard condition else { throw NativeAPIError.unsupported(label) }; checks += 1 }
    static func rejects(_ label: String, _ work: () async throws -> Void) async throws { var denied = false; do { try await work() } catch { denied = true }; try require(denied, label) }
    static func make() throws -> (BackendRepository, ReviewSecrets, ReviewSigner, ReviewTransport, RegisteredDevice) {
        let secrets = ReviewSecrets(), signer = ReviewSigner(), transport = ReviewTransport(secrets: secrets, signer: signer)
        let device = RegisteredDevice(accountID: reviewAccount, faceHandle: "lfh_" + Data(repeating: 1, count: 32).base64URL, deviceID: reviewDeviceID, keyAlias: NativeEnrollmentRecord.keyAlias)
        try secrets.write("registered-device", data: JSONEncoder().encode(device))
        return (BackendRepository(origin: reviewOrigin, transport: transport, secrets: secrets, signer: signer), secrets, signer, transport, device)
    }
    static func main() async throws {
        for (status, code) in [(409, "operation_recovered_without_result"), (410, "operation_retired_by_recovery")] {
            let (terminal, terminalSecrets, terminalSigner, terminalTransport, _) = try make()
            await terminalTransport.failMutation(status: status, code: code)
            do { _ = try await terminal.renewDeviceAudience(expectedVersion: 1, consentPolicy: reviewPolicy); throw NativeAPIError.invalidResponse }
            catch NativeAPIError.denied(409, "audience_operation_recovered_without_result") {}
            let archive = try JSONDecoder().decode([NativeOperationRetirementRecord].self, from: terminalSecrets.read("operation-terminal-evidence")!)
            let negative = archive[0], originalCalls = await terminalTransport.sent
            try require(archive.count == 1 && negative.sourceStatus == status && negative.sourceCode == code && negative.status == "operation_recovered_without_result", "Terminal audience source code or negative disposition was lost")
            try require(negative.operationKey == originalCalls[0]["operation_key"].string && (try terminalSecrets.read("audience-device-renewals")) == nil, "Terminal audience did not preserve exact key before releasing its journal")
            let restarted = BackendRepository(origin: reviewOrigin, transport: terminalTransport, secrets: terminalSecrets, signer: terminalSigner)
            try await rejects("Terminal retry invented a fresh operation") { _ = try await restarted.renewDeviceAudience(expectedVersion: 0, consentPolicy: nil, retryOriginal: true) }
            let callsAfterRetry = await terminalTransport.sent
            try require(callsAfterRetry.count == originalCalls.count, "Terminal retry dispatched without a fresh decision")
            let current = try await terminal.signedAudienceStatus()
            try require(current.decision.version == 1 && current.decision.needsReview(), "Current status was interpreted as a committed renewal")
            await terminalTransport.failMutation(status: nil)
            _ = try await terminal.renewDeviceAudience(expectedVersion: 1, consentPolicy: reviewPolicy)
            let after = await terminalTransport.sent.last!, retained = try JSONDecoder().decode([NativeOperationRetirementRecord].self, from: terminalSecrets.read("operation-terminal-evidence")!)
            try require(after["operation_key"].string != negative.operationKey && retained == archive, "Fresh decision erased original terminal evidence")
        }
        do {
            let (terminal, terminalSecrets, _, terminalTransport, _) = try make()
            terminalSecrets.fail("operation-terminal-evidence"); await terminalTransport.failMutation(status: 410)
            try await rejects("Failed negative-evidence write reported terminal retirement") { _ = try await terminal.renewDeviceAudience(expectedVersion: 1, consentPolicy: reviewPolicy) }
            let held = try terminalSecrets.read("audience-device-renewals")
            try require(held != nil && (try terminalSecrets.read("operation-terminal-evidence")) == nil, "Failed terminal archive erased the exact renewal")
            terminalSecrets.fail(nil); await terminalTransport.failMutation(status: 409, code: "operation_key_conflict")
            try await rejects("Input conflict became terminal") { _ = try await terminal.renewDeviceAudience(expectedVersion: 0, consentPolicy: nil, retryOriginal: true) }
            _ = try await terminal.signedAudienceStatus()
            try require(try terminalSecrets.read("audience-device-renewals") == held, "Current signed status or key conflict retired a pending renewal")
        }
        try require(NativeLocalAuthenticationPurpose.reconciliation.allows(protocol: "lovelies-audience-device-v1"), "Explicit reconciliation cannot sign the audience namespace")
        try require(!NativeLocalAuthenticationPurpose.capture.allows(protocol: "lovelies-audience-device-v1") && !NativeLocalAuthenticationPurpose.enrollment.allows(protocol: "lovelies-audience-device-v1"), "Capture/enrollment authorization acquired audience-renewal signing")
        let (repo, secrets, signer, transport, _) = try make()
        let status = try await repo.signedAudienceStatus(), initialSession = await repo.summary()
        try require(status.nextStep == "audience_review" && status.decision.needsReview() && initialSession == nil && status.authorityExpiry == nil, "Expired status gained product authority or bypassed review")
        await transport.loseNext()
        try await rejects("Lost renewal was reported as settled") { _ = try await repo.renewDeviceAudience(expectedVersion: 1, consentPolicy: reviewPolicy) }
        let originalBytes = try secrets.read("audience-device-renewals")!, original = try JSONDecoder().decode([NativeAudienceDeviceRenewalRecord].self, from: originalBytes).first!
        try require(original.decisionBody["age_band"] == nil && original.decisionBody["consent"]?["policy_version"].string == reviewPolicy, "Raw age or missing separate consent in journal")
        try await rejects("Pending renewal replaced by a new decision") { _ = try await repo.renewDeviceAudience(expectedVersion: 2, consentPolicy: "changed-policy") }
        try require(try secrets.read("audience-device-renewals") == originalBytes, "Rejected replacement changed the original journal")
        let restarted = BackendRepository(origin: reviewOrigin, transport: transport, secrets: secrets, signer: signer)
        let renewed = try await restarted.renewDeviceAudience(expectedVersion: 0, consentPolicy: nil, retryOriginal: true)
        let calls = await transport.sent.filter { $0["operation_key"].string == original.operationKey }, renewedSession = await restarted.summary()
        try require(calls.count == 2 && calls[0]["request_nonce"] != calls[1]["request_nonce"] && calls[0]["consent"] == calls[1]["consent"], "Restart did not use fresh proof with original consent/key")
        try require(renewed.renewalNextStep == "profile_recovery" && renewedSession == nil && (try secrets.read("audience-device-renewals")) == nil, "Renewal fabricated login or failed durable retirement")
        let (minor, _, _, minorTransport, _) = try make(); await minorTransport.setMinor()
        let guardian = try await minor.renewDeviceAudience(expectedVersion: 1, consentPolicy: nil, guardianRequired: true)
        let minorBody = await minorTransport.sent.last!
        try require(guardian.nextStep == "guardian_review" && guardian.guardianRequest?.id == reviewRequestID && minorBody["consent"] == .null && minorBody["guardian_required"].bool == true, "Minor review changed audience or granted face consent")
        let (bad, badSecrets, _, badTransport, _) = try make(); await badTransport.corruptNonce(true)
        try await rejects("Foreign nonce retired the original operation") { _ = try await bad.renewDeviceAudience(expectedVersion: 1, consentPolicy: reviewPolicy) }
        try require(try badSecrets.read("audience-device-renewals") != nil, "Malformed reply erased recovery")
        await badTransport.corruptNonce(false); _ = try await bad.renewDeviceAudience(expectedVersion: 0, consentPolicy: nil, retryOriginal: true)
        let (noWrite, noWriteSecrets, noWriteSigner, noWriteTransport, _) = try make(); noWriteSecrets.fail("audience-device-renewals")
        try await rejects("Mutation preceded durable operation") { _ = try await noWrite.renewDeviceAudience(expectedVersion: 1, consentPolicy: reviewPolicy) }
        let noWritePaths = await noWriteTransport.paths
        try require(noWritePaths.isEmpty && noWriteSigner.signatures == 0, "Failed persistence dispatched or signed")
        let (advanced, _, _, advancedTransport, _) = try make(); await advancedTransport.loseNext()
        try await rejects("Lost receipt returned success") { _ = try await advanced.renewDeviceAudience(expectedVersion: 1, consentPolicy: reviewPolicy) }
        await advancedTransport.advance(); let newer = try await advanced.renewDeviceAudience(expectedVersion: 0, consentPolicy: nil, retryOriginal: true)
        try require(newer.decision.version == 3 && newer.decision.needsReview() && newer.nextStep == "audience_review", "Historical receipt replaced newer eligibility")
        let (controlRepo, controlSecrets, controlSigner, controlTransport, controlDevice) = try make()
        let key = "lfl_" + Data(repeating: 3, count: 32).base64URL, operation = UUID().uuidString.lowercased()
        let jwk = try controlSigner.publicJWK(alias: NativeEnrollmentRecord.keyAlias, create: false), digest = try controlSigner.sha256(jwk.canonical())
        let metadata = try NativeFaceProfileMetadata(.object(["protocol": .string("lovelies-face-profile-v1"), "authenticated": .bool(false), "account_id": .string(reviewAccount), "device_id": .string(reviewDeviceID), "public_key_digest": .string(digest), "device_revision": .string(reviewRequestID), "version": .integer(1), "auth_policy_version": .string(reviewPolicy), "photo_policy_version": .string("photo-v1"), "profile": .null, "authentication_enabled": .bool(false), "matching_enabled": .bool(false), "processing_enabled": .bool(false), "receive_matches": .bool(false), "matching_paused": .bool(true), "removal_state": .string("completed"), "operation": .null]), account: reviewAccount, device: reviewDeviceID, digest: digest)
        let envelope = WireValue.object(["protocol": .string("lovelies-face-profile-device-v1"), "step": .string("control"), "account_id": .string(reviewAccount), "device_id": .string(reviewDeviceID), "control_key": .string(key), "control_operation_key": .string(operation)])
        let record = NativeFaceLifecycleRecord(accountID: reviewAccount, apiOrigin: reviewOrigin.absoluteString, originalDevice: controlDevice, keyAlias: NativeEnrollmentRecord.keyAlias, publicJWK: jwk, publicKeyDigest: digest, controlKey: key, controlOperationKey: operation, controlSignature: try controlSigner.sign(envelope.canonical()), createdAt: Date(), controlReady: true, metadata: metadata)
        try controlSecrets.write("face-profile-lifecycle", data: JSONEncoder().encode(record)); _ = try await controlRepo.bootstrap()
        let controlStatus = try await controlRepo.checkRetainedFaceControl()
        try require(controlStatus.authorityUnavailable && controlStatus.metadata.controlRecovery != nil, "Expired retained control was promoted")
        await controlTransport.loseNext()
        try await rejects("Lost control renewal was discarded") { _ = try await controlRepo.renewRetainedFaceControl(consentPolicy: reviewPolicy) }
        let held = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: controlSecrets.read("face-profile-lifecycle")!)
        try require(held.controlKey == key && held.controlOperationKey == operation && held.controlRecoveryRenewal != nil, "Control recovery rotated the original secret or lost its journal")
        let controlRestart = BackendRepository(origin: reviewOrigin, transport: controlTransport, secrets: controlSecrets, signer: controlSigner); _ = try await controlRestart.bootstrap()
        let recovered = try await controlRestart.renewRetainedFaceControl(consentPolicy: nil, retryOriginal: true), session = await controlRestart.summary()
        let saved = try JSONDecoder().decode(NativeFaceLifecycleRecord.self, from: controlSecrets.read("face-profile-lifecycle")!)
        try require(!recovered.authorityUnavailable && !recovered.metadata.authenticationEnabled && session == nil && saved.controlRecoveryRenewal == nil && saved.controlKey == key && saved.controlOperationKey == operation, "Control renewal created a session/purpose or replaced proof")
        print("Native audience renewal checks passed: \(checks)")
    }
}
