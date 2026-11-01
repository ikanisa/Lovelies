import SwiftUI
import UIKit
import AVFoundation

typealias NativePhotoSaveOperation = @MainActor (Data, @escaping @MainActor () async throws -> Void) async throws -> Void

@MainActor final class LiveAppStore: ObservableObject {
    @Published var session: NativeSessionSummary? { didSet { schedulePrivateContentExpiry() } }
    @Published private(set) var audience: NativeAudienceProjection?
    @Published private(set) var deviceAudience: NativeAudienceDeviceStatus?
    @Published private(set) var hasSavedAudienceDevice = false
    @Published private(set) var deviceAudienceNeeded = false
    @Published private(set) var audienceRenewalContinuation: String?
    @Published private(set) var audienceReviewPolicy = ""
    private var deviceAudienceBinding: NativeAudienceSessionBinding?
    @Published private(set) var audiencePendingMutation = false
    @Published private(set) var guardianClaim: NativeGuardianRequest?
    private var audienceCaptureGeneration = 0
    private var audienceSessionEpoch: Int?
    private var audienceExpiryTask: Task<Void, Never>?
    private var audienceDeadline: NativePrivateMediaDeadline?
    @Published private(set) var audienceBinding: NativeAudienceSessionBinding?
    var hasRegisteredPrivacyIdentity: Bool { audienceBinding?.registeredIdentity == true }
    @Published var connected = false
    @Published var busy = false
    @Published var error: String?
    @Published var hasPendingOperation = false
    @Published private(set) var hasPendingPrivacyOperation = false
    @Published var photos: [NativePhoto] = []
    private var photoSelection = NativePhotoSelectionFence()
    @Published var currentPhoto: NativePhoto? { didSet { photoSelection.changed() } }
    @Published var currentPerson: NativePerson?
    @Published var imports: [NativeImport] = []
    @Published var selectedImports: Set<String> = []
    @Published var snapshot: NativeSnapshot?
    @Published var draft: NativeShareDraft?
    @Published var preview: NativePreview?
    @Published var outcome: WireValue?
    @Published var inbox: [WireValue] = []
    @Published var receipt: WireValue?
    @Published var query = ""
    @Published var name = ""
    @Published var preferences: WireValue = .object([:])
    @Published var privacy: WireValue = .object([:])
    @Published var registeredDeletion: NativeRegisteredDeletionRecord?
    @Published var guestDeletion: NativeGuestDeletionSummary?
    @Published var enrollment: NativeEnrollmentSummary?
    @Published var accountRecovery: NativeAccountRecoverySummary?
    @Published var faceLifecycle: NativeFaceLifecycleSummary?
    @Published var ordinaryLogin: NativeOrdinaryLoginSummary?
    @Published var accountRecoverySheet = false
    @Published var recoveryKey: NativeRecoveryKeyMetadata?
    @Published var recoveryBackup: String?
    @Published var recoveryBackupSheet = false
    @Published var policy = ""
    @Published var authConsent = false
    @Published var processingConsent = false
    @Published var acceptedAuthPolicy = ""
    @Published var challenge: NativeFaceChallenge?
    @Published var captureReceipts: [WireValue] = []
    @Published var lastSelfie: UIImage?
    @Published private(set) var selfieReview: NativeSelfieCandidate?
    @Published private(set) var faceQualityFailure: NativeFaceQualityFailure?
    @Published private(set) var captureNeedsStatus = false
    @Published var uploadedIDs: [String] = []
    @Published private(set) var uploadRecovery: NativeUploadSummary?
    @Published private(set) var uploadRunning = false
    @Published var uploadCaption = ""
    @Published private(set) var photoImportContext: String?
    private var uploadTask: Task<Void, Never>?
    private var uploadPresentation = 0
    @Published var processingStatuses: [String: String] = [:]
    @Published var transferText = ""
    @Published var pendingReceiptID: String?
    @Published var mediaRevision = 0
    @Published var favoriteIDs: Set<String> = []
    @Published var gallerySource = "all"
    @Published var galleryCategory = "all"
    @Published var galleryColumns = 3
    @Published var outgoing: [WireValue] = []
    @Published var supportRequests: [WireValue] = []
    @Published var supportSubject = ""
    @Published var supportDetails = ""
    @Published var sharedFile: NativeShareFile?
    @Published private(set) var retainedPrivacyExports: Set<String> = []
    private let sharedFiles: NativeAuthorizedShareFiles
    private let privateMediaClock: NativePrivateMediaClock
    private let savePhotoToLibrary: NativePhotoSaveOperation
    private var sharedFileDeadline: NativePrivateMediaDeadline?
    private var sharedFileExpiryTask: Task<Void, Never>?
    private var libraryAccount: String?
    private var savedReview: NativeShareDraft?
    private var savedReviewAssetIDs: [String] = []
    private var librarySave: Task<Void, Never>?
    private var lastLibraryScreen: Screen?
    private var restoredDestination: Screen?

