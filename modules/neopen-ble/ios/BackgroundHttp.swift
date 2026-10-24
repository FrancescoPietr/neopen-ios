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

  /// Called (on any thread) when a request is over and its `.done` file is written: JavaScript reads it right away.
  var onDone: ((String) -> Void)?

  /// Normal session for the quick attempt (it runs at once, also in the background, while iOS gives us time).
  private lazy var quick: URLSession = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 120
    config.timeoutIntervalForResource = 300
    return URLSession(configuration: config)
  }()

  /// Starts a POST whose body is the file `bodyPath`. The answer ends up in `<id>.body` and `<id>.done`.
  /// First it is tried at once with a normal request, inside an iOS background task (so it goes on for a while with
  /// the phone locked): requests that the background session starts while the app is in the background can wait
  /// several minutes before iOS sends them. If iOS takes back the time before the answer, or there is no network,
  /// the same request moves to the background session, which iOS finishes by itself.
  func startPost(id: String, url: String, headers: [String: String], bodyPath: String) -> Bool {
    guard let target = URL(string: url) else { return false }
    var request = URLRequest(url: target)
    request.httpMethod = "POST"
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    let dir = BackgroundHttp.directory
    try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).body"))
    try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).done"))
    let body = URL(fileURLWithPath: bodyPath)

    let attempt = QuickAttempt()
    let app = UIApplication.shared
    let toBackground: () -> Void = { [weak self] in
      guard attempt.settle() else { return }
      attempt.task?.cancel()
      self?.startInBackgroundSession(id: id, request: request, body: body)
      attempt.end(app)
    }
    attempt.background = app.beginBackgroundTask(withName: "neopen-\(id)") { toBackground() }
    if attempt.background == .invalid {
      // no time left from iOS: straight to the background session
      startInBackgroundSession(id: id, request: request, body: body)
      return true
    }
    let task = quick.uploadTask(with: request, fromFile: body) { [weak self] data, response, error in
      if let error = error as NSError?, error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled {
        // no network (locked phone, airplane…): the background session waits for it
        toBackground()
        return
      }
      guard attempt.settle() else { return }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if let data { try? data.write(to: BackgroundHttp.directory.appendingPathComponent("\(id).body")) }
      self?.finish(id: id, status: status, error: error?.localizedDescription) {
        // a few more seconds so JavaScript can use the answer before iOS suspends the app
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { attempt.end(app) }
      }
    }
    attempt.task = task
    task.resume()
    return true
  }

  private func startInBackgroundSession(id: String, request: URLRequest, body: URL) {
    try? FileManager.default.removeItem(at: BackgroundHttp.directory.appendingPathComponent("\(id).body"))
    let task = session.uploadTask(with: request, fromFile: body)
    task.taskDescription = id
    task.resume()
  }

  /// Writes `<id>.done` (with the app state when the request ended) and tells JavaScript.
  private func finish(id: String, status: Int, error: String?, then: (() -> Void)? = nil) {
    let finished = Int(Date().timeIntervalSince1970 * 1000)
    DispatchQueue.main.async { [weak self] in
      let state: String
      switch UIApplication.shared.applicationState {
      case .active: state = "attiva"
      case .inactive: state = "inattiva"
      case .background: state = "in background"
      @unknown default: state = "?"
      }
      var info: [String: Any] = ["status": status, "finished": finished, "appState": state]
      if let error { info["error"] = error }
      if let data = try? JSONSerialization.data(withJSONObject: info) {
        try? data.write(to: BackgroundHttp.directory.appendingPathComponent("\(id).done"))
      }
      self?.onDone?(id)
      then?()
    }
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
    // also records whether the app was in the foreground when the request ended (proof that it finished on its own)
    finish(id: id, status: status, error: error?.localizedDescription)
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    lock.lock()
    let done = eventsDone
    eventsDone = nil
    lock.unlock()
    guard let done else { return }
    // iOS woke the app for these answers: JavaScript needs a little time to put them in the vault and the calendar
    // (the app may even be starting from scratch) before we tell iOS we are finished.
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) { done() }
  }
}

/// State of one quick attempt (shared between the request, its timeout and iOS's expiration handler).
private final class QuickAttempt: @unchecked Sendable {
  private let lock = NSLock()
  private var settled = false
  var task: URLSessionTask?
  var background: UIBackgroundTaskIdentifier = .invalid

  /// True only the first time (answer, error or expiration: whichever comes first wins).
  func settle() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if settled { return false }
    settled = true
    return true
  }

  func end(_ app: UIApplication) {
    DispatchQueue.main.async {
      if self.background != .invalid {
        app.endBackgroundTask(self.background)
        self.background = .invalid
      }
    }
  }
}
