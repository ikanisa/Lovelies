import SwiftUI
import UIKit
import ImageIO

struct LiveRouteView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    let screen: Screen
    @AccessibilityFocusState private var errorFocused: Bool
    @ViewBuilder var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                if live.registeredDeletion != nil { NativeRegisteredDeletionView() }
                else if live.guestDeletion != nil { LiveGuestDeletionView() }
                else if live.audienceGateNeeded(screen) { LiveAudienceGateView() }
                else if live.faceLifecycle != nil, live.accountRecovery == nil, live.session?.authenticated != true, ![.faceEnrollment, .processing, .faceQualityRetry, .privacy, .exportData, .security].contains(screen) { LiveFaceProfileManagementView() }
                else { switch screen.rawValue {
                case 1...9: LiveOnboardingView(screen: screen)
                case 10...18: LiveGalleryView(screen: screen)
                case 19...24: LiveUploadView(screen: screen)
                case 25...26:
                    VStack(spacing: 8) {
                        LiveMatchesNavigation(selected: "To review").padding(.horizontal, 18)
                        LiveSharingView(screen: screen)
                    }
                case 27...36: LiveSharingView(screen: screen)
                default: LiveSettingsView(screen: screen)
                } }
            }
            if let error = live.error {
                ScrollView { VStack(spacing: 8) {
                    Text(error).loveliesFont(size: 14).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
                        .accessibilityFocused($errorFocused).accessibilityAddTraits(.isHeader)
                    AdaptiveActions {
                        Button("Dismiss") { live.error = nil }.frame(minHeight: 44)
                        if live.registeredDeletion != nil {
                            Button("Check deletion status") { live.checkRegisteredDeletion() }.frame(minHeight: 48)
                        } else if let deletion = live.guestDeletion {
                            Button("Check status") { live.checkGuestDeletion() }.frame(minHeight: 48)
                            if deletion.canRetryOriginal { Button("Retry original request") { live.checkGuestDeletion(retry: true) }.frame(minHeight: 48) }
                        } else if live.faceLifecycle != nil, live.accountRecovery == nil {
                            Button("Check face profile") { live.checkFaceProfile() }.frame(minHeight: 48)
                            Button("Retry saved action") { live.checkFaceProfile(retry: true) }.frame(minHeight: 48)
                        } else if live.accountRecovery != nil {
                            Button("Check recovery") { live.checkAccountRecovery() }.frame(minHeight: 48)
                        } else if live.enrollment != nil {
                            Button("Check enrollment") { live.checkEnrollment() }.frame(minHeight: 48)
                            Button("Recover my account") { live.accountRecoverySheet = true }.frame(minHeight: 48)
                        } else if live.hasPendingOperation {
                            Button("Check status") { live.reconcile() }.frame(minHeight: 44)
                            Button("Retry original request") { live.reconcile(retry: true) }.frame(minHeight: 44)
                        } else {
                            if live.photoCameraPermissionDenied {
                                Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }.frame(minHeight: 44)
                            }
                            Button("Try again") {
                                if screen == .processing || screen == .faceEnrollment { live.restartFace() }
                                else if (25...34).contains(screen.rawValue) { live.refreshReview() }
                                else if live.session?.authenticated == true { live.reloadPhotos() }
                                else { live.connect() }
                            }.frame(minHeight: 44)
                        }
                    }.foregroundStyle(LoveliesTheme.pink).font(.subheadline.weight(.medium))
                }.padding(14) }.frame(maxHeight: 320).background(LoveliesTheme.raised, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(LoveliesTheme.pink.opacity(0.5)))
                    .padding(12).zIndex(10)
            }
        }
        .sheet(isPresented: $live.photoCamera) {
            if let request = live.photoCameraContext {
                NativeOrdinaryPhotoCamera(request: request, isCurrent: { request in await live.verifyPhotoCameraImport(request) }) { request, items, error in
                    live.acceptCameraImports(items, failure: error, request: request)
                }
            }
        }
        .sheet(isPresented: $live.accountRecoverySheet) { LiveAccountRecoveryView() }
        .sheet(isPresented: $live.recoveryBackupSheet) { LiveRecoveryBackupView() }
        .onChange(of: live.error) { _, error in errorFocused = error != nil }
    }
}

private struct LiveMatchesNavigation: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    let selected: String
    var body: some View {
        SegmentPills(values: ["Received", "To review"], selected: Binding(get: { selected }, set: { value in
            guard value != selected else { return }
            if value == "Received" { store.go(.newMatches, simulateProgress: false) }
            else { live.beginReview(destination: .matchedPhotos) }
        })).disabled(live.busy)
    }
}

