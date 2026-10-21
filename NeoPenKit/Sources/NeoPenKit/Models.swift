import Foundation

/// Una pagina del quaderno: sezione, proprietario, quaderno, pagina (come nel plugin di Obsidian).
public struct PageKey: Hashable, Codable, Comparable, CustomStringConvertible, Sendable {
    public var section: Int
    public var owner: Int
    public var note: Int
    public var page: Int

    public init(section: Int, owner: Int, note: Int, page: Int) {
        self.section = section
        self.owner = owner
        self.note = note
        self.page = page
    }

    /// Lo stesso id del plugin: "sezione_proprietario_quaderno_pagina" (es. "3_27_746_9").
    public var id: String { "\(section)_\(owner)_\(note)_\(page)" }

    public var isValid: Bool { section >= 0 && owner >= 0 && note > 0 && page >= 0 }

    public var description: String { "\(note)/\(page)" }

    public init?(id: String) {
        let parts = id.split(separator: "_").compactMap { Int($0) }
        guard parts.count == 4 else { return nil }
        self.init(section: parts[0], owner: parts[1], note: parts[2], page: parts[3])
    }

    public static func < (a: PageKey, b: PageKey) -> Bool {
        (a.section, a.owner, a.note, a.page) < (b.section, b.owner, b.note, b.page)
    }
}

/// Un tratto, nello stesso formato del plugin: `pts` = [x, y, pressione, x, y, pressione, ...] in unità Ncode.
public struct Stroke: Codable, Equatable, Sendable {
    /// Momento del pen-down (ms dal 1970, orologio della penna). Serve anche a riconoscere i doppioni.
    public var t: Int64
    /// 0 = penna normale, 1 = gomma.
    public var tip: Int
    /// Colore grezzo mandato dalla penna (ARGB).
    public var color: Int64
    public var pts: [Double]

    public init(t: Int64, tip: Int, color: Int64, pts: [Double]) {
        self.t = t
        self.tip = tip
        self.color = color
        self.pts = pts
    }

    /// Punti con coordinate negative scartati (come `cleanPts` del plugin).
    public func cleaned() -> Stroke {
        var out: [Double] = []
        out.reserveCapacity(pts.count)
        var i = 0
        while i + 2 < pts.count {
            if pts[i] >= 0 && pts[i + 1] >= 0 { out.append(contentsOf: pts[i...(i + 2)]) }
            i += 3
        }
        return Stroke(t: t, tip: tip, color: color, pts: out)
    }

    /// Toglie i punti isolati "sballati" (come il filtro dei tratti in tempo reale del kit ufficiale):
    /// un punto che salta di più di 10 unità rispetto a entrambi i vicini, nella stessa direzione, o fuori dal foglio.
    public func despiked(delta: Double = 10) -> Stroke {
        let n = pointCount
        guard n >= 3 else { return self }
        func x(_ i: Int) -> Double { pts[i * 3] }
        func y(_ i: Int) -> Double { pts[i * 3 + 1] }
        func spike(_ a: Double, _ b: Double, _ c: Double) -> Bool {
            (b > a) == (b > c) && abs(b - a) > delta && abs(b - c) > delta
        }
        var out: [Double] = []
        out.reserveCapacity(pts.count)
        for i in 0..<n {
            let inPage = x(i) >= 1 && y(i) >= 1 && x(i) <= 15070 && y(i) <= 8480
            var bad = !inPage
            if !bad && i > 0 && i < n - 1 {
                bad = spike(x(i - 1), x(i), x(i + 1)) || spike(y(i - 1), y(i), y(i + 1))
            }
            if !bad { out.append(contentsOf: pts[(i * 3)...(i * 3 + 2)]) }
        }
        return Stroke(t: t, tip: tip, color: color, pts: out)
    }

    /// Coordinate arrotondate a 2 decimali (come la pagina Bluefy): pagine più leggere da inviare.
    public func rounded() -> Stroke {
        Stroke(t: t, tip: tip, color: color, pts: pts.map { ($0 * 100).rounded() / 100 })
    }

    public var pointCount: Int { pts.count / 3 }
}

/// Tutto quello che l'app sa di una pagina.
public struct PageRecord: Codable, Equatable, Sendable {
    public var key: PageKey
    /// Tratti ordinati per tempo, senza doppioni (dalla memoria della penna e in tempo reale).
    public var strokes: [Stroke]
    /// Numero di tratti dichiarato dalla penna all'ultimo scaricamento dalla sua memoria (-1 = mai).
    public var penCount: Int
    /// Byte dichiarati dalla penna all'ultimo scaricamento (-1 = mai).
    public var penBytes: Int
    /// Numero di tratti all'ultimo invio riuscito al PC (-1 = mai inviata).
    public var sentCount: Int
    /// Ultima modifica (ms).
    public var updated: Int64

    public init(key: PageKey) {
        self.key = key
        strokes = []
        penCount = -1
        penBytes = -1
        sentCount = -1
        updated = 0
    }

    /// Da inviare: ha tratti e non sono quelli già inviati.
    public var needsUpload: Bool { !strokes.isEmpty && sentCount != strokes.count }

    /// Aggiunge tratti nuovi (riconosciuti dal momento del pen-down). Restituisce quanti erano davvero nuovi.
    @discardableResult
    public mutating func merge(_ incoming: [Stroke]) -> Int {
        var seen = Set(strokes.map { $0.t })
        var added = 0
        for s in incoming where s.pointCount >= 1 && !seen.contains(s.t) {
            strokes.append(s)
            seen.insert(s.t)
            added += 1
        }
        if added > 0 {
            strokes.sort { $0.t < $1.t }
            updated = Int64(Date().timeIntervalSince1970 * 1000)
        }
        return added
    }
}

/// Informazioni mandate dalla penna al collegamento.
public struct PenVersion: Equatable, Sendable {
    public var deviceName = ""
    public var firmware = ""
    public var protocolVersion = ""
    public var subName = ""
    public var mac = ""
}

public struct PenSettings: Equatable, Sendable {
    public var locked = false
    public var retryCount = 0
    public var resetCount = 0
    public var timestamp: Int64 = 0
    public var autoShutdown = 0
    public var maxForce = 0
    public var usedMemory = 0
    public var capPowerOff = false
    public var autoPowerOn = false
    public var beep = false
    public var hover = false
    public var battery = 0
    public var offlineData = false
}