    @Published var devices: [WireValue] = []
    @Published var sessions: [WireValue] = []
    @Published var photoCamera = false
    @Published var photoCameraPermissionDenied = false
    @Published var isForeground = true
    @Published var galleryAnchor: String?
    @Published var blockedPeople: [WireValue] = []
    @Published var notificationSettings: WireValue = .object([:])
    @Published var notifications: [WireValue] = []
    let camera = NativeCamera()
    private(set) var repository: BackendRepository?
    private var nextCursor: WireValue?
    private var loadedGalleryQuery: NativeGalleryQuery?
    private var galleryReadSerial = 0
    private var galleryReloadQueued = false
    private var inboxCursor: String?, outgoingCursor: String?, notificationCursor: String?, supportCursor: String?
    var hasMoreInbox: Bool { inboxCursor != nil }
    var hasMoreOutgoing: Bool { outgoingCursor != nil }
    var hasMoreNotifications: Bool { notificationCursor != nil }
    var hasMoreSupport: Bool { supportCursor != nil }
    private var navigation: DemoStore?
    private var workTask: Task<Void, Never>?
    private var workGeneration = 0
    private var privateContentExpiryTask: Task<Void, Never>?
    private struct PrivateReadOwner {
        let accountID: String?, epoch: Int?, expiresAt: Date?
        let weakBinding: NativeAudienceSessionBinding?
    }
    private let localAuthenticator: any NativeLocalAuthenticating
    private var localSigningLease: NativeLocalSigningLease?
    private var localAuthenticationOperation: UUID?
    private var localAuthenticationPending = false
    private var cameraReviewGeneration = 0
    private var retakeChallenge: NativeFaceChallenge?
    private(set) var photoCameraContext: NativeMediaCaptureContext?
    init(sharedFiles: NativeAuthorizedShareFiles = NativeAuthorizedShareFiles(), privateMediaClock: NativePrivateMediaClock = .live,
         localAuthenticator: any NativeLocalAuthenticating = NativeLocalAuthenticator(), repository: BackendRepository? = nil,
         savePhotoToLibrary: @escaping NativePhotoSaveOperation = { bytes, requireCurrent in
             try await NativePhotoLibrary.save(bytes, requireCurrent: requireCurrent)
         }) {
        self.sharedFiles = sharedFiles; self.privateMediaClock = privateMediaClock; self.localAuthenticator = localAuthenticator
        self.repository = repository; self.savePhotoToLibrary = savePhotoToLibrary
        // A restarted presentation has no surviving authority. Only recognized
        // private share files participate; durable upload staging is separate.
        do { try sharedFiles.prune(now: privateMediaClock.read().wall) }
        catch { scheduleSharedFileCleanupRetry() }
    }
    var audienceEligible: Bool {
        guard audienceRenewalContinuation == nil, let audience, audience.accountID == audienceBinding?.accountID, audienceSessionEpoch == audienceBinding?.epoch,
              session == nil || session?.accountID == audience.accountID && session?.epoch == audienceSessionEpoch else { return false }
        return (try? audience.require(.faceAuthentication)) != nil
    }
    var canManagePrivacy: Bool { !busy }
    var canEdit: Bool { audienceEligible && !hasPendingOperation && !uploadRunning && canManagePrivacy }
    var canDeleteGuest: Bool { connected && !hasRegisteredPrivacyIdentity && (session?.authenticated == false || audienceBinding != nil) && guestDeletion == nil && accountRecovery == nil && faceLifecycle == nil && !busy }
    var blockedPersonIDs: Set<String> { Set(blockedPeople.compactMap { $0["blocked_id"].string }) }
    var effective: Set<NativePair> { guard let snapshot, let draft else { return [] }; return draft.effective(snapshot).filter { !blockedPersonIDs.contains($0.recipient_id) } }
    var subsets: [String: [String]] { Dictionary(grouping: effective, by: \.recipient_id).mapValues { $0.map(\.asset_id).sorted() } }
    var displayedPhotos: [NativePhoto] { photos }
    func attach(_ navigation: DemoStore) { self.navigation = navigation }
    func perform(_ work: @escaping @MainActor (NativeAccountPublicationPermit) async throws -> Void) {
        let account = session?.accountID ?? audienceBinding?.accountID, epoch = session?.epoch ?? audienceBinding?.epoch
        performGuarded { [self] fence in
            let permit = NativeAccountPublicationPermit(generation: fence.generation, accountID: account, sessionEpoch: epoch)
            try checkPublication(permit)
            do { try await work(permit) }
            catch { try checkPublication(permit); throw error }
        }
    }
    private func checkPublication(_ permit: NativeAccountPublicationPermit) throws {
        guard permit.permits(generation: workGeneration, accountID: session?.accountID ?? audienceBinding?.accountID,
            sessionEpoch: session?.epoch ?? audienceBinding?.epoch, foreground: isForeground, cancelled: Task.isCancelled) else { throw CancellationError() }
    }
    private func publicationPermit() -> NativeAccountPublicationPermit {
        .init(generation: workGeneration, accountID: session?.accountID ?? audienceBinding?.accountID,
              sessionEpoch: session?.epoch ?? audienceBinding?.epoch)
    }
    func publicationFence() -> NativePublicationFence { NativePublicationFence(generation: workGeneration) }
    func checkPublication(_ fence: NativePublicationFence) throws {
        guard fence.permits(currentGeneration: workGeneration, cancelled: Task.isCancelled) else { throw CancellationError() }
    }
    private func privateReadOwner() -> PrivateReadOwner {
        .init(accountID: session?.accountID, epoch: session?.epoch, expiresAt: session?.expiresAt, weakBinding: audienceBinding)
    }
    private func checkPrivatePublication(_ owner: PrivateReadOwner, fence: NativePublicationFence) throws {
        try checkPublication(fence)
        guard owner.accountID == session?.accountID, owner.epoch == session?.epoch, owner.weakBinding == audienceBinding,
              owner.expiresAt == nil || owner.expiresAt! > Date() else { throw NativeAPIError.sessionChanged }
    }
    private func schedulePrivateContentExpiry() {
        privateContentExpiryTask?.cancel(); privateContentExpiryTask = nil
        guard let captured = session else { return }
        privateContentExpiryTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(max(0, captured.expiresAt.timeIntervalSinceNow)))
                guard !Task.isCancelled, let self, self.session?.accountID == captured.accountID,
                      self.session?.epoch == captured.epoch, self.session?.expiresAt == captured.expiresAt,
                      captured.expiresAt <= Date() else { return }
                self.workTask?.cancel(); self.workGeneration += 1; self.busy = false
                self.retireAccountPresentation()
            } catch {}
        }
    }
    private func performGuarded(localSigning purpose: NativeLocalAuthenticationPurpose? = nil, recoveryBackup: String? = nil,
                                retainedEnrollmentOnly: Bool = false,
                                _ work: @escaping @MainActor (NativePublicationFence) async throws -> Void) {
        performGuarded(localSigning: purpose, recoveryBackup: recoveryBackup, retainedEnrollmentOnly: retainedEnrollmentOnly,
                       guestResume: false) { fence, _, _ in try await work(fence) }
    }
    private func performGuarded(localSigning purpose: NativeLocalAuthenticationPurpose?, recoveryBackup: String? = nil,
                                retainedEnrollmentOnly: Bool = false, guestResume: Bool, profileCancellation: Bool = false,
                                _ work: @escaping @MainActor (NativePublicationFence, NativeGuestSetupResumeTicket?, NativeLocalTransitionTicket?) async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil; workGeneration += 1; let generation = workGeneration
        let fence = NativePublicationFence(generation: generation)
        let operationID = UUID()
        workTask = Task {
            var lease: NativeLocalSigningLease?
            defer {
                lease?.retire()
                if localAuthenticationOperation == operationID {
                    localAuthenticationPending = false; localAuthenticationOperation = nil; localSigningLease = nil
                }
                if let repository { Task { await repository.finishLocalSigning(operationID: operationID) } }
                if generation == workGeneration { busy = false; dispatchQueuedGalleryReload() }
            }
            do {
                try checkPublication(fence)
                var resumeTicket: NativeGuestSetupResumeTicket?
                var transitionTicket: NativeLocalTransitionTicket?
                if let purpose {
                    if repository == nil { repository = try NativeBackgroundUploads.shared.repository() }
                    guard let repository else { throw NativeAPIError.unavailable("configuration") }
                    if let recoveryBackup {
                        await NativeBackgroundUploads.shared.stop(); try checkPublication(fence)
                        if try await repository.recoveryStartNeedsSignedRetirement(backup: recoveryBackup) {
                            guard let retirement = try await repository.prepareLocalSigning(purpose: .connect, operationID: operationID) else { throw NativeLocalAuthenticationIssue.required }
                            lease = try await authorizeLocalSigning(retirement, repository: repository, fence: fence)
                            try await NativeLocalSigningOperation.$id.withValue(operationID) {
                                try await NativeLocalSigningOperation.$purpose.withValue(.connect) { try await repository.logout() }
                            }
                            lease?.retire(); lease = nil; localSigningLease = nil
                            await repository.finishLocalSigning(operationID: operationID); try checkPublication(fence)
                        }
                        transitionTicket = try await repository.prepareAccountRecoveryStart(backup: recoveryBackup)
                        try checkPublication(fence)
                    } else if profileCancellation {
                        transitionTicket = try await repository.prepareFaceProfileCancellation()
                        try checkPublication(fence)
                    }
                    if guestResume {
                        resumeTicket = try await repository.prepareGuestSetupResume()
                        try checkPublication(fence)
                    }
                    let request = try await repository.prepareLocalSigning(purpose: purpose, operationID: operationID, recoveryBackup: recoveryBackup,
                                                                          retainedEnrollmentOnly: retainedEnrollmentOnly, guestResume: resumeTicket, transition: transitionTicket)
                    try checkPublication(fence)
                    if let request {
                        lease = try await authorizeLocalSigning(request, repository: repository, fence: fence)
                    }
                }
                // Recreate publication authority only after OS authentication and
                // the active-scene/account/epoch checks have completed.
                let currentFence = NativePublicationFence(generation: generation)
                try checkPublication(currentFence)
                try await NativeLocalSigningOperation.$id.withValue(operationID) {
                    try await NativeLocalSigningOperation.$purpose.withValue(purpose) { try await work(currentFence, resumeTicket, transitionTicket) }
                }
            }
            catch is CancellationError {}
            catch NativeLocalAuthenticationIssue.cancelled { localAuthenticator.invalidate() }
            catch {
                if fence.permits(currentGeneration: workGeneration, cancelled: Task.isCancelled) {
                    if let quality = NativeFaceQualityFailure.from(error), retakeChallenge != nil {
                        faceQualityFailure = quality; retireSelfieReview(); stopFaceCameraPresentation()
                        navigation?.go(.faceQualityRetry, replace: true, simulateProgress: false)
                    } else {
                        if case NativeAPIError.denied(409, "operation_recovered_without_result") = error {
                            let owner = session?.accountID ?? audienceBinding?.accountID
                            retireAccountPresentation()
                            await repository?.retireMedia()
                            let latest = try? await repository?.protectedJSON("/privacy/center")
                            guard fence.permits(currentGeneration: workGeneration, cancelled: Task.isCancelled), isForeground,
                                  owner == (session?.accountID ?? audienceBinding?.accountID) else { return }
                            if let latest { privacy = latest }
                        }
                        if Self.isAudienceError(error) {
                            let currentWeakBinding = await repository?.audienceSessionBinding()
                            guard fence.permits(currentGeneration: workGeneration, cancelled: Task.isCancelled) else { return }
                            audience = nil; deviceAudienceNeeded = true; stopFaceCameraPresentation(); photoCamera = false; photoCameraContext = nil
                            if case NativeAPIError.denied(409, "audience_operation_recovered_without_result") = error {
                                deviceAudience = nil; deviceAudienceBinding = nil; audienceReviewPolicy = ""; audienceRenewalContinuation = nil
                                navigation?.go(.introduction, replace: true, simulateProgress: false)
                            }
                            retireAccountPresentation(preservingWeakState: canPreserveWeakPresentation(currentWeakBinding))
                        }
                        self.error = error.localizedDescription
                    }
                }
            }
            if fence.permits(currentGeneration: workGeneration, cancelled: Task.isCancelled), let repository {
                let nextSession = await repository.summary()
                let nextPending = await repository.pending()
                let nextGuest = await repository.guestDeletionSummary()
                let nextEnrollment = try? await repository.enrollmentSummary()
                let nextRecovery = try? await repository.accountRecoverySummary()
                let nextLifecycle = try? await repository.faceLifecycleSummary()
                let nextOrdinary = try? await repository.ordinaryLoginSummary()
                let nextAudienceBinding = await repository.audienceSessionBinding()
                let pendingAudienceMutation = (try? await repository.pendingAudienceMutation()) != nil
                let pendingDeviceRenewal = (try? await repository.pendingAudienceDeviceRenewal()) == true
                let pendingAudience = pendingAudienceMutation || pendingDeviceRenewal
                let savedAudienceDevice = (try? await repository.device()) != nil
                let currentDeviceBinding: NativeAudienceSessionBinding?
                if let deviceAudience { currentDeviceBinding = try? await repository.audienceDeviceBinding(deviceAudience) }
                else { currentDeviceBinding = nil }
                let retainedCapture = try? await repository.retainedFaceCaptureContext()
                let finalAudienceBinding = await repository.audienceSessionBinding()
                guard fence.permits(currentGeneration: workGeneration, cancelled: Task.isCancelled) else { return }
                guard finalAudienceBinding == nextAudienceBinding,
                      nextSession == nil || nextSession?.accountID == nextAudienceBinding?.accountID && nextSession?.epoch == nextAudienceBinding?.epoch else {
                    retireSelfieReview(); retireAccountPresentation()
                    audience = nil; audienceSessionEpoch = nil; audienceBinding = nil; session = nil
                    return
                }
                hasSavedAudienceDevice = savedAudienceDevice
                if currentDeviceBinding != deviceAudienceBinding { deviceAudience = nil; deviceAudienceBinding = nil; audienceReviewPolicy = "" }
                let preserveWeakPresentation = canPreserveWeakPresentation(nextAudienceBinding)
                let weakBindingChanged = audienceBinding != nextAudienceBinding
                if weakBindingChanged || session != nil && (nextSession == nil || nextSession?.accountID != session?.accountID) {
                    retireSelfieReview(); retireAccountPresentation(preservingWeakState: preserveWeakPresentation)
                }
                audiencePendingMutation = pendingAudience
                if nextAudienceBinding?.accountID != audience?.accountID || nextAudienceBinding?.epoch != audienceSessionEpoch { audience = nil; audienceSessionEpoch = nil }
                audienceBinding = nextAudienceBinding
                hasPendingOperation = !nextPending.isEmpty; hasPendingPrivacyOperation = nextPending.contains { $0.path?.hasPrefix("/privacy/") == true || $0.path?.hasPrefix("/privacy-exports/") == true }; session = nextSession; guestDeletion = nextGuest; enrollment = nextEnrollment; accountRecovery = nextRecovery; faceLifecycle = nextLifecycle; ordinaryLogin = nextOrdinary
                if captureNeedsStatus && retakeChallenge == nil { retakeChallenge = retainedCapture }
                if nextGuest == nil, nextRecovery == nil, let nextLifecycle {
                    challenge = nextLifecycle.challenge; captureReceipts = nextLifecycle.receipts
                    if !nextLifecycle.authenticated {
                        retireAccountPresentation(preservingWeakState: preserveWeakPresentation)
                        if let currentScreen = navigation?.screen, ![.faceEnrollment, .processing, .faceQualityRetry, .privacy, .exportData, .security].contains(currentScreen) {
                            navigation?.go(.faceManagement, replace: true, simulateProgress: false)
                        }
                    }
                } else if nextGuest == nil, let nextRecovery {
                    challenge = nextRecovery.awaitingServer ? nil : nextRecovery.challenge; captureReceipts = nextRecovery.receipts
                } else if nextGuest == nil, let nextEnrollment {
                    policy = nextEnrollment.policy; acceptedAuthPolicy = nextEnrollment.policy; authConsent = true
                    challenge = nextEnrollment.requiresCheck ? nil : nextEnrollment.challenge; captureReceipts = nextEnrollment.receipts
                } else if nextGuest == nil, let nextOrdinary {
                    retakeChallenge = nextOrdinary.challenge; faceQualityFailure = nextOrdinary.terminalQuality
                    captureNeedsStatus = nextOrdinary.awaitingServer || nextOrdinary.canRetry
                    challenge = captureNeedsStatus ? nil : nextOrdinary.challenge; captureReceipts = nextOrdinary.receipts
                }
                if guestDeletion != nil {
                    retireGuestPresentation()
                    navigation?.go(.privacy, replace: true, simulateProgress: false)
                }
            }
        }
    }
    private func authorizeLocalSigning(_ request: NativeLocalAuthenticationBinding, repository: BackendRepository,
                                       fence: NativePublicationFence) async throws -> NativeLocalSigningLease {
        localAuthenticationOperation = request.operationID; localAuthenticationPending = true
        let lease = try await localAuthenticator.authorize(request)
        do {
            // The expected OS-sheet inactive phase still retires camera/media.
            for _ in 0..<80 {
                if isForeground { break }
                try checkPublication(fence); try await Task.sleep(for: .milliseconds(25))
            }
            guard isForeground, localAuthenticationOperation == request.operationID else { throw NativeLocalAuthenticationIssue.cancelled }
            try checkPublication(fence); try await repository.installLocalSigning(lease); try checkPublication(fence)
            localSigningLease = lease; localAuthenticationPending = false; return lease
        } catch { lease.invalidate(); throw error }
    }
    func connect() {
        retireSharedFile()
        performGuarded(localSigning: .connect) { [self] fence in
            await NativeBackgroundUploads.shared.stop()
            try checkPublication(fence)
            if repository == nil { repository = try NativeBackgroundUploads.shared.repository() }
            NativeImport.removeAll()
            if let retained = try await repository!.registeredDeletionReceipt() {
                try checkPublication(fence)
                registeredDeletion = retained; connected = true; navigation?.go(.privacy, replace: true, simulateProgress: false)
                let checked = try await repository!.checkRegisteredDeletion()
                try checkPublication(fence); registeredDeletion = checked; return
            }
            let savedAudienceDevice = (try await repository!.device()) != nil
            try checkPublication(fence); hasSavedAudienceDevice = savedAudienceDevice
            _ = try await repository!.bootstrap()
            let restoredGuest = await repository!.guestDeletionSummary()
            let restoredSession = await repository!.summary()
            let restoredEnrollment = try await repository!.enrollmentSummary()
            let restoredRecovery = try await repository!.accountRecoverySummary()
            let restoredLifecycle = try await repository!.faceLifecycleSummary()
            let restoredOrdinary = try await repository!.ordinaryLoginSummary()
            let retainedCapture = try await repository!.retainedFaceCaptureContext()
            try checkPublication(fence)
            session = restoredSession; guestDeletion = restoredGuest; enrollment = restoredEnrollment; accountRecovery = restoredRecovery; faceLifecycle = restoredLifecycle; ordinaryLogin = restoredOrdinary; connected = true
            let restoredAudienceBinding = await repository!.audienceSessionBinding()
            try checkPublication(fence)
            if audienceBinding != restoredAudienceBinding {
                retireSelfieReview(); retireAccountPresentation(); audience = nil; audienceSessionEpoch = nil
            }
            audienceBinding = restoredAudienceBinding
            if restoredAudienceBinding != nil { let currentAudience = try await repository!.audience(); try checkPublication(fence); try await installAudience(currentAudience, fence: fence) }
            let restoredAudienceMutation = (try await repository!.pendingAudienceMutation()) != nil
            let restoredDeviceRenewal = try await repository!.pendingAudienceDeviceRenewal()
            let restoredAudiencePending = restoredAudienceMutation || restoredDeviceRenewal
            try checkPublication(fence); audiencePendingMutation = restoredAudiencePending
            if hasRegisteredPrivacyIdentity {
                let restoredClaim = try? await repository!.retainedGuardianClaim()
                try checkPublication(fence); guardianClaim = restoredClaim
            }
            if retainedCapture != nil { retakeChallenge = retainedCapture; captureNeedsStatus = restoredLifecycle?.challenge == nil && restoredLifecycle != nil || restoredEnrollment?.awaitingServer == true || restoredRecovery?.awaitingServer == true || restoredOrdinary?.awaitingServer == true }
            if guestDeletion != nil {
                retireGuestPresentation(); navigation?.go(.privacy, replace: true, simulateProgress: false)
                let checked = try await repository!.checkGuestDeletion()
                try checkPublication(fence); guestDeletion = checked
            }
            else if audiencePendingMutation || audienceBinding != nil && !audienceEligible {
                stopFaceCameraPresentation(); retireAccountPresentation(); navigation?.go(.introduction, replace: true, simulateProgress: false)
            }
            else if let restoredLifecycle, restoredRecovery == nil {
                challenge = restoredLifecycle.challenge; captureReceipts = restoredLifecycle.receipts
                if restoredLifecycle.authenticated { try await refreshGallery(); try checkPublication(fence); navigation?.go(.home, replace: true, simulateProgress: false) }
                else { retireAccountPresentation(); navigation?.go(.faceManagement, replace: true, simulateProgress: false) }
            }
            else if let restoredRecovery { challenge = restoredRecovery.awaitingServer ? nil : restoredRecovery.challenge; captureReceipts = restoredRecovery.receipts; navigation?.go(.faceEnrollment, replace: true, simulateProgress: false) }
            else if session?.authenticated == true { try await refreshGallery(); try checkPublication(fence); try await restorePhotoUploads(); try checkPublication(fence); navigation?.go(restoredDestination ?? .home, replace: true, simulateProgress: false) }
            else if let restoredEnrollment {
                policy = restoredEnrollment.policy; acceptedAuthPolicy = policy; authConsent = true
                challenge = restoredEnrollment.requiresCheck ? nil : restoredEnrollment.challenge; captureReceipts = restoredEnrollment.receipts
                navigation?.go(.faceEnrollment, replace: true, simulateProgress: false)
                if let challenge, !restoredEnrollment.awaitingServer, captureReceipts.count == challenge.poses.count { try await finishRecoveredEnrollment(challenge, receipts: captureReceipts, fence: fence) }
            }
            else if let restoredOrdinary {
                retakeChallenge = restoredOrdinary.challenge; faceQualityFailure = restoredOrdinary.terminalQuality
                captureNeedsStatus = restoredOrdinary.awaitingServer || restoredOrdinary.canRetry
                challenge = captureNeedsStatus ? nil : restoredOrdinary.challenge; captureReceipts = restoredOrdinary.receipts
                navigation?.go(restoredOrdinary.terminalQuality == nil ? .faceEnrollment : .faceQualityRetry, replace: true, simulateProgress: false)
            }
            else {
                let knownDevice = try await repository!.device()
                try checkPublication(fence)
                if knownDevice != nil { navigation?.go(.faceEnrollment, replace: true, simulateProgress: false) }
            }
        }
    }
    private var isWeakPrivacyScreen: Bool {
        guard let screen = navigation?.screen else { return false }
        return [.privacy, .exportData, .security].contains(screen)
    }
    private func canPreserveWeakPresentation(_ nextBinding: NativeAudienceSessionBinding?) -> Bool {
        guard let nextBinding, nextBinding == audienceBinding else { return false }
        return isWeakPrivacyScreen
    }
    private func retireAccountPresentation(preservingWeakState: Bool = false) {
        processingConsent = false
        galleryReadSerial += 1; galleryReloadQueued = false; loadedGalleryQuery = nil
        inboxCursor = nil; outgoingCursor = nil; notificationCursor = nil; supportCursor = nil
        if !preservingWeakState { guardianClaim = nil; preferences = .object([:]); privacy = .object([:]); retainedPrivacyExports = []; devices = []; sessions = []; recoveryKey = nil }
        uploadTask?.cancel(); uploadPresentation += 1; uploadRunning = false; uploadRecovery = nil; uploadCaption = ""; uploadedIDs = []; processingStatuses = [:]
        photoImportContext = nil
        photoCamera = false; photoCameraContext = nil
        photos = []; currentPhoto = nil; currentPerson = nil; snapshot = nil; draft = nil; preview = nil; outcome = nil
        inbox = []; receipt = nil; name = ""
        notificationSettings = .object([:]); notifications = []; blockedPeople = []; favoriteIDs = []; outgoing = []; supportRequests = []; supportSubject = ""; supportDetails = ""; query = ""; libraryAccount = nil; savedReview = nil; savedReviewAssetIDs = []; lastLibraryScreen = nil; restoredDestination = nil; galleryAnchor = nil; nextCursor = nil; retireSharedFile(); NativePurchasesRetirement(); mediaRevision += 1
        recoveryBackup = nil; recoveryBackupSheet = false
    }
    private func retireGuestPresentation() {
        retireSelfieReview(); retireAccountPresentation(); stopFaceCameraPresentation(); challenge = nil; captureReceipts = []; lastSelfie = nil
        retakeChallenge = nil; faceQualityFailure = nil; captureNeedsStatus = false
        authConsent = false; acceptedAuthPolicy = ""; policy = ""; processingConsent = false
        enrollment = nil; faceLifecycle = nil
        accountRecovery = nil; accountRecoverySheet = false
        imports = []; selectedImports = []; NativeImport.removeAll(); photoCamera = false
        uploadedIDs = []; processingStatuses = [:]; transferText = ""; pendingReceiptID = nil; galleryAnchor = nil; nextCursor = nil
    }
    func synchronizeMediaSession(_ next: NativeSessionSummary?, expectedEpoch: Int?) -> Bool {
        guard session?.epoch == expectedEpoch else { return false }
        if session != nil && (next == nil || next?.accountID != session?.accountID) {
            retireSelfieReview(); retireAccountPresentation(); error = NativeAPIError.authenticationRequired.localizedDescription
        }
        session = next
        scheduleAudienceExpiry()
        return next?.authenticated == true
    }
    func mediaInstant() -> NativePrivateMediaInstant { privateMediaClock.read() }
    func mediaDeadline(_ approval: NativeAudienceProjection) throws -> NativePrivateMediaDeadline {
        guard let session, session.accountID == approval.accountID else { throw NativeAPIError.authenticationRequired }
        return NativePrivateMediaDeadline(created: privateMediaClock.read(), authorityExpiresAt:
            try approval.authorityExpiresAt(sessionExpiresAt: session.expiresAt, purpose: .faceAuthentication, now: privateMediaClock.read().wall))
    }
    private func scheduleAudienceExpiry() {
        audienceExpiryTask?.cancel(); audienceExpiryTask = nil; audienceDeadline = nil
        guard isForeground, let audience, let session, audience.accountID == session.accountID,
              let deadline = try? mediaDeadline(audience) else { return }
        audienceDeadline = deadline
        audienceExpiryTask = Task { [weak self] in
            do {
                while !Task.isCancelled, let self, self.audience == audience, self.session?.epoch == session.epoch {
                    let remaining = deadline.remaining(at: self.privateMediaClock.read())
                    if remaining <= 0 { self.expireAudienceAuthority(); return }
                    try await Task.sleep(for: .seconds(min(remaining, 60)))
                }
            } catch {}
        }
    }
    func expireAudienceAuthority() {
        expireSharedFiles()
        guard audienceDeadline?.remaining(at: privateMediaClock.read()) == 0 else { return }
        audienceExpiryTask?.cancel(); audienceExpiryTask = nil; audienceDeadline = nil
        audience = nil; audienceSessionEpoch = nil
        workTask?.cancel(); workGeneration += 1; busy = false
        stopFaceCameraPresentation(); retireAccountPresentation(preservingWeakState: isWeakPrivacyScreen)
        if let repository { Task { await repository.retireMedia() } }
    }
    func loadFacePolicy() { performGuarded { [self] fence in guard let repository else { return }; let value = try await repository.policy(); try checkPublication(fence); policy = value } }
    func acceptAuthConsent(_ enabled: Bool) { if !enabled { invalidateLocalAuthentication(); stopFaceCameraPresentation() }; authConsent = enabled; acceptedAuthPolicy = enabled ? policy : "" }
    func prepareFace(renewedAudienceAccount: String? = nil) {
        guard selfieReview == nil else { return }
        if faceLifecycle != nil, accountRecovery == nil { checkFaceProfile(); return }
        if accountRecovery != nil { checkAccountRecovery(); return }
        performGuarded(localSigning: .enrollment) { [self] fence in
            guard guestDeletion == nil else { throw NativeAPIError.unsupported(String(localized: "Check your guest account deletion before resuming setup.")) }
            guard let repository else { throw NativeAPIError.unavailable("configuration") }
            let currentPolicy = try await repository.policy()
            let knownDevice = try await repository.device()
            let retained = try await repository.hasEnrollmentIntent()
            let restored = try await repository.enrollmentSummary()
            try checkPublication(fence)
            guard (authConsent && acceptedAuthPolicy == currentPolicy) || (retained && restored?.policy == currentPolicy) || (session == nil && knownDevice != nil) || (renewedAudienceAccount != nil && renewedAudienceAccount == knownDevice?.accountID) else {
                authConsent = false
                throw NativeAPIError.unsupported(String(localized: "Read and accept the current face-registration policy before capturing."))
            }
            let value = try await repository.startFace(consentPolicy: currentPolicy, publicKey: DeviceIdentity.publicJWK(alias: knownDevice?.keyAlias ?? NativeEnrollmentRecord.keyAlias, createIfMissing: !retained && knownDevice == nil))
            let latest = try await repository.enrollmentSummary()
            let login = try await repository.ordinaryLoginSummary()
            try checkPublication(fence)
            policy = currentPolicy; challenge = value; enrollment = latest; ordinaryLogin = login; captureReceipts = latest?.receipts ?? login?.receipts ?? []; lastSelfie = nil
            if captureReceipts.count == value.poses.count { try await finishRecoveredEnrollment(value, receipts: captureReceipts, fence: fence) }
        }
    }
    func takeSelfie() {
        performGuarded { [self] fence in
            guard isForeground, selfieReview == nil, !captureNeedsStatus else { throw NativeCameraIssue.captureUnavailable }
            guard guestDeletion == nil else { throw NativeAPIError.unsupported(String(localized: "Check your guest account deletion before capturing.")) }
            guard let repository, let challenge else { throw NativeAPIError.unsupported(String(localized: "Accept face registration consent and start a current capture session first.")) }
            let shutter = NativeFaceShutterContext(challenge), captureIndex = captureReceipts.count
            let cameraGeneration = camera.currentState.generation, presentationGeneration = cameraReviewGeneration, sessionEpoch = session?.epoch
            try await repository.requireFaceAudience(challenge)
            try checkPublication(fence)
            var bytes = try await camera.capture(); defer { bytes.resetBytes(in: 0..<bytes.count) }
            try checkPublication(fence)
            guard isForeground, camera.currentState.generation == cameraGeneration,
                  cameraReviewGeneration == presentationGeneration, session?.epoch == sessionEpoch,
                  shutter.permits(self.challenge), captureReceipts.count == captureIndex else { throw NativeAPIError.sessionChanged }
            try await repository.requireFaceAudience(challenge)
            try checkPublication(fence)
            guard isForeground, camera.currentState.generation == cameraGeneration, cameraReviewGeneration == presentationGeneration,
                  session?.epoch == sessionEpoch, shutter.permits(self.challenge), captureReceipts.count == captureIndex else { throw NativeAPIError.sessionChanged }
            guard captureReceipts.reduce(0, { $0 + ($1["byte_size"].integer ?? 0) }) + bytes.count <= 8 * 1024 * 1024 else { throw NativeAPIError.unsupported(String(localized: "These captures exceed the 8 MiB enrollment limit. Start again with smaller camera captures.")) }
            guard let decoded = UIImage(data: bytes) else { throw NativeCameraIssue.invalidImage }
            selfieReview = try NativeSelfieCandidate(bytes: bytes, challenge: challenge, index: captureIndex,
                publicationGeneration: presentationGeneration, sessionEpoch: sessionEpoch, cameraGeneration: cameraGeneration)
            lastSelfie = decoded; faceQualityFailure = nil
        }
    }
    func useReviewedSelfie() {
        guard !busy, !captureNeedsStatus, var candidate = selfieReview else { return }
        do {
            try candidate.requireCurrent(challenge: challenge, receipts: captureReceipts, publicationGeneration: cameraReviewGeneration,
                sessionEpoch: session?.epoch, camera: camera.currentState, foreground: isForeground)
        } catch { retireSelfieReview(); self.error = error.localizedDescription; return }
        guard let challenge else { retireSelfieReview(); return }
        let shutter = NativeFaceShutterContext(challenge), captureIndex = candidate.index
        let cameraGeneration = candidate.cameraGeneration, sessionEpoch = candidate.sessionEpoch
        var bytes = candidate.bytes; candidate.retire(); retireSelfieReview()
        performGuarded(localSigning: .capture) { [self] fence in
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            guard let repository, guestDeletion == nil, isForeground, camera.currentState.generation == cameraGeneration,
                  shutter.permits(self.challenge), session?.epoch == sessionEpoch, captureReceipts.count == captureIndex else { throw NativeAPIError.sessionChanged }
            retakeChallenge = challenge
            captureNeedsStatus = true
            let value = try await repository.capture(bytes, index: captureIndex, challenge: challenge)
            try checkPublication(fence); guard isForeground, camera.currentState.generation == cameraGeneration,
                shutter.permits(self.challenge), session?.epoch == sessionEpoch, captureReceipts.count == captureIndex else { throw NativeAPIError.sessionChanged }; captureReceipts.append(value); captureNeedsStatus = false
            if captureReceipts.count == challenge.poses.count {
                navigation?.go(.processing, simulateProgress: false); stopFaceCameraPresentation()
                captureNeedsStatus = true
                let upgraded = try await repository.completeFace(challenge, captures: captureReceipts)
                let managed = try await repository.faceLifecycleSummary()
                try checkPublication(fence); session = upgraded; enrollment = nil
                faceLifecycle = managed; accountRecovery = nil
                retireSelfieReview(); retakeChallenge = nil; faceQualityFailure = nil; captureNeedsStatus = false; captureReceipts = []; self.challenge = nil
                navigation?.go(managed == nil ? .setupComplete : .faceManagement, replace: true, simulateProgress: false)
            }
        }
    }
    private func retireSelfieReview() {
        if var previous = selfieReview { previous.retire() }
        selfieReview = nil; lastSelfie = nil; cameraReviewGeneration += 1
    }
    func retakeReviewedSelfie() {
        guard !busy else { return }; retireSelfieReview()
        if !camera.ready { openFaceCamera() }
    }
    func cameraAuthorityChanged() {
        if let candidate = selfieReview, candidate.cameraGeneration != camera.currentState.generation || !camera.currentState.foreground || camera.currentState.permission != .authorized { retireSelfieReview() }
    }
    func leaveFaceCamera() {
        invalidateLocalAuthentication()
        retireSelfieReview(); stopFaceCameraPresentation(); workTask?.cancel(); workGeneration += 1; busy = false
        navigation?.back()
    }
    func stopFaceCameraPresentation() { audienceCaptureGeneration += 1; retireSelfieReview(); camera.stop() }
    func openFaceCamera() {
        guard !busy, isForeground, guestDeletion == nil, navigation?.screen == .faceEnrollment, selfieReview == nil else { return }
        guard let challenge else { prepareFace(); return }
        audienceCaptureGeneration += 1; let generation = audienceCaptureGeneration
        Task { [self] in
            do {
                guard let repository else { throw NativeAPIError.authenticationRequired }
                try await repository.requireFaceAudience(challenge)
                guard generation == audienceCaptureGeneration, self.challenge?.wire == challenge.wire, isForeground else { return }
                await camera.start(expiresAt: challenge.expiresAt) { [self] in
                    guard generation == audienceCaptureGeneration, self.challenge?.wire == challenge.wire, isForeground, navigation?.screen == .faceEnrollment else { throw NativeAPIError.sessionChanged }
                    try await repository.requireFaceAudience(challenge)
                    guard generation == audienceCaptureGeneration, self.challenge?.wire == challenge.wire, isForeground, navigation?.screen == .faceEnrollment else { throw NativeAPIError.sessionChanged }
                }
                guard generation == audienceCaptureGeneration, self.challenge?.wire == challenge.wire, isForeground else { camera.stop(); return }
                try await repository.requireFaceAudience(challenge)
                guard generation == audienceCaptureGeneration, self.challenge?.wire == challenge.wire, isForeground else { camera.stop(); return }
            } catch { if generation == audienceCaptureGeneration { stopFaceCameraPresentation(); self.error = error.localizedDescription } }
        }
    }
    func recoverCamera() { retireSelfieReview(); openFaceCamera() }
    func retakeRejectedSequence() {
        guard let previous = retakeChallenge else { checkCurrentFaceCapture(); return }
        let terminal = faceQualityFailure != nil
        retireSelfieReview(); stopFaceCameraPresentation()
        performGuarded(localSigning: .reconciliation) { [self] fence in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            let recovered = try await repository.prepareFaceRetake(previous, terminalQualityFailure: terminal)
            let current = await repository.summary(), nextEnrollment = try await repository.enrollmentSummary()
            let nextRecovery = try await repository.accountRecoverySummary(), nextLifecycle = try await repository.faceLifecycleSummary()
            let nextOrdinary = try await repository.ordinaryLoginSummary()
            try checkPublication(fence)
            session = current; enrollment = nextEnrollment; accountRecovery = nextRecovery; faceLifecycle = nextLifecycle; ordinaryLogin = nextOrdinary
            challenge = recovered.challenge; captureReceipts = recovered.receipts
            if current?.authenticated == true && recovered.challenge == nil {
                retakeChallenge = nil; faceQualityFailure = nil; captureNeedsStatus = false
                navigation?.go(nextLifecycle == nil ? .setupComplete : .faceManagement, replace: true, simulateProgress: false); return
            }
            if recovered.awaitingServer {
                captureNeedsStatus = true
                transferText = String(localized: "The original capture result is not confirmed. Check the saved request before taking another selfie.")
                navigation?.go(.processing, replace: true, simulateProgress: false); return
            }
            guard recovered.challenge != nil else { throw NativeAPIError.operationUnconfirmed(previous.id) }
            retakeChallenge = nil; faceQualityFailure = nil; captureNeedsStatus = false
            navigation?.go(.faceEnrollment, replace: true, simulateProgress: false)
            if let challenge = recovered.challenge, recovered.receipts.count == challenge.poses.count {
                retakeChallenge = challenge; captureNeedsStatus = true; stopFaceCameraPresentation()
                navigation?.go(.processing, replace: true, simulateProgress: false)
                let upgraded = try await repository.completeFace(challenge, captures: recovered.receipts)
                let managed = try await repository.faceLifecycleSummary(); try checkPublication(fence)
                session = upgraded; enrollment = nil; accountRecovery = nil; faceLifecycle = managed
                self.challenge = nil; captureReceipts = []; retakeChallenge = nil; captureNeedsStatus = false
                navigation?.go(managed == nil ? .setupComplete : .faceManagement, replace: true, simulateProgress: false)
            }
        }
    }
    private func checkCurrentFaceCapture() {
        if faceLifecycle != nil, accountRecovery == nil { checkFaceProfile() }
        else if accountRecovery != nil { checkAccountRecovery() }
        else if enrollment != nil { checkEnrollment() }
        else { prepareFace() }
    }
    func checkEnrollment() {
        if captureNeedsStatus && retakeChallenge != nil { retakeRejectedSequence(); return }
        performGuarded(localSigning: .reconciliation) { [self] fence in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            let recovered = try await repository.recoverEnrollment()
            let current = await repository.summary()
            try checkPublication(fence)
            if current?.authenticated == true {
                session = current; enrollment = nil; challenge = nil; captureReceipts = []; lastSelfie = nil
                navigation?.go(.setupComplete, replace: true, simulateProgress: false); return
            }
            if recovered.awaitingServer {
                enrollment = recovered; challenge = nil; captureReceipts = recovered.receipts
                transferText = String(localized: "Enrollment is still processing. Check again before capturing."); return
            }
            let value = try await repository.startFace(consentPolicy: recovered.policy, publicKey: DeviceIdentity.publicJWK(createIfMissing: false))
            let latest = try await repository.enrollmentSummary()
            try checkPublication(fence)
            enrollment = latest; policy = recovered.policy; acceptedAuthPolicy = policy; authConsent = true
            challenge = value; captureReceipts = latest?.receipts ?? []; lastSelfie = nil
            navigation?.go(.faceEnrollment, replace: true, simulateProgress: false)
            if captureReceipts.count == value.poses.count { try await finishRecoveredEnrollment(value, receipts: captureReceipts, fence: fence) }
        }
    }
    private func finishRecoveredEnrollment(_ challenge: NativeFaceChallenge, receipts: [WireValue], fence: NativePublicationFence) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }
        try checkPublication(fence); stopFaceCameraPresentation(); navigation?.go(.processing, simulateProgress: false)
        let recovered = try await repository.completeFace(challenge, captures: receipts)
        try checkPublication(fence); session = recovered; enrollment = nil; self.challenge = nil; captureReceipts = []; lastSelfie = nil
        navigation?.go(.setupComplete, replace: true, simulateProgress: false)
    }
    func restartFace() {
        if retakeChallenge != nil { retakeRejectedSequence(); return }
        retireSelfieReview(); stopFaceCameraPresentation(); navigation?.go(.faceEnrollment, simulateProgress: false); checkCurrentFaceCapture()
    }
    func refreshGallery(loadMore: Bool = false) async throws {
        guard let repository, session?.authenticated == true else { throw NativeAPIError.authenticationRequired }
        let fence = publicationFence(), owner = privateReadOwner()
        try await restoreLibraryState()
        try checkPrivatePublication(owner, fence: fence)
        let identity = currentGalleryQuery
        let append = loadMore && loadedGalleryQuery == identity
        galleryReadSerial += 1; let serial = galleryReadSerial
        let loaded: [NativePhoto], cursor: WireValue?
        if let favorites = identity.favorites {
            let offset = append ? nextCursor?["favorite_offset"].integer ?? 0 : 0
            guard offset <= favorites.count else { throw NativeAPIError.invalidResponse }
            let ids = Array(favorites.dropFirst(offset).prefix(100))
            loaded = try await repository.photosByID(ids, source: identity.source)
            cursor = offset + ids.count < favorites.count ? .object(["favorite_offset": .integer(offset + ids.count)]) : nil
        } else {
            let value = try await repository.photos(source: identity.source, cursor: append ? nextCursor : nil, query: identity.query, category: identity.category)
            guard let rows = value["items"].array else { throw NativeAPIError.invalidResponse }
            loaded = try rows.map(NativePhoto.init); cursor = value["next_cursor"] == .null ? nil : value["next_cursor"]
        }
        try checkPrivatePublication(owner, fence: fence)
        guard serial == galleryReadSerial, currentGalleryQuery == identity else { throw CancellationError() }
        let current = try await repository.current()
        let nextPreferences = try await repository.protectedJSON("/me/photo-preferences")
        try checkPrivatePublication(owner, fence: fence)
        guard serial == galleryReadSerial, currentGalleryQuery == identity else { throw CancellationError() }
        if append { var seen = Set(photos.map(\.id)); photos += loaded.filter { seen.insert($0.id).inserted } } else { photos = loaded }
        loadedGalleryQuery = identity; nextCursor = cursor; name = current["name"].string ?? ""; preferences = nextPreferences
    }
    private var currentGalleryQuery: NativeGalleryQuery {
        .init(source: gallerySource, query: query, category: galleryCategory, favorites: lastLibraryScreen == .favorites ? favoriteIDs.sorted() : nil)
    }
    private func dispatchQueuedGalleryReload() {
        guard galleryReloadQueued, !busy, isForeground, session?.authenticated == true else { return }
        galleryReloadQueued = false
        performGuarded { [self] _ in try await refreshGallery() }
    }
    func reloadPhotos() { galleryReloadQueued = true; dispatchQueuedGalleryReload() }
    func loadMore() { guard nextCursor != nil else { return }; performGuarded { [self] fence in try await refreshGallery(loadMore: true) } }
    var hasMorePhotos: Bool { nextCursor != nil && loadedGalleryQuery == currentGalleryQuery }
    func openPhoto(_ photo: NativePhoto) { galleryAnchor = photo.id; persistLibraryState(); currentPhoto = photo; navigation?.go(.photoViewer, simulateProgress: false) }
    func beginReview(photoIDs: [String]? = nil, source: String = "personal", destination: Screen = .shareSelection) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner()
            let value = try await repository.snapshot(assetIDs: photoIDs, source: source)
            try checkPrivatePublication(owner, fence: fence)
            var revised = NativeShareDraft(snapshot: value); revised.selectedPeople.subtract(blockedPersonIDs)
            if let savedReview, savedReviewAssetIDs == value.photos.map(\.id).sorted() {
                revised.selectedPhotos.formIntersection(savedReview.selectedPhotos)
                revised.selectedPeople.formIntersection(savedReview.selectedPeople)
                revised.excludedPairs = savedReview.excludedPairs.intersection(value.pairs)
                revised.version = savedReview.version + 1
            }
            snapshot = value; draft = revised; preview = nil; persistLibraryState()
            navigation?.go(destination, simulateProgress: false)
        }
    }
    func edit(_ body: (inout NativeShareDraft) -> Void) {
        guard canEdit, var value = draft else { return }; body(&value); value.selectedPeople.subtract(blockedPersonIDs); value.version += 1; draft = value; preview = nil; persistLibraryState()
    }
    func togglePhoto(_ id: String) { edit { if !$0.selectedPhotos.insert(id).inserted { $0.selectedPhotos.remove(id) } } }
    func togglePerson(_ id: String) { guard !blockedPersonIDs.contains(id) else { return }; edit { if !$0.selectedPeople.insert(id).inserted { $0.selectedPeople.remove(id) } } }
    func togglePair(photo: String, person: String) { guard !blockedPersonIDs.contains(person) else { return }; let pair = NativePair(asset: photo, recipient: person); edit { if !$0.excludedPairs.insert(pair).inserted { $0.excludedPairs.remove(pair) } } }
    func prepareReview() {
        performGuarded { [self] fence in
            guard let repository, let snapshot, let draft else { throw NativeAPIError.selectionEmpty }
            let owner = privateReadOwner(), value = try await repository.previewShare(snapshot, draft: draft)
            try checkPrivatePublication(owner, fence: fence); preview = value; navigation?.go(.shareReview, simulateProgress: false)
        }
    }
    func refreshReview() {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner()
            let old = draft, current = try await repository.snapshot(assetIDs: snapshot?.photos.map(\.id), source: snapshot?.source ?? "personal"); var revised = NativeShareDraft(snapshot: current)
            try checkPrivatePublication(owner, fence: fence)
            if let old {
                revised.selectedPhotos.formIntersection(old.selectedPhotos); revised.selectedPeople.formIntersection(old.selectedPeople)
                revised.excludedPairs = old.excludedPairs.intersection(current.pairs); revised.version = old.version + 1
            }
            revised.selectedPeople.subtract(blockedPersonIDs)
            snapshot = current; draft = revised; preview = nil; navigation?.go(.shareSelection, simulateProgress: false)
        }
    }
    func share() {
        performGuarded { [self] fence in
            guard let repository, let preview, let snapshot, let draft else { throw NativeAPIError.reviewChanged }
            let owner = privateReadOwner()
            navigation?.go(.sharingProgress, simulateProgress: false)
            let value = try await repository.commit(preview, snapshot: snapshot, draft: draft)
            try checkPrivatePublication(owner, fence: fence); outcome = value
            if outcome?["status"].string == "changed" { self.preview = nil; throw NativeAPIError.reviewChanged }
            savedReview = nil; savedReviewAssetIDs = []; persistLibraryState(); navigation?.go(.sharedHistory, replace: true, simulateProgress: false); try await loadInbox(); try await loadOutgoing()
        }
    }
    func reconcile(retry: Bool = false) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner()
            let value = try await repository.reconcile(retryUnknown: retry)
            try checkPrivatePublication(owner, fence: fence)
            if value["status"].string == "unknown" { throw NativeAPIError.unsupported(String(localized: "The original request is still unconfirmed. Retry reuses its original key and exact selection.")) }
            if value["status"].string == "ready", value["snapshot"] != .null { let loaded = try NativeSnapshot(value); snapshot = loaded; draft = NativeShareDraft(snapshot: loaded); navigation?.go(.shareSelection, simulateProgress: false) }
            else if value["recipients"] != .null { outcome = value; navigation?.go(.sharedHistory, simulateProgress: false) }
            else { outcome = value; transferText = String(localized: "Original request confirmed.") }
        }
    }
    private func photoCollectionFailed(_ error: Error, account: String, epoch: Int, generation: Int) async {
        let currentBinding = await repository?.audienceSessionBinding()
        guard !Task.isCancelled, generation == workGeneration, session?.accountID == account, session?.epoch == epoch else { return }
        let preserveWeak = canPreserveWeakPresentation(currentBinding)
        audience = nil; audienceSessionEpoch = nil
        retireAccountPresentation(preservingWeakState: preserveWeak)
        if currentBinding?.accountID == account, currentBinding?.epoch == epoch { audienceBinding = currentBinding }
        else { audienceBinding = nil; session = nil }
        self.error = error.localizedDescription
    }
    func beginPhotoImport() async -> NativeMediaCaptureContext? {
        guard canEdit, isForeground, guestDeletion == nil, let repository, let session, session.authenticated, session.expiresAt > Date() else { return nil }
        workTask?.cancel(); workGeneration += 1
        let generation = workGeneration
        do {
            let current = try await repository.requirePhotoCollection()
            guard !busy, isForeground, generation == workGeneration, self.session?.epoch == session.epoch,
                  self.session?.accountID == session.accountID, current.accountID == session.accountID else { return nil }
            let binding = await repository.audienceSessionBinding()
            guard !Task.isCancelled, generation == workGeneration, self.session?.epoch == session.epoch, binding?.epoch == session.epoch, binding?.accountID == session.accountID, isForeground else { return nil }
            audience = current; audienceSessionEpoch = session.epoch; audienceBinding = binding
            return NativeMediaCaptureContext(accountID: session.accountID, sessionEpoch: session.epoch, publicationGeneration: generation, expiresAt: session.expiresAt)
        } catch { await photoCollectionFailed(error, account: session.accountID, epoch: session.epoch, generation: generation); return nil }
    }
    func photoImportIsCurrent(_ request: NativeMediaCaptureContext) -> Bool {
        guestDeletion == nil && audienceEligible && !Task.isCancelled && request.permits(session, generation: workGeneration, foreground: isForeground)
    }
    func verifyPhotoImport(_ request: NativeMediaCaptureContext) async -> Bool {
        do { try await requirePhotoImport(request); return true } catch { return false }
    }
    private func requirePhotoImport(_ request: NativeMediaCaptureContext) async throws {
        do {
            guard photoImportIsCurrent(request), let repository else { throw NativeAPIError.sessionChanged }
            let currentAudience = try await repository.requirePhotoCollection(expectedOwner: request)
            let backendSession = await repository.summary()
            guard currentAudience.accountID == request.accountID else { throw NativeAPIError.sessionChanged }
            let binding = await repository.audienceSessionBinding()
            guard !Task.isCancelled, request.ownsSession(backendSession), request.ownsSession(session), binding?.epoch == request.sessionEpoch, binding?.accountID == request.accountID, request.permits(session, generation: workGeneration, foreground: isForeground) else { throw NativeAPIError.sessionChanged }
            audience = currentAudience; audienceSessionEpoch = backendSession?.epoch; audienceBinding = binding
            guard photoImportIsCurrent(request), request.ownsSession(backendSession) else { throw NativeAPIError.sessionChanged }
        } catch {
            await photoCollectionFailed(error, account: request.accountID, epoch: request.sessionEpoch, generation: request.publicationGeneration)
            throw error
        }
    }
    private func acceptedPhotoImport(_ request: NativeMediaCaptureContext, fence: NativePublicationFence) -> NativeMediaCaptureContext {
        NativeMediaCaptureContext(accountID: request.accountID, sessionEpoch: request.sessionEpoch, publicationGeneration: fence.generation, expiresAt: request.expiresAt)
    }
    func acceptImports(_ items: [NativeImport], failure: String?, request: NativeMediaCaptureContext, pickerContext: String? = nil) {
        guard !busy, photoImportIsCurrent(request) else {
            for item in items { NativeImport.removeCameraItem(item) }; return
        }
        performGuarded { [self] fence in
            try await persistPhotoImports(items, failure: failure, request: acceptedPhotoImport(request, fence: fence), pickerContext: pickerContext)
            try checkPublication(fence)
        }
    }
    func acceptFileImports(_ urls: [URL], request: NativeMediaCaptureContext, pickerContext: String) {
        guard !urls.isEmpty, !busy, photoImportIsCurrent(request) else { return }
        performGuarded { [self] fence in
            let accepted = acceptedPhotoImport(request, fence: fence)
            var items: [NativeImport] = []
            defer { for item in items { NativeImport.removeCameraItem(item) } }
            for url in urls.prefix(30) {
                try await requirePhotoImport(accepted)
                let item = try await Task.detached(priority: .userInitiated) {
                    let allowed = url.startAccessingSecurityScopedResource()
                    defer { if allowed { url.stopAccessingSecurityScopedResource() } }
                    let data = try Data(contentsOf: url, options: .mappedIfSafe)
                    return try NativeImport.store(data)
                }.value
                items.append(item)
                try await requirePhotoImport(accepted)
            }
            try await persistPhotoImports(items, failure: nil, request: accepted, pickerContext: pickerContext)
            try checkPublication(fence)
        }
    }
    private func persistPhotoImports(_ items: [NativeImport], failure: String?, request: NativeMediaCaptureContext, pickerContext: String? = nil) async throws {
        defer { for item in items { NativeImport.removeCameraItem(item) } }
        try await requirePhotoImport(request)
        guard !items.isEmpty, let repository else { error = failure; return }
        let next: NativeUploadSummary
        do { next = try await repository.stagePhotoUpload(items.map { NativeUploadSource(id: $0.id, file: $0.file, title: $0.title, width: $0.width, height: $0.height) }, expectedOwner: request) }
        catch { await photoCollectionFailed(error, account: request.accountID, epoch: request.sessionEpoch, generation: request.publicationGeneration); throw error }
        try await requirePhotoImport(request)
        guard next.batch.accountID == request.accountID else { throw NativeAPIError.sessionChanged }
        installPhotoUploads(next); photoImportContext = pickerContext; error = failure
        navigation?.go(.uploadSelection, simulateProgress: false)
    }
    private func installPhotoUploads(_ value: NativeUploadSummary) {
        guard session?.authenticated == true, value.batch.accountID == session?.accountID else { return }
        if uploadRecovery?.batch.id != value.batch.id { photoImportContext = nil }
        uploadRecovery = value; uploadCaption = value.batch.caption
        imports = value.sources.map { NativeImport(id: $0.id, file: $0.file, title: $0.title, width: $0.width, height: $0.height) }
        selectedImports = Set(value.batch.selectedFiles.map(\.id)); uploadedIDs = value.uploadedIDs
        processingStatuses = Dictionary(uniqueKeysWithValues: value.batch.selectedFiles.compactMap { item -> (String, String)? in
            guard let id = item.assetID, item.received else { return nil }; return (id, item.phase.rawValue)
        })
        transferText = value.batch.cancellationRequested && value.batch.finished ? String(localized: "Pending uploads cancelled.") : value.batch.received ? String(localized: "Uploads received. Photo matching is separate from sharing.") : String.localizedStringWithFormat(NSLocalizedString("controller_bytes_received", comment: ""), value.batch.acknowledgedBytes, value.batch.totalBytes)
    }
    func restorePhotoUploads() async throws {
        let permit = publicationPermit()
        guard let repository, let value = try await repository.uploadSummary(), value.batch.accountID == session?.accountID else { return }
        try checkPublication(permit)
        installPhotoUploads(value)
    }
    func showPhotoUploads() {
        guard let value = uploadRecovery else { return }
        navigation?.go(value.batch.started ? (value.batch.received ? .uploadComplete : .uploadProgress) : .uploadSelection, simulateProgress: false)
    }
    func toggleUploadPhoto(_ id: String) {
        guard let recovery = uploadRecovery, !recovery.batch.started, !uploadRunning else { return }
        if !selectedImports.insert(id).inserted { selectedImports.remove(id) }; persistUploadDraft()
    }
    func updateUploadCaption(_ value: String) {
        guard uploadRecovery?.batch.started == false else { return }
        var bounded = String(value.prefix(500)); while bounded.utf16.count > 500 { bounded.removeLast() }; uploadCaption = bounded; persistUploadDraft()
    }
    private func persistUploadDraft() {
        guard let repository, let value = uploadRecovery, !value.batch.started else { return }
        let selected = selectedImports, caption = uploadCaption, account = value.batch.accountID
        Task { [self] in
            do {
                let updated = try await repository.editPhotoUpload(batchID: value.batch.id, selected: selected, caption: caption)
                if session?.accountID == account, selectedImports == selected, uploadCaption == caption { installPhotoUploads(updated) }
            } catch { if session?.accountID == account { self.error = error.localizedDescription } }
        }
    }
    func upload() {
        guard let repository, let value = uploadRecovery, !selectedImports.isEmpty, !uploadRunning, !busy else { return }
        let batch = value.batch.id, account = value.batch.accountID
        uploadPresentation += 1; let presentation = uploadPresentation
        uploadRunning = true; busy = true; error = nil
        navigation?.go(.uploadProgress, simulateProgress: false)
        uploadTask = Task { [self] in
            defer { if uploadPresentation == presentation { uploadRunning = false; busy = false } }
            do {
                if !value.batch.started { _ = try await repository.editPhotoUpload(batchID: batch, selected: selectedImports, caption: uploadCaption) }
                if processingConsent {
                    let updated = try await repository.post("/me/photo-preferences", payload: .object(["processing_consent": .bool(true), "policy_version": .string(try preferences.text("policy_version"))]), operation: "photo.preferences")
                    guard uploadPresentation == presentation, session?.accountID == account else { throw NativeAPIError.sessionChanged }
                    try Task.checkCancellation(); preferences = updated
                }
                guard uploadPresentation == presentation, session?.accountID == account else { throw NativeAPIError.sessionChanged }
                try Task.checkCancellation()
                try await repository.allowBackgroundUpload(batchID: batch)
                let final = try await repository.resumePhotoUpload(batchID: batch) { [weak self] progress in
                    await MainActor.run {
                        guard let self, self.uploadPresentation == presentation, self.session?.accountID == account else { return }
                        self.installPhotoUploads(progress)
                    }
                }
                guard uploadPresentation == presentation, session?.accountID == account else { return }
                installPhotoUploads(final)
                if final.batch.received { navigation?.go(.uploadComplete, replace: true, simulateProgress: false) }
            } catch is CancellationError {}
            catch {
                guard uploadPresentation == presentation, session?.accountID == account else { return }
                self.error = error.localizedDescription
                if let summary = try? await repository.uploadSummary(batchID: batch) { installPhotoUploads(summary) }
                hasPendingOperation = !(await repository.pending()).isEmpty
                if await repository.summary() == nil { retireAccountPresentation(); session = nil; navigation?.go(.faceEnrollment, replace: true, simulateProgress: false) }
            }
        }
    }
    func pausePhotoUploads(userInitiated: Bool = true, scheduleRetry: Bool = false) {
        guard let repository, let current = uploadRecovery else { return }
        uploadTask?.cancel(); uploadPresentation += 1; uploadRunning = false; busy = false
        if userInitiated { NativeBackgroundUploads.shared.cancelScheduled() }
        Task { [self] in
            do {
                let next = try await repository.pausePhotoUpload(batchID: current.batch.id, disableAutomaticRetry: userInitiated)
                if session?.accountID == current.batch.accountID { installPhotoUploads(next); transferText = String(localized: "Paused. Received bytes and the original upload are saved.") }
                if scheduleRetry && next.batch.canRetryInBackground { NativeBackgroundUploads.shared.schedule() }
            }
            catch { if session?.accountID == current.batch.accountID { self.error = error.localizedDescription } }
        }
    }
    func cancelPhotoUploads() {
        guard let repository, let current = uploadRecovery else { return }
        pausePhotoUploads()
        performGuarded { [self] fence in let owner = privateReadOwner(); let next = try await repository.cancelPhotoUpload(batchID: current.batch.id); try checkPrivatePublication(owner, fence: fence); installPhotoUploads(next); transferText = String(localized: "Pending uploads cancelled. Photos already processing remain in your library.") }
    }
    func checkProcessing() {
        performGuarded { [self] fence in
            guard let repository, let value = uploadRecovery else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner(), current = try await repository.checkPhotoUpload(batchID: value.batch.id)
            try checkPrivatePublication(owner, fence: fence); installPhotoUploads(current)
            if current.batch.selectedFiles.allSatisfy({ $0.phase == .ready || $0.phase == .cancelled }) { transferText = String(localized: "Photo processing complete."); try await refreshGallery() }
        }
    }
    func retryUploadPhoto(_ id: String) {
        performGuarded { [self] fence in
            guard let repository, let current = uploadRecovery else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner(), updated = try await repository.retryPhotoProcessing(batchID: current.batch.id, fileID: id)
            try checkPrivatePublication(owner, fence: fence); installPhotoUploads(updated)
        }
    }
    func loadInbox(loadMore: Bool = false) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }
        let fence = publicationFence(), owner = privateReadOwner(), cursor = loadMore ? inboxCursor : nil
        if loadMore && cursor == nil { return }
        var payload: [String: WireValue] = ["limit": .integer(25)]; if let cursor { payload["cursor"] = .string(cursor) }
        let page = try NativeAccountPage(await repository.community("inbox", payload: .object(payload)), personalOnly: true)
        try checkPrivatePublication(owner, fence: fence)
        guard !loadMore || inboxCursor == cursor else { throw CancellationError() }
        inbox = loadMore ? page.appending(to: inbox) : page.items; inboxCursor = page.nextCursor
    }
    func refreshInbox(loadMore: Bool = false) { performGuarded { [self] _ in try await loadInbox(loadMore: loadMore) } }
    func openReceipt(_ id: String) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner()
            let value = try await repository.community("receipt", payload: .object(["request_id": .string(id)]))
            try checkPrivatePublication(owner, fence: fence); receipt = value; pendingReceiptID = id
        }
    }
    func decide(_ decision: String) {
        performGuarded { [self] fence in
            guard let repository, let pendingReceiptID else { throw NativeAPIError.invalidResponse }
            let owner = privateReadOwner()
            _ = try await repository.decide(pendingReceiptID, decision: decision)
            let value = try await repository.community("receipt", payload: .object(["request_id": .string(pendingReceiptID)]))
            try checkPrivatePublication(owner, fence: fence)
            guard self.pendingReceiptID == pendingReceiptID else { throw CancellationError() }; receipt = value
            try await loadInbox(); try await refreshGallery()
        }
    }
    func preference(_ field: String, enabled: Bool) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner()
            _ = try await repository.post("/me/photo-preferences", payload: .object([field: .bool(enabled), "policy_version": .string(try preferences.text("policy_version"))]), operation: "photo.preferences")
            let value = try await repository.protectedJSON("/me/photo-preferences"); await repository.retireMedia()
            try checkPrivatePublication(owner, fence: fence); preferences = value; mediaRevision += 1
        }
    }
    func saveCurrentPhoto() {
        let photo = currentPhoto, selected = currentPhoto.map { photoSelection.capture($0) }
        performGuarded { [self] fence in
            guard let repository, let photo, let selected else { throw NativeAPIError.invalidResponse }
            guard photoSelection.permits(selected, current: currentPhoto) else { throw NativeAPIError.unsupported(String(localized: "Return to your library and refresh current access.")) }
            let account = session?.accountID, epoch = session?.epoch
            let approval = try await repository.requireAudience(.faceAuthentication)
            let bytes = try await repository.authorizedSaveBytes(photo)
            try await savePhotoToLibrary(bytes) { [self] in
                let current = try await repository.requireAudience(.faceAuthentication)
                try checkPublication(fence)
                guard current == approval, account == session?.accountID, epoch == session?.epoch, isForeground else { throw NativeAPIError.sessionChanged }
                guard photoSelection.permits(selected, current: currentPhoto) else { throw NativeAPIError.unsupported(String(localized: "Return to your library and refresh current access.")) }
            }
            try checkPublication(fence); transferText = String(localized: "Saved to Photos.")
        }
    }
    func loadPrivacy() {
        guard (session?.authenticated == true || hasRegisteredPrivacyIdentity), guestDeletion == nil else { return }
        performGuarded { [self] fence in
            guard let repository else { return }; let owner = privateReadOwner()
            let value = try await repository.protectedJSON("/privacy/center")
            let retained = try await repository.retainedPrivacyExportRequests()
            try checkPrivatePublication(owner, fence: fence); privacy = value; retainedPrivacyExports = retained
        }
    }
    func reconcilePrivacy(retry: Bool = false) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner()
            let result = try await repository.reconcilePrivacy(retryUnknown: retry)
            let current = try await repository.protectedJSON("/privacy/center")
            try checkPrivatePublication(owner, fence: fence); privacy = current
            transferText = result["status"].string == "unknown" ? String(localized: "The result is not confirmed. Check the original request before trying again.") : String(localized: "Original request confirmed.")
        }
    }
    func requestGuestDeletion() {
        guard canDeleteGuest else { return }
        performGuarded(localSigning: .reconciliation, retainedEnrollmentOnly: true) { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.requestGuestDeletion()
            try checkPublication(fence); guestDeletion = value
        }
    }
    func checkGuestDeletion(retry: Bool = false) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.unavailable("configuration") }
            let value = try await repository.checkGuestDeletion(retryOriginal: retry)
            try checkPublication(fence); guestDeletion = value
        }
    }
    func resumeGuestSetup() {
        performGuarded(localSigning: .reconciliation, guestResume: true) { [self] fence, ticket, _ in
            guard let repository, let ticket else { throw NativeAPIError.unavailable("configuration") }
            let value = try await repository.resumeGuestSetup(ticket)
            try checkPublication(fence); session = value; guestDeletion = nil; connected = true
            navigation?.go(.introduction, replace: true, simulateProgress: false)
        }
    }
    func startAgainAfterGuestDeletion() {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.unavailable("configuration") }
            let value = try await repository.startAgainAfterGuestDeletion()
            try checkPublication(fence); session = value; guestDeletion = nil; connected = true
            navigation?.go(.introduction, replace: true, simulateProgress: false)
        }
    }
    func loadDevices() {
        performGuarded { [self] fence in
            guard let repository else { return }; let owner = privateReadOwner()
            let nextDevices = try await repository.protectedJSON("/me/devices")["items"].array ?? []
            let nextSessions = try await repository.protectedJSON("/me/sessions")["items"].array ?? []
            try checkPrivatePublication(owner, fence: fence); devices = nextDevices; sessions = nextSessions
        }
    }
    func revoke(_ value: WireValue, device: Bool) {
        invalidateLocalAuthentication()
        performGuarded { [self] fence in
            guard let repository else { return }
            let owner = privateReadOwner()
            let result = try await repository.protectedJSON(device ? "/auth/device/revoke" : "/auth/session/revoke", method: "POST", body: .object([device ? "device_id" : "session_id": .string(try value.uuid("id"))]))
            try checkPrivatePublication(owner, fence: fence)
            if result["clear_device_identity"].bool == true { await repository.clearSession(identity: true) }
            try checkPrivatePublication(owner, fence: fence)
            if result["current_session_revoked"].bool == true {
                retireAccountPresentation(); session = nil; mediaRevision += 1
                navigation?.go(.faceEnrollment, replace: true, simulateProgress: false)
            } else {
                let nextDevices = try await repository.protectedJSON("/me/devices")["items"].array ?? []
                let nextSessions = try await repository.protectedJSON("/me/sessions")["items"].array ?? []
                try checkPrivatePublication(owner, fence: fence); devices = nextDevices; sessions = nextSessions
            }
        }
    }
    func saveProfile() { performGuarded { [self] fence in guard let repository else { return }; _ = try await repository.post("/me/profile", payload: .object(["name": .string(name)]), operation: "account.profile.update", method: "PATCH") } }
    private func installBlockedPeople(_ items: [WireValue]) {
        let previous = blockedPersonIDs
        blockedPeople = items
        if var value = draft, !value.selectedPeople.isDisjoint(with: blockedPersonIDs) {
            value.selectedPeople.subtract(blockedPersonIDs); value.version += 1; draft = value; preview = nil
        }
        if previous != blockedPersonIDs { preview = nil }
    }
    func loadBlocked() { performGuarded { [self] fence in guard let repository else { return }; let owner = privateReadOwner(); let value = try await repository.protectedJSON("/me/blocks")["items"].array ?? []; try checkPrivatePublication(owner, fence: fence); installBlockedPeople(value) } }
    func block(_ id: String, remove: Bool = false) {
        performGuarded { [self] fence in
            guard let repository else { return }
            let owner = privateReadOwner()
            _ = try await repository.post("/me/blocks/\(id)", payload: .object([:]), operation: remove ? "safety.block.DELETE" : "safety.block.POST", method: remove ? "DELETE" : "POST")
            try checkPrivatePublication(owner, fence: fence)
            var confirmed = blockedPeople.filter { $0["blocked_id"].string != id }
            if !remove { confirmed.append(.object(["blocked_id": .string(id)])) }
            installBlockedPeople(confirmed); preview = nil
            await repository.retireMedia()
            let value = try await repository.protectedJSON("/me/blocks")["items"].array ?? []
            try checkPrivatePublication(owner, fence: fence); mediaRevision += 1; installBlockedPeople(value)
        }
    }
    func reportCurrentPair() {
        performGuarded { [self] fence in
            guard let repository, let photo = currentPhoto, let person = currentPerson else { throw NativeAPIError.unsupported(String(localized: "Choose a matched photo and person before reporting.")) }
            let owner = privateReadOwner()
            _ = try await repository.post("/safety/reports", payload: .object(["asset_id": .string(photo.id), "subject_id": .string(person.id), "reason": .string(String(localized: "This photo/person match is incorrect"))]), operation: "safety.report")
            try checkPrivatePublication(owner, fence: fence)
            if var value = draft { value.excludedPairs.insert(NativePair(asset: photo.id, recipient: person.id)); value.version += 1; draft = value; preview = nil }
            transferText = String(localized: "Report received for review. No access has been granted.")
        }
    }
    func loadNotificationSettings() { performGuarded { [self] fence in
        guard let repository else { return }; let owner = privateReadOwner()
        let value = try await repository.protectedJSON("/me/notification-settings")
        try checkPrivatePublication(owner, fence: fence); notificationSettings = value
    } }
    func setNotification(_ key: String, enabled: Bool) { performGuarded { [self] fence in
        guard let repository else { return }; let owner = privateReadOwner()
        let value = try await repository.post("/me/notification-settings", payload: .object([key: .bool(enabled)]), operation: "notification.settings", method: "PATCH")
        try checkPrivatePublication(owner, fence: fence); notificationSettings = value
    } }
    private func refreshNotifications(loadMore: Bool = false) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }
        let fence = publicationFence(), owner = privateReadOwner(), cursor = loadMore ? notificationCursor : nil
        if loadMore && cursor == nil { return }
        let page = try NativeAccountPage(await repository.protectedJSON(NativeAccountPage.path("/me/notifications", cursor: cursor)))
        try checkPrivatePublication(owner, fence: fence)
        guard !loadMore || notificationCursor == cursor else { throw CancellationError() }
        notifications = loadMore ? page.appending(to: notifications) : page.items; notificationCursor = page.nextCursor
    }
    func loadNotifications(loadMore: Bool = false) { performGuarded { [self] _ in try await refreshNotifications(loadMore: loadMore) } }
    func readNotification(_ id: String) { performGuarded { [self] fence in
        guard UUID(uuidString: id) != nil, let repository else { return }
        let owner = privateReadOwner()
        _ = try await repository.post("/me/notifications/\(id)/read", payload: .object([:]), operation: "notification.read")
        let value = try await repository.protectedJSON("/me/notifications/" + id)["notification"]
        try checkPrivatePublication(owner, fence: fence)
        guard value["id"].string == id else { throw NativeAPIError.invalidResponse }
        if let index = notifications.firstIndex(where: { $0["id"].string == id }) { notifications[index] = value }
    } }
    func requestPrivacy(_ deletion: Bool) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner()
            if deletion {
                do {
                    let value = try await repository.requestRegisteredDeletion()
                    try checkPrivatePublication(owner, fence: fence); registeredDeletion = value
                    navigation?.go(.privacy, replace: true, simulateProgress: false)
                } catch {
                    let value = try? await repository.registeredDeletionReceipt()
                    try checkPrivatePublication(owner, fence: fence); registeredDeletion = value; throw error
                }
            } else {
                _ = try await repository.post("/privacy/export", payload: .object([:]), operation: "privacy.request.export")
                let value = try await repository.protectedJSON("/privacy/center")
                try checkPrivatePublication(owner, fence: fence); privacy = value
            }
        }
    }
    func logout() {
        repository?.retireSessionAuthority()
        invalidateLocalAuthentication()
        workTask?.cancel(); busy = false
        retireSelfieReview(); stopFaceCameraPresentation()
        retireAccountPresentation(); audience = nil; audienceBinding = nil; session = nil
        NativePush.shared.retireAccountBinding()
        performGuarded { [self] fence in
            photos = []; currentPhoto = nil; snapshot = nil; draft = nil; preview = nil; inbox = []; receipt = nil; favoriteIDs = []
            retireAccountPresentation()
            challenge = nil; captureReceipts = []; lastSelfie = nil; imports = []; NativeImport.removeAll(); mediaRevision += 1; stopFaceCameraPresentation()
            await NativePush.shared.unregister()
            try await repository?.logout(); try checkPublication(fence); audience = nil; audienceBinding = nil; deviceAudience = nil; deviceAudienceBinding = nil; deviceAudienceNeeded = false; audienceRenewalContinuation = nil; audienceReviewPolicy = ""; guardianClaim = nil; session = nil
            if let repository, try await repository.pendingAudienceMutation() != nil {
                _ = try await repository.bootstrap()
                let binding = await repository.audienceSessionBinding()
                try checkPublication(fence); audienceBinding = binding; audiencePendingMutation = true
                transferText = String(localized: "Your original age request is held privately for recovery. Resolve it before starting another account or face setup.")
                navigation?.go(.introduction, replace: true, simulateProgress: false)
            } else { navigation?.go(.faceEnrollment, replace: true, simulateProgress: false) }
        }
    }
    func pauseWork() { invalidateLocalAuthentication(); if uploadRecovery != nil { pausePhotoUploads(); return }; workTask?.cancel(); transferText = String(localized: "Paused. Resume keeps the original upload stage and pending request keys.") }
    func clearPreviewCache() { mediaRevision += 1; if let repository { Task { await repository.retireMedia() } } }
    /// Called only for a native authentication sheet's expected inactive phase.
    /// Private media/camera are still retired; true backgrounding never uses it.
    func localAuthenticationSceneInactive() -> Bool {
        guard localAuthenticationPending, localAuthenticationOperation != nil else { return false }
        isForeground = false; photoCamera = false; photoCameraContext = nil
        retireSelfieReview(); camera.setForeground(false); retireSharedFile(); mediaRevision += 1
        if let repository { Task { await repository.retireMedia() } }
        return true
    }
    func localAuthenticationSceneActive() -> Bool {
        guard localAuthenticationPending, localAuthenticationOperation != nil else { return false }
        isForeground = true; camera.setForeground(true); return true
    }
    private func invalidateLocalAuthentication() {
        localAuthenticator.invalidate(); localSigningLease?.invalidate(); localSigningLease = nil
        localAuthenticationPending = false; localAuthenticationOperation = nil
    }
    func background(scheduleRetry: Bool = false) {
        invalidateLocalAuthentication(); persistLibraryState()
        if uploadRunning || scheduleRetry && uploadRecovery?.batch.started == true {
            pausePhotoUploads(userInitiated: false, scheduleRetry: scheduleRetry)
        }
        isForeground = false; photoCamera = false; photoCameraContext = nil
        if deviceAudience != nil { deviceAudienceNeeded = true }; deviceAudience = nil; deviceAudienceBinding = nil; audienceReviewPolicy = ""
        retireSelfieReview(); camera.setForeground(false)
        // Retire the temporary presentation copy synchronously. The separate
        // durable export archive remains available for exact-request recovery.
        retireSharedFile()
        recoveryBackup = nil; recoveryBackupSheet = false; mediaRevision += 1
        workTask?.cancel(); workGeneration += 1; busy = false
        if let repository { Task { await repository.retireMedia() } }
    }
    func foreground() {
        expireSharedFiles()
        if let repository { Task { await repository.expirePrivateMedia() } }
        audience = nil
        isForeground = true
        camera.setForeground(true)
        if !connected, !busy { connect() }
        else if session != nil || audienceBinding != nil, !busy { refreshAudience() }
        if session?.authenticated == true, !uploadRunning { Task { await NativeBackgroundUploads.shared.stop(); try? await restorePhotoUploads() } }
        if guestDeletion != nil, !busy { checkGuestDeletion() }
        else if faceLifecycle != nil, !busy { checkFaceProfile() }
        else if let session, session.expiresAt <= Date(), !busy { performGuarded { [self] fence in guard let repository else { return }; try await repository.refresh(); let value = await repository.summary(); try checkPublication(fence); self.session = value; mediaRevision += 1 } }
    }
}

