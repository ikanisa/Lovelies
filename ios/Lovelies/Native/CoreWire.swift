import Foundation
import CryptoKit

enum WireValue: Codable, Equatable, Sendable {
    case object([String: WireValue]), array([WireValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([String: WireValue].self) { self = .object(value) }
        else { self = .array(try container.decode([WireValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
    var string: String? { if case .string(let value) = self { return value }; return nil }
    var bool: Bool? { if case .bool(let value) = self { return value }; return nil }
    var object: [String: WireValue]? { if case .object(let value) = self { return value }; return nil }
    var array: [WireValue]? { if case .array(let value) = self { return value }; return nil }
    var integer: Int? { if case .number(let value) = self, value.isFinite, value.rounded() == value, value >= 0, value <= Double(Int.max) { return Int(value) }; return nil }
    subscript(_ key: String) -> WireValue { object?[key] ?? .null }
    static func integer(_ value: Int) -> WireValue { .number(Double(value)) }
    static func strings(_ values: [String]) -> WireValue { .array(values.map(WireValue.string)) }
    func encoded() throws -> Data { let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]; return try encoder.encode(self) }
    static func decoded(_ data: Data) throws -> WireValue { try JSONDecoder().decode(WireValue.self, from: data) }
    func canonical() throws -> Data { try encoded() }
    func text(_ key: String, maximum: Int = 8192) throws -> String {
        guard let value = self[key].string, !value.isEmpty, value.count <= maximum else { throw NativeAPIError.invalidResponse }
        return value
    }
    func uuid(_ key: String) throws -> String {
        let value = try text(key, maximum: 36)
        guard UUID(uuidString: value) != nil else { throw NativeAPIError.invalidResponse }; return value.lowercased()
    }
    func requireExpiry(_ key: String) throws {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let value = formatter.date(from: try text(key)), value > Date() else { throw NativeAPIError.reviewChanged }
    }
}

enum NativeAPIError: Error, LocalizedError, Equatable {
    case unavailable(String), denied(Int, String), invalidResponse, sessionChanged, authenticationRequired
    case selectionEmpty, reviewChanged, operationUnconfirmed(String), unsupported(String)
    var errorDescription: String? {
        switch self {
        case .unavailable(let code): return String.localizedStringWithFormat(NSLocalizedString("Connection unavailable (%@). Try again.", comment: ""), code)
        case .denied(_, let code):
            if code == "database_schema_not_ready" { return String(localized: "Lovelies is temporarily unavailable. Please try again later.") }
            if code == "age_not_supported" { return String(localized: "Lovelies is for ages 13 and over. You can still manage privacy and account deletion.") }
            if code == "audience_required" { return String(localized: "Confirm your age range before face setup or photos.") }
            if code == "guardian_approval_required" { return String(localized: "Current guardian approval and independent review are required before face setup or photos.") }
            if ["audience_version_changed", "guardian_revision_changed", "audience_policy_changed"].contains(code) { return String(localized: "Your age or guardian approval changed. Refresh its current status before continuing.") }
            if code == "audience_age_review_required" { return String(localized: "A minor account cannot change itself to an older age range. Contact support for independent review.") }
            if code == "guardian_adult_required" { return String(localized: "Use your own registered, eligible adult account to request guardian review.") }
            if code == "guardian_request_active" { return String(localized: "This account already has an active guardian request. Refresh its status.") }
            if code == "guardian_request_unavailable" { return String(localized: "This guardian request is unavailable to your account. Check the reference and current status.") }
            if code == "face_verification_failed" { return String(localized: "This selfie did not match your registered face. Take a fresh selfie to try again.") }
            if code == "face_capture_no_face" { return String(localized: "No face was found. Center your face in the frame and retake the selfies.") }
            if code == "face_capture_multiple_faces" { return String(localized: "More than one face was found. Make sure only your face is in the frame and retake the selfies.") }
            if code == "face_capture_quality_low" { return String(localized: "The selfies were not clear enough. Hold the phone steady, use even lighting, and retake them.") }
            if code == "face_capture_invalid_image" || code == "capture_format_invalid" { return String(localized: "A selfie could not be read. Check the saved capture status before retaking it.") }
            if code == "capture_too_large" { return String(localized: "This selfie is too large. Check the saved capture status before retaking it.") }
            if ["capture_unavailable", "capture_changed"].contains(code) { return String(localized: "The saved selfie is unavailable or changed. Check the original capture status before retaking it.") }
            if code.contains("verifier") || code.contains("face_authentication_unavailable") || code.contains("verdict") { return String(localized: "Face verification is unavailable. Your account has not been verified. Try again when the service is available.") }
            if code.contains("processor") { return String(localized: "Photo processing is unavailable. Your photos have not been matched or shared.") }
            return String.localizedStringWithFormat(NSLocalizedString("The service could not allow this action (%@).", comment: ""), code)
        case .invalidResponse: return String(localized: "The service returned an unverified result. Nothing has been confirmed.")
        case .sessionChanged: return String(localized: "Your account changed. Reopen this screen.")
        case .authenticationRequired: return String(localized: "Verify your face to continue.")
        case .selectionEmpty: return String(localized: "Select at least one matched photo and person.")
        case .reviewChanged: return String(localized: "The eligible matches changed. Review the current selection again.")
        case .operationUnconfirmed: return String(localized: "The result is not confirmed. Check the original request before trying again.")
        case .unsupported(let message): return message
        }
    }
}

struct NativeCredentials: Codable, Sendable {
    let access_token: String, refresh_token: String, account_id: String, auth_method: String
    let expires_in: Int, roles: [String]
    let expiresAt: Date
    init(_ wire: WireValue, now: Date = Date(), deliveryRotationKey: String? = nil) throws {
        access_token = try wire.text("access_token"); refresh_token = try wire.text("refresh_token", maximum: 512)
        account_id = try wire.uuid("account_id"); auth_method = try wire.text("auth_method", maximum: 32)
        guard ["anonymous", "registered_face"].contains(auth_method), let seconds = wire["expires_in"].integer, (1...900).contains(seconds),
              let roleValues = wire["roles"].array else { throw NativeAPIError.invalidResponse }
        expires_in = seconds; roles = try roleValues.map { guard let value = $0.string, ["user", "admin"].contains(value) else { throw NativeAPIError.invalidResponse }; return value }
        guard !roles.isEmpty, Set(roles).count == roles.count, auth_method != "anonymous" || roles == ["user"] else { throw NativeAPIError.invalidResponse }
        let parts = access_token.split(separator: ".")
        guard parts.count == 3, let data = Data(base64URL: String(parts[1])), let claims = try? WireValue.decoded(data),
              claims["sub"].string == account_id, claims["auth_method"].string == auth_method,
              let expiration = claims["exp"].integer else { throw NativeAPIError.invalidResponse }
        if let deliveryRotationKey {
            guard wire["protocol"].string == NativeRefreshDeliveryRecord.protocolName, wire["rotation_key"].string == deliveryRotationKey else { throw NativeAPIError.invalidResponse }
            let accessExpiry = try NativeRefreshDeliveryRecord.date(wire["access_expires_at"])
            let refreshExpiry = try NativeRefreshDeliveryRecord.date(wire["refresh_expires_at"])
            let deliveryExpiry = try NativeRefreshDeliveryRecord.date(wire["delivery_expires_at"])
            guard abs(accessExpiry.timeIntervalSince1970 - Double(expiration)) < 1.001,
                  accessExpiry <= now.addingTimeInterval(1020), refreshExpiry > accessExpiry, deliveryExpiry <= refreshExpiry else { throw NativeAPIError.invalidResponse }
            // A replay returns the original TTL. Never extend its access clock;
            // an expired delivered successor is saved before rotating it again.
            expiresAt = min(accessExpiry, Date(timeIntervalSince1970: Double(expiration)))
        } else {
            expiresAt = min(now.addingTimeInterval(Double(seconds)), Date(timeIntervalSince1970: Double(expiration)))
            guard expiresAt > now else { throw NativeAPIError.invalidResponse }
        }
    }
    private enum CodingKeys: String, CodingKey { case access_token, refresh_token, account_id, auth_method, expires_in, roles, expiresAt }
    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        access_token = try values.decode(String.self, forKey: .access_token); refresh_token = try values.decode(String.self, forKey: .refresh_token)
        account_id = try values.decode(String.self, forKey: .account_id); auth_method = try values.decode(String.self, forKey: .auth_method)
        expires_in = try values.decode(Int.self, forKey: .expires_in); roles = try values.decode([String].self, forKey: .roles)
        expiresAt = try values.decode(Date.self, forKey: .expiresAt)
        if auth_method == "anonymous" { try validateAnonymousRecovery(accountID: account_id) }
        else { try validateRegisteredRecovery(accountID: account_id) }
    }
    var authenticated: Bool { auth_method == "registered_face" }
    /// Stored credentials may be expired, but recovery may retain only the
    /// original anonymous account. The server still validates/refreshes them.
    func validateAnonymousRecovery(accountID: String) throws {
        guard account_id == accountID, auth_method == "anonymous", roles == ["user"],
              access_token.count <= 8192, !refresh_token.isEmpty, refresh_token.count <= 512,
              (1...900).contains(expires_in) else { throw NativeAPIError.invalidResponse }
        let parts = access_token.split(separator: ".")
        guard parts.count == 3, let bytes = Data(base64URL: String(parts[1])), let claims = try? WireValue.decoded(bytes),
              claims["sub"].string == accountID, claims["auth_method"].string == "anonymous", let expiration = claims["exp"].integer,
              expiresAt <= Date(timeIntervalSince1970: Double(expiration)).addingTimeInterval(120) else { throw NativeAPIError.invalidResponse }
    }
    func validateRegisteredRecovery(accountID: String) throws {
        guard account_id == accountID, authenticated, !roles.isEmpty, roles.count <= 2, Set(roles).count == roles.count,
              roles.allSatisfy({ ["user", "admin"].contains($0) }), access_token.count <= 8192,
              !refresh_token.isEmpty, refresh_token.count <= 512, (1...900).contains(expires_in) else { throw NativeAPIError.invalidResponse }
        let parts = access_token.split(separator: ".")
        guard parts.count == 3, let bytes = Data(base64URL: String(parts[1])), let claims = try? WireValue.decoded(bytes),
              claims["sub"].string == accountID, claims["auth_method"].string == "registered_face", let expiration = claims["exp"].integer,
              expiresAt <= Date(timeIntervalSince1970: Double(expiration)).addingTimeInterval(120) else { throw NativeAPIError.invalidResponse }
    }
}
/// All secrets remain in device-only protected storage. This record never
/// becomes a UI summary, diagnostic field or logged request body.
struct NativeRefreshDeliveryRecord: Codable, Sendable {
    static let protocolName = "lovelies-refresh-delivery-v1"
    let protocolName: String, apiOrigin: String, rotationKey: String, deliverySecret: String
    let original: NativeCredentials, ownerBinding: String, deviceBinding: String, preparedAt: Date
    var suspended = false
    var cancellationConfirmed = false
    var response: WireValue? = nil
    init(origin: URL, original: NativeCredentials, owner: String, device: String, secret: String, rotationKey: String = UUID().uuidString.lowercased()) {
        protocolName = Self.protocolName; apiOrigin = origin.absoluteString; self.original = original
        ownerBinding = owner; deviceBinding = device; deliverySecret = secret; self.rotationKey = rotationKey; preparedAt = Date()
    }
    var payload: WireValue { .object(["protocol": .string(Self.protocolName), "rotation_key": .string(rotationKey), "delivery_secret": .string(deliverySecret), "refresh_token": .string(original.refresh_token)]) }
    func validate(origin: URL) throws {
        guard protocolName == Self.protocolName, apiOrigin == origin.absoluteString, UUID(uuidString: rotationKey) != nil,
              deliverySecret.count == 43, let secret = Data(base64URL: deliverySecret), secret.count == 32, secret.base64URL == deliverySecret,
              ownerBinding.count == 64, deviceBinding.count == 64, ownerBinding.allSatisfy(\.isHexDigit), deviceBinding.allSatisfy(\.isHexDigit),
              preparedAt <= Date().addingTimeInterval(120) else { throw NativeAPIError.invalidResponse }
        if original.authenticated { try original.validateRegisteredRecovery(accountID: original.account_id) } else { try original.validateAnonymousRecovery(accountID: original.account_id) }
        if let response { _ = try successor(response) }
    }
    func successor(_ value: WireValue) throws -> NativeCredentials {
        let next = try NativeCredentials(value, deliveryRotationKey: rotationKey)
        guard next.account_id == original.account_id, next.auth_method == original.auth_method,
              next.refresh_token != original.refresh_token,
              try Self.date(value["delivery_expires_at"]) <= Self.date(value["refresh_expires_at"]) else { throw NativeAPIError.sessionChanged }
        return next
    }
    static func date(_ value: WireValue) throws -> Date {
        guard let text = value.string, text.count <= 40 else { throw NativeAPIError.invalidResponse }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = formatter.date(from: text) { return parsed }
        formatter.formatOptions = [.withInternetDateTime]
        guard let parsed = formatter.date(from: text) else { throw NativeAPIError.invalidResponse }; return parsed
    }
}

struct NativeSessionSummary: Sendable {
    let accountID: String, roles: [String], authenticated: Bool, expiresAt: Date, epoch: Int
}

/// Current durable-session binding for own audience/privacy controls only.
/// A lifecycle-held registered identity is not a product-authenticated session.
struct NativeAudienceSessionBinding: Sendable, Equatable {
    let accountID: String, epoch: Int, registeredIdentity: Bool
}

/// UI publication ownership is independent of backend/session authority.
/// A completed old task cannot publish into a later logout/reconnect lifecycle.
struct NativePublicationFence: Sendable {
    let generation: Int
    func permits(currentGeneration: Int, cancelled: Bool) -> Bool { generation == currentGeneration && !cancelled }
}

enum NativeGuestDeletionPhase: String, Codable, Sendable {
    case pendingApproval = "pending_approval", approved, queued, processing, completed, rejected, failed, cancelled
}

/// A bound server lifecycle, never a client-side assertion that erasure finished.
struct NativeGuestDeletionStatus: Codable, Sendable, Equatable {
    let operationKey: String, requestID: String
    let phase: NativeGuestDeletionPhase
    let createdAt: Date, reviewedAt: Date?, completedAt: Date?
    let requestExpiresAt: Date, receiptExpiresAt: Date
    let requestExpired: Bool
    let failureCode: String?
    var completed: Bool { phase == .completed && completedAt != nil }

    init(_ value: WireValue, record: NativeGuestDeletionRecord, now: Date = Date()) throws {
        guard value["protocol"].string == "lovelies-account-deletion-v1", value["source"].string == "privacy",
              value["operation_key"].string == record.operationKey,
              value["privacy_request"]["request_type"].string == "delete",
              let phase = value["privacy_request"]["status"].string.flatMap(NativeGuestDeletionPhase.init(rawValue:)),
              let completed = value["deletion_completed"].bool, let requestExpired = value["request_expired"].bool else { throw NativeAPIError.invalidResponse }
        let request = value["privacy_request"]
        operationKey = record.operationKey; requestID = try request.uuid("id"); self.phase = phase
        if let previous = record.status, previous.requestID != requestID { throw NativeAPIError.invalidResponse }
        for field in ["subject_user_id", "requested_by"] {
            if request[field] != .null, request[field].string != record.accountID { throw NativeAPIError.sessionChanged }
        }
        createdAt = try Self.date(request["created_at"])
        reviewedAt = request["reviewed_at"] == .null ? nil : try Self.date(request["reviewed_at"])
        completedAt = request["completed_at"] == .null ? nil : try Self.date(request["completed_at"])
        requestExpiresAt = try Self.date(value["request_expires_at"])
        receiptExpiresAt = try Self.date(value["deletion_status"]["expires_at"])
        self.requestExpired = requestExpired
        failureCode = request["failure_code"].string
        guard request["failure_code"] == .null || failureCode != nil,
              completed == (phase == .completed), completed == (completedAt != nil),
              validDeletionTimes(now: now, requireUnexpiredFinalReceipt: true) else { throw NativeAPIError.invalidResponse }
        if let previous = record.status {
            // Only the first confirmed final outcome may establish its own
            // thirty-day window; polling cannot renew that window.
            let finalRebase = !previous.isTerminal && isTerminal && finalOutcomeAt.map {
                abs(receiptExpiresAt.timeIntervalSince($0.addingTimeInterval(30 * 86400))) < 0.01 && receiptExpiresAt >= previous.receiptExpiresAt
            } == true
            guard previous.createdAt == createdAt, previous.requestExpiresAt == requestExpiresAt,
                  previous.receiptExpiresAt == receiptExpiresAt || finalRebase,
                  !previous.completed || completed else { throw NativeAPIError.invalidResponse }
        }
    }
    var isTerminal: Bool { [.completed, .rejected, .cancelled].contains(phase) }
    private var finalOutcomeAt: Date? { phase == .completed ? completedAt : ([.rejected, .cancelled].contains(phase) ? reviewedAt : nil) }
    func validDeletionTimes(now: Date, requireUnexpiredFinalReceipt: Bool) -> Bool {
        createdAt <= now.addingTimeInterval(120) && requestExpiresAt > createdAt &&
        requestExpiresAt <= createdAt.addingTimeInterval(30 * 86400 + 120) &&
        receiptExpiresAt >= requestExpiresAt && receiptExpiresAt > createdAt &&
        receiptExpiresAt <= (finalOutcomeAt ?? createdAt).addingTimeInterval(30 * 86400 + 120) &&
        (!requireUnexpiredFinalReceipt || !isTerminal || receiptExpiresAt > now) &&
        (reviewedAt == nil || (reviewedAt! >= createdAt && reviewedAt! <= now.addingTimeInterval(120))) &&
        (completedAt == nil || (completedAt! >= createdAt && completedAt! <= now.addingTimeInterval(120))) &&
        ((completedAt != nil) == (phase == .completed)) &&
        (failureCode == nil || failureCode!.count <= 128) &&
        (!requestExpired || (!isTerminal && requestExpiresAt <= now.addingTimeInterval(120)))
    }
    private static func date(_ value: WireValue) throws -> Date {
        guard let text = value.string, text.count <= 40 else { throw NativeAPIError.invalidResponse }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: text) else { throw NativeAPIError.invalidResponse }; return date
    }
}

/// Private Keychain receipt: no token is surfaced through the presentation summary.
struct NativeGuestDeletionRecord: Codable, Sendable {
    let accountID: String, operationKey: String, statusToken: String, apiOrigin: String, reason: String?, preparedAt: Date
    var status: NativeGuestDeletionStatus?
    var originalCredentials: NativeCredentials?
    var statusUnavailable = false
    var payload: WireValue {
        var body: [String: WireValue] = ["operation_key": .string(operationKey), "status_token": .string(statusToken)]
        if let reason { body["reason"] = .string(reason) }; return .object(body)
    }
    func validate(origin: URL, now: Date = Date()) throws {
        guard apiOrigin == origin.absoluteString, UUID(uuidString: accountID) != nil, UUID(uuidString: operationKey) != nil,
              statusToken.count == 68, statusToken.hasPrefix("lvd_"), statusToken.dropFirst(4).allSatisfy({ "0123456789abcdef".contains($0) }),
              preparedAt <= now.addingTimeInterval(120),
              reason == nil || (reason!.count <= 1000 && !reason!.unicodeScalars.contains { $0.value < 32 && ![9, 10, 13].contains($0.value) }),
              status == nil || (status!.operationKey == operationKey && UUID(uuidString: status!.requestID) != nil &&
                status!.validDeletionTimes(now: now, requireUnexpiredFinalReceipt: false)),
              status?.completed != true || originalCredentials == nil else { throw NativeAPIError.invalidResponse }
        try originalCredentials?.validateAnonymousRecovery(accountID: accountID)
    }
}

struct NativeGuestDeletionSummary: Sendable, Equatable {
    let status: NativeGuestDeletionStatus?
    let statusUnavailable: Bool
    let canRetryOriginal: Bool
    let canResumeSetup: Bool
    var completed: Bool { status?.completed == true }
    var requestExpired: Bool { status?.requestExpired == true }
}

struct RegisteredDevice: Codable, Sendable {
    let accountID: String, faceHandle: String, deviceID: String
    var profileID: String?, profileRevision: String?, modelID: String?
    var keyAlias: String? = nil
}

struct NativeFaceChallenge: Sendable {
    let wire: WireValue, id: String, accountID: String, deviceID: String, purpose: String
    let faceHandle: String?, poses: [String], expiresAt: Date
    init(_ value: WireValue, accountID expectedAccount: String? = nil, purpose expectedPurpose: String, now: Date = Date(), allowExpired: Bool = false) throws {
        guard value["protocol"].string == "lovelies-face-auth-v1", value["purpose"].string == expectedPurpose,
              value["maximum_capture_bytes"].integer == 8 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        wire = value; id = try value.uuid("challenge_id"); accountID = try value.uuid("account_id"); deviceID = try value.uuid("device_id"); purpose = expectedPurpose
        if let expectedAccount, expectedAccount != accountID { throw NativeAPIError.sessionChanged }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expiry = formatter.date(from: try value.text("expires_at")), allowExpired || expiry > now, expiry <= now.addingTimeInterval(125) else { throw NativeAPIError.invalidResponse }; expiresAt = expiry
        poses = value["poses"].array?.compactMap(\.string) ?? []
        guard poses == (expectedPurpose == "replacement" || value["profile_id"] == .null ? ["front", "left", "right"] : ["front"]), value["required_captures"].integer == poses.count else { throw NativeAPIError.invalidResponse }
        _ = try value.uuid("device_revision")
        let nonce = try value.text("nonce", maximum: 47)
        guard nonce.hasPrefix("lfn_"), nonce.count == 47 else { throw NativeAPIError.invalidResponse }
        _ = try value.text("policy_version", maximum: 128)
        if value["profile_id"] != .null { _ = try value.uuid("profile_id"); _ = try value.text("profile_revision"); _ = try value.text("model_id") }
        faceHandle = value["face_handle"].string
        if expectedPurpose == "registration", faceHandle?.hasPrefix("lfh_") != true || faceHandle?.count != 47 { throw NativeAPIError.invalidResponse }
    }
    func deviceEnvelope() -> [String: WireValue] {
        var value = Dictionary(uniqueKeysWithValues: ["challenge_id", "nonce", "purpose", "account_id", "device_id", "device_revision", "profile_id", "profile_revision", "policy_version"].map { ($0, wire[$0]) })
        value["protocol"] = .string("lovelies-face-device-v1"); return value
    }
}

// Audience eligibility is separate from a registered-face session and subject consent.
enum NativeAudiencePurpose: String, CaseIterable, Codable, Sendable {
    case faceAuthentication = "face_authentication", photoMatching = "photo_matching", photoProcessing = "photo_processing"
}
enum NativeAgeBand: String, CaseIterable, Codable, Sendable {
    case unknown, under13, teen = "13_17", adult = "18_plus"
}
enum NativeAudienceStatus: String, Codable, Sendable {
    case unknown, blocked, guardianPending = "guardian_pending", eligible, suspended
}
struct NativeAudienceCapabilities: Equatable, Sendable {
    let faceAuthentication: Bool, photoMatching: Bool, photoProcessing: Bool
    init(_ wire: WireValue) throws {
        try NativeAudienceProjection.keys(wire, ["face_authentication", "photo_matching", "photo_processing"])
        guard let face = wire["face_authentication"].bool, let matching = wire["photo_matching"].bool,
              let processing = wire["photo_processing"].bool else { throw NativeAPIError.invalidResponse }
        faceAuthentication = face; photoMatching = matching; photoProcessing = processing
    }
    func allows(_ purpose: NativeAudiencePurpose) -> Bool {
        switch purpose { case .faceAuthentication: return faceAuthentication; case .photoMatching: return photoMatching; case .photoProcessing: return photoProcessing }
    }
    var any: Bool { faceAuthentication || photoMatching || photoProcessing }
}
struct NativeGuardianRequest: Equatable, Sendable {
    enum State: String, Sendable { case pending, underReview = "under_review", approved, rejected, withdrawn, expired }
    let id: String, childAccountID: String, state: State, revision: Int, policyVersion: String
    let createdAt: Date, expiresAt: Date, purposes: NativeAudienceCapabilities
    init(_ wire: WireValue, child expectedChild: String? = nil, id expectedID: String? = nil) throws {
        try NativeAudienceProjection.keys(wire, ["id", "child_account_id", "state", "revision", "policy_version", "created_at", "expires_at", "purposes"])
        id = try wire.uuid("id"); childAccountID = try wire.uuid("child_account_id")
        guard expectedID == nil || expectedID == id, expectedChild == nil || expectedChild == childAccountID,
              let state = wire["state"].string.flatMap(State.init(rawValue:)), let revision = wire["revision"].integer,
              revision > 0, wire["policy_version"].string == NativeAudienceProjection.policy else { throw NativeAPIError.invalidResponse }
        self.state = state; self.revision = revision; policyVersion = NativeAudienceProjection.policy
        createdAt = try NativeRefreshDeliveryRecord.date(wire["created_at"]); expiresAt = try NativeRefreshDeliveryRecord.date(wire["expires_at"])
        guard expiresAt > createdAt else { throw NativeAPIError.invalidResponse }
        purposes = try NativeAudienceCapabilities(wire["purposes"])
        guard state == .approved || !purposes.any else { throw NativeAPIError.invalidResponse }
    }
    var live: Bool { [.pending, .underReview, .approved].contains(state) && expiresAt > Date() }
}
struct NativeAudienceProjection: Equatable, Sendable {
    static let protocolName = "lovelies-audience-v1", policy = "audience-2026-10-24-v1"
    let accountID: String, ageBand: NativeAgeBand, status: NativeAudienceStatus, version: Int
    let policyVersion: String?, nextReviewAt: Date?, guardianRequest: NativeGuardianRequest?, capabilities: NativeAudienceCapabilities
    init(_ wire: WireValue, account expectedAccount: String) throws {
        try Self.keys(wire, ["protocol", "policy_version", "account_id", "audience", "guardian_request", "capabilities"])
        guard wire["protocol"].string == Self.protocolName, wire["policy_version"].string == Self.policy,
              try wire.uuid("account_id") == expectedAccount else { throw NativeAPIError.invalidResponse }
        accountID = expectedAccount
        let audience = wire["audience"]
        try Self.keys(audience, ["age_band", "status", "version", "policy_version", "next_review_at"])
        guard let band = audience["age_band"].string.flatMap(NativeAgeBand.init(rawValue:)),
              let status = audience["status"].string.flatMap(NativeAudienceStatus.init(rawValue:)),
              let version = audience["version"].integer else { throw NativeAPIError.invalidResponse }
        ageBand = band; self.status = status; self.version = version
        policyVersion = audience["policy_version"] == .null ? nil : try audience.text("policy_version", maximum: 128)
        nextReviewAt = audience["next_review_at"] == .null ? nil : try NativeRefreshDeliveryRecord.date(audience["next_review_at"])
        guardianRequest = wire["guardian_request"] == .null ? nil : try NativeGuardianRequest(wire["guardian_request"], child: expectedAccount)
        capabilities = try NativeAudienceCapabilities(wire["capabilities"])
        if band == .unknown {
            guard status == .unknown, version == 0, policyVersion == nil, nextReviewAt == nil, guardianRequest == nil, !capabilities.any else { throw NativeAPIError.invalidResponse }
        } else {
            guard version > 0, policyVersion == Self.policy else { throw NativeAPIError.invalidResponse }
            if band == .under13 { guard status == .blocked, !capabilities.any else { throw NativeAPIError.invalidResponse } }
            if band == .adult { guard status == .eligible || status == .suspended else { throw NativeAPIError.invalidResponse } }
            if status == .suspended || status == .blocked { guard !capabilities.any else { throw NativeAPIError.invalidResponse } }
            if band == .teen {
                guard status == .guardianPending || status == .eligible || status == .suspended else { throw NativeAPIError.invalidResponse }
                if status == .eligible || capabilities.any {
                    guard let request = guardianRequest, request.state == .approved, let nextReviewAt,
                          nextReviewAt <= request.expiresAt,
                          (!capabilities.faceAuthentication || request.purposes.faceAuthentication),
                          (!capabilities.photoMatching || request.purposes.photoMatching),
                          (!capabilities.photoProcessing || request.purposes.photoProcessing) else { throw NativeAPIError.invalidResponse }
                } else { guard !capabilities.any else { throw NativeAPIError.invalidResponse } }
            }
        }
    }
    static func keys(_ wire: WireValue, _ expected: Set<String>) throws {
        guard let object = wire.object, Set(object.keys) == expected else { throw NativeAPIError.invalidResponse }
    }
    func require(_ purpose: NativeAudiencePurpose, now: Date = Date()) throws {
        guard status == .eligible, policyVersion == Self.policy, capabilities.allows(purpose),
              ageBand == .adult || (ageBand == .teen && guardianRequest?.state == .approved && (guardianRequest?.expiresAt ?? .distantPast) > now && (nextReviewAt ?? .distantPast) > now)
        else { throw NativeAPIError.denied(403, ageBand == .under13 ? "age_not_supported" : ageBand == .teen ? "guardian_approval_required" : "audience_required") }
    }
}
/// Server-issued HTTPS presentation authority for one exact known-account
/// capture. This is not an age assertion, product session or photo-access grant.
struct NativeAudienceChallengeAuthority: Equatable, Sendable {
    let accountID: String, challengeID: String, deviceID: String, purpose: String
    let audienceVersion: Int, expiresAt: Date
    init(_ wire: WireValue, challenge: NativeFaceChallenge) throws {
        try NativeAudienceProjection.keys(wire, ["protocol", "account_id", "challenge_id", "device_id", "purpose", "policy_version", "audience_version", "expires_at"])
        guard wire["protocol"].string == "lovelies-audience-challenge-v1", wire["policy_version"].string == NativeAudienceProjection.policy,
              try wire.uuid("account_id") == challenge.accountID, try wire.uuid("challenge_id") == challenge.id,
              try wire.uuid("device_id") == challenge.deviceID, wire["purpose"].string == challenge.purpose,
              let version = wire["audience_version"].integer, version > 0 else { throw NativeAPIError.invalidResponse }
        accountID = challenge.accountID; challengeID = challenge.id; deviceID = challenge.deviceID; purpose = challenge.purpose; audienceVersion = version
        expiresAt = try NativeRefreshDeliveryRecord.date(wire["expires_at"])
        guard expiresAt <= challenge.expiresAt else { throw NativeAPIError.invalidResponse }
    }
    func requireCurrent(now: Date = Date()) throws {
        guard expiresAt > now else { throw NativeAPIError.denied(403, "audience_required") }
    }
}
/// Exact token-free mutation identity. The protected journal is written before dispatch.
/// It survives logout/transport failure; a later action cannot replace it silently.
struct NativeAudienceMutationRecord: Codable, Equatable, Sendable {
    let apiOrigin: String, accountID: String, path: String, method: String, operationKey: String, body: WireValue
    let preparedAt: Date
    init(origin: URL, accountID: String, path: String, method: String, body: WireValue, operationKey: String = UUID().uuidString.lowercased()) throws {
        apiOrigin = origin.absoluteString; self.accountID = accountID; self.path = path; self.method = method; self.operationKey = operationKey; preparedAt = Date()
        var fields = body.object ?? [:]; fields["operation_key"] = .string(operationKey); self.body = .object(fields)
        try validate(origin: origin)
    }
    func validate(origin: URL) throws {
        guard apiOrigin == origin.absoluteString, UUID(uuidString: accountID) != nil, (16...128).contains(operationKey.count),
              operationKey.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "._:-".contains($0)) }),
              body["operation_key"].string == operationKey, method == (path == "/me/audience" ? "PUT" : "POST"),
              try body.encoded().count <= 4096 else { throw NativeAPIError.invalidResponse }
        let fields = Set(body.object?.keys.map { $0 } ?? [])
        if path == "/me/audience" {
            guard fields == ["age_band", "policy_version", "expected_version", "operation_key"],
                  let band = body["age_band"].string.flatMap(NativeAgeBand.init(rawValue:)), band != .unknown,
                  body["policy_version"].string == NativeAudienceProjection.policy, body["expected_version"].integer != nil else { throw NativeAPIError.invalidResponse }
        } else if path == "/me/guardian-requests" {
            guard fields == ["expected_version", "policy_version", "operation_key"], body["expected_version"].integer != nil,
                  body["policy_version"].string == NativeAudienceProjection.policy else { throw NativeAPIError.invalidResponse }
        } else {
            let parts = path.split(separator: "/")
            guard parts.count == 3, parts[0] == "guardian-requests", UUID(uuidString: String(parts[1])) != nil else { throw NativeAPIError.invalidResponse }
            if parts[2] == "withdraw" {
                guard fields == ["expected_revision", "operation_key"], let revision = body["expected_revision"].integer, revision > 0 else { throw NativeAPIError.invalidResponse }
            } else if parts[2] == "claim" {
                guard fields == ["expected_revision", "policy_version", "relationship_attested", "purposes", "operation_key"],
                      let revision = body["expected_revision"].integer, revision > 0, body["policy_version"].string == NativeAudienceProjection.policy,
                      body["relationship_attested"].bool == true, let purposes = body["purposes"].array, !purposes.isEmpty,
                      purposes.count <= 3, Set(purposes.compactMap(\.string)).count == purposes.count,
                      purposes.allSatisfy({ $0.string.flatMap(NativeAudiencePurpose.init(rawValue:)) != nil }) else { throw NativeAPIError.invalidResponse }
            } else { throw NativeAPIError.invalidResponse }
        }
    }
}

