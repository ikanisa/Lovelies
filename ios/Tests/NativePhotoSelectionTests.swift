import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// One synthetic account; the transport is entirely in memory and never opens
// a network connection. No UIKit, Photos, Keychain or real media is involved.
private final class SelectionSecrets: NativeSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var slots: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return slots[name] }
    func write(_ name: String, data: Data?) throws { lock.lock(); defer { lock.unlock() }; slots[name] = data }
}
private struct SelectionSigner: NativeDeviceSigner {
    func sign(_ data: Data) throws -> String { throw NativeAPIError.invalidResponse }
    func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func clear() {}
}
private actor SelectionTransport: NativeTransport {
    static let account = "00000000-0000-4000-8000-000000000091"
    static let ticket = "00000000-0000-4000-8000-000000000092"
    let sourceVersion: WireValue
    private var signs = 0, gets = 0
    init(_ sourceVersion: WireValue) { self.sourceVersion = sourceVersion }
    nonisolated func cancelPending() {}
    func counts() -> (Int, Int) { (signs, gets) }
    func send(_ request: URLRequest, limit: Int) async throws -> NativeHTTPReply {
        func json(_ value: WireValue) throws -> NativeHTTPReply {
            .init(status: 200, headers: ["content-type": "application/json"], data: try value.encoded())
        }
        switch request.url!.path {
        case "/me":
            return try json(.object(["user_id": .string(Self.account), "auth_method": .string("registered_face"), "authenticated": .bool(true)]))
        case "/me/audience":
            return try json(.object(["protocol": .string(NativeAudienceProjection.protocolName), "policy_version": .string(NativeAudienceProjection.policy), "account_id": .string(Self.account),
                "audience": .object(["age_band": .string("18_plus"), "status": .string("eligible"), "version": .integer(1), "policy_version": .string(NativeAudienceProjection.policy), "next_review_at": .null]),
                "guardian_request": .null, "capabilities": .object(["face_authentication": .bool(true), "photo_matching": .bool(true), "photo_processing": .bool(true)])]))
        case "/downloads/sign":
            signs += 1
            let body = try WireValue.decoded(request.httpBody!)
            guard body["asset_id"].string == NativePhotoSelectionTests.assetA, body["operation_key"].string != nil else { throw NativeAPIError.invalidResponse }
            var response: [String: WireValue] = ["method": .string("GET"), "download_url": .string("https://fixture.invalid/downloads/" + Self.ticket), "expires_in": .integer(120)]
            if sourceVersion != .null { response["source_version"] = sourceVersion }
            return try json(.object(response))
        case "/downloads/" + Self.ticket:
            gets += 1
            return .init(status: 200, headers: ["content-type": "image/png"], data: Data([0x89, 0x50, 0x4e, 0x47, 0x01]))
        default: throw NativeAPIError.invalidResponse
        }
    }
}

@main struct NativePhotoSelectionTests {
    static let assetA = "00000000-0000-4000-8000-000000000093"
    static let assetB = "00000000-0000-4000-8000-000000000094"
    private static var checks = 0
    static func require(_ value: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try value() else { throw NativeAPIError.unsupported("Photo selection check failed: " + label) }; checks += 1
    }
    static func photo(_ id: String, _ version: String) throws -> NativePhoto {
        try NativePhoto(.object(["id": .string(id), "title": .string("Synthetic photo"), "media_source": .string("personal"), "version": .string(version)]))
    }
    private static func make(_ source: WireValue) async throws -> (BackendRepository, SelectionTransport) {
        let vault = SelectionSecrets(), transport = SelectionTransport(source), now = Date(), lifetime = 900
        let claims: WireValue = .object(["sub": .string(SelectionTransport.account), "auth_method": .string("registered_face"), "exp": .integer(Int(now.timeIntervalSince1970) + lifetime + 1)])
        let credential = try NativeCredentials(.object(["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".fixture"), "refresh_token": .string("synthetic-selection-refresh"),
            "account_id": .string(SelectionTransport.account), "auth_method": .string("registered_face"), "expires_in": .integer(lifetime), "roles": .strings(["user"])]), now: now)
        try vault.write("credentials", data: JSONEncoder().encode(credential))
        let repository = BackendRepository(origin: URL(string: "https://fixture.invalid")!, transport: transport, secrets: vault, signer: SelectionSigner())
        _ = try await repository.bootstrap(); return (repository, transport)
    }
    static func main() async throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments == ["--baseline"] || arguments == ["--fixed"] else { throw NativeAPIError.invalidResponse }
        let fixed = arguments == ["--fixed"]
        #if SELECTION_FIXED
        try require(fixed, "candidate binary must run fixed expectations")
        var selection = NativePhotoSelectionFence()
        let a = try photo(assetA, "source-v1"), b = try photo(assetB, "source-v1"), a2 = try photo(assetA, "source-v2")
        selection.changed(); let first = selection.capture(a)
        try require(selection.permits(first, current: a), "unchanged A remains current")
        selection.changed(); try require(!selection.permits(first, current: b), "A to B rejects the old A operation")
        selection.changed(); try require(!selection.permits(first, current: a), "A to B to A does not revive the old operation")
        let afterReturn = selection.capture(a); try require(selection.permits(afterReturn, current: a), "new A action obtains new authority")
        selection.changed(); try require(!selection.permits(afterReturn, current: a2), "A version change retires the old operation")
        let v2 = selection.capture(a2); try require(selection.permits(v2, current: a2), "new A version may be selected")
        selection.changed(); try require(!selection.permits(v2, current: a2), "even identical reselection cannot revive an old action")
        selection.changed(); try require(!selection.permits(v2, current: nil), "retired selection rejects the old action")
        #else
        try require(!fixed, "baseline binary must run baseline expectations")
        #endif
        for (selected, returned, expectedSigns, expectedGets, shouldSucceed) in [
            ("source-v1", WireValue.string("source-v1"), 1, 1, true),
            ("source-v1", WireValue.string("source-v2"), 1, fixed ? 0 : 1, !fixed),
            ("source-v1", WireValue.null, 1, fixed ? 0 : 1, !fixed),
            ("", WireValue.string("source-v1"), fixed ? 0 : 1, fixed ? 0 : 1, !fixed)
        ] {
            let (repo, transport) = try await make(returned)
            var value: Data?, failure: Error?
            do { value = try await repo.authorizedSaveBytes(photo(assetA, selected)) }
            catch { failure = error }
            let (signs, gets) = await transport.counts()
            try require(signs == expectedSigns && gets == expectedGets, "version case sends only expected sign and GET")
            try require((value != nil) == shouldSucceed && (failure != nil) != shouldSucceed, "version case publishes only expected result")
            if let value { try require(value == Data([0x89, 0x50, 0x4e, 0x47, 0x01]), "matching bytes remain unchanged") }
        }
        print("Photo selection checks passed: \(checks); mode=\(fixed ? "fixed" : "baseline").")
    }
}
