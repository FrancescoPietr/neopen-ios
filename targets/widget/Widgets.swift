import AppIntents
import SwiftUI
import WidgetKit

// Three widgets in every size (home screen and lock screen): Calendario, Attività, Agenda (both), plus the
// Live Activities. Tasks can be ticked right on the widget (iOS 17).

@main
struct NeoWidgets: WidgetBundle {
  var body: some Widget {
    CalendarWidget()
    TasksWidget()
    AgendaWidget()
    NeoLiveActivity()
  }
}

// ---------------------------------------------------------------- timeline

struct NeoEntry: TimelineEntry {
  let date: Date
  let data: WData
}

struct NeoProvider: TimelineProvider {
  func placeholder(in context: Context) -> NeoEntry { NeoEntry(date: Date(), data: .sample) }

  func getSnapshot(in context: Context, completion: @escaping (NeoEntry) -> Void) {
    completion(NeoEntry(date: Date(), data: SharedFiles.load() ?? .sample))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<NeoEntry>) -> Void) {
    let now = Date()
    let data = SharedFiles.load() ?? .sample
    // a new entry when something starts or ends in the next hours, and at midnight
    var times: [Date] = [now]
    for e in data.events where !e.allDay {
      for t in [e.startDate, e.endDate] where t > now && t < now.addingTimeInterval(12 * 3600) { times.append(t) }
    }
    times.append(now.adding(days: 1).startOfDay)
    let entries = Array(Set(times)).sorted().prefix(24).map { NeoEntry(date: $0, data: data) }
    completion(Timeline(entries: entries, policy: .after(min(now.addingTimeInterval(30 * 60), entries.last?.date ?? now))))
  }
}

// ---------------------------------------------------------------- ticking a task on the widget

struct ToggleTaskIntent: AppIntent {
  static var title: LocalizedStringResource = "Spunta attività"
  @Parameter(title: "Attività") var key: String

  init() {}
  init(key: String) { self.key = key }

  func perform() async throws -> some IntentResult {
    guard var data = SharedFiles.load(), let i = data.tasks.firstIndex(where: { $0.key == key }) else { return .result() }
    data.tasks[i].done.toggle()
    SharedFiles.save(data)
    SharedFiles.addToggle(key: key, done: data.tasks[i].done)
    return .result()
  }
}

// ---------------------------------------------------------------- the month of the Agenda widget: arrows and switch

struct MonthStepIntent: AppIntent {
  static var title: LocalizedStringResource = "Cambia mese"
  static var isDiscoverable: Bool = false
  /// -1 / +1: one month back / ahead; 0: back to this month.
  @Parameter(title: "Passo") var step: Int

  init() {}
  init(step: Int) { self.step = step }

  func perform() async throws -> some IntentResult {
    var s = WState.load()
    let now = Date()
    s.offset = step == 0 ? 0 : s.monthOffset(now: now) + step
    s.day = ymd(now)
    s.save()
    return .result()
  }
}

struct AgendaModeIntent: AppIntent {
  static var title: LocalizedStringResource = "Mese o lista"
  static var isDiscoverable: Bool = false
  @Parameter(title: "Grandezza") var size: String

  init() {}
  init(size: String) { self.size = size }

  func perform() async throws -> some IntentResult {
    var s = WState.load()
    s.list[size] = !(s.list[size] ?? false)
    if s.list[size] == true { s.offset = 0 }
    s.save()
    return .result()
  }
}

