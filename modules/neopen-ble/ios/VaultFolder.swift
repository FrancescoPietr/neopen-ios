import Foundation
import UIKit
import UniformTypeIdentifiers

/// A folder chosen by the user once (the Obsidian vault, in Files → On My iPhone → Obsidian), remembered with a
/// security-scoped bookmark so the app can write into it later, also in the background.
final class VaultFolder: NSObject, UIDocumentPickerDelegate {
  static let shared = VaultFolder()
  private let key = "neopen.vaultBookmark"
  private var pending: ((String?) -> Void)?

  func pick(completion: @escaping (String?) -> Void) {
    DispatchQueue.main.async {
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
      picker.delegate = self
      picker.allowsMultipleSelection = false
      guard let top = VaultFolder.topController() else {
        completion(nil)
        return
      }
      self.pending = completion
      top.present(picker, animated: true)
    }
  }

  private static func topController() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
    var controller = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
    while let presented = controller?.presentedViewController { controller = presented }
    return controller
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first else {
      finish(nil)
      return
    }
    let accessing = url.startAccessingSecurityScopedResource()
    defer { if accessing { url.stopAccessingSecurityScopedResource() } }
    do {
      let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      UserDefaults.standard.set(data, forKey: key)
      finish(url.lastPathComponent)
    } catch {
      finish(nil)
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(nil)
  }

  private func finish(_ name: String?) {
    let done = pending
    pending = nil
    done?(name)
  }

