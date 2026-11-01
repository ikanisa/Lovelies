import SwiftUI
import UIKit
import StoreKit
import UserNotifications
import UniformTypeIdentifiers
import BackgroundTasks


enum NativePolicyLinks {
    enum Kind: String { case privacy = "LoveliesPrivacyPolicyURL", terms = "LoveliesTermsURL", support = "LoveliesSupportURL", deletion = "LoveliesAccountDeletionURL" }
    static func url(_ kind: Kind) -> URL? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: kind.rawValue) as? String,
              let url = URL(string: raw), url.scheme == "https", url.host?.isEmpty == false,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.port == nil || url.port == 443 else { return nil }
        return url
    }
    static var purchaseReady: Bool { url(.privacy) != nil && url(.terms) != nil }
}

/// Local choices never substitute for a current server snapshot, media grant,
/// subscription or session. Store this record in the account's Keychain slot.
struct NativeShareFile: Identifiable { let id = UUID(); let url: URL }
struct NativeSystemShare: UIViewControllerRepresentable {
    let url: URL
    let completion: (Bool) -> Void
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, completed, _, error in completion(completed && error == nil) }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

@MainActor final class NativePurchases: ObservableObject {
    @Published private(set) var product: Product?
    @Published private(set) var working = false
    @Published private(set) var message = ""
    @Published private(set) var entitlement: WireValue = .object([:])
    private weak var live: LiveAppStore?
    private var updates: Task<Void, Never>?
    private var bindingGeneration = 0
    var productID: String { Bundle.main.object(forInfoDictionaryKey: "LoveliesSubscriptionProduct") as? String ?? "com.lovelies.memories.pro.monthly" }
    func attach(_ store: LiveAppStore) {
        if live !== store { bindingGeneration += 1 }
        live = store
        guard updates == nil else { return }
        let binding = bindingGeneration
        updates = Task { [weak self] in
            for await value in StoreKit.Transaction.updates {
                guard !Task.isCancelled, let self, self.bindingGeneration == binding else { return }
                do { try await self.verify(value) }
                catch { if self.bindingGeneration == binding, !Task.isCancelled { self.message = self.failureMessage(error) } }
            }
        }
    }
    func suspend() {
        bindingGeneration += 1
        updates?.cancel(); updates = nil; live = nil
    }
    func load() async {
        guard !Task.isCancelled, let live else { return }
        if updates == nil { attach(live) }
        let binding = bindingGeneration
        var recoveryFailure: (any Error)?
        do {
            let available = try await Product.products(for: [productID]).first
            guard isCurrent(live, binding: binding) else { return }
            product = available
            if product == nil { message = String(localized: "This subscription is currently unavailable from the App Store.") }
        } catch { recoveryFailure = error }
        guard isCurrent(live, binding: binding) else { return }
        do {
            do { try await recoverUnfinished() } catch { recoveryFailure = error }
            // One held historical submission cannot suppress an independent,
            // authoritative read of today's subscription entitlement.
            try await refreshEntitlement()
            if let recoveryFailure, isCurrent(live, binding: binding) { message = failureMessage(recoveryFailure) }
        } catch { if isCurrent(live, binding: binding) { message = failureMessage(error) } }
    }
    func refreshEntitlement() async throws {
        try Task.checkCancellation()
        guard let live, live.session?.authenticated == true, let repository = live.repository else { throw NativeAPIError.authenticationRequired }
        let binding = bindingGeneration
        let account = live.session?.accountID, epoch = live.session?.epoch, fence = live.publicationFence()
        let result = try await repository.refreshedAppleEntitlements()
        try live.checkPublication(fence)
        guard isCurrent(live, binding: binding), live.session?.accountID == account, live.session?.epoch == epoch,
              let expires = live.session?.expiresAt, expires > Date() else { throw NativeAPIError.sessionChanged }
        entitlement = result
    }
    func purchase() async {
        guard !working, let live else { return }
        let binding = bindingGeneration, owner = live.session?.accountID
        working = true; defer { working = false }
        do {
            guard NativePolicyLinks.purchaseReady else { throw NativeAPIError.unsupported(String(localized: "Review the available privacy policy and terms before subscribing.")) }
            guard let product, let repository = live.repository, live.session?.authenticated == true,
                  let account = UUID(uuidString: live.session?.accountID ?? "") else { throw NativeAPIError.authenticationRequired }
            let binding = bindingGeneration, fence = live.publicationFence(), sessionEpoch = live.session?.epoch
            let reservation = try await repository.reserveApplePurchase(product: product.id)
            try live.checkPublication(fence)
            guard isCurrent(live, binding: binding), live.session?.accountID == owner, live.session?.epoch == sessionEpoch else { throw NativeAPIError.sessionChanged }
            let result = try await product.purchase(options: [.appAccountToken(account)])
            try live.checkPublication(fence)
            guard isCurrent(live, binding: binding), live.session?.accountID == account.uuidString.lowercased(), live.session?.epoch == sessionEpoch else { throw NativeAPIError.sessionChanged }
            switch result {
            case .success(let result): try await verify(result)
            case .pending:
                if isCurrent(live, binding: binding), live.session?.accountID == owner { message = String(localized: "Purchase awaits App Store approval. Original access has not been granted.") }
            case .userCancelled:
                try await repository.releaseApplePurchaseReservation(reservation)
                if isCurrent(live, binding: binding), live.session?.accountID == owner { message = String(localized: "Purchase cancelled.") }
            @unknown default:
                if isCurrent(live, binding: binding), live.session?.accountID == owner { message = String(localized: "The App Store returned an unknown purchase state. Check or restore purchases.") }
            }
        } catch { if isCurrent(live, binding: binding), live.session?.accountID == owner { message = failureMessage(error) } }
    }
    func restore() async {
        guard !working, let live else { return }
        let binding = bindingGeneration, owner = live.session?.accountID, epoch = live.session?.epoch
        func requireRestoreOwner() throws {
            guard isCurrent(live, binding: binding), let owner, live.session?.authenticated == true,
                  live.session?.accountID == owner, live.session?.epoch == epoch else { throw NativeAPIError.sessionChanged }
        }
        working = true; defer { working = false }
        let restoreAttempt = NativeAppleRestoreAttempt()
        do {
            try requireRestoreOwner()
            try await AppStore.sync()
            try requireRestoreOwner()
            var recoveryFailure: (any Error)?
            do { try await recoverUnfinished(restoreAttempt: restoreAttempt); try requireRestoreOwner() }
            catch { try requireRestoreOwner(); recoveryFailure = error }
            var restored = false
            for await result in StoreKit.Transaction.currentEntitlements {
                try requireRestoreOwner()
                if case .verified(let transaction) = result, transaction.productID == productID {
                    do { try await verify(result, restoreAttempt: restoreAttempt); try requireRestoreOwner(); restored = true }
                    catch { try requireRestoreOwner(); recoveryFailure = error }
                }
            }
            try requireRestoreOwner()
            try await refreshEntitlement()
            if isCurrent(live, binding: binding), live.session?.accountID == owner, live.session?.epoch == epoch {
                if let recoveryFailure { message = failureMessage(recoveryFailure) }
                else if !restored { message = String(localized: "No current matching subscription was returned by the App Store.") }
            }
        } catch { if isCurrent(live, binding: binding), live.session?.accountID == owner, live.session?.epoch == epoch { message = failureMessage(error) } }
    }
    private func recoverUnfinished(restoreAttempt: NativeAppleRestoreAttempt? = nil) async throws {
        guard let live, let owner = live.session?.accountID, let repository = live.repository else { throw NativeAPIError.authenticationRequired }
        let binding = bindingGeneration, epoch = live.session?.epoch
        var failure: (any Error)?
        var seen: Set<String> = []
        for await result in StoreKit.Transaction.unfinished {
            guard isCurrent(live, binding: binding), live.session?.accountID == owner, live.session?.epoch == epoch else { throw NativeAPIError.sessionChanged }
            if case .verified(let transaction) = result, transaction.productID == productID,
               transaction.appAccountToken?.uuidString.lowercased() == owner {
                seen.insert(String(transaction.id))
                do { try await verify(result, restoreAttempt: restoreAttempt) } catch { if failure == nil { failure = error } }
            }
        }
        // finish() can succeed immediately before process death, leaving the
        // local provider-confirmed marker behind. Such a transaction is absent
        // from unfinished; the verified history supplies its exact StoreKit ID.
        let originalIDs = try await repository.unfinishedApplePurchaseIDs(includeTerminal: restoreAttempt != nil)
        guard isCurrent(live, binding: binding), live.session?.accountID == owner, live.session?.epoch == epoch else { throw NativeAPIError.sessionChanged }
        var retained = originalIDs.subtracting(seen)
        if !retained.isEmpty {
            for await result in StoreKit.Transaction.all {
                guard isCurrent(live, binding: binding), live.session?.accountID == owner, live.session?.epoch == epoch else { throw NativeAPIError.sessionChanged }
                if case .verified(let transaction) = result, retained.contains(String(transaction.id)), transaction.productID == productID,
                   transaction.appAccountToken?.uuidString.lowercased() == owner {
                    do { try await verify(result, restoreAttempt: restoreAttempt) } catch { if failure == nil { failure = error } }
                    retained.remove(String(transaction.id)); if retained.isEmpty { break }
                }
            }
        }
        if let failure { throw failure }
    }
    private func verify(_ result: VerificationResult<StoreKit.Transaction>, restoreAttempt: NativeAppleRestoreAttempt? = nil) async throws {
        try Task.checkCancellation()
        guard case .verified(let transaction) = result, transaction.productID == productID else { throw NativeAPIError.unsupported(String(localized: "The App Store transaction could not be verified.")) }
        guard let live, let session = live.session, session.authenticated, let repository = live.repository,
              transaction.appAccountToken?.uuidString.lowercased() == session.accountID else { throw NativeAPIError.unsupported(String(localized: "This purchase belongs to another Lovelies account. Sign in to the purchasing account before restoring.")) }
        let binding = bindingGeneration, fence = live.publicationFence()
        let environment: String
        if transaction.environment == .production { environment = "production" }
        else if transaction.environment == .sandbox { environment = "sandbox" }
        else { throw NativeAPIError.unsupported(String(localized: "This App Store environment cannot grant a live Lovelies entitlement.")) }
        if let restoreAttempt, !restoreAttempt.claim(account: session.accountID, product: transaction.productID, transaction: String(transaction.id), original: String(transaction.originalID), environment: environment) { return }
        let record = try await repository.verifyApplePurchase(account: session.accountID, product: transaction.productID,
            transaction: String(transaction.id), original: String(transaction.originalID), environment: environment, signedTransaction: result.jwsRepresentation,
            allowTerminalReplacement: restoreAttempt != nil, expectedEpoch: session.epoch)
        try live.checkPublication(fence)
        guard isCurrent(live, binding: binding), live.session?.accountID == session.accountID, live.session?.epoch == session.epoch,
              let receipt = record.receipt, let response = try record.result(from: receipt) else { throw NativeAPIError.sessionChanged }
        try live.checkPublication(fence)
        guard (live.session?.expiresAt ?? .distantPast) > Date() else { throw NativeAPIError.sessionChanged }
        if !record.finished {
            await transaction.finish()
            // This historical observation survives cancellation/account changes;
            // it never publishes content or authorizes another account.
            try await repository.applePurchaseFinishObserved(record.operationKey, account: record.accountID)
        }
        guard isCurrent(live, binding: binding), live.session?.accountID == session.accountID, live.session?.epoch == session.epoch else { throw NativeAPIError.sessionChanged }
        try await refreshEntitlement()
        guard isCurrent(live, binding: binding), live.session?.accountID == session.accountID else { throw NativeAPIError.sessionChanged }
        message = response["billing_environment"].string == "sandbox" ? String(localized: "Sandbox transaction verified. Production original access is unchanged.") : response["active"].bool == true ? String(localized: "Subscription verified by Lovelies.") : String(localized: "Subscription is expired or revoked.")
    }
    private func isCurrent(_ store: LiveAppStore, binding: Int) -> Bool {
        !Task.isCancelled && live === store && bindingGeneration == binding && store.isForeground
    }
    private func failureMessage(_ error: any Error) -> String {
        if case NativeAPIError.denied(409, "operation_recovered_without_result") = error {
            return String(localized: "Purchase verification ended without confirmation. Choose Restore purchases to try again.")
        }
        return error.localizedDescription
    }
    func retire() { bindingGeneration += 1; updates?.cancel(); updates = nil; entitlement = .object([:]); message = "" }
}

