import ActivityKit
import SwiftUI
import WidgetKit

// The Live Activities on the lock screen and in the Dynamic Island:
// - "event": the next appointment with a countdown (then how long it still lasts);
// - "tasks": the tasks of today.

struct NeoLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: NeoAttributes.self) { context in
      LockView(state: context.state, stale: context.isStale)
        .activityBackgroundTint(Color(hex: context.state.paper))
        .activitySystemActionForegroundColor(Color(hex: context.state.ink))
    } dynamicIsland: { context in
      let s = context.state
      let theme = LiveTheme(state: s)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          if s.kind == "event" {
            ColorBar(color: Color(hex: s.color)).frame(height: 34).padding(.leading, 6)
          } else {
            Text("\(s.done)/\(s.total)").font(theme.font(16, bold: true)).foregroundStyle(theme.accent).padding(.leading, 6)
          }
        }
        DynamicIslandExpandedRegion(.center) {
          Text(s.kind == "event" ? s.title : "Oggi").font(theme.font(17, bold: true)).lineLimit(1)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if s.kind == "event" {
            Countdown(state: s, stale: context.isStale, size: 15).padding(.trailing, 6)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          if s.kind == "event" {
            Text(s.subtitle).font(theme.font(14)).foregroundStyle(.secondary).lineLimit(1)
          } else {
            VStack(alignment: .leading, spacing: 2) {
              ForEach(s.items.prefix(3), id: \.self) { item in
                Text("\(item.done ? "✓" : "○") \(item.title)").font(theme.font(14)).lineLimit(1).strikethrough(item.done)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      } compactLeading: {
        if s.kind == "event" {
          Circle().fill(Color(hex: s.color)).frame(width: 9, height: 9)
        } else {
          Text("✓").font(.system(size: 13, weight: .bold)).foregroundStyle(Color(hex: s.accent))
        }
      } compactTrailing: {
        if s.kind == "event" {
          Countdown(state: s, stale: context.isStale, size: 13).frame(maxWidth: 52)
        } else {
          Text("\(max(0, s.total - s.done))").font(.system(size: 13, weight: .semibold))
        }
      } minimal: {
        if s.kind == "event" {
          Circle().fill(Color(hex: s.color)).frame(width: 9, height: 9)
        } else {
          Text("\(max(0, s.total - s.done))").font(.system(size: 12, weight: .semibold))
        }
      }
      .keylineTint(Color(hex: s.accent))
    }
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

struct LockView: View {
  let state: NeoAttributes.ContentState
  let stale: Bool
  var body: some View {
    let theme = LiveTheme(state: state)
    if state.kind == "event" {
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
        ForEach(state.items, id: \.self) { item in
          HStack(spacing: 8) {
            ZStack {
              WobblyCircle(seed: item.title).stroke(item.done ? theme.soft.opacity(0.5) : theme.soft, lineWidth: 1.4)
              if item.done {
                StrokesShape(strokes: [[CGPoint(x: 16, y: 54), CGPoint(x: 40, y: 78), CGPoint(x: 86, y: 20)]], fit: false)
                  .stroke(theme.ink, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
              }
            }
            .frame(width: 15, height: 15)
            Text(item.title)
              .font(theme.font(15))
              .foregroundStyle(item.done ? theme.soft : theme.ink)
              .strikethrough(item.done)
              .lineLimit(1)
            Spacer(minLength: 0)
            if !item.time.isEmpty { Text(item.time).font(theme.font(13)).foregroundStyle(theme.soft) }
          }
        }
        if state.more > 0 { Text("e altre \(state.more)").font(theme.font(13)).foregroundStyle(theme.soft) }
      }
      .padding(16)
    }
  }
}
