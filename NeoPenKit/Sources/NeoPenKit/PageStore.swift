import Foundation

/// Archivio delle pagine sul telefono: un file JSON per pagina. È la copia di sicurezza di tutto quello che
/// arriva dalla penna, anche prima che vada al PC (e anche se la penna è in tempo reale e non salva niente).
@MainActor
public final class PageStore {
    public let folder: URL
    public private(set) var pages: [String: PageRecord] = [:]

    public init(folder: URL) {
        self.folder = folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        load()
    }

    private func load() {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        let dec = JSONDecoder()
        for f in files where f.pathExtension == "json" {
            if let d = try? Data(contentsOf: f), let r = try? dec.decode(PageRecord.self, from: d) {
                pages[r.key.id] = r
            }
        }
    }

    public func record(_ key: PageKey) -> PageRecord {
        pages[key.id] ?? PageRecord(key: key)
    }

    public func save(_ r: PageRecord) {
        pages[r.key.id] = r
        let url = folder.appendingPathComponent("\(r.key.id).json")
        if let d = try? JSONEncoder().encode(r) {
            try? d.write(to: url, options: .atomic)
        }
    }

    /// Aggiunge tratti a una pagina e la salva. Restituisce quanti erano nuovi.
    @discardableResult
    public func add(_ strokes: [Stroke], to key: PageKey) -> Int {
        var r = record(key)
        let n = r.merge(strokes)
        if n > 0 { save(r) }
        return n
    }

    public var pendingUploads: [PageRecord] {
        pages.values.filter { $0.needsUpload }.sorted { $0.updated > $1.updated }
    }

    /// "Rimanda tutte": al prossimo invio ogni pagina riparte verso il PC.
    public func markAllUnsent() {
        for var r in pages.values {
            r.sentCount = -1
            save(r)
        }
    }

    public var totalStrokes: Int { pages.values.reduce(0) { $0 + $1.strokes.count } }
}
