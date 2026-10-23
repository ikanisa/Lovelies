import Foundation

/// Root QA compiles this with Native/CoreWire.swift. No platform, provider or UI
/// fixture can establish real camera, installed-device or hosted acceptance.
@main struct NativeProtocolTests {
    static var checks = 0
    static func assert(_ value: @autoclosure () -> Bool, _ label: String) throws {
        guard value() else { throw NativeAPIError.unsupported("Native protocol check failed: \(label)") }; checks += 1
    }
    static func rejects(_ label: String, _ body: () throws -> Void) throws {
        do { try body() } catch { checks += 1; return }
        throw NativeAPIError.unsupported("Native protocol rejection missing: \(label)")
    }
    static func id(_ number: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", number) }
    static func main() throws {
        let p1 = id(1), p2 = id(2), p4 = id(4), aline = id(11), eric = id(12)
        let pairs = [NativePair(asset: p1, recipient: aline), NativePair(asset: p2, recipient: aline), NativePair(asset: p2, recipient: eric), NativePair(asset: p4, recipient: eric)]
        let expires = "2099-01-01T00:00:00.000Z"
        let graph: WireValue = .object(["id": .string(id(20)), "version": .string("verified-graph-v1"), "source": .string("personal"), "expires_at": .string(expires),
            "assets": .array([p1, p2, p4].map { .object(["id": .string($0), "version": .string("source-v1"), "media_source": .string("personal"), "width": .integer(1200), "height": .integer(1600)]) }),
            "recipients": .array([.object(["id": .string(aline), "name": .string("Aline")]), .object(["id": .string(eric), "name": .string("Eric")])]),
            "pairs": .array(pairs.map(\.wire)), "scope": .object(["asset_limit": .integer(100), "recipient_limit": .integer(100), "pair_limit": .integer(1000), "has_more": .bool(false), "selection_limited": .bool(false)])])
        func response(_ graph: WireValue) -> WireValue { .object(["protocol": .string("reviewed-sharing-v1"), "status": .string("ready"), "snapshot": graph]) }
        let snapshot = try NativeSnapshot(response(graph)); var draft = NativeShareDraft(snapshot: snapshot)
        try assert(draft.effective(snapshot).count == 4, "sparse graph preserves four real edges")
        try assert(draft.subsets(snapshot)[aline] == [p1, p2] && draft.subsets(snapshot)[eric] == [p2, p4], "per-person actual subsets")
        draft.excludedPairs.insert(NativePair(asset: p2, recipient: aline)); draft.version += 1
        try assert(draft.subsets(snapshot)[aline] == [p1] && draft.subsets(snapshot)[eric] == [p2, p4], "pair-only exclusion cannot globally remove P2")
        draft.selectedPhotos.remove(p4); draft.version += 1
        try assert(draft.subsets(snapshot)[eric] == [p2], "global photo exclusion")
        draft.selectedPeople.remove(eric); draft.version += 1
        try assert(draft.effective(snapshot) == [NativePair(asset: p1, recipient: aline)], "global person exclusion")
        draft.selectedPeople.insert(eric); draft.selectedPhotos.insert(p4); draft.version += 1
        try assert(draft.excludedPairs.contains(NativePair(asset: p2, recipient: aline)), "editing preserves pair exclusions")
        let encoded = try JSONEncoder().encode(draft), restored = try JSONDecoder().decode(NativeShareDraft.self, from: encoded)
        try assert(restored == draft, "private draft recovery is exact")
        var empty = draft; empty.selectedPhotos = []
        try rejects("empty effective selection") { _ = try empty.previewPayload(snapshot) }
        var outside = draft; outside.selectedPeople.insert(id(999))
        try rejects("unknown recipient") { _ = try outside.previewPayload(snapshot) }
        var missing = graph.object!; missing.removeValue(forKey: "scope")
        try rejects("missing scope") { _ = try NativeSnapshot(response(.object(missing))) }
        var wrongSource = graph.object!; wrongSource["source"] = .string("professional")
        try rejects("wrong source") { _ = try NativeSnapshot(response(.object(wrongSource))) }
        try rejects("professional snapshot mode cannot be selected") { _ = try NativeSnapshot(response(.object(wrongSource)), source: "professional") }
        var missingSource = graph.object!; missingSource.removeValue(forKey: "source")
        try rejects("missing explicit snapshot source") { _ = try NativeSnapshot(response(.object(missingSource))) }
        var missingAssetSource = graph.object!
        missingAssetSource["assets"] = .array([.object(["id": .string(p1), "version": .string("v1")])])
        try rejects("missing media source") { _ = try NativeSnapshot(response(.object(missingAssetSource))) }
        var expired = graph.object!; expired["expires_at"] = .string("2000-01-01T00:00:00.000Z")
        try rejects("expired snapshot") { _ = try NativeSnapshot(response(.object(expired))) }
        var fabricated = graph.object!; fabricated["pairs"] = .array(pairs.map(\.wire) + [NativePair(asset: p4, recipient: id(999)).wire])
        try rejects("out-of-scope graph edge") { _ = try NativeSnapshot(response(.object(fabricated))) }
        let effective = draft.effective(snapshot), subsets = draft.subsets(snapshot)
        let preview: WireValue = .object(["protocol": .string("reviewed-sharing-v1"), "status": .string("ready"), "preview": .object([
            "id": .string(id(30)), "version": .string("preview-v1"), "source": .string("personal"), "draft_version": .integer(draft.version), "expires_at": .string(expires),
            "pairs": .array(effective.map(\.wire)), "recipients": .array(subsets.keys.sorted().map { .object(["recipient_id": .string($0), "asset_ids": .strings(subsets[$0]!), "photo_count": .integer(subsets[$0]!.count)]) }),
            "totals": .object(["photos": .integer(Set(effective.map(\.asset_id)).count), "recipients": .integer(subsets.count), "pairs": .integer(effective.count)])])])
        _ = try NativePreview(preview, snapshot: snapshot, draft: draft); checks += 1
        var missingPreviewSource = preview.object!, missingPreviewBody = preview["preview"].object!
        missingPreviewBody.removeValue(forKey: "source"); missingPreviewSource["preview"] = .object(missingPreviewBody)
        try rejects("missing explicit preview source") { _ = try NativePreview(.object(missingPreviewSource), snapshot: snapshot, draft: draft) }
        missingPreviewBody["source"] = .string("professional"); missingPreviewSource["preview"] = .object(missingPreviewBody)
        try rejects("wrong preview source") { _ = try NativePreview(.object(missingPreviewSource), snapshot: snapshot, draft: draft) }
        var forged = preview.object!, forgedBody = preview["preview"].object!
        forgedBody["recipients"] = .array([.object(["recipient_id": .string(aline), "asset_ids": .strings([p1, p2, p4]), "photo_count": .integer(3)])]); forged["preview"] = .object(forgedBody)
        try rejects("fabricated recipient subset") { _ = try NativePreview(.object(forged), snapshot: snapshot, draft: draft) }
        let signed: WireValue = .object(["protocol": .string("lovelies-face-device-v1"), "step": .string("capture"), "mime": .string("image/jpeg"), "byte_size": .integer(321), "capture_index": .integer(0), "profile_id": .null])
        let canonical = String(data: try signed.canonical(), encoding: .utf8)
        try assert(canonical == "{\"byte_size\":321,\"capture_index\":0,\"mime\":\"image/jpeg\",\"profile_id\":null,\"protocol\":\"lovelies-face-device-v1\",\"step\":\"capture\"}", "canonical signature bytes match server ordering and slash format")
        let intent = NativeOperationIntent(key: "original-stable-operation-key", accountID: id(50), source: "personal", action: "sharing.commit", payload: .object(["preview_id": .string(id(30))]), approvedPairs: effective)
        let recovered = try JSONDecoder().decode(NativeOperationIntent.self, from: JSONEncoder().encode(intent))
        try assert(recovered.key == intent.key && recovered.payload == intent.payload && recovered.approvedPairs == intent.approvedPairs, "ambiguous share retains exact original key and subset")
        let photoWire: [String: WireValue] = ["id": .string(p1), "source": .string("received"), "media_source": .string("personal"), "width": .integer(100), "height": .integer(200)]
        let wirePhoto = try NativePhoto(.object(photoWire))
        try assert(wirePhoto.source == "personal" && wirePhoto.feedSource == "received" && wirePhoto.ratio == 2, "personal receipt retains its feed and real geometry")
        var retiredPhoto = photoWire; retiredPhoto["media_source"] = .string("professional")
        try rejects("professional photo metadata") { _ = try NativePhoto(.object(retiredPhoto)) }
        retiredPhoto.removeValue(forKey: "media_source")
        try rejects("photo metadata cannot infer missing media source") { _ = try NativePhoto(.object(retiredPhoto)) }
        let date = ISO8601DateFormatter(); date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = Date()
        let claims: WireValue = .object(["sub": .string(id(50)), "auth_method": .string("registered_face"), "exp": .integer(Int(now.timeIntervalSince1970) + 900)])
        var credential: [String: WireValue] = ["access_token": .string("fixture." + (try claims.encoded()).base64URL + ".signature"), "refresh_token": .string("fixture-refresh"), "account_id": .string(id(50)), "auth_method": .string("registered_face"), "expires_in": .integer(900), "roles": .strings(["user", "admin"])]
        let registered = try NativeCredentials(.object(credential), now: now)
        let restoredCredential = try JSONDecoder().decode(NativeCredentials.self, from: JSONEncoder().encode(registered))
        try assert(restoredCredential.roles == ["user", "admin"], "current credential roles survive private storage")
        for roles in [["photographer"], ["user", "photographer"], ["user", "user"], [String]()] {
            credential["roles"] = .strings(roles)
            try rejects("retired or malformed wire credential roles: \(roles)") { _ = try NativeCredentials(.object(credential), now: now) }
            var storedCredential = try WireValue.decoded(JSONEncoder().encode(registered)).object!
            storedCredential["roles"] = .strings(roles)
            try rejects("retired or malformed stored credential roles: \(roles)") { _ = try JSONDecoder().decode(NativeCredentials.self, from: WireValue.object(storedCredential).encoded()) }
        }
        var face: [String: WireValue] = ["protocol": .string("lovelies-face-auth-v1"), "challenge_id": .string(id(60)), "account_id": .string(id(50)), "device_id": .string(id(61)), "device_revision": .string(id(62)), "nonce": .string("lfn_" + String(repeating: "A", count: 43)), "face_handle": .string("lfh_" + String(repeating: "B", count: 43)), "purpose": .string("registration"), "profile_id": .null, "profile_revision": .null, "model_id": .null, "policy_version": .string("registered-face-opencv-v1"), "required_captures": .integer(3), "poses": .strings(["front", "left", "right"]), "expires_at": .string(date.string(from: now.addingTimeInterval(100))), "maximum_capture_bytes": .integer(8 * 1024 * 1024)]
        let registration = try NativeFaceChallenge(.object(face), accountID: id(50), purpose: "registration", now: now)
        try assert(registration.poses == ["front", "left", "right"] && registration.deviceEnvelope()["profile_id"] == .null, "three ordinary initial enrollment captures")
        try rejects("capture challenge bound to another account") { _ = try NativeFaceChallenge(.object(face), accountID: id(999), purpose: "registration", now: now) }
        face["purpose"] = .string("login"); face["profile_id"] = .string(id(63)); face["profile_revision"] = .string(id(64)); face["model_id"] = .string("yunet-sface-v1"); face["required_captures"] = .integer(1); face["poses"] = .strings(["front"]); face.removeValue(forKey: "face_handle")
        let login = try NativeFaceChallenge(.object(face), accountID: id(50), purpose: "login", now: now)
        try assert(login.poses == ["front"] && login.faceHandle == nil, "fresh login uses retained opaque device identity and one ordinary selfie")
        face["expires_at"] = .string(date.string(from: now.addingTimeInterval(-1)))
        try rejects("expired single-use face challenge") { _ = try NativeFaceChallenge(.object(face), accountID: id(50), purpose: "login", now: now) }
        print("Native protocol checks passed: \(checks)")
    }
}
