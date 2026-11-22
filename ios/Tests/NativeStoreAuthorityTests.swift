import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// One synthetic subject, real repository actor and the production MainActor
// reducer. No Keychain, StoreKit, provider, UI lifecycle or remote endpoint runs.
private final class StoreAuthoritySecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; values[name] = data }
}
private struct StoreAuthoritySigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
}
private enum StoreAuthorityFixture {
    static let account = "00000000-0000-4000-8000-000000000181"
    static let origin = URL(string: "https://store-authority.invalid")!
    static func credentials() throws -> NativeCredentials {
        let claims: WireValue = .object(["sub": .string(account), "auth_method": .string("registered_face"), "exp": .integer(Int(Date().timeIntervalSince1970) + 900)])
        return try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"),
            "refresh_token": .string("synthetic-store-refresh"), "account_id": .string(account), "auth_method": .string("registered_face"),
            "expires_in": .integer(900), "roles": .strings(["user"])]))
    }
    static func audience(version: Int, eligible: Bool = true) -> WireValue {
        .object(["protocol": .string(NativeAudienceProjection.protocolName), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(account),
            "audience": .object(["age_band": .string("18_plus"), "status": .string(eligible ? "eligible" : "suspended"), "version": .integer(version),
                "policy_version": .string(NativeAudienceProjection.policy), "next_review_at": .null]),
            "guardian_request": .null, "capabilities": .object(["face_authentication": .bool(eligible), "photo_matching": .bool(eligible), "photo_processing": .bool(eligible)])])
    }
}
private actor StoreAuthorityGate {
    private var entered = false, released = false
    private var entrants: [CheckedContinuation<Void, Never>] = []
    private var waiter: CheckedContinuation<Void, Never>?
    func block() async {
        entered = true; entrants.forEach { $0.resume() }; entrants = []
        if !released { await withCheckedContinuation { waiter = $0 } }
    }
    func waitUntilEntered() async {
        if !entered { await withCheckedContinuation { entrants.append($0) } }
    }
    func release() { released = true; waiter?.resume(); waiter = nil }
}
private actor StoreAuthorityTransport: NativeTransport {
    private var version = 1, eligible = true
    private var nextGate: StoreAuthorityGate?
    private var nextFailure: Int?
    private var nextCancelledNetwork = false
    private(set) var entitlementReads = 0
    nonisolated func cancelPending() {}
    func audience(version: Int, eligible: Bool = true) { self.version = version; self.eligible = eligible }
    func holdNext(_ gate: StoreAuthorityGate) { nextGate = gate }
    func failNext(status: Int) { nextFailure = status }
    func cancelNextTransport() { nextCancelledNetwork = true }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        guard request.url?.host == StoreAuthorityFixture.origin.host else { throw NativeAPIError.invalidResponse }
        let value: WireValue, status: Int
        switch request.url!.path {
        case "/me":
            value = .object(["user_id": .string(StoreAuthorityFixture.account), "auth_method": .string("registered_face"), "authenticated": .bool(true)]); status = 200
        case "/me/audience": value = StoreAuthorityFixture.audience(version: version, eligible: eligible); status = 200
        case "/me/entitlements":
            entitlementReads += 1
            let number = entitlementReads, gate = nextGate, failure = nextFailure, cancelledNetwork = nextCancelledNetwork
            nextGate = nil; nextFailure = nil; nextCancelledNetwork = false
            if let gate { await gate.block() }
            if cancelledNetwork { throw URLError(.cancelled) }
            status = failure ?? 200
            value = failure == nil ? .object(["pro_active": .bool(true), "read_number": .integer(number)]) : .object(["error": .string("synthetic_store_unavailable")])
        default: throw NativeAPIError.invalidResponse
        }
        let bytes = try value.encoded()
        guard bytes.count <= limit else { throw NativeAPIError.invalidResponse }
        return NativeHTTPReply(status: status, headers: ["content-type": "application/json"], data: bytes)
    }
}

