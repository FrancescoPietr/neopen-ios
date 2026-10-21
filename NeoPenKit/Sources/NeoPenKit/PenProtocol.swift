import Foundation

// Protocollo 2 della Neo Smartpen, portato dal kit web ufficiale (web_pen_sdk, PenRequestV2 e
// PenClientParserV2) che il plugin di Obsidian usa già con questa penna. Solo le parti che servono:
// collegamento, impostazioni, password, orologio, tratti in tempo reale, memoria offline.

enum Cmd {
    static let versionRequest: UInt8 = 0x01
    static let versionResponse: UInt8 = 0x81
    static let passwordRequest: UInt8 = 0x02
    static let passwordResponse: UInt8 = 0x82
    static let settingInfoRequest: UInt8 = 0x04
    static let settingInfoResponse: UInt8 = 0x84
    static let settingChangeRequest: UInt8 = 0x05
    static let settingChangeResponse: UInt8 = 0x85
    static let lowBatteryEvent: UInt8 = 0x61
    static let shutdownEvent: UInt8 = 0x62
    static let onlineDataRequest: UInt8 = 0x11
    static let onlineDataResponse: UInt8 = 0x91
    static let penUpDownEvent: UInt8 = 0x63
    static let paperInfoEvent: UInt8 = 0x64
    static let penDotEvent: UInt8 = 0x65
    static let penErrorEvent: UInt8 = 0x68
    static let newPenDownEvent: UInt8 = 0x69
    static let newPenUpEvent: UInt8 = 0x6A
    static let newPaperInfoEvent: UInt8 = 0x6B
    static let newPenDotEvent: UInt8 = 0x6C
    static let newPenErrorEvent: UInt8 = 0x6D
    static let penHoverEvent: UInt8 = 0x6F
    static let offlineNoteListRequest: UInt8 = 0x21
    static let offlineNoteListResponse: UInt8 = 0xA1
    static let offlinePageListRequest: UInt8 = 0x22
    static let offlinePageListResponse: UInt8 = 0xA2
    static let offlineDataRequest: UInt8 = 0x23
    static let offlineDataResponse: UInt8 = 0xA3
    static let offlinePacket: UInt8 = 0x24
    static let offlinePacketResponse: UInt8 = 0xA4
}

/// Richieste da mandare alla penna (pacchetti già pronti, con STX/ETX ed escape).
public enum PenRequest {
    private static func build(_ cmd: UInt8, _ body: (inout ByteWriter) -> Void) -> [UInt8] {
        var w = ByteWriter()
        w.raw(Frame.stx)
        w.put(cmd)
        body(&w)
        w.raw(Frame.etx)
        return w.bytes
    }

    /// Prima richiesta dopo il collegamento: chi sei? (versione del protocollo supportata: 2.18)
    public static func version() -> [UInt8] {
        build(Cmd.versionRequest) { w in
            w.putShort(42)
            w.putNull(16)
            w.put(0xF0)
            w.put(0x01)
            w.put(Array("0.0.0.0".utf8), length: 16)
            w.put(Array("2.18".utf8), length: 8)
        }
    }

    public static func penStatus() -> [UInt8] {
        build(Cmd.settingInfoRequest) { w in w.putShort(0) }
    }

    public static func password(_ pw: String) -> [UInt8] {
        build(Cmd.passwordRequest) { w in
            w.putShort(16)
            w.put(Array(pw.utf8), length: 16)
        }
    }

    /// Orologio della penna = ora del telefono (serve all'orario dei tratti).
    public static func setTime(_ ms: Int64) -> [UInt8] {
        build(Cmd.settingChangeRequest) { w in
            w.putShort(9)
            w.put(1) // SettingType.TimeStamp
            w.putLong(ms)
        }
    }

    /// Tratti in tempo reale da tutti i quaderni. (Mentre è così collegata, la penna non li salva in memoria.)
    public static func onlineAllNotes() -> [UInt8] {
        build(Cmd.onlineDataRequest) { w in
            w.putShort(2)
            w.put(0xFF)
            w.put(0xFF)
        }
    }

    /// Elenco dei quaderni nella memoria della penna.
    public static func noteList() -> [UInt8] {
        build(Cmd.offlineNoteListRequest) { w in
            w.putShort(4)
            w.put([0xFF, 0xFF, 0xFF, 0xFF], length: 4)
        }
    }

