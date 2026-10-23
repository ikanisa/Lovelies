import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// File-backed uploads use a bounded ephemeral session so redirects can be
/// refused before private bytes reach a different endpoint. Background daemon
/// sessions cannot enforce this redirect rule. App backgrounding pauses uploads;
/// the durable journal reconciles accepted bytes after foregrounding/relaunch.
final class NativeFileURLUploadTransport: NSObject, NativeUploadFileTransport, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = NativeFileURLUploadTransport()
    private struct Pending {
        let continuation: CheckedContinuation<NativeHTTPReply, Error>
        let limit: Int
        var data = Data()
        var invalid = false
    }
    private final class Cancellation: @unchecked Sendable {
        private let lock = NSLock()
        private var cancelled = false
        private var task: URLSessionTask?
        func publish(_ value: URLSessionTask) {
            lock.lock(); task = value; let shouldCancel = self.cancelled; lock.unlock()
            if shouldCancel { value.cancel() } else { value.resume() }
        }
        func cancel() { lock.lock(); cancelled = true; let current = task; lock.unlock(); current?.cancel() }
    }
    private let lock = NSLock()
    private var pending: [Int: Pending] = [:]
    private var session: URLSession!
    override init() {
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60; configuration.timeoutIntervalForResource = 180
        configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }
    private func tasks() async -> [URLSessionTask] {
        await withCheckedContinuation { continuation in session.getAllTasks { continuation.resume(returning: $0) } }
    }
    private func retain(_ value: Pending?, task: Int) { lock.lock(); defer { lock.unlock() }; pending[task] = value }
    func send(_ request: URLRequest, file: URL, taskKey: String, limit: Int) async throws -> NativeHTTPReply {
        let parts = taskKey.split(separator: ":")
        guard parts.count == 4, UUID(uuidString: String(parts[0])) != nil, UUID(uuidString: String(parts[1])) != nil,
              let offset = Int(parts[2]), offset >= 0, NativeResumableUploadFile.digest(String(parts[3])), request.httpMethod == "PUT",
              let url = request.url, url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")),
              (url.path.hasPrefix("/uploads/") || url.path.hasPrefix("/functions/v1/lovelies-api/uploads/")), url.path.hasSuffix("/chunks"), url.user == nil, url.password == nil, url.fragment == nil,
              file.isFileURL, limit > 0, limit <= 2 * 1024 * 1024 else { throw NativeAPIError.invalidResponse }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        guard components?.queryItems == [URLQueryItem(name: "offset", value: String(offset))],
              request.value(forHTTPHeaderField: "X-Lovelies-Chunk-SHA256") == String(parts[3]) else { throw NativeAPIError.invalidResponse }
        let cancellation = Cancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let task = session.uploadTask(with: request, fromFile: file); task.taskDescription = taskKey
                // Register first. An earlier Swift cancellation is held in the
                // box and cannot finish an unregistered URLSession task.
                retain(Pending(continuation: continuation, limit: limit), task: task.taskIdentifier)
                cancellation.publish(task)
            }
        } onCancel: { cancellation.cancel() }
    }
    func cancel(batch: String) async {
        guard UUID(uuidString: batch) != nil else { return }
        for task in await tasks() where task.taskDescription?.hasPrefix(batch + ":") == true { task.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard var value = pending[dataTask.taskIdentifier] else { return }
        guard value.data.count + data.count <= value.limit else { value.invalid = true; pending[dataTask.taskIdentifier] = value; dataTask.cancel(); return }
        value.data.append(data); pending[dataTask.taskIdentifier] = value
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let value = pending.removeValue(forKey: task.taskIdentifier); lock.unlock()
        guard let value else { return }
        if value.invalid { value.continuation.resume(throwing: NativeAPIError.invalidResponse); return }
        if let error { value.continuation.resume(throwing: error); return }
        guard let response = task.response as? HTTPURLResponse, response.url == task.originalRequest?.url,
              value.data.count <= value.limit else { value.continuation.resume(throwing: NativeAPIError.invalidResponse); return }
        let headers = Dictionary(uniqueKeysWithValues: response.allHeaderFields.compactMap { key, value -> (String, String)? in
            guard let key = key as? String, let value = value as? String else { return nil }; return (key.lowercased(), value)
        })
        value.continuation.resume(returning: NativeHTTPReply(status: response.statusCode, headers: headers, data: value.data))
    }
}
