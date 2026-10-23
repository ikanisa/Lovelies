import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ImageIO

struct LiveUploadView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    let screen: Screen
    @State private var files = false
    @State private var photoRequest: ImportRequest?
    @State private var fileRequest: ImportRequest?
    @State private var sourceHelp: LoveliesUploadSource?
    @State private var pendingPicker: LoveliesUploadSource?
    @State private var cancelUploads = false
    private struct ImportRequest: Identifiable {
        let id = UUID()
        let source: LoveliesUploadSource
        let owner: NativeMediaCaptureContext
    }
    @ViewBuilder var body: some View {
        switch screen {
        case .uploadEntry, .uploadSource:
            VStack(spacing: 12) {
                PageHeader(title: screen == .uploadEntry ? "Add Photos" : "Choose Source", close: true)
                if let saved = live.uploadRecovery, !saved.batch.finished {
                    Button { live.showPhotoUploads() } label: { HStack { Image(systemName: "arrow.up.circle"); Text(saved.batch.started ? "Resume saved upload" : "Continue selected photos"); Spacer(); Image(systemName: "chevron.right") }.font(.system(size: 15)).padding(14).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 14)) }.buttonStyle(LoveliesPressStyle()).accessibilityLabel("Open saved upload")
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if screen == .uploadEntry {
                            HStack(spacing: 16) {
                                PhotoHeart(size: 74).accessibilityHidden(true)
                                Text("Add your photos\nto find their people.").loveliesFont(size: 19, weight: .medium)
                            }.frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 10)
                        }
                        ForEach(LoveliesUploadSource.groups, id: \.title) { group in
                            VStack(alignment: .leading, spacing: 10) {
                                Text(group.title).loveliesFont(size: 13, weight: .medium).foregroundStyle(LoveliesTheme.secondary).padding(.leading, 3)
                                ForEach(group.sources) { item in
                                    source(item.title, detail: item.detail, icon: item.icon) {
                                        if item.needsGuidance { sourceHelp = item }
                                        else { openPicker(item) }
                                    }.disabled(!live.canEdit)
                                }
                            }
                        }
                    }.padding(.top, 4).padding(.bottom, 18)
                }.scrollIndicators(.visible)
            }.padding(.horizontal, 20).foregroundStyle(.white)
            .sheet(item: $sourceHelp, onDismiss: {
                if let chosen = pendingPicker { pendingPicker = nil; openPicker(chosen) }
            }) { chosen in
                DemoSheet(title: chosen.title) {
                    if chosen == .googlePhotos {
                        Text("Save the photos you want from Google Photos to Apple Photos first. Then choose those saved photos in the Photos picker.")
                            .loveliesFont(size: 16).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                        PinkButton(title: "Continue to Photos") { pendingPicker = chosen; sourceHelp = nil }
                    } else {
                        Text("In Files, tap Browse and choose \(chosen.title) under Locations. Install its app, sign in and enable its location in Files if it is missing.")
                            .loveliesFont(size: 16).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                        PinkButton(title: "Open Files") { pendingPicker = chosen; sourceHelp = nil }
                    }
                    QuietButton(title: "Cancel") { sourceHelp = nil }
                }
            }
            .sheet(item: $photoRequest) { request in
                NativePhotoPicker(isCurrent: { live.photoImportIsCurrent(request.owner) }) { items, error in
                    if photoRequest?.id == request.id { photoRequest = nil }
                    live.acceptImports(items, failure: error, request: request.owner, pickerContext: request.source.title)
                }
            }
            .fileImporter(isPresented: $files, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
                guard let request = fileRequest else { return }
                fileRequest = nil
                guard live.photoImportIsCurrent(request.owner) else { return }
                switch result {
                case .failure(let error): live.error = error.localizedDescription
                case .success(let urls):
                    live.acceptFileImports(urls, request: request.owner, pickerContext: request.source.title)
                }
            }
        case .uploadSelection:
            VStack(spacing: 12) {
                PageHeader(title: "\(live.selectedImports.count) selected")
                importContext
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4), GridItem(.flexible())], spacing: 4) {
                        ForEach(live.imports) { item in
                            Button { live.toggleUploadPhoto(item.id) } label: {
                                NativeImportThumbnail(item: item).frame(height: 160).clipped().clipShape(RoundedRectangle(cornerRadius: 12))
                                    .overlay(alignment: .topTrailing) { CheckBadge(selected: live.selectedImports.contains(item.id), size: 26).padding(6) }
                            }.buttonStyle(LoveliesPressStyle()).accessibilityLabel(item.title.isEmpty ? "Imported photo" : item.title)
                                .accessibilityValue(live.selectedImports.contains(item.id) ? "Selected" : "Not selected")
                                .accessibilityAddTraits(live.selectedImports.contains(item.id) ? .isSelected : [])
                        }
                    }.padding(.horizontal, 8)
                }
                PinkButton(title: "Next", enabled: !live.selectedImports.isEmpty) { store.go(.uploadReview, simulateProgress: false) }.padding(18)
            }.foregroundStyle(.white)
        case .uploadReview:
            VStack(spacing: 16) {
                PageHeader(title: "Review Upload")
                importContext
                ScrollView {
                    VStack(spacing: 16) {
                    Text("JPEG, PNG and WebP keep their original bytes. Other supported still images are converted to JPEG and labelled before upload.")
                        .font(.footnote).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                    LazyVStack(spacing: 8) {
                        ForEach(live.imports.filter { live.selectedImports.contains($0.id) }) { item in
                            HStack(spacing: 13) { NativeImportThumbnail(item: item).frame(width: 67, height: 67).clipped().clipShape(RoundedRectangle(cornerRadius: 12)); Text(item.title).loveliesFont(size: 16); Spacer(); Button { live.toggleUploadPhoto(item.id) } label: { Image(systemName: "xmark.circle").frame(width: 48, height: 48) }.accessibilityLabel("Remove photo from upload") }.padding(10).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        }
                    }
                    TextField("Add a caption (optional)", text: Binding(get: { live.uploadCaption }, set: live.updateUploadCaption), axis: .vertical)
                        .loveliesFont(size: 15).padding(17).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 14)).lineLimit(1...3)
                Toggle("Allow processing of these photos to find their registered people", isOn: $live.processingConsent).loveliesFont(size: 14).tint(LoveliesTheme.pink)
                PinkButton(title: "Upload \(live.selectedImports.count) Photos", enabled: !live.selectedImports.isEmpty && live.canEdit) { live.upload() }
                    }
                }.scrollDismissesKeyboard(.interactively)
            }.padding(.horizontal, 18).padding(.bottom, 16).foregroundStyle(.white)
        case .uploadProgress:
            VStack(spacing: 16) {
                PageHeader(title: "Uploading")
                uploadRows
                Text(live.transferText).loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                AdaptiveActions {
                    if live.uploadRecovery?.batch.cancellationRequested == true {
                        QuietButton(title: "Back to photos") { store.go(.home, simulateProgress: false) }
                        if live.uploadRecovery?.batch.finished == false { QuietButton(title: "Check cancellation", enabled: !live.busy) { live.cancelPhotoUploads() } }
                    } else {
                        QuietButton(title: live.uploadRunning ? "Pause" : "Resume upload", enabled: live.uploadRunning || !live.busy) { if live.uploadRunning { live.pausePhotoUploads() } else { live.upload() } }
                        QuietButton(title: "Cancel pending", enabled: !live.busy || live.uploadRunning) { cancelUploads = true }
                    }
                }
            }.padding(.horizontal, 21).padding(.bottom, 16).foregroundStyle(.white)
                .alert("Cancel pending uploads?", isPresented: $cancelUploads) {
                    Button("Keep uploads", role: .cancel) {}
                    Button("Cancel pending", role: .destructive) { live.cancelPhotoUploads() }
                } message: { Text("This stops pending transfers. Photos already processing stay in your library. Sharing still requires your review and approval.") }
        default:
            VStack(spacing: 20) {
                PageHeader(title: "Upload received")
                Spacer(minLength: 0)
                AssetImage(name: "upload-hero").scaledToFit().frame(maxWidth: 250, maxHeight: 210)
                Text(live.transferText).loveliesFont(size: 19).multilineTextAlignment(.center)
                uploadRows
                PinkButton(title: "Check matching", enabled: !live.busy) { live.checkProcessing() }
                QuietButton(title: "Review matches", enabled: live.processingStatuses.values.contains("ready")) { live.beginReview(photoIDs: live.uploadedIDs.filter { live.processingStatuses[$0] == "ready" }) }
            }.padding(22).foregroundStyle(.white)

        }
    }
    @ViewBuilder private var importContext: some View {
        if let context = live.photoImportContext {
            Text("Picker opened from \(context)").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8)
        }
    }
    private func openPicker(_ source: LoveliesUploadSource) {
        if source == .camera { live.requestPhotoCamera(); return }
        guard let owner = live.beginPhotoImport() else { return }
        let request = ImportRequest(source: source, owner: owner)
        if source.usesFiles { fileRequest = request; files = true }
        else { photoRequest = request }
    }
    private var uploadRows: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if let batch = live.uploadRecovery?.batch {
                    ForEach(batch.selectedFiles) { item in
                        HStack(spacing: 14) {
                            if item.phase != .cancelled, let source = live.imports.first(where: { $0.id == item.id }) {
                                NativeImportThumbnail(item: source).frame(width: 58, height: 60).clipped().clipShape(RoundedRectangle(cornerRadius: 7))
                            } else {
                                Image(systemName: item.phase == .cancelled ? "xmark.circle" : "photo").font(.system(size: 27, weight: .light)).foregroundStyle(LoveliesTheme.secondary).frame(width: 58, height: 60)
                            }
                            VStack(alignment: .leading, spacing: 7) {
                                Text(item.title).loveliesFont(size: 14).lineLimit(2)
                                Text(uploadStatus(item, paused: batch.paused)).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary)
                                ProgressView(value: item.uploadProgress).tint(LoveliesTheme.pink).accessibilityLabel("Bytes received for " + item.title)
                                    .accessibilityValue("\(item.acknowledgedBytes) of \(item.byteSize) bytes")
                                if item.phase == .failed, item.received { Button("Retry processing") { live.retryUploadPhoto(item.id) }.loveliesFont(size: 13).foregroundStyle(LoveliesTheme.pink).frame(minHeight: 44).disabled(live.busy || live.uploadRunning) }
                            }
                        }.padding(.vertical, 6)
                    }
                }
            }
        }.scrollIndicators(.hidden)
    }
    private func uploadStatus(_ file: NativeResumableUploadFile, paused: Bool) -> String {
        switch file.phase {
        case .draft, .queued: return "Waiting"
        case .reserving: return "Checking original upload"
        case .uploading: return "\(Int(file.uploadProgress * 100))% received" + (paused ? " · Paused" : "")
        case .completing: return "Upload received · Starting processing"
        case .processing: return "Upload received · Processing"
        case .ready: return "Ready to review matches"
        case .failed: return file.discardedTerminalTransfer == true ? "Rejected source · Cancelled locally" : file.received ? "Processing failed · Retry available" : "Upload failed · Check status"
        case .cancelling: return "Checking cancellation"
        case .cancelled: return "Cancelled"
        }
    }
    private func source(_ title: String, detail: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { HStack(spacing: 18) { Image(systemName: icon).font(.system(size: 29, weight: .light)).frame(width: 35).accessibilityHidden(true); VStack(alignment: .leading, spacing: 5) { Text(title).loveliesFont(size: 18, weight: .medium); Text(detail).loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary) }.fixedSize(horizontal: false, vertical: true); Spacer(minLength: 4); Image(systemName: "chevron.right").font(.system(size: 16)).foregroundStyle(LoveliesTheme.secondary).accessibilityHidden(true) }.padding(.horizontal, 18).padding(.vertical, 14).frame(minHeight: 76).frame(maxWidth: .infinity, alignment: .leading).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 18)) }.buttonStyle(LoveliesPressStyle())
    }
}