@MainActor final class NativePush: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NativePush()
    @Published private(set) var permission = String(localized: "Not requested")
    @Published private(set) var failure: String?
    private(set) var token: String?
    private weak var live: LiveAppStore?
    private var bindingGeneration = 0
    private var pending: (String, String)?
    private var pendingNotificationID: String?
    private var routingNotification = false
    private var boundAccount: String?
    private var registrationID: String?
    private var explicitRegistrationChoice: (account: String, binding: Int)?
    func attach(_ store: LiveAppStore) {
        if live !== store { bindingGeneration += 1 }
        live = store; UNUserNotificationCenter.current().delegate = self
    }
    func suspend() {
        bindingGeneration += 1; live = nil
        let center = UNUserNotificationCenter.current()
        if center.delegate === self { center.delegate = nil }
    }
    func requestPermission() async {
        guard let live else { return }
        let binding = bindingGeneration, account = live.session?.accountID
        do {
            let accepted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            guard isCurrent(live, binding: binding), live.session?.accountID == account else { return }
            permission = accepted ? String(localized: "Allowed") : String(localized: "Disabled in Settings")
            if accepted {
                if let account { explicitRegistrationChoice = (account, binding) }
                UIApplication.shared.registerForRemoteNotifications(); await register()
            } else { explicitRegistrationChoice = nil; await unregister(allowNewAfterTerminal: true) }
        } catch { failure = String(localized: "Notification permission could not be requested.") }
    }
    func foreground() async {
        guard !Task.isCancelled, let live else { return }
        let binding = bindingGeneration
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard isCurrent(live, binding: binding) else { return }
        let allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        permission = allowed ? String(localized: "Allowed") : settings.authorizationStatus == .notDetermined ? String(localized: "Not requested") : String(localized: "Disabled in Settings")
        if allowed { UIApplication.shared.registerForRemoteNotifications(); await register() }
        else { await unregister() }
        if isCurrent(live, binding: binding) { routePending() }
    }
    func receivedToken(_ data: Data) { token = data.map { String(format: "%02x", $0) }.joined(); Task { await register() } }
    func registrationFailed() { failure = String(localized: "Push registration is unavailable. In-app notifications remain available.") }
    func register() async {
        guard let live, !live.busy, let session = live.session, session.authenticated, let repository = live.repository, let token else { return }
        let binding = bindingGeneration
        let allowReplacement = explicitRegistrationChoice?.account == session.accountID && explicitRegistrationChoice?.binding == binding
        explicitRegistrationChoice = nil
        do {
            try Task.checkCancellation()
            let value = try await repository.post("/me/push-devices", payload: .object(["platform": .string("ios"), "push_token": .string(token)]), operation: "notification.device.register", allowNewAfterTerminal: allowReplacement)
            guard isCurrent(live, binding: binding), live.session?.accountID == session.accountID else { return }
            registrationID = try value.uuid("id"); boundAccount = session.accountID; failure = nil
            if let authDevice = try await repository.device()?.deviceID {
                guard isCurrent(live, binding: binding) else { return }
                let rows = try await repository.protectedJSON("/me/push-devices")["items"].array ?? []
                for row in rows where row["platform"].string == "ios" && row["auth_device_id"].string == authDevice && row["active"].bool != false && row["active"].integer != 0 {
                    guard isCurrent(live, binding: binding) else { return }
                    let id = try row.uuid("id")
                    if id != registrationID { _ = try await repository.post("/me/push-devices/\(id)", payload: .object([:]), operation: "notification.device.rotate", method: "DELETE") }
                }
            }
        } catch { if isCurrent(live, binding: binding) { failure = error.localizedDescription } }
    }
    func unregister(allowNewAfterTerminal: Bool = false) async {
        guard let live, let repository = live.repository, live.session?.authenticated == true else { return }
        let binding = bindingGeneration
        do {
            guard let authDevice = try await repository.device()?.deviceID else { return }
            guard isCurrent(live, binding: binding) else { return }
            let rows = try await repository.protectedJSON("/me/push-devices")["items"].array ?? []
            for row in rows where row["platform"].string == "ios" && row["auth_device_id"].string == authDevice && row["active"].bool != false && row["active"].integer != 0 {
                guard isCurrent(live, binding: binding) else { return }
                let id = try row.uuid("id")
                _ = try await repository.post("/me/push-devices/\(id)", payload: .object([:]), operation: "notification.device.remove", method: "DELETE", allowNewAfterTerminal: allowNewAfterTerminal)
            }
            guard isCurrent(live, binding: binding) else { return }
            registrationID = nil; boundAccount = nil
        } catch { if isCurrent(live, binding: binding) { failure = error.localizedDescription } }
    }
    func retireAccountBinding() {
        bindingGeneration += 1; registrationID = nil; boundAccount = nil
        pending = nil; pendingNotificationID = nil; failure = nil; explicitRegistrationChoice = nil
    }
    func queue(kind: String, entity: String) {
        guard ["match", "support", "payment"].contains(kind),
              kind == "payment" ? (!entity.isEmpty && entity.count <= 512 && !entity.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })) : UUID(uuidString: entity) != nil else { return }
        pending = (kind, entity); routePending()
    }
    func queueNotification(id: String) {
        guard UUID(uuidString: id) != nil else { return }
        pendingNotificationID = id.lowercased(); routePending()
    }
    func routePending() {
        guard let live, let session = live.session, session.authenticated, !live.busy else { return }
        let binding = bindingGeneration
        if let id = pendingNotificationID, !routingNotification {
            routingNotification = true; pendingNotificationID = nil
            Task { @MainActor in
                defer { self.routingNotification = false }
                do {
                    guard self.isCurrent(live, binding: binding) else { return }
                    guard let repository = live.repository else { throw NativeAPIError.authenticationRequired }
                    let fence = live.publicationFence()
                    let response = try await repository.protectedJSON("/me/notifications/" + id)
                    try live.checkPublication(fence)
                    let row = response["notification"]
                    guard self.isCurrent(live, binding: binding), live.session?.accountID == session.accountID, live.session?.epoch == session.epoch,
                          session.expiresAt > Date(), row["id"].string == id,
                          let kind = row["kind"].string, let entity = row["entity_id"].string else { throw NativeAPIError.sessionChanged }
                    self.queue(kind: kind, entity: entity)
                } catch { if self.isCurrent(live, binding: binding) { self.failure = String(localized: "This account update is unavailable. Open your notification inbox.") } }
            }
            return
        }
        guard let value = pending else { return }
        pending = nil; live.openAuthorizedDestination(kind: value.0, id: value.1)
    }
    private func isCurrent(_ store: LiveAppStore, binding: Int) -> Bool {
        !Task.isCancelled && live === store && bindingGeneration == binding
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let id = (info["id"] ?? info["notification_id"]) as? String
        Task { @MainActor in if let id { self.queueNotification(id: id) }; completionHandler() }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Public notification text stays generic. Current account content is
        // fetched after a tap through the authenticated repository.
        completionHandler([.banner, .sound])
    }
}