  private func resolve() -> URL? {
    guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
    var stale = false
    guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
    if stale {
      let accessing = url.startAccessingSecurityScopedResource()
      if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
        UserDefaults.standard.set(fresh, forKey: key)
      }
      if accessing { url.stopAccessingSecurityScopedResource() }
    }
    return url
  }

  var name: String? { resolve()?.lastPathComponent }

  /// Markdown files of the vault: [["path": relative path, "mtime": ms]]. Hidden folders (.obsidian, .trash) are skipped.
  func listMarkdown() -> [[String: Any]] {
    guard let root = resolve() else { return [] }
    let accessing = root.startAccessingSecurityScopedResource()
    defer { if accessing { root.stopAccessingSecurityScopedResource() } }
    let base = root.standardizedFileURL.path
    var out: [[String: Any]] = []
    let keys: [URLResourceKey] = [.contentModificationDateKey, .isRegularFileKey]
    guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
    for case let url as URL in walker {
      guard url.pathExtension.lowercased() == "md" else { continue }
      let values = try? url.resourceValues(forKeys: Set(keys))
      guard values?.isRegularFile == true else { continue }
      var path = url.standardizedFileURL.path
      if path.hasPrefix(base) { path = String(path.dropFirst(base.count)) }
      if path.hasPrefix("/") { path = String(path.dropFirst()) }
      let mtime = (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
      out.append(["path": path, "mtime": mtime])
    }
    return out
  }

  /// Text of a file inside the folder (relative path), or nil.
  func read(_ relative: String) -> String? {
    guard let root = resolve() else { return nil }
    let accessing = root.startAccessingSecurityScopedResource()
    defer { if accessing { root.stopAccessingSecurityScopedResource() } }
    var text: String?
    var coordinationError: NSError?
    NSFileCoordinator().coordinate(readingItemAt: root.appendingPathComponent(relative), options: [], error: &coordinationError) { url in
      text = try? String(contentsOf: url, encoding: .utf8)
    }
    return text
  }

  /// Writes a UTF-8 text file at `relative` inside the folder (creating the folders). Returns "" or the error message.
  func write(_ relative: String, _ text: String) -> String {
    guard let root = resolve() else { return "cartella del vault non scelta" }
    let accessing = root.startAccessingSecurityScopedResource()
    defer { if accessing { root.stopAccessingSecurityScopedResource() } }
    let target = root.appendingPathComponent(relative)
    var failure = ""
    var coordinationError: NSError?
    NSFileCoordinator().coordinate(writingItemAt: target, options: .forReplacing, error: &coordinationError) { url in
      do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url, options: .atomic)
      } catch {
        failure = error.localizedDescription
      }
    }
    if let coordinationError { return coordinationError.localizedDescription }
    return failure
  }

  // ---------------------------------------------------------------- the whole vault (for the plugin's engine on the phone)

  /// Runs `body` with access to the folder (security scope), or returns nil if no folder was chosen.
  private func withRoot<T>(_ body: (URL) -> T) -> T? {
    guard let root = resolve() else { return nil }
    let accessing = root.startAccessingSecurityScopedResource()
    defer { if accessing { root.stopAccessingSecurityScopedResource() } }
    return body(root)
  }

  private static func info(_ url: URL) -> [String: Any]? {
    let keys: Set<URLResourceKey> = [.isDirectoryKey, .contentModificationDateKey, .creationDateKey, .fileSizeKey]
    guard let v = try? url.resourceValues(forKeys: keys) else { return nil }
    let mtime = (v.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
    let ctime = (v.creationDate?.timeIntervalSince1970 ?? v.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
    return ["folder": v.isDirectory == true, "mtime": mtime, "ctime": ctime, "size": v.fileSize ?? 0]
  }

  /// Every file and folder (relative paths), hidden ones (.obsidian, .trash) left out, like Obsidian's file list.
  func scan() -> [[String: Any]] {
    return withRoot { root -> [[String: Any]] in
      let base = root.standardizedFileURL.path
      var out: [[String: Any]] = []
      let keys: [URLResourceKey] = [.isDirectoryKey, .contentModificationDateKey, .creationDateKey, .fileSizeKey]
      guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
      for case let url as URL in walker {
        guard var entry = VaultFolder.info(url) else { continue }
        var path = url.standardizedFileURL.path
        if path.hasPrefix(base) { path = String(path.dropFirst(base.count)) }
        if path.hasPrefix("/") { path = String(path.dropFirst()) }
        if path.isEmpty { continue }
        entry["path"] = path
        out.append(entry)
      }
      return out
    } ?? []
  }

  func stat(_ relative: String) -> [String: Any]? {
    return withRoot { root in VaultFolder.info(root.appendingPathComponent(relative)) } ?? nil
  }

  /// Contents of a folder (also hidden ones): full relative paths.
  func list(_ relative: String) -> [String: [String]] {
    return withRoot { root -> [String: [String]] in
      let dir = relative.isEmpty || relative == "/" ? root : root.appendingPathComponent(relative)
      var files: [String] = []
      var folders: [String] = []
      let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
      for name in names.sorted() {
        let rel = relative.isEmpty || relative == "/" ? name : "\(relative)/\(name)"
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path, isDirectory: &isDir)
        if isDir.boolValue { folders.append(rel) } else { files.append(rel) }
      }
      return ["files": files, "folders": folders]
    } ?? ["files": [], "folders": []]
  }

  func readData(_ relative: String) -> Data? {
    return withRoot { root -> Data? in
      var data: Data?
      var coordinationError: NSError?
      NSFileCoordinator().coordinate(readingItemAt: root.appendingPathComponent(relative), options: [], error: &coordinationError) { url in
        data = try? Data(contentsOf: url)
      }
      return data
    } ?? nil
  }

  func writeData(_ relative: String, _ data: Data) -> String {
    return withRoot { root -> String in
      let target = root.appendingPathComponent(relative)
      var failure = ""
      var coordinationError: NSError?
      NSFileCoordinator().coordinate(writingItemAt: target, options: .forReplacing, error: &coordinationError) { url in
        do {
          try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
          try data.write(to: url, options: .atomic)
        } catch {
          failure = error.localizedDescription
        }
      }
      if let coordinationError { return coordinationError.localizedDescription }
      return failure
    } ?? "cartella del vault non scelta"
  }

  func mkdir(_ relative: String) -> String {
    return withRoot { root -> String in
      do {
        try FileManager.default.createDirectory(at: root.appendingPathComponent(relative), withIntermediateDirectories: true)
        return ""
      } catch {
        return error.localizedDescription
      }
    } ?? "cartella del vault non scelta"
  }

  func remove(_ relative: String) -> String {
    return withRoot { root -> String in
      let target = root.appendingPathComponent(relative)
      var failure = ""
      var coordinationError: NSError?
      NSFileCoordinator().coordinate(writingItemAt: target, options: .forDeleting, error: &coordinationError) { url in
        do {
          if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        } catch {
          failure = error.localizedDescription
        }
      }
      if let coordinationError { return coordinationError.localizedDescription }
      return failure
    } ?? "cartella del vault non scelta"
  }

  func rename(_ from: String, _ to: String) -> String {
    return withRoot { root -> String in
      let source = root.appendingPathComponent(from)
      let target = root.appendingPathComponent(to)
      var failure = ""
      var coordinationError: NSError?
      NSFileCoordinator().coordinate(writingItemAt: source, options: .forMoving, writingItemAt: target, options: .forReplacing, error: &coordinationError) { a, b in
        do {
          try FileManager.default.createDirectory(at: b.deletingLastPathComponent(), withIntermediateDirectories: true)
          try FileManager.default.moveItem(at: a, to: b)
        } catch {
          failure = error.localizedDescription
        }
      }
      if let coordinationError { return coordinationError.localizedDescription }
      return failure
    } ?? "cartella del vault non scelta"
  }
}
