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
}
