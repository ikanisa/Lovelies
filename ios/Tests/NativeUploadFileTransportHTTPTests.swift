import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Root supplies two owned loopback HTTP listeners. The first redirects the
/// declared upload paths to same-origin/cross-origin sinks and exposes /hits;
/// counters are observed actual requests, not a replacement transport verdict.
@main struct NativeUploadFileTransportHTTPTests {
    static func main() async throws {
        guard CommandLine.arguments.count == 3, let origin = URL(string: CommandLine.arguments[1]),
              origin.scheme == "http", ["localhost", "127.0.0.1"].contains(origin.host ?? ""), origin.user == nil,
              origin.password == nil, origin.query == nil, origin.fragment == nil, ["", "/"].contains(origin.path) else { throw NativeAPIError.invalidResponse }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("lovelies-redirect-check-" + UUID().uuidString.lowercased() + ".chunk")
        let bytes = Data([0xff, 0xd8, 0xff, 0x44]), digest = NativeUploadPrivateFiles.hash(bytes)
        try bytes.write(to: file, options: .atomic); defer { try? FileManager.default.removeItem(at: file) }
        let transport = NativeFileURLUploadTransport()
        let batch = UUID().uuidString.lowercased(), local = UUID().uuidString.lowercased()
        var checks = 0
        for (asset, status) in [("00000000-0000-4000-8000-000000000101", 302), ("00000000-0000-4000-8000-000000000102", 307)] {
            var request = URLRequest(url: URL(string: "/uploads/" + asset + "/chunks?offset=0", relativeTo: origin)!.absoluteURL)
            request.httpMethod = "PUT"; request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            request.setValue(digest, forHTTPHeaderField: "X-Lovelies-Chunk-SHA256"); request.setValue("Bearer explicit-synthetic-redirect-fixture", forHTTPHeaderField: "Authorization")
            let reply = try await transport.send(request, file: file, taskKey: batch + ":" + local + ":0:" + digest, limit: 1024)
            guard reply.status == status else { throw NativeAPIError.unsupported("Private file upload followed a redirect") }; checks += 1
        }
        var read = URLRequest(url: URL(string: "/hits", relativeTo: origin)!.absoluteURL); read.httpMethod = "GET"
        let result = try await NativeURLTransport().send(read, limit: 1024), hits = try WireValue.decoded(result.data)
        guard result.status == 200, hits["same_origin_sink"].integer == 0, hits["cross_origin_sink"].integer == 0,
              hits["upload_requests"].integer == 2 else { throw NativeAPIError.unsupported("Private upload bytes reached a redirected endpoint") }; checks += 3
        let report: WireValue = .object(["status": .string("passed"), "assertions_passed": .integer(checks), "scope": .string("Actual production file-backed ephemeral URLSession rejects same-origin302 and cross-origin307 before a sink receives any request; loopback static four-byte fixture"), "same_origin_sink_requests": .integer(0), "cross_origin_sink_requests": .integer(0), "does_not_establish": .strings(["iOS UI/device execution", "background-daemon scheduling", "hosted API operation"])])
        try report.encoded().write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
        print("Native upload file transport HTTP checks passed: \(checks)")
    }
}
