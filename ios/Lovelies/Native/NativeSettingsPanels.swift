import SwiftUI
import UIKit

struct NativePolicyPanel: View {
    var includeSupport = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let url = NativePolicyLinks.url(.privacy) { Link("Privacy policy", destination: url).frame(minHeight: 44) }
            else { Text("Privacy policy is unavailable in this build.").font(.footnote).foregroundStyle(LoveliesTheme.secondary) }
            if let url = NativePolicyLinks.url(.terms) { Link("Lovelies terms", destination: url).frame(minHeight: 44) }
            else { Text("Lovelies terms are unavailable in this build.").font(.footnote).foregroundStyle(LoveliesTheme.secondary) }
            if includeSupport {
                if let url = NativePolicyLinks.url(.support) { Link("Support website", destination: url).frame(minHeight: 44) }
                else { Text("The support website is unavailable in this build.").font(.footnote).foregroundStyle(LoveliesTheme.secondary) }
                if let url = NativePolicyLinks.url(.deletion) { Link("Account deletion information", destination: url).frame(minHeight: 44) }
                else { Text("The account deletion webpage is unavailable in this build. Use the account deletion controls here.").font(.footnote).foregroundStyle(LoveliesTheme.secondary) }
            }
        }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct NativeSubscriptionPanel: View {
    @EnvironmentObject private var purchases: NativePurchases
    @EnvironmentObject private var live: LiveAppStore
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Original photos").font(.title3.weight(.semibold))
            Text("A verified Pro subscription enables authorized original saving and system sharing. Matching and recipient approval still apply.").font(.body).foregroundStyle(LoveliesTheme.secondary)
            if purchases.entitlement["pro_active"].bool == true { Label("Pro active", systemImage: "checkmark.seal").foregroundStyle(LoveliesTheme.pink) }
            if let subscription = purchases.entitlement["subscription"].object, let expiry = subscription["expires_at"]?.string { Text("Current period ends \(expiry)").font(.footnote).foregroundStyle(LoveliesTheme.secondary) }
            if let product = purchases.product {
                Text("\(product.displayName) · \(product.displayPrice) / month").font(.headline)
                Text("Payment is charged to your Apple Account. The subscription renews monthly unless cancelled at least 24 hours before the current period ends. Manage or cancel in App Store subscriptions.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                PinkButton(title: String(localized: "Subscribe with App Store"), enabled: !purchases.working && live.canEdit) { Task { await purchases.purchase() } }
            } else { QuietButton(title: String(localized: "Check App Store product"), enabled: !purchases.working) { Task { await purchases.load() } } }
            QuietButton(title: String(localized: "Restore purchases"), enabled: !purchases.working && live.canEdit) { Task { await purchases.restore() } }
            if purchases.working { ProgressView("Contacting the App Store…").tint(LoveliesTheme.pink) }
            NativePolicyPanel()
            Link("Manage App Store subscriptions", destination: URL(string: "https://apps.apple.com/account/subscriptions")!).font(.body).frame(minHeight: 44)
            Link("Apple standard terms of use", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!).font(.footnote).frame(minHeight: 44)
            if !purchases.message.isEmpty { Text(purchases.message).font(.footnote).foregroundStyle(LoveliesTheme.secondary).accessibilityAddTraits(.updatesFrequently) }
        }
    }
}

struct NativeSupportPanel: View {
    @EnvironmentObject private var live: LiveAppStore
    @FocusState private var editing: Field?
    private enum Field { case subject, details }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Contact support").font(.title3.weight(.semibold))
            TextField("Subject", text: $live.supportSubject).textInputAutocapitalization(.sentences).padding(12).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 12)).accessibilityLabel("Support subject")
                .focused($editing, equals: .subject).submitLabel(.next).onSubmit { editing = .details }
                .onChange(of: live.supportSubject) { _, value in live.supportSubject = String(value.prefix(160)) }
            TextEditor(text: $live.supportDetails).scrollContentBackground(.hidden).frame(minHeight: 130).padding(8).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 12)).accessibilityLabel("Support request details")
                .focused($editing, equals: .details)
                .onChange(of: live.supportDetails) { _, value in live.supportDetails = String(value.prefix(4000)) }
            Text("Describe the problem. Do not include passwords, recovery keys or private face images.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
            Text("Enter a subject with at least 3 characters and details with at least 5 characters.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
            PinkButton(title: String(localized: "Send support request"), enabled: live.canEdit && live.supportSubject.count >= 3 && live.supportDetails.count >= 5) { live.sendSupport() }
            QuietButton(title: String(localized: "Refresh support status"), enabled: live.canEdit) { live.loadSupport() }
            ForEach(Array(live.supportRequests.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(item["subject"].string ?? String(localized: "Support request")).font(.headline)
                    Text(item["status"].string.map(NativeStatusCopy.support) ?? String(localized: "Unavailable")).font(.subheadline).foregroundStyle(LoveliesTheme.pink)
                    if let notes = item["review_notes"].string, !notes.isEmpty { Text(notes).font(.body).foregroundStyle(LoveliesTheme.secondary) }
                }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 14))
            }
        }.onAppear { live.loadSupport() }
            .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { editing = nil } } }
    }
}

