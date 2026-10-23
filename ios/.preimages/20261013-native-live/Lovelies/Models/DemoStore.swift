import SwiftUI

enum Screen: Int, CaseIterable, Identifiable {
    case splash = 1, introduction, signIn, photoAccessPrompt, photoAccessOptions
    case faceEnrollment, faceQualityRetry, processing, setupComplete
    case home, newMatches, photoViewer, allPhotos, favorites, search, filters
    case activity, notifications, uploadEntry, uploadSource, uploadSelection
    case uploadReview, uploadProgress, uploadComplete, matchSummary, matchedPhotos
    case photoPeople, personPhotos, shareSelection, deselectPhotos, peopleSelection
    case deselectPeople, shareReview, sharingProgress, sharedHistory, incorrectMatch
    case profile, faceManagement, allowedPeople, privacy, photoAccessSettings
    case notificationSettings, storage, exportData, help, security, noMatches, offline

    var id: Int { rawValue }
    var title: String {
        ["Splash", "Introduction and how it works", "Sign in and join", "Photo access prompt",
         "Photo access options", "Face enrollment", "Face quality retry", "Processing",
         "Setup complete", "Home gallery", "New matches", "Photo viewer", "All photos",
         "Favorites and saved", "Search", "Filters", "Activity inbox", "Notifications",
         "Upload entry", "Upload source picker", "Select upload photos", "Review upload",
         "Upload progress", "Upload complete", "Match results summary", "Matched photos gallery",
         "Photo to people", "Person to photos", "Select photos to share", "Deselect photos",
         "Select people to share with", "Deselect people", "Review and share", "Sharing progress",
         "Shared history", "Report incorrect match", "Profile overview", "Face management",
         "Manage allowed recipients", "Privacy and sharing", "Photo access settings",
         "Notification settings", "Storage", "Data export", "Help center",
         "Account security and devices", "No matches", "Offline and error"][rawValue - 1]
    }
}

struct DemoPhoto: Identifiable, Hashable {
    let id: Int
    let asset: String
    let tags: String
    let ratio: CGFloat
    var personIDs: Set<Int> { Set([((id - 1) % 8) + 1, (id % 8) + 1, 1]) }
    var location: String { [7, 16].contains(id) ? "Switzerland" : [1, 2, 4, 5, 8, 10, 13, 14, 15].contains(id) ? "Italy" : "Croatia" }
    var sampleDate: String { Calendar.current.date(byAdding: .day, value: id <= 9 ? 0 : id <= 15 ? -1 : -7, to: Date())!.formatted(date: .abbreviated, time: .omitted) }
    static let all: [DemoPhoto] = (1...18).map { index in
        let tags = ["sunset coast woman hat travel", "travel architecture city Italy", "dog friends garden", "travel church cathedral architecture", "friends people travel town", "beach swimming sunset people", "lake mountains alpine travel", "friends people seated woman town", "dog garden park", "city travel man people", "woman sunshine portrait friends", "friends dinner evening party food", "coastal town travel", "tower sunset travel architecture", "cathedral travel", "woman lake mountains travel", "blonde sunlight portrait friends", "blonde summer dress people friends"]
        let ratios: [CGFloat] = [1.65, 1.35, 1.0, 1.4, 1.25, 1.1, 1.15, 1.2, 1.2, 1.35, 1.35, 1.1, 1.05, 1.35, 1.4, 1.5, 1.3, 1.45]
        return DemoPhoto(id: index, asset: String(format: "photo%02d", index), tags: tags[index - 1], ratio: ratios[index - 1])
    }
}