struct LiveOnboardingView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    let screen: Screen
    @ViewBuilder var body: some View {
        switch screen {
        case .splash: OnboardingViews(screen: .splash)
        case .introduction, .signIn:
            LoveliesPage(spacing: 18, padding: 0) {
                PageHeader(title: "", trailing: false)
                Spacer(minLength: 10)
                AssetImage(name: "intro-collage").scaledToFit().frame(maxHeight: 310).accessibilityHidden(true)
                Text("Your photos\nfind their people").loveliesFont(size: 23, weight: .semibold).multilineTextAlignment(.center)
                Text("We match your photos.\nYou choose what to share.").loveliesFont(size: 16).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                Spacer()
                PinkButton(title: String(localized: "Get Started"), enabled: live.connected && !live.busy) { store.go(.photoAccessPrompt) }
                QuietButton(title: String(localized: "Recover my account"), enabled: !live.busy && live.guestDeletion == nil) { live.accountRecoverySheet = true }
                NativePolicyPanel()
                if live.session?.authenticated == false {
                    QuietButton(title: String(localized: "Delete guest account"), enabled: live.canDeleteGuest) { store.go(.privacy, simulateProgress: false) }
                }
                if live.busy { ProgressView().tint(LoveliesTheme.pink) }
            }.padding(22).foregroundStyle(.white)
        case .photoAccessPrompt, .photoAccessOptions:
            LoveliesPage(spacing: 14, padding: 0) {
                PageHeader(title: String(localized: "Choose Photo Access"))
                PhotoHeart(size: 80).padding(.vertical, 20)
                VStack(alignment: .leading, spacing: 14) {
                    Label("You choose the photos", systemImage: "photo.on.rectangle.angled").font(.title3.weight(.semibold))
                    Text("Lovelies uses Apple's Photos picker and Files. Only items you select are imported; this screen does not grant full-library access or continuous background scanning.").font(.body).foregroundStyle(LoveliesTheme.secondary)
                    Text("You can choose more photos each time you add photos. Saving originals asks separately for permission to add to Photos.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                }.padding(18).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 20))
                Toggle("Use my enrollment selfies to register my face and authenticate this device", isOn: Binding(get: { live.authConsent }, set: live.acceptAuthConsent))
                    .loveliesFont(size: 14).tint(LoveliesTheme.pink).disabled(live.policy.isEmpty || live.busy)
                if !live.policy.isEmpty { Text("Face policy: \(live.policy)").loveliesFont(size: 11).foregroundStyle(LoveliesTheme.secondary) }
                NativePolicyPanel()
                Spacer(minLength: 0)
                PinkButton(title: String(localized: "Continue"), enabled: live.authConsent && !live.busy) { store.go(.faceEnrollment, simulateProgress: false); live.prepareFace() }
                if live.session?.authenticated == false {
                    QuietButton(title: String(localized: "Delete guest account"), enabled: live.canDeleteGuest) { store.go(.privacy, simulateProgress: false) }
                }
            }.padding(.horizontal, 20).padding(.bottom, 16).foregroundStyle(.white).onAppear { if live.policy.isEmpty { live.loadFacePolicy() } }
        case .faceEnrollment: LiveCameraEnrollment(camera: live.camera)
        case .faceQualityRetry:
            LoveliesPage(spacing: 18, padding: 0) {
                PageHeader(title: "", trailing: false)
                if let image = live.lastSelfie { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 330).clipShape(RoundedRectangle(cornerRadius: 24)) }
                Text("Let's try that again").loveliesFont(size: 23, weight: .medium)
                Text(live.faceQualityFailure?.message ?? String(localized: "Make sure your face is well lit, in focus, and centered.")).loveliesFont(size: 16).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                Text("Your face has not been verified. The rejected sequence must be checked before starting fresh selfies.")
                    .loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                Spacer(); PinkButton(title: String(localized: "Retake selfies"), enabled: !live.busy) { live.retakeRejectedSequence() }
            }.padding(22).foregroundStyle(.white)
        case .processing:
            LoveliesPage(spacing: 20) {
                PageHeader(title: String(localized: "Face Setup"), close: true, trailing: false)
                AssetImage(name: "processing-hero").scaledToFit().frame(maxWidth: 240, maxHeight: 240).accessibilityHidden(true)
                Text("Verifying your face…").font(.title2.weight(.medium)).accessibilityAddTraits(.isHeader)
                if live.busy { ProgressView().tint(LoveliesTheme.pink).accessibilityLabel("Verification in progress") }
                Text("Leaving this screen keeps the saved request. Verification is complete only after the backend confirms it.").font(.body).foregroundStyle(LoveliesTheme.secondary)
                if live.faceLifecycle != nil, live.accountRecovery == nil { QuietButton(title: String(localized: "Check face profile"), enabled: !live.busy) { live.checkFaceProfile() } }
                else if live.accountRecovery != nil { QuietButton(title: String(localized: "Check recovery"), enabled: !live.busy) { live.checkAccountRecovery() } }
                else if live.enrollment != nil { QuietButton(title: String(localized: "Check enrollment"), enabled: !live.busy) { live.checkEnrollment() } }
            }.foregroundStyle(.white)
        default:
            LoveliesPage(spacing: 20, padding: 0) {
                PageHeader(title: String(localized: "Setup Complete"), trailing: false)
                Spacer(); AssetImage(name: "setup-hero").scaledToFit().frame(width: 270)
                Text("You're all set!").loveliesFont(size: 25, weight: .medium)
                Text("Your face is registered.\nYou decide who sees your photos.").loveliesFont(size: 17).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                Spacer(); PinkButton(title: String(localized: "Let's Go"), enabled: live.session?.authenticated == true) { store.go(.home, replace: true, simulateProgress: false); live.reloadPhotos() }
            }.padding(23).foregroundStyle(.white)
        }
    }
}