struct NativeImportThumbnail: View {
    let item: NativeImport
    @State private var image: UIImage?
    var body: some View {
        ZStack { LoveliesTheme.surface; if let image { Image(uiImage: image).resizable().scaledToFill() } else { Image(systemName: "photo").foregroundStyle(LoveliesTheme.secondary) } }
            .task(id: item.id) {
                let data = await Task.detached { () -> Data? in
                    guard let source = CGImageSourceCreateWithURL(item.file as CFURL, nil), let image = CGImageSourceCreateThumbnailAtIndex(source, 0,
                        [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 600] as CFDictionary) else { return nil }
                    return UIImage(cgImage: image).pngData()
                }.value
                if !Task.isCancelled { image = data.flatMap(UIImage.init(data:)) }
            }.onDisappear { image = nil }
    }
}

struct LiveSharingView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    let screen: Screen
    @ViewBuilder var body: some View {
        if screen == .sharingProgress {
            LoveliesPage(spacing: 20) {
                PageHeader(title: "Sharing", close: true, trailing: false)
                AssetImage(name: "sharing-hero").scaledToFit().frame(maxWidth: 240, maxHeight: 240).accessibilityHidden(true)
                Text("Submitting your reviewed selection…").font(.title2.weight(.medium)).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
                ProgressView().tint(LoveliesTheme.pink).accessibilityLabel("Share request in progress")
                Text("Leaving keeps the original request. Photo access still requires confirmation and recipient acceptance.").font(.body).foregroundStyle(LoveliesTheme.secondary)
            }.foregroundStyle(.white)
        } else if screen == .sharedHistory { LiveInboxView() }
        else if screen == .incorrectMatch {
                LoveliesPage(spacing: 20) { PageHeader(title: "Not Me"); Text("Exclude this photo/person pair before sharing.").foregroundStyle(LoveliesTheme.secondary); if let photo = live.currentPhoto, let person = live.currentPerson { ProtectedNativePhoto(photo: photo).frame(height: 260).clipped().clipShape(RoundedRectangle(cornerRadius: 18)); PinkButton(title: "Exclude this match") { live.togglePair(photo: photo.id, person: person.id); store.back() }; QuietButton(title: "Report incorrect match", enabled: live.canEdit) { live.reportCurrentPair() } } }.foregroundStyle(.white)
        } else if let snapshot = live.snapshot, let draft = live.draft {
            VStack(spacing: 10) {
                PageHeader(title: title, subtitle: "\(Set(live.effective.map(\.asset_id)).count) photos · \(live.subsets.count) people")
                if snapshot.limited { Text("This review covers \(snapshot.photos.count) photos. Choose another group to review more.").loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary).padding(.horizontal, 18) }
                ScrollView {
                    if screen == .shareReview { finalReview(snapshot, draft) }
                    else if screen == .peopleSelection || screen == .deselectPeople || screen == .photoPeople { people(snapshot, draft) }
                    else {
                        let photos = screen == .personPhotos ? snapshot.photos.filter { photo in snapshot.pairs.contains { $0.asset_id == photo.id && $0.recipient_id == live.currentPerson?.id } } : snapshot.photos
                        LivePhotoGrid(photos: photos, selection: screen == .personPhotos ? Set(live.effective.filter { $0.recipient_id == live.currentPerson?.id }.map(\.asset_id)) : draft.selectedPhotos) { photo in
                            if screen == .personPhotos, let person = live.currentPerson { live.togglePair(photo: photo.id, person: person.id) }
                            else { live.togglePhoto(photo.id) }
                        }.padding(.horizontal, 8)
                    }
                }
                if screen == .shareReview {
                    PinkButton(title: "Share", enabled: !live.effective.isEmpty && live.preview != nil && live.canEdit) { live.share() }.padding(.horizontal, 18).padding(.bottom, 12)
                } else {
                    HStack {
                        Menu { Button("Select all") { live.edit { $0.selectedPhotos = Set(snapshot.photos.map(\.id)) } }; Button("Deselect all photos") { live.edit { $0.selectedPhotos = [] } }; Button("Deselect people") { store.go(.deselectPeople, simulateProgress: false) } } label: { Image(systemName: "square.and.arrow.up").frame(width: 48, height: 48) }
                        Spacer(); Text("\(Set(live.effective.map(\.asset_id)).count) selected").loveliesFont(size: 15).foregroundStyle(LoveliesTheme.secondary); Spacer()
                        Button {
                            if [.peopleSelection, .deselectPeople, .photoPeople].contains(screen) { live.prepareReview() }
                            else { store.go(.peopleSelection, simulateProgress: false) }
                        } label: { Image(systemName: "arrow.right").font(.system(size: 25)).foregroundStyle(.black).frame(width: 57, height: 50).background(LoveliesTheme.pink, in: Capsule()) }.disabled(live.effective.isEmpty || !live.canEdit).accessibilityLabel("Continue")
                    }.padding(10).background(.ultraThinMaterial, in: Capsule()).overlay(Capsule().stroke(LoveliesTheme.stroke)).padding(.horizontal, 12)
                }
            }.foregroundStyle(.white)
        } else {
            LoveliesPage(spacing: 20) { PageHeader(title: title); AssetImage(name: "matches-hero").scaledToFit().frame(maxWidth: 180, maxHeight: 180).accessibilityHidden(true); Text("Review the people in your photos").loveliesFont(size: 22, weight: .medium).multilineTextAlignment(.center); PinkButton(title: "Find current matches", enabled: live.canEdit) { live.beginReview() } }.foregroundStyle(.white)
        }
    }
    private var title: String { screen == .photoPeople ? "People in This Photo" : screen == .personPhotos ? (live.currentPerson?.name ?? "Matched photos") : screen == .peopleSelection ? "Choose People to Share With" : screen == .deselectPeople ? "Deselect People" : screen == .shareReview ? "Review & Share" : screen == .deselectPhotos ? "Deselect Photos" : "Select Photos to Share" }
    private func people(_ snapshot: NativeSnapshot, _ draft: NativeShareDraft) -> some View {
        LazyVStack(spacing: 5) {
            ForEach(snapshot.people) { person in
                HStack(spacing: 13) {
                    Button { live.currentPerson = person; store.go(.personPhotos, simulateProgress: false) } label: {
                        HStack { NativePersonAvatar(person: person); VStack(alignment: .leading, spacing: 4) { Text(person.name.isEmpty ? "Matched person" : person.name).loveliesFont(size: 16, weight: .medium); Text("\(snapshot.pairs.filter { $0.recipient_id == person.id }.count) matched photos").loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary) } }
                    }.buttonStyle(LoveliesPressStyle())
                    Spacer()
                    Button {
                        if screen == .photoPeople, let photo = live.currentPhoto { live.togglePair(photo: photo.id, person: person.id) }
                        else { live.togglePerson(person.id) }
                    } label: {
                        let selected = !live.blockedPersonIDs.contains(person.id) && (screen == .photoPeople && live.currentPhoto != nil ? !draft.excludedPairs.contains(NativePair(asset: live.currentPhoto!.id, recipient: person.id)) && draft.selectedPhotos.contains(live.currentPhoto!.id) && draft.selectedPeople.contains(person.id) : draft.selectedPeople.contains(person.id))
                        CheckBadge(selected: selected, size: 28).frame(width: 48, height: 48)
                    }.disabled(!live.canEdit || live.blockedPersonIDs.contains(person.id)).accessibilityLabel(live.blockedPersonIDs.contains(person.id) ? "\(person.name) is blocked" : "Include \(person.name)")
                        .accessibilityValue(draft.selectedPeople.contains(person.id) && !live.blockedPersonIDs.contains(person.id) ? "Selected" : "Not selected")
                }.padding(12).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }
        }.padding(.horizontal, 14)
    }
    private func finalReview(_ snapshot: NativeSnapshot, _ draft: NativeShareDraft) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("Photos").loveliesFont(size: 17, weight: .semibold); Spacer(); QuietButton(title: "Edit") { store.go(.shareSelection, simulateProgress: false) }.frame(width: 70) }
            LivePhotoGrid(photos: snapshot.photos.filter { photo in live.effective.contains { $0.asset_id == photo.id } }) { live.currentPhoto = $0; store.go(.photoViewer, simulateProgress: false) }
            HStack { Text("People").loveliesFont(size: 17, weight: .semibold); Spacer(); QuietButton(title: "Edit") { store.go(.peopleSelection, simulateProgress: false) }.frame(width: 70) }
            ForEach(snapshot.people.filter { live.subsets[$0.id] != nil }) { person in
                VStack(alignment: .leading, spacing: 9) {
                    HStack { NativePersonAvatar(person: person, size: 40); Text(person.name); Spacer(); Text("\(live.subsets[person.id]?.count ?? 0) photos").foregroundStyle(LoveliesTheme.secondary) }
                    ScrollView(.horizontal) { HStack(spacing: 5) { ForEach(snapshot.photos.filter { live.subsets[person.id]?.contains($0.id) == true }) { photo in ProtectedNativePhoto(photo: photo, pixels: 300).frame(width: 65, height: 79).clipped().clipShape(RoundedRectangle(cornerRadius: 12)) } } }
                }.padding(12).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }
            Text("Only these exact subsets will be requested. Recipients must accept before access is granted.").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
        }.padding(.horizontal, 18).padding(.bottom, 18)
    }
}

