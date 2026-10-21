import Foundation

/// Il canale verso la penna (nell'app è il Bluetooth; nelle prove una penna simulata).
@MainActor
public protocol PenLink: AnyObject {
    func send(_ bytes: [UInt8])
}

public struct SessionOptions: Sendable {
    /// Tratti in tempo reale mentre scrivi (la penna allora non li salva nella sua memoria: li salva il telefono).
    public var live = true
    /// Dopo averle scaricate, la penna cancella le pagine dalla sua memoria (i collegamenti successivi sono più rapidi).
    public var deleteAfterDownload = false
    /// Sperimentale: se la penna dichiara gli stessi tratti e byte dell'ultima volta, si interrompe l'invio della pagina.
    /// (Con Bluefy, dopo un'interruzione la penna smetteva di rispondere: per questo è spento di base.)
    public var skipUnchanged = false
    /// Password della penna, se ne ha una.
    public var password = ""

    public init() {}
}

public enum SessionError: Error, CustomStringConvertible {
    case closed
    case timeout(String)
    case passwordNeeded
    case wrongPassword(retry: Int, reset: Int)

    public var description: String {
        switch self {
        case .closed: return "penna scollegata"
        case .timeout(let what): return "nessuna risposta (\(what))"
        case .passwordNeeded: return "la penna chiede una password: scrivila nelle impostazioni"
        case .wrongPassword(let retry, let reset): return "password sbagliata (\(retry)/\(reset) tentativi)"
        }
    }
}

/// Cosa succede durante un collegamento (per lo schermo, il registro e l'invio al PC).
public enum SessionNote: Sendable {
    case authorized(PenVersion, PenSettings)
    case syncProgress(done: Int, total: Int, key: PageKey?)
    case pageUpdated(PageKey, newStrokes: Int)
    case syncFinished(pages: Int, newStrokes: Int)
    case battery(Int)
    case powerOff
}

/// Un collegamento con la penna: presentazione, autorizzazione, orologio, tempo reale e scaricamento della memoria.
/// Tutto avviene sul main thread; i byte dalla penna entrano da `receive`.
@MainActor
public final class PenSession {
    public weak var link: PenLink?
    public let store: PageStore
    public var options: SessionOptions
    public var log: (String) -> Void = { _ in }
    public var note: (SessionNote) -> Void = { _ in }

    public private(set) var version: PenVersion?
    public private(set) var settings: PenSettings?
    public private(set) var closed = false

    private let parser = PenParser()

    // risposte attese
    private var gotVersion: PenVersion?
    private var gotSettings: PenSettings?
    private var gotPassword: (ok: Bool, retry: Int, reset: Int)?
    private var gotNotes: [PageKey]?
    private var gotPages: [String: [Int]] = [:]
    private var gotOnline: Bool?
    private var transfer: Transfer?

    /// Scaricamento di una pagina dalla memoria della penna.
    final class Transfer {
        let key: PageKey
        var started = false
        var failed = false
        var count = -1
        var bytes = -1
        var strokes: [Stroke] = []
        var done = false
        var damaged = false
        var abort = false
        var lastActivity = Date()
        init(key: PageKey) { self.key = key }
    }

    public init(store: PageStore, options: SessionOptions = SessionOptions()) {
        self.store = store
        self.options = options
    }

    // ---------------------------------------------------------------- byte dalla penna

    public func receive(_ bytes: [UInt8]) {
        for e in parser.feed(bytes) { handle(e) }
    }

    /// Il collegamento Bluetooth si è chiuso.
    public func linkClosed() {
        for e in parser.flushLive() { handle(e) }
        closed = true
    }

