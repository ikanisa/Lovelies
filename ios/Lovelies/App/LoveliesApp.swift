import SwiftUI
import UIKit

@main struct LoveliesApp: App {
    @UIApplicationDelegateAdaptor(NativeAppDelegate.self) private var appDelegate
    @StateObject private var purchases = NativePurchases()
    @StateObject private var store = DemoStore()
    @StateObject private var live = LiveAppStore()
    var body: some Scene {
        WindowGroup {
            LoveliesRootView()
                .environmentObject(store)
                .environmentObject(live)
                .environmentObject(purchases)
                .preferredColorScheme(.dark)
                .tint(LoveliesTheme.pink)
        }
    }
}

struct LoveliesRootView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    @EnvironmentObject private var purchases: NativePurchases
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    @State private var foregroundRefresh: Task<Void, Never>?
    var body: some View {
        ZStack {
            LoveliesTheme.canvas.ignoresSafeArea()
            Group { if store.isReferenceMode { route } else { LiveRouteView(screen: store.screen) } }
                .id(store.screen)
                .transition(reduceMotion ? .identity : .opacity)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if store.isReferenceMode {
                ReferenceBannerLayout(layoutDirection: layoutDirection) {
                    referenceStatus
                    referenceGalleryButton
                }.padding(.horizontal, 16).background(LoveliesTheme.canvas)
            }
        }
        .sheet(isPresented: $store.showGallery) { ScreenGalleryView() }
        .task {
            live.attach(store)
            guard !store.isReferenceMode else { return }
            attachConnectedServices()
            if scenePhase == .active { live.connect() }
        }
        .task(id: "\(store.isReferenceMode):\(live.session?.accountID ?? "none"):\(live.session?.authenticated == true)") {
            guard !store.isReferenceMode else { return }
            if live.session?.authenticated == true {
                await purchases.load()
                guard !Task.isCancelled, !store.isReferenceMode else { return }
                await NativePush.shared.foreground()
            } else { purchases.retire() }
        }
        .onChange(of: store.screen) { _, _ in
            if !store.isReferenceMode { live.persistLibraryState() }
            if UIAccessibility.isVoiceOverRunning { UIAccessibility.post(notification: .screenChanged, argument: nil) }
        }
        .onChange(of: live.busy) { _, busy in if !store.isReferenceMode, !busy { NativePush.shared.routePending() } }
        .onOpenURL { if !store.isReferenceMode { live.openLink($0) } }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in if !store.isReferenceMode, let url = activity.webpageURL { live.openLink(url) } }
        .sheet(item: $live.sharedFile, onDismiss: { live.retireSharedFile() }) { item in NativeSystemShare(url: item.url) { live.retireSharedFile() } }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("LoveliesAccountRetired"))) { _ in purchases.retire() }
        .onChange(of: scenePhase) { _, phase in
            foregroundRefresh?.cancel()
            guard !store.isReferenceMode else { return }
            if phase != .active { live.background(scheduleRetry: phase == .background) }
            else { resumeConnectedApp() }
        }
        .onChange(of: store.isReferenceMode) { _, reference in
            foregroundRefresh?.cancel()
            if reference {
                purchases.suspend()
                NativePush.shared.suspend()
                live.background()
            } else {
                attachConnectedServices()
                if scenePhase == .active { resumeConnectedApp() }
            }
        }
        .alert("Lovelies reference review", isPresented: $store.showDemoNotice) {
            Button("Explore the screens", role: .cancel) {}
        } message: {
            Text("Reference review mode uses sample photos and people. Its actions are local fixtures and send no data. The connected app uses its real backend separately. Use Return to connected app in the screen gallery to leave reference review.")
        }
    }
    private var referenceStatus: some View {
        Text(String.localizedStringWithFormat(NSLocalizedString("Preview · %lld of 48", comment: "Reference screen position"), store.screen.id))
            .font(.caption).foregroundStyle(LoveliesTheme.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
    private var referenceGalleryButton: some View {
        Button { store.showGallery = true } label: {
            Label("Screen gallery", systemImage: "xmark")
                .font(.subheadline).multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true).frame(minHeight: 44)
        }.accessibilityLabel("Close preview and open screen gallery")
    }
    private func attachConnectedServices() {
        purchases.attach(live)
        NativePush.shared.attach(live)
    }
    private func resumeConnectedApp() {
        live.foreground()
        foregroundRefresh = Task {
            guard !Task.isCancelled, !store.isReferenceMode else { return }
            await NativePush.shared.foreground()
            guard !Task.isCancelled, !store.isReferenceMode else { return }
            try? await purchases.refreshEntitlement()
        }
    }
    @ViewBuilder private var route: some View {
        switch store.screen.rawValue {
        case 1...9: OnboardingViews(screen: store.screen)
        case 10...18: GalleryViews(screen: store.screen)
        case 19...24: UploadViews(screen: store.screen)
        case 25...36: SharingViews(screen: store.screen)
        default: SettingsViews(screen: store.screen)
        }
    }
}

