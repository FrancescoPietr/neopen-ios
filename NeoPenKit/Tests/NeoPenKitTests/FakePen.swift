import Foundation
@testable import NeoPenKit

/// Penna simulata: risponde ai comandi come la Neo Smartpen (protocollo 2), con la memoria offline,
/// le conferme pacchetto per pacchetto, il tempo reale e la password. Per provare `PenSession` senza Bluetooth.
@MainActor
final class FakePen: PenLink {
    weak var session: PenSession?

    /// Memoria offline: pagina → tratti.
    var memory: [PageKey: [Stroke]] = [:]
    var password: String? = nil
    var strokesPerPacket = 3
    /// Si "spegne" dopo aver mandato questo numero di pacchetti offline (nil = mai).
    var powerOffAfterPackets: Int? = nil
    /// Pagine per cui la penna risponde "niente da mandare" le prime N volte.
    var refuseTimes: [PageKey: Int] = [:]
    /// Se vero, la penna non risponde più a niente (per provare i tempi massimi).
    var mute = false

    private(set) var received: [UInt8] = []
    private(set) var acks = 0
    private(set) var endAcks = 0
    private(set) var requestedPages: [PageKey] = []
    private(set) var deletedPages: [PageKey] = []
    private(set) var liveOn = false
    private(set) var clockSet: Int64 = 0
    private var packetsSent = 0
    private var outgoing: [[UInt8]] = []
    private var transferQueue: [[UInt8]] = []
    private var unlocked = true

    init() {}

    // ------------------------------------------------------------ app → penna

    func send(_ bytes: [UInt8]) {
        received += bytes
        // i comandi dell'app: STX cmd [esito solo per 0xA4] lunghezza dati ETX
        var buf: [UInt8]? = nil
        var esc = false
        for b in bytes {
            if b == 0xC0 { buf = []; esc = false }
            else if b == 0xC1 { if let f = buf { handle(f) }; buf = nil }
            else if b == 0x7D && !esc { esc = true }
            else if esc { buf?.append(b ^ 0x20); esc = false }
            else { buf?.append(b) }
        }
    }

    private func handle(_ f: [UInt8]) {
        if mute { return }
        var r = ByteReader(f)
        let cmd = UInt8(r.byte())
        if cmd == 0xA4 { _ = r.byte() }
        _ = r.short()
        switch cmd {
        case 0x01:
            reply(packet(0x81, version()))
        case 0x04:
            reply(packet(0x84, settings()))
        case 0x02:
            let pw = r.string(16)
            let ok = pw == password
            if ok { unlocked = true }
            reply(packet(0x82, [ok ? 1 : 0, ok ? 0 : 1, 10]))
        case 0x05:
            let type = r.byte()
            if type == 1 { clockSet = r.long() }
            reply(packet(0x85, [UInt8(type), 0]))
        case 0x11:
            liveOn = true
            reply(packet(0x91, []))
        case 0x21:
            let notes = Set(memory.keys.map { PageKey(section: $0.section, owner: $0.owner, note: $0.note, page: 0) }).sorted()
            var w = ByteWriterPlain()
            w.short(notes.count)
            for n in notes { w.so(n.section, n.owner); w.int(n.note) }
            reply(packet(0xA1, w.b))
        case 0x22:
            let so = r.sectionOwner()
            let note = r.int()
            let pages = memory.keys.filter { $0.section == so.section && $0.owner == so.owner && $0.note == note }.map(\.page).sorted()
            var w = ByteWriterPlain()
            w.so(so.section, so.owner); w.int(note); w.short(pages.count)
            for p in pages { w.int(p) }
            reply(packet(0xA2, w.b))
        case 0x23:
            let delete = r.byte() == 1
            _ = r.byte()
            let so = r.sectionOwner()
            let note = r.int()
            let n = r.int()
            for _ in 0..<n {
                let key = PageKey(section: so.section, owner: so.owner, note: note, page: r.int())
                requestedPages.append(key)
                startTransfer(key, delete: delete)
            }
        case 0xA4:
            let index = r.short()
            let more = r.byte() == 1
            _ = index
            if more { acks += 1; sendNextPacket() } else { endAcks += 1; transferQueue = [] }
        default:
            break
        }
    }