struct LiveCameraEnrollment: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    @ObservedObject private var camera: NativeCamera
    init(camera: NativeCamera) { _camera = ObservedObject(wrappedValue: camera) }
    var body: some View {
        GeometryReader { geometry in
            ScrollView { VStack(spacing: 15) {
                ZStack {
                    NativeCameraPreview(camera: live.camera)
                    if live.selfieReview != nil, let image = live.lastSelfie {
                        Image(uiImage: image).resizable().scaledToFit().background(.black)
                    } else if !camera.ready {
                        VStack(spacing: 16) {
                            if camera.state.phase == .initializing || camera.state.phase == .permissionPending { ProgressView().tint(.white); Text(camera.state.phase == .permissionPending ? String(localized: "Waiting for camera permission") : String(localized: "Opening camera")) }
                            else {
                                Image(systemName: "camera").font(.system(size: 30))
                                Text(camera.error ?? String(localized: "Open the camera to take your selfie.")).multilineTextAlignment(.center)
                                if camera.state.canOpenSettings {
                                    QuietButton(title: String(localized: "Open Settings")) { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                                } else if camera.state.phase != .restricted {
                                    QuietButton(title: String(localized: "Open camera again"), enabled: !live.busy) { live.recoverCamera() }
                                }
                            }
                        }.padding(24).foregroundStyle(.white).background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 20))
                    }
                }
                    .frame(width: max(1, geometry.size.width - 22), height: max(200, geometry.size.height * (live.selfieReview == nil ? 0.67 : 0.57)))
                    .clipShape(RoundedRectangle(cornerRadius: 19))
                    .overlay { if live.selfieReview == nil { RoundedRectangle(cornerRadius: 20).stroke(LoveliesTheme.pink.opacity(0.7), lineWidth: 2).frame(width: geometry.size.width * 0.58, height: geometry.size.height * 0.41) } }
                if live.selfieReview != nil {
                    Text("Review your selfie").loveliesFont(size: 20, weight: .medium).foregroundStyle(.white)
                    Text("Captured on this device. Not yet verified.").loveliesFont(size: 14).multilineTextAlignment(.center).foregroundStyle(LoveliesTheme.secondary)
                    HStack(spacing: 12) {
                        QuietButton(title: String(localized: "Retake"), enabled: !live.busy) { live.retakeReviewedSelfie() }
                        PinkButton(title: String(localized: "Use photo"), enabled: !live.busy && live.isForeground) { live.useReviewedSelfie() }
                    }.padding(.horizontal, 20)
                } else {
                    Button { live.takeSelfie() } label: { Circle().fill(.white).frame(width: 52, height: 52).padding(5).overlay(Circle().stroke(.white, lineWidth: 2)) }
                        .disabled(live.busy || live.challenge == nil || live.captureNeedsStatus || !camera.ready)
                        .accessibilityLabel("Capture selfie \(live.captureReceipts.count + 1)")
                    Text(instruction).loveliesFont(size: 14).multilineTextAlignment(.center).foregroundStyle(LoveliesTheme.secondary)
                }
                if live.challenge == nil, live.faceLifecycle != nil, live.accountRecovery == nil {
                    QuietButton(title: String(localized: "Check face profile"), enabled: !live.busy) { live.checkFaceProfile() }.padding(.horizontal, 20)
                } else if live.challenge == nil, live.accountRecovery != nil {
                    QuietButton(title: String(localized: "Check recovery"), enabled: !live.busy) { live.checkAccountRecovery() }.padding(.horizontal, 20)
                } else if live.challenge == nil, live.enrollment != nil {
                    QuietButton(title: String(localized: "Check enrollment"), enabled: !live.busy) { live.checkEnrollment() }.padding(.horizontal, 20)
                }
                if live.captureNeedsStatus {
                    Text("This capture has not been confirmed. Check the saved request before taking another selfie.")
                        .loveliesFont(size: 14).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center).padding(.horizontal, 20)
                    QuietButton(title: String(localized: "Check saved capture"), enabled: !live.busy) { live.retakeRejectedSequence() }.padding(.horizontal, 20)
                }
                if live.faceLifecycle?.operation?.action.captures == true, live.faceLifecycle?.operation?.terminal != true {
                    QuietButton(title: String(localized: "Cancel face update")) { live.cancelManagedCapture() }.padding(.horizontal, 20)
                }
                if let cameraError = camera.error { Text(cameraError).loveliesFont(size: 13).foregroundStyle(LoveliesTheme.pink).multilineTextAlignment(.center) }
                Spacer(minLength: 0)
            }.frame(maxWidth: .infinity) }
                .overlay(alignment: .topLeading) { Button { live.leaveFaceCamera() } label: { Image(systemName: "chevron.left").font(.system(size: 19)).frame(width: 48, height: 48).background(.black.opacity(0.3), in: Circle()) }.padding(12).accessibilityLabel("Back") }
        }
        .task(id: live.challenge?.id) { live.openFaceCamera() }
        .onChange(of: live.busy) { _, busy in if !busy && !camera.ready { live.openFaceCamera() } }
        .onChange(of: camera.state.generation) { _, _ in live.cameraAuthorityChanged() }
        .onDisappear { live.stopFaceCameraPresentation() }
    }
    private var instruction: String {
        guard let challenge = live.challenge, challenge.poses.indices.contains(live.captureReceipts.count) else { return String(localized: "Position your face\nin the frame") }
        let pose = challenge.poses[live.captureReceipts.count]
        return (pose == "left" ? String(localized: "Turn slightly to your left") : pose == "right" ? String(localized: "Turn slightly to your right") : String(localized: "Position your face in the frame")) + String(localized: "\n\(live.captureReceipts.count + 1) of \(challenge.poses.count) selfies")
    }
}