@MainActor @main struct NativeStoreAuthorityTests {
    private static var checks = 0
    private static func require(_ condition: @autoclosure () -> Bool, _ label: String) throws {
        guard condition() else { throw NativeAPIError.unsupported(label) }
        checks += 1; print("PASS " + label)
    }
    static func main() async throws {
        let secrets = StoreAuthoritySecrets(), transport = StoreAuthorityTransport()
        try secrets.write("credentials", data: JSONEncoder().encode(StoreAuthorityFixture.credentials()))
        let privateRoot = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-store-authority-" + UUID().uuidString.lowercased(), isDirectory: true)
        let repository = BackendRepository(origin: StoreAuthorityFixture.origin, transport: transport, secrets: secrets, signer: StoreAuthoritySigner(),
            uploadFiles: NativeUploadPrivateFiles(root: privateRoot))
        _ = try await repository.bootstrap(); _ = try await repository.audience()
        let source = repository.storeAuthority, initial = source.current()
        let reducer = NativeStoreEntitlementReducer()
        try require(initial.permitsStoreRead(), "Real actor publishes current registered eligible authority")
        try require(reducer.observe(initial, source: source), "Production reducer accepts the current initial snapshot")

        let gate = StoreAuthorityGate()
        await transport.holdNext(gate)
        let olderID = reducer.beginRead()
        let older = Task { try await repository.storeEntitlement(readID: olderID) }
        await gate.waitUntilEntered()
        let newerID = reducer.beginRead(), newer = try await repository.storeEntitlement(readID: newerID)
        try require(reducer.install(newer, id: newerID, source: source), "Newer completed read owns publication")
        await gate.release()
        let oldReply = try await older.value
        try require(!reducer.install(oldReply, id: olderID, source: source), "Older success cannot overwrite a newer success")
        try require(reducer.displayed(source: source)["read_number"].integer == 2, "Display retains the actual newer server result")

        let failedGate = StoreAuthorityGate()
        await transport.holdNext(failedGate)
        let supersededID = reducer.beginRead()
        let superseded = Task { try await repository.storeEntitlement(readID: supersededID) }
        await failedGate.waitUntilEntered()
        let failedID = reducer.beginRead()
        await transport.failNext(status: 503)
        do { _ = try await repository.storeEntitlement(readID: failedID); throw NativeAPIError.invalidResponse }
        catch let failure as NativeStoreEntitlementFailure {
            try require(failure.readID == failedID && source.matches(failure.authority), "A failed newer read retains exact read and current authority ownership")
            try require(failure.settledAuthority == failure.authority, "A genuine current noncancelled 503 retains bounded settlement")
        }
        await failedGate.release()
        let supersededReply = try await superseded.value
        try require(!reducer.install(supersededReply, id: supersededID, source: source), "A newer failed read still supersedes older success")

        await transport.audience(version: 2, eligible: false); _ = try await repository.audience()
        let denied = source.current()
        try require(!source.permits(newer.authority), "Actor invalidation rejects old proof before MainActor delivery")
        try require(reducer.displayed(source: source) == .object([:]), "Getter fails closed before queued denial is reduced")
        try require(reducer.observe(denied, source: source) && !denied.permitsStoreRead(), "A genuinely current denial reaches the production reducer")
        // Presentation retirement clears only the value, retaining observation
        // ownership so a later eligible event can repair the same account.
        reducer.clearValue()
        let retainedStream = source.observations()
        var retained = retainedStream.makeAsyncIterator()
        await transport.audience(version: 3); _ = try await repository.audience()
        let allowed = source.current()
        try require(!reducer.observe(denied, source: source), "Old denial admitted before a newer allow cannot reduce after that allow")
        guard let retainedLatest = await retained.next() else { throw NativeAPIError.invalidResponse }
        try require(retainedLatest == allowed, "Complete bounded stream retains the newer allow across presentation retirement")
        try require(reducer.observe(allowed, source: source), "Newer same-account eligible revision remains recoverable")
        let recoveredID = reducer.beginRead(), recovered = try await repository.storeEntitlement(readID: recoveredID)
        try require(reducer.install(recovered, id: recoveredID, source: source), "Recovery publishes a fresh read after current eligibility returns")

        await transport.audience(version: 4); _ = try await repository.audience()
        let revision4 = source.current()
        try require(reducer.displayed(source: source) == .object([:]), "Eligible-to-eligible revision invalidates the displayed entitlement")
        try require(reducer.observe(revision4, source: source), "Eligible revision change after publication reaches the reducer")
        let freshID = reducer.beginRead(), fresh = try await repository.storeEntitlement(readID: freshID)
        try require(reducer.install(fresh, id: freshID, source: source), "Same-session eligible revision supports a replacement read")

        let audienceGate = StoreAuthorityGate(); await transport.holdNext(audienceGate)
        let deniedReadID = reducer.beginRead()
        let deniedRead = Task { try await repository.storeEntitlement(readID: deniedReadID) }
        await audienceGate.waitUntilEntered()
        await transport.audience(version: 5, eligible: false); _ = try await repository.audience()
        await audienceGate.release()
        do { _ = try await deniedRead.value; throw NativeAPIError.invalidResponse }
        catch let failure as NativeStoreEntitlementFailure {
            try require(!failure.authority.permitsStoreRead() && source.matches(failure.authority), "Real post-read audience denial remains current and cannot publish entitlement")
        }

        // Coalescing is safe because each event carries the entire current state.
        let coalescedStream = source.observations()
        var coalesced = coalescedStream.makeAsyncIterator()
        for version in 6...12 { await transport.audience(version: version, eligible: version % 2 == 0); _ = try await repository.audience() }
        guard let final = await coalesced.next() else { throw NativeAPIError.invalidResponse }
        try require(final == source.current() && final.audience?.version == 12, "Rapid deny/allow transitions coalesce to complete newest authority")
        let beforeReads = await transport.entitlementReads
        reducer.clearValue(); _ = reducer.observe(final, source: source)
        let afterReads = await transport.entitlementReads
        try require(beforeReads == afterReads, "Authority source and reducer do not issue recursive network reads")

        let otherSource = NativeStoreAuthoritySource()
        otherSource.publish(session: final.session, binding: final.binding, audience: final.audience, readID: nil)
        try require(!otherSource.matches(final) && !otherSource.permits(final), "Another repository cannot accept a coincident revision as its proof")
        let substituted = NativeStoreAuthoritySnapshot(sourceID: final.sourceID, revision: final.revision, session: nil,
            binding: final.binding, audience: final.audience, readID: final.readID, observationID: final.observationID)
        try require(!source.matches(substituted), "Same-ID revision cannot substitute different snapshot fields")
        let cancelledID = reducer.beginRead(); reducer.cancelRead()
        let currentReply = NativeStoreEntitlementRead(authority: final, value: .object(["pro_active": .bool(true)]))
        try require(!reducer.install(currentReply, id: cancelledID, source: source), "Cancelled read cannot republish current authority")

        let expiryReducer = NativeStoreEntitlementReducer(), expiryID = expiryReducer.beginRead()
        try require(expiryReducer.install(currentReply, id: expiryID, source: source), "Live proof installs before its deadline")
        try require(expiryReducer.displayed(source: source, now: final.session!.expiresAt.addingTimeInterval(1)) == .object([:]), "Wall-clock expiry fails closed without waiting for a UI timer")

        await transport.audience(version: 13)
        let observedID = UUID(), originReadID = UUID()
        let ownRead = try await repository.storeEntitlement(readID: originReadID, observationID: observedID)
        try require(ownRead.authority.readID == originReadID && ownRead.authority.observationID == observedID,
                    "Real actor marks authority learned by its own read without a self-refresh trigger")
        await transport.audience(version: 14); _ = try await repository.audience()
        try require(source.current().observationID == nil, "Independent authority observation remains distinguishable from all own reads")

        let paused = StoreAuthorityGate(); await transport.holdNext(paused)
        let retiringRead = Task { try await repository.storeEntitlement(readID: UUID()) }
        await paused.waitUntilEntered()
        await repository.clearSession()
        try require(source.current().session == nil && !source.permits(final), "Real actor retirement synchronously invalidates all outstanding proofs")
        await paused.release()
        do { _ = try await retiringRead.value; throw NativeAPIError.invalidResponse }
        catch let failure as NativeStoreEntitlementFailure { try require(failure.authority.session == nil, "Late real-actor reply after logout retains a retired failure observation") }

        try secrets.write("credentials", data: JSONEncoder().encode(StoreAuthorityFixture.credentials()))
        _ = try await repository.bootstrap(); _ = try await repository.audience()
        let returned = source.current()
        try require(returned.session?.accountID == initial.session?.accountID && returned.session!.epoch > initial.session!.epoch,
                    "Same-account reauthentication carries a newer real repository epoch")
        try require(!source.permits(final) && returned.permitsStoreRead(), "Earlier epoch cannot publish into a current eligible same-account session")
        try await schedulingChecks()
        try await retiredAndCancellationChecks()
        try feedbackChecks(session: returned.session!, repositoryID: returned.sourceID)
        print("Native store authority checks passed: \(checks)")
    }

