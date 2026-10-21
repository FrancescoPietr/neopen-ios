import Foundation

/// Decompressore DEFLATE (RFC 1951) in Swift puro, con o senza intestazione zlib/gzip.
/// La penna manda le pagine della sua memoria compresse con zlib.
public enum Inflate {
    public struct Failure: Error, CustomStringConvertible {
        public let description: String
    }

    /// Come `zlib.unzip` di Node: riconosce da solo l'intestazione gzip o zlib; altrimenti dati "nudi".
    public static func zlibOrRaw(_ data: [UInt8]) throws -> [UInt8] {
        if data.count >= 10, data[0] == 0x1F, data[1] == 0x8B {
            return try raw(Array(data[gzipHeaderLength(data)...]))
        }
        if data.count >= 2, data[0] & 0x0F == 8, (Int(data[0]) * 256 + Int(data[1])) % 31 == 0 {
            return try raw(Array(data[2...]))
        }
        return try raw(data)
    }

    private static func gzipHeaderLength(_ d: [UInt8]) -> Int {
        let flags = d[3]
        var pos = 10
        if flags & 0x04 != 0, d.count > pos + 1 { pos += 2 + Int(d[pos]) + Int(d[pos + 1]) * 256 }
        if flags & 0x08 != 0 { while pos < d.count, d[pos] != 0 { pos += 1 }; pos += 1 }
        if flags & 0x10 != 0 { while pos < d.count, d[pos] != 0 { pos += 1 }; pos += 1 }
        if flags & 0x02 != 0 { pos += 2 }
        return min(pos, d.count)
    }

    // ---------------------------------------------------------------- lettura a bit

    private struct Bits {
        let data: [UInt8]
        var pos = 0
        var bitBuf: UInt32 = 0
        var bitCount = 0

        mutating func need(_ n: Int) throws -> UInt32 {
            while bitCount < n {
                guard pos < data.count else { throw Failure(description: "dati compressi troncati") }
                bitBuf |= UInt32(data[pos]) << UInt32(bitCount)
                pos += 1
                bitCount += 8
            }
            let v = bitBuf & ((1 << UInt32(n)) - 1)
            bitBuf >>= UInt32(n)
            bitCount -= n
            return v
        }

        mutating func alignToByte() {
            bitBuf = 0
            bitCount = 0
        }
    }

    /// Tabella di Huffman canonica: quanti codici per lunghezza e simboli in ordine.
    private struct Huffman {
        var counts = [Int](repeating: 0, count: 16)
        var symbols: [Int] = []

        init(lengths: [Int]) throws {
            for l in lengths { counts[l] += 1 }
            counts[0] = 0
            var left = 1
            for len in 1..<16 {
                left <<= 1
                left -= counts[len]
                if left < 0 { throw Failure(description: "tabella di Huffman non valida") }
            }
            var offs = [Int](repeating: 0, count: 16)
            for len in 1..<15 { offs[len + 1] = offs[len] + counts[len] }
            symbols = [Int](repeating: 0, count: lengths.count)
            for (sym, l) in lengths.enumerated() where l != 0 {
                symbols[offs[l]] = sym
                offs[l] += 1
            }
        }

        func decode(_ b: inout Bits) throws -> Int {
            var code = 0, first = 0, index = 0
            for len in 1..<16 {
                code |= Int(try b.need(1))
                let count = counts[len]
                if code - count < first { return symbols[index + (code - first)] }
                index += count
                first += count
                first <<= 1
                code <<= 1
            }
            throw Failure(description: "codice di Huffman non valido")
        }
    }

    private static let lenBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
    private static let lenExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
    private static let distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
    private static let distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

    private static let fixedLit: Huffman = {
        var l = [Int](repeating: 8, count: 288)
        for i in 144..<256 { l[i] = 9 }
        for i in 256..<280 { l[i] = 7 }
        return try! Huffman(lengths: l)
    }()

    private static let fixedDist: Huffman = try! Huffman(lengths: [Int](repeating: 5, count: 30))

    /// Dati DEFLATE senza intestazione.
    public static func raw(_ data: [UInt8]) throws -> [UInt8] {
        var b = Bits(data: data)
        var out: [UInt8] = []
        out.reserveCapacity(data.count * 4)
        var last = false
        while !last {
            last = try b.need(1) == 1
            let type = try b.need(2)
            switch type {
            case 0:
                b.alignToByte()
                guard b.pos + 4 <= data.count else { throw Failure(description: "blocco non compresso troncato") }
                let len = Int(data[b.pos]) | Int(data[b.pos + 1]) << 8
                let nlen = Int(data[b.pos + 2]) | Int(data[b.pos + 3]) << 8
                guard len == (~nlen & 0xFFFF) else { throw Failure(description: "lunghezza del blocco non valida") }
                b.pos += 4
                guard b.pos + len <= data.count else { throw Failure(description: "blocco non compresso troncato") }
                out.append(contentsOf: data[b.pos..<(b.pos + len)])
                b.pos += len
            case 1:
                try codes(&b, &out, fixedLit, fixedDist)
            case 2:
                let (lit, dist) = try dynamicTables(&b)
                try codes(&b, &out, lit, dist)
            default:
                throw Failure(description: "tipo di blocco non valido")
            }
        }
        return out
    }

    private static func dynamicTables(_ b: inout Bits) throws -> (Huffman, Huffman) {
        let nlen = Int(try b.need(5)) + 257
        let ndist = Int(try b.need(5)) + 1
        let ncode = Int(try b.need(4)) + 4
        guard nlen <= 286, ndist <= 30 else { throw Failure(description: "troppi codici") }
        let order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
        var lengths = [Int](repeating: 0, count: 19)
        for i in 0..<ncode { lengths[order[i]] = Int(try b.need(3)) }
        let lencode = try Huffman(lengths: lengths)
        var all: [Int] = []
        while all.count < nlen + ndist {
            let sym = try lencode.decode(&b)
            if sym < 16 {
                all.append(sym)
            } else {
                var len = 0
                var rep = 0
                if sym == 16 {
                    guard let prev = all.last else { throw Failure(description: "ripetizione senza lunghezza") }
                    len = prev
                    rep = 3 + Int(try b.need(2))
                } else if sym == 17 {
                    rep = 3 + Int(try b.need(3))
                } else {
                    rep = 11 + Int(try b.need(7))
                }
                guard all.count + rep <= nlen + ndist else { throw Failure(description: "troppe lunghezze") }
                all.append(contentsOf: [Int](repeating: len, count: rep))
            }
        }
        guard all[256] != 0 else { throw Failure(description: "manca il codice di fine blocco") }
        return (try Huffman(lengths: Array(all[0..<nlen])), try Huffman(lengths: Array(all[nlen...])))
    }

    private static func codes(_ b: inout Bits, _ out: inout [UInt8], _ lit: Huffman, _ dist: Huffman) throws {
        while true {
            let sym = try lit.decode(&b)
            if sym < 256 {
                out.append(UInt8(sym))
            } else if sym == 256 {
                return
            } else {
                let li = sym - 257
                guard li < 29 else { throw Failure(description: "lunghezza non valida") }
                let len = lenBase[li] + Int(try b.need(lenExtra[li]))
                let ds = try dist.decode(&b)
                guard ds < 30 else { throw Failure(description: "distanza non valida") }
                let d = distBase[ds] + Int(try b.need(distExtra[ds]))
                guard d <= out.count else { throw Failure(description: "distanza oltre l'inizio") }
                let start = out.count - d
                for i in 0..<len { out.append(out[start + i]) }
            }
        }
    }
}
