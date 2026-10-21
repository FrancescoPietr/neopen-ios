import Foundation
import XCTest
@testable import NeoPenKit

/// Tutto il giro con una penna simulata: collegamento, memoria, conferme, tempo reale, interruzioni.
@MainActor
final class SessionTests: XCTestCase {
    var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("neopen-test-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func connect(_ pen: FakePen, _ store: PageStore, _ opts: SessionOptions = SessionOptions()) -> PenSession {
        let s = PenSession(store: store, options: opts)
        s.link = pen
        pen.session = s
        return s
    }

    let k5 = PageKey(section: 3, owner: 27, note: 746, page: 5)
    let k9 = PageKey(section: 3, owner: 27, note: 746, page: 9)
    let other = PageKey(section: 3, owner: 27, note: 600, page: 2)

    func testFullSyncThenNothingNew() async throws {
        let pen = FakePen()
        pen.memory[k5] = makeStrokes(7, from: 1_792_300_000_000)
        pen.memory[k9] = makeStrokes(10, from: 1_792_370_000_000)
        pen.memory[other] = makeStrokes(2, from: 1_792_100_000_000)
        let store = PageStore(folder: dir)
        let s = connect(pen, store)
        var notes: [String] = []
        s.note = { n in if case .pageUpdated(let k, let c) = n { notes.append("\(k):\(c)") } }

        try await s.start()
        XCTAssertTrue(pen.liveOn, "tempo reale chiesto")
        XCTAssertGreaterThan(pen.clockSet, 1_700_000_000_000, "orologio della penna impostato")
        XCTAssertEqual(s.version?.deviceName, "NWP-F51")

        let r = try await s.syncMemory()
        XCTAssertEqual(r.pages, 3)
        XCTAssertEqual(r.newStrokes, 19)
        // prima il quaderno più alto e l'ultima pagina
        XCTAssertEqual(pen.requestedPages, [k9, k5, other])
        XCTAssertEqual(store.record(k9).strokes, pen.memory[k9])
        XCTAssertEqual(store.record(k5).strokes, pen.memory[k5])
        XCTAssertEqual(store.record(k9).penCount, 10)
        // 10 tratti a 3 per pacchetto = 4 pacchetti, 3 conferme; 7 → 3 pacchetti, 2; 2 → 1, 0
        XCTAssertEqual(pen.acks, 5)
        XCTAssertEqual(pen.endAcks, 0)
        XCTAssertTrue(pen.deletedPages.isEmpty, "senza l'opzione non si cancella niente dalla penna")
        XCTAssertEqual(notes.count, 3)

        // secondo giro: tutto già scaricato
        let again = try await s.syncMemory()
        XCTAssertEqual(again.pages, 0)
        XCTAssertEqual(again.newStrokes, 0)

        // l'archivio sopravvive alla riapertura dell'app
        let reopened = PageStore(folder: dir)
        XCTAssertEqual(reopened.record(k9).strokes.count, 10)
        XCTAssertEqual(reopened.pendingUploads.count, 3)
    }

    func testResumeAfterPowerOffMidTransfer() async throws {
        let pen = FakePen()
        pen.memory[k5] = makeStrokes(4, from: 1_792_300_000_000)
        pen.memory[k9] = makeStrokes(9, from: 1_792_370_000_000)
        pen.powerOffAfterPackets = 2 // a metà della pagina 9 (3 pacchetti)
        let store = PageStore(folder: dir)
        let s = connect(pen, store)
        try await s.start()
        do {
            _ = try await s.syncMemory()
            XCTFail("doveva interrompersi")
        } catch SessionError.closed {}
        XCTAssertTrue(store.record(k9).strokes.isEmpty, "una pagina a metà non si salva a metà")

        // la penna si riaccende: nuovo collegamento, riprende tutto
        pen.powerOffAfterPackets = nil
        let s2 = connect(pen, store)
        try await s2.start()
        let r = try await s2.syncMemory()
        XCTAssertEqual(r.newStrokes, 13)
        XCTAssertEqual(store.record(k9).strokes.count, 9)
        XCTAssertEqual(store.record(k5).strokes.count, 4)
    }