struct NativePrivacyPanel: View {
    @EnvironmentObject private var live: LiveAppStore
    @State private var deleting = false
    private var requests: [WireValue] { live.privacy["requests"].array ?? live.privacy["privacy_requests"].array ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if live.hasPendingPrivacyOperation {
                QuietButton(title: String(localized: "Check request status"), enabled: !live.busy) { live.reconcilePrivacy() }
                QuietButton(title: String(localized: "Retry original request"), enabled: !live.busy) { live.reconcilePrivacy(retry: true) }
            }
            PinkButton(title: String(localized: "Request data export"), enabled: live.canManagePrivacy) { live.requestPrivacy(false) }
            Text("Export and deletion requests show their actual review, processing and delivery status. A submitted request does not confirm erasure.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
            ForEach(Array(requests.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 8) {
                    Text(item["request_type"].string == "delete" ? String(localized: "Account deletion") : String(localized: "Data export")).font(.headline)
                    Text(item["status"].string.map(NativeStatusCopy.privacy) ?? String(localized: "Unavailable")).font(.body).foregroundStyle(LoveliesTheme.pink)
                    if let failure = item["failure_code"].string { Text(failure).font(.footnote).foregroundStyle(LoveliesTheme.secondary) }
                    if let id = item["id"].string {
                        if item["download_state"].string == "ready" {
                            PinkButton(title: String(localized: "Save or share data export"), enabled: live.canManagePrivacy) { live.exportPrivacy(id) }
                            Text("This retrieves an account-bound, one-time export. Choose Save to Files in the system share sheet. Keep the saved copy private.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                        } else if item["request_type"].string == "export", item["status"].string == "completed" {
                            Text("The export download is unavailable or expired. Request a fresh export.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                        }
                        QuietButton(title: String(localized: "Check request status"), enabled: live.canManagePrivacy) { live.checkPrivacyRequest(id) }
                    }
                }.padding(14).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }
            QuietButton(title: String(localized: "Refresh privacy status"), enabled: live.canManagePrivacy) { live.loadPrivacy() }
            NativePolicyPanel(includeSupport: true)
            Button("Request account deletion", role: .destructive) { deleting = true }.frame(minHeight: 48).disabled(!live.canManagePrivacy)
        }.onAppear { live.loadPrivacy() }
        .confirmationDialog("Delete your Lovelies account?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Request account deletion", role: .destructive) { live.requestPrivacy(true) }
            Button("Cancel", role: .cancel) {}
        } message: { Text("This requests erasure of your account, face profile and retained private photos after review and verified cleanup. Copies already saved or forwarded cannot be recalled. App Store subscriptions must also be cancelled in your Apple Account.") }
    }
}

struct NativeRegisteredDeletionView: View {
    @EnvironmentObject private var live: LiveAppStore
    var body: some View {
        VStack(spacing: 18) {
            PageHeader(title: String(localized: "Account deletion"), trailing: false, back: false)
            ScrollView { VStack(alignment: .leading, spacing: 18) {
                if let receipt = live.registeredDeletion {
                    Text(receipt.completed ? String(localized: "Account deletion completed") : String(localized: "Deletion request saved")).font(.title2.weight(.semibold))
                    Text(receipt.response?["privacy_request"]["status"].string.map(NativeStatusCopy.privacy) ?? String(localized: "Awaiting confirmation")).font(.headline).foregroundStyle(LoveliesTheme.pink)
                    Text(receipt.completed ? String(localized: "The server confirmed account erasure and private-file cleanup. Previously downloaded or forwarded copies cannot be recalled.") : String(localized: "Your private status receipt is stored securely on this device and works after your session is retired. Deletion is complete only when the server confirms it.")).font(.body).foregroundStyle(LoveliesTheme.secondary)
                    if receipt.completed { PinkButton(title: String(localized: "Start again"), enabled: !live.busy) { live.startAfterRegisteredDeletion() } }
                    else {
                        PinkButton(title: String(localized: "Check deletion status"), enabled: !live.busy) { live.checkRegisteredDeletion() }
                        if receipt.response == nil, live.session?.authenticated == true || live.hasRegisteredPrivacyIdentity { QuietButton(title: String(localized: "Retry original request"), enabled: !live.busy) { live.checkRegisteredDeletion(retry: true) } }
                        if ["rejected", "cancelled"].contains(receipt.response?["privacy_request"]["status"].string ?? "") { QuietButton(title: String(localized: "Continue account"), enabled: !live.busy) { live.continueRegisteredAccount() } }
                    }
                    Link("Manage or cancel App Store subscriptions", destination: URL(string: "https://apps.apple.com/account/subscriptions")!).font(.body).frame(minHeight: 44)
                }
                if live.busy { ProgressView().tint(LoveliesTheme.pink) }
            }.padding(22) }
        }.foregroundStyle(.white)
    }
}

struct NativeNotificationPermissionPanel: View {
    @ObservedObject private var push = NativePush.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Device notifications: \(push.permission)").font(.body)
            QuietButton(title: String(localized: "Enable device notifications")) { Task { await push.requestPermission() } }
            Button("Open notification settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }.frame(minHeight: 44)
            if let failure = push.failure { Text(failure).font(.footnote).foregroundStyle(LoveliesTheme.secondary) }
        }.task { await push.foreground() }
    }
}


struct NativeGuardianClaimPanel: View {
    @EnvironmentObject private var live: LiveAppStore
    @State private var reference = ""
    @State private var purposes: Set<NativeAudiencePurpose> = []
    @State private var attested = false
    @FocusState private var editing: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Parent or legal guardian").font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
            Text("Use a request reference shared privately by your child. Your own registered account must be adult and eligible. Each selected purpose is a request for independent review, not immediate approval.").font(.body).foregroundStyle(LoveliesTheme.secondary)
            TextField("Guardian request reference", text: $reference).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.asciiCapable).focused($editing)
                .padding(12).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 12)).accessibilityLabel("Guardian request reference")
                .onChange(of: reference) { _, value in reference = String(value.prefix(64)) }
            Toggle("I am this child’s parent or legal guardian and have parental responsibility", isOn: $attested).tint(LoveliesTheme.pink)
            ForEach(NativeAudiencePurpose.allCases, id: \.rawValue) { purpose in
                Toggle(purposeLabel(purpose), isOn: Binding(get: { purposes.contains(purpose) }, set: { enabled in if enabled { purposes.insert(purpose) } else { purposes.remove(purpose) } })).tint(LoveliesTheme.pink)
            }
            Text("Do not enter identity documents, dates of birth, contact details or face images here. Lovelies support arranges the separate review. Guardian approval never gives you access to the child’s photos.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
            PinkButton(title: String(localized: "Request independent guardian review"), enabled: live.canEdit && live.audience?.ageBand == .adult && !live.audiencePendingMutation && attested && !purposes.isEmpty && !reference.isEmpty) { editing = false; live.claimGuardian(reference: reference, purposes: purposes, attested: attested) }
            QuietButton(title: String(localized: "Check my guardian claim"), enabled: !live.busy && !reference.isEmpty) { editing = false; live.checkGuardianClaim(reference) }
            if live.audiencePendingMutation { QuietButton(title: String(localized: "Retry original age or guardian request"), enabled: !live.busy) { live.refreshAudience(retryOriginal: true) } }
            if let claim = live.guardianClaim {
                Text(NativeGuardianCopy.state(claim.state)).font(.headline).foregroundStyle(LoveliesTheme.pink)
                if claim.live { QuietButton(title: String(localized: "Withdraw guardian request or approval"), enabled: !live.busy && !live.audiencePendingMutation) { live.withdrawGuardian(claim) } }
            }
        }.padding(16).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .disabled(live.busy)
        .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { editing = false } } }
    }
    private func purposeLabel(_ purpose: NativeAudiencePurpose) -> String {
        switch purpose {
        case .faceAuthentication: return String(localized: "Face registration and sign-in")
        case .photoMatching: return String(localized: "Finding the child’s face in photos")
        case .photoProcessing: return String(localized: "Processing photos the child adds")
        }
    }
}
