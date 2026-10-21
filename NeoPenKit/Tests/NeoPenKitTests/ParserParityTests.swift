import Foundation
import XCTest
@testable import NeoPenKit

/// NeoPenKit deve leggere i pacchetti della penna esattamente come il kit ufficiale usato dal plugin di Obsidian.
/// `tools/vectors.json` (pacchetti generati da tools/make_vectors.py, spezzati a caso come le notifiche Bluetooth)
/// e `tools/expected.json` (cosa ne ricava il kit ufficiale, tools/ts_reference.ts).
final class ParserParityTests: XCTestCase {
    static var tools: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("tools")
    }

    func r2(_ x: Double) -> Double { (x * 100).rounded() / 100 }

    func normalize(_ e: PenEvent) -> [[String: Any]] {
        switch e {
        case .version(let v): return [["version": [v.deviceName, v.firmware, v.protocolVersion]]]
        case .settings(let s): return [["settings": [s.locked, s.battery, s.maxForce, s.usedMemory] as [Any]]]
        case .noteList(let n): return [["notes": n.map { [$0.section, $0.owner, $0.note] }]]
        case .pageList(let s, let o, let n, let p): return [["pages": [s, o, n, p] as [Any]]]
        case .offlineStart(let s, let b): return [["start": [s, b]]]
        case .offlineFailure: return [["failure": true]]
        case .powerOff: return [["powerOff": true]]
        case .offlineChunk(_, _, let strokes, _, _):
            return strokes.map { k, s in
                ["offline": k.id, "t": s.t, "tip": s.tip, "color": s.color, "pts": s.pts.map(r2)]
            }
        case .liveStroke(let k, let s): return [["live": k.id, "pts": s.pts.map(r2)]]
        default: return []
        }
    }

    func canon(_ obj: Any) -> String {
        let d = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        return String(decoding: d, as: UTF8.self)
    }

    func testSameResultsAsOfficialKit() throws {
        let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: Self.tools.appendingPathComponent("vectors.json"))) as! [[String: Any]]
        let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: Self.tools.appendingPathComponent("expected.json"))) as! [String: [[String: Any]]]
        XCTAssertEqual(vectors.count, 16)
        var checked = 0
        for v in vectors {
            let name = v["name"] as! String
            let parser = PenParser()
            var got: [[String: Any]] = []
            for hex in v["chunks"] as! [String] {
                var bytes: [UInt8] = []
                var i = hex.startIndex
                while i < hex.endIndex {
                    let j = hex.index(i, offsetBy: 2)
                    bytes.append(UInt8(hex[i..<j], radix: 16)!)
                    i = j
                }
                for e in parser.feed(bytes) { got += normalize(e) }
            }
            for e in parser.flushLive() { got += normalize(e) }
            var want = expected[name]!
            // il tratto in tempo reale si confronta su pagina e punti (l'ora del pen-down non passa dal kit per i tratti "vecchio stile")
            want = want.map { e in
                var e = e
                if e["live"] != nil { e["t"] = nil }
                return e
            }
            // 1) il kit ufficiale decomprime i pacchetti in parallelo e può consegnare i tratti offline in un altro ordine:
            //    si confrontano ordinati per ora del tratto
            // 2) il filtro del kit scarta sempre il primo punto di un tratto in tempo reale (effetto del pen-down "segnaposto"
            //    con x = -1): NeoPenKit lo tiene, quindi qui si toglie prima del confronto
            func key(_ e: [String: Any]) -> String {
                if let t = e["t"] as? NSNumber, e["offline"] != nil { return String(format: "o%020lld", t.int64Value) }
                return ""
            }
            got = got.map { e in
                var e = e
                if e["live"] != nil, let pts = e["pts"] as? [Double] { e["pts"] = Array(pts.dropFirst(3)) }
                return e
            }
            let sortedGot = got.enumerated().sorted { (key($0.element), $0.offset) < (key($1.element), $1.offset) }.map(\.element)
            let sortedWant = want.enumerated().sorted { (key($0.element), $0.offset) < (key($1.element), $1.offset) }.map(\.element)
            XCTAssertEqual(got.count, want.count, "\(name): numero di eventi")
            for (a, b) in zip(sortedGot, sortedWant) {
                XCTAssertEqual(canon(a), canon(b), "\(name)")
            }
            checked += 1
        }
    
        XCTAssertEqual(checked, 16)
    }
}
