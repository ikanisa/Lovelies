import SwiftUI
import UIKit
import AVFoundation
import Photos
import PhotosUI
import UniformTypeIdentifiers
import ImageIO

private final class NativeCaptureCancellation: @unchecked Sendable {
    private let lock = NSLock(); private var value = false
    var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func cancel() { lock.lock(); defer { lock.unlock() }; value = true }
}

final class NativeCamera: NSObject, ObservableObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.lovelies.camera")
    private let output = AVCapturePhotoOutput()
    private let authority = NativeCameraAuthority()
    private let captureLock = NSLock()
    private var pending: (request: UUID, ticket: NativeCameraTicket, completion: CheckedContinuation<Data, Error>, processed: Data?)?
    private var scopedStart: (expiresAt: Date, check: @MainActor @Sendable () async throws -> Void)?
    private var configured = false
    private var observers: [NSObjectProtocol] = []
    private var rotation: CGFloat = 90
    @Published private(set) var state = NativeCameraAuthority().snapshot
    var ready: Bool { state.ready }
    var error: String? { state.issue?.localizedDescription }
    var currentState: NativeCameraSnapshot { authority.snapshot }
    override init() {
        super.init()
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { [weak self] _ in self?.interrupt(.interrupted) })
        observers.append(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: nil) { [weak self] _ in self?.resumeIfWanted() })
        observers.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
            self?.runtimeError(reset: error?.code == AVError.Code.mediaServicesWereReset.rawValue)
        })
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.setForeground(false) })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.setForeground(true) })
    }
    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        captureLock.lock(); let unfinished = pending; pending = nil; captureLock.unlock()
        if var unfinished { let count = unfinished.processed?.count ?? 0; unfinished.processed?.resetBytes(in: 0..<count); unfinished.completion.resume(throwing: CancellationError()) }
    }
    private static func permission() -> NativeCameraPermission {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .authorized
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        default: return .denied
        }
    }
    private func publish() {
        let snapshot = authority.snapshot
        DispatchQueue.main.async { [weak self] in
            guard let self, self.authority.snapshot.generation == snapshot.generation else { return }
            self.state = snapshot
        }
    }
    private func saveScopedStart(expiresAt: Date, check: @escaping @MainActor @Sendable () async throws -> Void) {
        captureLock.lock(); scopedStart = (expiresAt, check); captureLock.unlock()
    }
    func start(expiresAt: Date, requireCurrent: @escaping @MainActor @Sendable () async throws -> Void) async {
        do { try await requireCurrent() } catch { stop(); return }
        guard expiresAt > Date(), !Task.isCancelled else { stop(); return }
        saveScopedStart(expiresAt: expiresAt, check: requireCurrent)
        let active = await MainActor.run { UIApplication.shared.applicationState == .active }
        let permission = Self.permission(), existing = authority.snapshot
        guard !(existing.ready && permission == .authorized && active) else { return }
        let ticket = authority.start(permission: permission, foreground: active)
        cancelPending(CancellationError()); publish()
        guard let ticket else { stopPhysical(); return }
        if permission == .notDetermined {
            DispatchQueue.global().asyncAfter(deadline: .now() + 30) { [weak self] in
                guard let self, self.authority.fail(ticket, issue: .initializingTimeout, onlyIfPhase: .permissionPending) else { return }; self.publish()
            }
            // Await the actual OS reply. Its callback cannot initialize a camera
            // later using an expired/revoked request's earlier authorization.
            _ = await withCheckedContinuation { (completion: CheckedContinuation<Bool, Never>) in
                AVCaptureDevice.requestAccess(for: .video) { allowed in completion.resume(returning: allowed) }
            }
            guard authority.resolvePermission(ticket, permission: Self.permission()) else { publish(); return }
        }
        do { try await requireCurrent() } catch { _ = authority.fail(ticket, issue: .captureUnavailable); publish(); stopPhysical(); return }
        guard !Task.isCancelled, expiresAt > Date(), authority.accepts(ticket) else { stopPhysical(); return }
        initialize(ticket, expiresAt: expiresAt, requireCurrent: requireCurrent)
    }
    private func initialize(_ ticket: NativeCameraTicket, expiresAt: Date, requireCurrent: @escaping @MainActor @Sendable () async throws -> Void) {
        DispatchQueue.global().asyncAfter(deadline: .now() + 12) { [weak self] in
            guard let self, self.authority.fail(ticket, issue: .initializingTimeout, onlyIfPhase: .initializing) else { return }
            self.publish(); self.stopPhysical()
        }
        queue.async { [weak self] in
            guard let self, expiresAt > Date(), self.authority.accepts(ticket) else { return }
            do {
                guard Self.permission() == .authorized else { throw NativeCameraIssue.permissionChanged }
                if !self.configured {
                    self.session.beginConfiguration()
                    do {
                        guard self.session.canSetSessionPreset(.photo) else { throw NativeCameraIssue.cameraUnavailable }
                        self.session.sessionPreset = .photo
                        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else { throw NativeCameraIssue.cameraUnavailable }
                        let input = try AVCaptureDeviceInput(device: device)
                        guard self.session.canAddInput(input), self.session.canAddOutput(self.output) else { throw NativeCameraIssue.cameraUnavailable }
                        self.session.addInput(input); self.session.addOutput(self.output)
                        self.output.maxPhotoQualityPrioritization = .balanced
                        self.session.commitConfiguration(); self.configured = true
                    } catch {
                        for input in self.session.inputs { self.session.removeInput(input) }
                        for output in self.session.outputs { self.session.removeOutput(output) }
                        self.session.commitConfiguration(); throw error
                    }
                }
                self.applyRotation()
                // Configuration may have waited on the serial capture queue.
                // Recheck the same request once more before starting hardware.
                Task { [weak self] in
                    do {
                        try await requireCurrent()
                        guard let self, expiresAt > Date(), self.authority.accepts(ticket) else { return }
                        self.queue.async { [weak self] in
                            guard let self, expiresAt > Date(), self.authority.accepts(ticket), Self.permission() == .authorized else { return }
                            self.session.startRunning()
                            guard self.authority.didStart(ticket, running: self.session.isRunning) else {
                                if !self.authority.snapshot.ready && self.session.isRunning { self.session.stopRunning() }; return
                            }
                            self.publish()
                        }
                    } catch {
                        guard let self else { return }
                        if self.authority.fail(ticket, issue: .captureUnavailable) { self.publish(); self.stopPhysical() }
                    }
                }
            } catch {
                if self.authority.fail(ticket, issue: error as? NativeCameraIssue ?? .cameraUnavailable) { self.publish() }
            }
        }
    }
    func capture() async throws -> Data {
        let request = UUID(), cancellation = NativeCaptureCancellation()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { (completion: CheckedContinuation<Data, Error>) in
                queue.async { [self] in
                    guard !cancellation.cancelled else { completion.resume(throwing: CancellationError()); return }
                    guard Self.permission() == .authorized else {
                        interrupt(.permissionChanged); completion.resume(throwing: NativeCameraIssue.permissionChanged); return
                    }
                    guard configured, session.isRunning else { completion.resume(throwing: NativeCameraIssue.cameraUnavailable); return }
                    guard output.availablePhotoCodecTypes.contains(.jpeg) else { completion.resume(throwing: NativeCameraIssue.invalidImage); return }
                    applyRotation()
                    let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                    settings.photoQualityPrioritization = .balanced
                    guard let ticket = authority.beginPhoto(settings.uniqueID) else { completion.resume(throwing: NativeCameraIssue.captureUnavailable); return }
                    captureLock.lock(); pending = (request, ticket, completion, nil); captureLock.unlock()
                    guard !cancellation.cancelled else { cancelCapture(request); return }
                    publish()
                    DispatchQueue.global().asyncAfter(deadline: .now() + 12) { [weak self] in self?.finish(ticket, result: .failure(NativeCameraIssue.captureTimeout)) }
                    output.capturePhoto(with: settings, delegate: self)
                }
            }
        }, onCancel: { [weak self] in cancellation.cancel(); self?.cancelCapture(request) })
    }
    private func cancelCapture(_ request: UUID) {
        captureLock.lock()
        let capture = pending?.request == request ? pending : nil
        if capture != nil { pending = nil }; captureLock.unlock()
        if var capture { let count = capture.processed?.count ?? 0; capture.processed?.resetBytes(in: 0..<count); _ = authority.fail(capture.ticket, issue: .captureUnavailable); publish(); capture.completion.resume(throwing: CancellationError()) }
    }
    private func cancelPending(_ error: Error) {
        captureLock.lock(); let capture = pending; pending = nil; captureLock.unlock()
        if var capture { let count = capture.processed?.count ?? 0; capture.processed?.resetBytes(in: 0..<count); capture.completion.resume(throwing: error) }
    }
    private func finish(_ ticket: NativeCameraTicket, result: Result<Data, Error>) {
        captureLock.lock()
        let capture = pending?.ticket == ticket ? pending : nil
        if capture != nil { pending = nil }; captureLock.unlock()
        guard var capture else { return }
        defer { let count = capture.processed?.count ?? 0; capture.processed?.resetBytes(in: 0..<count) }
        switch result {
        case .success(var data):
            guard Self.permission() == .authorized, authority.finishPhoto(ticket) else {
                _ = authority.fail(ticket, issue: Self.permission() == .authorized ? .captureUnavailable : .permissionChanged)
                publish(); data.resetBytes(in: 0..<data.count); capture.completion.resume(throwing: CancellationError()); return
            }
            publish(); capture.completion.resume(returning: data)
        case .failure(let error):
            _ = authority.fail(ticket, issue: error as? NativeCameraIssue ?? .captureUnavailable)
            publish(); capture.completion.resume(throwing: error)
        }
    }
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let uniqueID = photo.resolvedSettings.uniqueID
        captureLock.lock(); let ticket = pending?.ticket.photoID == uniqueID ? pending?.ticket : nil; captureLock.unlock()
        guard let ticket, authority.accepts(ticket) else { return }
        if let error { finish(ticket, result: .failure(error)); return }
        queue.async { [weak self] in
            guard let self, self.authority.accepts(ticket) else { return }
            guard var raw = photo.fileDataRepresentation(), !raw.isEmpty, raw.count <= 32 * 1024 * 1024 else { self.finish(ticket, result: .failure(NativeCameraIssue.captureUnavailable)); return }
            defer { raw.resetBytes(in: 0..<raw.count) }
            guard let source = CGImageSourceCreateWithData(raw as CFData, nil),
                  CGImageSourceGetCount(source) == 1,
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2048] as CFDictionary),
                  let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.88), !data.isEmpty else { self.finish(ticket, result: .failure(NativeCameraIssue.invalidImage)); return }
            guard data.count <= 8 * 1024 * 1024 else { self.finish(ticket, result: .failure(NativeCameraIssue.captureTooLarge)); return }
            self.captureLock.lock()
            if self.pending?.ticket == ticket && self.authority.didProcessPhoto(ticket) { self.pending?.processed = data }
            self.captureLock.unlock()
        }
    }
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        captureLock.lock(); let ticket = pending?.ticket.photoID == resolvedSettings.uniqueID ? pending?.ticket : nil; captureLock.unlock()
        guard let ticket else { return }
        queue.async { [weak self] in
            guard let self else { return }
            if let error { self.finish(ticket, result: .failure(error)); return }
            self.captureLock.lock(); let data = self.pending?.ticket == ticket ? self.pending?.processed : nil; self.captureLock.unlock()
            guard let data else { self.finish(ticket, result: .failure(NativeCameraIssue.captureUnavailable)); return }
            self.finish(ticket, result: .success(data))
        }
    }
    private func interrupt(_ issue: NativeCameraIssue) {
        let current = authority.snapshot
        _ = authority.fail(NativeCameraTicket(generation: current.generation, photoID: nil), issue: issue)
        cancelPending(issue); publish(); stopPhysical()
    }
    private func runtimeError(reset: Bool) {
        interrupt(reset ? .mediaServicesReset : .cameraUnavailable)
        if reset {
            queue.async { [weak self] in
                guard let self else { return }
                self.session.beginConfiguration()
                for input in self.session.inputs { self.session.removeInput(input) }
                for output in self.session.outputs { self.session.removeOutput(output) }
                self.session.commitConfiguration(); self.configured = false
                self.resumeIfWanted()
            }
        }
    }
    private func resumeIfWanted() {
        guard authority.snapshot.wanted, authority.snapshot.foreground else { return }
        captureLock.lock(); let scoped = scopedStart; captureLock.unlock()
        guard let scoped, scoped.expiresAt > Date() else { stop(); return }
        Task { [weak self] in await self?.start(expiresAt: scoped.expiresAt, requireCurrent: scoped.check) }
    }
    func setForeground(_ active: Bool) {
        let wanted = authority.snapshot.wanted
        authority.suspend(foreground: active); cancelPending(CancellationError()); publish()
        if active && wanted { resumeIfWanted() } else { stopPhysical() }
    }
    private func stopPhysical() { queue.async { [weak self] in if let self, self.session.isRunning { self.session.stopRunning() } } }
    func stop() { captureLock.lock(); scopedStart = nil; captureLock.unlock(); authority.suspend(foreground: authority.snapshot.foreground, stop: true); cancelPending(CancellationError()); publish(); stopPhysical() }
    func setRotation(_ angle: CGFloat) { queue.async { [weak self] in self?.rotation = angle; self?.applyRotation() } }
    private func applyRotation() {
        if let connection = output.connection(with: .video) {
            if connection.isVideoRotationAngleSupported(rotation) { connection.videoRotationAngle = rotation }
            if connection.isVideoMirroringSupported { connection.automaticallyAdjustsVideoMirroring = false; connection.isVideoMirrored = true }
        }
    }
}