struct NativePersonAvatar: View {
    let person: NativePerson
    var size: CGFloat = 45
    var body: some View { Text(person.name.isEmpty ? "?" : String(person.name.prefix(1))).loveliesFont(size: size * 0.4, weight: .medium).foregroundStyle(LoveliesTheme.pink).frame(width: size, height: size).background(LoveliesTheme.raised, in: Circle()).overlay(Circle().stroke(LoveliesTheme.pink.opacity(0.4))) }
}

struct LiveInboxView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    var body: some View {
        VStack(spacing: 10) {
            PageHeader(title: store.screen == .sharedHistory ? "Shared History" : "Activity")
            ScrollView {
                LazyVStack(spacing: 8) {
                    if let outcome = live.outcome { Text(outcome["status"].string == "pending_acceptance" ? "Requests submitted · awaiting recipient acceptance" : (outcome["status"].string ?? "Result not confirmed")).loveliesFont(size: 16, weight: .medium).padding(16).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16)) }
                    ForEach(Array((store.screen == .sharedHistory ? live.outgoing : live.inbox).enumerated()), id: \.offset) { _, item in
                        Button { if let id = item["id"].string { live.openReceipt(id) } } label: {
                            HStack { Image(systemName: "person.crop.circle").font(.system(size: 36)); VStack(alignment: .leading, spacing: 4) { Text(item["person"]["name"].string ?? "Photo request"); Text("\(item["photo_count"].integer ?? 0) photos · \(item["status"].string ?? "unavailable")").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary); Text("\(item["available_count"].integer ?? 0) currently available").loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary) }; Spacer(); Image(systemName: "chevron.right") }.padding(14).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        }.buttonStyle(LoveliesPressStyle())
                    }
                    if (store.screen == .sharedHistory ? live.outgoing : live.inbox).isEmpty { Text("No photo requests yet").foregroundStyle(LoveliesTheme.secondary).padding(40) }
                }.padding(.horizontal, 14)
            }.refreshable { do { if store.screen == .sharedHistory { try await live.loadOutgoing() } else { try await live.loadInbox() } } catch { live.error = error.localizedDescription } }
            BottomNavigation(active: .newMatches)
        }.foregroundStyle(.white).onAppear { if !live.busy { if store.screen == .sharedHistory { live.refreshOutgoing() } else { live.refreshInbox() } } }
            .sheet(isPresented: Binding(get: { live.receipt != nil }, set: { if !$0 { live.receipt = nil; live.pendingReceiptID = nil } })) {
                VStack(spacing: 18) {
                    Text(live.receipt?["person"]["name"].string ?? "Photo request").loveliesFont(size: 22, weight: .semibold)
                    Text("\(live.receipt?["photo_count"].integer ?? 0) reviewed photos").foregroundStyle(LoveliesTheme.secondary)
                    Text(live.receipt?["status"].string ?? "Unavailable")
                    if live.receipt?["status"].string == "requested", live.receipt?["sender"].bool == false {
                        PinkButton(title: "Accept", enabled: live.canEdit) { live.decide("accept") }; QuietButton(title: "Decline", enabled: live.canEdit) { live.decide("decline") }
                    }
                    if live.receipt?["status"].string == "accepted" { PinkButton(title: "View received photos") { live.receipt = nil; store.go(.allPhotos, simulateProgress: false); live.reloadPhotos() }; QuietButton(title: "Revoke access", enabled: live.canEdit) { live.decide("revoke") } }
                    if live.receipt?["sender"].bool == true, live.receipt?["status"].string == "requested" { QuietButton(title: "Withdraw request", enabled: live.canEdit) { live.decide("withdraw") } }
                    Button("Close") { live.receipt = nil }.frame(minHeight: 48)
                }.padding(25).frame(maxWidth: .infinity, maxHeight: .infinity).background(LoveliesTheme.canvas).foregroundStyle(.white).presentationDetents([.medium, .large])
            }
    }
}