struct ProtectedNativePhoto: View {
    @EnvironmentObject private var live: LiveAppStore
    let photo: NativePhoto
    var pixels = 600
    var fit: ContentMode = .fill
    @State private var image: UIImage?
    @State private var failure = false
    @State private var attempt = 0
    @State private var expiresAt: Date?
    var body: some View {
        ZStack {
            if let image { Image(uiImage: image).resizable().aspectRatio(contentMode: fit) }
            else { LoveliesTheme.surface; Image(systemName: failure ? "exclamationmark.triangle" : "photo").foregroundStyle(LoveliesTheme.secondary) }
            if failure { Button { attempt += 1 } label: { Image(systemName: "arrow.clockwise").frame(width: 48, height: 48).background(.black.opacity(0.7), in: Circle()) }.accessibilityLabel("Retry protected preview") }
        }
        .task(id: "\(photo.id):\(photo.version):\(live.mediaRevision):\(live.session?.epoch ?? 0):\(live.isForeground):\(attempt)") {
            image = nil; failure = false; expiresAt = nil
            guard let repository = live.repository, live.isForeground else { return }
            let revision = live.mediaRevision, epoch = live.session?.epoch
            do {
                let bytes = try await repository.preview(photo)
                guard !Task.isCancelled, revision == live.mediaRevision, epoch == live.session?.epoch else { return }
                let currentSession = await repository.summary()
                guard !Task.isCancelled, live.synchronizeMediaSession(currentSession, expectedEpoch: epoch) else { return }
                let approval = try await repository.requireAudience(.faceAuthentication)
                let decoded = await Task.detached(priority: .userInitiated) { () -> Data? in
                    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                          let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: pixels] as CFDictionary) else { return nil }
                    return UIImage(cgImage: cg).pngData()
                }.value
                let currentApproval = try await repository.requireAudience(.faceAuthentication)
                guard approval == currentApproval, !Task.isCancelled, revision == live.mediaRevision, epoch == live.session?.epoch else { return }
                image = decoded.flatMap(UIImage.init(data:)); failure = image == nil
                expiresAt = live.session?.expiresAt
            } catch {
                if !Task.isCancelled {
                    let currentSession = await repository.summary()
                    guard !Task.isCancelled else { return }
                    _ = live.synchronizeMediaSession(currentSession, expectedEpoch: epoch)
                    live.handleAudienceFailure(error)
                    image = nil; failure = true
                }
            }
        }
        .task(id: expiresAt) { if let expiresAt { do { try await Task.sleep(for: .seconds(max(0, expiresAt.timeIntervalSinceNow))); if !Task.isCancelled { image = nil; failure = true } } catch {} } }
        .onDisappear { image = nil }
    }
}

