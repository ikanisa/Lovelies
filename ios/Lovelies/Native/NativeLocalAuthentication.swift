import Foundation
import CryptoKit
import LocalAuthentication
import Security

/// Local device authorization never establishes the Lovelies account identity.
/// The server still verifies its signed challenge and registered reference.
enum NativeLocalAuthenticationPurpose: String, Sendable {
    case connect, enrollment, capture, reconciliation, accountRecovery, profileControl
    func allows(protocol name: String) -> Bool {
        let face = "lovelies-face-device-v1"
        switch self {
        case .enrollment:
            return [face, "lovelies-face-enrollment-device-v1", "lovelies-ordinary-face-login-device-v1"].contains(name)
        case .accountRecovery:
            return [face, "lovelies-account-recovery-device-v1"].contains(name)
        case .profileControl:
            return [face, "lovelies-face-profile-device-v1"].contains(name)
        case .connect, .capture, .reconciliation:
            // These journeys resume one of the existing signed journals or its
            // challenge. The repository still fixes the account and aliases.
            return [face, "lovelies-face-enrollment-device-v1", "lovelies-ordinary-face-login-device-v1",
                    "lovelies-account-recovery-device-v1", "lovelies-face-profile-device-v1"].contains(name)
        }
    }
}

enum NativeLocalAuthenticationIssue: Error, LocalizedError, Sendable {
    case cancelled, failed, unavailable, passcodeRequired, required, bindingChanged, expired
    var errorDescription: String? {
        switch self {
        case .cancelled: return String(localized: "Device authentication was cancelled. Your saved request is unchanged.")
        case .failed: return String(localized: "Device authentication did not finish. Try again when you are ready.")
        case .unavailable: return String(localized: "Device authentication is unavailable. Unlock this device and try again.")
        case .passcodeRequired: return String(localized: "Set a device passcode before using protected Lovelies sign-in. Guest privacy controls remain available.")
        case .required: return String(localized: "Authenticate on this device before continuing the saved face request.")
        case .bindingChanged: return String(localized: "Your sign-in state changed. Authenticate again to check the original request.")
        case .expired: return String(localized: "Device authorization expired. Authenticate again to continue the original request.")
        }
    }
}

/// A task-local operation prevents an unrelated/background task borrowing the
/// foreground operation's authorization, even when it shares the repository.
enum NativeLocalSigningOperation {
    @TaskLocal static var id: UUID?
    @TaskLocal static var purpose: NativeLocalAuthenticationPurpose?
}

struct NativeLocalAuthenticationBinding: Equatable, Sendable {
    let operationID: UUID
    let purpose: NativeLocalAuthenticationPurpose
    let accountID: String
    let epoch: Int
    let aliases: Set<String>
    let stateDigest: String

    init(operationID: UUID, purpose: NativeLocalAuthenticationPurpose, accountID: String,
         epoch: Int, aliases: Set<String>, stateDigest: String) throws {
        guard UUID(uuidString: accountID) != nil, epoch >= 0, !aliases.isEmpty,
              aliases.allSatisfy(NativeAccountRecoveryRecord.validAlias),
              stateDigest.count == 64, stateDigest.allSatisfy({ $0.isHexDigit }) else {
            throw NativeLocalAuthenticationIssue.bindingChanged
        }
        self.operationID = operationID; self.purpose = purpose; self.accountID = accountID
        self.epoch = epoch; self.aliases = aliases; self.stateDigest = stateDigest
    }
}

protocol NativeLocalAuthenticationSession: Sendable {
    func authenticate(reason: String) async throws
    func invalidate()
    var keychainContext: LAContext? { get }
}

