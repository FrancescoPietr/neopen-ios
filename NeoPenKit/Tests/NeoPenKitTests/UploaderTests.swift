import Foundation
import XCTest
@testable import NeoPenKit

/// Script finto: registra le pagine ricevute, può fallire a comando.
actor FakeScript: PageSender {
    var received: [(String, Int)] = []
    var failNext = 0
    var onPut: (@Sendable () async -> Void)?

    func setFail(_ n: Int) { failNext = n }
    func setOnPut(_ f: @escaping @Sendable () async -> Void) { onPut = f }

    func put(_ r: PageRecord) async throws {
        if let f = onPut { await f() }
        if failNext > 0 {
            failNext -= 1
            throw RelayClient.Failure(description: "rete assente")
        }
        received.append((r.key.id, r.strokes.count))
    }
}

@MainActor
final class UploaderTests: XCTestCase {
    func tempStore() -> PageStore {
        PageStore(folder: FileManager.default.temporaryDirectory.appendingPathComponent("neopen-up-\(UUID().uuidString)"))
    }

    let a = PageKey(section: 3, owner: 27, note: 746, page: 8)
    let b = PageKey(section: 3, owner: 27, note: 746, page: 9)

    func testUploadsChangedPagesOnce() async throws {
        let store = tempStore()
        store.add(makeStrokes(3, from: 1_000), to: a)
        store.add(makeStrokes(5, from: 9_000), to: b)
        let up = Uploader(store: store)
        let script = FakeScript()
        up.client = script
        await up.flush()
        let got = await script.received
        XCTAssertEqual(got.count, 2)
        XCTAssertTrue(store.pendingUploads.isEmpty)
        // niente di nuovo: niente invii
        await up.flush()
        let again = await script.received
        XCTAssertEqual(again.count, 2)
        // un tratto nuovo: solo quella pagina riparte
        store.add(makeStrokes(1, from: 50_000), to: b)
        await up.flush()
        let last = await script.received
        XCTAssertEqual(last.count, 3)
        XCTAssertEqual(last.last?.0, b.id)
        XCTAssertEqual(last.last?.1, 6)
    }

    func testFailureKeepsPagesPending() async throws {
        let store = tempStore()
        store.add(makeStrokes(3, from: 1_000), to: a)
        let up = Uploader(store: store)
        let script = FakeScript()
        await script.setFail(1)
        up.client = script
        await up.flush()
        XCTAssertEqual(store.pendingUploads.count, 1)
        XCTAssertNotNil(up.lastError)
        await up.flush()
        XCTAssertTrue(store.pendingUploads.isEmpty)
        XCTAssertNil(up.lastError)
    }

    func testStrokesArrivingDuringUploadStayPending() async throws {
        let store = tempStore()
        store.add(makeStrokes(3, from: 1_000), to: a)
        let up = Uploader(store: store)
        let script = FakeScript()
        // mentre lo script "riceve", arriva un tratto nuovo sulla stessa pagina
        await script.setOnPut { @Sendable in
            await MainActor.run { _ = store.add(makeStrokes(1, from: 70_000), to: PageKey(section: 3, owner: 27, note: 746, page: 8)) }
        }
        up.client = script
        await up.flush()
        XCTAssertEqual(store.record(a).strokes.count, 4)
        XCTAssertEqual(store.record(a).sentCount, 3)
        XCTAssertEqual(store.pendingUploads.count, 1, "il tratto arrivato durante l'invio resta da inviare")
    }

    func testRequestBodyMatchesScript() async throws {
        var r = PageRecord(key: b)
        r.merge([Stroke(t: 1_792_370_000_123, tip: 0, color: 4_278_190_080, pts: [12.345, 67.891, 512, 13, 68, 600])])
        let client = RelayClient(url: URL(string: "https://script.google.com/macros/s/X/exec")!, secret: "abcdef123456")
        let body = try JSONSerialization.jsonObject(with: client.putBody(r)) as! [String: Any]
        XCTAssertEqual(body["secret"] as? String, "abcdef123456")
        let relay = body["relay"] as! [String: Any]
        XCTAssertEqual(relay["action"] as? String, "put")
        let page = (relay["pages"] as! [[String: Any]])[0]
        XCTAssertEqual(page["id"] as? String, "3_27_746_9")
        XCTAssertEqual(page["count"] as? Int, 1)
        let s = (page["strokes"] as! [[String: Any]])[0]
        XCTAssertEqual((s["t"] as? NSNumber)?.int64Value, 1_792_370_000_123)
        XCTAssertEqual(s["pts"] as? [Double], [12.35, 67.89, 512, 13, 68, 600])
    }

    func testScriptAnswers() async throws {
        XCTAssertNoThrow(try RelayClient.check(Data(#"{"ok":true,"saved":1}"#.utf8)))
        XCTAssertThrowsError(try RelayClient.check(Data(#"{"ok":false,"error":"secret"}"#.utf8))) { e in
            XCTAssertEqual(String(describing: e), "la chiave segreta non corrisponde")
        }
        XCTAssertThrowsError(try RelayClient.check(Data(#"{"results":[]}"#.utf8)))
        XCTAssertThrowsError(try RelayClient.check(Data("<!DOCTYPE html><html>login</html>".utf8))) { e in
            XCTAssertTrue(String(describing: e).contains("Chiunque"))
        }
        XCTAssertTrue(RelayClient.looksValid(url: "https://script.google.com/macros/s/AKfy/exec", secret: "0123456789abcdef"))
        XCTAssertFalse(RelayClient.looksValid(url: "https://example.com/exec", secret: "0123456789abcdef"))
    }
}