/// Device-only authority held solely to reconcile an uncertain anonymous age
/// operation after logout. It never grants product or capture access.
struct NativeAudienceSuspensionRecord: Codable, Sendable {
    let protocolName: String, apiOrigin: String, operation: NativeAudienceMutationRecord
    var credentials: NativeCredentials
    var resolved: Bool
    init(origin: URL, operation: NativeAudienceMutationRecord, credentials: NativeCredentials) throws {
        protocolName = "lovelies-audience-suspension-v1"; apiOrigin = origin.absoluteString
        self.operation = operation; self.credentials = credentials; resolved = false
        try validate(origin: origin)
    }
    func validate(origin: URL) throws {
        guard protocolName == "lovelies-audience-suspension-v1", apiOrigin == origin.absoluteString,
              operation.accountID == credentials.account_id else { throw NativeAPIError.invalidResponse }
        try operation.validate(origin: origin); try credentials.validateAnonymousRecovery(accountID: operation.accountID)
    }
}

enum NativeEnrollmentState: String, Codable, Sendable {
    case starting, pending, capturePending = "capture_pending", completionPending = "completion_pending"
    case verifying, registered, restartRequired = "restart_required", promoting
}
struct NativeEnrollmentCapture: Codable, Sendable, Equatable {
    let index: Int, sha256: String, mime: String, byte_size: Int
    var accepted = false
    var wire: WireValue { .object(["index": .integer(index), "sha256": .string(sha256), "mime": .string(mime), "byte_size": .integer(byte_size)]) }
    init(index: Int, sha256: String, mime: String = "image/jpeg", byteSize: Int, accepted: Bool = false) {
        self.index = index; self.sha256 = sha256; self.mime = mime; byte_size = byteSize; self.accepted = accepted
    }
    init(_ wire: WireValue, accepted: Bool = true) throws {
        guard let index = wire["index"].integer, let size = wire["byte_size"].integer else { throw NativeAPIError.invalidResponse }
        self.init(index: index, sha256: try wire.text("sha256", maximum: 64), mime: try wire.text("mime", maximum: 32), byteSize: size, accepted: accepted)
        try validate()
    }
    func validate() throws {
        guard (0..<3).contains(index), sha256.count == 64, sha256.allSatisfy({ "0123456789abcdef".contains($0) }),
              mime == "image/jpeg", (1...8 * 1024 * 1024).contains(byte_size) else { throw NativeAPIError.invalidResponse }
    }
}
struct NativeEnrollmentProfile: Codable, Sendable, Equatable {
    let id: String, revision: String, modelID: String
    init(_ value: WireValue) throws { id = try value.uuid("id"); revision = try value.text("revision", maximum: 256); modelID = try value.text("model_id", maximum: 128) }
    init(id: String, revision: String, modelID: String) { self.id = id; self.revision = revision; self.modelID = modelID }
}
struct NativeEnrollmentResume: Codable, Sendable {
    let key: String, generation: Int, challengeID: String
}
/// Metadata and credential journal only. Raw selfie JPEGs are never persisted.
struct NativeEnrollmentRecord: Codable, Sendable {
    static let keyAlias = "com.lovelies.registered-face.p256.v1"
    var schema = 1
    let accountID: String, apiOrigin: String, enrollmentKey: String, keyAlias: String
    let publicJWK: WireValue, publicKeyDigest: String, faceHandle: String, policy: String, consent: Bool, createdAt: Date
    let startSignature: String
    var originalAnonymous: NativeCredentials?
    var state: NativeEnrollmentState = .starting
    var generation = 1
    var recoveryExpiresAt: Date?
    var deviceID: String?, deviceRevision: String?, challengeWire: WireValue?
    var predecessorID: String?
    var captures: [NativeEnrollmentCapture] = []
    var retiredCaptures: [NativeEnrollmentCapture] = []
    var resume: NativeEnrollmentResume?
    var profile: NativeEnrollmentProfile?
    var loginChallengeWire: WireValue?
    var loginCaptures: [NativeEnrollmentCapture] = []
    var loginTerminalCode: String?
    var promotionCredentials: NativeCredentials?, promotionDevice: RegisteredDevice?
    var startEnvelope: WireValue { .object(["protocol": .string("lovelies-face-enrollment-device-v1"), "step": .string("start"), "account_id": .string(accountID), "enrollment_key": .string(enrollmentKey), "face_handle": .string(faceHandle), "policy_version": .string(policy), "device_public_jwk": publicJWK]) }
    var startBody: WireValue { .object(["account_id": .string(accountID), "enrollment_key": .string(enrollmentKey), "face_handle": .string(faceHandle), "device_public_jwk": publicJWK,
        "consent": .object(["purpose": .string("face_authentication"), "policy_version": .string(policy), "granted": .bool(consent)]), "device_signature": .string(startSignature)]) }
    func publicKey() throws -> P256.Signing.PublicKey {
        guard publicJWK["kty"].string == "EC", publicJWK["crv"].string == "P-256", publicJWK["ext"].bool == true,
              publicJWK["key_ops"] == .strings(["verify"]), Set(publicJWK.object?.keys.map { $0 } ?? []) == ["kty", "crv", "x", "y", "ext", "key_ops"],
              let x = publicJWK["x"].string.flatMap(Data.init(base64URL:)), let y = publicJWK["y"].string.flatMap(Data.init(base64URL:)), x.count == 32, y.count == 32 else { throw NativeAPIError.invalidResponse }
        return try P256.Signing.PublicKey(x963Representation: Data([4]) + x + y)
    }
    func validate(origin: URL) throws {
        // Validate each bounded integer before aggregating corrupted storage.
        for capture in captures + retiredCaptures + loginCaptures { try capture.validate() }
        guard schema == 1, accountID == accountID.lowercased(), UUID(uuidString: accountID) != nil, apiOrigin == origin.absoluteString,
              UUID(uuidString: enrollmentKey) != nil, keyAlias == Self.keyAlias, faceHandle.hasPrefix("lfh_"), faceHandle.count == 47,
              let handle = Data(base64URL: String(faceHandle.dropFirst(4))), handle.count == 32, handle.base64URL == faceHandle.dropFirst(4),
              !policy.isEmpty, policy.count <= 128, consent, createdAt <= Date().addingTimeInterval(120), (1...1000).contains(generation),
              captures.count <= 3, retiredCaptures.count <= 3, loginCaptures.count <= 1, captures.reduce(0, { $0 + $1.byte_size }) <= 8 * 1024 * 1024,
              captures.enumerated().allSatisfy({ $0.offset == $0.element.index }), Set(captures.map(\.sha256)).count == captures.count,
              (deviceID == nil) == (deviceRevision == nil), (promotionCredentials == nil) == (promotionDevice == nil),
              publicKeyDigest == SHA256.hash(data: try publicJWK.canonical()).map({ String(format: "%02x", $0) }).joined(),
              let signature = Data(base64URL: startSignature), signature.count == 64 else { throw NativeAPIError.invalidResponse }
        guard loginTerminalCode == nil || NativeFaceTerminalFailure.known(loginTerminalCode) else { throw NativeAPIError.invalidResponse }
        let key = try publicKey()
        guard key.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: signature), for: try startEnvelope.canonical()) else { throw NativeAPIError.invalidResponse }
        try originalAnonymous?.validateAnonymousRecovery(accountID: accountID)
        if [.registered, .promoting].contains(state) { guard profile != nil, deviceID != nil else { throw NativeAPIError.invalidResponse } }
        if state == .promoting { guard promotionCredentials != nil else { throw NativeAPIError.invalidResponse } }
        if let deviceID { guard UUID(uuidString: deviceID) != nil, UUID(uuidString: deviceRevision!) != nil else { throw NativeAPIError.invalidResponse } }
        if let challengeWire {
            let challenge = try NativeFaceChallenge(challengeWire, accountID: accountID, purpose: "registration", allowExpired: true)
            guard challenge.faceHandle == faceHandle, challenge.deviceID == deviceID, challengeWire["device_revision"].string == deviceRevision,
                  challengeWire["enrollment_key"].string == enrollmentKey, challengeWire["enrollment_generation"].integer == generation,
                  challengeWire["public_key_digest"].string == publicKeyDigest, challengeWire["policy_version"].string == policy else { throw NativeAPIError.invalidResponse }
            guard challenge.id == predecessorID else { throw NativeAPIError.invalidResponse }
        }
        if let predecessorID { guard UUID(uuidString: predecessorID) != nil else { throw NativeAPIError.invalidResponse } }
        if let resume { guard UUID(uuidString: resume.key) != nil, resume.generation == generation, resume.challengeID == predecessorID else { throw NativeAPIError.invalidResponse } }
        if let profile { guard UUID(uuidString: profile.id) != nil, !profile.revision.isEmpty, !profile.modelID.isEmpty else { throw NativeAPIError.invalidResponse } }
        if let loginChallengeWire {
            let login = try NativeFaceChallenge(loginChallengeWire, accountID: accountID, purpose: "login", allowExpired: true)
            guard login.deviceID == deviceID, loginChallengeWire["device_revision"].string == deviceRevision, loginChallengeWire["policy_version"].string == policy,
                  loginChallengeWire["profile_id"].string == profile?.id, loginChallengeWire["profile_revision"].string == profile?.revision, loginChallengeWire["model_id"].string == profile?.modelID else { throw NativeAPIError.invalidResponse }
        }
        if let credential = promotionCredentials, let device = promotionDevice {
            try credential.validateRegisteredRecovery(accountID: accountID)
            guard credential.account_id == accountID, credential.authenticated, device.accountID == accountID, device.deviceID == deviceID,
                  device.faceHandle == faceHandle, device.profileID == profile?.id, device.profileRevision == profile?.revision, device.modelID == profile?.modelID else { throw NativeAPIError.invalidResponse }
        }
    }
}
struct NativeEnrollmentSummary: Sendable {
    let state: NativeEnrollmentState, policy: String
    let challenge: NativeFaceChallenge?
    let receipts: [WireValue]
    let requiresCheck: Bool
    var awaitingServer: Bool { state == .capturePending || state == .verifying || state == .completionPending }
}

