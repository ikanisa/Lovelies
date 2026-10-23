import Foundation

@main struct NativeReleaseReadinessTests {
    static var checks = 0
    static func expect(_ condition: @autoclosure () -> Bool, _ label: String) throws {
        guard condition() else { throw NativeAPIError.unsupported("Release protocol failure: " + label) }; checks += 1
    }
    static func reject(_ label: String, _ work: () throws -> Void) throws {
        do { try work() } catch { checks += 1; return }
        throw NativeAPIError.unsupported("Expected rejection: " + label)
    }
    static func main() throws {
        let account = UUID().uuidString.lowercased(), operation = UUID().uuidString.lowercased(), request = UUID().uuidString.lowercased()
        var receipt = NativeRegisteredDeletionRecord(accountID: account, operationKey: operation, statusToken: "lvd_" + String(repeating: "a", count: 64), apiOrigin: "https://fixture/functions/v1/lovelies-api", preparedAt: Date())
        let origin = URL(string: receipt.apiOrigin)!
        try receipt.validate(origin: origin); checks += 1
        try reject("wrong API deployment cannot import old deletion authority") { try receipt.validate(origin: URL(string: "https://other")!) }
        func response(_ id: String, _ state: String, _ completed: Bool, key: String = operation) -> WireValue { .object([
            "protocol": .string("lovelies-account-deletion-v1"), "source": .string("privacy"), "operation_key": .string(key),
            "privacy_request": .object(["id": .string(id), "request_type": .string("delete"), "status": .string(state)]), "deletion_completed": .bool(completed)
        ]) }
        let pending = response(request, "pending_approval", false)
        try receipt.validateResponse(pending); receipt.response = pending
        try expect(!receipt.completed, "pending is never erasure")
        let recovered = try JSONDecoder().decode(NativeRegisteredDeletionRecord.self, from: JSONEncoder().encode(receipt))
        try expect(recovered.operationKey == operation && recovered.statusToken == receipt.statusToken, "exact request and private status authority survive restart")
        try reject("cannot adopt another request") { try recovered.validateResponse(response(UUID().uuidString, "completed", true)) }
        try reject("cannot adopt another operation") { try recovered.validateResponse(response(request, "completed", true, key: UUID().uuidString)) }
        try reject("processing cannot claim completion") { try recovered.validateResponse(response(request, "processing", true)) }
        try reject("unknown lifecycle") { try recovered.validateResponse(response(request, "done", true)) }
        try reject("completion boolean must agree") { try recovered.validateResponse(response(request, "completed", false)) }
        try recovered.validateResponse(response(request, "completed", true)); receipt.response = response(request, "completed", true)
        try expect(receipt.completed, "only bound server completion allows start-again")
        var library = NativeLibraryState(accountID: account)
        library.favoriteIDs = [UUID().uuidString.lowercased()]; library.anchor = library.favoriteIDs.first; library.columns = 4; library.query = "mountains"; library.destination = 15; library.category = "landscapes"
        let stored = try JSONDecoder().decode(NativeLibraryState.self, from: JSONEncoder().encode(library))
        try expect(stored.favoriteIDs == library.favoriteIDs && stored.accountID == account, "favorites retain account scope")
        try expect(stored.review == nil, "local persistence cannot manufacture a sharing preview")
        try expect(stored.anchor == library.anchor && stored.query == library.query && stored.columns == 4, "browsing choices retain intent")
        try expect(stored.safeDestination == 15 && stored.category == "landscapes", "restored browsing route/category retain intent")
        library.destination = 23
        try expect(library.safeDestination == nil, "active operation routes cannot restore into completion or progress")
        try expect(NativeLibraryState.boundedQuery(String(repeating: "🌄", count: 300)).utf16.count <= 200, "long Unicode queries preserve server limit without splitting characters")
        try expect(!NativePublicationFence(generation: 4).permits(currentGeneration: 5, cancelled: false), "old lifecycle publication denied")
        try expect(!NativePublicationFence(generation: 4).permits(currentGeneration: 4, cancelled: true), "cancelled publication denied")
        print("Native release-readiness protocol checks passed: \(checks)")
    }
}
