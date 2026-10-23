import SwiftUI

@main struct LoveliesApp: App {
    @StateObject private var store = DemoStore()
    var body: some Scene {
        WindowGroup {
            LoveliesRootView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .tint(LoveliesTheme.pink)
        }
    }
}

struct LoveliesRootView: View {
    @EnvironmentObject private var store: DemoStore
    var body: some View {
        ZStack {
            LoveliesTheme.canvas.ignoresSafeArea()
            route
                .id(store.screen)
                .transition(.opacity)
        }
        .sheet(isPresented: $store.showGallery) { ScreenGalleryView() }
        .alert("Lovelies frontend preview", isPresented: $store.showDemoNotice) {
            Button("Explore the screens", role: .cancel) {}
        } message: {
            Text("This clickable native prototype uses sample photos and people. Sign-in, three selfie captures, matching, upload, sharing and settings are simulated locally. No photos, face data or messages leave this app. Open the screen gallery from any ••• menu to review all 48 reference screens.")
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
        }
        .preferredColorScheme(.dark)
    }
}
