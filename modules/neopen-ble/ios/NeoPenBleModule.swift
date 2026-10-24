import ExpoModulesCore
import UIKit

/// JavaScript interface of the pen Bluetooth (see PenBluetooth.swift) plus iOS background tasks.
/// Bytes travel as base64 strings.
public class NeoPenBleModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NeoPenBle")

    Events("onState", "onReady", "onData", "onClosed", "onLog", "onHttpDone")

    OnStartObserving {
      DispatchQueue.main.async { [weak self] in
        PenBluetooth.shared.start()
        PenBluetooth.shared.sink = { name, body in self?.sendEvent(name, body) }
      }
      BackgroundHttp.shared.onDone = { [weak self] id in self?.sendEvent("onHttpDone", ["id": id]) }
    }

    OnStopObserving {
      DispatchQueue.main.async { PenBluetooth.shared.sink = nil }
      BackgroundHttp.shared.onDone = nil
    }

    AsyncFunction("getState") { () -> [String: Any] in
      PenBluetooth.shared.start()
      return PenBluetooth.shared.snapshot()
    }.runOnQueue(.main)

    Function("searchPen") {
      DispatchQueue.main.async { PenBluetooth.shared.searchPen() }
    }

    Function("stopSearch") {
      DispatchQueue.main.async { PenBluetooth.shared.stopSearch() }
    }

    Function("forgetPen") {
      DispatchQueue.main.async { PenBluetooth.shared.forgetPen() }
    }

    Function("disconnect") {
      DispatchQueue.main.async { PenBluetooth.shared.disconnect() }
    }

    Function("send") { (base64: String) in
      guard let data = Data(base64Encoded: base64) else { return }
      DispatchQueue.main.async { PenBluetooth.shared.send(data) }
    }

    /// A few extra seconds from iOS to finish work with the app in the background. Returns an id for `endBackgroundTask`.
    Function("beginBackgroundTask") { (name: String) -> Int in
      BackgroundTasks.begin(name)
    }

    Function("endBackgroundTask") { (id: Int) in
      BackgroundTasks.end(id)
    }

    /// POST that iOS keeps running with the app suspended. The body is the file `bodyPath`; the answer lands in
    /// Documents/http/<id>.body and <id>.done.
    /// The Obsidian vault folder: chosen once from Files, then the app can write files into it.
    AsyncFunction("pickVaultFolder") { (promise: Promise) in
      VaultFolder.shared.pick { name in promise.resolve(name) }
    }

    Function("vaultFolderName") { () -> String? in
      VaultFolder.shared.name
    }

    /// Markdown files of the vault with their modification time (ms).
    AsyncFunction("listVaultMarkdown") { () -> [[String: Any]] in
      VaultFolder.shared.listMarkdown()
    }

    /// Text of a file inside the vault folder, or null.
    AsyncFunction("readVaultFile") { (path: String) -> String? in
      VaultFolder.shared.read(path)
    }

    /// Writes a text file inside the vault folder; returns "" or the error message.
    Function("writeVaultFile") { (path: String, text: String) -> String in
      VaultFolder.shared.write(path, text)
    }

    Function("startBackgroundPost") { (id: String, url: String, headers: [String: String], bodyPath: String) -> Bool in
      BackgroundHttp.shared.startPost(id: id, url: url, headers: headers, bodyPath: bodyPath)
    }
  }
}

/// iOS background tasks, by number (JavaScript can't hold a UIBackgroundTaskIdentifier).
enum BackgroundTasks {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var tasks: [Int: UIBackgroundTaskIdentifier] = [:]
  nonisolated(unsafe) private static var next = 1

  static func begin(_ name: String) -> Int {
    lock.lock()
    let id = next
    next += 1
    lock.unlock()
    let task = UIApplication.shared.beginBackgroundTask(withName: name) {
      end(id) // iOS is about to suspend the app: close it ourselves
    }
    lock.lock()
    tasks[id] = task
    lock.unlock()
    return id
  }

  static func end(_ id: Int) {
    lock.lock()
    let task = tasks.removeValue(forKey: id)
    lock.unlock()
    if let task, task != .invalid { UIApplication.shared.endBackgroundTask(task) }
  }
}