extension LiveAppStore {
    func requestPhotoCamera() {
        guard canEdit, isForeground, let session, session.authenticated else { error = NativeAPIError.authenticationRequired.localizedDescription; return }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { error = String(localized: "A camera is unavailable on this device. Choose a photo using Photos or Files."); return }
        // Each camera presentation owns a distinct generation, including a reopen
        // under the same account and session. Old delegate work cannot adopt it.
        workTask?.cancel(); workGeneration += 1
        let context = NativeMediaCaptureContext(accountID: session.accountID, sessionEpoch: session.epoch, publicationGeneration: workGeneration, expiresAt: session.expiresAt)
        photoCameraPermissionDenied = false
        Task { [self] in
          do {
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let before = try await repository.requirePhotoCollection(expectedOwner: context)
            guard context.permits(self.session, generation: workGeneration, foreground: isForeground), before.accountID == session.accountID else { throw NativeAPIError.sessionChanged }
            let binding = await repository.audienceSessionBinding()
            guard !Task.isCancelled, context.permits(self.session, generation: workGeneration, foreground: isForeground), binding?.epoch == session.epoch, binding?.accountID == session.accountID else { throw NativeAPIError.sessionChanged }
            audience = before; audienceSessionEpoch = session.epoch; audienceBinding = binding
            let permission = AVCaptureDevice.authorizationStatus(for: .video)
            let allowed: Bool
            if permission == .authorized { allowed = true }
            else if permission == .notDetermined { allowed = await AVCaptureDevice.requestAccess(for: .video) }
            else { allowed = false }
            let after = try await repository.requirePhotoCollection(expectedOwner: context)
            let backendSession = await repository.summary()
            guard !Task.isCancelled, after == before,
                  context.permits(self.session, generation: workGeneration, foreground: isForeground),
                  context.permits(backendSession, generation: workGeneration, foreground: isForeground) else { return }
            if allowed { photoCameraContext = context; photoCamera = true }
            else {
                photoCameraPermissionDenied = AVCaptureDevice.authorizationStatus(for: .video) == .denied
                error = photoCameraPermissionDenied ? String(localized: "Allow camera access in Settings, then return and open the camera again.") : String(localized: "Camera access is restricted on this device.")
            }
          } catch { await photoCollectionFailed(error, account: context.accountID, epoch: context.sessionEpoch, generation: context.publicationGeneration) }
        }
    }
    private func ownsPhotoCameraPresentation(_ request: NativeMediaCaptureContext) -> Bool {
        guard photoCamera, let presented = photoCameraContext else { return false }
        return presented.accountID == request.accountID && presented.sessionEpoch == request.sessionEpoch &&
            presented.publicationGeneration == request.publicationGeneration && presented.expiresAt == request.expiresAt
    }
    private func photoCameraImportIsCurrent(_ request: NativeMediaCaptureContext) -> Bool {
        ownsPhotoCameraPresentation(request) && AVCaptureDevice.authorizationStatus(for: .video) == .authorized && photoImportIsCurrent(request)
    }
    func verifyPhotoCameraImport(_ request: NativeMediaCaptureContext) async -> Bool {
        guard photoCameraImportIsCurrent(request), await verifyPhotoImport(request) else { return false }
        return photoCameraImportIsCurrent(request)
    }
    func acceptCameraImports(_ items: [NativeImport], failure: String?, request: NativeMediaCaptureContext) {
        // A stale delegate must neither stage its image nor dismiss a newer sheet.
        guard ownsPhotoCameraPresentation(request) else {
            for item in items { NativeImport.removeCameraItem(item) }; return
        }
        let authorized = photoCameraImportIsCurrent(request)
        photoCamera = false; photoCameraContext = nil
        guard authorized else { for item in items { NativeImport.removeCameraItem(item) }; return }
        Task { [self] in
            do { try await requirePhotoImport(request) }
            catch {
                for item in items { NativeImport.removeCameraItem(item) }
                await photoCollectionFailed(error, account: request.accountID, epoch: request.sessionEpoch, generation: request.publicationGeneration); return
            }
            acceptImports(items, failure: failure, request: request)
        }
    }
}