/// Display labels only. Wire values remain the authority for all decisions.
enum NativeStatusCopy {
    static func support(_ code: String) -> String {
        switch code {
        case "open": return String(localized: "Open")
        case "under_review": return String(localized: "Under review")
        case "resolved": return String(localized: "Resolved")
        case "closed": return String(localized: "Closed")
        default: return code
        }
    }
    static func privacy(_ code: String) -> String {
        switch code {
        case "pending_approval": return String(localized: "Awaiting approval")
        case "approved": return String(localized: "Approved")
        case "queued": return String(localized: "Queued")
        case "processing": return String(localized: "Processing")
        case "completed": return String(localized: "Completed")
        case "rejected": return String(localized: "Rejected")
        case "failed": return String(localized: "Failed")
        case "cancelled": return String(localized: "Cancelled")
        default: return code
        }
    }
    static func sharing(_ code: String) -> String {
        switch code {
        case "requested": return String(localized: "Requested")
        case "accepted": return String(localized: "Accepted")
        case "declined": return String(localized: "Declined")
        case "withdrawn": return String(localized: "Withdrawn")
        case "expired": return String(localized: "Expired")
        case "revoked": return String(localized: "Revoked")
        case "blocked": return String(localized: "Blocked")
        default: return code
        }
    }
    static func faceOperation(_ code: String) -> String {
        switch code {
        case "pending": return String(localized: "Pending")
        case "capture_pending": return String(localized: "Capture pending")
        case "verifying": return String(localized: "Verifying")
        case "applied": return String(localized: "Applied")
        case "completed": return String(localized: "Completed")
        case "cancelled": return String(localized: "Cancelled")
        case "failed": return String(localized: "Failed")
        default: return code
        }
    }
    static func cleanup(_ code: String) -> String {
        switch code {
        case "none": return String(localized: "None")
        case "pending": return String(localized: "Pending")
        case "completed": return String(localized: "Completed")
        case "failed": return String(localized: "Failed")
        case "blocked": return String(localized: "Blocked")
        default: return code
        }
    }
}

