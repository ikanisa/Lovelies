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
}

/// Local choices never substitute for a current server snapshot, media grant,
/// subscription or session. Store this record in the account's Keychain slot.
struct NativeShareFile: Identifiable { let id = UUID(); let url: URL }
struct NativeSystemShare: UIViewControllerRepresentable {
    let url: URL
    let completion: () -> Void
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in completion() }
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
    var productID: String { Bundle.main.object(forInfoDictionaryKey: "LoveliesSubscriptionProduct") as? String ?? "com.lovelies.memories.pro.monthly" }
    func attach(_ store: LiveAppStore) {
        live = store
        guard updates == nil else { return }
        updates = Task { [weak self] in
            for await value in StoreKit.Transaction.updates {
                guard !Task.isCancelled, let self else { return }
                do { try await self.verify(value) } catch { self.message = error.localizedDescription }
            }
        }
    }
    func load() async {
        do {
            product = try await Product.products(for: [productID]).first
            if product == nil { message = "This subscription is currently unavailable from the App Store." }
            try await refreshEntitlement()
        } catch { message = error.localizedDescription }
    }
    func refreshEntitlement() async throws {
        guard let live, live.session?.authenticated == true, let repository = live.repository else { throw NativeAPIError.authenticationRequired }
        let account = live.session?.accountID
        let result = try await repository.protectedJSON("/me/entitlements")
        guard live.session?.accountID == account else { throw NativeAPIError.sessionChanged }
        entitlement = result
    }
    func purchase() async {
        guard !working else { return }
        working = true; defer { working = false }
        do {
            guard let product, let live, live.session?.authenticated == true,
                  let account = UUID(uuidString: live.session?.accountID ?? "") else { throw NativeAPIError.authenticationRequired }
            switch try await product.purchase(options: [.appAccountToken(account)]) {
            case .success(let result): try await verify(result)
            case .pending: message = "Purchase awaits App Store approval. Original access has not been granted."
            case .userCancelled: message = "Purchase cancelled."
            @unknown default: message = "The App Store returned an unknown purchase state. Check or restore purchases."
            }
        } catch { message = error.localizedDescription }
    }
    func restore() async {
        guard !working else { return }
        working = true; defer { working = false }
        do {
            try await AppStore.sync()
            var restored = false
            for await result in StoreKit.Transaction.currentEntitlements {
                if case .verified(let transaction) = result, transaction.productID == productID {
                    try await verify(result); restored = true
                }
            }
            try await refreshEntitlement()
            if !restored { message = "No current matching subscription was returned by the App Store." }
        } catch { message = error.localizedDescription }
    }
    private func verify(_ result: VerificationResult<StoreKit.Transaction>) async throws {
        guard case .verified(let transaction) = result, transaction.productID == productID else { throw NativeAPIError.unsupported("The App Store transaction could not be verified.") }
        guard let live, let session = live.session, session.authenticated, let repository = live.repository,
              transaction.appAccountToken?.uuidString.lowercased() == session.accountID else { throw NativeAPIError.unsupported("This purchase belongs to another Lovelies account. Sign in to the purchasing account before restoring.") }
        let response = try await repository.post("/subscriptions/apple/transactions", payload: .object([
            "product_id": .string(transaction.productID), "signed_transaction": .string(result.jwsRepresentation)
        ]), operation: "store.apple")
        guard live.session?.accountID == session.accountID, live.session?.epoch == session.epoch,
              response["product_id"].string == transaction.productID,
              response["transaction_id"].string == String(transaction.id), response["active"].bool != nil,
              ["production", "sandbox"].contains(response["billing_environment"].string ?? "") else { throw NativeAPIError.invalidResponse }
        // Finish only after durable backend verification. An unavailable service
        // leaves StoreKit's transaction unfinished for the next update/relaunch.
        await transaction.finish()
        try await refreshEntitlement()
        message = response["billing_environment"].string == "sandbox" ? "Sandbox transaction verified. Production original access is unchanged." : response["active"].bool == true ? "Subscription verified by Lovelies." : "Subscription is expired or revoked."
    }
    func retire() { entitlement = .object([:]); message = "" }
}

