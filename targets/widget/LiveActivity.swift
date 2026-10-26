import ActivityKit
import SwiftUI
import WidgetKit

// The Live Activity on the lock screen and in the Dynamic Island ("today"):
// - the coming appointments, nearest first, each with how long until it starts (then how long it still lasts);
// - the tasks of today still to do (a task disappears as soon as it is done).
// Older versions had two separate ones ("event", "tasks"): still drawn, in case one is still on screen.

struct NeoLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: NeoAttributes.self) { context in
      LockView(state: context.state, stale: context.isStale)
        .activityBackgroundTint(Color(hex: context.state.paper))
        .activitySystemActionForegroundColor(Color(hex: context.state.ink))
    } dynamicIsland: { context in
      let s = context.state
      let theme = LiveTheme(state: s)
      let next = s.kind == "today" ? s.comingEvents(Date()).first : nil
      let open = s.kind == "today" ? s.items.filter { !$0.done }.count : max(0, s.total - s.done)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          if s.kind == "event" {
            ColorBar(color: Color(hex: s.color)).frame(height: 34).padding(.leading, 6)
          } else if let next {
            ColorBar(color: Color(hex: next.color ?? s.accent)).frame(height: 34).padding(.leading, 6)
          } else {
            Text("\(s.done)/\(s.total)").font(theme.font(16, bold: true)).foregroundStyle(theme.accent).padding(.leading, 6)
          }
        }
        DynamicIslandExpandedRegion(.center) {
          Text(s.kind == "event" ? s.title : next?.title ?? "Oggi").font(theme.font(17, bold: true)).lineLimit(1)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if s.kind == "event" {
            Countdown(state: s, stale: context.isStale, size: 15).padding(.trailing, 6)
          } else if let next {
            EventClock(item: next, theme: theme, size: 15, label: false).padding(.trailing, 6)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          if s.kind == "event" {
            Text(s.subtitle).font(theme.font(14)).foregroundStyle(.secondary).lineLimit(1)
          } else {
            VStack(alignment: .leading, spacing: 2) {
              ForEach(Array(s.comingEvents(Date()).dropFirst().prefix(2)), id: \.self) { e in
                HStack(spacing: 6) {
                  Circle().fill(Color(hex: e.color ?? s.accent)).frame(width: 6, height: 6)
                  Text(e.title).font(theme.font(14)).lineLimit(1)
                  Spacer(minLength: 4)
                  Text(e.time).font(theme.font(12)).foregroundStyle(.secondary)
                }
              }
              ForEach(Array(s.items.filter { !$0.done }.prefix(3)), id: \.self) { item in
                Text("○ \(item.title)").font(theme.font(14)).lineLimit(1)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      } compactLeading: {
        if s.kind == "event" {
          Circle().fill(Color(hex: s.color)).frame(width: 9, height: 9)
        } else if let next {
          Circle().fill(Color(hex: next.color ?? s.accent)).frame(width: 9, height: 9)
        } else {
          Text("✓").font(.system(size: 13, weight: .bold)).foregroundStyle(Color(hex: s.accent))
        }
      } compactTrailing: {
        if s.kind == "event" {
          Countdown(state: s, stale: context.isStale, size: 13).frame(maxWidth: 52)
        } else if let next {
          EventClock(item: next, theme: theme, size: 13, label: false).frame(maxWidth: 56)
        } else {
          Text("\(open)").font(.system(size: 13, weight: .semibold))
        }
      } minimal: {
        if s.kind == "event" {
          Circle().fill(Color(hex: s.color)).frame(width: 9, height: 9)
        } else if let next {
          Circle().fill(Color(hex: next.color ?? s.accent)).frame(width: 9, height: 9)
        } else {
          Text("\(open)").font(.system(size: 12, weight: .semibold))
        }
      }
      .keylineTint(Color(hex: s.accent))
    }
  }
}

extension NeoAttributes.ContentState {
  /// The appointments not over yet, nearest first.
  func comingEvents(_ now: Date) -> [NeoAttributes.Item] {
    (events ?? []).filter { ($0.end ?? .distantFuture) > now }
  }
}

struct LiveTheme {
  let state: NeoAttributes.ContentState
  func font(_ size: CGFloat, bold: Bool = false) -> Font {
    state.hand ? .custom("Fra", size: size * 1.08 + (bold ? 1 : 0)) : .system(size: size, weight: bold ? .semibold : .regular)
  }
  var ink: Color { Color(hex: state.ink) }
  var soft: Color { Color(hex: state.soft) }
  var accent: Color { Color(hex: state.accent) }
}

/// One appointment: how long until it starts, then how long it still lasts.
struct EventClock: View {
  let item: NeoAttributes.Item
  let theme: LiveTheme
  var size: CGFloat = 15
  /// With "tra" / "finisce tra" in front.
  var label = true
  var body: some View {
    let now = Date()
    let start = item.start ?? now
    let end = item.end ?? start
    HStack(spacing: 4) {
      if now < start {
        if label { Text("tra").font(theme.font(size - 3)).foregroundStyle(theme.soft) }
        Text(timerInterval: now...start, countsDown: true)
          .font(theme.font(size, bold: true))
          .monospacedDigit()
          .multilineTextAlignment(.trailing)
          .foregroundStyle(theme.accent)
          .frame(maxWidth: start.timeIntervalSince(now) >= 3600 ? 66 : 46, alignment: .trailing)
      } else if now < end {
        if label { Text("finisce tra").font(theme.font(size - 3)).foregroundStyle(theme.soft) }
        Text(timerInterval: now...end, countsDown: true)
          .font(theme.font(size))
          .monospacedDigit()
          .multilineTextAlignment(.trailing)
          .foregroundStyle(theme.soft)
          .frame(maxWidth: end.timeIntervalSince(now) >= 3600 ? 66 : 46, alignment: .trailing)
      } else {
        Text("finito").font(theme.font(size - 2)).foregroundStyle(theme.soft)
      }
    }
  }
}

/// Before the start: how long until it begins; then: how long it still lasts.
struct Countdown: View {
  let state: NeoAttributes.ContentState
  let stale: Bool
  var size: CGFloat = 15
  var body: some View {
    let theme = LiveTheme(state: state)
    let now = Date()
    if now < state.start && !stale {
      Text(timerInterval: now...state.start, countsDown: true)
        .font(theme.font(size, bold: true))
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
        .foregroundStyle(theme.accent)
    } else if now < state.end {
      Text(timerInterval: now...state.end, countsDown: true)
        .font(theme.font(size))
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
        .foregroundStyle(theme.soft)
    } else {
      Text("finito").font(theme.font(size)).foregroundStyle(theme.soft)
    }
  }
}

struct TaskRow: View {
  let item: NeoAttributes.Item
  let theme: LiveTheme
  var size: CGFloat = 15
  var body: some View {
    HStack(spacing: 8) {
      ZStack {
        WobblyCircle(seed: item.title).stroke(item.done ? theme.soft.opacity(0.5) : theme.soft, lineWidth: 1.4)
        if item.done {
          StrokesShape(strokes: [[CGPoint(x: 16, y: 54), CGPoint(x: 40, y: 78), CGPoint(x: 86, y: 20)]], fit: false)
            .stroke(theme.ink, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
        }
      }
      .frame(width: size, height: size)
      Text(item.title)
        .font(theme.font(size))
        .foregroundStyle(item.done ? theme.soft : theme.ink)
        .strikethrough(item.done)
        .lineLimit(1)
      Spacer(minLength: 0)
      if !item.time.isEmpty { Text(item.time).font(theme.font(size - 2)).foregroundStyle(theme.soft) }
    }
  }
}

struct LockView: View {
  let state: NeoAttributes.ContentState
  let stale: Bool
  var body: some View {
    let theme = LiveTheme(state: state)
    if state.kind == "today" {
      let events = state.comingEvents(Date())
      let tasks = state.items.filter { !$0.done }
      // the lock screen gives at most ~160 points: 5 rows, 4 when there are both
      let both = !events.isEmpty && !tasks.isEmpty
      let evN = min(events.count, both ? max(2, 4 - min(tasks.count, 2)) : 5)
      let taskN = min(tasks.count, (both ? 4 : 5) - evN)
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(state.title).font(theme.font(18, bold: true)).foregroundStyle(theme.ink)
          Spacer()
          Text(state.subtitle).font(theme.font(14)).foregroundStyle(theme.accent)
        }
        ForEach(Array(events.prefix(evN)), id: \.self) { e in
          HStack(spacing: 8) {
            ColorBar(color: Color(hex: e.color ?? state.accent)).frame(height: 18)
            Text(e.title).font(theme.font(15)).foregroundStyle(theme.ink).lineLimit(1)
            Spacer(minLength: 4)
            Text(e.time).font(theme.font(12)).foregroundStyle(theme.soft).lineLimit(1)
            EventClock(item: e, theme: theme, size: 15)
          }
        }
        if both && taskN > 0 {
          HandRule(profile: nil, seed: "live").stroke(theme.soft.opacity(0.35), style: StrokeStyle(lineWidth: 1, lineCap: .round)).frame(height: 3)
        }
        ForEach(Array(tasks.prefix(taskN)), id: \.self) { TaskRow(item: $0, theme: theme) }
        if events.isEmpty && tasks.isEmpty {
          Text("Tutto fatto").font(theme.font(15)).foregroundStyle(theme.soft)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 13)
    } else if state.kind == "event" {
      HStack(spacing: 12) {
        ColorBar(color: Color(hex: state.color)).frame(height: 46)
        VStack(alignment: .leading, spacing: 2) {
          Text(state.title).font(theme.font(19, bold: true)).foregroundStyle(theme.ink).lineLimit(1)
          Text(state.subtitle).font(theme.font(14)).foregroundStyle(theme.soft).lineLimit(1)
        }
        Spacer(minLength: 6)
        VStack(alignment: .trailing, spacing: 2) {
          Text(Date() < state.start && !stale ? "tra" : "finisce tra").font(theme.font(12)).foregroundStyle(theme.soft)
          Countdown(state: state, stale: stale, size: 20).frame(maxWidth: 90, alignment: .trailing)
        }
      }
      .padding(16)
    } else {
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text(state.title).font(theme.font(18, bold: true)).foregroundStyle(theme.ink)
          Spacer()
          Text(state.subtitle).font(theme.font(14)).foregroundStyle(theme.accent)
        }
        ForEach(state.items.filter { !$0.done }, id: \.self) { TaskRow(item: $0, theme: theme) }
        if state.more > 0 { Text("e altre \(state.more)").font(theme.font(13)).foregroundStyle(theme.soft) }
      }
      .padding(16)
    }
  }
}
