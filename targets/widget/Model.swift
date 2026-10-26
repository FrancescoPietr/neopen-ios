import Foundation
import SwiftUI
import WidgetKit

// What the app writes for its widgets (widget.json in the App Group): the look and the agenda of the coming days.

let appGroup: String = (Bundle.main.object(forInfoDictionaryKey: "NeoAppGroup") as? String) ?? "group.com.francesco.neopen"

struct WLook: Codable {
  var paper: String
  var ink: String
  var soft: String
  var faint: String
  var line: String
  var accent: String
  var red: String
  var hand: Bool
  /// Your drawn line (how it leaves the straight line, see the app's core/drawing.ts).
  var profile: [Double]?
  /// Your drawings (strokes in a 100 × 100 box) for: check.empty, check.done, today, dot, nav.prev, nav.next, log, tab.calendar.
  var drawings: [String: [[[Double]]]]?
}

struct WEvent: Codable, Identifiable, Hashable {
  var key: String
  var title: String
  /// ms since 1970
  var start: Double
  var end: Double
  var allDay: Bool
  var color: String
  var done: Bool
  var id: String { key }
  var startDate: Date { Date(timeIntervalSince1970: start / 1000) }
  var endDate: Date { Date(timeIntervalSince1970: end / 1000) }
}

struct WTask: Codable, Identifiable, Hashable {
  var key: String
  var title: String
  /// YYYY-MM-DD or nil
  var date: String?
  /// HH:MM or nil
  var time: String?
  var done: Bool
  var priority: Int
  var id: String { key }
}

struct WData: Codable {
  var updated: Double
  var look: WLook
  var events: [WEvent]
  var tasks: [WTask]
  /// Days (YYYY-MM-DD) with something still to do, also months away: the dots of the month.
  var taskDays: [String]?
}

/// What you chose on the widget itself: the month shown (arrows) and, for each size of the Agenda widget,
/// whether it shows the month (like Fantastical) or the list of today.
struct WState: Codable {
  var list: [String: Bool] = [:]
  var offset: Int = 0
  var day: String = ""

  static func load() -> WState {
    guard let url = SharedFiles.dir?.appendingPathComponent("widgetstate.json"), let data = try? Data(contentsOf: url),
      let s = try? JSONDecoder().decode(WState.self, from: data)
    else { return WState() }
    return s
  }

  func save() {
    guard let url = SharedFiles.dir?.appendingPathComponent("widgetstate.json"), let data = try? JSONEncoder().encode(self) else { return }
    try? data.write(to: url, options: .atomic)
  }

  /// Months away from this one; the next day it is back on this month.
  func monthOffset(now: Date) -> Int { day == ymd(now) ? offset : 0 }
}

enum SharedFiles {
  static var dir: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) }

  static func load() -> WData? {
    guard let url = dir?.appendingPathComponent("widget.json"), let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(WData.self, from: data)
  }

  static func save(_ w: WData) {
    guard let url = dir?.appendingPathComponent("widget.json"), let data = try? JSONEncoder().encode(w) else { return }
    try? data.write(to: url, options: .atomic)
  }

  /// A task ticked on the widget: the app applies it to the vault when it runs.
  static func addToggle(key: String, done: Bool) {
    guard let url = dir?.appendingPathComponent("toggles.json") else { return }
    var list: [[String: String]] = []
    if let data = try? Data(contentsOf: url), let old = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] { list = old }
    list.append(["key": key, "done": done ? "1" : "0", "at": String(Int(Date().timeIntervalSince1970 * 1000))])
    if let data = try? JSONSerialization.data(withJSONObject: list) { try? data.write(to: url, options: .atomic) }
  }
}

// ---------------------------------------------------------------- dates

func ymd(_ d: Date) -> String {
  let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
  return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}

func hm(_ d: Date) -> String {
  let c = Calendar.current.dateComponents([.hour, .minute], from: d)
  return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
}

let weekdaysShort = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"]
let weekdaysLong = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"]
let monthsShort = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]
let monthsLong = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"]

extension Date {
  var weekday: Int { Calendar.current.component(.weekday, from: self) - 1 }
  var dayNumber: Int { Calendar.current.component(.day, from: self) }
  var monthIndex: Int { Calendar.current.component(.month, from: self) - 1 }
  var startOfDay: Date { Calendar.current.startOfDay(for: self) }
  func adding(days: Int) -> Date { Calendar.current.date(byAdding: .day, value: days, to: self) ?? self }
}

// ---------------------------------------------------------------- what to show

struct TaskGroup: Identifiable {
  var name: String
  var tasks: [WTask]
  var id: String { name }
}