    private static func schedulingChecks() async throws {
        for observerFirst in [false, true] {
            let secrets = StoreAuthoritySecrets(), transport = StoreAuthorityTransport()
            try secrets.write("credentials", data: JSONEncoder().encode(StoreAuthorityFixture.credentials()))
            let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-store-scheduler-" + UUID().uuidString.lowercased())
            let repository = BackendRepository(origin: StoreAuthorityFixture.origin, transport: transport, secrets: secrets,
                signer: StoreAuthoritySigner(), uploadFiles: NativeUploadPrivateFiles(root: scratch))
            _ = try await repository.bootstrap(); _ = try await repository.audience()
            let reducer = NativeStoreEntitlementReducer(), source = repository.storeAuthority, observationID = UUID()
            let gateA = StoreAuthorityGate(); await transport.holdNext(gateA)
            let idA = reducer.beginRead()
            let readA = Task { try await repository.storeEntitlement(readID: idA, observationID: observationID) }
            await gateA.waitUntilEntered()
            await transport.audience(version: 2); _ = try await repository.audience()
            let idB = reducer.beginRead(), replyB = try await repository.storeEntitlement(readID: idB, observationID: observationID)
            try require(reducer.install(replyB, id: idB, source: source), "Scheduler interleaving installs newer B at v2: observerFirst=\(observerFirst)")
            reducer.finishRead(idB, authority: replyB.authority, source: source)
            await transport.audience(version: 3); await gateA.release()
            let failureA: NativeStoreEntitlementFailure
            do { _ = try await readA.value; throw NativeAPIError.invalidResponse }
            catch let failure as NativeStoreEntitlementFailure { failureA = failure }
            let revision3 = source.current()
            try require(revision3.audience?.version == 3 && revision3.observationID == observationID && revision3.readID == idA,
                        "Superseded real read A learns eligible v3 in the same observation: observerFirst=\(observerFirst)")
            try require(failureA.underlying as? NativeAPIError == .denied(409, "audience_version_changed"),
                        "Superseded A returns the actual post-read version-fence failure: observerFirst=\(observerFirst)")
            if !observerFirst { reducer.finishRead(idA, authority: failureA.authority, source: source) }
            try require(reducer.observe(revision3, source: source), "Production observation accepts v3 after B settled: observerFirst=\(observerFirst)")
            try require(reducer.refreshDecision(revision3, source: source, active: true) == .start,
                        "Production scheduling queues recovery for superseded A's newer authority: observerFirst=\(observerFirst)")
            if observerFirst { reducer.finishRead(idA, authority: failureA.authority, source: source) }
            try require(reducer.refreshDecision(source.current(), source: source, active: true) == .none,
                        "Observation and old-read completion coalesce into one recovery: observerFirst=\(observerFirst)")
            // Execute only after the actual production decision requested work.
            let idC = reducer.beginRead(), replyC = try await repository.storeEntitlement(readID: idC, observationID: observationID)
            try require(reducer.install(replyC, id: idC, source: source), "Scheduled recovery C publishes exact v3: observerFirst=\(observerFirst)")
            reducer.finishRead(idC, authority: replyC.authority, source: source)
            try require(reducer.refreshDecision(source.current(), source: source, active: true) == .none,
                        "A valid current C proof suppresses another automatic read: observerFirst=\(observerFirst)")

            // A new eligible event while its current owner is still active must
            // be reconsidered at completion, even if that result is now stale.
            let staleCompletion = source.current(), activeID = reducer.beginRead()
            await transport.audience(version: 4); _ = try await repository.audience()
            let revision4 = source.current(); _ = reducer.observe(revision4, source: source)
            try require(reducer.refreshDecision(revision4, source: source, active: true) == .none,
                        "A live current owner temporarily coalesces a newer revision: observerFirst=\(observerFirst)")
            reducer.finishRead(activeID, authority: staleCompletion, source: source)
            try require(reducer.refreshDecision(source.current(), source: source, active: true) == .start,
                        "Completion rechecks latest source after a stale result: observerFirst=\(observerFirst)")
            let failedID = reducer.beginRead()
            reducer.finishRead(failedID, authority: revision4, source: source)
            try require(reducer.refreshDecision(revision4, source: source, active: true) == .none,
                        "Current failure at an exact revision cannot create an automatic retry loop: observerFirst=\(observerFirst)")
            _ = reducer.observe(revision4, source: source)
            try require(reducer.refreshDecision(revision4, source: source, active: true) == .none,
                        "A delayed event after current failure does not restart it: observerFirst=\(observerFirst)")
            await transport.audience(version: 5); _ = try await repository.audience()
            try require(reducer.refreshDecision(source.current(), source: source, active: true) == .start,
                        "Later independent eligibility can recover after a failed read: observerFirst=\(observerFirst)")
            let delayed = source.current(), delayedID = reducer.beginRead()
            reducer.finishRead(delayedID, authority: delayed, source: source)
            try require(reducer.observe(delayed, source: source) && reducer.refreshDecision(delayed, source: source, active: true) == .none,
                        "First observer delivery after exact failure preserves settlement: observerFirst=\(observerFirst)")
            await transport.audience(version: 6); _ = try await repository.audience()
            try require(reducer.refreshDecision(source.current(), source: source, active: true) == .start,
                        "A newer revision still schedules after a delayed failed event: observerFirst=\(observerFirst)")
            try require(reducer.refreshDecision(source.current(), source: source, active: false) == .cancel && reducer.queuedRevision == nil,
                        "Background invalidation retires queued refresh ownership: observerFirst=\(observerFirst)")
            reducer.cancelRead()
            try require(reducer.activeReadID == nil && reducer.readID == nil && reducer.queuedRevision == nil,
                        "Lifecycle cancellation retires active and queued ownership: observerFirst=\(observerFirst)")
            reducer.reset()
            try require(reducer.settledRevision == nil && reducer.observedRevision == nil,
                        "Repository rebinding cannot inherit a previous settlement: observerFirst=\(observerFirst)")
        }
    }