struct LivePhotoGrid: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let photos: [NativePhoto]
    var selection: Set<String>? = nil
    var columnCount: Int = 3
    @State private var containerWidth: CGFloat = 0
    var action: (NativePhoto) -> Void
    private var effectiveColumns: Int { textSize.isAccessibilitySize ? 2 : max(2, min(5, columnCount)) }
    private var columns: [[NativePhoto]] {
        var values = Array(repeating: [NativePhoto](), count: effectiveColumns), heights = Array(repeating: 0.0, count: effectiveColumns)
        for photo in photos { let column = heights.enumerated().min { $0.element < $1.element }!.offset; values[column].append(photo); heights[column] += photo.ratio + 0.04 }
        return values
    }
    var body: some View {
        GeometryReader { geometry in
            let width = max(1, (geometry.size.width - CGFloat(effectiveColumns - 1) * 4) / CGFloat(effectiveColumns))
            HStack(alignment: .top, spacing: 4) {
                ForEach(0..<effectiveColumns, id: \.self) { column in
                    LazyVStack(spacing: 4) {
                        ForEach(columns[column]) { photo in
                            Button { action(photo) } label: {
                                ProtectedNativePhoto(photo: photo, pixels: Int(width * UIScreen.main.scale * max(1, photo.ratio)))
                                    .frame(width: width, height: width * photo.ratio).clipped().clipShape(RoundedRectangle(cornerRadius: 12))
                                    .overlay(alignment: .topTrailing) { if let selection { CheckBadge(selected: selection.contains(photo.id), size: 26).padding(6) } }
                            }.buttonStyle(LoveliesPressStyle()).id(photo.id).accessibilityLabel(photo.title)
                                .accessibilityValue(selection.map { $0.contains(photo.id) ? String(localized: "Selected") : String(localized: "Not selected") } ?? "")
                                .accessibilityAddTraits(selection?.contains(photo.id) == true ? .isSelected : [])
                        }
                    }.frame(width: width)
                }
            }.onAppear { containerWidth = geometry.size.width }.onChange(of: geometry.size.width) { _, width in containerWidth = width }
        }.frame(height: gridHeight)
    }
    private var gridHeight: CGFloat { let width = max(1, (containerWidth - CGFloat(effectiveColumns - 1) * 4) / CGFloat(effectiveColumns)); return CGFloat(columns.map { $0.reduce(0) { $0 + width * $1.ratio + 4 } }.max() ?? 0) }
}

