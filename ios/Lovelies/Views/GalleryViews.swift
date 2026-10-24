import SwiftUI

struct GalleryViews: View {
    @EnvironmentObject private var store: DemoStore
    let screen: Screen
    @State private var segment = "All"
    @State private var columns = 3
    @State private var filterTab = "People"
    @State private var filterSheet: FilterSheet?
    @State private var date = Date()
    @State private var location = ""
    @State private var showSampleVideo = false
    @State private var matchHighlights = SourceReferenceCatalog.selectedIDs(11) ?? [17, 5, 10, 16, 6]
    @State private var searchHighlights = SourceReferenceCatalog.selectedIDs(15) ?? [1, 4, 6]
    private enum FilterSheet: String, Identifiable { case date, location, people; var id: String { rawValue } }

    @ViewBuilder var body: some View {
        switch screen {
        case .home: home
        case .newMatches: newMatches
        case .photoViewer: photoViewer
        case .allPhotos: allPhotos
        case .favorites: favorites
        case .search: search
        case .filters: filters
        case .activity: activity
        default: notifications
        }
    }

    private var home: some View {
        VStack(spacing: 5) {
            HStack(spacing: 9) {
                Wordmark(width: 154)
                Spacer()
                circleCommand("magnifyingglass", label: String(localized: "Search")) { store.go(.search) }
                circleCommand("bell", label: String(localized: "Notifications")) { store.go(.notifications) }
            }.padding(.horizontal, 19).padding(.top, 4)
            HomeMosaicView().padding(.horizontal, 11).padding(.bottom, 65)
        }.safeAreaInset(edge: .bottom, spacing: 0) { BottomNavigation(active: .home) }
    }

    private var newMatches: some View {
        VStack(spacing: 8) {
            HStack {
                Button { store.go(.matchSummary) } label: {
                    HStack(spacing: 15) { Text("New Matches").loveliesFont(size: 21, weight: .semibold); Image(systemName: "chevron.right").font(.system(size: 16)) }.frame(minHeight: 44).contentShape(Rectangle())
                }
                Spacer()
                Button { store.go(.matchedPhotos) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44).background(.white.opacity(0.05), in: Circle()) }.accessibilityLabel("View all matches")
            }.padding(.horizontal, 20).padding(.top, 6)
            HStack(spacing: 12) {
                ForEach(Array([DemoPerson.all[0], DemoPerson.all[2], DemoPerson.all[6], DemoPerson.all[4]].enumerated()), id: \.offset) { index, person in
                    Button { store.openPerson(person) } label: {
                        Avatar(asset: person.asset, size: 66, pink: index < 3)
                            .overlay(alignment: .bottom) {
                                Text(index == 3 ? "+6" : ["24", "18", "12"][index]).loveliesFont(size: 14, weight: .semibold)
                                    .foregroundStyle(index == 3 ? .white : .black).padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(index == 3 ? LoveliesTheme.surface : LoveliesTheme.pink, in: Capsule()).offset(y: 6)
                            }
                    }.accessibilityLabel("\(person.name), new matched photos")
                }
                Spacer(minLength: 0)
            }.padding(.horizontal, 18).padding(.bottom, 9)
            ScrollView {
                if SourceReferenceCatalog.layout(11) != nil {
                    SourcePhotoGrid(route: 11, selection: matchHighlights, badge: .check, badgeAction: { photo in
                        if matchHighlights.contains(photo.id) { matchHighlights.remove(photo.id) } else { matchHighlights.insert(photo.id) }
                    }) { store.openPhoto($0) }.padding(.horizontal, 12).padding(.bottom, 76)
                } else {
                    MasonryPhotos(photos: [17, 5, 1, 10, 3, 7, 16, 4, 6, 8, 2, 11].map { DemoPhoto.all[$0 - 1] }, selected: [17, 5, 10, 16, 6], showOnlySelectedBadges: true) { store.openPhoto($0) }
                        .padding(.horizontal, 12).padding(.bottom, 76)
                }
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white).safeAreaInset(edge: .bottom, spacing: 0) { BottomNavigation(active: .newMatches) }
    }