/// A small drawn symbol: your drawing when there is one, otherwise the provisional one (100 × 100).
struct Glyph: View {
  let theme: Theme
  let id: String
  let fallback: [[CGPoint]]
  var color: Color? = nil
  var body: some View {
    let drawn = theme.strokes(id)
    StrokesShape(strokes: drawn ?? fallback, fit: drawn != nil)
      .stroke(color ?? theme.ink, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
  }
}

private func pts(_ p: [(CGFloat, CGFloat)]) -> [CGPoint] { p.map { CGPoint(x: $0.0, y: $0.1) } }
let glyphPrev = [pts([(62, 18), (34, 50), (62, 82)])]
let glyphNext = [pts([(38, 18), (66, 50), (38, 82)])]
let glyphList = [pts([(14, 24)]), pts([(30, 24), (88, 24)]), pts([(14, 50)]), pts([(30, 50), (80, 50)]), pts([(14, 76)]), pts([(30, 76), (86, 76)])]
let glyphMonth = [
  pts([(12, 20), (88, 20), (88, 88), (12, 88), (12, 20)]), pts([(12, 38), (88, 38)]), pts([(32, 10), (32, 28)]), pts([(68, 10), (68, 28)]),
  pts([(32, 55)]), pts([(50, 55)]), pts([(68, 55)]), pts([(32, 72)]), pts([(50, 72)]),
]

/// The button that switches the Agenda widget between the month and the list of today.
struct ModeButton: View {
  let theme: Theme
  let size: String
  /// What it switches to.
  let toList: Bool
  var body: some View {
    Button(intent: AgendaModeIntent(size: size)) {
      Glyph(theme: theme, id: toList ? "log" : "tab.calendar", fallback: toList ? glyphList : glyphMonth, color: theme.soft)
        .frame(width: 13, height: 13)
        .frame(width: 24, height: 22)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// The month like in Fantastical: arrows to move, the week of today marked, today circled, a dot where there is
/// something; tap a day to open it in the app.
struct MiniMonth: View {
  let theme: Theme
  let data: WData
  let now: Date
  let offset: Int
  /// "medium" / "large": which widget the switch button belongs to.
  let size: String
  var body: some View {
    let cal = Calendar.current
    let thisMonth = cal.date(from: cal.dateComponents([.year, .month], from: now)) ?? now
    let first = cal.date(byAdding: .month, value: offset, to: thisMonth) ?? thisMonth
    let lead = (first.weekday + 6) % 7
    let gridStart = first.adding(days: -lead)
    let count = cal.range(of: .day, in: .month, for: first)?.count ?? 30
    let weeks = Int(ceil(Double(lead + count) / 7))
    let month = cal.component(.month, from: first)
    let year = cal.component(.year, from: first)
    let today = ymd(now)
    let big = size == "large"
    VStack(spacing: 0) {
      HStack(spacing: 0) {
        StepButton(theme: theme, step: -1)
        Spacer(minLength: 0)
        Button(intent: MonthStepIntent(step: 0)) {
          HStack(spacing: 4) {
            Text(monthsShort[month - 1].capitalized).font(theme.font(big ? 15 : 13, bold: true)).foregroundStyle(theme.ink)
            Text(String(year)).font(theme.font(big ? 15 : 13, bold: true)).foregroundStyle(theme.accent)
          }
        }
        .buttonStyle(.plain)
        Spacer(minLength: 0)
        StepButton(theme: theme, step: 1)
        ModeButton(theme: theme, size: size, toList: true)
      }
      .frame(height: 22)
      HStack(spacing: 0) {
        ForEach(Array(["L", "M", "M", "G", "V", "S", "D"].enumerated()), id: \.offset) { i, w in
          Text(w).font(theme.font(big ? 10 : 9)).foregroundStyle(i == 6 ? theme.accent : theme.soft).frame(maxWidth: .infinity)
        }
      }
      .padding(.bottom, 1)
      ForEach(0..<weeks, id: \.self) { w in
        let days = (0..<7).map { gridStart.adding(days: w * 7 + $0) }
        HStack(spacing: 0) {
          ForEach(days, id: \.self) { d in
            let key = ymd(d)
            let inMonth = cal.component(.month, from: d) == month
            Link(destination: URL(string: "neotransfer://giorno/\(key)")!) {
              ZStack {
                if key == today { TodayRing(theme: theme).frame(width: big ? 21 : 17, height: big ? 21 : 17) }
                Text("\(d.dayNumber)")
                  .font(theme.font(big ? 12 : 11, bold: key == today))
                  .foregroundStyle(key == today ? theme.accent : inMonth ? theme.ink : theme.faint)
              }
              .frame(maxWidth: .infinity, maxHeight: .infinity)
              .overlay(alignment: .bottom) {
                if inMonth && key != today && data.busy(key) { InkDot(color: theme.soft, size: 2.6).offset(y: big ? 0 : 1) }
              }
            }
          }
        }
        .frame(maxHeight: .infinity)
        .background {
          if days.contains(where: { ymd($0) == today }) {
            RoundedRectangle(cornerRadius: 6).fill(theme.line.opacity(0.35))
          }
        }
      }
    }
  }
}

struct StepButton: View {
  let theme: Theme
  let step: Int
  var body: some View {
    Button(intent: MonthStepIntent(step: step)) {
      Glyph(theme: theme, id: step < 0 ? "nav.prev" : "nav.next", fallback: step < 0 ? glyphPrev : glyphNext)
        .frame(width: 8, height: 12)
        .frame(width: 22, height: 22)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

// ---------------------------------------------------------------- pieces

struct Rule: View {
  let theme: Theme
  var seed = "r"
  var body: some View {
    HandRule(profile: theme.look.profile, seed: seed).stroke(theme.line, style: StrokeStyle(lineWidth: 1, lineCap: .round)).frame(height: 4)
  }
}

struct TaskLine: View {
  let theme: Theme
  let task: WTask
  var size: CGFloat = 14
  var body: some View {
    HStack(spacing: 7) {
      Button(intent: ToggleTaskIntent(key: task.key)) {
        HandCheck(theme: theme, done: task.done, color: task.priority < 4 ? priorityColor(task.priority) : theme.soft, size: size + 2, seed: task.key)
      }
      .buttonStyle(.plain)
      Text(task.title)
        .font(theme.font(size))
        .foregroundStyle(task.done ? theme.faint : theme.ink)
        .strikethrough(task.done, color: theme.faint)
        .lineLimit(1)
      Spacer(minLength: 0)
      if let t = task.time {
        Text(t).font(theme.font(size - 3)).foregroundStyle(theme.soft)
      }
    }
  }
}

func priorityColor(_ p: Int) -> Color {
  switch p {
  case 1: return Color(hex: "#D1453B")
  case 2: return Color(hex: "#EB8909")
  case 3: return Color(hex: "#246FE0")
  default: return Color(hex: "#8E8E93")
  }
}

struct EventLine: View {
  let theme: Theme
  let item: AgendaItem
  var size: CGFloat = 14
  var body: some View {
    HStack(spacing: 7) {
      ColorBar(color: item.event ? Color(hex: item.color) : theme.soft).frame(height: size + 4)
      VStack(alignment: .leading, spacing: 0) {
        Text(item.title).font(theme.font(size)).foregroundStyle(theme.ink).lineLimit(1)
        Text(item.tomorrow ? "domani \(item.time)" : item.time).font(theme.font(size - 3)).foregroundStyle(theme.soft).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
  }
}

struct DayHeader: View {
  let theme: Theme
  let date: Date
  var big: CGFloat = 34
  var body: some View {
    VStack(alignment: .leading, spacing: -2) {
      Text(weekdaysLong[date.weekday]).font(theme.font(13)).foregroundStyle(theme.accent)
      Text("\(date.dayNumber)").font(theme.font(big, bold: true)).foregroundStyle(theme.ink)
    }
  }
}

struct Empty: View {
  let theme: Theme
  let text: String
  var body: some View {
    Text(text).font(theme.font(13)).foregroundStyle(theme.faint)
  }
}

/// The paper behind every widget.
extension View {
  func paper(_ theme: Theme) -> some View {
    containerBackground(for: .widget) { theme.paper }
  }
}

// ---------------------------------------------------------------- Calendario

struct CalendarView: View {
  @Environment(\.widgetFamily) var family
  let entry: NeoEntry
  var body: some View {
    let theme = Theme(look: entry.data.look)
    let items = entry.data.upcoming(now: entry.date)
    switch family {
    case .accessoryInline:
      Text(items.first.map { "\($0.time) \($0.title)" } ?? "Niente in programma").font(theme.font(13))
    case .accessoryCircular:
      VStack(spacing: -2) {
        Text(weekdaysShort[entry.date.weekday]).font(theme.font(11))
        Text("\(entry.date.dayNumber)").font(theme.font(22, bold: true))
      }
      .widgetAccentable()
      .containerBackground(for: .widget) { Color.clear }
    case .accessoryRectangular:
      VStack(alignment: .leading, spacing: 1) {
        if let first = items.first {
          Text(first.title).font(theme.font(15, bold: true)).lineLimit(1).widgetAccentable()
          Text(first.tomorrow ? "domani \(first.time)" : first.time).font(theme.font(13))
          if items.count > 1 { Text("poi \(items[1].title)").font(theme.font(12)).lineLimit(1) }
        } else {
          Text("Niente in programma").font(theme.font(14))
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .containerBackground(for: .widget) { Color.clear }
    case .systemSmall:
      VStack(alignment: .leading, spacing: 4) {
        DayHeader(theme: theme, date: entry.date, big: 30)
        if items.isEmpty { Empty(theme: theme, text: "Niente in programma") }
        ForEach(items.prefix(2)) { EventLine(theme: theme, item: $0, size: 12) }
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .widgetURL(URL(string: "neotransfer://giorno/\(ymd(entry.date))"))
      .paper(theme)
    case .systemMedium:
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading) {
          DayHeader(theme: theme, date: entry.date, big: 40)
          Text(monthsLong[entry.date.monthIndex]).font(theme.font(13)).foregroundStyle(theme.soft)
          Spacer(minLength: 0)
        }
        .frame(width: 84, alignment: .leading)
        VStack(alignment: .leading, spacing: 5) {
          if items.isEmpty { Empty(theme: theme, text: "Niente in programma oggi") }
          ForEach(items.prefix(4)) { EventLine(theme: theme, item: $0, size: 13) }
          Spacer(minLength: 0)
        }
      }
      .widgetURL(URL(string: "neotransfer://giorno/\(ymd(entry.date))"))
      .paper(theme)
    default:
      VStack(alignment: .leading, spacing: 6) {
        MonthGrid(theme: theme, data: entry.data, now: entry.date)
        Rule(theme: theme)
        if items.isEmpty { Empty(theme: theme, text: "Niente in programma") }
        ForEach(items.prefix(3)) { EventLine(theme: theme, item: $0, size: 13) }
        Spacer(minLength: 0)
      }
      .widgetURL(URL(string: "neotransfer://mese"))
      .paper(theme)
    }
  }
}

struct MonthGrid: View {
  let theme: Theme
  let data: WData
  let now: Date
  var body: some View {
    let cal = Calendar.current
    let first = cal.date(from: cal.dateComponents([.year, .month], from: now)) ?? now
    let lead = (first.weekday + 6) % 7
    let count = cal.range(of: .day, in: .month, for: first)?.count ?? 30
    let cells = Array(0..<Int(ceil(Double(lead + count) / 7) * 7))
    let today = ymd(now)
    VStack(alignment: .leading, spacing: 2) {
      HStack {
        Text(monthsLong[now.monthIndex].capitalized).font(theme.font(17, bold: true)).foregroundStyle(theme.ink)
        Spacer()
      }
      HStack(spacing: 0) {
        ForEach(["lun", "mar", "mer", "gio", "ven", "sab", "dom"], id: \.self) { w in
          Text(w).font(theme.font(10)).foregroundStyle(theme.soft).frame(maxWidth: .infinity)
        }
      }
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: 1) {
        ForEach(cells, id: \.self) { i in
          let n = i - lead + 1
          if n >= 1 && n <= count {
            let d = first.adding(days: n - 1)
            let key = ymd(d)
            Link(destination: URL(string: "neotransfer://giorno/\(key)")!) {
              VStack(spacing: 0) {
                ZStack {
                  if key == today { TodayRing(theme: theme).frame(width: 22, height: 22) }
                  Text("\(n)").font(theme.font(12)).foregroundStyle(key == today ? theme.accent : theme.ink)
                }
                .frame(height: 22)
                if data.busy(key) { InkDot(color: theme.ink, size: 3.5) } else { Color.clear.frame(height: 3.5) }
              }
            }
          } else {
            Color.clear.frame(height: 26)
          }
        }
      }
    }
  }
}

struct CalendarWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "NeoCalendar", provider: NeoProvider()) { CalendarView(entry: $0) }
      .configurationDisplayName("Calendario")
      .description("Oggi, i prossimi impegni e il mese.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular, .accessoryInline])
  }
}

// ---------------------------------------------------------------- Attività

struct TasksView: View {
  @Environment(\.widgetFamily) var family
  let entry: NeoEntry
  var body: some View {
    let theme = Theme(look: entry.data.look)
    let groups = entry.data.taskList(now: entry.date)
    let flat = groups.flatMap { $0.tasks }
    let open = entry.data.openToday(now: entry.date)
    switch family {
    case .accessoryInline:
      Text(open == 0 ? "Nessuna attività" : "\(open) da fare oggi").font(theme.font(13))
    case .accessoryCircular:
      VStack(spacing: -2) {
        Text("\(open)").font(theme.font(24, bold: true))
        Text("da fare").font(theme.font(10))
      }
      .widgetAccentable()
      .containerBackground(for: .widget) { Color.clear }
    case .accessoryRectangular:
      VStack(alignment: .leading, spacing: 1) {
        let list = flat.filter { !$0.done }.prefix(3)
        if list.isEmpty { Text("Niente da fare").font(theme.font(14)) }
        ForEach(Array(list)) { t in
          Text("○ \(t.title)").font(theme.font(13)).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .containerBackground(for: .widget) { Color.clear }
    case .systemSmall:
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text("Attività").font(theme.font(16, bold: true)).foregroundStyle(theme.ink)
          Spacer()
          Text("\(open)").font(theme.font(16, bold: true)).foregroundStyle(theme.accent)
        }
        ForEach(Array(flat.prefix(4))) { TaskLine(theme: theme, task: $0, size: 12) }
        if flat.isEmpty { Empty(theme: theme, text: "Niente da fare") }
        Spacer(minLength: 0)
      }
      .widgetURL(URL(string: "neotransfer://attivita"))
      .paper(theme)
    case .systemMedium:
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text("Attività").font(theme.font(16, bold: true)).foregroundStyle(theme.ink)
          Spacer()
          Text(open == 0 ? "tutto fatto" : "\(open) da fare").font(theme.font(13)).foregroundStyle(theme.accent)
        }
        Rule(theme: theme)
        ForEach(Array(flat.prefix(4))) { TaskLine(theme: theme, task: $0, size: 13) }
        if flat.isEmpty { Empty(theme: theme, text: "Niente da fare") }
        Spacer(minLength: 0)
      }
      .widgetURL(URL(string: "neotransfer://attivita"))
      .paper(theme)
    default:
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text("Attività").font(theme.font(20, bold: true)).foregroundStyle(theme.ink)
          Spacer()
          Text(open == 0 ? "tutto fatto" : "\(open) da fare").font(theme.font(14)).foregroundStyle(theme.accent)
        }
        let rows = limitRows(groups, max: 11)
        ForEach(rows) { g in
          Text(g.name).font(theme.font(13, bold: true)).foregroundStyle(g.name == "In ritardo" ? theme.red : theme.soft).padding(.top, 3)
          ForEach(g.tasks) { TaskLine(theme: theme, task: $0, size: 14) }
        }
        if flat.isEmpty { Empty(theme: theme, text: "Niente da fare") }
        Spacer(minLength: 0)
      }
      .widgetURL(URL(string: "neotransfer://attivita"))
      .paper(theme)
    }
  }
}

/// The groups cut so that, headers included, at most `max` rows are shown.
func limitRows(_ groups: [TaskGroup], max: Int) -> [TaskGroup] {
  var left = max
  var out: [TaskGroup] = []
  for g in groups where left > 1 && !g.tasks.isEmpty {
    let n = min(g.tasks.count, left - 1)
    out.append(TaskGroup(name: g.name, tasks: Array(g.tasks.prefix(n))))
    left -= n + 1
  }
  return out
}

struct TasksWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "NeoTasks", provider: NeoProvider()) { TasksView(entry: $0) }
      .configurationDisplayName("Attività")
      .description("Le attività di oggi: spuntale direttamente dal widget.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular, .accessoryInline])
  }
}

// ---------------------------------------------------------------- Agenda (both)

struct AgendaView: View {
  @Environment(\.widgetFamily) var family
  let entry: NeoEntry
  var body: some View {
    let theme = Theme(look: entry.data.look)
    let items = entry.data.upcoming(now: entry.date)
    let tasks = entry.data.taskList(now: entry.date).flatMap { $0.tasks }.filter { !$0.done || $0.date == ymd(entry.date) }
    switch family {
    case .accessoryInline:
      Text(items.first.map { "\($0.time) \($0.title)" } ?? "\(entry.data.openToday(now: entry.date)) da fare").font(theme.font(13))
    case .accessoryCircular:
      VStack(spacing: -2) {
        Text("\(entry.date.dayNumber)").font(theme.font(20, bold: true))
        Text("\(entry.data.openToday(now: entry.date)) da fare").font(theme.font(9))
      }
      .widgetAccentable()
      .containerBackground(for: .widget) { Color.clear }
    case .accessoryRectangular:
      VStack(alignment: .leading, spacing: 1) {
        if let first = items.first { Text("\(first.time) \(first.title)").font(theme.font(14, bold: true)).lineLimit(1).widgetAccentable() }
        ForEach(Array(tasks.filter { !$0.done }.prefix(items.isEmpty ? 3 : 2))) { Text("○ \($0.title)").font(theme.font(13)).lineLimit(1) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .containerBackground(for: .widget) { Color.clear }
    case .systemSmall:
      VStack(alignment: .leading, spacing: 4) {
        DayHeader(theme: theme, date: entry.date, big: 24)
        if let first = items.first { EventLine(theme: theme, item: first, size: 12) }
        ForEach(Array(tasks.prefix(items.isEmpty ? 3 : 2))) { TaskLine(theme: theme, task: $0, size: 12) }
        Spacer(minLength: 0)
      }
      .widgetURL(URL(string: "neotransfer://giorno/\(ymd(entry.date))"))
      .paper(theme)
    case .systemMedium:
      let state = WState.load()
      HStack(alignment: .top, spacing: 14) {
        Group {
          if state.list["medium"] ?? false {
            VStack(alignment: .leading, spacing: 5) {
              HStack(spacing: 0) {
                Text("\(weekdaysShort[entry.date.weekday]) \(entry.date.dayNumber)").font(theme.font(15, bold: true)).foregroundStyle(theme.accent)
                Spacer(minLength: 0)
                ModeButton(theme: theme, size: "medium", toList: false).padding(.top, -3)
              }
              if items.isEmpty { Empty(theme: theme, text: "Niente in programma") }
              ForEach(items.prefix(3)) { EventLine(theme: theme, item: $0, size: 12) }
              Spacer(minLength: 0)
            }
          } else {
            MiniMonth(theme: theme, data: entry.data, now: entry.date, offset: state.monthOffset(now: entry.date), size: "medium")
              .padding(.top, -4)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .leading, spacing: 5) {
          Text("Attività").font(theme.font(15, bold: true)).foregroundStyle(theme.ink)
          if tasks.isEmpty { Empty(theme: theme, text: "Niente da fare") }
          ForEach(Array(tasks.prefix(4))) { TaskLine(theme: theme, task: $0, size: 12) }
          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .widgetURL(URL(string: "neotransfer://giorno/\(ymd(entry.date))"))
      .paper(theme)
    default:
      let state = WState.load()
      HStack(alignment: .top, spacing: 14) {
        VStack(alignment: .leading, spacing: 5) {
          if state.list["large"] ?? false {
            HStack(spacing: 0) {
              DayHeader(theme: theme, date: entry.date, big: 28)
              Spacer(minLength: 0)
              ModeButton(theme: theme, size: "large", toList: false)
            }
            if items.isEmpty { Empty(theme: theme, text: "Niente in programma") }
            ForEach(items.prefix(8)) { EventLine(theme: theme, item: $0, size: 13) }
          } else {
            MiniMonth(theme: theme, data: entry.data, now: entry.date, offset: state.monthOffset(now: entry.date), size: "large")
              .frame(height: 168)
              .padding(.top, -4)
            Rule(theme: theme).padding(.vertical, 2)
            if items.isEmpty { Empty(theme: theme, text: "Niente in programma") }
            ForEach(items.prefix(3)) { EventLine(theme: theme, item: $0, size: 12) }
          }
          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .leading, spacing: 5) {
          Text("Attività").font(theme.font(16, bold: true)).foregroundStyle(theme.ink)
          if tasks.isEmpty { Empty(theme: theme, text: "Niente da fare") }
          ForEach(Array(tasks.prefix(11))) { TaskLine(theme: theme, task: $0, size: 13) }
          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .widgetURL(URL(string: "neotransfer://giorno/\(ymd(entry.date))"))
      .paper(theme)
    }
  }
}

struct AgendaWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "NeoAgenda", provider: NeoProvider()) { AgendaView(entry: $0) }
      .configurationDisplayName("Agenda")
      .description("Il mese (o gli impegni di oggi) e le attività insieme.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular, .accessoryInline])
  }
}