struct LiveNotificationsView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    var body: some View {
        VStack(spacing: 12) {
            PageHeader(title: "Notifications", trailing: true)
            ScrollView {
                LazyVStack(spacing: 8) {
                    if live.notifications.isEmpty { Text("No notifications yet").foregroundStyle(LoveliesTheme.secondary).padding(28) }
                    ForEach(Array(live.notifications.enumerated()), id: \.offset) { _, item in
                        Button {
                            if item["read_at"] == .null, let id = item["id"].string { live.readNotification(id) }
                            if let kind = item["kind"].string, let entity = item["entity_id"].string { NativePush.shared.queue(kind: kind, entity: entity) }
                        } label: {
                            HStack(spacing: 13) {
                                Image(systemName: item["kind"].string == "match" ? "person.2" : "bell").font(.system(size: 22)).foregroundStyle(LoveliesTheme.pink).frame(width: 45)
                                VStack(alignment: .leading, spacing: 5) { Text(item["title"].string ?? "Notification").loveliesFont(size: 16, weight: .medium); Text(item["created_at"].string ?? "").loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary) }
                                Spacer(); if item["read_at"] == .null { Circle().fill(LoveliesTheme.pink).frame(width: 8, height: 8) }
                            }.frame(minHeight: 56).padding(12).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        }.buttonStyle(LoveliesPressStyle()).disabled(!live.canEdit)
                    }
                    QuietButton(title: "Photo requests") { store.go(.activity, simulateProgress: false); live.refreshInbox() }
                }.padding(.horizontal, 16)
            }
            BottomNavigation(active: .newMatches)
        }.foregroundStyle(.white).onAppear { live.loadNotifications() }
    }
}