struct DemoPerson: Identifiable, Hashable {
    let id: Int
    var name: String
    var fullName: String
    let asset: String
    let matches: Int
    static let all: [DemoPerson] = [
        DemoPerson(id: 1, name: "Sophie", fullName: "Sophie Chen", asset: "person01", matches: 6),
        DemoPerson(id: 2, name: "Mark", fullName: "Marcus Bell", asset: "person02", matches: 4),
        DemoPerson(id: 3, name: "Emma", fullName: "Priya Shah", asset: "person03", matches: 3),
        DemoPerson(id: 4, name: "James", fullName: "Daniel Kim", asset: "person04", matches: 3),
        DemoPerson(id: 5, name: "Olivia", fullName: "Elena Cruz", asset: "person05", matches: 2),
        DemoPerson(id: 6, name: "Daniel", fullName: "Jordan Taylor", asset: "person06", matches: 2),
        DemoPerson(id: 7, name: "Maya", fullName: "Alex Rivera", asset: "person07", matches: 1),
        DemoPerson(id: 8, name: "Lucas", fullName: "Taylor Morgan", asset: "person08", matches: 1)
    ]
}

enum AccessMode: String, CaseIterable { case all = "All Photos", albums = "Selected Albums", limited = "Limited Access" }

@MainActor final class DemoStore: ObservableObject {
    @Published var screen: Screen = .splash
    @Published var history: [Screen] = []
    @Published var showGallery = false
    @Published var showDemoNotice = true
    @Published var access: AccessMode = .all
    @Published var captures = 0
    @Published var currentPhoto = DemoPhoto.all[0]
    @Published var currentPerson = DemoPerson.all[0]
    @Published var favoriteIDs: Set<Int> = SourceReferenceCatalog.selectedIDs(14) ?? [3, 4, 5, 6, 8, 9, 11]
    @Published var uploadIDs: Set<Int> = SourceReferenceCatalog.selectedIDs(21) ?? Set(1...12)
    @Published var sharePhotoIDs: Set<Int> = SourceReferenceCatalog.selectedIDs(29) ?? [1, 2, 4, 5, 6, 7, 8, 9]
    @Published var sharePersonIDs: Set<Int> = [1, 2, 3, 5, 7]
    @Published var blockedIDs: Set<Int> = [13, 14, 15]
    @Published var people = DemoPerson.all
    @Published var managedPeople = DemoPerson.all + [
        DemoPerson(id: 9, name: "Sam", fullName: "Sam Lee", asset: "person02", matches: 2),
        DemoPerson(id: 10, name: "Ava", fullName: "Ava Rose", asset: "person03", matches: 1),
        DemoPerson(id: 11, name: "Noah", fullName: "Noah Wilson", asset: "person04", matches: 1),
        DemoPerson(id: 12, name: "Mia", fullName: "Mia Jones", asset: "person05", matches: 2),
        DemoPerson(id: 13, name: "Chris", fullName: "Chris Adams", asset: "person06", matches: 1),
        DemoPerson(id: 14, name: "Ella", fullName: "Ella Brown", asset: "person07", matches: 1),
        DemoPerson(id: 15, name: "Leo", fullName: "Leo Martin", asset: "person08", matches: 1)
    ]
    @Published var query = ""
    @Published var searchCategory = ""
    @Published var filterPeople: Set<Int> = [1]
    @Published var filterDate = "Any date"
    @Published var filterLocation = "Any location"
    @Published var filterMedia = "Photos"
    @Published var filtersApplied = false
    @Published var uploadPhotoAssets: [Int: String] = [:]
    @Published var sharingPhotoAssets: [Int: String] = [:]
    @Published var referenceReview33 = false
    @Published var uploadSource = "From This Device"
    @Published var caption = ""
    @Published var album = "Travels 2024"
    @Published var visibility = "Matched people only"
    @Published var findability = "Only people you're matched with"
    @Published var progress: Double = 0
    @Published var shared = false
    @Published var reportReason = "This isn't me"
    @Published var profileName = "Jasmine"
    @Published var profileBio = "Here for the good photos\nand great company ✨"
    @Published var email = "jasmine@lovelies.app"
    @Published var phone = "+1 (555) 123-4567"
    @Published var twoFactor = false
    @Published var activeDevices = ["This iPhone", "iPad", "MacBook"]
    @Published var cacheCleared = false
    @Published var unreadNotifications: Set<Int> = Set(0...5)
    @Published var preferences: [String: Bool] = [
        "Allow others to save": true, "Show location info": false,
        "Show in suggestions": true, "Analytics": false, "New Matches": true,
        "Messages": true, "Mentions": true, "Tips & Features": true,
        "Reminders": false, "Marketing": false
    ]
    private var progressTask: Task<Void, Never>?

