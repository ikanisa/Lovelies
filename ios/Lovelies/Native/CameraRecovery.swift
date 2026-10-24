import Foundation
import CryptoKit

enum NativeCameraPermission: String, Sendable { case notDetermined, authorized, denied, restricted }
enum NativeCameraIssue: String, Error, LocalizedError, Sendable {
    case permissionDenied, permissionRestricted, permissionChanged, initializingTimeout, captureTimeout
    case cameraUnavailable, interrupted, mediaServicesReset, captureUnavailable, invalidImage, captureTooLarge
    var errorDescription: String? {
        switch self {
        case .permissionDenied, .permissionChanged: return String(localized: "Allow camera access in Settings, then return to take your selfie.")
        case .permissionRestricted: return String(localized: "Camera access is restricted on this device. Check the device restrictions before continuing.")
        case .initializingTimeout: return String(localized: "The camera did not start. Try opening it again.")
        case .captureTimeout: return String(localized: "The camera did not return this photo. Retake it; no selfie was sent.")
        case .cameraUnavailable: return String(localized: "A front camera is unavailable. Try again on a device with a working front camera.")
        case .interrupted: return String(localized: "The camera was interrupted. Return to the app and try again.")
        case .mediaServicesReset: return String(localized: "The camera service restarted. Open the camera again.")
        case .captureUnavailable: return String(localized: "The camera photo is unavailable. Retake it.")
        case .invalidImage: return String(localized: "This photo could not be read. Retake it.")
        case .captureTooLarge: return String(localized: "This photo is too large. Retake it at a smaller size.")
        }
    }
}
enum NativeCameraPhase: String, Sendable { case stopped, permissionPending, initializing, ready, capturing, interrupted, unavailable, denied, restricted }
struct NativeCameraSnapshot: Sendable, Equatable {
    let generation: UInt64, phase: NativeCameraPhase, permission: NativeCameraPermission
    let foreground: Bool, wanted: Bool, photoID: Int64?, photoProcessed: Bool, issue: NativeCameraIssue?
    var ready: Bool { foreground && wanted && permission == .authorized && phase == .ready }
    var canOpenSettings: Bool { phase == .denied }
}
struct NativeCameraTicket: Sendable, Equatable { let generation: UInt64, photoID: Int64? }

/// Shared by the AVFoundation adapter and host tests. The lock fences callbacks
/// even while startRunning/stopRunning is blocking the camera's serial queue.
final class NativeCameraAuthority: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var phase: NativeCameraPhase = .stopped
    private var permission: NativeCameraPermission = .notDetermined
    private var foreground = true, wanted = false
    private var photoID: Int64?, issue: NativeCameraIssue?
    private var photoProcessed = false
    private func locked<T>(_ work: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return work() }
    var snapshot: NativeCameraSnapshot { locked { NativeCameraSnapshot(generation: generation, phase: phase, permission: permission, foreground: foreground, wanted: wanted, photoID: photoID, photoProcessed: photoProcessed, issue: issue) } }
    func start(permission next: NativeCameraPermission, foreground active: Bool) -> NativeCameraTicket? {
        locked {
            generation &+= 1; permission = next; foreground = active; wanted = true; photoID = nil; photoProcessed = false; issue = nil
            guard active else { phase = .stopped; return nil }
            switch next {
            case .authorized: phase = .initializing
            case .notDetermined: phase = .permissionPending
            case .denied: phase = .denied; issue = .permissionDenied; return nil
            case .restricted: phase = .restricted; issue = .permissionRestricted; return nil
            }
            return NativeCameraTicket(generation: generation, photoID: nil)
        }
    }
    func resolvePermission(_ ticket: NativeCameraTicket, permission next: NativeCameraPermission) -> Bool {
        locked {
            guard generation == ticket.generation, phase == .permissionPending, foreground, wanted else { return false }
            permission = next
            if next == .authorized { phase = .initializing; return true }
            phase = next == .restricted ? .restricted : .denied
            issue = next == .restricted ? .permissionRestricted : .permissionDenied
            return false
        }
    }
    func accepts(_ ticket: NativeCameraTicket) -> Bool {
        locked { generation == ticket.generation && foreground && wanted && permission == .authorized && (ticket.photoID == nil || photoID == ticket.photoID) }
    }
    @discardableResult func didStart(_ ticket: NativeCameraTicket, running: Bool) -> Bool {
        locked {
            guard generation == ticket.generation, phase == .initializing, foreground, wanted, permission == .authorized else { return false }
            phase = running ? .ready : .unavailable; issue = running ? nil : .cameraUnavailable; return running
        }
    }
    func beginPhoto(_ id: Int64) -> NativeCameraTicket? {
        locked {
            guard foreground, wanted, permission == .authorized, phase == .ready, photoID == nil else { return nil }
            phase = .capturing; photoID = id; photoProcessed = false; return NativeCameraTicket(generation: generation, photoID: id)
        }
    }
    @discardableResult func didProcessPhoto(_ ticket: NativeCameraTicket) -> Bool {
        locked {
            guard generation == ticket.generation, photoID == ticket.photoID, ticket.photoID != nil, phase == .capturing, !photoProcessed, foreground, wanted, permission == .authorized else { return false }
            photoProcessed = true; return true
        }
    }
    @discardableResult func finishPhoto(_ ticket: NativeCameraTicket) -> Bool {
        locked {
            guard generation == ticket.generation, photoID == ticket.photoID, ticket.photoID != nil, phase == .capturing, photoProcessed, foreground, wanted, permission == .authorized else { return false }
            photoID = nil; photoProcessed = false; phase = .ready; issue = nil; return true
        }
    }
    @discardableResult func fail(_ ticket: NativeCameraTicket, issue next: NativeCameraIssue, onlyIfPhase expected: NativeCameraPhase? = nil) -> Bool {
        locked {
            guard generation == ticket.generation, expected == nil || phase == expected,
                  ticket.photoID == nil || photoID == ticket.photoID else { return false }
            generation &+= 1; photoID = nil; photoProcessed = false; issue = next
            phase = next == .permissionChanged ? .denied : next == .interrupted ? .interrupted : .unavailable
            if next == .permissionChanged { permission = .denied }
            return true
        }
    }
    func suspend(foreground active: Bool, stop: Bool = false, issue next: NativeCameraIssue? = nil) {
        locked {
            generation &+= 1; foreground = active; if stop { wanted = false }
            photoID = nil; photoProcessed = false; issue = next; phase = next == .interrupted ? .interrupted : .stopped
        }
    }
}