    // ------------------------------------------------------------ penna → app

    private func reply(_ p: [UInt8]) {
        // a pezzi, come le notifiche Bluetooth, e un attimo dopo
        let chunks = stride(from: 0, to: p.count, by: 20).map { Array(p[$0..<min(p.count, $0 + 20)]) }
        Task { @MainActor [weak self] in
            for c in chunks { self?.session?.receive(c) }
        }
    }

    private func startTransfer(_ key: PageKey, delete: Bool) {
        if let n = refuseTimes[key], n > 0 {
            refuseTimes[key] = n - 1
            reply(packet(0xA3, le32(0) + le32(0) + [0], result: 1))
            return
        }
        let strokes = memory[key] ?? []
        guard unlocked, !strokes.isEmpty else {
            reply(packet(0xA3, le32(0) + le32(0) + [0]))
            return
        }
        let groups = stride(from: 0, to: strokes.count, by: strokesPerPacket).map { Array(strokes[$0..<min(strokes.count, $0 + strokesPerPacket)]) }
        var total = 0
        transferQueue = groups.enumerated().map { idx, g in
            let raw = g.map { encode($0, page: key.page) }.reduce([], +)
            total += raw.count
            let pos: UInt8 = groups.count == 1 ? 2 : (idx == 0 ? 0 : (idx == groups.count - 1 ? 2 : 1))
            var w = ByteWriterPlain()
            w.short(idx); w.b.append(0); w.short(raw.count); w.short(0); w.b.append(pos)
            w.so(key.section, key.owner); w.int(key.note); w.short(g.count)
            w.b += raw
            return packet(0x24, w.b, result: nil)
        }
        if delete { deletedPages.append(key); memory[key] = nil }
        reply(packet(0xA3, le32(strokes.count) + le32(total) + [0]))
        sendNextPacket()
    }

    private func sendNextPacket() {
        guard !transferQueue.isEmpty else { return }
        if let limit = powerOffAfterPackets, packetsSent >= limit {
            transferQueue = []
            Task { @MainActor [weak self] in self?.session?.linkClosed() }
            return
        }
        packetsSent += 1
        reply(transferQueue.removeFirst())
    }

    /// Scrive un tratto in tempo reale (pen-down, pagina, punti, pen-up), come il protocollo 2.18.
    func writeLive(_ key: PageKey, _ s: Stroke) {
        var out: [UInt8] = []
        out += packet(0x69, [1] + le64(s.t) + [UInt8(s.tip)] + le32(Int(s.color)), result: nil)
        var w = ByteWriterPlain()
        w.b.append(2); w.so(key.section, key.owner); w.int(key.note); w.int(key.page)
        out += packet(0x6B, w.b, result: nil)
        var i = 0
        while i + 2 < s.pts.count {
            let x = s.pts[i], y = s.pts[i + 1]
            var d = ByteWriterPlain()
            d.b.append(3); d.b.append(10); d.short(Int(s.pts[i + 2]))
            d.short(Int(x)); d.short(Int(y))
            d.b.append(UInt8((x - x.rounded(.down)) * 100 + 0.5)); d.b.append(UInt8((y - y.rounded(.down)) * 100 + 0.5))
            d.b += [0, 0, 0, 0]
            out += packet(0x6C, d.b, result: nil)
            i += 3
        }
        out += packet(0x6A, [4] + le64(s.t + 500) + [UInt8](repeating: 0, count: 10), result: nil)
        reply(out)
    }

    func shutdown() { reply(packet(0x62, [1], result: nil)) }

    // ------------------------------------------------------------ codifica