struct AgendaItem: Identifiable, Hashable {
  var id: String
  var title: String
  var time: String
  var color: String
  var done: Bool
  var tomorrow: Bool
  var event: Bool
}

extension WData {
  /// Events and timed tasks still to come today (and tomorrow, if `tomorrow`), in order.
  func upcoming(now: Date, tomorrow: Bool = true) -> [AgendaItem] {
    let today = ymd(now)
    let next = ymd(now.adding(days: 1))
    var out: [(Date, AgendaItem)] = []
    for e in events where !e.done {
      let day = ymd(e.startDate)
      let isToday = day == today || (e.startDate < now && e.endDate > now)
      guard isToday || (tomorrow && day == next) else { continue }
      if !e.allDay && e.endDate <= now { continue }
      let time = e.allDay ? "tutto il giorno" : hm(e.startDate)
      out.append((e.allDay ? e.startDate.startOfDay : e.startDate, AgendaItem(id: e.key, title: e.title, time: time, color: e.color, done: false, tomorrow: !isToday, event: true)))
    }
    for t in tasks where !t.done {
      guard let time = t.time, let date = t.date, date == today || (tomorrow && date == next) else { continue }
      let parts = time.split(separator: ":").compactMap { Int($0) }
      guard parts.count == 2 else { continue }
      var c = Calendar.current.dateComponents([.year, .month, .day], from: date == today ? now : now.adding(days: 1))
      c.hour = parts[0]
      c.minute = parts[1]
      let at = Calendar.current.date(from: c) ?? now
      if date == today && at.addingTimeInterval(3600) < now { continue }
      out.append((at, AgendaItem(id: t.key, title: t.title, time: time, color: look.ink, done: false, tomorrow: date != today, event: false)))
    }
    return out.sorted { $0.0 < $1.0 }.map { $0.1 }
  }

  /// Tasks to do: late first, then today, then tomorrow; done today at the end (struck through).
  func taskList(now: Date) -> [TaskGroup] {
    let today = ymd(now)
    let next = ymd(now.adding(days: 1))
    let sorted = { (l: [WTask]) in l.sorted { ($0.time ?? "99") < ($1.time ?? "99") } }
    let late = tasks.filter { !$0.done && ($0.date ?? "9999") < today }
    let todays = sorted(tasks.filter { $0.date == today && !$0.done }) + tasks.filter { $0.date == today && $0.done }
    let tomorrows = sorted(tasks.filter { $0.date == next && !$0.done })
    var out: [TaskGroup] = []
    if !late.isEmpty { out.append(TaskGroup(name: "In ritardo", tasks: late)) }
    out.append(TaskGroup(name: "Oggi", tasks: todays))
    if !tomorrows.isEmpty { out.append(TaskGroup(name: "Domani", tasks: tomorrows)) }
    return out
  }

  func openToday(now: Date) -> Int {
    let today = ymd(now)
    return tasks.filter { !$0.done && ($0.date ?? "9999") <= today }.count
  }

  func busy(_ day: String) -> Bool {
    events.contains { ymd($0.startDate) == day } || tasks.contains { $0.date == day && !$0.done } || (taskDays?.contains(day) ?? false)
  }
}

// ---------------------------------------------------------------- sample (gallery)

extension WData {
  static var sample: WData {
    let now = Date()
    let at = { (h: Int, m: Int) -> Double in
      var c = Calendar.current.dateComponents([.year, .month, .day], from: now)
      c.hour = h
      c.minute = m
      return (Calendar.current.date(from: c) ?? now).timeIntervalSince1970 * 1000
    }
    let today = ymd(now)
    return WData(
      updated: 0,
      look: WLook(paper: "#F6F0E1", ink: "#1E2A44", soft: "#5E6372", faint: "#9A9A99", line: "#C4C1B8", accent: "#D2453F", red: "#C8372D", hand: true, profile: nil, drawings: nil),
      events: [
        WEvent(key: "1", title: "Riprese video", start: at(10, 0), end: at(12, 0), allDay: false, color: "#0B8043", done: false),
        WEvent(key: "2", title: "Palestra", start: at(18, 0), end: at(19, 30), allDay: false, color: "#8E44AD", done: false),
      ],
      tasks: [
        WTask(key: "a", title: "completare l'app", date: today, time: nil, done: false, priority: 4),
        WTask(key: "b", title: "chiamare Marco", date: today, time: "15:00", done: false, priority: 2),
        WTask(key: "c", title: "fare la spesa", date: today, time: nil, done: true, priority: 4),
      ],
      taskDays: nil
    )
  }
}
