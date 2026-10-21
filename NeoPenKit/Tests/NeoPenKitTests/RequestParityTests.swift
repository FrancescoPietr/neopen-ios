import Foundation
import XCTest
@testable import NeoPenKit

/// I comandi verso la penna devono essere byte per byte quelli del kit ufficiale (tools/requests.json, da tools/ts_requests.ts).
final class RequestParityTests: XCTestCase {
    func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }

    func testSameBytesAsOfficialKit() throws {
        let want = try JSONSerialization.jsonObject(with: Data(contentsOf: ParserParityTests.tools.appendingPathComponent("requests.json"))) as! [String: String]
        let got: [String: [UInt8]] = [
            "version": PenRequest.version(),
            "penStatus": PenRequest.penStatus(),
            "password": PenRequest.password("1234"),
            "setTime": PenRequest.setTime(1792371234567),
            "onlineAll": PenRequest.onlineAllNotes(),
            "noteList": PenRequest.noteList(),
            "pageList": PenRequest.pageList(section: 3, owner: 27, note: 746),
            "pageListEsc": PenRequest.pageList(section: 0xC1, owner: 0x7DC0C1, note: 0xC0),
            "offlineData": PenRequest.offlineData(section: 3, owner: 27, note: 746, pages: [9], delete: false),
            "offlineDataDelete": PenRequest.offlineData(section: 3, owner: 27, note: 746, pages: [5, 6, 0xC0], delete: true),
            "ack": PenRequest.offlineAck(index: 0xC1),
            "ackEnd": PenRequest.offlineAck(index: 3, success: true, end: true),
        ]
        XCTAssertEqual(Set(got.keys), Set(want.keys))
        for (name, bytes) in got { XCTAssertEqual(hex(bytes), want[name], name) }
    }
}