    /// Elenco delle pagine di un quaderno nella memoria della penna.
    public static func pageList(section: Int, owner: Int, note: Int) -> [UInt8] {
        build(Cmd.offlinePageListRequest) { w in
            w.putShort(8)
            w.putSectionOwner(section: section, owner: owner)
            w.putInt(note)
        }
    }

    /// Tratti salvati di alcune pagine. Con `delete` la penna le cancella dalla sua memoria dopo averle mandate.
    public static func offlineData(section: Int, owner: Int, note: Int, pages: [Int], delete: Bool) -> [UInt8] {
        build(Cmd.offlineDataRequest) { w in
            w.putShort(14 + pages.count * 4)
            w.put(delete ? 1 : 2)
            w.put(0x01)
            w.putSectionOwner(section: section, owner: owner)
            w.putInt(note)
            w.putInt(pages.count)
            for p in pages { w.putInt(p) }
        }
    }

    /// Conferma di un pacchetto offline ricevuto. `end` = smetti di mandare.
    public static func offlineAck(index: Int, success: Bool = true, end: Bool = false) -> [UInt8] {
        build(Cmd.offlinePacketResponse) { w in
            w.put(success ? 0 : 1)
            w.putShort(3)
            w.putShort(index)
            w.put(end ? 0 : 1)
        }
    }
}

/// Quello che la penna dice, già interpretato.
public enum PenEvent: Equatable, Sendable {
    case version(PenVersion)
    case settings(PenSettings)
    /// Risposta alla password: ok, oppure tentativi usati / massimi.
    case passwordResult(ok: Bool, retry: Int, reset: Int)
    case settingChanged(type: Int, ok: Bool)
    case lowBattery(Int)
    case powerOff(reason: Int)
    case onlineDataSet(ok: Bool)
    case noteList([PageKey]) // page = 0
    case pageList(section: Int, owner: Int, note: Int, pages: [Int])
    /// Inizio dell'invio dalla memoria: quanti tratti e quanti byte.
    case offlineStart(strokes: Int, bytes: Int)
    /// La penna non ha niente da mandare per quella richiesta (o ha rifiutato).
    case offlineFailure
    /// Un pacchetto di tratti dalla memoria. `index` serve alla conferma; `last` = ultimo pacchetto.
    case offlineChunk(index: Int, key: PageKey?, strokes: [(PageKey, Stroke)], last: Bool, damaged: Bool)
    /// Tratto finito, ricevuto in tempo reale.
    case liveStroke(PageKey, Stroke)
    case unknown(cmd: UInt8, result: Int)

    public static func == (a: PenEvent, b: PenEvent) -> Bool {
        String(describing: a) == String(describing: b)
    }
}

/// Interpreta i byte che arrivano dalla penna e restituisce gli eventi.
public final class PenParser {
    private var frames = FrameParser()

    // tratto in tempo reale in costruzione
    private var liveKey: PageKey? = nil
    private var liveTime: Int64 = -1
    private var liveTip = 0
    private var liveColor: Int64 = 0
    private var liveStroke: Stroke? = nil

    public init() {}

    public func reset() {
        frames = FrameParser()
        liveKey = nil
        liveTime = -1
        liveStroke = nil
    }

    public func feed(_ chunk: [UInt8]) -> [PenEvent] {
        var out: [PenEvent] = []
        for p in frames.feed(chunk) { out.append(contentsOf: parse(p)) }
        return out
    }

    /// La penna si è scollegata a metà tratto: quel tratto si chiude con quello che c'è.
    public func flushLive() -> [PenEvent] {
        finishLive().map { [$0] } ?? []
    }