struct LiveSettingsView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    let screen: Screen
    @ViewBuilder var body: some View {
        if screen == .faceManagement || (live.faceLifecycle != nil && live.accountRecovery == nil && live.session?.authenticated != true) { LiveFaceProfileManagementView() }
        else if screen == .privacy && live.session?.authenticated != true { LiveGuestDeletionView() }
        else { VStack(spacing: 12) {
            PageHeader(title: screen == .profile ? "Profile" : screen.title, trailing: true)
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    if screen == .profile {
                        HStack { Image(systemName: "person.crop.circle").font(.system(size: 80)).foregroundStyle(LoveliesTheme.pink); VStack(alignment: .leading, spacing: 8) { Text(live.name.isEmpty ? "Your profile" : live.name).loveliesFont(size: 24, weight: .medium); Text(live.session?.authenticated == true ? "Registered face" : "Enrollment account").foregroundStyle(LoveliesTheme.secondary) } }
                        TextField("Your name", text: $live.name).padding(14).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 15))
                        PinkButton(title: "Save profile", enabled: live.canEdit) { live.saveProfile() }
                    }
                    if screen == .privacy || screen == .profile {
                        if screen == .privacy {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack { Text("Who can find you"); Spacer(); Text("Anyone").foregroundStyle(LoveliesTheme.secondary) }
                                Text("Registered people can find your face in matching photos when matching is enabled. Blocking excludes a person. Finding a match never grants photo access.")
                                    .loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
                            }.padding(16).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        }
                        Toggle("Find my face in matching photos", isOn: preference("photo_matching_consent", read: "matching_enabled")).tint(LoveliesTheme.pink)
                        Toggle("Receive photo requests", isOn: preference("receive_matches", read: "receive_matches")).tint(LoveliesTheme.pink)
                        Toggle("Process the photos I add", isOn: preference("processing_consent", read: "processing_enabled")).tint(LoveliesTheme.pink)
                        Text("Matching and processing do not grant photo access. You review sharing and accept incoming requests separately.").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
                        QuietButton(title: "Privacy center") { store.go(.privacy); live.loadPrivacy() }
                    }
                    if screen == .faceManagement || screen == .profile {
                        QuietButton(title: "Manage your registered face") { live.openFaceManagement() }
                    }
                    if screen == .security {
                        Text("Account recovery").loveliesFont(size: 18, weight: .medium)
                        Text("Save a private recovery key before losing this device. A fresh selfie is also required. Without a saved key, a lost device key cannot recover this account.").loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary)
                        if let key = live.recoveryKey { Text("Recovery key expires \(key.expiresAt.formatted(date: .abbreviated, time: .omitted))").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary) }
                        QuietButton(title: "Check recovery key", enabled: live.canEdit) { live.loadRecoveryKey() }
                        PinkButton(title: "Create or view private recovery key", enabled: live.canEdit) { live.createRecoveryBackup() }
                        QuietButton(title: "Revoke recovery key", enabled: live.canEdit) { live.revokeRecoveryBackup() }
                        Text("Devices").loveliesFont(size: 18, weight: .medium)
                        ForEach(Array(live.devices.enumerated()), id: \.offset) { _, device in
                            HStack { Image(systemName: "iphone"); Text(device["current"].bool == true ? "This device" : "Registered device"); Spacer(); Button("Revoke") { live.revoke(device, device: true) }.foregroundStyle(LoveliesTheme.pink).frame(minHeight: 48) }.padding(12).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        }
                        Text("Sessions").loveliesFont(size: 18, weight: .medium)
                        ForEach(Array(live.sessions.enumerated()), id: \.offset) { _, session in
                            HStack { Text(session["current"].bool == true ? "Current session" : "Other session"); Spacer(); Button("Revoke") { live.revoke(session, device: false) }.foregroundStyle(LoveliesTheme.pink).frame(minHeight: 48) }.padding(12).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        }
                    }
                    if screen == .exportData || screen == .privacy {
                        NativePrivacyPanel()
                    }
                    if screen == .storage { Text("Protected previews are kept only in bounded memory.").foregroundStyle(LoveliesTheme.secondary); QuietButton(title: "Clear cache") { live.clearPreviewCache() } }
                    if screen == .photoAccessSettings { Text("Your selected Photos access is controlled by iOS. The system picker shares only the photos you choose.").foregroundStyle(LoveliesTheme.secondary); QuietButton(title: "Open iOS Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } } }
                    if screen == .help { Text("Register your face, choose photo permissions, add real photos, then review the exact recipients and subsets before sharing. Incoming photos become available after acceptance. Original saving requires the backend's verified entitlement.").foregroundStyle(LoveliesTheme.secondary); NativeSupportPanel() }
                    if screen == .profile { NativeSubscriptionPanel() }
                    if screen == .notificationSettings {
                        NativeNotificationPermissionPanel()
                        ForEach([("match_alerts", "New Matches"), ("support_alerts", "Support")], id: \.0) { item in Toggle(item.1, isOn: Binding(get: { live.notificationSettings[item.0].bool ?? false }, set: { live.setNotification(item.0, enabled: $0) })).tint(LoveliesTheme.pink).disabled(!live.canEdit) }
                    }
                    if screen == .allowedPeople {
                        peopleManagement
                    }
                    if [.noMatches, .offline].contains(screen) { Text(screen == .offline ? "Connection unavailable. Your pending requests are retained under their original keys." : "No confirmed items are available for this account.").foregroundStyle(LoveliesTheme.secondary); PinkButton(title: "Refresh") { live.reloadPhotos() } }
                    QuietButton(title: "Activity") { store.go(.activity); live.refreshInbox() }
                    QuietButton(title: "Account & security") { store.go(.security); live.loadDevices() }
                    QuietButton(title: "Sign out") { live.logout() }
                }.padding(20)
            }.scrollDismissesKeyboard(.interactively)
            if screen == .profile { BottomNavigation(active: .profile) }
        }.foregroundStyle(.white).onAppear { if screen == .security { live.loadDevices() }; if screen == .privacy || screen == .exportData { live.loadPrivacy() }; if screen == .notificationSettings { live.loadNotificationSettings() }; if screen == .allowedPeople { live.loadBlocked() } }
        }
    }
    private var peopleManagement: some View {
        VStack(alignment: .leading, spacing: 15) {
            Text("Every matched person is allowed unless you block them. You still review sharing and accept incoming requests before photo access.")
                .loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary)
            let inReview = (live.snapshot?.people ?? []).filter { !live.blockedPersonIDs.contains($0.id) }
            Text("Allowed in this review (\(inReview.count))").loveliesFont(size: 18, weight: .medium)
            if live.snapshot == nil {
                Text("Open a match review to see its matched people here. This is not a complete list of everyone who may match with you.")
                    .loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
            } else if inReview.isEmpty {
                Text("No allowed people in this review.").loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
            }
            ForEach(inReview) { person in
                HStack(spacing: 13) {
                    NativePersonAvatar(person: person)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(person.name.isEmpty ? "Matched person" : person.name)
                        Text("Can share with").loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary)
                    }
                    Spacer()
                    Button("Block") { live.block(person.id) }.frame(minHeight: 48).foregroundStyle(LoveliesTheme.pink).disabled(!live.canEdit)
                }.padding(12).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }
            Text("Blocked (\(live.blockedPeople.count))").loveliesFont(size: 18, weight: .medium)
            ForEach(Array(live.blockedPeople.enumerated()), id: \.offset) { _, item in
                HStack {
                    Text("Blocked account \(String((item["blocked_id"].string ?? "").prefix(8)))")
                    Spacer()
                    Button("Unblock") { if let id = item["blocked_id"].string { live.block(id, remove: true) } }
                        .frame(minHeight: 48).foregroundStyle(LoveliesTheme.pink).disabled(!live.canEdit)
                }.padding(12).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }
            Text("Blocking changes future matching and sharing eligibility. Unblocking does not restore earlier access or add anyone to your current approved selection.")
                .loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary)
        }
    }
    private func preference(_ field: String, read: String) -> Binding<Bool> { Binding(get: { live.preferences[read].bool ?? false }, set: { live.preference(field, enabled: $0) }) }
}

