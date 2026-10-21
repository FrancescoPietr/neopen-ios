import Foundation

/// Manda al PC (tramite lo script Google) le pagine cambiate, una alla volta.
/// Le pagine non inviate restano segnate: si riprova al giro dopo (rete assente, script lento…).
@MainActor
public final class Uploader {
    public let store: PageStore
    public var client: (any PageSender)?
    public var log: (String) -> Void = { _ in }
    /// Chiamata quando cambia qualcosa (per aggiornare lo schermo).
    public var changed: () -> Void = {}
    /// Per finire l'invio anche con l'app in background (nell'app: beginBackgroundTask).
    public var keepAlive: (@MainActor (_ name: String) -> (@MainActor () -> Void)) = { _ in {} }

    public private(set) var busy = false
    public private(set) var lastSuccess: Date?
    public private(set) var lastError: String?
    private var pending: Task<Void, Never>?
    private var again = false

    public init(store: PageStore) {
        self.store = store
    }

    /// Invia fra `delay` secondi (le chiamate ravvicinate si uniscono: scrivendo, un invio ogni pochi secondi).
    public func schedule(after delay: Double = 4) {
        pending?.cancel()
        // anche l'attesa è "lavoro in background": iOS non sospende l'app proprio prima dell'invio
        let end = keepAlive("invio in attesa")
        pending = Task { [weak self] in
            defer { end() }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            await self?.flush()
        }
    }

    /// Invia subito tutte le pagine in attesa.
    public func flush() async {
        if busy {
            again = true
            return
        }
        guard let client else {
            if !store.pendingUploads.isEmpty { lastError = "manca il collegamento allo script (impostazioni)" }
            changed()
            return
        }
        busy = true
        changed()
        let end = keepAlive("invio pagine")
        defer {
            busy = false
            end()
            changed()
        }
        repeat {
            again = false
            for r in store.pendingUploads {
                do {
                    try await client.put(r)
                    var cur = store.record(r.key)
                    // se nel frattempo sono arrivati altri tratti, la pagina resta da inviare
                    cur.sentCount = r.strokes.count
                    store.save(cur)
                    lastSuccess = Date()
                    lastError = nil
                    log("Pagina \(r.key) inviata al PC (\(r.strokes.count) tratti).")
                } catch {
                    lastError = String(describing: error)
                    log("Invio della pagina \(r.key) non riuscito: \(error). Riprovo più tardi.")
                    schedule(after: 60)
                    return
                }
                changed()
            }
        } while again
    }
}