    private func handle(_ e: PenEvent) {
        switch e {
        case .version(let v): gotVersion = v
        case .settings(let s):
            gotSettings = s
            settings = s
        case .passwordResult(let ok, let retry, let reset): gotPassword = (ok, retry, reset)
        case .onlineDataSet(let ok): gotOnline = ok
        case .noteList(let n): gotNotes = n
        case .pageList(let s, let o, let n, let pages): gotPages["\(s)_\(o)_\(n)"] = pages
        case .offlineStart(let strokes, let bytes):
            guard let t = transfer else { return }
            t.started = true
            t.count = strokes
            t.bytes = bytes
            t.lastActivity = Date()
            if options.skipUnchanged {
                let r = store.record(t.key)
                if strokes > 0, r.penCount == strokes, r.penBytes == bytes, !r.strokes.isEmpty { t.abort = true }
            }
        case .offlineFailure:
            transfer?.failed = true
        case .offlineChunk(let index, _, let strokes, let last, let damaged):
            guard let t = transfer else {
                // pacchetto inatteso: si conferma comunque, così la penna non resta bloccata
                if !last { link?.send(PenRequest.offlineAck(index: index)) }
                return
            }
            t.lastActivity = Date()
            if t.abort {
                if !last { link?.send(PenRequest.offlineAck(index: index, success: true, end: true)) }
                t.done = true
                return
            }
            if damaged { t.damaged = true }
            for (k, s) in strokes where k == t.key { t.strokes.append(s) }
            if last { t.done = true } else { link?.send(PenRequest.offlineAck(index: index)) }
        case .liveStroke(let key, let stroke):
            let n = store.add([stroke], to: key)
            if n > 0 { note(.pageUpdated(key, newStrokes: n)) }
        case .lowBattery(let b):
            log("Batteria della penna bassa: \(b)%")
            note(.battery(b))
        case .powerOff:
            log("La penna si sta spegnendo.")
            note(.powerOff)
        case .settingChanged, .unknown:
            break
        }
    }

    // ---------------------------------------------------------------- attese

    private func send(_ b: [UInt8]) throws {
        guard !closed, let link else { throw SessionError.closed }
        link.send(b)
    }