private final class SystemNativeLocalAuthenticationSession: NativeLocalAuthenticationSession, @unchecked Sendable {
    private let context = LAContext()
    var keychainContext: LAContext? { context }
    func invalidate() { context.invalidate() }
    func authenticate(reason: String) async throws {
        context.localizedCancelTitle = String(localized: "Cancel")
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            throw Self.issue(error)
        }
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                // The same userPresence/privateKeyUsage ACL is applied to new
                // physical keys. Preauthorizing it binds this LAContext to the
                // signature operation and avoids a synchronous second prompt.
                guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                                  [.privateKeyUsage, .userPresence], nil) else {
                    continuation.resume(throwing: NativeLocalAuthenticationIssue.unavailable); return
                }
                context.evaluateAccessControl(access, operation: .useKeySign, localizedReason: reason) { success, error in
                    if success { continuation.resume() }
                    else { continuation.resume(throwing: Self.issue(error)) }
                }
            }
            try Task.checkCancellation()
        } onCancel: { self.invalidate() }
    }
    static func issue(_ error: (any Error)?) -> NativeLocalAuthenticationIssue {
        guard let error = error as? LAError else { return .unavailable }
        switch error.code {
        case .userCancel, .appCancel, .systemCancel: return .cancelled
        case .passcodeNotSet: return .passcodeRequired
        case .authenticationFailed, .userFallback: return .failed
        default: return .unavailable
        }
    }
}

/// Immutable request proof, checked again at the synchronous signing boundary.
/// Existing keys retain their ACL; only newly created keys receive userPresence.
struct NativeLocalSigningPermit: @unchecked Sendable {
    let lease: NativeLocalSigningLease
    let payloadDigest: String
    let alias: String
    let epoch: Int
    let operationID: UUID
    func require(_ bytes: Data, alias: String) throws -> LAContext? {
        guard self.alias == alias, payloadDigest == NativeLocalSigningLease.digest(bytes) else {
            throw NativeLocalAuthenticationIssue.bindingChanged
        }
        try lease.require(bytes, alias: alias, epoch: epoch, operationID: operationID)
        return lease.session.keychainContext
    }
}

private final class NativeLocalAuthenticatedContext: @unchecked Sendable {
    let session: any NativeLocalAuthenticationSession
    let started: TimeInterval
    private let lock = NSLock()
    private var invalidated = false
    init(session: any NativeLocalAuthenticationSession, started: TimeInterval) {
        self.session = session; self.started = started
    }
    func require(now: TimeInterval) throws {
        lock.lock(); defer { lock.unlock() }
        guard !invalidated else { throw NativeLocalAuthenticationIssue.required }
        guard now.isFinite, now >= started, now < started + NativeLocalSigningLease.maximumLifetime else {
            invalidated = true; throw NativeLocalAuthenticationIssue.expired
        }
    }
    func invalidate() {
        lock.lock(); invalidated = true; lock.unlock(); session.invalidate()
    }
}

final class NativeLocalSigningLease: @unchecked Sendable {
    let binding: NativeLocalAuthenticationBinding
    fileprivate var session: any NativeLocalAuthenticationSession { context.session }
    private let context: NativeLocalAuthenticatedContext
    private let clock: @Sendable () -> TimeInterval
    private let lock = NSLock()
    private var retired = false
    static let maximumLifetime: TimeInterval = 120
    init(binding: NativeLocalAuthenticationBinding, session: any NativeLocalAuthenticationSession,
         clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) throws {
        let now = clock()
        guard now.isFinite, now >= 0 else { throw NativeLocalAuthenticationIssue.expired }
        self.binding = binding; self.clock = clock
        context = NativeLocalAuthenticatedContext(session: session, started: now)
    }
    fileprivate init(binding: NativeLocalAuthenticationBinding, context: NativeLocalAuthenticatedContext,
                     clock: @escaping @Sendable () -> TimeInterval) throws {
        try context.require(now: clock()); self.binding = binding; self.context = context; self.clock = clock
    }
    static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    /// A completed action retires its operation proof. Reuse of the system's
    /// context is bounded by the ORIGINAL authorization time, never a new lease.
    func retire() { lock.lock(); retired = true; lock.unlock() }
    func invalidate() { retire(); context.invalidate() }
    fileprivate func require(_ bytes: Data, alias: String, epoch: Int, operationID: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        guard !retired else { throw NativeLocalAuthenticationIssue.required }
        try context.require(now: clock())
        guard binding.epoch == epoch, binding.operationID == operationID,
              NativeLocalSigningOperation.id == operationID,
              NativeLocalSigningOperation.purpose == binding.purpose, binding.aliases.contains(alias),
              bytes.count <= 64 * 1024,
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              value["account_id"] as? String == binding.accountID,
              let proto = value["protocol"] as? String,
              binding.purpose.allows(protocol: proto) else {
            throw NativeLocalAuthenticationIssue.bindingChanged
        }
    }
    func permit(_ bytes: Data, alias: String, epoch: Int, operationID: UUID) throws -> NativeLocalSigningPermit {
        try require(bytes, alias: alias, epoch: epoch, operationID: operationID)
        return NativeLocalSigningPermit(lease: self, payloadDigest: Self.digest(bytes), alias: alias,
                                       epoch: epoch, operationID: operationID)
    }
}