    private static func retirementFixture() async throws -> (BackendRepository, StoreAuthoritySecrets, StoreAuthorityTransport) {
        let secrets = StoreAuthoritySecrets(), transport = StoreAuthorityTransport()
        try secrets.write("credentials", data: JSONEncoder().encode(StoreAuthorityFixture.credentials()))
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-store-retirement-" + UUID().uuidString.lowercased())
        let repository = BackendRepository(origin: StoreAuthorityFixture.origin, transport: transport, secrets: secrets,
            signer: StoreAuthoritySigner(), uploadFiles: NativeUploadPrivateFiles(root: scratch))
        _ = try await repository.bootstrap(); _ = try await repository.audience()
        return (repository, secrets, transport)
    }
    private static func retiredAndCancellationChecks() async throws {
        for cancelled in [false, true] {
            let (repository, secrets, transport) = try await retirementFixture()
            let source = repository.storeAuthority, original = source.current(), reducer = NativeStoreEntitlementReducer()
            let gate = StoreAuthorityGate(); await transport.holdNext(gate)
            let id = reducer.beginRead(), read = Task { try await repository.storeEntitlement(readID: id) }
            await gate.waitUntilEntered()
            await repository.clearSession()
            try secrets.write("credentials", data: JSONEncoder().encode(StoreAuthorityFixture.credentials()))
            _ = try await repository.bootstrap(); _ = try await repository.audience()
            let successor = source.current(); _ = reducer.observe(successor, source: source)
            try require(successor.session!.epoch > original.session!.epoch && reducer.refreshDecision(successor, source: source, active: true) == .none,
                        "New epoch waits only while its old owner remains active: cancelled=\(cancelled)")
            if cancelled { read.cancel() }
            await gate.release()
            let failure: NativeStoreEntitlementFailure
            do { _ = try await read.value; throw NativeAPIError.invalidResponse }
            catch let value as NativeStoreEntitlementFailure { failure = value }
            try require(failure.authority == successor && failure.attemptedAuthority?.session?.epoch == original.session?.epoch,
                        "Real stale reply retains original pre-dispatch epoch beside current context: cancelled=\(cancelled)")
            try require(failure.settledAuthority == nil && failure.cancelledAuthority == nil,
                        "Old scope cannot certify or suppress the new epoch: cancelled=\(cancelled)")
            reducer.finishRead(id, authority: failure.settledAuthority, source: source, cancelledAuthority: failure.cancelledAuthority,
                cancelled: cancelled, attemptedAuthority: failure.attemptedAuthority)
            try require(reducer.settledRevision == nil && reducer.cancelledRevision == nil && reducer.refreshDecision(source.current(), source: source, active: true) == .start,
                        "Production completion schedules current epoch after retired reply: cancelled=\(cancelled)")
            let nextID = reducer.beginRead(), next = try await repository.storeEntitlement(readID: nextID)
            try require(reducer.install(next, id: nextID, source: source), "Scheduled new-epoch read publishes current entitlement: cancelled=\(cancelled)")
            reducer.finishRead(nextID, authority: next.authority, source: source)
        }
        for changedRevision in [false, true] {
            let (repository, _, transport) = try await retirementFixture()
            let source = repository.storeAuthority, reducer = NativeStoreEntitlementReducer(), gate = StoreAuthorityGate()
            await transport.holdNext(gate); await transport.cancelNextTransport()
            let id = reducer.beginRead(), read = Task { try await repository.storeEntitlement(readID: id) }
            await gate.waitUntilEntered()
            if changedRevision { await transport.audience(version: 2); _ = try await repository.audience() }
            read.cancel(); await gate.release()
            let failure: NativeStoreEntitlementFailure
            do { _ = try await read.value; throw NativeAPIError.invalidResponse }
            catch let value as NativeStoreEntitlementFailure { failure = value }
            try require(failure.underlying as? NativeAPIError == .unavailable("network") && failure.settledAuthority == nil,
                        "Task cancellation cannot settle a transport-mapped network failure: changedRevision=\(changedRevision)")
            reducer.finishRead(id, authority: failure.settledAuthority, source: source, cancelledAuthority: failure.cancelledAuthority,
                cancelled: true, attemptedAuthority: failure.attemptedAuthority)
            try require(reducer.settledRevision == nil && reducer.refreshDecision(source.current(), source: source, active: true) == (changedRevision ? .start : .none),
                        "Cancellation suppresses only its exact attempted revision: changedRevision=\(changedRevision)")
        }
        // Cancellation can occur after the actor classified a genuine current
        // failure but before MainActor completes it. Exercise the same production
        // completion helper used in NativePurchases.defer, with a gated handoff.
        for changedRevision in [false, true] {
            let (repository, _, transport) = try await retirementFixture()
            let source = repository.storeAuthority, reducer = NativeStoreEntitlementReducer(), handoff = StoreAuthorityGate()
            await transport.failNext(status: 503)
            let id = reducer.beginRead()
            let read = Task { @MainActor () async throws -> NativeStoreEntitlementFailure in
                do { _ = try await repository.storeEntitlement(readID: id); throw NativeAPIError.invalidResponse }
                catch let failure as NativeStoreEntitlementFailure {
                    await handoff.block()
                    reducer.finishRead(id, authority: failure.settledAuthority, source: source, cancelledAuthority: failure.cancelledAuthority,
                        cancelled: Task.isCancelled, attemptedAuthority: failure.attemptedAuthority)
                    return failure
                }
            }
            await handoff.waitUntilEntered()
            if changedRevision { await transport.audience(version: 2); _ = try await repository.audience() }
            read.cancel(); await handoff.release()
            let failure = try await read.value
            try require(failure.settledAuthority != nil && reducer.settledRevision == nil,
                        "Late cancellation overrides an actor-classified current failure: changedRevision=\(changedRevision)")
            try require(reducer.refreshDecision(source.current(), source: source, active: true) == (changedRevision ? .start : .none),
                        "Late-cancelled completion never suppresses newly learned authority: changedRevision=\(changedRevision)")
        }
    }
    private static func feedbackChecks(session: NativeSessionSummary, repositoryID: UUID) throws {
        let binding = NativeStoreFeedbackBinding(repositoryID: repositoryID, session: session)
        try require(binding.permits(repositoryID: repositoryID, session: session), "Store feedback permits its exact current repository and session")
        try require(!binding.permits(repositoryID: repositoryID, session: nil), "A completed StoreKit finish cannot publish feedback after logout")
        let later = NativeSessionSummary(accountID: session.accountID, roles: session.roles, authenticated: session.authenticated,
            expiresAt: session.expiresAt, epoch: session.epoch + 1)
        try require(!binding.permits(repositoryID: repositoryID, session: later), "Same-account reauthentication cannot inherit earlier StoreKit feedback")
        let foreign = NativeSessionSummary(accountID: "00000000-0000-4000-8000-000000000182", roles: session.roles, authenticated: true,
            expiresAt: session.expiresAt, epoch: session.epoch)
        try require(!binding.permits(repositoryID: repositoryID, session: foreign), "Another account cannot receive earlier purchase or restore feedback")
        try require(!binding.permits(repositoryID: UUID(), session: session), "A replacement repository cannot receive old load or transaction feedback")
        try require(!binding.permits(repositoryID: repositoryID, session: session, now: session.expiresAt.addingTimeInterval(1)),
                    "Expired authority rejects delayed StoreKit feedback")
    }
}