private final class CameraPreviewSurface: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    weak var camera: NativeCamera?
    override func layoutSubviews() {
        super.layoutSubviews()
        let angle: CGFloat
        switch window?.windowScene?.interfaceOrientation {
        case .portraitUpsideDown: angle = 270
        case .landscapeLeft: angle = 0
        case .landscapeRight: angle = 180
        default: angle = 90
        }
        if let connection = preview.connection {
            if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
            if connection.isVideoMirroringSupported { connection.automaticallyAdjustsVideoMirroring = false; connection.isVideoMirrored = true }
        }
        camera?.setRotation(angle)
    }
}
struct NativeCameraPreview: UIViewRepresentable {
    let camera: NativeCamera
    func makeUIView(context: Context) -> UIView {
        let view = CameraPreviewSurface(); view.camera = camera; view.preview.session = camera.session; view.preview.videoGravity = .resizeAspectFill
        return view
    }
    func updateUIView(_ uiView: UIView, context: Context) { uiView.setNeedsLayout() }
}

struct NativeImport: Identifiable, Codable, Sendable {
    let id: String, file: URL, title: String, width: Int, height: Int
    var ratio: Double { Double(height) / Double(width) }
    static func store(_ data: Data) throws -> NativeImport {
        guard !data.isEmpty, data.count <= 32 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let rawWidth = properties[kCGImagePropertyPixelWidth] as? Int, let rawHeight = properties[kCGImagePropertyPixelHeight] as? Int,
              rawWidth > 0, rawHeight > 0, rawWidth <= 100_000, rawHeight <= 100_000,
              Int64(rawWidth) * Int64(rawHeight) <= 100_000_000 else { throw NativeAPIError.unsupported(String(localized: "Choose one still image within the photo size limit. Animated images and RAW require conversion first.")) }
        if let sourceType = CGImageSourceGetType(source), UTType(sourceType as String)?.conforms(to: .rawImage) == true {
            throw NativeAPIError.unsupported(String(localized: "RAW requires an exported JPEG, PNG or WebP copy before importing."))
        }
        let bytes: Data, content: NativeUploadContentType, width: Int, height: Int, title: String
        if let original = NativeUploadContentType.detect(data) {
            guard data.count <= 20 * 1024 * 1024 else { throw NativeAPIError.unsupported(String(localized: "This original exceeds 20 MB. Export a smaller copy before selecting it.")) }
            // Preserve the exact original JPEG/PNG/WebP bytes. Display metadata
            // accounts for orientation without re-encoding the uploaded photo.
            bytes = data; content = original
            let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
            width = (5...8).contains(orientation) ? rawHeight : rawWidth
            height = (5...8).contains(orientation) ? rawWidth : rawHeight
            title = String(localized: "Imported photo")
        } else {
            // Inference accepts JPEG/PNG/WebP. HEIC and other decodable still
            // images become an explicit converted copy, visible before Upload.
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 4096] as CFDictionary),
                  let converted = UIImage(cgImage: image).jpegData(compressionQuality: 0.9), converted.count <= 20 * 1024 * 1024 else { throw NativeAPIError.unsupported(String(localized: "This format needs conversion to JPEG, PNG or WebP before importing.")) }
            bytes = converted; content = .jpeg; width = image.width; height = image.height; title = String(localized: "Converted photo (JPEG)")
        }
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("LoveliesPrivateImports", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased(), file = root.appendingPathComponent(id + "." + content.fileExtension)
        try bytes.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues(); values.isExcludedFromBackup = true; var mutable = file; try mutable.setResourceValues(values)
        return NativeImport(id: id, file: file, title: title, width: width, height: height)
    }
    static func removeAll() {
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("LoveliesPrivateImports", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
    }
    static func removeCameraItem(_ item: NativeImport) {
        guard UUID(uuidString: item.id) != nil else { return }
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("LoveliesPrivateImports", isDirectory: true)
        guard ["jpg", "png", "webp"].contains(item.file.pathExtension) else { return }
        let expected = root.appendingPathComponent(item.id + "." + item.file.pathExtension).standardizedFileURL
        guard item.file.standardizedFileURL == expected else { return }
        try? FileManager.default.removeItem(at: expected)
    }
}