protocol NativeLocalAuthenticating: Sendable {
    func authorize(_ binding: NativeLocalAuthenticationBinding) async throws -> NativeLocalSigningLease
    func invalidate()
}

final class NativeLocalAuthenticator: NativeLocalAuthenticating, @unchecked Sendable {
    private let makeSession: @Sendable () -> any NativeLocalAuthenticationSession
    private let clock: @Sendable () -> TimeInterval
    private let lock = NSLock()
    private var pending: (id: UUID, session: any NativeLocalAuthenticationSession)?
    private var cached: (binding: NativeLocalAuthenticationBinding, context: NativeLocalAuthenticatedContext)?
    init(makeSession: @escaping @Sendable () -> any NativeLocalAuthenticationSession = { SystemNativeLocalAuthenticationSession() },
         clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.makeSession = makeSession; self.clock = clock
    }
    private func reused(_ binding: NativeLocalAuthenticationBinding) -> NativeLocalSigningLease? {
        lock.lock(); defer { lock.unlock() }
        guard let cached, cached.binding.accountID == binding.accountID, cached.binding.epoch == binding.epoch,
              cached.binding.aliases == binding.aliases,
              let lease = try? NativeLocalSigningLease(binding: binding, context: cached.context, clock: clock) else { return nil }
        return lease
    }
    private func begin(_ session: any NativeLocalAuthenticationSession) -> UUID {
        lock.lock(); defer { lock.unlock() }
        pending?.session.invalidate(); cached?.context.invalidate(); cached = nil
        let id = UUID(); pending = (id, session); return id
    }
    private func finish(_ id: UUID, binding: NativeLocalAuthenticationBinding? = nil,
                        context: NativeLocalAuthenticatedContext? = nil) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard pending?.id == id else { return false }
        pending = nil
        if let binding, let context { cached = (binding, context) }
        return true
    }
    func invalidate() {
        lock.lock(); let held = pending?.session, context = cached?.context
        pending = nil; cached = nil; lock.unlock()
        held?.invalidate(); context?.invalidate()
    }
    func authorize(_ binding: NativeLocalAuthenticationBinding) async throws -> NativeLocalSigningLease {
        try Task.checkCancellation()
        if let lease = reused(binding) { return lease }
        let session = makeSession(), id = begin(session)
        do {
            try await session.authenticate(reason: String(localized: "Confirm access on this device to continue your Lovelies request. Your selfies are verified separately."))
            try Task.checkCancellation()
            let now = clock()
            guard now.isFinite, now >= 0 else { throw NativeLocalAuthenticationIssue.expired }
            let context = NativeLocalAuthenticatedContext(session: session, started: now)
            guard finish(id, binding: binding, context: context) else { throw NativeLocalAuthenticationIssue.cancelled }
            return try NativeLocalSigningLease(binding: binding, context: context, clock: clock)
        } catch {
            _ = finish(id); session.invalidate(); throw error
        }
    }
}