    private var photoViewer: some View {
        GeometryReader { geometry in
            ZStack {
                AssetImage(name: store.currentPhoto.asset).scaledToFill().frame(width: geometry.size.width, height: geometry.size.height).clipped().ignoresSafeArea()
                    .accessibilityElement(children: .ignore).accessibilityLabel(Text("Photo \(store.currentPhoto.id)")).accessibilityAddTraits(.isImage)
                LinearGradient(colors: [.black.opacity(0.22), .clear, .black.opacity(0.35)], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
                VStack {
                    HStack {
                        Button { store.back() } label: { Image(systemName: "chevron.left").font(.system(size: 23)).frame(width: 44, height: 44) }.accessibilityLabel("Back")
                        Spacer()
                        OverflowMenu()
                    }.padding(.horizontal, 13)
                    Spacer()
                    HStack(spacing: 8) {
                        Button { store.go(.photoPeople) } label: {
                            HStack(spacing: -6) { Avatar(asset: "person05", size: 42, pink: true); Avatar(asset: "person03", size: 42) }
                        }.accessibilityLabel("People in this photo")
                        Button { store.go(.photoPeople) } label: { Text("+3").loveliesFont(size: 15).frame(width: 44, height: 44).background(.white.opacity(0.13), in: Circle()) }.accessibilityLabel("3 more people")
                        Spacer()
                        Button { store.toggleFavorite(store.currentPhoto.id) } label: {
                            Image(systemName: store.favoriteIDs.contains(store.currentPhoto.id) ? "heart.fill" : "heart").font(.system(size: 25))
                                .foregroundStyle(store.favoriteIDs.contains(store.currentPhoto.id) ? LoveliesTheme.pink : .white)
                                .frame(width: 47, height: 47).background(.black.opacity(0.4), in: Circle())
                        }.accessibilityLabel(store.favoriteIDs.contains(store.currentPhoto.id) ? String(localized: "Remove from favorites") : String(localized: "Add to favorites"))
                        Button { store.beginSharing(store.currentPhoto); store.go(.shareSelection) } label: {
                            Image(systemName: "square.and.arrow.up").font(.system(size: 23)).frame(width: 47, height: 47).background(.black.opacity(0.4), in: Circle())
                        }.accessibilityLabel("Share photo")
                    }.padding(11).background(.ultraThinMaterial, in: Capsule()).padding(.horizontal, 10).padding(.bottom, 4)
                }
            }.frame(width: geometry.size.width, height: geometry.size.height).foregroundStyle(.white)
        }
    }

    private var allPhotos: some View {
        VStack(spacing: 13) {
            HStack {
                Button { store.back() } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Back")
                Text("Photos").loveliesFont(size: 25, weight: .semibold).onLongPressGesture { store.showGallery = true }
                Spacer()
                Button { columns = columns == 3 ? 2 : 3 } label: { Image(systemName: "square.grid.2x2").font(.system(size: 23)).frame(width: 44, height: 44) }.accessibilityLabel("Change photo grid")
            }.padding(.horizontal, 23).padding(.top, 6)
            SegmentPills(values: ["All", "People", "Places", "Videos"], selected: $segment).padding(.horizontal, 19)
            ScrollView {
                if segment == "People" {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 15), count: 3), spacing: 22) {
                        ForEach(store.people) { person in
                            Button { store.openPerson(person) } label: {
                                VStack(spacing: 9) { Avatar(asset: person.asset, size: 89, pink: true); Text(person.name).loveliesFont(size: 15); Text(NativeCountCopy.text(.photos, person.matches)).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary) }
                            }
                        }
                    }.padding(.horizontal, 20).padding(.top, 10)
                } else {
                    if segment == "All", columns == 3 {
                        ReferenceLibraryColumns { store.openPhoto($0) }.padding(.horizontal, 12).padding(.bottom, 12)
                    } else {
                        MasonryPhotos(photos: libraryPhotos, columns: columns) { photo in
                            if segment == "Videos" { showSampleVideo = true } else { store.openPhoto(photo) }
                        }.padding(.horizontal, 12).padding(.bottom, 12)
                    }
                }
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
            .alert("Sample video", isPresented: $showSampleVideo) { Button("Done", role: .cancel) {} } message: { Text("This frontend preview includes still thumbnails. Video playback will connect to your library in the next implementation stage.") }
    }
    private var libraryPhotos: [DemoPhoto] {
        let ordered = [2, 1, 3, 4, 5, 6, 9, 7, 8, 10, 11, 12, 13, 16, 15, 17, 14, 18].map { DemoPhoto.all[$0 - 1] }
        if segment == "Places" { return ordered.filter { $0.tags.contains("travel") } }
        if segment == "Videos" { return ordered.filter { [6, 12, 16].contains($0.id) } }
        return ordered
    }

    private var favorites: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                Button { store.back() } label: { Image(systemName: "chevron.left").font(.system(size: 22)).frame(width: 44, height: 44) }.accessibilityLabel("Back")
                Image(systemName: "heart.fill").font(.system(size: 29)).foregroundStyle(LoveliesTheme.pink).shadow(color: LoveliesTheme.pink.opacity(0.4), radius: 10)
                Text("Favorites").loveliesFont(size: 25, weight: .semibold)
                Spacer()
                OverflowMenu()
            }.padding(.horizontal, 19).padding(.top, 3)
            ScrollView {
                if store.favoriteIDs.isEmpty {
                    VStack(spacing: 15) { Image(systemName: "heart").font(.system(size: 42)).foregroundStyle(LoveliesTheme.pink); Text("Save your favorite moments"); PinkButton(title: String(localized: "Explore Photos")) { store.go(.allPhotos) } }.padding(30)
                } else {
                    if SourceReferenceCatalog.layout(14) != nil {
                        SourcePhotoGrid(route: 14, selection: store.favoriteIDs, badge: .heart, badgeAction: { store.toggleFavorite($0.id) }) { store.openPhoto($0) }.padding(.horizontal, 13).padding(.bottom, 12)
                    } else {
                        MasonryPhotos(photos: [2, 3, 6, 5, 1, 18, 16, 4, 11, 17, 13, 7].map { DemoPhoto.all[$0 - 1] }, selected: store.favoriteIDs, showOnlySelectedBadges: true, heart: true, badgeAction: { store.toggleFavorite($0.id) }) { store.openPhoto($0) }
                            .padding(.horizontal, 13).padding(.bottom, 12)
                    }
                }
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }

    private var search: some View {
        LoveliesPage(spacing: 16, padding: 20) {
            HStack {
                Button { store.back() } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Back")
                Text("Search").loveliesFont(size: 25, weight: .semibold)
                Spacer()
                Button { store.go(.filters) } label: { Image(systemName: "slider.horizontal.3").font(.system(size: 23)).frame(width: 44, height: 44) }.accessibilityLabel("Filters")
            }.padding(.top, 5)
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(LoveliesTheme.secondary)
                TextField("Search photos, people, places...", text: $store.query, prompt: Text("Search photos, people, places...").foregroundColor(LoveliesTheme.secondary)).loveliesFont(size: 15).submitLabel(.search).autocorrectionDisabled().frame(minHeight: 44).contentShape(Rectangle()).accessibilityLabel("Search photos, people, places")
                if !store.query.isEmpty { Button { store.query = "" } label: { Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44) }.accessibilityLabel("Clear search") }
                Button { store.go(.filters) } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44) }.accessibilityLabel("Search filters")
            }.padding(13).background(LoveliesTheme.raised, in: Capsule())
            AdaptiveActions {
                ForEach(categoryItems, id: \.0) { item in
                    Button { store.searchCategory = store.searchCategory == item.0 ? "" : item.0; if item.0 == "Dates" { store.go(.filters) } } label: {
                        VStack(spacing: 7) { Image(systemName: item.1).font(.system(size: 25, weight: .light)); Text(LocalizedStringKey(item.0)).loveliesFont(size: 12) }
                            .frame(maxWidth: .infinity).frame(minHeight: 74).background(store.searchCategory == item.0 ? LoveliesTheme.pink.opacity(0.22) : LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 13))
                    }.buttonStyle(LoveliesPressStyle())
                }
            }
            VStack {
                VStack(alignment: .leading, spacing: 15) {
                    Text("Recent").loveliesFont(size: 18, weight: .semibold)
                    ScrollView(.horizontal) { HStack(spacing: 13) {
                        ForEach(Array([("Sunsets", 1), ("Travel", 7), ("Friends", 11), ("Food", 12)].enumerated()), id: \.offset) { index, item in
                            Button { store.query = item.0 == "Sunsets" ? "sunset" : item.0.lowercased() } label: {
                                VStack(spacing: 7) { AssetImage(name: SourceReferenceCatalog.recentAsset(index, route: 15) ?? DemoPhoto.all[item.1 - 1].asset).scaledToFill().frame(width: 70, height: 70).clipped().clipShape(RoundedRectangle(cornerRadius: 20)); Text(LocalizedStringKey(item.0)).loveliesFont(size: 13) }
                            }.buttonStyle(LoveliesPressStyle()).frame(maxWidth: .infinity)
                        }
                    } }.padding(.bottom, 10)
                    Text("Results").loveliesFont(size: 18, weight: .semibold)
                    if store.searchResults.isEmpty { Text("No photos found. Try a person, place or sunset.").foregroundStyle(LoveliesTheme.secondary).padding(.vertical, 25) }
                    else {
                        if SourceReferenceCatalog.layout(15) != nil, store.query.isEmpty, store.searchCategory.isEmpty, !store.filtersApplied {
                            SourcePhotoGrid(route: 15, selection: searchHighlights, badge: .check, badgeAction: { photo in
                                if searchHighlights.contains(photo.id) { searchHighlights.remove(photo.id) } else { searchHighlights.insert(photo.id) }
                            }) { store.openPhoto($0) }
                        } else {
                            MasonryPhotos(photos: store.searchResults, selected: store.favoriteIDs, showOnlySelectedBadges: true) { store.openPhoto($0) }
                        }
                    }
                }.padding(.bottom, 15)
            }.scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
        }.foregroundStyle(.white)
    }
    private var categoryItems: [(String, String)] { [("People", "person.2"), ("Places", "mappin.and.ellipse"), ("Dates", "calendar"), ("Favorites", "heart")] }

    private var filters: some View {
        LoveliesPage(spacing: 16, padding: 20) {
            HStack {
                Button { store.back() } label: { Image(systemName: "chevron.left").font(.system(size: 22)).frame(width: 44, height: 44) }.accessibilityLabel("Back")
                Text("Filters").loveliesFont(size: 23, weight: .semibold)
                Spacer()
                Button { store.resetFilters() } label: { Text("Reset").loveliesFont(size: 15).foregroundStyle(LoveliesTheme.pink).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
            }
            AdaptiveActions {
                ForEach(categoryItems, id: \.0) { item in
                    Button { filterTab = item.0; if item.0 == "Dates" { filterSheet = .date }; if item.0 == "Places" { filterSheet = .location }; if item.0 == "Favorites" { store.searchCategory = "Favorites" } } label: {
                        VStack(spacing: 7) { Image(systemName: item.1).font(.system(size: 26, weight: .light)); Text(LocalizedStringKey(item.0)).loveliesFont(size: 13) }
                            .foregroundStyle(filterTab == item.0 ? .black : .white).frame(maxWidth: .infinity).frame(minHeight: 78)
                            .background(filterTab == item.0 ? LoveliesTheme.pink : LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                    }.buttonStyle(LoveliesPressStyle())
                }
            }
            VStack {
                VStack(alignment: .leading, spacing: 17) {
                    Text("People").loveliesFont(size: 18, weight: .semibold)
                    HStack(spacing: 16) {
                        ForEach(Array(store.people.prefix(3))) { person in
                            Button { if store.filterPeople.contains(person.id) { store.filterPeople.remove(person.id) } else { store.filterPeople.insert(person.id) } } label: { Avatar(asset: person.asset, size: 74, pink: store.filterPeople.contains(person.id)) }.accessibilityLabel("Filter by \(person.name)")
                        }
                        Button { filterSheet = .people } label: { Image(systemName: "plus").font(.system(size: 28, weight: .light)).frame(width: 72, height: 72).background(LoveliesTheme.raised, in: Circle()).overlay(Circle().stroke(LoveliesTheme.stroke)) }.accessibilityLabel("Add people to filter")
                    }
                    Text("Date Range").loveliesFont(size: 18, weight: .medium)
                    GroupSurface { SettingsRow(icon: "calendar", title: store.filterDate == "Any date" ? String(localized: "Any date") : store.filterDate) { filterSheet = .date } }
                    Text("Location").loveliesFont(size: 18, weight: .medium)
                    GroupSurface { SettingsRow(icon: "mappin.and.ellipse", title: store.filterLocation == "Any location" ? String(localized: "Any location") : store.filterLocation) { location = store.filterLocation == "Any location" ? "" : store.filterLocation; filterSheet = .location } }
                    Text("Media Type").loveliesFont(size: 18, weight: .medium)
                    AdaptiveActions {
                        ForEach([("Photos", "photo"), ("Videos", "video"), ("Live Photos", "livephoto")], id: \.0) { item in
                            Button { store.filterMedia = item.0 } label: {
                                VStack(spacing: 8) { Image(systemName: item.1).font(.system(size: 24)); Text(LocalizedStringKey(item.0)).loveliesFont(size: 12) }
                                    .foregroundStyle(store.filterMedia == item.0 ? .black : .white).frame(maxWidth: .infinity).frame(minHeight: 74)
                                    .background(store.filterMedia == item.0 ? LoveliesTheme.pink : LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                            }.buttonStyle(LoveliesPressStyle())
                        }
                    }
                }.padding(.bottom, 12)
            }.scrollIndicators(.hidden)
            PinkButton(title: String(localized: "Show Results (\(filterResultCount))")) { store.query = ""; store.filtersApplied = true; store.go(.search) }.padding(.bottom, 6)
        }.foregroundStyle(.white)
            .sheet(item: $filterSheet) { sheet in
                DemoSheet(title: sheet == .date ? String(localized: "Date range") : sheet == .location ? String(localized: "Location") : String(localized: "Choose people")) {
                    if sheet == .date {
                        DatePicker("Photos from", selection: $date, displayedComponents: .date).datePickerStyle(.graphical)
                        PinkButton(title: String(localized: "Use this date")) { store.filterDate = date.formatted(date: .abbreviated, time: .omitted); filterSheet = nil }
                        QuietButton(title: String(localized: "Any date")) { store.filterDate = "Any date"; filterSheet = nil }
                    } else if sheet == .location {
                        TextField("City, country or place", text: $location).textFieldStyle(.roundedBorder)
                        PinkButton(title: String(localized: "Apply location")) { store.filterLocation = location.isEmpty ? "Any location" : location; filterSheet = nil }
                    } else {
                        ForEach(store.people) { person in
                            Button { if store.filterPeople.contains(person.id) { store.filterPeople.remove(person.id) } else { store.filterPeople.insert(person.id) } } label: {
                                HStack { Avatar(asset: person.asset, size: 42); Text(person.name); Spacer(); CheckBadge(selected: store.filterPeople.contains(person.id), size: 27) }
                            }.buttonStyle(LoveliesPressStyle())
                        }
                    }
                }
            }
    }
    private var filterResultCount: Int { store.filterDate == "Any date" && store.filterLocation == "Any location" && store.filterMedia == "Photos" ? 342 : (store.filterMedia == "Videos" ? 3 : 12) }

    private var activity: some View {
        VStack(spacing: 15) {
            PageHeader(title: String(localized: "Activity"), trailing: false, leadingTitle: true, back: true)
            SegmentPills(values: ["All", "Matches", "Shares", "Mentions"], selected: $segment).padding(.horizontal, 20)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(activityItems.enumerated()).filter { segment == "All" || $0.element.category == segment }, id: \.offset) { _, item in
                        Button { store.go(item.destination) } label: {
                            HStack(spacing: 15) {
                                if item.person > 0 { Avatar(asset: DemoPerson.all[item.person - 1].asset, size: 55, pink: true).overlay(alignment: .bottomTrailing) { Image(systemName: "heart.fill").font(.system(size: 11)).foregroundStyle(.black).padding(5).background(LoveliesTheme.pink, in: Circle()) } }
                                else { Image(systemName: item.symbol).font(.system(size: 34, weight: .light)).foregroundStyle(LoveliesTheme.pink).frame(width: 55) }
                                VStack(alignment: .leading, spacing: 5) { Text(item.text).loveliesFont(size: 15).multilineTextAlignment(.leading); Text(item.time).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary) }
                                Spacer(minLength: 5)
                                AssetImage(name: DemoPhoto.all[item.photo - 1].asset).scaledToFill().frame(width: 58, height: 73).clipped().clipShape(RoundedRectangle(cornerRadius: 7))
                                Image(systemName: "chevron.right").font(.system(size: 14)).foregroundStyle(LoveliesTheme.secondary)
                            }.padding(.vertical, 19).contentShape(Rectangle())
                        }.buttonStyle(LoveliesPressStyle())
                        Divider().overlay(.white.opacity(0.04))
                    }
                }.padding(.horizontal, 22)
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }
    private var activityItems: [ActivityItem] {
        [ActivityItem(text: String(localized: "Maya matched\nwith your photos"), time: String(localized: "2m ago"), person: 7, photo: 5, symbol: "heart", category: "Matches", destination: .matchedPhotos),
         ActivityItem(text: String(localized: "Alex liked 3 of\nyour photos"), time: String(localized: "12m ago"), person: 3, photo: 6, symbol: "heart", category: "Mentions", destination: .favorites),
         ActivityItem(text: String(localized: "You and Sam\nmatched on 12 photos"), time: String(localized: "1h ago"), person: 0, photo: 11, symbol: "link", category: "Matches", destination: .matchSummary),
         ActivityItem(text: String(localized: "Priya shared\na photo with you"), time: String(localized: "3h ago"), person: 5, photo: 5, symbol: "square.and.arrow.up", category: "Shares", destination: .photoViewer),
         ActivityItem(text: String(localized: "New people found\nin your photos"), time: String(localized: "5h ago"), person: 0, photo: 7, symbol: "person.2", category: "Matches", destination: .newMatches)]
    }

    private var notifications: some View {
        VStack(spacing: 15) {
            PageHeader(title: String(localized: "Notifications"), trailing: false, leadingTitle: true, back: true)
            SegmentPills(values: ["All", "People", "System"], selected: $segment).padding(.horizontal, 20)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(notificationItems.enumerated()).filter { segment == "All" || $0.element.category == segment }, id: \.offset) { index, item in
                        Button { store.unreadNotifications.remove(index); store.go(item.destination) } label: {
                            HStack(spacing: 22) {
                                Image(systemName: item.symbol).font(.system(size: 31, weight: .regular)).foregroundStyle(LoveliesTheme.pink).frame(width: 43)
                                VStack(alignment: .leading, spacing: 6) { Text(item.text).loveliesFont(size: 15).multilineTextAlignment(.leading); Text(item.time).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary) }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.system(size: 14)).foregroundStyle(LoveliesTheme.secondary)
                            }.opacity(store.unreadNotifications.contains(index) ? 1 : 0.6).padding(.vertical, 21).contentShape(Rectangle())
                        }.buttonStyle(LoveliesPressStyle())
                        Divider().overlay(.white.opacity(0.04))
                    }
                }.padding(.horizontal, 25)
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }
    private var notificationItems: [ActivityItem] {
        [ActivityItem(text: String(localized: "You have 5 new matches!"), time: String(localized: "2m ago"), person: 0, photo: 1, symbol: "heart.fill", category: "People", destination: .newMatches),
         ActivityItem(text: String(localized: "Emma joined Lovelies\nand found you"), time: String(localized: "14m ago"), person: 0, photo: 1, symbol: "person.badge.plus", category: "People", destination: .personPhotos),
         ActivityItem(text: String(localized: "Taylor commented\non your photo"), time: String(localized: "1h ago"), person: 0, photo: 1, symbol: "bubble.left.fill", category: "People", destination: .photoViewer),
         ActivityItem(text: String(localized: "Jordan shared a photo\nwith you"), time: String(localized: "2h ago"), person: 0, photo: 1, symbol: "square.and.arrow.up", category: "People", destination: .sharedHistory),
         ActivityItem(text: String(localized: "Your upload is complete"), time: String(localized: "3h ago"), person: 0, photo: 1, symbol: "bell.fill", category: "System", destination: .uploadComplete),
         ActivityItem(text: String(localized: "New memories ready\nto explore"), time: String(localized: "5h ago"), person: 0, photo: 1, symbol: "star.fill", category: "System", destination: .home)]
    }

    private func circleCommand(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).font(.system(size: 23, weight: .light)).frame(width: 44, height: 44).background(.white.opacity(0.06), in: Circle()) }.foregroundStyle(.white).accessibilityLabel(label)
    }
}