struct NativePhoto: Identifiable, Sendable, Equatable {
    let id: String, title: String, source: String, version: String, feedSource: String
    let width: Int?, height: Int?
    init(_ wire: WireValue) throws {
        id = try wire.uuid("id"); title = wire["title"].string ?? String(localized: "Photo")
        source = try wire.text("media_source", maximum: 32); feedSource = wire["source"].string ?? "contributions"
        guard source == "personal" else { throw NativeAPIError.invalidResponse }
        version = wire["version"].string ?? ""
        width = wire["width"].integer.flatMap { $0 > 0 ? $0 : nil }; height = wire["height"].integer.flatMap { $0 > 0 ? $0 : nil }
    }
    var ratio: Double { guard let width, let height else { return 1 }; return Double(height) / Double(width) }
}
/// Captures the selected photo before asynchronous original-download work.
/// A later assignment invalidates the snapshot even if the user returns to
/// the same asset and version before the download completes.
struct NativePhotoSelectionFence: Sendable {
    struct Snapshot: Sendable {
        fileprivate let revision: UUID, assetID: String, source: String, version: String
    }
    private var revision = UUID()
    mutating func changed() { revision = UUID() }
    func capture(_ photo: NativePhoto) -> Snapshot {
        .init(revision: revision, assetID: photo.id, source: photo.source, version: photo.version)
    }
    func permits(_ snapshot: Snapshot, current: NativePhoto?) -> Bool {
        guard let current else { return false }
        return revision == snapshot.revision && current.id == snapshot.assetID &&
            current.source == snapshot.source && current.version == snapshot.version
    }
}
struct NativePerson: Identifiable, Sendable, Equatable {
    let id: String, name: String
    init(_ wire: WireValue) throws { id = try wire.uuid("id"); name = wire["name"].string ?? String(localized: "Matched person") }
}
struct NativePair: Hashable, Codable, Sendable {
    let asset_id: String, recipient_id: String
    init(_ wire: WireValue) throws { asset_id = try wire.uuid("asset_id"); recipient_id = try wire.uuid("recipient_id") }
    init(asset: String, recipient: String) { asset_id = asset; recipient_id = recipient }
    var wire: WireValue { .object(["asset_id": .string(asset_id), "recipient_id": .string(recipient_id)]) }
}
struct NativeSnapshot: Sendable {
    let wire: WireValue, id: String, version: String, source: String
    let photos: [NativePhoto], people: [NativePerson], pairs: Set<NativePair>, limited: Bool
    init(_ response: WireValue, source expectedSource: String = "personal") throws {
        guard response["protocol"].string == "reviewed-sharing-v1", response["status"].string == "ready" else { throw NativeAPIError.invalidResponse }
        wire = response["snapshot"]; id = try wire.uuid("id"); version = try wire.text("version"); source = expectedSource
        try wire.requireExpiry("expires_at")
        guard expectedSource == "personal", wire["source"].string == expectedSource,
              let assets = wire["assets"].array, assets.count <= 100, let recipients = wire["recipients"].array, recipients.count <= 100,
              let edgeValues = wire["pairs"].array, edgeValues.count <= 1000,
              let maxAssets = wire["scope"]["asset_limit"].integer, (1...100).contains(maxAssets),
              let maxPeople = wire["scope"]["recipient_limit"].integer, (1...100).contains(maxPeople),
              let maxPairs = wire["scope"]["pair_limit"].integer, (1...1000).contains(maxPairs),
              let hasMore = wire["scope"]["has_more"].bool, let selectionLimited = wire["scope"]["selection_limited"].bool,
              assets.count <= maxAssets, recipients.count <= maxPeople, edgeValues.count <= maxPairs,
              assets.allSatisfy({ $0["media_source"].string == expectedSource }) else { throw NativeAPIError.invalidResponse }
        photos = try assets.map(NativePhoto.init); people = try recipients.map(NativePerson.init)
        guard photos.allSatisfy({ $0.source == expectedSource }) else { throw NativeAPIError.invalidResponse }
        let edges = try edgeValues.map(NativePair.init); pairs = Set(edges); limited = hasMore || selectionLimited
        guard pairs.count == edges.count, Set(photos.map(\.id)).count == photos.count, Set(people.map(\.id)).count == people.count,
              pairs.allSatisfy({ pair in photos.contains { $0.id == pair.asset_id } && people.contains { $0.id == pair.recipient_id } }) else { throw NativeAPIError.invalidResponse }
    }
}
struct NativeShareDraft: Codable, Sendable, Equatable {
    var version = 1
    var selectedPhotos: Set<String>, selectedPeople: Set<String>, excludedPairs: Set<NativePair> = []
    init(snapshot: NativeSnapshot) { selectedPhotos = Set(snapshot.photos.map(\.id)); selectedPeople = Set(snapshot.people.map(\.id)) }
    func effective(_ snapshot: NativeSnapshot) -> Set<NativePair> { snapshot.pairs.filter { selectedPhotos.contains($0.asset_id) && selectedPeople.contains($0.recipient_id) && !excludedPairs.contains($0) } }
    func subsets(_ snapshot: NativeSnapshot) -> [String: [String]] {
        var value: [String: [String]] = [:]
        for pair in effective(snapshot) { value[pair.recipient_id, default: []].append(pair.asset_id) }
        return value.mapValues { $0.sorted() }
    }
    func previewPayload(_ snapshot: NativeSnapshot) throws -> WireValue {
        guard selectedPhotos.isSubset(of: Set(snapshot.photos.map(\.id))), selectedPeople.isSubset(of: Set(snapshot.people.map(\.id))), excludedPairs.isSubset(of: snapshot.pairs) else { throw NativeAPIError.reviewChanged }
        guard !effective(snapshot).isEmpty else { throw NativeAPIError.selectionEmpty }
        return .object(["snapshot_id": .string(snapshot.id), "snapshot_version": .string(snapshot.version), "draft_version": .integer(version),
          "selected_asset_ids": .strings(selectedPhotos.sorted()), "selected_recipient_ids": .strings(selectedPeople.sorted()),
          "excluded_pairs": .array(excludedPairs.sorted { ($0.asset_id, $0.recipient_id) < ($1.asset_id, $1.recipient_id) }.map(\.wire))])
    }
}