final class NativeAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NativeBackgroundUploads.shared.register(); return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Task { @MainActor in NativePush.shared.receivedToken(deviceToken) } }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { Task { @MainActor in NativePush.shared.registrationFailed() } }
}

/// BGProcessing is opportunistic. User-started uploads retain exact bytes and
/// request keys; a locked device, revoked session, explicit pause, or exhausted
/// retry budget leaves the same journal available for foreground review.
@MainActor final class NativeBackgroundUploads {
    static let shared = NativeBackgroundUploads()
    private var retainedRepository: BackendRepository?
    private var work: Task<Void, Never>?
    private var registrationSucceeded = false
    private var identifier: String { (Bundle.main.bundleIdentifier ?? "com.lovelies.memories") + ".upload-retry" }
    func repository() throws -> BackendRepository {
        if let retainedRepository { return retainedRepository }
        let value = try BackendRepository(origin: NativeConfiguration.origin()); retainedRepository = value; return value
    }
    func register() {
        registrationSucceeded = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            Task { @MainActor in NativeBackgroundUploads.shared.run(task) }
        }
    }
    func schedule() {
        guard registrationSucceeded, UIApplication.shared.applicationState != .active, UIApplication.shared.backgroundRefreshStatus == .available else { return }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        let request = BGProcessingTaskRequest(identifier: identifier)
        request.requiresNetworkConnectivity = true; request.requiresExternalPower = false
        request.earliestBeginDate = Date().addingTimeInterval(15 * 60)
        // Unavailable/disabled scheduling is recoverable through the visible
        // saved-upload screen. It never changes the upload's authority.
        try? BGTaskScheduler.shared.submit(request)
    }
    func cancelScheduled() { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier) }
    func stop() async {
        let active = work; active?.cancel(); await active?.value
    }
    private func run(_ task: BGTask) {
        guard work == nil, UIApplication.shared.applicationState == .background else { task.setTaskCompleted(success: false); return }
        work = Task { [self] in
            var batch: String?, success = false
            let deadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(25)); self?.work?.cancel() } catch {}
            }
            defer { deadline.cancel(); work = nil; task.setTaskCompleted(success: success) }
            do {
                let repository = try repository()
                guard let saved = try await repository.restoreBackgroundUpload(), saved.batch.canRetryInBackground else { success = true; return }
                batch = saved.batch.id; try Task.checkCancellation()
                guard try await repository.beginBackgroundUpload(batchID: saved.batch.id) else { success = true; return }
                _ = try await repository.resumePhotoUpload(batchID: saved.batch.id, maximumChunks: 4)
                success = !Task.isCancelled
            } catch { /* Preserve request identity and require fresh server checks on retry. */ }
            if let batch, let repository = retainedRepository {
                // A cancelled task still must persist a safe pause and cancel
                // its transport before foreground work can use this repository.
                let saved = try? await repository.pausePhotoUpload(batchID: batch, disableAutomaticRetry: false)
                if saved?.batch.canRetryInBackground == true { schedule() }
            }
        }
        task.expirationHandler = { [weak self] in Task { @MainActor in self?.work?.cancel() } }
    }
}