private struct ActivityItem {
    let text: String
    let time: String
    let person: Int
    let photo: Int
    let symbol: String
    let category: String
    let destination: Screen
}

private struct HomeMosaicManifest: Decodable {
    let tiles: [HomeMosaicTile]
    static let tiles: [HomeMosaicTile] = {
        let url = Bundle.main.url(forResource: "home-grid", withExtension: "json") ?? Bundle.main.url(forResource: "home-grid", withExtension: "json", subdirectory: "Resources")
        guard let url, let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode(HomeMosaicManifest.self, from: data) else { return [] }
        return value.tiles
    }()
}

private struct HomeMosaicTile: Decodable, Identifiable {
    let id: Int
    let asset: String
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

private struct HomeMosaicView: View {
    @EnvironmentObject private var store: DemoStore
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                ForEach(HomeMosaicManifest.tiles) { tile in
                    Button {
                        let fixture = DemoPhoto.all[min(tile.id - 1, DemoPhoto.all.count - 1)]
                        store.openPhoto(DemoPhoto(id: fixture.id, asset: (tile.asset as NSString).deletingPathExtension, tags: fixture.tags, ratio: tile.height / tile.width))
                    } label: {
                        AssetImage(name: tile.asset).scaledToFill()
                            .frame(width: geometry.size.width * tile.width, height: geometry.size.height * tile.height)
                            .clipped().clipShape(RoundedRectangle(cornerRadius: 8))
                    }.buttonStyle(LoveliesPressStyle())
                        .accessibilityLabel("Open gallery photo \(tile.id)")
                        .offset(x: geometry.size.width * tile.x, y: geometry.size.height * tile.y)
                }
            }.frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
    }
}