struct ScreenGalleryView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    @State private var query = ""
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("All 48 reference screens. Choosing a selection screen loads its screenshot's sample selections; editing a review keeps your changes.")
                        .font(.subheadline).foregroundStyle(LoveliesTheme.secondary)
                }
                ForEach(Screen.allCases.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || String($0.id).contains(query) }) { screen in
                    Button { store.jump(screen) } label: {
                        HStack(spacing: 14) {
                            Text(String(format: "%02d", screen.id)).font(.system(.body, design: .monospaced)).foregroundStyle(LoveliesTheme.pink)
                            Text(screen.title).foregroundStyle(.white)
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(LoveliesTheme.secondary)
                        }.padding(.vertical, 6)
                    }
                    .listRowBackground(LoveliesTheme.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(LoveliesTheme.canvas)
            .navigationTitle("Screen gallery")
            .searchable(text: $query, prompt: "Find a screen")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { store.showGallery = false } } }
            .toolbar { ToolbarItem(placement: .bottomBar) { Button("Return to connected app") { store.isReferenceMode = false; store.showGallery = false; store.go(live.session?.authenticated == true ? .home : .photoAccessPrompt, replace: true, simulateProgress: false) } } }
        }
        .preferredColorScheme(.dark)
    }
}

// One stable status and one stable gallery button; only their placement changes.
private struct ReferenceBannerLayout: Layout {
    var layoutDirection: LayoutDirection
    private let minimumHorizontalGap: CGFloat = 28

    private struct Arrangement {
        var width: CGFloat
        var horizontal: Bool
        var childProposal: ProposedViewSize
        var status: CGSize
        var gallery: CGSize
        var height: CGFloat { horizontal ? max(status.height, gallery.height) : status.height + gallery.height }
    }

    private func arrangement(width: CGFloat?, subviews: Subviews) -> Arrangement {
        let statusIdeal = subviews[0].sizeThatFits(.unspecified)
        let galleryIdeal = subviews[1].sizeThatFits(.unspecified)
        let idealWidth = statusIdeal.width + minimumHorizontalGap + galleryIdeal.width
        let available = width.flatMap { $0.isFinite ? max(0, $0) : nil } ?? idealWidth
        let horizontal = idealWidth <= available
        let childProposal: ProposedViewSize = horizontal ? .unspecified : ProposedViewSize(width: available, height: nil)
        return Arrangement(width: available, horizontal: horizontal, childProposal: childProposal,
            status: horizontal ? statusIdeal : subviews[0].sizeThatFits(childProposal),
            gallery: horizontal ? galleryIdeal : subviews[1].sizeThatFits(childProposal))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let measured = arrangement(width: proposal.width, subviews: subviews)
        return CGSize(width: measured.width, height: measured.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let measured = arrangement(width: bounds.width, subviews: subviews)
        let rightToLeft = layoutDirection == .rightToLeft
        let leadingX = rightToLeft ? bounds.maxX : bounds.minX
        let trailingX = rightToLeft ? bounds.minX : bounds.maxX
        let leadingAnchor = rightToLeft ? CGFloat(1) : 0
        let trailingAnchor = rightToLeft ? CGFloat(0) : 1
        if measured.horizontal {
            subviews[0].place(at: CGPoint(x: leadingX, y: bounds.midY),
                anchor: UnitPoint(x: leadingAnchor, y: 0.5), proposal: measured.childProposal)
            subviews[1].place(at: CGPoint(x: trailingX, y: bounds.midY),
                anchor: UnitPoint(x: trailingAnchor, y: 0.5), proposal: measured.childProposal)
        } else {
            subviews[0].place(at: CGPoint(x: leadingX, y: bounds.minY),
                anchor: UnitPoint(x: leadingAnchor, y: 0), proposal: measured.childProposal)
            subviews[1].place(at: CGPoint(x: trailingX, y: bounds.minY + measured.status.height),
                anchor: UnitPoint(x: trailingAnchor, y: 0), proposal: measured.childProposal)
        }
    }
}