    func testLiveStrokesWhileConnected() async throws {
        let pen = FakePen()
        let store = PageStore(folder: dir)
        let s = connect(pen, store)
        var updates: [PageKey] = []
        s.note = { n in if case .pageUpdated(let k, _) = n { updates.append(k) } }
        try await s.start()
        let live = makeStrokes(3, from: 1_792_400_000_000, x: 40, y: 50)
        for st in live { pen.writeLive(k9, st) }
        try await Task.sleep(nanoseconds: 300_000_000)
        let saved = store.record(k9).strokes
        XCTAssertEqual(saved.count, 3)
        XCTAssertEqual(saved.map(\.t), live.map(\.t))
        XCTAssertEqual(saved[0].pts, live[0].pts)
        XCTAssertEqual(updates, [k9, k9, k9])

        // penna spenta a metà di un tratto: quello che c'è si salva
        pen.shutdown()
        try await Task.sleep(nanoseconds: 100_000_000)
        s.linkClosed()
        XCTAssertTrue(s.closed)
    }

    func testLiveAndOfflineDoNotDuplicate() async throws {
        let pen = FakePen()
        let strokes = makeStrokes(5, from: 1_792_500_000_000)
        pen.memory[k9] = strokes
        let store = PageStore(folder: dir)
        store.add(Array(strokes.prefix(2)), to: k9) // già arrivati prima
        let s = connect(pen, store)
        try await s.start()
        let r = try await s.syncMemory()
        XCTAssertEqual(r.newStrokes, 3)
        XCTAssertEqual(store.record(k9).strokes.count, 5)
    }

    func testPassword() async throws {
        let pen = FakePen()
        pen.password = "4321"
        pen.lock()
        let store = PageStore(folder: dir)

        let noPw = connect(pen, store)
        do {
            try await noPw.start()
            XCTFail("doveva chiedere la password")
        } catch SessionError.passwordNeeded {}

        var wrong = SessionOptions()
        wrong.password = "1111"
        let w = connect(pen, store, wrong)
        do {
            try await w.start()
            XCTFail("password sbagliata")
        } catch SessionError.wrongPassword {}

        var right = SessionOptions()
        right.password = "4321"
        let ok = connect(pen, store, right)
        try await ok.start()
        XCTAssertTrue(pen.liveOn)
    }

    func testEmptyReadIsRetried() async throws {
        let pen = FakePen()
        pen.memory[k9] = makeStrokes(4, from: 1_792_370_000_000)
        pen.refuseTimes[k9] = 1
        let store = PageStore(folder: dir)
        let s = connect(pen, store)
        try await s.start()
        let r = try await s.download(k9)
        XCTAssertEqual(r, .read(count: 4, newStrokes: 4))
        XCTAssertEqual(pen.requestedPages, [k9, k9])
    }

    func testDeleteAfterDownload() async throws {
        let pen = FakePen()
        pen.memory[k9] = makeStrokes(4, from: 1_792_370_000_000)
        let store = PageStore(folder: dir)
        var o = SessionOptions()
        o.deleteAfterDownload = true
        let s = connect(pen, store, o)
        try await s.start()
        _ = try await s.syncMemory()
        XCTAssertEqual(pen.deletedPages, [k9])
        XCTAssertEqual(store.record(k9).strokes.count, 4)
        let again = try await s.syncMemory()
        XCTAssertEqual(again.pages, 0)
        XCTAssertTrue(pen.memory.isEmpty)
    }

    func testSkipUnchangedSendsEndAck() async throws {
        let pen = FakePen()
        pen.memory[k9] = makeStrokes(9, from: 1_792_370_000_000)
        let store = PageStore(folder: dir)
        var o = SessionOptions()
        o.skipUnchanged = true
        let s = connect(pen, store, o)
        try await s.start()
        _ = try await s.syncMemory()
        let acksBefore = pen.acks
        let r = try await s.download(k9)
        XCTAssertEqual(r, .unchanged)
        XCTAssertEqual(pen.endAcks, 1)
        XCTAssertEqual(pen.acks, acksBefore)
    }

    func testTimeoutWhenPenIsMute() async throws {
        let pen = FakePen()
        pen.mute = true
        let s = connect(pen, PageStore(folder: dir))
        let t0 = Date()
        do {
            try await s.start()
            XCTFail("doveva scadere")
        } catch SessionError.timeout {}
        XCTAssertLessThan(Date().timeIntervalSince(t0), 15)
    }
}