struct NativePreview: Sendable {
    let id: String, version: String, draftVersion: Int, pairs: Set<NativePair>, wire: WireValue
    init(_ value: WireValue, snapshot: NativeSnapshot, draft: NativeShareDraft) throws {
        if value["status"].string == "changed" { throw NativeAPIError.reviewChanged }
        guard value["protocol"].string == "reviewed-sharing-v1", value["status"].string == "ready" else { throw NativeAPIError.invalidResponse }
        wire = value["preview"]; id = try wire.uuid("id"); version = try wire.text("version")
        try wire.requireExpiry("expires_at")
        guard wire["source"].string == snapshot.source else { throw NativeAPIError.invalidResponse }
        guard let revision = wire["draft_version"].integer, revision == draft.version, let edges = wire["pairs"].array,
              let recipients = wire["recipients"].array else { throw NativeAPIError.invalidResponse }; draftVersion = revision
        pairs = Set(try edges.map(NativePair.init))
        guard pairs == draft.effective(snapshot), pairs.count == edges.count else { throw NativeAPIError.invalidResponse }
        let expected = draft.subsets(snapshot); var observed: [String: [String]] = [:]
        for recipient in recipients {
            let id = try recipient.uuid("recipient_id")
            guard observed[id] == nil, let photos = recipient["asset_ids"].array?.compactMap(\.string), recipient["photo_count"].integer == photos.count, Set(photos).count == photos.count else { throw NativeAPIError.invalidResponse }
            observed[id] = photos.sorted()
        }
        guard expected == observed, wire["totals"]["photos"].integer == Set(pairs.map(\.asset_id)).count,
              wire["totals"]["recipients"].integer == expected.count, wire["totals"]["pairs"].integer == pairs.count else { throw NativeAPIError.invalidResponse }
    }
}
struct NativeOperationIntent: Codable, Sendable {
    let key: String, accountID: String, source: String, action: String, payload: WireValue
    let approvedPairs: Set<NativePair>?
    var path: String? = nil
    var method: String? = nil
}
struct NativeUploadRecord: Codable, Sendable {
    let accountID: String, localID: String, sha256: String, assetID: String
    var status: String
}

extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    init?(base64URL: String) {
        var value = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4); self.init(base64Encoded: value)
    }
}

struct NativeRecoveryKeyMetadata: Codable, Sendable {
    let accountID: String, keyID: String, operationKey: String, expiresAt: Date
    init(_ value: WireValue, account: String, operation: String? = nil) throws {
        guard value["protocol"].string == "lovelies-account-recovery-v1", value["state"].string == "ready",
              value["account_id"].string == account, value["recovery_key"] == .null else { throw NativeAPIError.invalidResponse }
        accountID = account; keyID = try value.uuid("key_id"); operationKey = try value.uuid("operation_key")
        if let operation { guard operationKey == operation else { throw NativeAPIError.invalidResponse } }
        expiresAt = try NativeAccountRecoveryRecord.date(value["expires_at"])
        guard expiresAt > Date(), expiresAt <= Date().addingTimeInterval(366 * 86400) else { throw NativeAPIError.invalidResponse }
    }
}
struct NativeRecoveryKeyRecord: Codable, Sendable {
    let accountID: String, apiOrigin: String, operationKey: String, secret: String, createdAt: Date
    var metadata: NativeRecoveryKeyMetadata?
    var backup: String { "LVR1:" + accountID + ":" + secret }
    var body: WireValue { .object(["operation_key": .string(operationKey), "recovery_key": .string(secret)]) }
    func validate(origin: URL) throws {
        guard apiOrigin == origin.absoluteString, UUID(uuidString: accountID) != nil, accountID == accountID.lowercased(),
              UUID(uuidString: operationKey) != nil, NativeAccountRecoveryRecord.validSecret(secret, prefix: "lfr_"),
              createdAt <= Date().addingTimeInterval(120), metadata == nil || (metadata!.accountID == accountID && metadata!.operationKey == operationKey) else { throw NativeAPIError.invalidResponse }
    }
}
enum NativeAccountRecoveryState: String, Codable, Sendable {
    case preparingKey = "preparing_key", starting, pending, capturePending = "capture_pending", completionPending = "completion_pending"
    case verifying, restartRequired = "restart_required", registered, promoting
}
/// A02 is a separate encrypted intent. It never overwrites A01's original key,
/// contains only capture metadata, and cannot authenticate from readonly status.
struct NativeAccountRecoveryRecord: Codable, Sendable {
    static let aliasPrefix = "com.lovelies.account-recovery.p256."
    let accountID: String, apiOrigin: String, recoveryKey: String, requestID: String, faceHandle: String, keyAlias: String, policy: String, createdAt: Date
    var schema = 1, generation = 1
    var state: NativeAccountRecoveryState = .preparingKey
    var publicJWK: WireValue?, publicKeyDigest: String?, startSignature: String?
    var deviceID: String?, deviceRevision: String?, predecessorID: String?, challengeWire: WireValue?
    var profile: NativeEnrollmentProfile?, expiresAt: Date?, resume: NativeEnrollmentResume?
    var captures: [NativeEnrollmentCapture] = [], retiredCaptures: [NativeEnrollmentCapture] = []
    var loginTerminalCode: String?
    var supersededAliases: [String] = []
    var promotionCredentials: NativeCredentials?, promotionDevice: RegisteredDevice?
    var base: [String: WireValue] { ["account_id": .string(accountID), "recovery_key": .string(recoveryKey), "recovery_request_id": .string(requestID), "face_handle": .string(faceHandle), "device_public_jwk": publicJWK ?? .null, "policy_version": .string(policy)] }
    var startEnvelope: WireValue { var value = base; value["protocol"] = .string("lovelies-account-recovery-device-v1"); value["step"] = .string("start"); return .object(value) }
    var startBody: WireValue { var value = base; value["device_signature"] = startSignature.map(WireValue.string) ?? .null; return .object(value) }
    static func validAlias(_ value: String) -> Bool {
        value == NativeEnrollmentRecord.keyAlias || (value.hasPrefix(aliasPrefix) && UUID(uuidString: String(value.dropFirst(aliasPrefix.count))) != nil)
    }
    static func validSecret(_ value: String, prefix: String) -> Bool {
        guard value.hasPrefix(prefix), value.count == 47, let bytes = Data(base64URL: String(value.dropFirst(4))) else { return false }
        return bytes.count == 32 && bytes.base64URL == String(value.dropFirst(4))
    }
    static func backup(_ text: String) throws -> (String, String) {
        let values = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard values.count == 3, values[0] == "LVR1", UUID(uuidString: values[1]) != nil,
              values[1] == values[1].lowercased(), validSecret(values[2], prefix: "lfr_") else { throw NativeAPIError.unsupported(String(localized: "Enter the private LVR1 recovery backup you saved for this account.")) }
        return (values[1], values[2])
    }
    static func date(_ value: WireValue) throws -> Date {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let text = value.string, text.count <= 40, let result = formatter.date(from: text) else { throw NativeAPIError.invalidResponse }; return result
    }
    func publicKey() throws -> P256.Signing.PublicKey {
        guard let jwk = publicJWK, jwk["kty"].string == "EC", jwk["crv"].string == "P-256", jwk["ext"].bool == true, jwk["key_ops"] == .strings(["verify"]),
              Set(jwk.object?.keys.map { $0 } ?? []) == ["kty", "crv", "x", "y", "ext", "key_ops"],
              let x = jwk["x"].string.flatMap(Data.init(base64URL:)), let y = jwk["y"].string.flatMap(Data.init(base64URL:)), x.count == 32, y.count == 32 else { throw NativeAPIError.invalidResponse }
        return try P256.Signing.PublicKey(x963Representation: Data([4]) + x + y)
    }
    func validate(origin: URL) throws {
        for capture in captures + retiredCaptures { try capture.validate() }
        guard loginTerminalCode == nil || NativeFaceTerminalFailure.known(loginTerminalCode) else { throw NativeAPIError.invalidResponse }
        guard schema == 1, apiOrigin == origin.absoluteString, UUID(uuidString: accountID) != nil, accountID == accountID.lowercased(),
              UUID(uuidString: requestID) != nil, Self.validSecret(recoveryKey, prefix: "lfr_"), Self.validSecret(faceHandle, prefix: "lfh_"),
              keyAlias == Self.aliasPrefix + requestID, !policy.isEmpty, policy.count <= 128, createdAt <= Date().addingTimeInterval(120),
              (1...1000).contains(generation), captures.count <= 1, retiredCaptures.count <= 1,
              supersededAliases.count <= 10, Set(supersededAliases).count == supersededAliases.count,
              supersededAliases.allSatisfy({ Self.validAlias($0) && $0 != keyAlias }),
              (deviceID == nil) == (deviceRevision == nil), (promotionCredentials == nil) == (promotionDevice == nil) else { throw NativeAPIError.invalidResponse }
        if state == .preparingKey { guard publicJWK == nil, publicKeyDigest == nil, startSignature == nil, deviceID == nil, challengeWire == nil else { throw NativeAPIError.invalidResponse }; return }
        guard let publicJWK, let digest = publicKeyDigest, digest == SHA256.hash(data: try publicJWK.canonical()).map({ String(format: "%02x", $0) }).joined(),
              let signature = startSignature.flatMap(Data.init(base64URL:)), signature.count == 64,
              try publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: signature), for: startEnvelope.canonical()) else { throw NativeAPIError.invalidResponse }
        if let deviceID { guard UUID(uuidString: deviceID) != nil, UUID(uuidString: deviceRevision!) != nil, profile != nil else { throw NativeAPIError.invalidResponse } }
        if let predecessorID { guard UUID(uuidString: predecessorID) != nil else { throw NativeAPIError.invalidResponse } }
        if let profile { guard UUID(uuidString: profile.id) != nil, !profile.revision.isEmpty, !profile.modelID.isEmpty else { throw NativeAPIError.invalidResponse } }
        if let challengeWire {
            let challenge = try NativeFaceChallenge(challengeWire, accountID: accountID, purpose: "login", allowExpired: true)
            guard challenge.deviceID == deviceID, challengeWire["device_revision"].string == deviceRevision, challengeWire["policy_version"].string == policy,
                  challengeWire["profile_id"].string == profile?.id, challengeWire["profile_revision"].string == profile?.revision,
                  challengeWire["model_id"].string == profile?.modelID, challenge.poses == ["front"] else { throw NativeAPIError.invalidResponse }
        }
        if let resume { guard UUID(uuidString: resume.key) != nil, resume.generation == generation, resume.challengeID == predecessorID else { throw NativeAPIError.invalidResponse } }
        if [.registered, .promoting].contains(state) { guard profile != nil, deviceID != nil else { throw NativeAPIError.invalidResponse } }
        if let credential = promotionCredentials, let device = promotionDevice {
            try credential.validateRegisteredRecovery(accountID: accountID)
            guard device.accountID == accountID, device.deviceID == deviceID, device.faceHandle == faceHandle, device.keyAlias == keyAlias,
                  device.profileID == profile?.id, device.profileRevision == profile?.revision, device.modelID == profile?.modelID else { throw NativeAPIError.invalidResponse }
        }
        if state == .promoting { guard promotionCredentials != nil else { throw NativeAPIError.invalidResponse } }
    }
}
struct NativeAccountRecoverySummary: Sendable {
    let accountID: String, state: NativeAccountRecoveryState, challenge: NativeFaceChallenge?, receipts: [WireValue]
    var awaitingServer: Bool { [.capturePending, .completionPending, .verifying].contains(state) }
}