    func parse(_ packet: Packet) -> [PenEvent] {
        var p = packet
        switch p.cmd {
        case Cmd.versionResponse:
            guard p.result == 0 else { return [.unknown(cmd: p.cmd, result: p.result)] }
            var v = PenVersion()
            v.deviceName = p.reader.string(16)
            v.firmware = p.reader.string(16)
            v.protocolVersion = p.reader.string(8)
            v.subName = p.reader.string(16)
            _ = p.reader.short() // tipo di dispositivo
            v.mac = p.reader.bytes(6).map { String(format: "%02x", $0) }.joined()
            return [.version(v)]

        case Cmd.settingInfoResponse:
            guard p.result == 0 else { return [.unknown(cmd: p.cmd, result: p.result)] }
            var s = PenSettings()
            s.locked = p.reader.byte() == 1
            s.resetCount = p.reader.byte()
            s.retryCount = p.reader.byte()
            s.timestamp = p.reader.long()
            s.autoShutdown = p.reader.short()
            s.maxForce = p.reader.short()
            s.usedMemory = p.reader.byte()
            s.capPowerOff = p.reader.byte() == 1
            s.autoPowerOn = p.reader.byte() == 1
            s.beep = p.reader.byte() == 1
            s.hover = p.reader.byte() == 1
            s.battery = p.reader.byte()
            s.offlineData = p.reader.byte() == 1
            return [.settings(s)]

        case Cmd.passwordResponse:
            let status = p.reader.byte()
            let retry = p.reader.byte()
            let reset = p.reader.byte()
            return [.passwordResult(ok: p.result == 0 && status == 1, retry: retry, reset: reset)]

        case Cmd.settingChangeResponse:
            let type = p.reader.byte()
            let ok = p.reader.byte() == 0
            return [.settingChanged(type: type, ok: ok && p.result == 0)]

        case Cmd.lowBatteryEvent:
            return [.lowBattery(p.reader.byte())]

        case Cmd.shutdownEvent:
            var out = flushLive()
            out.append(.powerOff(reason: p.reader.byte()))
            return out

        case Cmd.onlineDataResponse:
            return [.onlineDataSet(ok: p.result == 0)]

        case Cmd.offlineNoteListResponse:
            guard p.result == 0 else { return [.noteList([])] }
            let n = p.reader.short()
            var notes: [PageKey] = []
            for _ in 0..<n {
                let so = p.reader.sectionOwner()
                let note = p.reader.int()
                notes.append(PageKey(section: so.section, owner: so.owner, note: note, page: 0))
            }
            return [.noteList(notes)]

        case Cmd.offlinePageListResponse:
            let so = p.reader.sectionOwner()
            let note = p.reader.int()
            let n = p.result == 0 ? p.reader.short() : 0
            var pages: [Int] = []
            for _ in 0..<n { pages.append(p.reader.int()) }
            return [.pageList(section: so.section, owner: so.owner, note: note, pages: pages)]

        case Cmd.offlineDataResponse:
            let strokes = p.reader.int()
            let bytes = p.reader.int()
            _ = p.reader.byte() // compresso?
            if p.result != 0 || bytes <= 0 { return [.offlineFailure] }
            return [.offlineStart(strokes: strokes, bytes: bytes)]

        case Cmd.offlinePacket:
            return [parseOfflinePacket(&p)]

        // ---- tempo reale
        case Cmd.newPenDownEvent:
            var out: [PenEvent] = []
            if let e = finishLive() { out.append(e) }
            _ = p.reader.byte() // contatore eventi
            liveTime = p.reader.long()
            liveTip = p.reader.byte() == 0 ? 0 : 1
            liveColor = Int64(p.reader.int())
            liveStroke = Stroke(t: liveTime, tip: liveTip, color: liveColor, pts: [])
            return out

        case Cmd.penUpDownEvent:
            var out: [PenEvent] = []
            let isDown = p.reader.byte() == 0
            if let e = finishLive() { out.append(e) }
            if isDown {
                liveTime = p.reader.long()
                liveTip = p.reader.byte() == 0 ? 0 : 1
                liveColor = Int64(p.reader.int())
                liveStroke = Stroke(t: liveTime, tip: liveTip, color: liveColor, pts: [])
            }
            return out

        case Cmd.newPenUpEvent:
            return finishLive().map { [$0] } ?? []

        case Cmd.paperInfoEvent, Cmd.newPaperInfoEvent:
            if p.cmd == Cmd.newPaperInfoEvent { _ = p.reader.byte() }
            let so = p.reader.sectionOwner()
            let note = p.reader.int()
            let page = p.reader.int()
            let key = PageKey(section: so.section, owner: so.owner, note: note, page: page)
            var out: [PenEvent] = []
            // pagina cambiata a metà tratto: il tratto si chiude e si riparte sulla pagina nuova
            if let cur = liveStroke, !cur.pts.isEmpty, liveKey != key {
                if let e = finishLive() { out.append(e) }
                liveStroke = Stroke(t: liveTime, tip: liveTip, color: liveColor, pts: [])
            }
            liveKey = key
            return out

        case Cmd.penDotEvent, Cmd.newPenDotEvent:
            if p.cmd == Cmd.newPenDotEvent { _ = p.reader.byte() }
            let timeAdd = p.reader.byte()
            let force = p.reader.short()
            let xi = p.reader.short()
            let yi = p.reader.short()
            let fx = p.reader.byte()
            let fy = p.reader.byte()
            if liveTime >= 0 { liveTime += Int64(timeAdd) }
            guard liveKey?.isValid == true else { return [] }
            if liveStroke == nil {
                // punto senza pen-down (il pen-down è andato perso): il tratto parte da qui
                let now = liveTime > 10_000 ? liveTime : Int64(Date().timeIntervalSince1970 * 1000)
                liveStroke = Stroke(t: now, tip: liveTip, color: liveColor, pts: [])
            }
            liveStroke?.pts.append(contentsOf: [Double(xi) + Double(fx) * 0.01, Double(yi) + Double(fy) * 0.01, Double(force)])
            return []

        case Cmd.penHoverEvent, Cmd.penErrorEvent, Cmd.newPenErrorEvent:
            return []

        default:
            return [.unknown(cmd: p.cmd, result: p.result)]
        }
    }

