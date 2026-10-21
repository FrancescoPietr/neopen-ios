import Foundation

// Formato dei pacchetti della penna (protocollo 2 del kit ufficiale Neo):
//   STX(0xC0) · comando · [esito] · lunghezza (2 byte, little-endian) · dati · ETX(0xC1)
// I byte 0xC0, 0xC1 e 0x7D dentro il pacchetto si scrivono come 0x7D seguito da (byte XOR 0x20).

enum Frame {
    static let stx: UInt8 = 0xC0
    static let etx: UInt8 = 0xC1
    static let dle: UInt8 = 0x7D
}

/// Costruisce un pacchetto da mandare alla penna (con l'escape dei byte speciali).
struct ByteWriter {
    private(set) var bytes: [UInt8] = []

    /// Byte "grezzo" senza escape (solo per STX ed ETX).
    mutating func raw(_ b: UInt8) { bytes.append(b) }

    mutating func put(_ b: UInt8) {
        if b == Frame.stx || b == Frame.etx || b == Frame.dle {
            bytes.append(Frame.dle)
            bytes.append(b ^ 0x20)
        } else {
            bytes.append(b)
        }
    }

    mutating func put(_ arr: [UInt8], length: Int) {
        for i in 0..<length { put(i < arr.count ? arr[i] : 0) }
    }

    mutating func putNull(_ n: Int) { for _ in 0..<n { put(0) } }

    mutating func putShort(_ v: Int) {
        let u = UInt16(truncatingIfNeeded: v)
        put(UInt8(u & 0xFF))
        put(UInt8(u >> 8))
    }

    mutating func putInt(_ v: Int) {
        let u = UInt32(truncatingIfNeeded: v)
        for i in 0..<4 { put(UInt8((u >> (8 * UInt32(i))) & 0xFF)) }
    }

    mutating func putLong(_ v: Int64) {
        let u = UInt64(bitPattern: v)
        for i in 0..<8 { put(UInt8((u >> (8 * UInt64(i))) & 0xFF)) }
    }

    /// Sezione e proprietario in 4 byte: proprietario nei primi 3 (little-endian), sezione nel quarto.
    mutating func putSectionOwner(section: Int, owner: Int) {
        let o = UInt32(truncatingIfNeeded: owner)
        put(UInt8(o & 0xFF))
        put(UInt8((o >> 8) & 0xFF))
        put(UInt8((o >> 16) & 0xFF))
        put(UInt8(section & 0xFF))
    }
}

/// Legge i dati di un pacchetto (little-endian). Oltre la fine restituisce zeri, come il kit ufficiale.
struct ByteReader {
    let data: [UInt8]
    private(set) var pos = 0

    init(_ data: [UInt8]) { self.data = data }

    var remaining: Int { max(0, data.count - pos) }

    mutating func byte() -> Int {
        defer { pos += 1 }
        return pos < data.count ? Int(data[pos]) : 0
    }

    mutating func bytes(_ n: Int) -> [UInt8] {
        let end = min(data.count, pos + n)
        let out = pos < end ? Array(data[pos..<end]) : []
        pos += n
        return out
    }

    mutating func rest() -> [UInt8] { bytes(remaining) }

    mutating func short() -> Int {
        let b = bytes(2) + [0, 0]
        return Int(b[0]) | (Int(b[1]) << 8)
    }

    mutating func int() -> Int {
        let b = bytes(4) + [0, 0, 0, 0]
        return Int(UInt32(b[0]) | (UInt32(b[1]) << 8) | (UInt32(b[2]) << 16) | (UInt32(b[3]) << 24))
    }

    mutating func long() -> Int64 {
        let b = bytes(8) + [UInt8](repeating: 0, count: 8)
        var v: UInt64 = 0
        for i in 0..<8 { v |= UInt64(b[i]) << (8 * UInt64(i)) }
        return Int64(bitPattern: v)
    }

    /// Testo a lunghezza fissa (gli zeri si tolgono).
    mutating func string(_ n: Int) -> String {
        let b = bytes(n).filter { $0 != 0 }
        return String(decoding: b, as: UTF8.self).trimmingCharacters(in: .whitespaces)
    }

    mutating func sectionOwner() -> (section: Int, owner: Int) {
        let b = bytes(4) + [0, 0, 0, 0]
        return (Int(b[3]), Int(b[0]) + Int(b[1]) * 256 + Int(b[2]) * 65536)
    }
}

/// Pacchetto ricevuto dalla penna.
struct Packet {
    let cmd: UInt8
    /// Esito (0 = ok); -1 se il comando non ne ha uno.
    let result: Int
    let length: Int
    var reader: ByteReader
}

/// Ricompone i pacchetti dai frammenti Bluetooth (un pacchetto può arrivare in più notifiche).
struct FrameParser {
    private var buffer: [UInt8]? = nil
    private var escape = false

    mutating func feed(_ chunk: [UInt8]) -> [Packet] {
        var out: [Packet] = []
        for b in chunk {
            if b == Frame.stx {
                buffer = []
                escape = false
            } else if b == Frame.etx {
                if let buf = buffer, !buf.isEmpty {
                    out.append(Self.packet(from: buf))
                }
                buffer = nil
                escape = false
            } else if b == Frame.dle && !escape {
                escape = true
            } else if escape {
                buffer?.append(b ^ 0x20)
                escape = false
            } else {
                buffer?.append(b)
            }
        }
        return out
    }

    static func packet(from buf: [UInt8]) -> Packet {
        var r = ByteReader(buf)
        let cmd = UInt8(r.byte())
        // gli eventi (0x6X), PDS (0x73), i pacchetti offline (0x24) e firmware (0x32) non hanno il byte di esito
        let hasResult = (cmd >> 4) != 0x6 && cmd != 0x73 && cmd != 0x24 && cmd != 0x32
        let result = hasResult ? r.byte() : -1
        let length = r.short()
        let data = r.rest()
        return Packet(cmd: cmd, result: result, length: length, reader: ByteReader(data))
    }
}