struct NativePhotoPicker: UIViewControllerRepresentable {
    let isCurrent: @MainActor () async -> Bool
    let completion: ([NativeImport], String?) -> Void
    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared()); config.filter = .images; config.selectionLimit = 30
        config.preferredAssetRepresentationMode = .current
        let controller = PHPickerViewController(configuration: config); controller.delegate = context.coordinator; return controller
    }
    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(isCurrent: isCurrent, completion: completion) }
    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let isCurrent: @MainActor () async -> Bool
        let completion: ([NativeImport], String?) -> Void
        init(isCurrent: @escaping @MainActor () async -> Bool, completion: @escaping ([NativeImport], String?) -> Void) { self.isCurrent = isCurrent; self.completion = completion }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            Task {
                var imports: [NativeImport] = [], failure: String?
                for result in results {
                    do {
                        guard await isCurrent() else { break }
                        let data = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                            result.itemProvider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, error in
                                if let error { continuation.resume(throwing: error) }
                                else if let data { continuation.resume(returning: data) }
                                else { continuation.resume(throwing: NativeAPIError.invalidResponse) }
                            }
                        }
                        guard await isCurrent() else { break }
                        let item = try await Task.detached(priority: .userInitiated) { try NativeImport.store(data) }.value
                        imports.append(item)
                        guard await isCurrent() else { break }
                    } catch { failure = error.localizedDescription; break }
                }
                if !(await isCurrent()) {
                    for item in imports { NativeImport.removeCameraItem(item) }
                    imports = []; failure = nil
                }
                await MainActor.run { self.completion(imports, failure) }
            }
        }
    }
}

