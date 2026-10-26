import ActivityKit
import Foundation
import WidgetKit

/// What the app shares with its widgets and Live Activities: files in the App Group container
/// (widget.json written by the app, toggles.json written by the widget when you tick a task there).
enum SharedAgenda {
  static var group: String {
    (Bundle.main.object(forInfoDictionaryKey: "NeoAppGroup") as? String) ?? "group.com.francesco.neopen"
  }

  static var dir: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
  }

  static func write(_ name: String, _ text: String) -> String {
    guard let dir else { return "App Group non disponibile (\(group))" }
    do {
      try text.data(using: .utf8)!.write(to: dir.appendingPathComponent(name), options: .atomic)
      return ""
    } catch {
      return error.localizedDescription
    }
  }

  static func read(_ name: String) -> String? {
    guard let dir, let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func reloadWidgets() {
    WidgetCenter.shared.reloadAllTimelines()
  }
}

/// Live Activities from JavaScript (state as JSON, dates in ms since 1970).
enum LiveActivities {
  private static func decode(_ json: String) -> NeoAttributes.ContentState? {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .millisecondsSince1970
    return try? d.decode(NeoAttributes.ContentState.self, from: Data(json.utf8))
  }

  static var enabled: Bool {
    if #available(iOS 16.1, *) { return ActivityAuthorizationInfo().areActivitiesEnabled }
    return false
  }

  /// Starts one (only while the app is on screen). Returns its id, or "errore: …".
  static func start(kind: String, json: String, stale: Double) -> String {
    guard #available(iOS 16.2, *) else { return "errore: serve iOS 16.2" }
    guard let state = decode(json) else { return "errore: dati non validi" }
    do {
      let content = ActivityContent(state: state, staleDate: stale > 0 ? Date(timeIntervalSince1970: stale / 1000) : nil)
      let a = try Activity<NeoAttributes>.request(attributes: NeoAttributes(kind: kind), content: content, pushType: nil)
      return a.id
    } catch {
      return "errore: \(error.localizedDescription)"
    }
  }

  static func update(id: String, json: String, stale: Double) async -> Bool {
    guard #available(iOS 16.2, *), let state = decode(json) else { return false }
    guard let a = Activity<NeoAttributes>.activities.first(where: { $0.id == id }) else { return false }
    await a.update(ActivityContent(state: state, staleDate: stale > 0 ? Date(timeIntervalSince1970: stale / 1000) : nil))
    return true
  }

  /// Ends it; it stays on the lock screen until `dismissAt` (ms; 0 = right away).
  static func end(id: String, dismissAt: Double) async {
    guard #available(iOS 16.2, *) else { return }
    for a in Activity<NeoAttributes>.activities where a.id == id || id.isEmpty {
      let policy: ActivityUIDismissalPolicy = dismissAt > 0 ? .after(Date(timeIntervalSince1970: dismissAt / 1000)) : .immediate
      await a.end(nil, dismissalPolicy: policy)
    }
  }

  static func list() -> [[String: String]] {
    guard #available(iOS 16.2, *) else { return [] }
    return Activity<NeoAttributes>.activities
      .filter { $0.activityState == .active || $0.activityState == .stale }
      .map { ["id": $0.id, "kind": $0.attributes.kind] }
  }
}