extension LiveAppStore {
    func beginAccountRecovery(_ backup: String) {
        performGuarded(localSigning: .accountRecovery, recoveryBackup: backup, guestResume: false) { [self] fence, _, ticket in
            guard guestDeletion == nil else { throw NativeAPIError.unsupported(String(localized: "Check your deletion request before recovering an account.")) }
            guard let repository, let ticket else { throw NativeAPIError.unavailable("configuration") }
            let result = try await repository.startAccountRecovery(backup: backup, transition: ticket)
            try checkPublication(fence); accountRecoverySheet = false; connected = true
            try await presentAccountRecovery(result, fence: fence)
        }
    }
    func checkAccountRecovery() {
        if captureNeedsStatus && retakeChallenge != nil { retakeRejectedSequence(); return }
        performGuarded(localSigning: .accountRecovery) { [self] fence in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            let result = try await repository.continueAccountRecovery()
            try checkPublication(fence); try await presentAccountRecovery(result, fence: fence)
        }
    }
    func useAnotherRecoveryKey() {
        invalidateLocalAuthentication()
        workTask?.cancel(); workGeneration += 1; busy = false
        performGuarded(localSigning: .accountRecovery) { [self] fence in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            try await repository.useAnotherRecoveryKey(); try checkPublication(fence)
            accountRecovery = nil; challenge = nil; captureReceipts = []; lastSelfie = nil; stopFaceCameraPresentation()
            transferText = String(localized: "The earlier attempt is retained privately. No server cancellation has been confirmed."); accountRecoverySheet = true
        }
    }
    private func presentAccountRecovery(_ result: NativeAccountRecoverySummary, fence: NativePublicationFence) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }
        let current = await repository.summary(); try checkPublication(fence)
        retireSelfieReview()
        if retakeChallenge?.accountID != result.accountID { retakeChallenge = nil; faceQualityFailure = nil; captureNeedsStatus = result.awaitingServer }
        if current?.authenticated == true {
            session = current; accountRecovery = nil; enrollment = nil; faceLifecycle = nil; challenge = nil; captureReceipts = []; lastSelfie = nil
            navigation?.go(.setupComplete, replace: true, simulateProgress: false); return
        }
        retireAccountPresentation(); accountRecovery = result; session = nil; challenge = result.awaitingServer ? nil : result.challenge; captureReceipts = result.receipts
        if result.awaitingServer { stopFaceCameraPresentation(); transferText = String(localized: "Account recovery is still processing. Check again before capturing.") }
        navigation?.go(.faceEnrollment, replace: true, simulateProgress: false)
        if let challenge, !result.awaitingServer, result.receipts.count == challenge.poses.count {
            let authenticated = try await repository.completeFace(challenge, captures: result.receipts)
            try checkPublication(fence); session = authenticated; accountRecovery = nil; enrollment = nil; self.challenge = nil; captureReceipts = []
            navigation?.go(.setupComplete, replace: true, simulateProgress: false)
        }
    }
    func loadRecoveryKey() {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let result = try await repository.recoveryKeyMetadata(); try checkPublication(fence); recoveryKey = result
        }
    }
    func createRecoveryBackup() {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let backup = try await repository.createRecoveryKey(), metadata = try await repository.recoveryKeyMetadata()
            try checkPublication(fence); recoveryKey = metadata; recoveryBackup = backup; recoveryBackupSheet = true
        }
    }
    func revokeRecoveryBackup() {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            try await repository.revokeRecoveryKey(); try checkPublication(fence); recoveryBackup = nil; recoveryKey = nil; recoveryBackupSheet = false
        }
    }
}

