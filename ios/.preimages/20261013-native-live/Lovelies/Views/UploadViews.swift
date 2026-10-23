import SwiftUI

struct UploadViews: View {
    @EnvironmentObject private var store: DemoStore
    let screen: Screen
    @State private var picker: UploadPicker?
    @State private var cancelUpload = false
    private enum UploadPicker: String, Identifiable { case album, visibility; var id: String { rawValue } }
    private let sources = [
        ("From This Device", "Browse your photos", "iphone"),
        ("From Albums", "Choose specific albums", "rectangle.stack"),
        ("From Files", "Import from your files", "doc"),
        ("Take a Photo", "Use your camera", "camera")
    ]

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
            VStack(spacing: 20) {
                PageHeader(title: "Add Photos", close: true, trailing: false)
                Spacer(minLength: 0)
                Button { store.go(.uploadSource) } label: { PhotoHeart(size: min(215, geometry.size.width * 0.58)) }.accessibilityLabel("Choose photo source")
                Text("Add your photos\nto find their people.").font(.system(size: 19, weight: .medium)).multilineTextAlignment(.center).lineSpacing(3)
                Spacer(minLength: 0)
                HStack(alignment: .top, spacing: 12) {
                    uploadQuickAction("Device", icon: "photo", selected: true, source: "From This Device")
                    uploadQuickAction("Albums", icon: "rectangle.stack", source: "From Albums")
                    uploadQuickAction("Files", icon: "doc", source: "From Files")
                    uploadQuickAction("Camera", icon: "camera", source: "Take a Photo")
                }.padding(.horizontal, 18).padding(.bottom, 17)
            }.foregroundStyle(.white)
        }
    }

    private func uploadQuickAction(_ title: String, icon: String, selected: Bool = false, source: String) -> some View {
        Button { store.uploadSource = source; store.go(.uploadSource) } label: {
            VStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 26, weight: .light)).frame(width: 64, height: 64)
                    .background(selected ? LoveliesTheme.pink : LoveliesTheme.surface, in: Circle())
                    .foregroundStyle(selected ? .white : .white.opacity(0.9))
                    .shadow(color: selected ? LoveliesTheme.pink.opacity(0.2) : .clear, radius: 16)
                Text(title).font(.system(size: 13)).foregroundStyle(selected ? LoveliesTheme.pink : .white)
            }.frame(maxWidth: .infinity)
        }.buttonStyle(.plain)
    }

    private var source: some View {
        VStack(spacing: 12) {
            PageHeader(title: "Choose Source", close: true, trailing: false)
            Spacer(minLength: 0)
            ForEach(sources, id: \.0) { item in
                Button { store.uploadSource = item.0; store.go(.uploadSelection) } label: {
                    HStack(spacing: 21) {
                        Image(systemName: item.2).font(.system(size: 33, weight: .light)).frame(width: 35)
                        VStack(alignment: .leading, spacing: 6) { Text(item.0).font(.system(size: 18, weight: .medium)); Text(item.1).font(.system(size: 14)).foregroundStyle(LoveliesTheme.secondary) }
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 17)).foregroundStyle(LoveliesTheme.secondary)
                    }.padding(.horizontal, 20).padding(.vertical, 14).frame(minHeight: 76).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 18)).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }.padding(.horizontal, 20).foregroundStyle(.white)
    }

    private var selection: some View {
        VStack(spacing: 13) {
            HStack {
                Button("Cancel") { store.go(.uploadEntry) }.font(.system(size: 15)).foregroundStyle(LoveliesTheme.pink)
                Spacer()
                Text("\(store.uploadIDs.count) selected").font(.system(size: 17, weight: .semibold))
                Spacer()
                Button { store.go(.uploadReview) } label: {
                    Text("Next").font(.system(size: 15, weight: .medium)).foregroundStyle(LoveliesTheme.pink.opacity(store.uploadIDs.isEmpty ? 0.35 : 1))
                        .padding(.horizontal, 14).padding(.vertical, 10).background(LoveliesTheme.surface, in: Capsule())
                }.disabled(store.uploadIDs.isEmpty)
            }.padding(.horizontal, 19).padding(.vertical, 7)
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
            PageHeader(title: "Review Upload", trailing: false)
            ScrollView {
                VStack(spacing: 16) {
                    HStack(spacing: 7) {
                        ForEach(Array(store.uploadPhotos.prefix(5))) { photo in
                            Button { store.openPhoto(photo) } label: { AssetImage(name: photo.asset).scaledToFill().frame(height: 73).clipped().clipShape(RoundedRectangle(cornerRadius: 10)) }.buttonStyle(.plain).frame(maxWidth: .infinity)
                        }
                        if store.uploadPhotos.count > 5 {
                            Button { store.go(.uploadSelection) } label: { Text("+\(store.uploadPhotos.count - 5)").font(.system(size: 17, weight: .medium)).frame(width: 57, height: 73).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 10)) }.accessibilityLabel("Edit selected photos")
                        }
                    }
                    TextField("Add a caption (optional)", text: $store.caption, axis: .vertical).font(.system(size: 15)).padding(17)
                        .background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 14)).lineLimit(1...3)
                    GroupSurface { SettingsRow(icon: "photo", title: "Add to album", value: store.album) { picker = .album } }
                    GroupSurface { SettingsRow(icon: "lock", title: "Who can see these?", value: store.visibility) { picker = .visibility } }
                }.padding(.horizontal, 21).padding(.top, 8)
            }.scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
            PinkButton(title: "Start Upload", enabled: !store.uploadIDs.isEmpty) { store.go(.uploadProgress) }.padding(.horizontal, 21).padding(.bottom, 17)
        }.foregroundStyle(.white)
            .sheet(item: $picker) { value in
                DemoSheet(title: value == .album ? "Add to album" : "Photo visibility") {
                    ForEach(value == .album ? ["Travels 2024", "Summer memories", "Friends & family", "No album"] : ["Matched people only", "Only me", "Allowed people"], id: \.self) { choice in
                        Button {
                            if value == .album { store.album = choice } else { store.visibility = choice }
                            picker = nil
                        } label: {
                            HStack { Text(choice); Spacer(); if (value == .album ? store.album : store.visibility) == choice { Image(systemName: "checkmark").foregroundStyle(LoveliesTheme.pink) } }.padding(.vertical, 12)
                        }.buttonStyle(.plain)
                    }
                }
            }
    }

    private var progress: some View {
        VStack(spacing: 12) {
            HStack {
                Button { cancelUpload = true } label: { Image(systemName: "xmark").font(.system(size: 22)).frame(width: 40, height: 40) }.accessibilityLabel("Cancel upload")
                Text("Uploading...").font(.system(size: 20, weight: .semibold)).frame(maxWidth: .infinity)
                Color.clear.frame(width: 40, height: 40)
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
                Text("IMG_\(2931 + index).\(index == 2 ? "MOV" : "JPG")").font(.system(size: 14))
                Text(value >= 1 ? "Complete" : value == 0 ? "Waiting..." : index == 2 ? "Processing..." : "Uploading... \(Int(value * 100))%")
                    .font(.system(size: 12)).foregroundStyle(LoveliesTheme.secondary)
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
            VStack(spacing: 16) {
                Spacer().frame(height: geometry.size.height * 0.06)
                AssetImage(name: "upload-hero").scaledToFit().frame(width: geometry.size.width * 0.716).accessibilityHidden(true)
                Text("Upload complete!").font(.system(size: 23, weight: .medium))
                Text("\(store.uploadIDs.count) photos added to your library\nand ready to find their people.").font(.system(size: 16)).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                PinkButton(title: "View in Library") { store.go(.allPhotos) }.padding(.top, 5)
                Spacer(minLength: 15)
                HStack { Text("Recent Uploads").font(.system(size: 17, weight: .medium)); Spacer(); Button { store.go(.uploadSelection) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("View recent uploads") }
                HStack(spacing: 7) {
                    ForEach(Array(store.uploadPhotos.prefix(5))) { photo in
                        Button { store.openPhoto(photo) } label: { AssetImage(name: photo.asset).scaledToFill().frame(height: 55).clipped().clipShape(RoundedRectangle(cornerRadius: 8)) }.buttonStyle(.plain).frame(maxWidth: .infinity)
                    }
                    Image(systemName: "chevron.right").font(.system(size: 16)).foregroundStyle(LoveliesTheme.secondary)
                }
                HStack { Text("Just now  ·  \(store.uploadIDs.count) photos").font(.system(size: 13)).foregroundStyle(LoveliesTheme.secondary); Spacer() }.padding(.bottom, 12)
            }.padding(.horizontal, 22).frame(maxWidth: .infinity).foregroundStyle(.white)
        }
    }
}