    var uploadPhotos: [DemoPhoto] {
        uploadIDs.sorted().compactMap { id in
            guard let fixture = DemoPhoto.all.first(where: { $0.id == id }) else { return nil }
            let source = SourceReferenceCatalog.photo(id, route: 21) ?? fixture
            return DemoPhoto(id: id, asset: uploadPhotoAssets[id] ?? source.asset, tags: source.tags, ratio: source.ratio)
        }
    }
    var sharingPhotos: [DemoPhoto] {
        sharePhotoIDs.sorted().compactMap { id in
            guard let fixture = DemoPhoto.all.first(where: { $0.id == id }) else { return nil }
            let source = SourceReferenceCatalog.photo(id, route: 29) ?? SourceReferenceCatalog.photo(id, route: 26) ?? fixture
            return DemoPhoto(id: id, asset: sharingPhotoAssets[id] ?? source.asset, tags: source.tags, ratio: source.ratio)
        }
    }
    var sharingPeople: [DemoPerson] { people.filter { sharePersonIDs.contains($0.id) } }
    var matchingPhotos: [DemoPhoto] { (1...12).map { SourceReferenceCatalog.photo($0, route: 29) ?? SourceReferenceCatalog.photo($0, route: 26) ?? DemoPhoto.all[$0 - 1] } }
    var searchResults: [DemoPhoto] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var photos = DemoPhoto.all
        if searchCategory == "Favorites" { photos = photos.filter { favoriteIDs.contains($0.id) } }
        if searchCategory == "People" { photos = photos.filter { $0.tags.contains("people") || $0.tags.contains("friends") } }
        if searchCategory == "Places" { photos = photos.filter { $0.tags.contains("travel") } }
        if filtersApplied {
            if !filterPeople.isEmpty { photos = photos.filter { !$0.personIDs.isDisjoint(with: filterPeople) } }
            if filterDate != "Any date" { photos = photos.filter { $0.sampleDate == filterDate } }
            if filterLocation != "Any location" { photos = photos.filter { $0.location.localizedCaseInsensitiveContains(filterLocation) || $0.tags.localizedCaseInsensitiveContains(filterLocation) } }
            if filterMedia == "Videos" { photos = photos.filter { [6, 12, 16].contains($0.id) } }
            if filterMedia == "Live Photos" { photos = photos.filter { [1, 11, 17].contains($0.id) } }
        }
        if !text.isEmpty { photos = photos.filter { $0.tags.localizedCaseInsensitiveContains(text) } }
        return photos
    }

    func go(_ next: Screen, replace: Bool = false, simulateProgress: Bool = true) {
        progressTask?.cancel()
        if next == .shareReview || (screen == .shareReview && (next == .shareSelection || next == .peopleSelection)) { referenceReview33 = false }
        if !replace, next != screen { history.append(screen) }
        withAnimation(.easeInOut(duration: 0.2)) { screen = next }
        if simulateProgress {
            if next == .processing { startProgress(from: next, to: .setupComplete, seconds: 3) }
            if next == .uploadProgress { startProgress(from: next, to: .uploadComplete, seconds: 5) }
            if next == .sharingProgress { startProgress(from: next, to: .sharedHistory, seconds: 5) }
        }
    }

    func back() {
        progressTask?.cancel()
        let previous = history.popLast() ?? .home
        withAnimation(.easeInOut(duration: 0.2)) { screen = previous }
    }

    func jump(_ next: Screen) {
        // Gallery fixtures reproduce the state depicted in the chosen reference.
        if next == .shareSelection { sharingPhotoAssets = [:]; sharePhotoIDs = SourceReferenceCatalog.selectedIDs(29) ?? [1, 2, 4, 5, 6, 7, 8, 9] }
        if next == .deselectPhotos { sharingPhotoAssets = [:]; sharePhotoIDs = SourceReferenceCatalog.selectedIDs(30) ?? [1, 4, 6, 8, 9, 11] }
        if next == .peopleSelection { sharePersonIDs = [1, 2, 3, 5, 7] }
        if next == .deselectPeople { sharePersonIDs = [1, 5, 7] }
        if next == .shareReview { sharingPhotoAssets = [:]; sharePhotoIDs = Set(SourceReferenceCatalog.layout(33)?.tiles.map(\.id) ?? [1, 4, 6, 8, 9, 11]); sharePersonIDs = [1, 5, 7] }
        if next == .uploadSelection { uploadPhotoAssets = [:]; uploadIDs = SourceReferenceCatalog.selectedIDs(21) ?? Set(1...12) }
        if next == .favorites, let selected = SourceReferenceCatalog.selectedIDs(14) { favoriteIDs = selected }
        if next == .faceEnrollment { captures = 0 }
        if next == .personPhotos { currentPerson = people[0] }
        if next == .photoViewer { currentPhoto = DemoPhoto.all[0]; favoriteIDs.remove(1) }
        if next == .processing { progress = 0.83 }
        if next == .uploadProgress { progress = 0 }
        if next == .sharingProgress { progress = 0.62 }
        showGallery = false
        go(next, simulateProgress: false)
        if next == .shareReview { referenceReview33 = true }
    }

    func openPhoto(_ photo: DemoPhoto, destination: Screen = .photoViewer) { currentPhoto = photo; go(destination) }
    func openPerson(_ person: DemoPerson) { currentPerson = person; go(.personPhotos) }
    func toggleFavorite(_ id: Int) { if favoriteIDs.contains(id) { favoriteIDs.remove(id) } else { favoriteIDs.insert(id) } }
    func toggleUpload(_ id: Int) { if uploadIDs.contains(id) { uploadIDs.remove(id) } else { uploadIDs.insert(id) } }
    func toggleSharePhoto(_ id: Int) { referenceReview33 = false; if sharePhotoIDs.contains(id) { sharePhotoIDs.remove(id) } else { sharePhotoIDs.insert(id) } }
    func toggleUpload(_ photo: DemoPhoto) { uploadPhotoAssets[photo.id] = photo.asset; toggleUpload(photo.id) }
    func toggleSharePhoto(_ photo: DemoPhoto) { sharingPhotoAssets[photo.id] = photo.asset; toggleSharePhoto(photo.id) }
    func beginSharing(_ photo: DemoPhoto) { sharingPhotoAssets = [photo.id: photo.asset]; sharePhotoIDs = [photo.id] }
    func toggleSharePerson(_ id: Int) { referenceReview33 = false; if sharePersonIDs.contains(id) { sharePersonIDs.remove(id) } else { sharePersonIDs.insert(id) } }
    func capture() { captures += 1; if captures >= 3 { go(.processing) } }
    func preference(_ key: String) -> Binding<Bool> {
        Binding(get: { self.preferences[key, default: false] }, set: { self.preferences[key] = $0 })
    }
    func resetFilters() { filterPeople = []; filterDate = "Any date"; filterLocation = "Any location"; filterMedia = "Photos"; searchCategory = ""; filtersApplied = false }

    private func startProgress(from route: Screen, to next: Screen, seconds: Double) {
        progress = 0
        progressTask = Task { [weak self] in
            for step in 1...40 {
                do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000 / 40)) } catch { return }
                guard let self, !Task.isCancelled, self.screen == route else { return }
                self.progress = Double(step) / 40
            }
            guard let self, !Task.isCancelled, self.screen == route else { return }
            if route == .sharingProgress { self.shared = true }
            self.go(next, replace: true)
        }
    }
}
