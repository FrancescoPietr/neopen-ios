import Foundation
import NeoPenKit
import SwiftUI
import UIKit

/// Il cervello dell'app: tiene insieme Bluetooth, collegamento con la penna, archivio e invio al PC.
/// Nasce all'avvio (anche quando iOS rilancia l'app in background per la penna).
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    // ---- impostazioni (UserDefaults)
    private let defaults = UserDefaults.standard

    var scriptURL: String {
        get { defaults.string(forKey: "scriptURL") ?? "" }
        set { objectWillChange.send(); defaults.set(newValue, forKey: "scriptURL"); configureUploader() }
    }
    var secret: String {
        get { defaults.string(forKey: "secret") ?? "" }
        set { objectWillChange.send(); defaults.set(newValue, forKey: "secret"); configureUploader() }
    }
    var live: Bool {
        get { defaults.object(forKey: "live") as? Bool ?? true }
        set { objectWillChange.send(); defaults.set(newValue, forKey: "live") }
    }
    var deleteAfterDownload: Bool {
        get { defaults.bool(forKey: "deleteAfterDownload") }
        set { objectWillChange.send(); defaults.set(newValue, forKey: "deleteAfterDownload") }
    }
    var skipUnchanged: Bool {
        get { defaults.bool(forKey: "skipUnchanged") }
        set { objectWillChange.send(); defaults.set(newValue, forKey: "skipUnchanged") }
    }
    var penPassword: String {
        get { defaults.string(forKey: "penPassword") ?? "" }
        set { objectWillChange.send(); defaults.set(newValue, forKey: "penPassword") }
    }

    // ---- stato per lo schermo
    @Published private(set) var bleState: BLEManager.State = .starting
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var battery: Int?
    @Published private(set) var lastSync: Date?
    @Published private(set) var lastProblem: String?
    @Published private(set) var log: [LogLine] = []
    @Published private(set) var tick = 0 // per ridisegnare dopo i cambi dell'archivio

    enum Phase: Equatable {
        case idle
        case handshake
        case syncing(done: Int, total: Int)
        case listening // collegata, in tempo reale
        case needsPassword
    }

    struct LogLine: Identifiable {
        let id = UUID()
        let time: Date
        let text: String
    }

    let store: PageStore
    let uploader: Uploader
    let ble: BLEManager
    private var session: PenSession?
    private var sessionTask: Task<Void, Never>?
    private let logURL: URL

    private init() {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        store = PageStore(folder: support.appendingPathComponent("pages", isDirectory: true))
        uploader = Uploader(store: store)
        ble = BLEManager()
        logURL = fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("registro.txt")

        uploader.log = { [weak self] in self?.write($0) }
        uploader.changed = { [weak self] in self?.tick += 1 }
        uploader.keepAlive = { name in Self.backgroundTask(name) }
        configureUploader()

        ble.log = { [weak self] in self?.write($0) }
        ble.onState = { [weak self] s in self?.bleState = s }
        ble.onReady = { [weak self] in self?.penReady() }
        ble.onData = { [weak self] bytes in self?.session?.receive(bytes) }
        ble.onClosed = { [weak self] in self?.penClosed() }

        write("App avviata (\(UIApplication.shared.applicationState == .background ? "in background" : "in primo piano")).")
        if !store.pendingUploads.isEmpty { uploader.schedule(after: 2) }
    }

    // ---------------------------------------------------------------- penna

    private func penReady() {
        sessionTask?.cancel()
        var o = SessionOptions()
        o.live = live
        o.deleteAfterDownload = deleteAfterDownload
        o.skipUnchanged = skipUnchanged
        o.password = penPassword
        let s = PenSession(store: store, options: o)
        s.link = ble
        s.log = { [weak self] in self?.write($0) }
        s.note = { [weak self] n in self?.sessionNote(n) }
        session = s
        phase = .handshake
        sessionTask = Task { [weak self] in
            guard let self else { return }
            let end = Self.backgroundTask("scaricamento dalla penna")
            defer { end() }
            do {
                try await s.start()
                try await s.syncMemory()
                self.lastSync = Date()
                self.lastProblem = nil
                self.phase = self.live ? .listening : .idle
                await self.uploader.flush()
                // senza tempo reale non serve restare collegati: la penna salva in memoria e la si rilegge alla prossima accensione
                if !self.live { self.ble.disconnect() }
            } catch SessionError.passwordNeeded {
                self.phase = .needsPassword
                self.lastProblem = SessionError.passwordNeeded.description
                self.write(SessionError.passwordNeeded.description)
            } catch {
                if !s.closed {
                    self.lastProblem = String(describing: error)
                    self.write("Collegamento interrotto: \(error)")
                    self.ble.disconnect()
                }
            }
        }
    }

    private func penClosed() {
        session?.linkClosed()
        session = nil
        if phase != .needsPassword { phase = .idle }
        tick += 1
        // quello che è arrivato fin qui parte subito per il PC
        uploader.schedule(after: 1)
    }

    private func sessionNote(_ n: SessionNote) {
        switch n {
        case .authorized(let v, _):
            write("Penna pronta: \(v.deviceName) (firmware \(v.firmware)).")
        case .battery(let b):
            battery = b
        case .syncProgress(let done, let total, _):
            phase = done < total ? .syncing(done: done, total: total) : phase
        case .pageUpdated:
            tick += 1
            uploader.schedule(after: 4)
        case .syncFinished(let pages, let fresh):
            write(pages > 0 ? "Memoria della penna letta: \(pages) pagine con \(fresh) tratti nuovi." : "Memoria della penna letta: niente di nuovo.")
        case .powerOff:
            break
        }
    }

    // ---------------------------------------------------------------- comandi dallo schermo

    func searchPen() { ble.searchPen() }
    func forgetPen() { ble.forgetPen() }

    func sendNow() {
        Task { await uploader.flush() }
    }

    func resendAll() {
        store.markAllUnsent()
        tick += 1
        write("Tutte le pagine ripartono verso il PC.")
        sendNow()
    }

    func testScript() async -> String {
        guard let client = uploader.client as? RelayClient else { return "Mancano indirizzo o chiave dello script." }
        do {
            try await client.ping()
            return "Script raggiungibile: tutto a posto."
        } catch {
            return "Script: \(error)"
        }
    }

    /// Incolla indirizzo e chiave dalla nota «Collegamento iPhone» copiata in Obsidian.
    func pasteConfig() -> Bool {
        guard let text = UIPasteboard.general.string else { return false }
        var found = false
        if let r = text.range(of: #"https://script\.google\.com/[^\s`"']+/exec"#, options: .regularExpression) {
            scriptURL = String(text[r])
            found = true
        }
        if let r = text.range(of: #"\b[0-9a-f]{24,64}\b"#, options: .regularExpression) {
            secret = String(text[r])
            found = true
        }
        return found
    }

    private func configureUploader() {
        let u = scriptURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let s = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        if RelayClient.looksValid(url: u, secret: s), let url = URL(string: u) {
            uploader.client = RelayClient(url: url, secret: s)
        } else {
            uploader.client = nil
        }
    }

    var isConfigured: Bool { uploader.client != nil }

    // ---------------------------------------------------------------- registro

    func write(_ text: String) {
        let line = LogLine(time: Date(), text: text)
        log.append(line)
        if log.count > 400 { log.removeFirst(log.count - 400) }
        let stamp = Self.stamp.string(from: line.time)
        let data = Data("\(stamp)  \(text)\n".utf8)
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile()
            h.write(data)
            try? h.close()
        } else {
            try? data.write(to: logURL)
        }
        // il file non cresce all'infinito
        if let size = try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? Int, size > 1_000_000,
           let all = try? Data(contentsOf: logURL) {
            try? all.suffix(500_000).write(to: logURL)
        }
    }

    var logFile: URL { logURL }

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "dd/MM HH:mm:ss"
        return f
    }()

    // ---------------------------------------------------------------- background

    /// Chiede a iOS qualche decina di secondi in più per finire un lavoro con l'app in background.
    static func backgroundTask(_ name: String) -> @MainActor () -> Void {
        let box = TaskBox()
        box.id = UIApplication.shared.beginBackgroundTask(withName: name) {
            MainActor.assumeIsolated { box.end() }
        }
        return { box.end() }
    }
}

/// Identificatore di un lavoro in background, chiuso una volta sola.
private final class TaskBox: @unchecked Sendable {
    var id: UIBackgroundTaskIdentifier = .invalid

    @MainActor func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