private struct LibraryReferenceTile: Identifiable {
    let id: Int
    let column: Int
    let ratio: CGFloat
    static let all: [LibraryReferenceTile] = {
        let ids = [[2, 4, 9, 10], [1, 6, 7, 11], [3, 5, 8, 12, 14]]
        let ratios: [[CGFloat]] = [[1.32, 1.35, 0.8, 1.5], [1.58, 1.05, 1.1, 1.02], [1, 1.1, 1.45, 1, 1.4]]
        return ids.enumerated().flatMap { column, values in
            values.enumerated().map { row, id in LibraryReferenceTile(id: id, column: column, ratio: ratios[column][row]) }
        }
    }()
}

private struct ReferenceLibraryColumns: View {
    var action: (DemoPhoto) -> Void
    var body: some View {
        ReferenceLibraryLayout {
            ForEach(LibraryReferenceTile.all) { tile in
                let photo = DemoPhoto.all[tile.id - 1]
                PhotoTile(photo: photo) { action(photo) }
                    .layoutValue(key: LibraryReferenceColumnKey.self, value: tile.column)
                    .layoutValue(key: LibraryReferenceRatioKey.self, value: tile.ratio)
            }
        }
    }
}

private struct LibraryReferenceColumnKey: LayoutValueKey { static let defaultValue: Int = 0 }
private struct LibraryReferenceRatioKey: LayoutValueKey { static let defaultValue: CGFloat = 1 }

private struct ReferenceLibraryLayout: Layout {
    private let weights: [CGFloat] = [70, 80, 69]
    private let gap: CGFloat = 6
    private func widths(for total: CGFloat) -> [CGFloat] {
        let available = max(3, total - gap * 2)
        return weights.map { available * $0 / 219 }
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 390
        let columns = widths(for: width)
        var heights = Array(repeating: CGFloat.zero, count: 3)
        for view in subviews {
            let column = view[LibraryReferenceColumnKey.self]
            heights[column] += columns[column] * view[LibraryReferenceRatioKey.self] + gap
        }
        return CGSize(width: width, height: max(0, (heights.max() ?? 0) - gap))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let columns = widths(for: bounds.width)
        let offsets = [CGFloat.zero, columns[0] + gap, columns[0] + columns[1] + gap * 2]
        var heights = Array(repeating: CGFloat.zero, count: 3)
        for view in subviews {
            let column = view[LibraryReferenceColumnKey.self]
            let height = columns[column] * view[LibraryReferenceRatioKey.self]
            view.place(at: CGPoint(x: bounds.minX + offsets[column], y: bounds.minY + heights[column]), proposal: ProposedViewSize(width: columns[column], height: height))
            heights[column] += height + gap
        }
    }
}