extension LiveAppStore {
    func openFaceManagement() {
        navigation?.go(.faceManagement, simulateProgress: false)
        performGuarded(localSigning: .profileControl) { [self] fence in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.openFaceLifecycle(); try checkPublication(fence)
            try await presentFaceLifecycle(value, fence: fence)
        }
    }
    func checkFaceProfile(retry: Bool = false) {
        if captureNeedsStatus && retakeChallenge != nil { retakeRejectedSequence(); return }
        performGuarded(localSigning: .profileControl) { [self] fence in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.checkFaceLifecycle(retryOriginal: retry); try checkPublication(fence)
            try await presentFaceLifecycle(value, fence: fence)
        }
    }
    func manageFace(_ action: NativeFaceProfileAction, explicitlyConsented: Bool = false) {
        performGuarded(localSigning: .profileControl) { [self] fence in
            guard let repository, let current = faceLifecycle, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            stopFaceCameraPresentation(); challenge = nil; captureReceipts = []; lastSelfie = nil
            let policy = action == .resume ? current.metadata.photoPolicy : current.metadata.authPolicy
            if action == .resume || action.captures { guard explicitlyConsented else { throw NativeAPIError.unsupported(String(localized: "Accept the current purpose-specific policy before continuing.")) } }
            let value = action.captures ? try await repository.startFaceProfileCapture(action, consentPolicy: policy, expectedVersion: current.metadata.version) : try await repository.faceProfileAction(action, consentPolicy: explicitlyConsented ? policy : nil, expectedVersion: current.metadata.version)
            try checkPublication(fence); try await presentFaceLifecycle(value, fence: fence)
            if let challenge = value.challenge, !value.awaitingServer {
                navigation?.go(.faceEnrollment, simulateProgress: false)
                if value.receipts.count == challenge.poses.count { try await finishManagedFace(challenge, receipts: value.receipts, fence: fence) }
            }
        }
    }
    func verifyManagedFace() {
        performGuarded(localSigning: .profileControl) { [self] fence in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.freshFaceProfileLogin(); try checkPublication(fence)
            try await presentFaceLifecycle(value, fence: fence)
            if let challenge = value.challenge {
                navigation?.go(.faceEnrollment, simulateProgress: false)
                if value.receipts.count == challenge.poses.count { try await finishManagedFace(challenge, receipts: value.receipts, fence: fence) }
            }
        }
    }
    private func presentFaceLifecycle(_ value: NativeFaceLifecycleSummary, fence: NativePublicationFence) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }
        let current = await repository.summary()
        let currentWeakBinding = await repository.audienceSessionBinding()
        try checkPublication(fence)
        if current?.authenticated != true { retireAccountPresentation(preservingWeakState: canPreserveWeakPresentation(currentWeakBinding)); imports = []; selectedImports = []; NativeImport.removeAll(); photoCamera = false }
        faceLifecycle = value; session = current; challenge = value.challenge; captureReceipts = value.receipts; lastSelfie = nil
        policy = value.metadata.authPolicy; enrollment = nil
        if value.awaitingServer || value.authorityUnavailable { stopFaceCameraPresentation(); transferText = String(localized: "The face-profile result is not confirmed. Check its saved status before continuing.") }
        if challenge == nil && !isWeakPrivacyScreen { navigation?.go(.faceManagement, replace: true, simulateProgress: false) }
    }
    private func finishManagedFace(_ challenge: NativeFaceChallenge, receipts: [WireValue], fence: NativePublicationFence) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }; try checkPublication(fence)
        let context = NativeFaceShutterContext(challenge); stopFaceCameraPresentation(); navigation?.go(.processing, simulateProgress: false)
        let value = try await repository.completeFace(challenge, captures: receipts)
        let managed = try await repository.faceLifecycleSummary(); try checkPublication(fence)
        guard context.permits(self.challenge) else { throw NativeAPIError.sessionChanged }
        session = value; faceLifecycle = managed; self.challenge = nil; captureReceipts = []; lastSelfie = nil
        navigation?.go(.faceManagement, replace: true, simulateProgress: false)
    }
}