    private func version() -> [UInt8] {
        func fixed(_ s: String, _ n: Int) -> [UInt8] { Array((Array(s.utf8) + [UInt8](repeating: 0, count: n)).prefix(n)) }
        var out: [UInt8] = fixed("NWP-F51", 16)
        out += fixed("1.10", 16)
        out += fixed("2.18", 8)
        out += fixed("M1+", 16)
        out += [1, 0, 1, 2, 3, 4, 5, 6, 1, 0, 0, 1, 2]
        return out
    }

    private func settings() -> [UInt8] {
        let locked: UInt8 = (password != nil && !unlocked) ? 1 : 0
        var out: [UInt8] = [locked, 10, 0]
        out += le64(1_792_000_000_000)
        out += [20, 0, 0xFF, 0x03, 12, 1, 1, 0, 0, 77, 1, 0]
        return out
    }

    func lock() { unlocked = password == nil }

    private func encode(_ s: Stroke, page: Int) -> [UInt8] {
        let n = s.pointCount
        var w = ByteWriterPlain()
        w.int(page)
        w.b += le64(s.t - 7) // il primo punto arriva 7 ms dopo il pen-down
        w.b += le64(s.t + 400)
        w.b.append(UInt8(s.tip)); w.b += le32(Int(s.color)); w.short(n)
        for j in 0..<n {
            let x = s.pts[j * 3], y = s.pts[j * 3 + 1], f = s.pts[j * 3 + 2]
            w.b.append(j == 0 ? 7 : 12)
            w.short(Int(f)); w.short(Int(x)); w.short(Int(y))
            w.b.append(UInt8((x - x.rounded(.down)) * 100 + 0.5)); w.b.append(UInt8((y - y.rounded(.down)) * 100 + 0.5))
            w.b += [1, 2, 0, 0, 0, 0, 0]
        }
        return w.b
    }

    private func packet(_ cmd: UInt8, _ data: [UInt8], result: UInt8? = 0) -> [UInt8] {
        var body: [UInt8] = [cmd]
        let hasResult = (cmd >> 4) != 0x6 && cmd != 0x73 && cmd != 0x24 && cmd != 0x32
        if hasResult { body.append(result ?? 0) }
        body += [UInt8(data.count & 0xFF), UInt8(data.count >> 8)]
        body += data
        var out: [UInt8] = [0xC0]
        for b in body {
            if b == 0xC0 || b == 0xC1 || b == 0x7D { out += [0x7D, b ^ 0x20] } else { out.append(b) }
        }
        out.append(0xC1)
        return out
    }
}

struct ByteWriterPlain {
    var b: [UInt8] = []
    mutating func short(_ v: Int) { b += [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)] }
    mutating func int(_ v: Int) { b += le32(v) }
    mutating func so(_ section: Int, _ owner: Int) { b += [UInt8(owner & 0xFF), UInt8((owner >> 8) & 0xFF), UInt8((owner >> 16) & 0xFF), UInt8(section & 0xFF)] }
}

func le32(_ v: Int) -> [UInt8] { (0..<4).map { UInt8((UInt32(truncatingIfNeeded: v) >> (8 * UInt32($0))) & 0xFF) } }
func le64(_ v: Int64) -> [UInt8] { (0..<8).map { UInt8((UInt64(bitPattern: v) >> (8 * UInt64($0))) & 0xFF) } }

/// Tratti finti ma realistici.
func makeStrokes(_ n: Int, from t: Int64, x: Double = 20, y: Double = 30) -> [Stroke] {
    (0..<n).map { i in
        var pts: [Double] = []
        for j in 0..<(8 + i % 5) {
            pts += [x + Double(i) * 3 + Double(j) * 0.4, y + Double(j % 3) * 0.25, Double(300 + j * 10)]
        }
        return Stroke(t: t + Int64(i) * 2000, tip: 0, color: 0xFF000000, pts: pts.map { ($0 * 100).rounded() / 100 })
    }
}