enum NativeFaceQualityFailure: String, Sendable, CaseIterable {
    case noFace = "face_capture_no_face", multipleFaces = "face_capture_multiple_faces"
    case qualityLow = "face_capture_quality_low", invalidImage = "face_capture_invalid_image"
    static func from(_ error: Error) -> NativeFaceQualityFailure? {
        guard case NativeAPIError.denied(422, let code) = error else { return nil }; return Self(rawValue: code)
    }
    var message: String {
        switch self {
        case .noFace: return String(localized: "No face was found. Center your face in the frame and retake the selfies.")
        case .multipleFaces: return String(localized: "More than one face was found. Make sure only your face is in the frame and retake the selfies.")
        case .qualityLow: return String(localized: "The selfies were not clear enough. Hold the phone steady, use even lighting, and retake them.")
        case .invalidImage: return String(localized: "A selfie could not be read. Retake the selfies.")
        }
    }
}
enum NativeFaceTerminalFailure {
    static func code(_ error: Error) -> String? {
        if let quality = NativeFaceQualityFailure.from(error) { return quality.rawValue }
        if case NativeAPIError.denied(401, "face_verification_failed") = error { return "face_verification_failed" }
        return nil
    }
    static func known(_ code: String?) -> Bool { code == "face_verification_failed" || code.flatMap(NativeFaceQualityFailure.init(rawValue:)) != nil }
}

/// This is a local, decoded photograph for review, never a verified profile.
/// Only the chosen current candidate can reach the signed repository upload.
struct NativeSelfieCandidate: Sendable {
    let id: UUID, context: NativeFaceShutterContext, index: Int, publicationGeneration: Int, sessionEpoch: Int?
    let cameraGeneration: UInt64, createdAt: Date
    private(set) var bytes: Data
    init(bytes: Data, challenge: NativeFaceChallenge, index: Int, publicationGeneration: Int, sessionEpoch: Int?, cameraGeneration: UInt64, now: Date = Date()) throws {
        guard !bytes.isEmpty, bytes.count <= 8 * 1024 * 1024, bytes.starts(with: [0xff, 0xd8, 0xff]), challenge.poses.indices.contains(index), challenge.expiresAt > now else { throw NativeCameraIssue.invalidImage }
        id = UUID(); context = NativeFaceShutterContext(challenge); self.index = index; self.publicationGeneration = publicationGeneration
        self.sessionEpoch = sessionEpoch; self.cameraGeneration = cameraGeneration; createdAt = now; self.bytes = bytes
    }
    func requireCurrent(challenge: NativeFaceChallenge?, receipts: [WireValue], publicationGeneration: Int, sessionEpoch: Int?, camera: NativeCameraSnapshot, foreground: Bool, now: Date = Date()) throws {
        guard !bytes.isEmpty, bytes.count <= 8 * 1024 * 1024, bytes.starts(with: [0xff, 0xd8, 0xff]) else { throw NativeCameraIssue.captureUnavailable }
        guard foreground, camera.ready, camera.generation == cameraGeneration,
              context.permits(challenge), challenge!.expiresAt > now, receipts.count == index,
              self.publicationGeneration == publicationGeneration, self.sessionEpoch == sessionEpoch else { throw NativeAPIError.sessionChanged }
        guard receipts.reduce(0, { $0 + ($1["byte_size"].integer ?? 0) }) + bytes.count <= 8 * 1024 * 1024 else { throw NativeCameraIssue.captureTooLarge }
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard receipts.allSatisfy({ $0["sha256"].string != hash }) else { throw NativeAPIError.unsupported(String(localized: "Take a new selfie for this pose. Previously submitted captures cannot be reused.")) }
    }
    mutating func retire() { bytes.resetBytes(in: 0..<bytes.count); bytes.removeAll(keepingCapacity: false) }
}