enum NativePhotoLibrary {
    static func save(_ data: Data, requireCurrent: @MainActor () async throws -> Void) async throws {
        try await requireCurrent()
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw NativeAPIError.unsupported(String(localized: "Allow saving to Photos in Settings.")) }
        try await requireCurrent()
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
        }
    }
}

struct NativeOrdinaryPhotoCamera: UIViewControllerRepresentable {
    let request: NativeMediaCaptureContext
    let isCurrent: @MainActor (NativeMediaCaptureContext) async -> Bool
    let completion: (NativeMediaCaptureContext, [NativeImport], String?) -> Void
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController(); controller.sourceType = .camera
        controller.cameraCaptureMode = .photo; controller.delegate = context.coordinator; return controller
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    static func dismantleUIViewController(_ uiViewController: UIImagePickerController, coordinator: Coordinator) {
        coordinator.invalidate(); uiViewController.delegate = nil
    }
    func makeCoordinator() -> Coordinator { Coordinator(request: request, isCurrent: isCurrent, completion: completion) }
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        // The delegate retains the opening owner; representable updates never replace it.
        let request: NativeMediaCaptureContext
        let isCurrent: @MainActor (NativeMediaCaptureContext) async -> Bool
        let completion: (NativeMediaCaptureContext, [NativeImport], String?) -> Void
        private var active = true, handling = false
        private var captureTask: Task<Void, Never>?
        init(request: NativeMediaCaptureContext, isCurrent: @escaping @MainActor (NativeMediaCaptureContext) async -> Bool, completion: @escaping (NativeMediaCaptureContext, [NativeImport], String?) -> Void) {
            self.request = request; self.isCurrent = isCurrent; self.completion = completion
        }
        func invalidate() { active = false; captureTask?.cancel(); captureTask = nil }
        private func finish(_ items: [NativeImport], failure: String?) {
            guard active else { for item in items { NativeImport.removeCameraItem(item) }; return }
            active = false; completion(request, items, failure)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { captureTask?.cancel(); finish([], failure: nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            guard active, !handling else { return }; handling = true
            let image = info[.originalImage] as? UIImage
            // Keep the sheet alive until this owner finishes; dismissal invalidates
            // any task still awaiting authority or the private staging write.
            captureTask = Task { @MainActor [self] in
                guard active, !Task.isCancelled, await isCurrent(request), active, !Task.isCancelled else { finish([], failure: nil); return }
                guard let image, let bytes = image.jpegData(compressionQuality: 0.92) else { finish([], failure: String(localized: "The camera image was unavailable.")); return }
                do {
                    guard active, !Task.isCancelled, await isCurrent(request), active, !Task.isCancelled else { finish([], failure: nil); return }
                    let item = try await Task.detached(priority: .userInitiated) { try NativeImport.store(bytes) }.value
                    guard active, !Task.isCancelled, await isCurrent(request), active, !Task.isCancelled else { NativeImport.removeCameraItem(item); finish([], failure: nil); return }
                    finish([item], failure: nil)
                } catch { finish([], failure: error.localizedDescription) }
            }
        }
    }
}