enum NativeFaceProfileAction: String, Codable, Sendable, CaseIterable {
    case pause, resume, withdrawAuthentication = "withdraw_authentication", remove, replace, restoreAuthentication = "restore_authentication", enroll
    var captures: Bool { [.replace, .restoreAuthentication, .enroll].contains(self) }
    var purpose: String { self == .replace ? "replacement" : "registration" }
}
struct NativeFaceProfileMetadata: Codable, Sendable {
    let wire: WireValue, version: Int
    let accountID: String, deviceID: String, deviceRevision: String, publicKeyDigest: String, authPolicy: String, photoPolicy: String
    let profile: NativeEnrollmentProfile?
    let authenticationEnabled: Bool, matchingEnabled: Bool, processingEnabled: Bool, receiveMatches: Bool, matchingPaused: Bool
    let removalState: String
    init(_ value: WireValue, account: String, device: String, digest: String, nonce: String? = nil) throws {
        guard value["protocol"].string == "lovelies-face-profile-v1", value["authenticated"].bool == false,
              value["account_id"].string == account, value["device_id"].string == device, value["public_key_digest"].string == digest,
              let version = value["version"].integer, version > 0, let auth = value["authentication_enabled"].bool,
              let matching = value["matching_enabled"].bool, let processing = value["processing_enabled"].bool,
              let receiving = value["receive_matches"].bool, let paused = value["matching_paused"].bool,
              let removal = value["removal_state"].string, ["none", "pending", "failed", "blocked", "completed"].contains(removal),
              ["access_token", "refresh_token", "face_handle", "device_public_jwk", "control_key", "template_key", "template_digest"].allSatisfy({ value[$0] == .null }) else { throw NativeAPIError.invalidResponse }
        if let nonce { guard value["request_nonce"].string == nonce else { throw NativeAPIError.invalidResponse } }
        wire = value; self.version = version; accountID = account; deviceID = device; publicKeyDigest = digest; deviceRevision = try value.uuid("device_revision")
        authPolicy = try value.text("auth_policy_version", maximum: 128); photoPolicy = try value.text("photo_policy_version", maximum: 128)
        profile = value["profile"] == .null ? nil : try NativeEnrollmentProfile(value["profile"])
        authenticationEnabled = auth; matchingEnabled = matching; processingEnabled = processing; receiveMatches = receiving; matchingPaused = paused; removalState = removal
        guard !auth || profile != nil else { throw NativeAPIError.invalidResponse }
        if value["operation"] != .null {
            let operation = value["operation"]; _ = try operation.uuid("operation_key")
            guard let action = operation["action"].string.flatMap(NativeFaceProfileAction.init(rawValue:)),
                  let generation = operation["generation"].integer, !action.captures || generation > 0,
                  let state = operation["state"].string, ["applied", "pending", "capture_pending", "verifying", "restart_required", "completed", "cancelled", "failed"].contains(state),
                  let cleanup = operation["cleanup_state"].string, ["none", "pending", "failed", "blocked", "completed"].contains(cleanup),
                  let captures = operation["captures"].array, captures.count <= 3 else { throw NativeAPIError.invalidResponse }
            if operation["challenge_id"] != .null { _ = try operation.uuid("challenge_id") }
            if ["applied", "completed"].contains(state) { guard operation["challenge"] == .null, captures.isEmpty else { throw NativeAPIError.invalidResponse } }
        }
    }
}
struct NativeFaceLifecycleIntent: Codable, Sendable {
    let operationKey: String, action: NativeFaceProfileAction, expectedVersion: Int, consent: WireValue?, createdAt: Date
    var generation = 0, predecessorID: String?, challengeWire: WireValue?, serverState: String?
    var completionPending = false, missingOnServer = false, cancelRequested = false
    var captures: [NativeEnrollmentCapture] = [], retiredCaptures: [NativeEnrollmentCapture] = []
    var resume: NativeEnrollmentResume?, cleanupState = "none"
    var awaitingServer: Bool { cancelRequested || completionPending || captures.contains(where: { !$0.accepted }) || serverState == nil || ["capture_pending", "verifying"].contains(serverState ?? "") }
    var terminal: Bool { ["applied", "completed", "cancelled", "failed"].contains(serverState ?? "") }
    var fields: [String: WireValue] {
        var body: [String: WireValue] = ["operation_key": .string(operationKey), "action": .string(action.rawValue), "expected_version": .integer(expectedVersion)]
        if let consent { body["consent"] = consent }; return body
    }
    func validate() throws {
        guard UUID(uuidString: operationKey) != nil, expectedVersion > 0, createdAt <= Date().addingTimeInterval(120), (0...1000).contains(generation),
              captures.count <= 3, retiredCaptures.count <= 3, captures.enumerated().allSatisfy({ $0.offset == $0.element.index }) else { throw NativeAPIError.invalidResponse }
        for capture in captures + retiredCaptures { try capture.validate() }
        guard captures.reduce(0, { $0 + $1.byte_size }) <= 8 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        if let predecessorID { guard UUID(uuidString: predecessorID) != nil else { throw NativeAPIError.invalidResponse } }
        if let resume { guard UUID(uuidString: resume.key) != nil, resume.generation == generation, resume.challengeID == predecessorID else { throw NativeAPIError.invalidResponse } }
        if action == .resume || action.captures {
            guard let consent, consent["purpose"].string == (action == .resume ? "photo_matching" : "face_authentication"), consent["granted"].bool == true else { throw NativeAPIError.invalidResponse }; _ = try consent.text("policy_version", maximum: 128)
        } else { guard consent == nil else { throw NativeAPIError.invalidResponse } }
    }
}
struct NativeFaceControlBinding: Codable, Sendable {
    let key: String, operationKey: String, previousOperationKey: String?, signature: String, createdAt: Date
    func body(account: String, device: String) -> [String: WireValue] {
        var value: [String: WireValue] = ["account_id": .string(account), "device_id": .string(device), "control_key": .string(key), "control_operation_key": .string(operationKey)]
        if let previousOperationKey { value["renew"] = .bool(true); value["previous_control_operation_key"] = .string(previousOperationKey) }
        return value
    }
}
struct NativeFaceLifecycleRecord: Codable, Sendable {
    let accountID: String, apiOrigin: String, originalDevice: RegisteredDevice, keyAlias: String, publicJWK: WireValue, publicKeyDigest: String
    var controlKey: String, controlOperationKey: String, controlSignature: String, createdAt: Date
    var previousControlOperationKey: String?, renewal: NativeFaceControlBinding?
    var controlHistory: [NativeFaceControlBinding] = []
    var schema = 1, controlReady = false, authorityUnavailable = false
    var authorityFailure: String?
    var metadata: NativeFaceProfileMetadata
    var credentials: NativeCredentials?, promotionCredentials: NativeCredentials?
    var promotionProfile: NativeEnrollmentProfile?
    var pending: NativeFaceLifecycleIntent?, history: [NativeFaceLifecycleIntent] = []
    var loginChallengeWire: WireValue?, loginCaptures: [NativeEnrollmentCapture] = []
    var loginTerminalCode: String?
    var loginCompletionPending = false, stableControlLogin = false, currentAuthorityValidated = false
    var base: [String: WireValue] { ["account_id": .string(accountID), "device_id": .string(originalDevice.deviceID), "control_key": .string(controlKey)] }
    var controlBinding: NativeFaceControlBinding { NativeFaceControlBinding(key: controlKey, operationKey: controlOperationKey, previousOperationKey: previousControlOperationKey, signature: controlSignature, createdAt: createdAt) }
    var controlEnvelope: WireValue { var body = controlBinding.body(account: accountID, device: originalDevice.deviceID); body["protocol"] = .string("lovelies-face-profile-device-v1"); body["step"] = .string("control"); return .object(body) }
    var controlBody: WireValue { var body = controlBinding.body(account: accountID, device: originalDevice.deviceID); body["device_signature"] = .string(controlSignature); return .object(body) }
    var blocksAlternateRecovery: Bool {
        if renewal != nil || !controlReady || authorityUnavailable || !metadata.authenticationEnabled || promotionCredentials != nil || ["pending", "failed", "blocked"].contains(metadata.removalState) { return true }
        if let pending { return !["applied", "completed", "cancelled"].contains(pending.serverState ?? "") }
        return false
    }
    var activeHold: Bool { blocksAlternateRecovery || credentials == nil }