/// Guest privacy has a dedicated receipt exchange; it never opens registered
/// settings, media, export or sharing under anonymous authority.
struct LiveGuestDeletionView: View {
    @EnvironmentObject private var live: LiveAppStore
    @State private var confirming = false
    var body: some View {
        VStack(spacing: 12) {
            PageHeader(title: "Guest account privacy", trailing: false, back: live.guestDeletion == nil)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Image(systemName: "person.crop.circle.badge.minus").font(.system(size: 44)).foregroundStyle(LoveliesTheme.pink).accessibilityHidden(true)
                    if let deletion = live.guestDeletion {
                        Text(title(deletion)).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        Text(detail(deletion)).font(.body).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                        if let status = deletion.status {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Approval window ends: \(status.requestExpiresAt.formatted(date: .abbreviated, time: .shortened))")
                                Text("Status receipt ends: \(status.receiptExpiresAt.formatted(date: .abbreviated, time: .shortened))")
                            }.font(.footnote).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        if deletion.completed {
                            PinkButton(title: "Start again", enabled: !live.busy) { live.startAgainAfterGuestDeletion() }
                        } else {
                            PinkButton(title: "Check deletion status", enabled: !live.busy) { live.checkGuestDeletion() }
                            if deletion.canResumeSetup { action("Resume setup") { live.resumeGuestSetup() } }
                            if deletion.canRetryOriginal { action("Retry original request") { live.checkGuestDeletion(retry: true) } }
                        }
                    } else {
                        Text("Delete guest account").font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        Text("You can request deletion of the guest account created on this device before registering your face. No face setup is required.").font(.body).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                        Text("Requests require independent review. A request is complete only after the server confirms erasure and private-file cleanup.").font(.footnote).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                        PinkButton(title: "Request guest account deletion", enabled: live.canDeleteGuest) { confirming = true }
                    }
                    if live.busy { HStack(spacing: 12) { ProgressView().tint(LoveliesTheme.pink); Text("Checking with Lovelies…").font(.body) } }
                    Color.clear.frame(height: live.error == nil ? 12 : 120)
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.foregroundStyle(.white)
            .confirmationDialog("Delete guest account?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Request deletion", role: .destructive) { live.requestGuestDeletion() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This requests deletion of the guest account created on this device. Setup will pause while the request is checked. Independent review and verified cleanup are required before deletion is complete.")
            }
    }
    private func action(_ title: String, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Text(title).font(.body.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(LoveliesTheme.secondary).padding(.horizontal, 16).padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(LoveliesTheme.surface, in: Capsule()).overlay(Capsule().stroke(LoveliesTheme.stroke))
        }.buttonStyle(LoveliesPressStyle()).disabled(live.busy)
    }
    private func title(_ deletion: NativeGuestDeletionSummary) -> String {
        if deletion.completed { return "Guest account deleted" }
        if deletion.statusUnavailable { return "Deletion status unavailable" }
        if deletion.requestExpired { return "Approval window expired" }
        switch deletion.status?.phase {
        case .pendingApproval: return "Awaiting review"
        case .approved: return "Deletion approved"
        case .queued: return "Deletion queued"
        case .processing: return "Deletion in progress"
        case .rejected: return "Deletion request rejected"
        case .failed: return "Deletion needs attention"
        case .cancelled: return "Deletion request cancelled"
        default: return "Request outcome not confirmed"
        }
    }
    private func detail(_ deletion: NativeGuestDeletionSummary) -> String {
        if deletion.completed { return "The server confirmed that this guest account and its private files were deleted. Start again only if you want a new guest account." }
        if deletion.statusUnavailable { return "The server cannot resolve this receipt. It may be unknown, expired or revoked. This does not mean the account was deleted. Your receipt is kept; a new account will not start automatically." }
        if deletion.requestExpired { return "The seven-day approval window ended before erasure. This is not completed deletion. Resume setup checks the original guest account; it never creates a replacement." }
        if [.rejected, .cancelled].contains(deletion.status?.phase ?? .pendingApproval) { return "This request did not complete deletion. Resume setup checks the same guest account and restores it only if the server still accepts its credentials." }
        if deletion.status?.phase == .failed { return "The server reported a failure. Private-file cleanup has not been confirmed. Keep this receipt and check the status again." }
        if deletion.status == nil { return "A recovery receipt was saved before sending the request. Check its status first. If no request is found, retry uses the original request and the same guest credentials." }
        return "Setup is paused while the server reviews and completes this request. The encrypted recovery receipt is kept on this device. Checking status does not grant account or photo access." 
    }
}

struct LiveAccountRecoveryView: View {
    @EnvironmentObject private var live: LiveAppStore
    @Environment(\.dismiss) private var dismiss
    @State private var backup = ""
    @State private var replacing = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack { Text("Recover my account").font(.title2.weight(.semibold)); Spacer(); Button("Close") { backup = ""; dismiss() }.frame(minHeight: 48) }
                Text("Use the private recovery backup you saved in Account & security. We verify one fresh selfie against that account's existing registered face.").foregroundStyle(LoveliesTheme.secondary)
                if let recovery = live.accountRecovery {
                    Text(recovery.awaitingServer ? "Recovery is still processing. Check its status before capturing again." : "Your original recovery request is saved on this device.").fixedSize(horizontal: false, vertical: true)
                    PinkButton(title: "Check recovery", enabled: !live.busy) { live.checkAccountRecovery() }
                    QuietButton(title: "Use another recovery key", enabled: live.guestDeletion == nil) { replacing = true }
                } else {
                    SecureField("Private LVR1 recovery backup", text: $backup).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(16).frame(minHeight: 56).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        .accessibilityLabel("Private account recovery backup")
                    PinkButton(title: "Continue", enabled: !live.busy && !backup.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                        let input = backup; backup = ""; live.beginAccountRecovery(input)
                    }
                }
                Text("No saved private recovery key means this lost account cannot be recovered here. Checking a request does not sign you in. Your account stays unavailable until the backend confirms your fresh selfie.").font(.footnote).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                if let error = live.error { Text(error).foregroundStyle(LoveliesTheme.pink).fixedSize(horizontal: false, vertical: true) }
            }.padding(22)
        }.background(LoveliesTheme.canvas).foregroundStyle(.white).tint(LoveliesTheme.pink)
            .interactiveDismissDisabled(live.busy).onDisappear { backup = "" }
            .confirmationDialog("Use another recovery key?", isPresented: $replacing, titleVisibility: .visible) {
                Button("Use another key") { backup = ""; live.useAnotherRecoveryKey() }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Your earlier attempt and device key will be kept privately. This does not cancel that server request. Your saved enrollment identity stays unchanged until a fresh selfie successfully recovers your account.") }
    }
}
struct LiveRecoveryBackupView: View {
    @EnvironmentObject private var live: LiveAppStore
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack { Text("Private recovery key").font(.title2.weight(.semibold)); Spacer(); Button("Done") { live.recoveryBackup = nil; dismiss() }.frame(minHeight: 48) }
                Text("Keep this backup privately outside this device, such as in your password manager. It identifies your account and is required together with a fresh selfie if your device key is lost.").foregroundStyle(LoveliesTheme.secondary)
                if let backup = live.recoveryBackup {
                    Text(backup).font(.system(.body, design: .monospaced)).textSelection(.enabled).padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                    PinkButton(title: copied ? "Copied" : "Copy private backup") {
                        UIPasteboard.general.setItems([["public.utf8-plain-text": backup]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)])
                        copied = true
                    }
                }
                Text("Copying happens only when you choose it. Anyone with this backup can start a recovery attempt; a current matching selfie is still required. Creating another recovery key revokes this one.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
            }.padding(22)
        }.background(LoveliesTheme.canvas).foregroundStyle(.white).tint(LoveliesTheme.pink)
            .onDisappear { live.recoveryBackup = nil }
    }
}