extension LiveAppStore {
    func cancelManagedCapture() {
        invalidateLocalAuthentication()
        workTask?.cancel(); workGeneration += 1; busy = false; stopFaceCameraPresentation(); challenge = nil; captureReceipts = []; lastSelfie = nil
        navigation?.go(.faceManagement, replace: true, simulateProgress: false)
        performGuarded(localSigning: .profileControl, guestResume: false, profileCancellation: true) { [self] fence, _, ticket in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            guard let ticket else { throw NativeLocalAuthenticationIssue.required }
            let value = try await repository.cancelFaceProfileCapture(transition: ticket); try checkPublication(fence)
            try await presentFaceLifecycle(value, fence: fence)
        }
    }
}

extension LiveAppStore {
    func checkRetainedFaceControl() {
        performGuarded(localSigning: .profileControl) { [self] fence in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.checkRetainedFaceControl(); try checkPublication(fence)
            try await presentFaceLifecycle(value, fence: fence)
        }
    }
    func renewRetainedFaceControl(explicitlyConsented: Bool, retryOriginal: Bool = false) {
        performGuarded(localSigning: .profileControl) { [self] fence in
            guard let repository, guestDeletion == nil, retryOriginal || explicitlyConsented else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.renewRetainedFaceControl(consentPolicy: retryOriginal ? nil : faceLifecycle?.metadata.authPolicy, retryOriginal: retryOriginal)
            try checkPublication(fence); try await presentFaceLifecycle(value, fence: fence)
        }
    }
    func renewFaceManagementControl() {
        performGuarded(localSigning: .profileControl) { [self] fence in
            guard let repository, guestDeletion == nil else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.renewFaceControl(); try checkPublication(fence)
            try await presentFaceLifecycle(value, fence: fence)
        }
    }
}