struct NativeFaceRetakeResult: Sendable {
    let challenge: NativeFaceChallenge?, receipts: [WireValue]
    let awaitingServer: Bool
}

/// Generic retained-device sign-in uses this protected proof/promotion journal
/// when A01/A02/A03 are absent. Unknown replies never become a new guest account.
struct NativeOrdinaryLoginRecord: Codable, Sendable {
    let apiOrigin: String, originalDevice: RegisteredDevice, publicJWK: WireValue, publicKeyDigest: String
    let challengeWire: WireValue, createdAt: Date
    var bindingSignature: String
    var captures: [NativeEnrollmentCapture] = []
    var completionPending = false
    var terminalQualityCode: String?
    var terminalMismatch: Bool?
    var promotionCredentials: NativeCredentials?
    var keyAlias: String { originalDevice.keyAlias ?? NativeEnrollmentRecord.keyAlias }
    var binding: WireValue {
        .object(["protocol": .string("lovelies-ordinary-face-login-device-v1"), "api_origin": .string(apiOrigin),
            "account_id": .string(originalDevice.accountID), "device_id": .string(originalDevice.deviceID),
            "key_alias": .string(keyAlias), "public_key_digest": .string(publicKeyDigest), "challenge": challengeWire])
    }
    func key() throws -> P256.Signing.PublicKey {
        guard publicJWK["kty"].string == "EC", publicJWK["crv"].string == "P-256", publicJWK["ext"].bool == true,
              publicJWK["key_ops"] == .strings(["verify"]), publicJWK.object?.count == 6,
              let x = publicJWK["x"].string.flatMap(Data.init(base64URL:)), let y = publicJWK["y"].string.flatMap(Data.init(base64URL:)), x.count == 32, y.count == 32 else { throw NativeAPIError.invalidResponse }
        return try P256.Signing.PublicKey(x963Representation: Data([4]) + x + y)
    }
    func validate(origin: URL, now: Date = Date()) throws {
        guard apiOrigin == origin.absoluteString, createdAt <= now.addingTimeInterval(120),
              originalDevice.faceHandle.hasPrefix("lfh_"), originalDevice.faceHandle.count == 47,
              NativeAccountRecoveryRecord.validAlias(keyAlias),
              SHA256.hash(data: try publicJWK.canonical()).map({ String(format: "%02x", $0) }).joined() == publicKeyDigest,
              let signature = Data(base64URL: bindingSignature), signature.count == 64,
              try key().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: signature), for: binding.canonical()) else { throw NativeAPIError.invalidResponse }
        let challenge = try NativeFaceChallenge(challengeWire, accountID: originalDevice.accountID, purpose: "login", now: createdAt, allowExpired: true)
        guard challenge.expiresAt > createdAt, challenge.deviceID == originalDevice.deviceID, challenge.poses == ["front"], challengeWire["profile_id"].string == originalDevice.profileID,
              challengeWire["profile_revision"].string == originalDevice.profileRevision, challengeWire["model_id"].string == originalDevice.modelID,
              captures.count <= 1, captures.enumerated().allSatisfy({ $0.offset == $0.element.index }),
              !completionPending || captures.count == 1 && captures[0].accepted,
              terminalQualityCode == nil || NativeFaceQualityFailure(rawValue: terminalQualityCode!) != nil else { throw NativeAPIError.invalidResponse }
        for capture in captures { try capture.validate() }
        if let promotionCredentials { try promotionCredentials.validateRegisteredRecovery(accountID: originalDevice.accountID) }
    }
}

struct NativeOrdinaryLoginSummary: Sendable {
    let challenge: NativeFaceChallenge, receipts: [WireValue], awaitingServer: Bool
    let terminalQuality: NativeFaceQualityFailure?
    let terminalMismatch: Bool
    var canRetry: Bool { terminalQuality != nil || terminalMismatch || challenge.expiresAt <= Date() }
}

struct NativeMediaCaptureContext: Sendable {
    let accountID: String, sessionEpoch: Int, publicationGeneration: Int, expiresAt: Date
    func ownsSession(_ current: NativeSessionSummary?, now: Date = Date()) -> Bool {
        expiresAt > now && current?.authenticated == true &&
            current?.accountID == accountID && current?.epoch == sessionEpoch && (current?.expiresAt ?? .distantPast) > now
    }
    func permits(_ current: NativeSessionSummary?, generation: Int, foreground: Bool, now: Date = Date()) -> Bool {
        foreground && generation == publicationGeneration && ownsSession(current, now: now)
    }
}
