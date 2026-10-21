import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Chi riceve le pagine (lo script Google; nelle prove uno finto).
public protocol PageSender: Sendable {
    func put(_ r: PageRecord) async throws
}

/// Invio delle pagine allo script Google (lo stesso della pagina Bluefy): il plugin di Obsidian sul PC
/// le preleva da lì e le trascrive. Formato: `{secret, relay: {action: "put", pages: [{id, count, strokes}]}}`.
public struct RelayClient: PageSender, Sendable {
    public var url: URL
    public var secret: String

    public init(url: URL, secret: String) {
        self.url = url
        self.secret = secret
    }

    public struct Failure: Error, CustomStringConvertible {
        public let description: String
    }

    struct PagePayload: Encodable {
        let id: String
        let count: Int
        let strokes: [Stroke]
    }

    struct Body<R: Encodable>: Encodable {
        let secret: String
        let relay: R
    }

    struct Put: Encodable {
        let action = "put"
        let pages: [PagePayload]
    }

    struct Ping: Encodable {
        let action = "ping"
    }

    /// Indirizzo e chiave sembrano giusti?
    public static func looksValid(url: String, secret: String) -> Bool {
        url.hasPrefix("https://script.google.com/") && url.hasSuffix("/exec") && secret.count > 8
    }

    /// Il corpo esatto della richiesta (serve anche alle prove).
    public func putBody(_ r: PageRecord) throws -> Data {
        let page = PagePayload(id: r.key.id, count: r.strokes.count, strokes: r.strokes.map { $0.rounded() })
        return try JSONEncoder().encode(Body(secret: secret, relay: Put(pages: [page])))
    }

    public func put(_ r: PageRecord) async throws {
        try await post(try putBody(r))
    }

    public func ping() async throws {
        try await post(try JSONEncoder().encode(Body(secret: secret, relay: Ping())))
    }

    private func post(_ body: Data) async throws {
        var req = URLRequest(url: url, timeoutInterval: 60)
        req.httpMethod = "POST"
        // text/plain: niente richiesta preliminare, come dalla pagina Bluefy
        req.setValue("text/plain;charset=utf-8", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw Failure(description: "lo script ha risposto \(code)") }
        try Self.check(data)
    }

    /// Controlla la risposta dello script: `{ok: true}` oppure un errore leggibile.
    public static func check(_ data: Data) throws {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            let text = String(decoding: data.prefix(200), as: UTF8.self)
            throw Failure(description: text.contains("<html") || text.contains("<!DOCTYPE")
                ? "lo script ha risposto con una pagina web: controlla che sia pubblicato per «Chiunque»"
                : "risposta non valida dallo script")
        }
        if obj["ok"] as? Bool == true { return }
        if obj["results"] != nil { throw Failure(description: "lo script è una versione vecchia: ricopialo dal plugin") }
        let err = String(describing: obj["error"] ?? "errore dello script")
        throw Failure(description: err == "secret" ? "la chiave segreta non corrisponde" : err)
    }
}
