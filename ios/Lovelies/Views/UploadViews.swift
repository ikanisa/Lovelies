import SwiftUI

enum LoveliesUploadSource: String, Identifiable {
    case device, googlePhotos, iCloudPhotos, googleDrive, dropbox, oneDrive, albums, files, camera
    var id: String { rawValue }
    static let groups: [(title: String, sources: [LoveliesUploadSource])] = [
        (String(localized: "Photo libraries"), [.device, .googlePhotos, .iCloudPhotos]),
        (String(localized: "Cloud storage"), [.googleDrive, .dropbox, .oneDrive]),
        (String(localized: "More ways"), [.albums, .files, .camera])
    ]
    var title: String {
        switch self {
        case .device: return String(localized: "From This Device")
        case .googlePhotos: return "Google Photos"
        case .iCloudPhotos: return "iCloud Photos"
        case .googleDrive: return "Google Drive"
        case .dropbox: return "Dropbox"
        case .oneDrive: return "OneDrive"
        case .albums: return String(localized: "From Albums")
        case .files: return String(localized: "From Files")
        case .camera: return String(localized: "Take a Photo")
        }
    }
    var detail: String {
        switch self {
        case .device: return String(localized: "Browse your photos")
        case .googlePhotos: return String(localized: "Save to Apple Photos first")
        case .iCloudPhotos: return String(localized: "Choose in Apple Photos")
        case .googleDrive, .dropbox, .oneDrive: return String(localized: "Choose from enabled Files locations")
        case .albums: return String(localized: "Choose specific albums")
        case .files: return String(localized: "Import from your files")
        case .camera: return String(localized: "Use your camera")
        }
    }
    var icon: String {
        switch self {
        case .device: return "iphone"
        case .googlePhotos: return "photo.on.rectangle"
        case .iCloudPhotos: return "icloud"
        case .googleDrive: return "externaldrive"
        case .dropbox: return "shippingbox"
        case .oneDrive: return "cloud"
        case .albums: return "rectangle.stack"
        case .files: return "doc"
        case .camera: return "camera"
        }
    }
    var needsGuidance: Bool { [.googlePhotos, .googleDrive, .dropbox, .oneDrive].contains(self) }
    var usesFiles: Bool { [.files, .googleDrive, .dropbox, .oneDrive].contains(self) }
}

struct UploadViews: View {
    @EnvironmentObject private var store: DemoStore
    let screen: Screen
    @State private var picker: UploadPicker?
    @State private var cancelUpload = false
    private enum UploadPicker: String, Identifiable { case album, visibility; var id: String { rawValue } }

    @ViewBuilder var body: some View {
        switch screen {
        case .uploadEntry: entry
        case .uploadSource: source
        case .uploadSelection: selection
        case .uploadReview: review
        case .uploadProgress: progress
        default: complete
        }
    }

