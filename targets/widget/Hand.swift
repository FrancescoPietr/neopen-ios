import SwiftUI

// The look of the app in the widgets: the handwriting, the colors, and lines/circles/ticks drawn by hand
// (your drawings made with the pen when there are some, otherwise slightly wavy ones).

extension Color {
  init(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    let v = UInt64(s, radix: 16) ?? 0
    self.init(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, opacity: 1)
  }
}

struct Theme {
  let look: WLook
  var paper: Color { Color(hex: look.paper) }
  var ink: Color { Color(hex: look.ink) }
  var soft: Color { Color(hex: look.soft) }
  var faint: Color { Color(hex: look.faint) }
  var line: Color { Color(hex: look.line) }
  var accent: Color { Color(hex: look.accent) }
  var red: Color { Color(hex: look.red) }

  /// The handwriting (or the iPhone's font). The hand font has no bold: a slightly bigger size instead.
  func font(_ size: CGFloat, bold: Bool = false) -> Font {
    look.hand ? .custom("Fra", size: size * 1.08 + (bold ? 1 : 0)) : .system(size: size, weight: bold ? .semibold : .regular)
  }

  func strokes(_ id: String) -> [[CGPoint]]? {
    guard let s = look.drawings?[id], !s.isEmpty else { return nil }
    return s.map { $0.compactMap { $0.count >= 2 ? CGPoint(x: $0[0], y: $0[1]) : nil } }
  }
}

/// Seeded random numbers: the same element always wobbles the same way.
struct Seeded {
  var state: UInt64
  init(_ seed: String) {
    var h: UInt64 = 1469598103934665603
    for b in seed.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
    state = h == 0 ? 1 : h
  }
  mutating func next() -> Double {
    state ^= state << 13
    state ^= state >> 7
    state ^= state << 17
    return Double(state % 10_000) / 10_000
  }
}

/// Strokes in a 100 × 100 box, stretched into the rect.
struct StrokesShape: Shape {
  let strokes: [[CGPoint]]
  var fit = true
  func path(in r: CGRect) -> Path {
    var p = Path()
    let pts = strokes.flatMap { $0 }
    guard !pts.isEmpty else { return p }
    var minX = 0.0, minY = 0.0, maxX = 100.0, maxY = 100.0
    if fit {
      minX = pts.map(\.x).min()!
      maxX = pts.map(\.x).max()!
      minY = pts.map(\.y).min()!
      maxY = pts.map(\.y).max()!
    }
    let sx = r.width / max(1, maxX - minX)
    let sy = r.height / max(1, maxY - minY)
    for s in strokes {
      guard let f = s.first else { continue }
      p.move(to: CGPoint(x: r.minX + (f.x - minX) * sx, y: r.minY + (f.y - minY) * sy))
      if s.count == 1 { p.addLine(to: CGPoint(x: r.minX + (f.x - minX) * sx + 0.1, y: r.minY + (f.y - minY) * sy)) }
      for q in s.dropFirst() { p.addLine(to: CGPoint(x: r.minX + (q.x - minX) * sx, y: r.minY + (q.y - minY) * sy)) }
    }
    return p
  }
}

/// A circle drawn in one go (it goes a little past its start).
struct WobblyCircle: Shape {
  let seed: String
  func path(in r: CGRect) -> Path {
    var g = Seeded(seed)
    let start = g.next() * .pi * 2
    let k1 = g.next() * .pi * 2
    let total = Double.pi * 2 + 0.35
    var p = Path()
    let n = 26
    for i in 0...n {
      let t = Double(i) / Double(n)
      let a = start + t * total
      let k = 1 + 0.06 * sin(a * 2 + k1) + 0.05 * t
      let pt = CGPoint(x: r.midX + cos(a) * r.width / 2 * k, y: r.midY + sin(a) * r.height / 2 * k)
      if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
    }
    return p
  }
}

/// A horizontal line drawn by hand: your drawn line, stretched, or a gentle wave.
struct HandRule: Shape {
  let profile: [Double]?
  let seed: String
  func path(in r: CGRect) -> Path {
    var p = Path()
    let y = r.midY
    let amp = min(r.width, 90)
    if let prof = profile, prof.count > 2 {
      for (i, d) in prof.enumerated() {
        let pt = CGPoint(x: r.minX + r.width * Double(i) / Double(prof.count - 1), y: y + d * amp)
        if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
      }
      return p
    }
    var g = Seeded(seed)
    let phase = g.next() * .pi * 2
    let n = 16
    for i in 0...n {
      let t = Double(i) / Double(n)
      let pt = CGPoint(x: r.minX + r.width * t, y: y + sin(phase + t * .pi * 1.4) * 0.9)
      if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
    }
    return p
  }
}

/// The check box of a task: your circle and tick, or hand-drawn ones.
struct HandCheck: View {
  let theme: Theme
  let done: Bool
  let color: Color
  var size: CGFloat = 16
  let seed: String
  var body: some View {
    ZStack {
      if let c = theme.strokes("check.empty") {
        StrokesShape(strokes: c).stroke(done ? theme.faint : color, style: StrokeStyle(lineWidth: 1.4, lineCap: .round, lineJoin: .round))
      } else {
        WobblyCircle(seed: seed).stroke(done ? theme.faint : color, style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
      }
      if done {
        let tick = theme.strokes("check.done") ?? [[CGPoint(x: 16, y: 54), CGPoint(x: 40, y: 78), CGPoint(x: 86, y: 20)]]
        StrokesShape(strokes: tick, fit: false).stroke(theme.ink, style: StrokeStyle(lineWidth: 1.9, lineCap: .round, lineJoin: .round))
      }
    }
    .frame(width: size, height: size)
  }
}

/// The circle around today's number.
struct TodayRing: View {
  let theme: Theme
  var body: some View {
    if let c = theme.strokes("today") {
      StrokesShape(strokes: c).stroke(theme.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
    } else {
      WobblyCircle(seed: "today").stroke(theme.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
    }
  }
}

/// A small ink blob.
struct InkDot: View {
  let color: Color
  var size: CGFloat = 4
  var body: some View {
    WobblyCircle(seed: "dot").fill(color).frame(width: size, height: size)
  }
}

/// A thin vertical stroke in the color of a calendar.
struct ColorBar: View {
  let color: Color
  var body: some View {
    Capsule().fill(color).frame(width: 3)
  }
}
