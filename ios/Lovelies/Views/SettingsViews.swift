import SwiftUI

struct SettingsViews: View {
    @EnvironmentObject private var store: DemoStore
    @Environment(\.dynamicTypeSize) private var textSize
    @ScaledMetric(relativeTo: .body) private var storageChartScale: CGFloat = 1
    let screen: Screen
    @State private var sheet: SettingsSheet?
    @State private var profileTab = "Photos"
    @State private var faceIndex = 0
    @State private var peopleTab = "Allowed"
    @State private var name = ""
    @State private var bio = ""
    @State private var editedValue = ""
    @State private var helpQuery = ""
    @State private var article = "Getting Started"
    @State private var showSignOut = false
    @State private var showDelete = false
    @State private var message: String?
    private enum SettingsSheet: String, Identifiable {
        case editProfile, faceTips, managePerson, findMe, visibility
        case storage, export, helpArticle, email, phone, password, twoFactor, devices
        var id: String { rawValue }
    }

    var body: some View {
        content
            .sheet(item: $sheet) { value in settingsSheet(value) }
            .alert("Frontend preview", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("Done", role: .cancel) { message = nil }
            } message: { Text(message ?? "") }
            .alert("Sign out of this preview?", isPresented: $showSignOut) {
                Button("Cancel", role: .cancel) {}
                Button("Sign Out") { store.history = []; store.go(.signIn, replace: true) }
            } message: { Text("This returns to the sign-in screen. No real account session is connected.") }
            .alert("Reset this demo account?", isPresented: $showDelete) {
                Button("Cancel", role: .cancel) {}
                Button("Reset demo", role: .destructive) {
                    store.profileName = "Jasmine"; store.profileBio = "Here for the good photos\nand great company ✨"
                    store.captures = 0; store.history = []; store.go(.signIn, replace: true)
                }
            } message: { Text("Only the local profile preview will reset. No real account or photos will be deleted.") }
    }

    @ViewBuilder private var content: some View {
        switch screen {
        case .profile: profile
        case .faceManagement: faceManagement
        case .allowedPeople: allowedPeople
        case .privacy: privacy
        case .photoAccessSettings: photoAccess
        case .notificationSettings: notificationSettings
        case .storage: storage
        case .exportData: exportData
        case .help: help
        case .security: security
        case .noMatches: noMatches
        default: offline
        }
    }