/// Existing Lovelies quiet task layout. Management status grants no account or
/// photo access; purpose-specific consent is explicit on each resumed episode.
struct LiveFaceProfileManagementView: View {
    @EnvironmentObject private var live: LiveAppStore
    @State private var confirming: NativeFaceProfileAction?
    @State private var confirmingVersion: Int?
    @State private var confirmingPolicy: String?
    @State private var matchingConsent = false
    @State private var authenticationConsent = false
    var body: some View {
        VStack(spacing: 12) {
            PageHeader(title: "Your registered face", trailing: false, back: live.session?.authenticated == true)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Image(systemName: "person.crop.rectangle").font(.system(size: 42)).foregroundStyle(LoveliesTheme.pink).accessibilityHidden(true)
                    if let value = live.faceLifecycle {
                        Text(title(value)).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        Text(detail(value)).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                        status("Face authentication", enabled: value.metadata.authenticationEnabled)
                        status("Photo matching", enabled: value.metadata.matchingEnabled)
                        status("Photo processing", enabled: value.metadata.processingEnabled)
                        if let operation = value.operation { Text("Saved action: \(label(operation.action)) · \(operation.serverState?.replacingOccurrences(of: "_", with: " ") ?? "not confirmed")").font(.footnote).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true) }
                        PinkButton(title: "Check status", enabled: !live.busy) { live.checkFaceProfile() }
                        if value.canRenewControl {
                            QuietButton(title: "Renew expired management control", enabled: !live.busy) { live.renewFaceManagementControl() }
                        }
                        if value.authorityUnavailable, value.metadata.authenticationEnabled, value.operation == nil || ["applied", "completed", "cancelled"].contains(value.operation?.serverState ?? "") {
                            QuietButton(title: "Verify retained face", enabled: !live.busy) { live.verifyManagedFace() }
                            Text("A current matching selfie may restore existing authentication on this device. It does not regrant withdrawn consent or renew this management control.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                        }
                        if value.operation?.missingOnServer == true || value.operation?.serverState == nil || value.authorityUnavailable {
                            QuietButton(title: "Retry saved action", enabled: !live.busy) { live.checkFaceProfile(retry: true) }
                        }
                        if value.operation?.action.captures == true, value.operation?.terminal != true {
                            QuietButton(title: "Cancel face update") { live.cancelManagedCapture() }
                        }
                        if let action = value.operation?.action, action.captures, ["pending", "capture_pending", "restart_required", "failed"].contains(value.operation?.serverState ?? ""), !value.awaitingServer {
                            QuietButton(title: value.operation?.serverState == "restart_required" || value.operation?.serverState == "failed" ? "Start fresh captures" : "Continue capture", enabled: !live.busy) { live.manageFace(action, explicitlyConsented: true) }
                        }
                        if canChoose(value) {
                            if value.metadata.profile != nil {
                                if value.metadata.matchingEnabled {
                                    QuietButton(title: "Pause photo matching", enabled: !live.busy) { live.manageFace(.pause) }
                                } else {
                                    Toggle("I agree to the current photo-matching policy", isOn: $matchingConsent).tint(LoveliesTheme.pink).disabled(live.busy)
                                    Text(value.metadata.photoPolicy).font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                                    QuietButton(title: "Resume photo matching", enabled: matchingConsent && !live.busy) { live.manageFace(.resume, explicitlyConsented: matchingConsent); matchingConsent = false }
                                }
                                if value.metadata.authenticationEnabled {
                                    QuietButton(title: "Replace face profile", enabled: !live.busy) { confirmationFor(.replace, value: value) }
                                    QuietButton(title: "Withdraw face authentication consent", enabled: !live.busy) { confirmationFor(.withdrawAuthentication, value: value) }
                                    if !value.authenticated { QuietButton(title: "Verify my face", enabled: !live.busy) { live.verifyManagedFace() } }
                                }
                                QuietButton(title: "Remove face profile", enabled: !live.busy) { confirmationFor(.remove, value: value) }
                            }
                            if !value.metadata.authenticationEnabled, !value.cleanupPending {
                                Toggle("I agree to the current face-authentication policy", isOn: $authenticationConsent).tint(LoveliesTheme.pink).disabled(live.busy)
                                Text(value.metadata.authPolicy).font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                                let action: NativeFaceProfileAction = value.metadata.profile == nil ? .enroll : .restoreAuthentication
                                PinkButton(title: action == .enroll ? "Enroll face again" : "Restore face authentication", enabled: authenticationConsent && !live.busy && (value.metadata.profile != nil || value.metadata.removalState == "completed")) {
                                    live.manageFace(action, explicitlyConsented: authenticationConsent); authenticationConsent = false
                                }
                            }
                        }
                        Text("Pause and resume manage a new matching episode. Authentication consent, photo processing, sharing approval and account deletion are separate. Removing a reference cannot recall downloaded copies.").font(.footnote).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("Manage your face profile").font(.title2.weight(.semibold))
                        Text("Check the current server profile before changing matching, authentication or the private reference.").foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                        PinkButton(title: "Check face profile", enabled: !live.busy) { live.openFaceManagement() }
                    }
                    if live.busy { HStack(spacing: 12) { ProgressView().tint(LoveliesTheme.pink); Text("Checking with Lovelies…") } }
                    Color.clear.frame(height: live.error == nil ? 12 : 130)
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.foregroundStyle(.white)
            .onChange(of: live.faceLifecycle?.metadata.version) { _, _ in matchingConsent = false; authenticationConsent = false }
            .onChange(of: live.faceLifecycle?.metadata.authPolicy) { _, _ in authenticationConsent = false }
            .onChange(of: live.faceLifecycle?.metadata.photoPolicy) { _, _ in matchingConsent = false }
            .confirmationDialog(confirming.map(label) ?? "Manage face profile", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
                if let action = confirming {
                    Button(action == .replace ? "Accept current policy and capture three selfies" : label(action), role: action == .replace ? nil : .destructive) {
                        guard live.faceLifecycle?.metadata.version == confirmingVersion, live.faceLifecycle?.metadata.authPolicy == confirmingPolicy else { live.error = "Your face profile or policy changed. Check the current status and confirm again."; confirming = nil; return }
                        live.manageFace(action, explicitlyConsented: action == .replace); confirming = nil
                    }
                }
                Button("Cancel", role: .cancel) { confirming = nil }
            } message: { Text(confirmation) }
    }
    private func confirmationFor(_ action: NativeFaceProfileAction, value: NativeFaceLifecycleSummary) {
        confirmingVersion = value.metadata.version; confirmingPolicy = value.metadata.authPolicy; confirming = action
    }
    private func status(_ title: String, enabled: Bool) -> some View {
        HStack { Text(title); Spacer(); Text(enabled ? "Enabled" : "Off").foregroundStyle(LoveliesTheme.secondary) }.frame(minHeight: 48)
    }
    private func canChoose(_ value: NativeFaceLifecycleSummary) -> Bool {
        !value.authorityUnavailable && !value.awaitingServer && (value.operation == nil || ["applied", "completed", "cancelled"].contains(value.operation?.serverState ?? ""))
    }
    private func label(_ action: NativeFaceProfileAction) -> String {
        switch action { case .pause: return "Pause photo matching"; case .resume: return "Resume photo matching"; case .withdrawAuthentication: return "Withdraw authentication consent"; case .remove: return "Remove face profile"; case .replace: return "Replace face profile"; case .restoreAuthentication: return "Restore face authentication"; case .enroll: return "Enroll face again" }
    }
    private func title(_ value: NativeFaceLifecycleSummary) -> String {
        if value.authorityUnavailable { return "Profile status unavailable" }
        if value.cleanupPending { return "Private reference cleanup \(value.metadata.removalState == "none" ? value.operation?.cleanupState ?? "pending" : value.metadata.removalState)" }
        if value.metadata.profile == nil, value.metadata.removalState == "completed" { return "Face reference removed" }
        if !value.metadata.authenticationEnabled { return "Face authentication is off" }
        if value.operation?.serverState == "completed" { return "Face profile updated" }
        if value.awaitingServer { return "Result not confirmed" }
        return value.metadata.matchingEnabled ? "Your face profile is active" : "Photo matching is paused"
    }
    private func detail(_ value: NativeFaceLifecycleSummary) -> String {
        if value.authorityUnavailable { return "The saved account and original device key are retained. Status cannot sign you in, and another account will not start automatically." }
        if value.cleanupPending { return "The server has not yet confirmed removal of all private reference bytes. Keep this saved action and check again; re-enrollment remains unavailable until cleanup is verified." }
        if !value.metadata.authenticationEnabled { return value.metadata.profile == nil ? "Authentication is off. After confirmed cleanup, you can explicitly enroll three new selfies on this same account and device." : "Your reference is retained for the separately granted matching purpose. Restoring authentication requires current consent and one fresh selfie." }
        if value.awaitingServer { return "Check the original action before capturing or sending another request. No result or access is inferred from a connection failure." }
        return value.authenticated ? "Use these controls to manage matching, authentication consent and your private registered reference." : "Your profile is current. Verify one fresh selfie with the retained device key to regain account access."
    }
    private var confirmation: String {
        switch confirming {
        case .replace: return "Accept face-authentication policy \(confirmingPolicy ?? "unavailable") and capture three fresh selfies. Each must match your existing registered reference. Completion updates this profile and retires older sessions, recovery keys and photo-access bindings."
        case .withdrawAuthentication: return "Face sign-in and existing sessions will stop. Matching and processing remain separate. A reference is retained only while separately granted matching needs it; otherwise verified private-reference cleanup is required."
        case .remove: return "Stop face authentication and matching, then remove the private reference. Account uploads and separately granted photo processing remain. Re-enrollment waits for confirmed cleanup. Downloaded copies cannot be recalled."
        default: return "Check the current profile before continuing."
        }
    }
}