struct LiveGalleryView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    let screen: Screen
    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var chrome = true
    private var visible: [NativePhoto] { screen == .favorites ? live.displayedPhotos.filter { live.favoriteIDs.contains($0.id) } : live.displayedPhotos }
    @ViewBuilder var body: some View {
        if screen == .photoViewer { viewer }
        else if screen == .activity { LiveInboxView() }
        else if screen == .notifications { LiveNotificationsView() }
        else if screen == .filters {
            LoveliesPage {
                PageHeader(title: String(localized: "Photo Filters"), trailing: false)
                Picker("Photo source", selection: $live.gallerySource) { Text("All").tag("all"); Text("Added by me").tag("contributions"); Text("Received").tag("received") }.pickerStyle(.menu)
                Picker("Orientation", selection: $live.galleryCategory) { Text("Any orientation").tag("all"); Text("Portrait").tag("portraits"); Text("Landscape").tag("landscapes") }.pickerStyle(.menu)
                PinkButton(title: String(localized: "Apply filters"), enabled: live.canEdit) { live.searchLibrary() }
                if live.busy { ProgressView("Finding photos…").tint(LoveliesTheme.pink) }
                Text("\(visible.count) matching photos loaded").font(.body).foregroundStyle(LoveliesTheme.secondary)
                QuietButton(title: String(localized: "View matching photos")) { store.go(.search) }
            }.foregroundStyle(.white).onAppear { live.showLibrary(screen) }
        }
        else {
            VStack(spacing: 8) {
                HStack {
                    if screen == .home { Wordmark(width: 154) }
                    else {
                        Button { store.back() } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Back")
                        Text(screen == .search ? String(localized: "Search") : screen == .favorites ? String(localized: "Favorites") : screen == .newMatches ? String(localized: "Matches") : String(localized: "Photos")).font(.headline).accessibilityAddTraits(.isHeader)
                    }
                    Spacer(minLength: 0)
                    Button { store.go(.search) } label: { Image(systemName: "magnifyingglass").frame(width: 48, height: 48) }.accessibilityLabel("Search all authorized photos")
                    Button { store.go(.filters) } label: { Image(systemName: "line.3.horizontal.decrease").frame(width: 48, height: 48) }.accessibilityLabel("Filter photos")
                    OverflowMenu()
                }.padding(.horizontal, 12)
                if screen == .newMatches {
                    LiveMatchesNavigation(selected: "Received").padding(.horizontal, 18)
                    Text("Photos you can access as a recipient.").font(.subheadline).foregroundStyle(LoveliesTheme.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18)
                }
                if screen == .search {
                    TextField("Search your photos", text: $live.query).textFieldStyle(.plain).submitLabel(.search)
                        .padding(13).background(LoveliesTheme.surface, in: Capsule()).padding(.horizontal, 12)
                        .onSubmit { live.searchLibrary() }
                        .task(id: live.query) { do { try await Task.sleep(for: .milliseconds(350)); if !Task.isCancelled, !live.busy { live.searchLibrary() } } catch {} }
                }
                ScrollViewReader { proxy in ScrollView {
                    if visible.isEmpty {
                        VStack(spacing: 18) {
                            Image(systemName: screen == .favorites ? "heart" : "photo.on.rectangle").font(.system(size: 52)).foregroundStyle(LoveliesTheme.pink).accessibilityHidden(true)
                            Text(live.busy ? String(localized: "Loading photos…") : screen == .favorites ? String(localized: "No favorites here yet") : live.query.isEmpty && live.galleryCategory == "all" ? String(localized: "No photos yet") : String(localized: "No matching photos")).font(.title2.weight(.medium))
                            Text(screen == .favorites ? String(localized: "Favorite a photo in its viewer. Load more to find favorites from older pages.") : screen == .newMatches ? String(localized: "Received photos appear after a contributor shares them and you accept access.") : String(localized: "Add photos or accept a photo request. Search and filters use only photos your account can currently access.")).font(.body).foregroundStyle(LoveliesTheme.secondary)
                            if !live.busy, screen != .newMatches { PinkButton(title: String(localized: "Add Photos")) { store.go(.uploadEntry) } }
                        }.padding(24).padding(.top, 50)
                    } else {
                        LivePhotoGrid(photos: visible, columnCount: live.galleryColumns) { live.openPhoto($0) }.padding(.horizontal, 8)
                    }
                    if live.hasMorePhotos { Button("Load more") { live.loadMore() }.frame(minHeight: 48).foregroundStyle(LoveliesTheme.pink) }
                }.refreshable { do { try await live.refreshGallery() } catch { live.error = error.localizedDescription } }
                    .onAppear { if let anchor = live.galleryAnchor { proxy.scrollTo(anchor, anchor: .center) } }
                    .simultaneousGesture(MagnificationGesture().onEnded { value in live.galleryColumns = min(5, max(2, live.galleryColumns + (value < 1 ? 1 : -1))); live.persistLibraryState() })
                }
                HStack {
                    Text("\(visible.count) loaded").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                    Spacer()
                    Button { live.galleryColumns = min(5, live.galleryColumns + 1); live.persistLibraryState() } label: { Image(systemName: "square.grid.3x3").frame(width: 44, height: 44) }.accessibilityLabel("Show smaller photos").disabled(live.galleryColumns == 5)
                    Button { live.galleryColumns = max(2, live.galleryColumns - 1); live.persistLibraryState() } label: { Image(systemName: "square.grid.2x2").frame(width: 44, height: 44) }.accessibilityLabel("Show larger photos").disabled(live.galleryColumns == 2)
                }.padding(.horizontal, 16)
                if let upload = live.uploadRecovery, !upload.batch.finished {
                    Button { live.showPhotoUploads() } label: { HStack(spacing: 10) { Image(systemName: "arrow.up.circle").font(.system(size: 22)); Text(upload.batch.received ? String(localized: "Photo matching") : live.uploadRunning ? String(localized: "Uploading photos") : String(localized: "Saved photo upload")).font(.subheadline); Spacer(); Text("\(Int(upload.batch.uploadProgress * 100))% received").font(.footnote); Image(systemName: "chevron.right") }.padding(.horizontal, 16).frame(minHeight: 48).background(LoveliesTheme.surface, in: Capsule()) }.buttonStyle(LoveliesPressStyle()).padding(.horizontal, 12).accessibilityLabel("Open saved photo upload")
                }
                if live.busy { ProgressView().tint(LoveliesTheme.pink).accessibilityLabel("Loading") }
                BottomNavigation(active: screen == .allPhotos ? .allPhotos : screen == .favorites ? .favorites : screen == .newMatches ? .newMatches : .home)
            }.foregroundStyle(.white).onAppear { live.showLibrary(screen) }
        }
    }
    private var viewer: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                if chrome { PageHeader(title: "", trailing: true) }
                if let photo = live.currentPhoto {
                    ProtectedNativePhoto(photo: photo, pixels: 2200, fit: .fit)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .scaleEffect(zoom).offset(offset).clipped()
                        .gesture(MagnificationGesture().onChanged { zoom = min(6, max(1, $0)) })
                        .simultaneousGesture(DragGesture().onChanged { if zoom > 1 { offset = $0.translation } }.onEnded { value in
                            if zoom == 1 && abs(value.translation.height) > 100 && abs(value.translation.height) > abs(value.translation.width) { store.back() }
                            else if zoom == 1 && abs(value.translation.width) > 60 { movePhoto(value.translation.width < 0 ? 1 : -1) }
                        })
                        .onTapGesture(count: 2) { zoom = zoom == 1 ? 2 : 1; offset = .zero }
                        .onTapGesture { if !UIAccessibility.isVoiceOverRunning { chrome.toggle() } }
                        .accessibilityLabel(photo.title)
                        .accessibilityAction(named: "Next photo") { movePhoto(1) }
                        .accessibilityAction(named: "Previous photo") { movePhoto(-1) }
                        .accessibilityAction(named: "Close photo") { store.back() }
                        .accessibilityAction(named: "Show photo controls") { chrome = true }
                        .overlay(alignment: .topTrailing) {
                            if chrome { VStack(spacing: 5) {
                                Button { zoom = min(6, zoom + 0.5) } label: { Image(systemName: "plus.magnifyingglass").frame(width: 48, height: 48).background(.black.opacity(0.6), in: Circle()) }.accessibilityLabel("Zoom in")
                                Button { zoom = max(1, zoom - 0.5); if zoom == 1 { offset = .zero } } label: { Image(systemName: "minus.magnifyingglass").frame(width: 48, height: 48).background(.black.opacity(0.6), in: Circle()) }.accessibilityLabel("Zoom out")
                            }.padding(10) }
                        }
                    if chrome { ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: 12) {
                        Button { movePhoto(-1) } label: { Image(systemName: "chevron.left").frame(width: 48, height: 48) }.accessibilityLabel("Previous photo")
                        Button { live.saveCurrentPhoto() } label: { Image(systemName: "square.and.arrow.down").frame(width: 48, height: 48) }.accessibilityLabel("Save authorized original to Photos")
                        Button { live.shareCurrentPhoto() } label: { Image(systemName: "square.and.arrow.up").frame(width: 48, height: 48) }.accessibilityLabel("Share authorized original")
                        if photo.feedSource != "received" { Button { live.beginReview(photoIDs: [photo.id], source: photo.source, destination: .photoPeople) } label: { Image(systemName: "person.2").frame(width: 48, height: 48) }.accessibilityLabel("Matched people and exclusions") }
                        Button { live.toggleFavorite(photo.id) } label: { Image(systemName: live.favoriteIDs.contains(photo.id) ? "heart.fill" : "heart").frame(width: 48, height: 48).foregroundStyle(live.favoriteIDs.contains(photo.id) ? LoveliesTheme.pink : .white) }.accessibilityLabel(live.favoriteIDs.contains(photo.id) ? String(localized: "Remove favorite") : String(localized: "Favorite photo"))
                        Button { movePhoto(1) } label: { Image(systemName: "chevron.right").frame(width: 48, height: 48) }.accessibilityLabel("Next photo")
                    }.padding(.horizontal, 12) }.background(LoveliesTheme.canvas) }
                } else { ContentUnavailableView("Photo unavailable", systemImage: "photo", description: Text("Return to your library and refresh current access.")) }
            }.frame(width: geometry.size.width, height: geometry.size.height).foregroundStyle(.white)
                .overlay(alignment: .topLeading) {
                    if !chrome {
                        Button { store.back() } label: { Image(systemName: "xmark").frame(width: 48, height: 48).background(.black.opacity(0.75), in: Circle()) }
                            .accessibilityLabel("Close photo").padding(12)
                    }
                }
        }
    }
    private func movePhoto(_ direction: Int) {
        guard let id = live.currentPhoto?.id, let index = live.photos.firstIndex(where: { $0.id == id }), live.photos.indices.contains(index + direction) else { return }
        live.currentPhoto = live.photos[index + direction]; live.galleryAnchor = live.currentPhoto?.id; live.persistLibraryState(); zoom = 1; offset = .zero
    }
}