extension LiveAppStore {
    private func NativePurchasesRetirement() { NativeBackgroundUploads.shared.cancelScheduled(); NotificationCenter.default.post(name: Notification.Name("LoveliesAccountRetired"), object: nil) }
    private func restoreLibraryState() async throws {
        guard let repository, let account = session?.accountID, libraryAccount != account else { return }
        let fence = publicationFence(), owner = privateReadOwner()
        let value = try await repository.libraryState()
        try checkPrivatePublication(owner, fence: fence)
        guard session?.accountID == account else { throw NativeAPIError.sessionChanged }
        favoriteIDs = value.favoriteIDs; galleryAnchor = value.anchor; galleryColumns = min(5, max(2, value.columns))
        savedReview = value.review; savedReviewAssetIDs = value.reviewAssetIDs; libraryAccount = account
        gallerySource = value.source; query = value.query; galleryCategory = value.category ?? "all"
        restoredDestination = value.safeDestination.flatMap(Screen.init(rawValue:))
        lastLibraryScreen = restoredDestination
    }
    func persistLibraryState() {
        guard let repository, let account = session?.accountID, session?.authenticated == true else { return }
        var value = NativeLibraryState(accountID: account)
        value.favoriteIDs = favoriteIDs; value.anchor = galleryAnchor; value.source = gallerySource; value.query = query; value.columns = galleryColumns
        value.destination = (navigation?.screen.rawValue).flatMap { NativeLibraryState.restorableDestinations.contains($0) ? $0 : nil }
        value.category = galleryCategory
        value.query = NativeLibraryState.boundedQuery(query)
        value.review = draft ?? savedReview; value.reviewAssetIDs = snapshot?.photos.map(\.id).sorted() ?? savedReviewAssetIDs
        librarySave?.cancel()
        librarySave = Task { [weak self] in
            do { try await repository.saveLibraryState(value) }
            catch { if !Task.isCancelled, self?.session?.accountID == account { self?.error = String(localized: "Your library choices could not be saved securely. Try again before closing.") } }
        }
    }
    func toggleFavorite(_ id: String) {
        guard session?.authenticated == true else { return }
        if !favoriteIDs.insert(id).inserted { favoriteIDs.remove(id) }; persistLibraryState()
        if lastLibraryScreen == .favorites { nextCursor = nil; reloadPhotos() }
    }
    func showLibrary(_ screen: Screen) {
        guard lastLibraryScreen != screen else { return }
        let previous = lastLibraryScreen, oldIdentity = currentGalleryQuery; lastLibraryScreen = screen
        let source = screen == .search || screen == .filters ? gallerySource : screen == .newMatches ? "received" : screen == .home ? "contributions" : "all"
        if screen != .search && screen != .filters { query = "" }
        gallerySource = source
        if screen == .favorites { galleryCategory = "all" }
        if previous == nil || currentGalleryQuery != oldIdentity || loadedGalleryQuery != currentGalleryQuery {
            nextCursor = nil; photos = []; reloadPhotos()
        }
    }
    func searchLibrary() { query = NativeLibraryState.boundedQuery(query); nextCursor = nil; if loadedGalleryQuery != currentGalleryQuery { photos = [] }; persistLibraryState(); reloadPhotos() }
    func loadOutgoing(loadMore: Bool = false) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }
        let fence = publicationFence(), owner = privateReadOwner(), cursor = loadMore ? outgoingCursor : nil
        if loadMore && cursor == nil { return }
        var payload: [String: WireValue] = ["limit": .integer(25)]; if let cursor { payload["cursor"] = .string(cursor) }
        let page = try NativeAccountPage(await repository.community("history", payload: .object(payload)), personalOnly: true)
        try checkPrivatePublication(owner, fence: fence)
        guard !loadMore || outgoingCursor == cursor else { throw CancellationError() }
        outgoing = loadMore ? page.appending(to: outgoing) : page.items; outgoingCursor = page.nextCursor
    }
    func refreshOutgoing(loadMore: Bool = false) { performGuarded { [self] _ in try await loadOutgoing(loadMore: loadMore) } }
    private func refreshSupport(loadMore: Bool = false) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }
        let fence = publicationFence(), owner = privateReadOwner(), cursor = loadMore ? supportCursor : nil
        if loadMore && cursor == nil { return }
        let page = try NativeAccountPage(await repository.protectedJSON(NativeAccountPage.path("/support/requests", cursor: cursor)), key: "support_requests")
        try checkPrivatePublication(owner, fence: fence)
        guard !loadMore || supportCursor == cursor else { throw CancellationError() }
        supportRequests = loadMore ? page.appending(to: supportRequests) : page.items; supportCursor = page.nextCursor
    }
    func loadSupport(loadMore: Bool = false) { performGuarded { [self] _ in try await refreshSupport(loadMore: loadMore) } }
    func sendSupport() {
        let subject = supportSubject.trimmingCharacters(in: .whitespacesAndNewlines), details = supportDetails.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (3...160).contains(subject.count), (5...4000).contains(details.count) else { error = String(localized: "Enter a subject of 3–160 characters and details of 5–4,000 characters."); return }
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner()
            _ = try await repository.post("/support/requests", payload: .object(["subject": .string(subject), "details": .string(details)]), operation: "support.create")
            try checkPrivatePublication(owner, fence: fence)
            supportSubject = ""; supportDetails = ""
            try await refreshSupport(); try checkPrivatePublication(owner, fence: fence)
            transferText = String(localized: "Support request received. Its current status is shown below.")
        }
    }
    func checkPrivacyRequest(_ id: String) {
        performGuarded { [self] fence in
            guard UUID(uuidString: id) != nil, let repository else { throw NativeAPIError.invalidResponse }
            let owner = privateReadOwner()
            let value = try await repository.protectedJSON("/privacy-requests/\(id)")
            try checkPrivatePublication(owner, fence: fence)
            guard value["privacy_request"]["id"].string == id else { throw NativeAPIError.invalidResponse }
            let center = try await repository.protectedJSON("/privacy/center")
            try checkPrivatePublication(owner, fence: fence); privacy = center
        }
    }
    func exportPrivacy(_ id: String) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let owner = privateReadOwner(), account = session?.accountID, epoch = session?.epoch
            let delivery = try await repository.exportFile(requestID: id)
            try checkPrivatePublication(owner, fence: fence)
            guard session?.accountID == account, session?.epoch == epoch, isForeground else { throw NativeAPIError.sessionChanged }
            try presentSharedExportFile(delivery.file, authorityExpiresAt: delivery.expiresAt)
        }
    }
    func shareCurrentPhoto() {
        let photo = currentPhoto, selected = currentPhoto.map { photoSelection.capture($0) }
        performGuarded { [self] fence in
            guard let repository, let photo, let selected else { throw NativeAPIError.invalidResponse }
            guard photoSelection.permits(selected, current: currentPhoto) else { throw NativeAPIError.unsupported(String(localized: "Return to your library and refresh current access.")) }
            let account = session?.accountID, epoch = session?.epoch, approval = try await repository.requireAudience(.faceAuthentication)
            let bytes = try await repository.authorizedSaveBytes(photo), current = try await repository.requireAudience(.faceAuthentication)
            try checkPublication(fence)
            guard session?.accountID == account, session?.epoch == epoch, approval == current, isForeground else { throw NativeAPIError.sessionChanged }
            guard photoSelection.permits(selected, current: currentPhoto) else { throw NativeAPIError.unsupported(String(localized: "Return to your library and refresh current access.")) }
            let ext = bytes.starts(with: [0xff, 0xd8]) ? "jpg" : bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) ? "png" : bytes.starts(with: [0x52, 0x49, 0x46, 0x46]) ? "webp" : "heic"
            try presentSharedBytes(bytes, extension: ext, deadline: mediaDeadline(current))
        }
    }
    private func presentSharedBytes(_ data: Data, extension ext: String, authorityExpiresAt: Date? = nil, deadline suppliedDeadline: NativePrivateMediaDeadline? = nil) throws {
        retireSharedFile()
        // A failed older cleanup cannot accumulate another private disk copy.
        try sharedFiles.prune(now: privateMediaClock.read().wall)
        let expiry = [session?.expiresAt, authorityExpiresAt].compactMap { $0 }.min()
        let deadline = suppliedDeadline ?? NativePrivateMediaDeadline(created: privateMediaClock.read(), authorityExpiresAt: expiry)
        let url = try sharedFiles.create(data, extension: ext)
        try installSharedFile(url, deadline: deadline)
    }
    private func installSharedFile(_ url: URL, deadline: NativePrivateMediaDeadline) throws {
        guard deadline.remaining(at: privateMediaClock.read()) > 0 else { try? sharedFiles.prune(); throw NativeAPIError.sessionChanged }
        presentSharedFile(url, deadline: deadline)
    }
    private func presentSharedExportFile(_ url: URL, authorityExpiresAt: Date) throws {
        retireSharedFile(); try sharedFiles.prune(now: privateMediaClock.read().wall)
        let expiry = min(session?.expiresAt ?? .distantPast, authorityExpiresAt)
        let deadline = NativePrivateMediaDeadline(created: privateMediaClock.read(), authorityExpiresAt: expiry)
        guard url.isFileURL, url.pathExtension == "json", deadline.remaining(at: privateMediaClock.read()) > 0 else { throw NativeAPIError.sessionChanged }
        // The repository owns this protected delivery file and retires it at
        // logout/expiry. Presentation adds no full-memory or temporary duplicate.
        presentSharedFile(url, deadline: deadline)
    }
    private func presentSharedFile(_ url: URL, deadline: NativePrivateMediaDeadline) {
        let file = NativeShareFile(url: url); sharedFile = file; sharedFileDeadline = deadline
        sharedFileExpiryTask?.cancel()
        sharedFileExpiryTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(deadline.remaining(at: self?.privateMediaClock.read() ?? deadline.created)))
                guard !Task.isCancelled, let self, self.sharedFile?.id == file.id else { return }
                self.expireSharedFiles()
            } catch {}
        }
    }
    func retireSharedFile() {
        sharedFileExpiryTask?.cancel(); sharedFileExpiryTask = nil
        sharedFile = nil; sharedFileDeadline = nil
        do { try sharedFiles.prune(now: privateMediaClock.read().wall) }
        catch { scheduleSharedFileCleanupRetry() }
    }
    func completeSharedFile(_ id: UUID, completed: Bool) {
        guard sharedFile?.id == id else { return }
        // Export v3 is bound to the current session and expires under repository
        // ownership. The OS callback retires only this presentation, never a new action.
        retireSharedFile()
    }

    private func scheduleSharedFileCleanupRetry() {
        sharedFileExpiryTask?.cancel()
        sharedFileExpiryTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled, let self, self.sharedFile == nil else { return }
                self.retireSharedFile()
            } catch {}
        }
    }
    private func expireSharedFiles() {
        if sharedFile != nil, (sharedFileDeadline?.remaining(at: privateMediaClock.read()) ?? 0) <= 0 { retireSharedFile(); return }
        try? sharedFiles.prune(keeping: sharedFile?.url, now: privateMediaClock.read().wall)
    }
    func openAuthorizedDestination(kind: String, id: String) {
        guard session?.authenticated == true, ["match", "support", "payment"].contains(kind),
              kind == "payment" || UUID(uuidString: id) != nil else { return }
        if kind == "match" { navigation?.go(.activity, simulateProgress: false); openReceipt(id) }
        else if kind == "support" {
            performGuarded { [self] fence in
                guard let repository else { throw NativeAPIError.authenticationRequired }
                let owner = privateReadOwner()
                let response = try await repository.protectedJSON("/support/requests/\(id)")
                try checkPrivatePublication(owner, fence: fence)
                guard response["support_request"]["id"].string == id else { throw NativeAPIError.invalidResponse }
                supportRequests = [response["support_request"]]; navigation?.go(.help, simulateProgress: false)
            }
        } else { navigation?.go(.profile, simulateProgress: false) }
    }
    func openLink(_ url: URL) {
        let trustedHost = Bundle.main.object(forInfoDictionaryKey: "LoveliesLinkHost") as? String ?? ""
        guard url.scheme == "lovelies" || (url.scheme == "https" && !trustedHost.isEmpty && url.host == trustedHost), url.user == nil, url.password == nil, url.fragment == nil else { error = String(localized: "This Lovelies link is unavailable."); return }
        let parts = url.path.split(separator: "/").map(String.init)
        let kind = url.scheme == "lovelies" ? url.host : parts.first
        let id = url.scheme == "lovelies" ? parts.first : parts.dropFirst().first
        guard let kind, let id, UUID(uuidString: id) != nil, ["match", "support", "payment"].contains(kind) else { error = String(localized: "This Lovelies link is expired or unavailable."); return }
        NativePush.shared.queue(kind: kind, entity: id)
    }
}