    func publicKey() throws -> P256.Signing.PublicKey {
        guard publicJWK["kty"].string == "EC", publicJWK["crv"].string == "P-256", publicJWK["ext"].bool == true, publicJWK["key_ops"] == .strings(["verify"]),
              Set(publicJWK.object?.keys.map { $0 } ?? []) == ["kty", "crv", "x", "y", "ext", "key_ops"],
              let x = publicJWK["x"].string.flatMap(Data.init(base64URL:)), let y = publicJWK["y"].string.flatMap(Data.init(base64URL:)), x.count == 32, y.count == 32 else { throw NativeAPIError.invalidResponse }
        return try P256.Signing.PublicKey(x963Representation: Data([4]) + x + y)
    }
    func validate(origin: URL) throws {
        guard loginTerminalCode == nil || NativeFaceTerminalFailure.known(loginTerminalCode) else { throw NativeAPIError.invalidResponse }
        guard schema == 1, accountID == originalDevice.accountID, UUID(uuidString: accountID) != nil, apiOrigin == origin.absoluteString,
              UUID(uuidString: originalDevice.deviceID) != nil, NativeAccountRecoveryRecord.validSecret(originalDevice.faceHandle, prefix: "lfh_"), NativeAccountRecoveryRecord.validAlias(keyAlias), keyAlias == (originalDevice.keyAlias ?? NativeEnrollmentRecord.keyAlias),
              NativeAccountRecoveryRecord.validSecret(controlKey, prefix: "lfl_"), UUID(uuidString: controlOperationKey) != nil, history.count <= 32,
              createdAt <= Date().addingTimeInterval(120), metadata.accountID == accountID, metadata.deviceID == originalDevice.deviceID,
              metadata.publicKeyDigest == publicKeyDigest, publicKeyDigest == SHA256.hash(data: try publicJWK.canonical()).map({ String(format: "%02x", $0) }).joined(),
              let raw = Data(base64URL: controlSignature), raw.count == 64,
              try publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: raw), for: controlEnvelope.canonical()) else { throw NativeAPIError.invalidResponse }
        guard controlHistory.count <= 8 else { throw NativeAPIError.invalidResponse }
        for binding in controlHistory + (renewal.map { [$0] } ?? []) {
            guard NativeAccountRecoveryRecord.validSecret(binding.key, prefix: "lfl_"), UUID(uuidString: binding.operationKey) != nil,
                  binding.createdAt <= Date().addingTimeInterval(120), binding.previousOperationKey == nil || UUID(uuidString: binding.previousOperationKey!) != nil,
                  let bytes = Data(base64URL: binding.signature), bytes.count == 64 else { throw NativeAPIError.invalidResponse }
            var envelope = binding.body(account: accountID, device: originalDevice.deviceID); envelope["protocol"] = .string("lovelies-face-profile-device-v1"); envelope["step"] = .string("control")
            guard try publicKey().isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: bytes), for: WireValue.object(envelope).canonical()) else { throw NativeAPIError.invalidResponse }
        }
        if let renewal { guard renewal.previousOperationKey == controlOperationKey, renewal.key != controlKey, renewal.operationKey != controlOperationKey else { throw NativeAPIError.invalidResponse } }
        try credentials?.validateRegisteredRecovery(accountID: accountID); try promotionCredentials?.validateRegisteredRecovery(accountID: accountID)
        guard (promotionCredentials == nil) == (promotionProfile == nil), loginCaptures.count <= 1 else { throw NativeAPIError.invalidResponse }
        let checked = try NativeFaceProfileMetadata(metadata.wire, account: accountID, device: originalDevice.deviceID, digest: publicKeyDigest)
        guard checked.version == metadata.version, checked.deviceRevision == metadata.deviceRevision, checked.profile == metadata.profile,
              checked.authPolicy == metadata.authPolicy, checked.photoPolicy == metadata.photoPolicy, checked.authenticationEnabled == metadata.authenticationEnabled,
              checked.matchingEnabled == metadata.matchingEnabled, checked.processingEnabled == metadata.processingEnabled,
              checked.receiveMatches == metadata.receiveMatches, checked.matchingPaused == metadata.matchingPaused, checked.removalState == metadata.removalState else { throw NativeAPIError.invalidResponse }
        try pending?.validate(); for intent in history { try intent.validate() }; for capture in loginCaptures { try capture.validate() }
        if let wire = pending?.challengeWire {
            let purpose = pending!.action.purpose, value = try NativeFaceChallenge(wire, accountID: accountID, purpose: purpose, allowExpired: true)
            guard value.deviceID == originalDevice.deviceID, wire["device_revision"].string == metadata.deviceRevision,
                  wire["lifecycle_operation_key"].string == pending!.operationKey, wire["lifecycle_generation"].integer == pending!.generation,
                  value.id == pending!.predecessorID else { throw NativeAPIError.invalidResponse }
        }
        if let loginChallengeWire {
            let value = try NativeFaceChallenge(loginChallengeWire, accountID: accountID, purpose: "login", allowExpired: true)
            guard value.deviceID == originalDevice.deviceID, loginChallengeWire["profile_id"].string == metadata.profile?.id,
                  loginChallengeWire["profile_revision"].string == metadata.profile?.revision, loginChallengeWire["model_id"].string == metadata.profile?.modelID else { throw NativeAPIError.invalidResponse }
        }
    }
}
struct NativeFaceLifecycleSummary: Sendable {
    let metadata: NativeFaceProfileMetadata, operation: NativeFaceLifecycleIntent?, challenge: NativeFaceChallenge?, receipts: [WireValue]
    let authorityUnavailable: Bool, authenticated: Bool, canRenewControl: Bool
    var awaitingServer: Bool { operation?.awaitingServer == true }
    var cleanupPending: Bool { ["pending", "failed", "blocked"].contains(metadata.removalState) || ["pending", "failed", "blocked"].contains(operation?.cleanupState ?? "none") }
}

/// Shutter publication is bound to the exact server challenge and, for A03, its
/// durable operation/generation. A later task cannot publish an older JPEG.
struct NativeFaceShutterContext: Sendable, Equatable {
    let accountID: String, deviceID: String, challengeID: String
    let operationKey: String?, generation: Int?
    let deviceRevision: String?, profileID: String?, profileRevision: String?, policyVersion: String?, nonce: String?
    init(_ challenge: NativeFaceChallenge) {
        accountID = challenge.accountID; deviceID = challenge.deviceID; challengeID = challenge.id
        operationKey = challenge.wire["lifecycle_operation_key"].string
        generation = challenge.wire["lifecycle_generation"].integer
        deviceRevision = challenge.wire["device_revision"].string; profileID = challenge.wire["profile_id"].string
        profileRevision = challenge.wire["profile_revision"].string; policyVersion = challenge.wire["policy_version"].string; nonce = challenge.wire["nonce"].string
    }
    func permits(_ current: NativeFaceChallenge?) -> Bool { current.map { NativeFaceShutterContext($0) == self } ?? false }
}

struct NativeLibraryState: Codable, Sendable {
    let accountID: String
    var favoriteIDs: Set<String> = []
    var anchor: String?
    var source = "all"
    var query = ""
    var columns = 3
    // Optional fields preserve older account-bound browsing records.
    var destination: Int? = nil
    var category: String? = nil
    static let restorableDestinations: Set<Int> = [10, 11, 13, 14, 15, 16, 17, 18, 19, 35, 37, 39, 40, 41, 42, 43, 44, 45, 46]
    var safeDestination: Int? { destination.flatMap { Self.restorableDestinations.contains($0) ? $0 : nil } }
    static func boundedQuery(_ text: String) -> String { var result = String(text.prefix(200)); while result.utf16.count > 200 { result.removeLast() }; return result }
    var review: NativeShareDraft?
    var reviewAssetIDs: [String] = []
}


struct NativeRegisteredDeletionRecord: Codable, Sendable {
    let accountID: String, operationKey: String, statusToken: String, apiOrigin: String, preparedAt: Date
    var response: WireValue?
    var payload: WireValue { .object(["operation_key": .string(operationKey), "status_token": .string(statusToken)]) }
    var completed: Bool { response?["deletion_completed"].bool == true && response?["privacy_request"]["status"].string == "completed" }
    func validate(origin: URL) throws {
        guard apiOrigin == origin.absoluteString, UUID(uuidString: accountID) != nil, UUID(uuidString: operationKey) != nil,
              statusToken.hasPrefix("lvd_"), statusToken.count == 68,
              statusToken.dropFirst(4).allSatisfy({ $0.isHexDigit && !$0.isUppercase }), preparedAt <= Date().addingTimeInterval(120) else { throw NativeAPIError.invalidResponse }
    }
    func validateResponse(_ value: WireValue) throws {
        guard value["protocol"].string == "lovelies-account-deletion-v1", value["source"].string == "privacy",
              value["operation_key"].string == operationKey, value["privacy_request"]["request_type"].string == "delete",
              value["deletion_completed"].bool != nil,
              ["pending_approval", "approved", "queued", "processing", "completed", "rejected", "failed", "cancelled"].contains(value["privacy_request"]["status"].string ?? "") else { throw NativeAPIError.invalidResponse }
        _ = try value["privacy_request"].uuid("id")
        if let response { guard value["privacy_request"]["id"] == response["privacy_request"]["id"] else { throw NativeAPIError.invalidResponse } }
        guard value["deletion_completed"].bool == (value["privacy_request"]["status"].string == "completed") else { throw NativeAPIError.invalidResponse }
    }
}