    private var entry: some View {
        GeometryReader { geometry in
            ScrollView {
            VStack(spacing: 20) {
                PageHeader(title: String(localized: "Add Photos"), close: true, trailing: false)
                Spacer(minLength: 0)
                Button { store.go(.uploadSource) } label: { PhotoHeart(size: min(215, geometry.size.width * 0.58)) }.accessibilityLabel("Choose photo source")
                Text("Add your photos\nto find their people.").loveliesFont(size: 19, weight: .medium).multilineTextAlignment(.center).lineSpacing(3)
                Spacer(minLength: 0)
                AdaptiveActions {
                    uploadQuickAction("Device", icon: "photo", selected: true, source: "From This Device")
                    uploadQuickAction("Albums", icon: "rectangle.stack", source: "From Albums")
                    uploadQuickAction("Files", icon: "doc", source: "From Files")
                    uploadQuickAction("Camera", icon: "camera", source: "Take a Photo")
                }.padding(.horizontal, 18).padding(.bottom, 17)
            }.foregroundStyle(.white)
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }

    private func uploadQuickAction(_ title: String, icon: String, selected: Bool = false, source: String) -> some View {
        Button { store.uploadSource = source; store.go(.uploadSource) } label: {
            VStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 26, weight: .light)).frame(width: 64, height: 64)
                    .background(selected ? LoveliesTheme.pink : LoveliesTheme.surface, in: Circle())
                    .foregroundStyle(selected ? .white : .white.opacity(0.9))
                    .shadow(color: selected ? LoveliesTheme.pink.opacity(0.2) : .clear, radius: 16)
                Text(LocalizedStringKey(title)).loveliesFont(size: 13).foregroundStyle(selected ? LoveliesTheme.pink : .white)
            }.frame(maxWidth: .infinity)
        }.buttonStyle(LoveliesPressStyle())
    }

    private var source: some View {
        VStack(spacing: 12) {
            PageHeader(title: String(localized: "Choose Source"), close: true, trailing: false)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Preview uses sample photos. No cloud accounts are connected.")
                        .loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
                    ForEach(LoveliesUploadSource.groups, id: \.title) { group in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(group.title).loveliesFont(size: 13, weight: .medium).foregroundStyle(LoveliesTheme.secondary).padding(.leading, 3)
                            ForEach(group.sources) { item in
                                Button { store.uploadSource = item.title; store.go(.uploadSelection) } label: {
                                    HStack(spacing: 18) {
                                        Image(systemName: item.icon).font(.system(size: 29, weight: .light)).frame(width: 35).accessibilityHidden(true)
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(item.title).loveliesFont(size: 18, weight: .medium)
                                            Text(item.detail).loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary)
                                        }.fixedSize(horizontal: false, vertical: true)
                                        Spacer(minLength: 4)
                                        Image(systemName: "chevron.right").font(.system(size: 16)).foregroundStyle(LoveliesTheme.secondary).accessibilityHidden(true)
                                    }.padding(.horizontal, 18).padding(.vertical, 14).frame(minHeight: 76).frame(maxWidth: .infinity, alignment: .leading)
                                        .background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 18)).contentShape(Rectangle())
                                }.buttonStyle(LoveliesPressStyle())
                            }
                        }
                    }
                }.padding(.top, 4).padding(.bottom, 18)
            }.scrollIndicators(.visible)
        }.padding(.horizontal, 20).foregroundStyle(.white)
    }

    private var selection: some View {
        VStack(spacing: 13) {
            HStack {
                Button("Cancel") { store.go(.uploadEntry) }.font(.body).frame(minHeight: 44).foregroundStyle(LoveliesTheme.pink)
                Spacer()
                Text("\(store.uploadIDs.count) selected").loveliesFont(size: 17, weight: .semibold)
                Spacer()
                Button { store.go(.uploadReview) } label: {
                    Text("Next").loveliesFont(size: 15, weight: .medium).foregroundStyle(LoveliesTheme.pink.opacity(store.uploadIDs.isEmpty ? 0.35 : 1))
                        .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 44).background(LoveliesTheme.surface, in: Capsule())
                }.disabled(store.uploadIDs.isEmpty)
            }.padding(.horizontal, 19).padding(.vertical, 7)
            Text("\(NSLocalizedString(store.uploadSource, comment: "App-owned upload source label")) · Sample photos").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 19)
            ScrollView {
                if SourceReferenceCatalog.layout(21) != nil {
                    SourcePhotoGrid(route: 21, selection: store.uploadIDs, badge: .check, badgeAction: { store.toggleUpload($0) }) { store.toggleUpload($0) }.padding(.horizontal, 11).padding(.bottom, 12)
                } else {
                    MasonryPhotos(photos: uploadOrder, columns: 4, selected: store.uploadIDs, showOnlySelectedBadges: true) { store.toggleUpload($0.id) }
                        .padding(.horizontal, 11).padding(.bottom, 12)
                }
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
    }
    private var uploadOrder: [DemoPhoto] { [1, 7, 16, 6, 3, 5, 9, 10, 11, 8, 4, 13, 17, 12, 2, 14, 18, 15].map { DemoPhoto.all[$0 - 1] } }

    private var review: some View {
        VStack(spacing: 16) {
            PageHeader(title: String(localized: "Review Upload"), trailing: false)
            Text("\(NSLocalizedString(store.uploadSource, comment: "App-owned upload source label")) · Sample photos").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 21)
            ScrollView {
                VStack(spacing: 16) {
                    HStack(spacing: 7) {
                        ForEach(Array(store.uploadPhotos.prefix(5))) { photo in
                            Button { store.openPhoto(photo) } label: { AssetImage(name: photo.asset).scaledToFill().frame(height: 73).clipped().clipShape(RoundedRectangle(cornerRadius: 10)) }.buttonStyle(LoveliesPressStyle()).frame(maxWidth: .infinity).accessibilityLabel("Photo \(photo.id)")
                        }
                        if store.uploadPhotos.count > 5 {
                            Button { store.go(.uploadSelection) } label: { Text("+\(store.uploadPhotos.count - 5)").loveliesFont(size: 17, weight: .medium).frame(width: 57, height: 73).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 10)) }.accessibilityLabel("Edit selected photos")
                        }
                    }
                    TextField("Add a caption (optional)", text: $store.caption, axis: .vertical).loveliesFont(size: 15).padding(17)
                        .background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 14)).lineLimit(1...3)
                    GroupSurface { SettingsRow(icon: "photo", title: String(localized: "Add to album"), value: store.album) { picker = .album } }
                    GroupSurface { SettingsRow(icon: "lock", title: String(localized: "Who can see these?"), value: NSLocalizedString(store.visibility, comment: "App-owned photo visibility option")) { picker = .visibility } }
                }.padding(.horizontal, 21).padding(.top, 8)
            }.scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
            PinkButton(title: String(localized: "Start Upload"), enabled: !store.uploadIDs.isEmpty) { store.go(.uploadProgress) }.padding(.horizontal, 21).padding(.bottom, 17)
        }.foregroundStyle(.white)
            .sheet(item: $picker) { value in
                DemoSheet(title: value == .album ? String(localized: "Add to album") : String(localized: "Photo visibility")) {
                    ForEach(value == .album ? ["Travels 2024", "Summer memories", "Friends & family", "No album"] : ["Matched people only", "Only me", "Allowed people"], id: \.self) { choice in
                        Button {
                            if value == .album { store.album = choice } else { store.visibility = choice }
                            picker = nil
                        } label: {
                            HStack { Text(value == .album ? (choice == "No album" ? String(localized: "No album") : choice) : NSLocalizedString(choice, comment: "App-owned photo visibility option")); Spacer(); if (value == .album ? store.album : store.visibility) == choice { Image(systemName: "checkmark").foregroundStyle(LoveliesTheme.pink) } }.padding(.vertical, 12)
                        }.buttonStyle(LoveliesPressStyle())
                    }
                }
            }
    }

    private var progress: some View {
        VStack(spacing: 12) {
            HStack {
                Button { cancelUpload = true } label: { Image(systemName: "xmark").font(.system(size: 22)).frame(width: 44, height: 44) }.accessibilityLabel("Cancel upload")
                Text("Uploading...").loveliesFont(size: 20, weight: .semibold).frame(maxWidth: .infinity)
                Color.clear.frame(width: 44, height: 44)
            }.padding(.horizontal, 18).padding(.top, 4)
            ScrollView {
                VStack(spacing: 12) {
                    ForEach(Array(store.uploadPhotos.enumerated()), id: \.element.id) { index, photo in uploadProgressRow(photo, index: index) }
                }.padding(.horizontal, 21)
            }.scrollIndicators(.hidden)
        }.foregroundStyle(.white)
            .alert("Pause this sample upload?", isPresented: $cancelUpload) {
                Button("Keep uploading", role: .cancel) {}
                Button("Back to selection") { store.go(.uploadSelection) }
            } message: { Text("Your selected photos and caption will stay here. This upload is a local preview.") }
    }
    private func uploadProgressRow(_ photo: DemoPhoto, index: Int) -> some View {
        let baseline: Double = index == 0 ? 0.78 : index == 1 ? 0.42 : index == 2 ? 0.2 : 0
        let value = min(1, baseline + store.progress * (index < 3 ? 0.85 : 1.15))
        return HStack(spacing: 14) {
            AssetImage(name: photo.asset).scaledToFill().frame(width: 58, height: 60).clipped().clipShape(RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 6) {
                Text("IMG_\(2931 + index).\(index == 2 ? "MOV" : "JPG")").loveliesFont(size: 14)
                Text(value >= 1 ? String(localized: "Complete") : value == 0 ? String(localized: "Waiting...") : index == 2 ? String(localized: "Processing...") : String(localized: "Uploading... \(Int(value * 100))%"))
                    .loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary)
                GeometryReader { geometry in
                    ZStack(alignment: .leading) { Capsule().fill(.white.opacity(0.12)); Capsule().fill(LoveliesTheme.pink).frame(width: geometry.size.width * value) }
                }.frame(height: 5)
            }
            Spacer(minLength: 4)
            ZStack {
                Circle().stroke(.white.opacity(0.35), lineWidth: 1.5)
                if value >= 1 { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(LoveliesTheme.pink) }
                else if value > 0 { Circle().trim(from: 0, to: value).stroke(LoveliesTheme.pink, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90)) }
            }.frame(width: 23, height: 23)
        }
    }

    private var complete: some View {
        GeometryReader { geometry in
            ScrollView {
            VStack(spacing: 16) {
                PageHeader(title: String(localized: "Upload Complete"), trailing: false)
                AssetImage(name: "upload-hero").scaledToFit().frame(width: min(300, geometry.size.width * 0.716)).accessibilityHidden(true)
                Text("Upload complete!").loveliesFont(size: 23, weight: .medium)
                Text("\(store.uploadIDs.count) photos added to your library\nand ready to find their people.").loveliesFont(size: 16).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                PinkButton(title: String(localized: "View in Library")) { store.go(.allPhotos) }.padding(.top, 5)
                Spacer(minLength: 15)
                HStack { Text("Recent Uploads").loveliesFont(size: 17, weight: .medium); Spacer(); Button { store.go(.uploadSelection) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }.accessibilityLabel("View recent uploads") }
                HStack(spacing: 7) {
                    ForEach(Array(store.uploadPhotos.prefix(5))) { photo in
                        Button { store.openPhoto(photo) } label: { AssetImage(name: photo.asset).scaledToFill().frame(height: 55).clipped().clipShape(RoundedRectangle(cornerRadius: 8)) }.buttonStyle(LoveliesPressStyle()).frame(maxWidth: .infinity).accessibilityLabel("Photo \(photo.id)")
                    }
                    Image(systemName: "chevron.right").font(.system(size: 16)).foregroundStyle(LoveliesTheme.secondary)
                }
                HStack { Text("Just now  ·  \(store.uploadIDs.count) photos").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary); Spacer() }.padding(.bottom, 12)
            }.padding(.horizontal, 22).frame(maxWidth: .infinity).foregroundStyle(.white)
        
                .frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }
}
