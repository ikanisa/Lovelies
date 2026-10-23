import Foundation
import CryptoKit

// Tests the policy used by the real AVFoundation adapter and local review path.
// It does not execute AVFoundation, an iOS camera, permission prompts or Settings.
@main struct NativeCameraRecoveryTests {
    private static var checks = 0
    private static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw NativeAPIError.unsupported("Camera recovery check failed: " + message) }; checks += 1
    }
    private static func rejects(_ message: String, _ work: () throws -> Void) throws {
        var rejected = false; do { try work() } catch { rejected = true }
        try require(rejected, message)
    }
    private static func challenge(_ edits: [String: WireValue] = [:], expired: Bool = false) throws -> NativeFaceChallenge {
        let dates = ISO8601DateFormatter(); dates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var value: [String: WireValue] = ["protocol": .string("lovelies-face-auth-v1"), "purpose": .string("registration"),
            "challenge_id": .string("00000000-0000-4000-8000-000000000004"), "account_id": .string("00000000-0000-4000-8000-000000000001"),
            "device_id": .string("00000000-0000-4000-8000-000000000002"), "device_revision": .string("00000000-0000-4000-8000-000000000003"),
            "profile_id": .null, "profile_revision": .null, "model_id": .null, "policy_version": .string("current-face-policy"),
            "maximum_capture_bytes": .integer(8 * 1024 * 1024), "required_captures": .integer(3), "poses": .strings(["front", "left", "right"]),
            "face_handle": .string("lfh_" + Data(repeating: 3, count: 32).base64URL), "nonce": .string("lfn_" + Data(repeating: 2, count: 32).base64URL),
            "expires_at": .string(dates.string(from: Date().addingTimeInterval(expired ? -1 : 100))),
            "lifecycle_operation_key": .string("00000000-0000-4000-8000-000000000009"), "lifecycle_generation": .integer(1)]
        for (key, edit) in edits { value[key] = edit }
        return try NativeFaceChallenge(.object(value), purpose: "registration", allowExpired: expired)
    }
    private static func cameraReady() throws -> NativeCameraAuthority {
        let camera = NativeCameraAuthority(), start = camera.start(permission: .authorized, foreground: true)!
        try require(camera.didStart(start, running: true), "Current allowed initialization becomes ready")
        return camera
    }
    private static func run() throws {
        for permission in [NativeCameraPermission.denied, .restricted] {
            let camera = NativeCameraAuthority()
            try require(camera.start(permission: permission, foreground: true) == nil, "Denied/restricted permission does not start a session")
            try require(!camera.snapshot.ready && camera.beginPhoto(1) == nil, "Denied/restricted camera cannot capture")
            try require(camera.snapshot.canOpenSettings == (permission == .denied), "Only app-configurable denial suggests Settings")
        }
        do {
            let camera = NativeCameraAuthority(), pending = camera.start(permission: .notDetermined, foreground: true)!
            try require(camera.snapshot.phase == .permissionPending && !camera.snapshot.ready, "Permission request is distinct from ready")
            try require(camera.resolvePermission(pending, permission: .authorized) && camera.snapshot.phase == .initializing, "Permission grant still requires initialization")
            try require(!camera.snapshot.ready && camera.beginPhoto(2) == nil, "Permission grant alone cannot capture")
            try require(camera.didStart(pending, running: true) && camera.snapshot.ready, "Only actual running callback enables shutter")
            try require(!camera.fail(pending, issue: .initializingTimeout, onlyIfPhase: .initializing) && camera.snapshot.ready, "A delayed startup timer cannot retire same-generation readiness")
            try require(!camera.fail(pending, issue: .initializingTimeout, onlyIfPhase: .permissionPending) && camera.snapshot.ready, "A delayed permission timer cannot retire an already allowed running session")
        }
        do {
            let camera = NativeCameraAuthority(), pending = camera.start(permission: .notDetermined, foreground: true)!
            try require(!camera.resolvePermission(pending, permission: .denied), "Denied permission request remains denied")
            try require(camera.snapshot.phase == .denied && camera.snapshot.issue == .permissionDenied, "Denial publishes useful recovery state")
            let returned = camera.start(permission: .authorized, foreground: true)!
            try require(camera.didStart(returned, running: true) && camera.snapshot.ready, "Settings return rechecks actual permission and initializes")
        }
        do {
            let camera = NativeCameraAuthority(), old = camera.start(permission: .notDetermined, foreground: true)!
            camera.suspend(foreground: false)
            try require(!camera.resolvePermission(old, permission: .authorized) && !camera.snapshot.ready, "Late permission callback while background cannot restart camera")
            let current = camera.start(permission: .authorized, foreground: true)!
            try require(!camera.didStart(old, running: true), "Late pre-background start cannot publish readiness")
            try require(camera.didStart(current, running: true), "Current foreground start recovers")
        }
        for issue in [NativeCameraIssue.interrupted, .mediaServicesReset, .permissionChanged, .initializingTimeout] {
            let camera = NativeCameraAuthority(), old = camera.start(permission: .authorized, foreground: true)!
            try require(camera.fail(old, issue: issue), "Initialization/runtime issue is current and applied")
            try require(!camera.didStart(old, running: true) && camera.beginPhoto(10) == nil, "Late startup after failure cannot enable capture")
            let current = camera.start(permission: .authorized, foreground: true)!
            try require(camera.didStart(current, running: true), "Explicit allowed restart recovers failed generation")
            try require(!camera.fail(old, issue: .cameraUnavailable) && camera.snapshot.ready, "Old failure cannot stop recovered camera")
        }
        for issue in [NativeCameraIssue.captureTimeout, .interrupted, .mediaServicesReset, .permissionChanged] {
            let camera = try cameraReady(), old = camera.beginPhoto(101)!
            try require(camera.beginPhoto(102) == nil && camera.snapshot.phase == .capturing, "One in-flight unique capture only")
            try require(camera.fail(old, issue: issue) && !camera.finishPhoto(old), "Timed-out/interrupted capture callback is retired")
            let start = camera.start(permission: .authorized, foreground: true)!
            try require(camera.didStart(start, running: true), "Capture failure recovers by new initialization")
            let current = camera.beginPhoto(102)!
            try require(!camera.finishPhoto(old) && camera.snapshot.photoID == 102, "Late old photo does not complete the new continuation")
            try require(!camera.finishPhoto(current) && camera.snapshot.phase == .capturing, "Final callback without a processed current JPEG cannot return success")
            try require(!camera.didProcessPhoto(old) && camera.didProcessPhoto(current) && !camera.snapshot.ready, "Processed current JPEG is staged without completing the shutter")
            try require(camera.finishPhoto(current) && camera.snapshot.ready, "Only matching current uniqueID completes")
            try require(!camera.finishPhoto(current), "Duplicate callback cannot complete twice")
        }
        do {
            let camera = try cameraReady(), capture = camera.beginPhoto(401)!
            try require(camera.didProcessPhoto(capture) && camera.snapshot.photoProcessed && !camera.snapshot.ready, "Processing alone never returns a ready capture")
            try require(camera.fail(capture, issue: .captureUnavailable) && !camera.finishPhoto(capture), "Final capture error discards previously processed JPEG instead of returning early success")
            try require(!camera.snapshot.photoProcessed && camera.snapshot.photoID == nil, "Final failure retires staged processing authority")
        }
        do {
            let camera = try cameraReady(), capture = camera.beginPhoto(1)!
            camera.suspend(foreground: false)
            try require(!camera.finishPhoto(capture) && !camera.snapshot.ready, "Background stops current capture before its late callback")
            try require(camera.start(permission: .authorized, foreground: false) == nil, "Inactive initialization cannot run")
            camera.suspend(foreground: true, stop: true)
            try require(!camera.snapshot.wanted && !camera.snapshot.ready, "Route back cancels camera demand")
        }
        do {
            let camera = try cameraReady(), challenge = try challenge(), jpeg = Data([0xff, 0xd8, 0xff, 7])
            var candidate = try NativeSelfieCandidate(bytes: jpeg, challenge: challenge, index: 0, publicationGeneration: 4, sessionEpoch: 7, cameraGeneration: camera.snapshot.generation)
            try candidate.requireCurrent(challenge: challenge, receipts: [], publicationGeneration: 4, sessionEpoch: 7, camera: camera.snapshot, foreground: true)
            try require(candidate.bytes == jpeg, "Local review retains unsent photo for explicit use")
            try rejects("Background cannot dispatch reviewed bytes") { try candidate.requireCurrent(challenge: challenge, receipts: [], publicationGeneration: 4, sessionEpoch: 7, camera: camera.snapshot, foreground: false) }
            try rejects("Account/session epoch change cannot dispatch reviewed bytes") { try candidate.requireCurrent(challenge: challenge, receipts: [], publicationGeneration: 4, sessionEpoch: 8, camera: camera.snapshot, foreground: true) }
            try rejects("Retake publication revision fences old review") { try candidate.requireCurrent(challenge: challenge, receipts: [], publicationGeneration: 5, sessionEpoch: 7, camera: camera.snapshot, foreground: true) }
            try rejects("Accepted slot cannot be overwritten by review") { try candidate.requireCurrent(challenge: challenge, receipts: [.object(["index": .integer(0)])], publicationGeneration: 4, sessionEpoch: 7, camera: camera.snapshot, foreground: true) }
            try rejects("Missing challenge has no upload authority") { try candidate.requireCurrent(challenge: nil, receipts: [], publicationGeneration: 4, sessionEpoch: 7, camera: camera.snapshot, foreground: true) }
            try rejects("Actual expiry fences local review") { try candidate.requireCurrent(challenge: challenge, receipts: [], publicationGeneration: 4, sessionEpoch: 7, camera: camera.snapshot, foreground: true, now: challenge.expiresAt.addingTimeInterval(1)) }
            for (field, value) in [("challenge_id", WireValue.string(UUID().uuidString)), ("account_id", .string(UUID().uuidString)), ("device_id", .string(UUID().uuidString)), ("device_revision", .string(UUID().uuidString)), ("policy_version", .string("later-policy")), ("nonce", .string("lfn_" + Data(repeating: 8, count: 32).base64URL)), ("lifecycle_operation_key", .string(UUID().uuidString)), ("lifecycle_generation", .integer(2))] {
                let changed = try self.challenge([field: value])
                try rejects("Exact changed challenge field fences review: " + field) { try candidate.requireCurrent(challenge: changed, receipts: [], publicationGeneration: 4, sessionEpoch: 7, camera: camera.snapshot, foreground: true) }
            }
            let anotherCapture = camera.beginPhoto(999)!
            try rejects("A second in-flight shutter cannot approve earlier local review") { try candidate.requireCurrent(challenge: challenge, receipts: [], publicationGeneration: 4, sessionEpoch: 7, camera: camera.snapshot, foreground: true) }
            _ = camera.didProcessPhoto(anotherCapture); _ = camera.finishPhoto(anotherCapture)
            camera.suspend(foreground: true, issue: .interrupted)
            try rejects("Camera interruption retires review before upload") { try candidate.requireCurrent(challenge: challenge, receipts: [], publicationGeneration: 4, sessionEpoch: 7, camera: camera.snapshot, foreground: true) }
            candidate.retire(); try require(candidate.bytes.isEmpty, "Retake retires transient unsent bytes")
            try rejects("A retired review cannot be approved later") { try candidate.requireCurrent(challenge: challenge, receipts: [], publicationGeneration: 4, sessionEpoch: 7, camera: camera.snapshot, foreground: true) }
        }
        do {
            let camera = try cameraReady(), challenge = try challenge(), jpeg = Data([0xff, 0xd8, 0xff, 7])
            let candidate = try NativeSelfieCandidate(bytes: jpeg, challenge: challenge, index: 1, publicationGeneration: 1, sessionEpoch: nil, cameraGeneration: camera.snapshot.generation)
            let hash = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
            try rejects("A previous signed hash cannot be reused as a new pose") { try candidate.requireCurrent(challenge: challenge, receipts: [.object(["sha256": .string(hash), "byte_size": .integer(4)])], publicationGeneration: 1, sessionEpoch: nil, camera: camera.snapshot, foreground: true) }
            try rejects("Aggregate signed capture budget is retained") { try candidate.requireCurrent(challenge: challenge, receipts: [.object(["sha256": .string(String(repeating: "0", count: 64)), "byte_size": .integer(8 * 1024 * 1024)])], publicationGeneration: 1, sessionEpoch: nil, camera: camera.snapshot, foreground: true) }
            try rejects("Empty local photo is unavailable") { _ = try NativeSelfieCandidate(bytes: Data(), challenge: challenge, index: 0, publicationGeneration: 1, sessionEpoch: nil, cameraGeneration: 1) }
            try rejects("Non-JPEG local photo cannot bypass decode/upload path") { _ = try NativeSelfieCandidate(bytes: Data([1, 2, 3]), challenge: challenge, index: 0, publicationGeneration: 1, sessionEpoch: nil, cameraGeneration: 1) }
            try rejects("Oversized local photo cannot enter review") { _ = try NativeSelfieCandidate(bytes: Data(repeating: 1, count: 8 * 1024 * 1024 + 1), challenge: challenge, index: 0, publicationGeneration: 1, sessionEpoch: nil, cameraGeneration: 1) }
        }
        do {
            let now = Date(), expiry = now.addingTimeInterval(120)
            let original = NativeSessionSummary(accountID: "picker-owner", roles: ["user"], authenticated: true, expiresAt: expiry, epoch: 9)
            let request = NativeMediaCaptureContext(accountID: original.accountID, sessionEpoch: original.epoch, publicationGeneration: 4, expiresAt: original.expiresAt)
            try require(request.permits(original, generation: 4, foreground: true, now: now), "A picker completion retains its opening account/session/generation")
            let laterAccount = NativeSessionSummary(accountID: "later-owner", roles: ["user"], authenticated: true, expiresAt: expiry, epoch: 9)
            try require(!request.permits(laterAccount, generation: 4, foreground: true, now: now) && !request.ownsSession(laterAccount, now: now), "Delayed Photos decoding or Files reads cannot move imports into a later account")
            let laterSession = NativeSessionSummary(accountID: original.accountID, roles: ["user"], authenticated: true, expiresAt: expiry, epoch: 10)
            try require(!request.permits(laterSession, generation: 4, foreground: true, now: now) && !request.ownsSession(laterSession, now: now), "Same-account session replacement retires a picker opened under an older epoch")
            try require(!request.permits(original, generation: 5, foreground: true, now: now), "A newer picker or publication generation retires an old asynchronous import")
            try require(!request.permits(original, generation: 4, foreground: false, now: now), "Background imports cannot publish")
            try require(!request.permits(nil, generation: 4, foreground: true, now: now), "Logout retires picker authority before staging")
            let renewed = NativeSessionSummary(accountID: original.accountID, roles: ["user"], authenticated: true, expiresAt: expiry.addingTimeInterval(300), epoch: 9)
            try require(!request.ownsSession(renewed, now: expiry.addingTimeInterval(1)), "Extending current session expiry cannot renew an expired picker request")
        }
        for quality in NativeFaceQualityFailure.allCases {
            try require(NativeFaceQualityFailure.from(NativeAPIError.denied(422, quality.rawValue)) == quality, "Only exact backend terminal quality codes select retake")
            try require(NativeFaceQualityFailure.from(NativeAPIError.denied(401, quality.rawValue)) == nil, "Wrong status cannot masquerade as quality rejection")
            try require(!quality.message.isEmpty && !quality.message.contains("verified"), "Quality message does not claim authentication")
        }
        for code in ["face_verification_failed", "face_handle_unavailable", "device_proof_invalid", "capture_unavailable", "capture_too_large", "capture_format_invalid"] {
            try require(NativeFaceQualityFailure.from(NativeAPIError.denied(422, code)) == nil, "Identity, preflight and ambiguous capture failures remain outside terminal quality retake")
        }
        try require(NativeFaceTerminalFailure.code(NativeAPIError.denied(401, "face_verification_failed")) == "face_verification_failed", "Exact registered-reference mismatch is a known terminal retry result")
        for code in ["face_handle_unavailable", "registered_face_session_invalid", "device_proof_invalid", "face_authentication_unavailable"] {
            try require(NativeFaceTerminalFailure.code(NativeAPIError.denied(401, code)) == nil, "Other consent/device/reference/availability denials cannot masquerade as terminal mismatch")
        }
    }
    static func main() {
        do { try run(); print("Native camera recovery checks passed: \(checks)") }
        catch { print(error.localizedDescription); exit(1) }
    }
}
