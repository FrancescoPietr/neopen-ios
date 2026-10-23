import Foundation
import UIKit

/// Network requests that iOS finishes by itself while the app is suspended (locked phone): a *background* URLSession.
/// Everything goes through files in Documents/http, so a result is not lost if the app is relaunched without JavaScript:
///   <id>.req    request body (written by JavaScript)
///   <id>.body   response bytes (appended as they arrive)
///   <id>.done   JSON {status, error, finished (ms since 1970)} (written when the request is over)
final class BackgroundHttp: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  static let shared = BackgroundHttp()

  private let lock = NSLock()
  private var eventsDone: (() -> Void)?

  static var directory: URL {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let dir = docs.appendingPathComponent("http", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// Created at launch (also when iOS relaunches the app for a finished request), so the delegate gets its events.
  lazy var session: URLSession = {
    let config = URLSessionConfiguration.background(withIdentifier: "com.francesco.neopen.http")
    config.sessionSendsLaunchEvents = true
    config.isDiscretionary = false
    config.waitsForConnectivity = true
    config.timeoutIntervalForRequest = 300
    config.timeoutIntervalForResource = 3600
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()

  /// Starts a POST whose body is the file `bodyPath`. The answer ends up in `<id>.body` and `<id>.done`.
  func startPost(id: String, url: String, headers: [String: String], bodyPath: String) -> Bool {
    guard let target = URL(string: url) else { return false }
    var request = URLRequest(url: target)
    request.httpMethod = "POST"
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    let dir = BackgroundHttp.directory
    try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).body"))
    try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).done"))
    let task = session.uploadTask(with: request, fromFile: URL(fileURLWithPath: bodyPath))
    task.taskDescription = id
    task.resume()
    return true
  }

  func handleEvents(completion: @escaping () -> Void) {
    lock.lock()
    eventsDone = completion
    lock.unlock()
    _ = session
  }

  // MARK: URLSession delegate

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let id = dataTask.taskDescription else { return }
    let file = BackgroundHttp.directory.appendingPathComponent("\(id).body")
    if let handle = try? FileHandle(forWritingTo: file) {
      handle.seekToEndOfFile()
      handle.write(data)
      try? handle.close()
    } else {
      try? data.write(to: file)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = task.taskDescription else { return }
    let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
    let finished = Int(Date().timeIntervalSince1970 * 1000)
    let message = error?.localizedDescription
    // also records whether the app was in the foreground when the request ended (proof that it finished on its own)
    DispatchQueue.main.async {
      let state: String
      switch UIApplication.shared.applicationState {
      case .active: state = "attiva"
      case .inactive: state = "inattiva"
      case .background: state = "in background"
      @unknown default: state = "?"
      }
      var info: [String: Any] = ["status": status, "finished": finished, "appState": state]
      if let message { info["error"] = message }
      if let data = try? JSONSerialization.data(withJSONObject: info) {
        try? data.write(to: BackgroundHttp.directory.appendingPathComponent("\(id).done"))
      }
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    lock.lock()
    let done = eventsDone
    eventsDone = nil
    lock.unlock()
    if let done { DispatchQueue.main.async { done() } }
  }
}
