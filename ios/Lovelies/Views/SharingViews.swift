import SwiftUI

struct SharingViews: View {
    @EnvironmentObject private var store: DemoStore
    let screen: Screen
    @State private var reportSaved = false

    @ViewBuilder var body: some View {
        switch screen {
        case .matchSummary: summary
        case .matchedPhotos: matchedPhotos
        case .photoPeople: photoPeople
        case .personPhotos: personPhotos
        case .shareSelection, .deselectPhotos: photoSelection
        case .peopleSelection, .deselectPeople: peopleSelection
        case .shareReview: review
        case .sharingProgress: progress
        case .sharedHistory: history
        default: report
        }
    }

    private var summary: some View {
        GeometryReader { geometry in
            ScrollView {
            ZStack {
                GlowBackground(strong: true)
                VStack(spacing: 12) {
                    PageHeader(title: String(localized: "Your Matches"), trailing: false)
                    AssetImage(name: "matches-hero").scaledToFit().frame(width: min(260, geometry.size.width * 0.531)).padding(.top, geometry.size.height * 0.02).accessibilityHidden(true)
                    VStack(spacing: 0) { Text("12").loveliesFont(size: 33, weight: .semibold); Text("Photos Matched").loveliesFont(size: 20).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true) }
                    VStack(spacing: 0) { Text("8").loveliesFont(size: 32, weight: .semibold); Text("People Found").loveliesFont(size: 20).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true) }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: -6) { summaryPeople }
                            .fixedSize(horizontal: true, vertical: false)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 58), spacing: 12)], spacing: 12) {
                            summaryPeople
                        }
                    }.padding(.vertical, 7)
                    Text("Great matches!\nYour photos found people\nin your memories.").loveliesFont(size: 16).multilineTextAlignment(.center).foregroundStyle(LoveliesTheme.secondary).lineSpacing(2)
                    Spacer(minLength: 10)
                    PinkButton(title: String(localized: "View Matches")) { store.go(.matchedPhotos) }.padding(.bottom, 19)
                }.padding(.horizontal, 23).frame(maxWidth: .infinity).foregroundStyle(.white)
            }
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }

    @ViewBuilder private var summaryPeople: some View {
        ForEach(Array(store.people.prefix(5))) { person in
            Button { store.openPerson(person) } label: { Avatar(asset: person.asset, size: 58, pink: true) }.accessibilityLabel(person.name)
        }
        Button { store.go(.photoPeople) } label: {
            Text("+3").loveliesFont(size: 16).frame(minWidth: 49, minHeight: 49)
                .background(.white.opacity(0.1), in: Circle())
        }.accessibilityLabel("3 more people")
    }

    private var matchedPhotos: some View {
        VStack(spacing: 6) {
            PageHeader(title: String(localized: "Matched Photos"), subtitle: String(localized: "12 photos"))
            ScrollView {
                if SourceReferenceCatalog.layout(26) != nil {
                    SourcePhotoGrid(route: 26) { store.openPhoto($0, destination: .photoPeople) }.padding(.horizontal, 12).padding(.bottom, 10)
                } else {
                    MasonryPhotos(photos: matchedOrder, people: true) { store.openPhoto($0, destination: .photoPeople) }.padding(.horizontal, 12).padding(.bottom, 10)
                }
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }
    private var matchedOrder: [DemoPhoto] { store.matchingPhotos }

    private var photoPeople: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                ZStack(alignment: .top) {
                    AssetImage(name: store.currentPhoto.asset).scaledToFill().frame(width: geometry.size.width, height: geometry.size.height * 0.53).clipped()
                        .accessibilityElement(children: .ignore).accessibilityLabel(Text("Photo \(store.currentPhoto.id)")).accessibilityAddTraits(.isImage)
                    HStack {
                        Button { store.back() } label: { Image(systemName: "chevron.left").font(.system(size: 22)).frame(width: 44, height: 44) }.accessibilityLabel("Back")
                        Spacer()
                        Text("\(max(1, store.matchingPhotos.firstIndex(of: store.currentPhoto).map { $0 + 1 } ?? 1))/12")
                            .loveliesFont(size: 15, weight: .medium).padding(.horizontal, 12).padding(.vertical, 9).background(.black.opacity(0.3), in: Capsule())
                    }.padding(.horizontal, 13).padding(.top, 7)
                }.clipShape(RoundedRectangle(cornerRadius: 16))
                VStack(spacing: 15) {
                    HStack {
                        Button { store.back() } label: { Image(systemName: "chevron.left").font(.system(size: 21)).frame(width: 44, height: 44) }.accessibilityLabel("Back to photo")
                        Text("People in this photo").loveliesFont(size: 19, weight: .semibold).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity)
                        Menu {
                            Button("Share this photo", systemImage: "square.and.arrow.up") { store.beginSharing(store.currentPhoto); store.go(.peopleSelection) }
                            Button("Report incorrect match", systemImage: "flag") { store.go(.incorrectMatch) }
                            Button("Screen gallery", systemImage: "rectangle.grid.2x2") { store.showGallery = true }
                        } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44).background(.white.opacity(0.08), in: Circle()) }.accessibilityLabel("Photo options")
                    }
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 15), count: 4), spacing: 17) {
                        ForEach(Array(store.people.prefix(7))) { person in
                            Button { store.openPerson(person) } label: {
                                VStack(spacing: 6) { Avatar(asset: person.asset, size: 60); Text(person.name).loveliesFont(size: 13) }
                            }.buttonStyle(LoveliesPressStyle())
                        }
                        Button { store.go(.allowedPeople) } label: { Text("+2").loveliesFont(size: 18).frame(width: 60, height: 60).background(LoveliesTheme.raised, in: Circle()).padding(.bottom, 23) }.accessibilityLabel("More people")
                    }.padding(.horizontal, 7)
                    Spacer(minLength: 0)
                }.padding(.horizontal, 14).padding(.top, 6).frame(maxWidth: .infinity).background(LoveliesTheme.canvas, in: RoundedRectangle(cornerRadius: 24))
            }.foregroundStyle(.white)
        }
    }

    private var personPhotos: some View {
        VStack(spacing: 10) {
            PageHeader(title: "")
            Avatar(asset: store.currentPerson.asset, size: 119).padding(.top, -20)
            Text(store.currentPerson.name).loveliesFont(size: 22, weight: .medium)
            Text(NativeCountCopy.text(.matched, store.currentPerson.matches)).loveliesFont(size: 17).foregroundStyle(LoveliesTheme.secondary)
            ScrollView {
                if SourceReferenceCatalog.layout(28) != nil, store.currentPerson.id == 1 {
                    SourcePhotoGrid(route: 28, filterIDs: Set((SourceReferenceCatalog.layout(28)?.tiles ?? []).prefix(store.currentPerson.matches).map(\.id))) { store.openPhoto($0) }.padding(.horizontal, 13).padding(.bottom, 12)
                } else {
                    MasonryPhotos(photos: Array([1, 2, 4, 13, 16, 7, 11, 8].prefix(store.currentPerson.matches)).map { DemoPhoto.all[$0 - 1] }) { store.openPhoto($0) }
                        .padding(.horizontal, 13).padding(.bottom, 12)
                }
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }

    private var photoSelection: some View {
        VStack(spacing: 6) {
            PageHeader(title: screen == .deselectPhotos ? String(localized: "Deselect Photos") : String(localized: "Select Photos to Share"), subtitle: String(localized: "\(store.sharePhotoIDs.count) of 12 selected"))
            ScrollView {
                if SourceReferenceCatalog.layout(screen.rawValue) != nil {
                    let overrides = Dictionary(uniqueKeysWithValues: store.sharingPhotos.filter { store.sharingPhotoAssets[$0.id] != nil }.map { ($0.id, $0) })
                    SourcePhotoGrid(route: screen.rawValue, selection: store.sharePhotoIDs, badge: .check, showUnselectedBadges: true, dimUnselected: screen == .deselectPhotos, photoOverrides: overrides, badgeAction: { store.toggleSharePhoto($0) }) { store.toggleSharePhoto($0) }.padding(.horizontal, 13).padding(.bottom, 80)
                } else {
                    MasonryPhotos(photos: matchedOrder, selected: store.sharePhotoIDs, people: true) { store.toggleSharePhoto($0.id) }
                        .padding(.horizontal, 13).padding(.bottom, 80)
                }
                let outsideIDs = store.sharePhotoIDs.subtracting(Set(matchedOrder.map(\.id)))
                if !outsideIDs.isEmpty {
                    MasonryPhotos(photos: store.sharingPhotos.filter { outsideIDs.contains($0.id) }, selected: store.sharePhotoIDs) { store.toggleSharePhoto($0) }.padding(.horizontal, 13).padding(.bottom, 80)
                }
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                HStack(spacing: 15) {
                    Menu {
                        Button("Select all photos") { store.sharePhotoIDs = Set(matchedOrder.map(\.id)) }
                        Button("Deselect all photos") { store.sharePhotoIDs = [] }
                        Button("Deselect photos") { store.go(.deselectPhotos) }
                    } label: { Image(systemName: "square.and.arrow.up").font(.system(size: 24)).frame(width: 44, height: 44).background(.white.opacity(0.04), in: Circle()) }.accessibilityLabel("Selection options")
                    Spacer()
                    Text("\(store.sharePhotoIDs.count) selected").loveliesFont(size: 16).foregroundStyle(LoveliesTheme.secondary)
                    Spacer()
                    Button { store.go(.peopleSelection) } label: {
                        Image(systemName: "arrow.right").font(.system(size: 25, weight: .light)).foregroundStyle(.black)
                            .frame(width: 57, height: 50).background(LoveliesTheme.pink.opacity(store.sharePhotoIDs.isEmpty ? 0.35 : 1), in: Capsule())
                    }.disabled(store.sharePhotoIDs.isEmpty).accessibilityLabel("Choose people to share with")
                }.padding(11).background(.ultraThinMaterial, in: Capsule()).overlay(Capsule().stroke(LoveliesTheme.stroke)).padding(.horizontal, 12).padding(.bottom, 3)
            }
    }

    private var peopleSelection: some View {
        VStack(spacing: 7) {
            PageHeader(title: screen == .deselectPeople ? String(localized: "Deselect People") : String(localized: "Choose People to Share With"), subtitle: String(localized: "\(store.sharingPeople.count) of \(store.people.count) selected"))
            ScrollView {
                VStack(spacing: 3) {
                    ForEach(store.people) { person in personSelectionRow(person) }
                }.padding(.horizontal, 14)
            }.scrollIndicators(.hidden)
            PinkButton(title: String(localized: "Continue"), enabled: !store.sharingPeople.isEmpty && !store.sharePhotoIDs.isEmpty) { store.go(.shareReview) }.padding(.horizontal, 19).padding(.bottom, 14)
        }.foregroundStyle(.white)
    }
    private func personSelectionRow(_ person: DemoPerson) -> some View {
        let blocked = store.blockedIDs.contains(person.id)
        let selected = store.sharePersonIDs.contains(person.id) && !blocked
        return Button { store.toggleSharePerson(person.id) } label: {
            HStack(spacing: 14) {
                Avatar(asset: person.asset, size: 45, pink: selected)
                VStack(alignment: .leading, spacing: 3) {
                    Text(person.name).loveliesFont(size: 16, weight: .medium)
                    Text(blocked ? String(localized: "Blocked") : String(localized: "Matched in \(person.matches) photos")).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary)
                }
                Spacer()
                RoundedRectangle(cornerRadius: 8).fill(selected ? LoveliesTheme.pink : .clear).frame(width: 28, height: 28)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? .clear : .white.opacity(0.6), lineWidth: 1.3))
                    .overlay { if selected { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(.black) } }
            }.padding(.horizontal, 9).padding(.vertical, 5).frame(minHeight: 62)
                .background(selected ? LoveliesTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 12)).opacity(blocked ? 0.4 : 1).contentShape(Rectangle())
        }.buttonStyle(LoveliesPressStyle()).disabled(blocked).accessibilityElement(children: .ignore).accessibilityLabel(person.name).accessibilityValue(blocked ? String(localized: "Blocked") : selected ? String(localized: "Selected") : String(localized: "Not selected")).accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var review: some View {
        VStack(spacing: 10) {
            PageHeader(title: String(localized: "Review & Share"), trailing: false)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    reviewSectionHeader(String(localized: "Photos (\(store.sharePhotoIDs.count))")) { store.go(.shareSelection) }
                    if let layout = SourceReferenceCatalog.layout(33) {
                        if store.referenceReview33 {
                            SourcePhotoGrid(route: 33, filterIDs: store.sharePhotoIDs) { store.openPhoto($0) }
                            let extra = store.sharePhotoIDs.subtracting(Set(layout.tiles.map(\.id)))
                            if !extra.isEmpty {
                                MasonryPhotos(photos: store.sharingPhotos.filter { extra.contains($0.id) }) { store.openPhoto($0) }
                            }
                        } else {
                            // Measured source slots retain the user's actual crop/ID.
                            let photos = store.sharingPhotos
                            let slots = Dictionary(uniqueKeysWithValues: Array(photos.prefix(6)).enumerated().map { ($0.offset + 1, $0.element) })
                            SourcePhotoGrid(route: 33, photoOverrides: slots, requirePhotoOverrides: true) { store.openPhoto($0) }
                            if photos.count > 6 { MasonryPhotos(photos: Array(photos.dropFirst(6))) { store.openPhoto($0) } }
                        }
                    } else {
                        PhotoReviewMosaic(photos: store.sharingPhotos) { store.openPhoto($0) }.frame(height: 165)
                    }
                    reviewSectionHeader(String(localized: "People (\(store.sharingPeople.count))")) { store.go(.peopleSelection) }.padding(.top, 7)
                    ScrollView(.horizontal) {
                        HStack(spacing: 22) {
                            ForEach(store.sharingPeople) { person in
                                Button { store.openPerson(person) } label: { VStack(spacing: 6) { Avatar(asset: person.asset, size: 65, pink: true); Text(person.name).loveliesFont(size: 14) } }.buttonStyle(LoveliesPressStyle())
                            }
                        }.padding(.horizontal, 4).padding(.vertical, 2)
                    }.scrollIndicators(.hidden).accessibilityIdentifier("lovelies.horizontal.review-people")
                }.padding(.horizontal, 21)
            }.scrollIndicators(.hidden)
            Text("You're about to share \(store.sharePhotoIDs.count) photos\nwith \(store.sharingPeople.count) people.")
                .loveliesFont(size: 15).multilineTextAlignment(.center).foregroundStyle(LoveliesTheme.secondary)
                .frame(maxWidth: .infinity).padding(.vertical, 21).background(LoveliesTheme.raised, in: RoundedRectangle(cornerRadius: 15))
                .overlay(RoundedRectangle(cornerRadius: 15).stroke(LoveliesTheme.stroke)).padding(.horizontal, 21)
            PinkButton(title: String(localized: "Share Photos"), icon: "square.and.arrow.up", enabled: !store.sharePhotoIDs.isEmpty && !store.sharingPeople.isEmpty) { store.go(.sharingProgress) }.padding(.horizontal, 21).padding(.bottom, 15)
        }.foregroundStyle(.white)
    }
    private func reviewSectionHeader(_ title: String, action: @escaping () -> Void) -> some View {
        HStack {
            Text(title).loveliesFont(size: 16, weight: .medium)
            Spacer()
            Button(action: action) {
                Text("Edit").loveliesFont(size: 12).foregroundStyle(.white.opacity(0.9))
                    .padding(.horizontal, 14).padding(.vertical, 5).frame(minHeight: 44).background(LoveliesTheme.surface, in: Capsule())
                    .overlay(Capsule().stroke(LoveliesTheme.stroke, lineWidth: 1))
            }.buttonStyle(LoveliesPressStyle())
        }
    }

    private var progress: some View {
        GeometryReader { geometry in
            ScrollView {
            ZStack {
                GlowBackground(strong: true)
                VStack(spacing: 18) {
                    PageHeader(title: String(localized: "Sharing Photos"), close: true, trailing: false)
                    AssetImage(name: "sharing-hero").scaledToFit().frame(width: min(300, geometry.size.width * 0.683)).accessibilityHidden(true)
                    Text("Sharing with \(store.sharingPeople.count) people...").loveliesFont(size: 20)
                    Text("This is a local preview. Your selections stay here when you go back.").loveliesFont(size: 15).foregroundStyle(LoveliesTheme.secondary)
                    VStack(alignment: .leading, spacing: 16) {
                        sharingStep(String(localized: "Preparing photos"), index: 0)
                        sharingStep(String(localized: "Finding your people"), index: 1)
                        sharingStep(String(localized: "Sending..."), index: 2)
                        sharingStep(String(localized: "Almost there!"), index: 3)
                        QuietButton(title: String(localized: "Back to review")) { store.back() }
                    }.padding(.top, 13).padding(.horizontal, 20)
                    Spacer(minLength: 0)
                }.padding(.horizontal, 29).frame(maxWidth: .infinity).foregroundStyle(.white)
            }.contentShape(Rectangle()).onLongPressGesture { store.showGallery = true }
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }
    private func sharingStep(_ title: String, index: Int) -> some View {
        let completed = index < 2 || store.progress > 0.8
        return HStack(spacing: 13) {
            ZStack {
                Circle().fill(completed ? LoveliesTheme.pink : .clear)
                if completed { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(.black) }
                else { Circle().stroke(.white.opacity(0.5), lineWidth: 1.4); if index == 2 { Circle().trim(from: 0, to: CGFloat(max(0.2, store.progress))).stroke(LoveliesTheme.pink, lineWidth: 2).rotationEffect(.degrees(-90)) } }
            }.frame(width: 25, height: 25)
            Text(title).loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary)
        }
    }

    private var history: some View {
        VStack(spacing: 9) {
            PageHeader(title: String(localized: "Shared with People"))
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array([DemoPerson.all[0], DemoPerson.all[4], DemoPerson.all[6]].enumerated()), id: \.offset) { index, person in
                        sharedRow(person, photo: [1, 6, 16][index], detail: NativeCountCopy.text(.photoStatus, store.shared ? store.sharePhotoIDs.count : 6, index == 0 ? String(localized: "Just now") : String(localized: "2m ago")), status: "Delivered")
                    }
                    Text("Earlier").loveliesFont(size: 18, weight: .semibold).padding(.vertical, 18)
                    sharedRow(DemoPerson.all[1], photo: nil, detail: String(localized: "4 photos · 1d ago"), status: "Viewed")
                    sharedRow(DemoPerson.all[2], photo: nil, detail: String(localized: "3 photos · 1d ago"), status: "Viewed")
                    sharedRow(DemoPerson.all[3], photo: nil, detail: String(localized: "5 photos · 2d ago"), status: "Sent")
                }.padding(.horizontal, 20)
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }
    private func sharedRow(_ person: DemoPerson, photo: Int?, detail: String, status: String) -> some View {
        Button { store.openPerson(person) } label: {
            HStack(spacing: 13) {
                if let photo {
                    HStack(spacing: -30) {
                        AssetImage(name: DemoPhoto.all[photo - 1].asset).scaledToFill().frame(width: 45, height: 60).clipped().clipShape(RoundedRectangle(cornerRadius: 7))
                        Avatar(asset: person.asset, size: 53)
                    }.frame(width: 73)
                } else { Avatar(asset: person.asset, size: 51) }
                VStack(alignment: .leading, spacing: 6) { Text(person.name).loveliesFont(size: 17, weight: .medium); Text(detail).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary) }
                Spacer(minLength: 0)
                Label(LocalizedStringKey(status), systemImage: status == "Delivered" ? "circle.fill" : status == "Viewed" ? "eye" : "circle.fill")
                    .loveliesFont(size: 11, weight: .medium).foregroundStyle(status == "Delivered" ? LoveliesTheme.pink : .black)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(status == "Delivered" ? LoveliesTheme.pink.opacity(0.14) : status == "Sent" ? Color(red: 0.7, green: 0.56, blue: 1) : LoveliesTheme.pink, in: Capsule())
            }.padding(.vertical, 14).contentShape(Rectangle())
        }.buttonStyle(LoveliesPressStyle()).overlay(alignment: .bottom) { Rectangle().fill(.white.opacity(0.08)).frame(height: 1) }
    }

    private var report: some View {
        LoveliesPage(spacing: 18, padding: 20) {
            PageHeader(title: "")
            Avatar(asset: "person02", size: 110)
            Text("Not this person?").loveliesFont(size: 24, weight: .medium)
            Text("Help us improve by letting us know\nthis isn't the right match.").loveliesFont(size: 16).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
            VStack(spacing: 8) {
                ForEach([("This isn't me", "hand.raised"), ("Wrong person", "person.crop.circle.badge.questionmark"), ("Not in this photo", "photo"), ("Other issue", "exclamationmark.circle")], id: \.0) { item in
                    Button { store.reportReason = item.0 } label: {
                        HStack(spacing: 14) {
                            Image(systemName: item.1).font(.system(size: 19)).frame(width: 27)
                            Text(LocalizedStringKey(item.0)).loveliesFont(size: 15)
                            Spacer()
                            Circle().stroke(.white.opacity(0.65), lineWidth: 1.5).frame(width: 27, height: 27)
                                .overlay { if store.reportReason == item.0 { Circle().fill(LoveliesTheme.pink).overlay(Circle().fill(.white.opacity(0.8)).frame(width: 9, height: 9)) } }
                        }.padding(16).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 13))
                    }.buttonStyle(LoveliesPressStyle()).accessibilityAddTraits(store.reportReason == item.0 ? .isSelected : [])
                }
            }.padding(.top, 2)
            Spacer(minLength: 0)
            PinkButton(title: String(localized: "Submit")) { reportSaved = true }.padding(.bottom, 15)
        }.foregroundStyle(.white)
            .alert("Report saved in this preview", isPresented: $reportSaved) { Button("Done") { store.go(.matchedPhotos) } } message: { Text("Selected reason: \(store.reportReason). No report or photo has been sent. This is a local frontend demonstration.") }
    }
}

private struct PhotoReviewMosaic: View {
    var photos: [DemoPhoto]
    var action: (DemoPhoto) -> Void
    var body: some View {
        GeometryReader { geometry in
            let width = (geometry.size.width - 12) / 3
            HStack(alignment: .top, spacing: 6) {
                if let first = photos.first { PhotoTile(photo: first, height: geometry.size.height) { action(first) }.frame(width: width) }
                VStack(spacing: 6) {
                    ForEach(Array(photos.dropFirst().prefix(2))) { photo in PhotoTile(photo: photo, height: (geometry.size.height - 6) / 2) { action(photo) }.frame(width: width) }
                }
                VStack(spacing: 6) {
                    ForEach(Array(photos.dropFirst(3).prefix(3))) { photo in PhotoTile(photo: photo, height: (geometry.size.height - 12) / 3) { action(photo) }.frame(width: width) }
                }
            }
        }
    }
}