@MainActor final class NativePush: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NativePush()
    @Published private(set) var permission = "Not requested"
    @Published private(set) var failure: String?
    private(set) var token: String?
    private weak var live: LiveAppStore?
    private var pending: (String, String)?
    private var pendingNotificationID: String?
    private var routingNotification = false
    private var boundAccount: String?
    private var registrationID: String?
    func attach(_ store: LiveAppStore) { live = store; UNUserNotificationCenter.current().delegate = self }
    func requestPermission() async {
        do {
            let accepted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            permission = accepted ? "Allowed" : "Disabled in Settings"
            if accepted { UIApplication.shared.registerForRemoteNotifications() }
            else { await unregister() }
        } catch { failure = "Notification permission could not be requested." }
    }
    func foreground() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        permission = allowed ? "Allowed" : settings.authorizationStatus == .notDetermined ? "Not requested" : "Disabled in Settings"
        if allowed { UIApplication.shared.registerForRemoteNotifications(); await register() }
        else { await unregister() }
        routePending()
    }
    func receivedToken(_ data: Data) { token = data.map { String(format: "%02x", $0) }.joined(); Task { await register() } }
    func registrationFailed() { failure = "Push registration is unavailable. In-app notifications remain available." }
    func register() async {
        guard let live, !live.busy, let session = live.session, session.authenticated, let repository = live.repository, let token else { return }
        do {
            let value = try await repository.post("/me/push-devices", payload: .object(["platform": .string("ios"), "push_token": .string(token)]), operation: "notification.device.register")
            guard live.session?.accountID == session.accountID else { return }
            registrationID = try value.uuid("id"); boundAccount = session.accountID; failure = nil
            if let authDevice = try await repository.device()?.deviceID {
                let rows = try await repository.protectedJSON("/me/push-devices")["items"].array ?? []
                for row in rows where row["platform"].string == "ios" && row["auth_device_id"].string == authDevice && row["active"].bool != false && row["active"].integer != 0 {
                    let id = try row.uuid("id")
                    if id != registrationID { _ = try await repository.post("/me/push-devices/\(id)", payload: .object([:]), operation: "notification.device.rotate", method: "DELETE") }
                }
            }
        } catch { failure = error.localizedDescription }
    }
    func unregister() async {
        guard let live, let repository = live.repository, live.session?.authenticated == true else { return }
        do {
            guard let authDevice = try await repository.device()?.deviceID else { return }
            let rows = try await repository.protectedJSON("/me/push-devices")["items"].array ?? []
            for row in rows where row["platform"].string == "ios" && row["auth_device_id"].string == authDevice && row["active"].bool != false && row["active"].integer != 0 {
                let id = try row.uuid("id")
                _ = try await repository.post("/me/push-devices/\(id)", payload: .object([:]), operation: "notification.device.remove", method: "DELETE")
            }
            registrationID = nil; boundAccount = nil
        } catch { failure = error.localizedDescription }
    }
    func queue(kind: String, entity: String) {
        guard ["match", "support", "payment"].contains(kind),
              kind == "payment" ? (!entity.isEmpty && entity.count <= 512 && !entity.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })) : UUID(uuidString: entity) != nil else { return }
        pending = (kind, entity); routePending()
    }
    func queueNotification(id: String) {
        guard UUID(uuidString: id) != nil else { return }
        pendingNotificationID = id; routePending()
    }
    func routePending() {
        guard let live, let session = live.session, session.authenticated, !live.busy else { return }
        if let id = pendingNotificationID, !routingNotification {
            routingNotification = true; pendingNotificationID = nil
            Task { @MainActor in
                defer { self.routingNotification = false }
                do {
                    guard let repository = live.repository else { throw NativeAPIError.authenticationRequired }
                    let response = try await repository.protectedJSON("/me/notifications")
                    guard live.session?.accountID == session.accountID, live.session?.epoch == session.epoch,
                          let row = response["items"].array?.first(where: { $0["id"].string == id }),
                          let kind = row["kind"].string, let entity = row["entity_id"].string else { throw NativeAPIError.sessionChanged }
                    self.queue(kind: kind, entity: entity)
                } catch { self.failure = "This account update is unavailable. Open your notification inbox." }
            }
            return
        }
        guard let value = pending else { return }
        pending = nil; live.openAuthorizedDestination(kind: value.0, id: value.1)
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