    private var profile: some View {
        GeometryReader { geometry in
            ScrollView {
            ZStack {
                GlowBackground()
                VStack(spacing: 12) {
                    HStack { Spacer(); OverflowMenu() }.padding(.horizontal, 20).padding(.top, 1)
                    Button { beginProfileEdit() } label: {
                        Avatar(asset: "person01", size: 148)
                            .overlay(alignment: .bottomTrailing) { Image(systemName: "pencil").font(.system(size: 18)).foregroundStyle(.black).frame(width: 44, height: 44).background(LoveliesTheme.pink, in: Circle()).offset(x: -4, y: -3) }
                    }.accessibilityLabel("Edit profile photo").padding(.top, -25)
                    Text(store.profileName).loveliesFont(size: 24, weight: .medium)
                    Text(store.profileBio).loveliesFont(size: 16).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center).lineSpacing(2)
                    HStack {
                        profileStatistic("248", title: String(localized: "Photos")) { store.go(.allPhotos) }
                        profileStatistic("36", title: String(localized: "Matches")) { store.go(.matchedPhotos) }
                        profileStatistic("\(store.matchedPeople.count)", title: String(localized: "People")) { store.go(.allowedPeople) }
                    }.padding(.vertical, 9)
                    PinkButton(title: String(localized: "Edit Profile")) { beginProfileEdit() }.padding(.horizontal, 22)
                    HStack {
                        profileTabButton("Photos", icon: "square.grid.3x3")
                        profileTabButton("Favorites", icon: "heart")
                        profileTabButton("People", icon: "person")
                    }.padding(.horizontal, 24)
                    VStack {
                        if profileTab == "People" {
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 17) {
                                ForEach(store.people) { person in
                                    Button { store.openPerson(person) } label: { VStack(spacing: 8) { Avatar(asset: person.asset, size: 77); Text(person.name).loveliesFont(size: 14) } }.buttonStyle(LoveliesPressStyle())
                                }
                            }.padding(.horizontal, 17).padding(.bottom, 80)
                        } else {
                            if profileTab == "Photos", SourceReferenceCatalog.layout(37) != nil {
                                SourcePhotoGrid(route: 37) { store.openPhoto($0) }.padding(.horizontal, 12).padding(.bottom, 80)
                            } else {
                                MasonryPhotos(photos: profilePhotos) { store.openPhoto($0) }.padding(.horizontal, 12).padding(.bottom, 80)
                            }
                        }
                    }.scrollIndicators(.hidden)
                }.foregroundStyle(.white)
                    .overlay(alignment: .bottom) { BottomNavigation(active: .profile, compact: true) }
            }
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }
    private var profilePhotos: [DemoPhoto] {
        let values = [1, 4, 7, 16, 11, 3, 5, 13, 17, 12, 9, 2].map { DemoPhoto.all[$0 - 1] }
        return profileTab == "Favorites" ? values.filter { store.favoriteIDs.contains($0.id) } : values
    }
    private func profileStatistic(_ value: String, title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { VStack(spacing: 4) { Text(value).loveliesFont(size: 20, weight: .semibold); Text(title).loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary) }.frame(maxWidth: .infinity) }.buttonStyle(LoveliesPressStyle())
    }
    private func profileTabButton(_ title: String, icon: String) -> some View {
        Button { profileTab = title } label: {
            Image(systemName: icon).font(.system(size: 24, weight: .light)).foregroundStyle(profileTab == title ? LoveliesTheme.pink : .white)
                .frame(maxWidth: .infinity).frame(minHeight: 44).background(profileTab == title ? LoveliesTheme.surface : .clear, in: Capsule())
        }.buttonStyle(LoveliesPressStyle()).accessibilityLabel(Text(LocalizedStringKey(title))).accessibilityAddTraits(profileTab == title ? .isSelected : [])
    }
    private func beginProfileEdit() { name = store.profileName; bio = store.profileBio; sheet = .editProfile }

    private var faceManagement: some View {
        GeometryReader { geometry in
            ScrollView {
            VStack(spacing: 17) {
                PageHeader(title: String(localized: "Manage Your Face"), trailing: false)
                Text("Help Lovelies find you in photos\nacross your matches.").loveliesFont(size: 17).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                if let camera = SourceReferenceCatalog.layout(38)?.cameraAsset {
                    AssetImage(name: camera).scaledToFit().frame(width: geometry.size.width * 0.687).clipShape(RoundedRectangle(cornerRadius: 19))
                        .accessibilityLabel(String(localized: "Sample face \(faceIndex + 1)"))
                } else {
                    AssetImage(name: "portrait").scaledToFill().scaleEffect(1 + CGFloat(faceIndex) * 0.05).frame(width: geometry.size.width * 0.74, height: geometry.size.height * 0.38).clipped().clipShape(RoundedRectangle(cornerRadius: 19))
                        .accessibilityLabel(String(localized: "Sample face \(faceIndex + 1)"))
                }
                if SourceReferenceCatalog.layout(38) != nil {
                    SourcePhotoGrid(route: 38, selection: [faceIndex + 1], outlineSelection: true) { faceIndex = max(0, min(3, $0.id - 1)) }.padding(.vertical, 3)
                } else {
                    HStack(spacing: 12) {
                        ForEach(0..<4) { index in
                            Button { faceIndex = index } label: {
                                AssetImage(name: "portrait").scaledToFill().scaleEffect(1 + CGFloat(index) * 0.08).frame(width: 70, height: 72).clipped().clipShape(RoundedRectangle(cornerRadius: 17))
                                    .overlay(RoundedRectangle(cornerRadius: 17).stroke(faceIndex == index ? LoveliesTheme.pink : .clear, lineWidth: 2))
                            }.buttonStyle(LoveliesPressStyle()).accessibilityLabel("Sample face \(index + 1)")
                        }
                    }
                    .padding(.vertical, 3)
                }
                Spacer(minLength: 0)
                PinkButton(title: String(localized: "Replace Face")) { store.captures = 0; store.go(.faceEnrollment) }
                GroupSurface { SettingsRow(icon: "lightbulb", title: String(localized: "Tips for best results")) { sheet = .faceTips } }.padding(.bottom, 15)
            }.padding(.horizontal, 21).foregroundStyle(.white)
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }

    private var allowedPeople: some View {
        VStack(spacing: 15) {
            HStack {
                Button { store.back() } label: { Image(systemName: "chevron.left").font(.system(size: 22)).frame(width: 44, height: 44) }.accessibilityLabel("Back")
                Text("Manage People").loveliesFont(size: 21, weight: .semibold)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity).accessibilityAddTraits(.isHeader)
                Color.clear.frame(width: 44, height: 44)
            }.padding(.horizontal, 15)
            Text("Every matched person is allowed unless you block them. You still review each photo and recipient before sharing.")
                .loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 22)
            HStack(spacing: 0) {
                peopleSegment("Allowed", count: store.allowedPeople.count)
                peopleSegment("Blocked", count: store.blockedPeople.count)
            }.background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 14)).padding(.horizontal, 20)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(peopleTab == "Blocked" ? store.blockedPeople : store.allowedPeople) { person in
                        Button { store.currentPerson = person; sheet = .managePerson } label: {
                            HStack(spacing: 15) {
                                Avatar(asset: person.asset, size: 43)
                                Text(person.fullName).loveliesFont(size: 14).fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                                Text(peopleTab == "Blocked" ? String(localized: "Blocked") : String(localized: "Can share with")).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary)
                                    .multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
                                Image(systemName: "chevron.right").font(.system(size: 14)).foregroundStyle(LoveliesTheme.secondary)
                            }.padding(.vertical, 11).contentShape(Rectangle())
                        }.buttonStyle(LoveliesPressStyle())
                        Divider().overlay(.white.opacity(0.04))
                    }
                }.padding(.horizontal, 22)
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }
    private func peopleSegment(_ title: String, count: Int) -> some View {
        Button { peopleTab = title } label: {
            Text("\(NSLocalizedString(title, comment: "App-owned people segment")) (\(count))").loveliesFont(size: 15, weight: peopleTab == title ? .medium : .regular).foregroundStyle(peopleTab == title ? .black : .white)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
                .background(peopleTab == title ? LoveliesTheme.pink : .clear, in: RoundedRectangle(cornerRadius: 14))
        }.buttonStyle(LoveliesPressStyle()).accessibilityAddTraits(peopleTab == title ? .isSelected : [])
    }

    private var privacy: some View {
        VStack(spacing: 16) {
            PageHeader(title: String(localized: "Privacy & Sharing"), trailing: false)
            ScrollView {
                VStack(spacing: 15) {
                    GroupSurface {
                        SettingsRow(icon: "person.crop.circle.badge.checkmark", title: String(localized: "Who can find you"), subtitle: NSLocalizedString(store.findability, comment: "App-owned findability option")) { sheet = .findMe }
                        insetDivider
                        SettingsRow(icon: "camera", title: String(localized: "Photo visibility"), subtitle: NSLocalizedString(store.visibility, comment: "App-owned photo visibility option")) { sheet = .visibility }
                        insetDivider
                        preferenceRow("Allow others to save", icon: "square.and.arrow.down")
                        insetDivider
                        preferenceRow("Show location info", icon: "mappin.and.ellipse")
                        insetDivider
                        preferenceRow("Show in suggestions", icon: "star")
                        insetDivider
                        preferenceRow("Analytics", icon: "chart.bar", subtitle: "Help us improve Lovelies")
                    }
                    HStack(spacing: 18) {
                        Image(systemName: "checkmark.shield").font(.system(size: 42, weight: .light)).foregroundStyle(LoveliesTheme.pink).shadow(color: LoveliesTheme.pink.opacity(0.6), radius: 10).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Your privacy matters").loveliesFont(size: 16, weight: .medium).foregroundStyle(LoveliesTheme.pink.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
                            Text("You choose each photo and recipient\nbefore sharing.").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Spacer(minLength: 0)
                    }.padding(17).background(LoveliesTheme.pink.opacity(0.07), in: RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(LoveliesTheme.pink.opacity(0.35), lineWidth: 1))
                }.padding(.horizontal, 20).padding(.bottom, 15)
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }

    private var photoAccess: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 17) {
                    PageHeader(title: String(localized: "Photo Access"), trailing: false)
                    Spacer(minLength: 0)
                    PhotoHeart(size: 185).accessibilityHidden(true)
                    Text("Lovelies needs access to your\nphotos to find people in them.").loveliesFont(size: 17).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: 3) {
                        ForEach(AccessMode.allCases, id: \.self) { mode in
                            Button { store.access = mode } label: {
                                HStack(spacing: 17) {
                                    CheckBadge(selected: store.access == mode, size: 30).accessibilityHidden(true)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(LocalizedStringKey(mode.rawValue)).loveliesFont(size: 16, weight: .medium).fixedSize(horizontal: false, vertical: true)
                                        Text(mode == .all ? String(localized: "Access to your entire library") : mode == .albums ? String(localized: "Choose specific albums") : String(localized: "Allow only certain photos")).loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                    Circle().stroke(store.access == mode ? LoveliesTheme.pink : .white.opacity(0.6), lineWidth: store.access == mode ? 5 : 1.3).frame(width: 25, height: 25).accessibilityHidden(true)
                                }.padding(16).frame(minHeight: 81).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 15))
                                    .overlay(RoundedRectangle(cornerRadius: 15).stroke(store.access == mode ? LoveliesTheme.pink.opacity(0.5) : .clear, lineWidth: 1))
                            }.buttonStyle(LoveliesPressStyle()).accessibilityAddTraits(store.access == mode ? .isSelected : [])
                        }
                    }
                    Spacer(minLength: 0)
                    PinkButton(title: String(localized: "Continue")) { store.go(.profile) }.padding(.bottom, 14)
                }.padding(.horizontal, 22).frame(minHeight: geometry.size.height)
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }

    private var notificationSettings: some View {
        VStack(spacing: 15) {
            PageHeader(title: String(localized: "Notifications"), trailing: false)
            ScrollView {
                GroupSurface {
                    preferenceRow("New Matches", icon: "heart", subtitle: "When you're matched in photos")
                    insetDivider
                    preferenceRow("Messages", icon: "bubble.left", subtitle: "When you receive a message")
                    insetDivider
                    preferenceRow("Mentions", icon: "at", subtitle: "When someone mentions you")
                    insetDivider
                    preferenceRow("Tips & Features", icon: "lightbulb", subtitle: "Product updates and tips")
                    insetDivider
                    preferenceRow("Reminders", icon: "bell", subtitle: "Friendly nudges")
                    insetDivider
                    preferenceRow("Marketing", icon: "megaphone", subtitle: "Special offers (optional)")
                }.padding(.horizontal, 21).padding(.bottom, 15)
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }
    private func preferenceRow(_ title: String, icon: String, subtitle: String? = nil) -> some View {
        Toggle(isOn: store.preference(title)) {
            HStack(alignment: .top, spacing: 15) {
                Image(systemName: icon).font(.system(size: 23, weight: .light)).frame(width: 27).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(LocalizedStringKey(title)).loveliesFont(size: 16).fixedSize(horizontal: false, vertical: true)
                    if let subtitle {
                        Text(LocalizedStringKey(subtitle)).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityLabel(Text(LocalizedStringKey(title)))
        .accessibilityHint(Text(LocalizedStringKey(subtitle ?? "")))
        .frame(minHeight: 44)
        .tint(LoveliesTheme.pink).padding(.horizontal, 16).padding(.vertical, subtitle == nil ? 17 : 21)
    }
    private var insetDivider: some View { Divider().overlay(.white.opacity(0.025)).padding(.leading, 57) }

    private var storage: some View {
        GeometryReader { geometry in
            let chartSize = min(max(0, geometry.size.width - 48), min(190, geometry.size.width * 0.431) * storageChartScale)
            ScrollView {
            VStack(spacing: 20) {
                PageHeader(title: String(localized: "Storage"), trailing: false)
                Spacer(minLength: 0)
                VStack(spacing: 16) {
                    storageDonut.frame(width: chartSize, height: chartSize)
                    if textSize.isAccessibilitySize { storageUsage }
                }.accessibilityElement(children: .combine)
                Spacer(minLength: 0)
                VStack(spacing: 21) {
                    storageRow(String(localized: "Photos"), amount: "1.8 GB", color: LoveliesTheme.pink)
                    storageRow(String(localized: "Matches"), amount: "420 MB", color: Color(red: 0.68, green: 0.51, blue: 0.96))
                    storageRow(String(localized: "Cache"), amount: store.cacheCleared ? "0 MB" : "180 MB", color: Color(red: 0.95, green: 0.92, blue: 0.8))
                    storageRow(String(localized: "Other"), amount: "60 MB", color: Color(red: 0.85, green: 0.82, blue: 0.73))
                }
                PinkButton(title: String(localized: "Manage Storage")) { sheet = .storage }.padding(.top, 9).padding(.bottom, 15)
            }.padding(.horizontal, 24).foregroundStyle(.white)
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }
    private var storageDonut: some View {
        ZStack {
            Circle().stroke(.white.opacity(0.07), lineWidth: 21)
            Circle().trim(from: 0, to: 0.62).stroke(LoveliesTheme.pink, lineWidth: 21).rotationEffect(.degrees(-90))
            Circle().trim(from: 0.635, to: 0.9).stroke(Color(red: 0.68, green: 0.51, blue: 0.96), lineWidth: 21).rotationEffect(.degrees(-90))
            Circle().trim(from: 0.915, to: 0.978).stroke(Color(red: 0.95, green: 0.92, blue: 0.8), lineWidth: 21).rotationEffect(.degrees(-90))
            if !textSize.isAccessibilitySize { storageUsage }
        }.shadow(color: LoveliesTheme.pink.opacity(0.09), radius: 16)
    }
    private var storageUsage: some View {
        VStack(spacing: 5) {
            Text(store.cacheCleared ? "2.2 GB" : "2.4 GB").loveliesFont(size: 26, weight: .medium)
            Text("of 5 GB used").loveliesFont(size: 16).foregroundStyle(LoveliesTheme.secondary)
        }.multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
    }
    private func storageRow(_ title: String, amount: String, color: Color) -> some View {
        HStack(spacing: 13) { Circle().fill(color).frame(width: 18, height: 18); Text(title).loveliesFont(size: 16); Spacer(); Text(amount).loveliesFont(size: 15).foregroundStyle(LoveliesTheme.secondary) }
    }

    private var exportData: some View {
        GeometryReader { geometry in
            ScrollView {
            VStack(spacing: 19) {
                PageHeader(title: String(localized: "Export Your Data"), trailing: false)
                Spacer(minLength: 0)
                ZStack { Image(systemName: "doc").font(.system(size: 91, weight: .ultraLight)); Image(systemName: "arrow.down").font(.system(size: 37, weight: .light)).offset(y: 8) }
                    .foregroundStyle(LoveliesTheme.pink).shadow(color: LoveliesTheme.pink.opacity(0.5), radius: 16).frame(height: 112)
                Text("Download a copy of your\nphotos, matches and profile data.").loveliesFont(size: 17).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                GroupSurface {
                    HStack(alignment: .top, spacing: 18) {
                        Image(systemName: "lightbulb").font(.system(size: 27, weight: .light)).padding(.top, 3)
                        VStack(alignment: .leading, spacing: 11) {
                            Text("Your data, your choice").loveliesFont(size: 16, weight: .medium)
                            ForEach([String(localized: "Photos you've shared"), String(localized: "Your matches and messages"), String(localized: "Profile information"), String(localized: "Settings and preferences")], id: \.self) { title in
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: "checkmark").accessibilityHidden(true)
                                    Text(title).fixedSize(horizontal: false, vertical: true)
                                }.loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }.padding(23)
                }
                Spacer(minLength: 0)
                PinkButton(title: String(localized: "Request Export")) { sheet = .export }.padding(.bottom, 15)
            }.padding(.horizontal, 23).foregroundStyle(.white)
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }

    private var help: some View {
        VStack(spacing: 10) {
            PageHeader(title: String(localized: "Help Center"), trailing: false)
            HStack(spacing: 11) {
                Image(systemName: "magnifyingglass").foregroundStyle(LoveliesTheme.secondary).accessibilityHidden(true)
                TextField("Search for help...", text: $helpQuery, prompt: Text("Search for help...").foregroundColor(LoveliesTheme.secondary))
                    .loveliesFont(size: 15).submitLabel(.search)
                    .frame(minHeight: 44).contentShape(Rectangle())
                    .accessibilityLabel(String(localized: "Search for help..."))
            }.padding(14).background(LoveliesTheme.raised, in: RoundedRectangle(cornerRadius: 12)).padding(.horizontal, 20)
            ScrollView {
                GroupSurface {
                    ForEach(filteredHelpTopics, id: \.0) { topic in
                        SettingsRow(icon: topic.2, title: NSLocalizedString(topic.0, comment: "App-owned help topic"), subtitle: NSLocalizedString(topic.1, comment: "App-owned help topic description")) { article = topic.0; sheet = .helpArticle }
                        insetDivider
                    }
                }.padding(.horizontal, 20).padding(.bottom, 12)
                if !helpQuery.isEmpty, filteredHelpTopics.isEmpty { Text("No help topics found. Try photos, privacy or account.").loveliesFont(size: 15).foregroundStyle(LoveliesTheme.secondary).padding(22) }
            }.scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
        }.foregroundStyle(.white)
    }
    private var filteredHelpTopics: [(String, String, String)] {
        helpTopics.filter { topic in
            helpQuery.isEmpty ||
            topic.0.localizedCaseInsensitiveContains(helpQuery) ||
            topic.1.localizedCaseInsensitiveContains(helpQuery) ||
            NSLocalizedString(topic.0, comment: "App-owned help topic").localizedCaseInsensitiveContains(helpQuery) ||
            NSLocalizedString(topic.1, comment: "App-owned help topic description").localizedCaseInsensitiveContains(helpQuery)
        }
    }
    private var helpTopics: [(String, String, String)] { [("Getting Started", "Learn the basics", "shield.lefthalf.filled"), ("Your Photos", "Uploading, matching and more", "photo"), ("Privacy & Safety", "Keeping your data safe", "checkmark.shield"), ("Account & Settings", "Manage your account", "gearshape"), ("Troubleshooting", "Fix common issues", "questionmark.circle"), ("Contact Support", "We're here to help", "bubble.left.and.bubble.right")] }

    private var security: some View {
        VStack(spacing: 16) {
            PageHeader(title: String(localized: "Account & Security"), trailing: false)
            ScrollView {
                VStack(spacing: 16) {
                    GroupSurface {
                        SettingsRow(icon: "envelope", title: String(localized: "Email"), value: store.email) { editedValue = store.email; sheet = .email }
                        insetDivider
                        SettingsRow(icon: "iphone", title: String(localized: "Phone"), value: store.phone) { editedValue = store.phone; sheet = .phone }
                        insetDivider
                        SettingsRow(icon: "lock", title: String(localized: "Password"), value: "••••••••") { editedValue = ""; sheet = .password }
                        insetDivider
                        SettingsRow(icon: "checkmark.shield", title: String(localized: "Two-Factor Authentication"), value: store.twoFactor ? String(localized: "On") : String(localized: "Off")) { sheet = .twoFactor }
                        insetDivider
                        SettingsRow(icon: "laptopcomputer", title: String(localized: "Active Devices"), value: String(localized: "\(store.activeDevices.count) devices")) { sheet = .devices }
                    }
                    GroupSurface {
                        SettingsRow(icon: "rectangle.portrait.and.arrow.right", title: String(localized: "Sign Out"), tint: Color(red: 1, green: 0.38, blue: 0.5)) { showSignOut = true }
                        insetDivider
                        SettingsRow(icon: "trash", title: String(localized: "Delete Account"), tint: Color(red: 1, green: 0.38, blue: 0.5)) { showDelete = true }
                    }
                }.padding(.horizontal, 21).padding(.bottom, 15)
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }

    private var noMatches: some View {
        GeometryReader { geometry in
            ScrollView {
            VStack(spacing: 20) {
                PageHeader(title: String(localized: "Matches"), trailing: false)
                Spacer().frame(height: geometry.size.height * 0.04)
                AssetImage(name: "empty-hero").scaledToFit().frame(width: min(260, geometry.size.width * 0.598)).accessibilityHidden(true)
                Text("No Matches Yet").loveliesFont(size: 25, weight: .medium).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).padding(.top, 10)
                Text("Your people are out there.\nKeep sharing your photos\nand we'll find them!").loveliesFont(size: 17).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 15)
                PinkButton(title: String(localized: "Keep Exploring")) { store.go(.home) }.padding(.bottom, 28)
            }.padding(.horizontal, 34).frame(maxWidth: .infinity).foregroundStyle(.white)
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }

    private var offline: some View {
        GeometryReader { geometry in
            ScrollView {
            VStack(spacing: 20) {
                PageHeader(title: String(localized: "Connection"), trailing: false)
                Spacer().frame(height: geometry.size.height * 0.04)
                AssetImage(name: "offline-hero").scaledToFit().frame(width: min(250, geometry.size.width * 0.504)).accessibilityHidden(true)
                Text("You're Offline").loveliesFont(size: 25, weight: .medium)
                Text("Check your connection\nand try again.").loveliesFont(size: 17).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                Spacer(minLength: 20)
                PinkButton(title: String(localized: "Try Again")) { store.go(.home) }
                Button { store.back() } label: { Text("Go Back").loveliesFont(size: 15).underline().foregroundStyle(LoveliesTheme.secondary).padding(13).frame(minHeight: 44) }.padding(.bottom, 15)
            }.padding(.horizontal, 30).frame(maxWidth: .infinity).foregroundStyle(.white)
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }

    @ViewBuilder private func settingsSheet(_ value: SettingsSheet) -> some View {
        switch value {
        case .editProfile:
            DemoSheet(title: String(localized: "Edit Profile")) {
                Avatar(asset: "person01", size: 92)
                TextField("Name", text: $name).textFieldStyle(.roundedBorder).textContentType(.name)
                TextField("About you", text: $bio, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(2...4)
                PinkButton(title: String(localized: "Save Profile"), enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty) { store.profileName = name.trimmingCharacters(in: .whitespaces); store.profileBio = bio; sheet = nil }
            }
        case .faceTips:
            DemoSheet(title: String(localized: "Tips for best results")) {
                Label("Use bright, even lighting", systemImage: "sun.max")
                Label("Keep your whole face in the frame", systemImage: "face.smiling")
                Label("Look straight, then left and right", systemImage: "arrow.left.and.right")
                Text("The shutter in this preview collects three sample steps from an included photo. Camera access and face processing are not connected.").font(.subheadline).foregroundStyle(LoveliesTheme.secondary)
                PinkButton(title: String(localized: "Try the three captures")) { sheet = nil; store.captures = 0; store.go(.faceEnrollment) }
            }
        case .managePerson:
            DemoSheet(title: store.currentPerson.fullName) {
                Avatar(asset: store.currentPerson.asset, size: 85)
                Text(store.blockedIDs.contains(store.currentPerson.id) ? String(localized: "This person is excluded from future matching and sharing. Unblocking allows future eligibility; it does not restore past access or add them to your current selection.") : String(localized: "This matched person can share with you. Photo access still needs your review and approval. Blocking excludes them from future matching and sharing.")).foregroundStyle(LoveliesTheme.secondary)
                PinkButton(title: store.blockedIDs.contains(store.currentPerson.id) ? String(localized: "Unblock Person") : String(localized: "Block Person")) {
                    let id = store.currentPerson.id
                    store.setBlocked(id, blocked: !store.blockedIDs.contains(id))
                    sheet = nil
                }
                if store.currentPerson.matches > 0 { QuietButton(title: String(localized: "View Matched Photos")) { sheet = nil; store.go(.personPhotos) } }
            }
        case .findMe:
            DemoSheet(title: String(localized: "Who can find you")) {
                Text("Finding you never grants access to your photos. You choose every photo and recipient before sharing.").loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary)
                choiceList(["Anyone", "Only people you're matched with", "Nobody"], selected: store.findability) { store.findability = $0; sheet = nil }
            }
        case .visibility:
            DemoSheet(title: String(localized: "Photo visibility")) {
                choiceList(["Matched people only", "Allowed people", "Only me"], selected: store.visibility) { store.visibility = $0; sheet = nil }
            }
        case .storage:
            DemoSheet(title: String(localized: "Manage Storage")) {
                Text("Sample library: 1.8 GB of photos and 420 MB of matches.").foregroundStyle(LoveliesTheme.secondary)
                SettingsRow(icon: "trash", title: String(localized: "Clear cached previews"), value: store.cacheCleared ? "0 MB" : "180 MB") { store.cacheCleared = true; sheet = nil }
                Text("This updates the demo storage display. No device photos or files are removed.").font(.subheadline).foregroundStyle(LoveliesTheme.secondary)
                QuietButton(title: String(localized: "Review Photos")) { sheet = nil; store.go(.allPhotos) }
            }
        case .export:
            DemoSheet(title: String(localized: "Demo Export Ready")) {
                Image(systemName: "doc.badge.arrow.up").font(.system(size: 45)).foregroundStyle(LoveliesTheme.pink)
                Text("This preview can share a text summary of your sample profile and selections. A real account archive is not connected.").foregroundStyle(LoveliesTheme.secondary)
                ShareLink(item: String(localized: "Lovelies frontend demo\nProfile: \(store.profileName)\nBio: \(store.profileBio)\nSelected photos: \(store.sharePhotoIDs.sorted().map { String($0) }.joined(separator: ", "))\nSelected people: \(store.sharingPeople.map(\.name).joined(separator: ", "))\nNo real account, messages, photos or face data included.")) {
                    Label("Share Demo Summary", systemImage: "square.and.arrow.up").loveliesFont(size: 16, weight: .semibold).foregroundStyle(.black).frame(maxWidth: .infinity).padding(.vertical, 16).background(LoveliesTheme.pink, in: Capsule())
                }
            }
        case .helpArticle:
            DemoSheet(title: NSLocalizedString(article, comment: "App-owned help topic")) {
                Text(helpArticleText).loveliesFont(size: 17).lineSpacing(5)
                Text("This is a frontend preview. Sample captures, matching, uploads, sharing, sign-in and account settings stay local. Nothing is sent to a backend or another person.").loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary)
                PinkButton(title: article == "Contact Support" ? String(localized: "Return to Help") : String(localized: "Open this feature")) { sheet = nil; if article != "Contact Support" { store.go(helpDestination) } }
                QuietButton(title: String(localized: "Browse All 48 Screens")) { sheet = nil; store.showGallery = true }
            }
        case .email, .phone, .password:
            DemoSheet(title: value == .email ? String(localized: "Email") : value == .phone ? String(localized: "Phone") : String(localized: "Password")) {
                Text("Changes apply only to this local frontend preview.").foregroundStyle(LoveliesTheme.secondary)
                if value == .password { SecureField("New password", text: $editedValue).textFieldStyle(.roundedBorder) }
                else { TextField(value == .email ? String(localized: "Email address") : String(localized: "Phone number"), text: $editedValue).textFieldStyle(.roundedBorder).keyboardType(value == .email ? .emailAddress : .phonePad).textInputAutocapitalization(.never).autocorrectionDisabled() }
                PinkButton(title: String(localized: "Save"), enabled: value == .password ? editedValue.count >= 8 : !editedValue.trimmingCharacters(in: .whitespaces).isEmpty) {
                    if value == .email { store.email = editedValue }
                    if value == .phone { store.phone = editedValue }
                    sheet = nil
                    if value == .password { message = String(localized: "Sample password step completed. No account password was changed or stored.") }
                }
                if value == .password { Text("Use at least 8 characters for this sample step.").font(.subheadline).foregroundStyle(LoveliesTheme.secondary) }
            }
        case .twoFactor:
            DemoSheet(title: String(localized: "Two-Factor Authentication")) {
                Toggle("Enable two-factor authentication", isOn: $store.twoFactor).tint(LoveliesTheme.pink)
                Text("This switch previews the enabled and disabled interface states. Verification codes and account protection are not connected.").foregroundStyle(LoveliesTheme.secondary)
            }
        case .devices:
            DemoSheet(title: String(localized: "Active Devices")) {
                ForEach(store.activeDevices, id: \.self) { device in
                    HStack(spacing: 15) {
                        Image(systemName: device.contains("iPhone") ? "iphone" : device == "iPad" ? "ipad" : "laptopcomputer").font(.system(size: 27))
                        VStack(alignment: .leading, spacing: 5) { Text(device); Text(device.contains("iPhone") ? String(localized: "Current sample device") : String(localized: "Sample session")).font(.caption).foregroundStyle(LoveliesTheme.secondary) }
                        Spacer()
                        if !device.contains("iPhone") { Button("Remove") { store.activeDevices.removeAll { $0 == device } }.loveliesFont(size: 14).foregroundStyle(LoveliesTheme.pink) }
                    }.padding(.vertical, 10)
                }
                Text("Removing a sample device changes this preview list only.").font(.subheadline).foregroundStyle(LoveliesTheme.secondary)
            }
        }
    }
    private func choiceList(_ choices: [String], selected: String, action: @escaping (String) -> Void) -> some View {
        VStack(spacing: 14) {
            ForEach(choices, id: \.self) { choice in
                Button { action(choice) } label: { HStack { Text(LocalizedStringKey(choice)); Spacer(); if selected == choice { Image(systemName: "checkmark").foregroundStyle(LoveliesTheme.pink) } }.padding(.vertical, 10) }.buttonStyle(LoveliesPressStyle())
            }
        }
    }
    private var helpArticleText: String {
        switch article {
        case "Getting Started": return String(localized: "Join Lovelies, choose your photo access, and take three guided selfie steps. You can explore each screen from the gallery in the more menu.")
        case "Your Photos": return String(localized: "Add photos from a device, album, files or a camera preview. Select your favorites, review the upload and caption, then explore matched photos. Sharing always includes a photo and people review.")
        case "Privacy & Safety": return String(localized: "Choose who can find you and control saving, location information and suggestions. Every matched person is allowed unless you block them. You choose each photo and recipient before sharing.")
        case "Account & Settings": return String(localized: "Edit your profile, explore notification preferences, storage, export, sample devices and account settings.")
        case "Troubleshooting": return String(localized: "Retry a sample selfie, change the selected photos, or return to exploring from the no-matches and offline screens. Existing selections stay available when you edit a review.")
        default: return String(localized: "Support is a planned connected feature. You can inspect every current screen in this preview and share feedback with the project owner. No support message is sent by this screen.")
        }
    }
    private var helpDestination: Screen {
        switch article {
        case "Getting Started": return .introduction
        case "Your Photos": return .uploadEntry
        case "Privacy & Safety": return .privacy
        case "Account & Settings": return .security
        default: return .offline
        }
    }
}

private struct HeartOrbit: View {
    var body: some View {
        ZStack {
            ForEach(0..<29) { index in
                let angle = Double(index) * .pi * 2 / 29
                Circle().fill(LoveliesTheme.pink.opacity(index.isMultiple(of: 4) ? 0.45 : 0.9)).frame(width: index.isMultiple(of: 3) ? 6 : 4, height: index.isMultiple(of: 3) ? 6 : 4)
                    .offset(x: CGFloat(cos(angle)) * 100, y: CGFloat(sin(angle)) * 100)
            }
            Image(systemName: "heart.fill").font(.system(size: 66)).foregroundStyle(LoveliesTheme.pink).shadow(color: LoveliesTheme.pink.opacity(0.6), radius: 30)
        }
    }
}