    private func finishLive() -> PenEvent? {
        defer { liveStroke = nil }
        guard let s = liveStroke, let key = liveKey, key.isValid else { return nil }
        let clean = s.cleaned().despiked()
        guard clean.pointCount >= 1 else { return nil }
        return .liveStroke(key, clean)
    }

    private func parseOfflinePacket(_ p: inout Packet) -> PenEvent {
        let index = p.reader.short()
        let compressed = p.reader.byte() == 1
        let before = p.reader.short()
        let after = p.reader.short()
        let position = p.reader.byte() // 0 inizio, 1 in mezzo, 2 fine
        let so = p.reader.sectionOwner()
        let note = p.reader.int()
        let strokeCount = p.reader.short()
        let size = compressed ? after : before
        let raw = size > 0 ? p.reader.bytes(size) : p.reader.rest()
        let last = position == 2
        var payload = raw
        if compressed {
            guard let un = try? Inflate.zlibOrRaw(raw) else {
                return .offlineChunk(index: index, key: nil, strokes: [], last: last, damaged: true)
            }
            payload = un
        }
        var r = ByteReader(payload)
        var strokes: [(PageKey, Stroke)] = []
        var firstKey: PageKey? = nil
        for _ in 0..<strokeCount {
            guard r.remaining >= 27 else { break }
            let page = r.int()
            var time = r.long()
            _ = r.long() // fine del tratto
            let tip = r.byte()
            let color = Int64(r.int())
            let dots = r.short()
            var pts: [Double] = []
            pts.reserveCapacity(dots * 3)
            // come il plugin: il tratto prende l'ora del suo primo punto
            var t0: Int64 = time
            for j in 0..<dots {
                let dt = r.byte()
                let force = r.short()
                let x = r.short()
                let y = r.short()
                let fx = r.byte()
                let fy = r.byte()
                _ = r.byte() // inclinazione x
                _ = r.byte() // inclinazione y
                _ = r.short() // rotazione
                _ = r.short() // riservato
                _ = r.byte() // checksum
                time += Int64(dt)
                if j == 0 { t0 = time }
                pts.append(Double(x) + Double(fx) * 0.01)
                pts.append(Double(y) + Double(fy) * 0.01)
                pts.append(Double(force))
            }
            let key = PageKey(section: so.section, owner: so.owner, note: note, page: page)
            if firstKey == nil { firstKey = key }
            let s = Stroke(t: t0, tip: tip == 0 ? 0 : 1, color: color, pts: pts).cleaned()
            if s.pointCount >= 1 && key.isValid { strokes.append((key, s)) }
        }
        return .offlineChunk(index: index, key: firstKey, strokes: strokes, last: last, damaged: false)
    }
}