    /// Aspetta che `ready` diventi vero (controlla ogni 50 ms).
    private func wait(_ what: String, _ seconds: Double, _ ready: () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !ready() {
            if closed { throw SessionError.closed }
            if Date() > end { throw SessionError.timeout(what) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private func pause(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    // ---------------------------------------------------------------- collegamento

    /// Da chiamare appena le notifiche Bluetooth della penna sono attive.
    public func start() async throws {
        await pause(0.5) // come il kit ufficiale: la penna appena collegata ha bisogno di un attimo
        var v: PenVersion?
        for attempt in 1...3 where v == nil {
            gotVersion = nil
            try send(PenRequest.version())
            do {
                try await wait("presentazione", 4) { gotVersion != nil }
                v = gotVersion
            } catch SessionError.timeout {
                if attempt == 3 { throw SessionError.timeout("la penna non si presenta") }
                log("La penna non ha risposto alla presentazione, riprovo…")
            }
        }
        version = v
        gotSettings = nil
        try send(PenRequest.penStatus())
        try await wait("impostazioni", 6) { gotSettings != nil }
        let s = gotSettings!
        if s.locked {
            guard !options.password.isEmpty else { throw SessionError.passwordNeeded }
            gotPassword = nil
            try send(PenRequest.password(options.password))
            try await wait("password", 6) { gotPassword != nil }
            if gotPassword?.ok != true {
                throw SessionError.wrongPassword(retry: gotPassword?.retry ?? 0, reset: gotPassword?.reset ?? 0)
            }
        }
        try send(PenRequest.setTime(Int64(Date().timeIntervalSince1970 * 1000)))
        note(.authorized(v!, s))
        note(.battery(s.battery))
        if options.live {
            gotOnline = nil
            try send(PenRequest.onlineAllNotes())
            try? await wait("tempo reale", 4) { gotOnline != nil }
            if gotOnline == false { log("La penna non ha accettato il tempo reale: i tratti restano nella sua memoria.") }
        }
    }

    // ---------------------------------------------------------------- memoria della penna

    /// Pagine nella memoria della penna.
    public func listMemory() async throws -> [PageKey] {
        gotNotes = nil
        try send(PenRequest.noteList())
        try await wait("elenco dei quaderni", 10) { gotNotes != nil }
        var out: [PageKey] = []
        for n in gotNotes ?? [] {
            let id = "\(n.section)_\(n.owner)_\(n.note)"
            gotPages[id] = nil
            try send(PenRequest.pageList(section: n.section, owner: n.owner, note: n.note))
            try await wait("pagine del quaderno \(n.note)", 10) { gotPages[id] != nil }
            for p in gotPages[id] ?? [] {
                out.append(PageKey(section: n.section, owner: n.owner, note: n.note, page: p))
            }
        }
        return out.filter { $0.isValid }
    }

    public enum Download: Equatable {
        /// Scaricata: tratti dichiarati e quanti erano nuovi per il telefono.
        case read(count: Int, newStrokes: Int)
        /// Invariata (solo con `skipUnchanged`).
        case unchanged
        /// La penna non l'ha mandata (vuota o rifiuto) anche dopo i tentativi.
        case empty
    }

    /// Scarica una pagina dalla memoria della penna e la unisce all'archivio del telefono.
    /// Le letture vuote si riprovano 2 volte (la penna a volte risponde "non posso" dopo un collegamento interrotto).
    public func download(_ key: PageKey) async throws -> Download {
        for attempt in 0...2 {
            if attempt > 0 {
                log("Pagina \(key): la penna non l'ha mandata, riprovo (\(attempt)/2)…")
                await pause(2.5)
            }
            let t = Transfer(key: key)
            transfer = t
            defer { transfer = nil }
            try send(PenRequest.offlineData(section: key.section, owner: key.owner, note: key.note, pages: [key.page], delete: options.deleteAfterDownload))
            try await wait("inizio della pagina \(key)", 10) { t.started || t.failed }
            if t.failed { continue }
            // fino all'ultimo pacchetto; il tempo massimo riparte a ogni pacchetto
            while !t.done {
                if closed { throw SessionError.closed }
                if Date().timeIntervalSince(t.lastActivity) > 15 { throw SessionError.timeout("la penna ha smesso di mandare la pagina \(key)") }
                if t.failed { break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            if t.abort {
                await pause(0.4)
                return .unchanged
            }
            if t.strokes.isEmpty { continue }
            var r = store.record(key)
            let added = r.merge(t.strokes)
            if !t.damaged {
                r.penCount = t.count
                r.penBytes = t.bytes
            }
            store.save(r)
            if added > 0 { note(.pageUpdated(key, newStrokes: added)) }
            return .read(count: t.count, newStrokes: added)
        }
        return .empty
    }

    /// Scarica tutta la memoria della penna. Prima le pagine mai viste, poi dall'ultima pagina in giù
    /// (quella su cui stai scrivendo arriva per prima). Ogni pagina finisce subito nell'archivio del telefono:
    /// se la penna si spegne a metà, al collegamento dopo si riparte e si ricevono anche le pagine mancanti.
    @discardableResult
    public func syncMemory() async throws -> (pages: Int, newStrokes: Int) {
        let keys = try await listMemory()
        let ordered = keys.sorted { a, b in
            let na = store.pages[a.id] == nil, nb = store.pages[b.id] == nil
            if na != nb { return na }
            if a.note != b.note { return a.note > b.note }
            return a.page > b.page
        }
        log("Nella memoria della penna: \(keys.count) pagine.")
        var changed = 0, fresh = 0
        for (i, key) in ordered.enumerated() {
            note(.syncProgress(done: i, total: ordered.count, key: key))
            switch try await download(key) {
            case .read(_, let n) where n > 0:
                changed += 1
                fresh += n
                log("Pagina \(key): \(n) tratti nuovi.")
            case .read:
                log("Pagina \(key): già scaricata.")
            case .unchanged:
                log("Pagina \(key): invariata, saltata.")
            case .empty:
                log("Pagina \(key): lettura vuota, la riprovo al prossimo collegamento.")
            }
        }
        note(.syncProgress(done: ordered.count, total: ordered.count, key: nil))
        note(.syncFinished(pages: changed, newStrokes: fresh))
        return (changed, fresh)
    }
}