struct LiveAudienceGateView: View {
    @EnvironmentObject private var store: DemoStore
    @EnvironmentObject private var live: LiveAppStore
    @State private var selected: NativeAgeBand?
    var body: some View {
        VStack(spacing: 12) {
            PageHeader(title: String(localized: "Your age and privacy"), trailing: false, back: false)
            ScrollView { VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "person.crop.circle.badge.checkmark").font(.system(size: 42)).foregroundStyle(LoveliesTheme.pink).accessibilityHidden(true)
                if let audience = live.audience {
                    if audience.ageBand == .unknown {
                        Text("Choose your age range").loveliesFont(size: 24, weight: .medium).accessibilityAddTraits(.isHeader)
                        Text("Lovelies is for ages 13 and over. Ages 13–17 need a parent or legal guardian’s approval and independent review before face setup or photos. We do not ask for your date of birth.").font(.body).foregroundStyle(LoveliesTheme.secondary)
                        ForEach([NativeAgeBand.under13, .teen, .adult], id: \.rawValue) { band in
                            Button { selected = band } label: { HStack(spacing: 14) { Image(systemName: selected == band ? "largecircle.fill.circle" : "circle"); Text(band == .under13 ? String(localized: "Under 13") : band == .teen ? String(localized: "13–17") : String(localized: "18 or over")); Spacer() }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16)) }
                                .buttonStyle(LoveliesPressStyle()).accessibilityAddTraits(selected == band ? .isSelected : []).disabled(live.busy || live.audiencePendingMutation)
                        }
                        Text("Choose accurately. A minor account cannot change itself to an older age range.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                        PinkButton(title: String(localized: "Confirm age range"), enabled: selected != nil && !live.busy && !live.audiencePendingMutation) { if let selected { live.declareAge(selected) } }
                    } else if audience.ageBand == .under13 {
                        Text("Lovelies is for ages 13 and over").loveliesFont(size: 24, weight: .medium).accessibilityAddTraits(.isHeader)
                        Text("Face setup, photo import and matching are unavailable for this account. You can still manage privacy or request account deletion.").font(.body).foregroundStyle(LoveliesTheme.secondary)
                    } else {
                        NativeAudienceStatusPanel()
                    }
                } else {
                    Text("Check your audience status").loveliesFont(size: 24, weight: .medium).accessibilityAddTraits(.isHeader)
                    Text("The service must confirm your current age and approval status before camera or photo access.").font(.body).foregroundStyle(LoveliesTheme.secondary)
                }
                QuietButton(title: String(localized: "Refresh age and approval status"), enabled: !live.busy) { live.refreshAudience() }
                if live.audiencePendingMutation {
                    if !live.transferText.isEmpty { Text(live.transferText).font(.footnote).foregroundStyle(LoveliesTheme.secondary) }
                    Text("An age or guardian request is not confirmed. Retry its original saved request before starting a different action.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                    PinkButton(title: String(localized: "Retry original age or guardian request"), enabled: !live.busy) { live.refreshAudience(retryOriginal: true) }
                }
                QuietButton(title: String(localized: "Privacy center"), enabled: !live.busy) { store.go(.privacy, simulateProgress: false); live.loadPrivacy() }
                if live.hasRegisteredPrivacyIdentity { QuietButton(title: String(localized: "Account & security"), enabled: !live.busy) { store.go(.security, simulateProgress: false); live.loadDevices() } }
                QuietButton(title: String(localized: "Sign out"), enabled: !live.busy) { live.logout() }
                NativePolicyPanel(includeSupport: true)
                if live.busy { ProgressView().tint(LoveliesTheme.pink) }
            }.padding(22).frame(maxWidth: .infinity, alignment: .leading) }.scrollDismissesKeyboard(.interactively)
        }.foregroundStyle(.white)
    }
}
struct NativeAudienceStatusPanel: View {
    @EnvironmentObject private var live: LiveAppStore
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Age and guardian approval").font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
            if let audience = live.audience {
                Text(live.audienceEligible ? String(localized: "Audience approval is current. Your own purpose consent and photo sharing approval are still required.") : String(localized: "Face setup and photos are paused until the required approval is current.")).font(.body).foregroundStyle(LoveliesTheme.secondary)
                if let request = audience.guardianRequest {
                    Text(NativeGuardianCopy.state(request.state)).font(.headline).foregroundStyle(LoveliesTheme.pink)
                    Text("Guardian request reference").font(.footnote)
                    Text(request.id + ":" + String(request.revision)).font(.footnote.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text("Share this reference privately with your parent or legal guardian. They need their own registered adult Lovelies account. A reference never gives access to your photos.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
                    Text(request.expiresAt, format: .dateTime.year().month().day()).font(.footnote).accessibilityLabel("Approval or request expiry")
                    if request.live { QuietButton(title: String(localized: "Withdraw guardian request or approval"), enabled: !live.busy && !live.audiencePendingMutation) { live.withdrawGuardian(request) } }
                }
                if audience.ageBand == .teen, audience.guardianRequest?.live != true {
                    PinkButton(title: String(localized: "Create guardian review request"), enabled: !live.busy && !live.audiencePendingMutation) { live.requestGuardianReview() }
                }
            }
            Text("Guardian approval requires independent review. Sending or claiming a request does not activate face processing or give anyone photo access.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
        }.padding(16).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16))
    }
}
enum NativeGuardianCopy {
    static func state(_ state: NativeGuardianRequest.State) -> String {
        switch state {
        case .pending: return String(localized: "Waiting for a guardian")
        case .underReview: return String(localized: "Guardian claim awaiting independent review")
        case .approved: return String(localized: "Guardian review approved")
        case .rejected: return String(localized: "Guardian review rejected")
        case .withdrawn: return String(localized: "Guardian approval withdrawn")
        case .expired: return String(localized: "Guardian request or approval expired")
        }
    }
}