extension LiveAppStore {
    func checkRegisteredDeletion(retry: Bool = false) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.unavailable("configuration") }
            let owner = privateReadOwner(), operation = registeredDeletion?.operationKey
            let value = retry ? try await repository.requestRegisteredDeletion(retry: true) : try await repository.checkRegisteredDeletion()
            try checkPrivatePublication(owner, fence: fence)
            guard registeredDeletion?.operationKey == operation else { throw NativeAPIError.sessionChanged }
            registeredDeletion = value
            if registeredDeletion?.completed == true { retireAccountPresentation(); session = nil }
        }
    }
    func startAfterRegisteredDeletion() {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.unavailable("configuration") }
            let value = try await repository.finishRegisteredDeletionReceipt()
            try checkPublication(fence); session = value; registeredDeletion = nil; navigation?.go(.introduction, replace: true, simulateProgress: false)
        }
    }
    func continueRegisteredAccount() {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.unavailable("configuration") }
            try await repository.continueRegisteredAccount(); let value = try await repository.bootstrap()
            try checkPublication(fence); session = value; registeredDeletion = nil; connected = true; navigation?.go(session?.authenticated == true ? .home : .faceEnrollment, replace: true, simulateProgress: false)
        }
    }
}


extension LiveAppStore {
    func handleAudienceFailure(_ error: Error) {
        guard Self.isAudienceError(error) else { return }
        audience = nil; audienceSessionEpoch = nil; deviceAudienceNeeded = true; stopFaceCameraPresentation(); retireAccountPresentation(); self.error = error.localizedDescription
    }
    private static func isAudienceError(_ error: Error) -> Bool {
        guard case NativeAPIError.denied(_, let code) = error else { return false }
        return code.hasPrefix("audience_") || code.hasPrefix("guardian_") || code == "age_not_supported"
    }
    func audienceGateNeeded(_ screen: Screen) -> Bool {
        guard session != nil || audienceBinding != nil || deviceAudienceNeeded || deviceAudience != nil else { return false }
        guard connected, guestDeletion == nil, registeredDeletion == nil else { return false }
        guard ![.privacy, .exportData, .security, .faceManagement].contains(screen) else { return false }
        return deviceAudienceNeeded || deviceAudience != nil || audiencePendingMutation || !audienceEligible
    }
    func refreshAudience(retryOriginal: Bool = false) {
        if deviceAudience != nil || audienceRenewalContinuation != nil && hasSavedAudienceDevice || audienceBinding == nil && hasSavedAudienceDevice {
            checkDeviceAudience(retryOriginal: retryOriginal); return
        }
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let value = retryOriginal ? try await repository.retryAudienceMutation() : try await repository.audience()
            try checkPublication(fence); try await installAudience(value, fence: fence)
            if hasRegisteredPrivacyIdentity {
                let claim = try await repository.retainedGuardianClaim(); try checkPublication(fence); guardianClaim = claim
            }
        }
    }
    func checkDeviceAudience(retryOriginal: Bool = false) {
        performGuarded(localSigning: .reconciliation) { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let value = retryOriginal ? try await repository.renewDeviceAudience(expectedVersion: 0, consentPolicy: nil, retryOriginal: true) : try await repository.signedAudienceStatus()
            try checkPublication(fence); try await installDeviceAudience(value, fence: fence)
        }
    }
    private func installDeviceAudience(_ value: NativeAudienceDeviceStatus, fence: NativePublicationFence) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }
        let binding = try await repository.audienceDeviceBinding(value)
        let currentPolicy = value.renewalAvailable && value.decision.guardianRequired == false ? try await repository.policy() : ""
        let finalBinding = try await repository.audienceDeviceBinding(value)
        try checkPublication(fence)
        guard binding == finalBinding else { throw NativeAPIError.sessionChanged }
        stopFaceCameraPresentation(); retireAccountPresentation(); audience = nil; audienceSessionEpoch = nil
        deviceAudience = value; deviceAudienceBinding = binding; deviceAudienceNeeded = true; audienceReviewPolicy = currentPolicy; audienceRenewalContinuation = nil
        navigation?.go(.introduction, replace: true, simulateProgress: false)
    }
    func renewEligibility(consentPolicy: String, adultConfirmed: Bool, authenticationConsented: Bool) {
        guard adultConfirmed, authenticationConsented, !consentPolicy.isEmpty, consentPolicy == audienceReviewPolicy else { return }
        if let held = deviceAudience {
            guard held.decision.ageBand == .adult, held.renewalAvailable else { return }
            performGuarded(localSigning: .reconciliation) { [self] fence in
                guard let repository, deviceAudience == held else { throw NativeAPIError.sessionChanged }
                let value = try await repository.renewDeviceAudience(expectedVersion: held.decision.version, consentPolicy: consentPolicy)
                try checkPublication(fence); try await installDeviceAudience(value, fence: fence)
            }
        } else if let held = audience, held.ageBand == .adult, held.decision.needsReview() {
            performGuarded { [self] fence in
                guard let repository, audience == held else { throw NativeAPIError.sessionChanged }
                let value = try await repository.renewAudience(expectedVersion: held.version, consentPolicy: consentPolicy)
                try checkPublication(fence); try await installAudience(value, fence: fence)
            }
        }
    }
    func renewMinorEligibility(confirmed: Bool) {
        guard confirmed else { return }
        if let held = deviceAudience {
            guard held.decision.ageBand == .teen, held.guardianReviewAvailable else { return }
            performGuarded(localSigning: .reconciliation) { [self] fence in
                guard let repository, deviceAudience == held else { throw NativeAPIError.sessionChanged }
                let value = try await repository.renewDeviceAudience(expectedVersion: held.decision.version, consentPolicy: nil, guardianRequired: true)
                try checkPublication(fence); try await installDeviceAudience(value, fence: fence)
            }
        } else if let held = audience, held.ageBand == .teen, held.decision.needsReview() || held.status == .guardianPending && held.guardianRequest?.state == .approved { declareAge(.teen) }
    }
    func continueDeviceAudience() {
        guard !busy, !audiencePendingMutation, let held = deviceAudience, !held.decision.needsReview(), held.decision.status == .eligible else { return }
        if held.nextStep == "face_login" {
            deviceAudience = nil; deviceAudienceBinding = nil; deviceAudienceNeeded = false; prepareFace(renewedAudienceAccount: held.accountID)
        } else if held.nextStep == "profile_recovery" {
            if faceLifecycle != nil { deviceAudienceNeeded = false; deviceAudience = nil; deviceAudienceBinding = nil; checkRetainedFaceControl() }
            else { error = String(localized: "Your saved device cannot restore the retired face reference by itself. Use your existing recovery backup or contact support; keep this account and its saved requests.") }
        }
    }
    private func installAudience(_ value: NativeAudienceProjection, fence: NativePublicationFence) async throws {
        guard let repository else { throw NativeAPIError.authenticationRequired }
        let current = try await repository.audiencePresentation(value)
        let productSession = await repository.summary()
        let currentPolicy = value.ageBand == .adult && value.decision.needsReview() ? try await repository.policy() : ""
        let finalBinding = await repository.audienceSessionBinding()
        try checkPublication(fence)
        guard current == finalBinding, value.accountID == current.accountID, productSession == nil || productSession?.accountID == current.accountID && productSession?.epoch == current.epoch else { throw NativeAPIError.sessionChanged }
        let preserveWeakPresentation = canPreserveWeakPresentation(current)
        if audienceBinding != current { retireSelfieReview(); retireAccountPresentation() }
        session = productSession; audienceBinding = current; audienceSessionEpoch = current.epoch; audience = value
        if let nextStep = value.renewalNextStep { audienceRenewalContinuation = nextStep }
        deviceAudience = nil; deviceAudienceBinding = nil; deviceAudienceNeeded = false; audienceReviewPolicy = currentPolicy
        scheduleAudienceExpiry()
        if !audienceEligible { stopFaceCameraPresentation(); retireAccountPresentation(preservingWeakState: preserveWeakPresentation); photoCamera = false }
    }
    func continueAudienceRenewal() {
        guard !busy, audienceRenewalContinuation != nil else { return }
        if hasSavedAudienceDevice { checkDeviceAudience(); return }
        if audienceBinding?.registeredIdentity == false {
            audienceRenewalContinuation = nil; navigation?.go(.introduction, replace: true, simulateProgress: false); return
        }
        if faceLifecycle != nil { audienceRenewalContinuation = nil; checkRetainedFaceControl(); return }
        error = String(localized: "Your retained face reference is unavailable. Use your existing face-profile recovery control or recovery backup. This device cannot create a replacement account.")
    }
    func declareAge(_ band: NativeAgeBand) {
        guard let current = audience, current.accountID == audienceBinding?.accountID,
              current.ageBand == .unknown || current.ageBand == .teen && band == .teen && current.decision.needsReview() else { return }
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.declareAudience(band, expectedVersion: current.version)
            try checkPublication(fence); try await installAudience(value, fence: fence)
        }
    }
    func requestGuardianReview() {
        guard let current = audience, current.ageBand == .teen else { return }
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.createGuardianRequest(expectedVersion: current.version)
            try checkPublication(fence); try await installAudience(value, fence: fence)
        }
    }
    func withdrawGuardian(_ request: NativeGuardianRequest) {
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.withdrawGuardianRequest(request)
            let current = try await repository.audience()
            try checkPublication(fence)
            let ownClaim = guardianClaim?.id == request.id
            try await installAudience(current, fence: fence)
            if ownClaim { guardianClaim = value }
        }
    }
    func claimGuardian(reference: String, purposes: Set<NativeAudiencePurpose>, attested: Bool) {
        let parts = reference.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ":")
        guard parts.count == 2, UUID(uuidString: String(parts[0])) != nil, let revision = Int(parts[1]), revision > 0 else { error = String(localized: "Enter the complete guardian request reference, including its revision."); return }
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.claimGuardianRequest(id: String(parts[0]).lowercased(), revision: revision, purposes: purposes, relationshipAttested: attested)
            try checkPublication(fence); guardianClaim = value
        }
    }
    func checkGuardianClaim(_ reference: String) {
        let id = String(reference.split(separator: ":").first ?? "").lowercased()
        performGuarded { [self] fence in
            guard let repository else { throw NativeAPIError.authenticationRequired }
            let value = try await repository.guardianRequest(id)
            try checkPublication(fence); guardianClaim = value
        }
    }
}
