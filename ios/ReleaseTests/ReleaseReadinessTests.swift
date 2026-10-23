import XCTest
@testable import Lovelies

final class ReleaseReadinessTests: XCTestCase {
    func testRegisteredDeletionRejectsAnotherReceiptAndFalseCompletion() throws {
        let account = UUID().uuidString.lowercased(), operation = UUID().uuidString.lowercased(), request = UUID().uuidString.lowercased()
        var receipt = NativeRegisteredDeletionRecord(accountID: account, operationKey: operation, statusToken: "lvd_" + String(repeating: "a", count: 64), apiOrigin: "https://fixture", preparedAt: Date())
        try receipt.validate(origin: URL(string: "https://fixture")!)
        func response(_ id: String, _ state: String, _ completed: Bool) -> WireValue { .object([
            "protocol": .string("lovelies-account-deletion-v1"), "source": .string("privacy"), "operation_key": .string(operation),
            "privacy_request": .object(["id": .string(id), "request_type": .string("delete"), "status": .string(state)]), "deletion_completed": .bool(completed)
        ]) }
        let pending = response(request, "pending_approval", false)
        try receipt.validateResponse(pending); receipt.response = pending
        XCTAssertFalse(receipt.completed)
        XCTAssertThrowsError(try receipt.validateResponse(response(UUID().uuidString, "completed", true)))
        XCTAssertThrowsError(try receipt.validateResponse(response(request, "processing", true)))
        try receipt.validateResponse(response(request, "completed", true))
        receipt.response = response(request, "completed", true); XCTAssertTrue(receipt.completed)
    }
    func testAccountLibraryIntentRoundTrip() throws {
        var state = NativeLibraryState(accountID: UUID().uuidString.lowercased())
        state.favoriteIDs = [UUID().uuidString.lowercased()]; state.anchor = state.favoriteIDs.first; state.columns = 4; state.destination = 15; state.query = "mountains"; state.category = "landscapes"
        let restored = try JSONDecoder().decode(NativeLibraryState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(restored.accountID, state.accountID); XCTAssertEqual(restored.favoriteIDs, state.favoriteIDs)
        XCTAssertEqual(restored.anchor, state.anchor); XCTAssertEqual(restored.columns, 4)
        XCTAssertEqual(restored.safeDestination, 15); XCTAssertEqual(restored.query, "mountains"); XCTAssertEqual(restored.category, "landscapes")
        state.destination = 23; XCTAssertNil(state.safeDestination)
        XCTAssertNil(restored.review) // Persistence never manufactures a server preview.
    }
    func testCancelledPublicationCannotPublish() {
        XCTAssertFalse(NativePublicationFence(generation: 3).permits(currentGeneration: 3, cancelled: true))
        XCTAssertFalse(NativePublicationFence(generation: 3).permits(currentGeneration: 4, cancelled: false))
    }
}
