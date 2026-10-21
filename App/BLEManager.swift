import CoreBluetooth
import Foundation
import NeoPenKit

/// Bluetooth con la penna, fatto per lavorare in background:
/// - la penna scelta si ricorda (identificatore salvato) e si chiede a iOS di collegarla "appena la vede":
///   la richiesta non scade mai, quindi quando togli il tappo iOS la collega e risveglia l'app;
/// - con il ripristino dello stato (restore identifier) iOS rilancia l'app anche se nel frattempo l'aveva chiusa
///   per liberare memoria (non se la chiudi tu dal multitasking);
/// - quando la penna si spegne, si richiede subito il collegamento per la volta dopo.
@MainActor
final class BLEManager: NSObject, PenLink {
    static let restoreID = "neopen.central"
    private static let penKey = "neopen.penIdentifier"
    private static let penNameKey = "neopen.penName"

    // UUID dei servizi della penna (gli stessi del plugin)
    static let service16 = CBUUID(string: "19F1")
    static let notify16 = CBUUID(string: "2BA1")
    static let write16 = CBUUID(string: "2BA0")
    static let service128 = CBUUID(string: "4F99F138-9D53-5BFA-9E50-B147491AFE68")
    static let notify128 = CBUUID(string: "64CD86B1-2256-5AEB-9F04-2CAF6C60AE57")
    static let write128 = CBUUID(string: "8BC8CC7D-88CA-56B0-AF9A-9BF514D0D61A")

    enum State: Equatable {
        case starting
        case bluetoothOff
        case unauthorized
        case noPen          // nessuna penna scelta
        case searching      // ricerca della penna (prima volta)
        case waiting        // penna nota ma spenta o lontana: iOS la collegherà appena si accende
        case connecting
        case ready          // canale aperto
    }

    private(set) var state: State = .starting {
        didSet { if state != oldValue { onState(state) } }
    }

    var onState: (State) -> Void = { _ in }
    var onReady: () -> Void = {}
    var onData: ([UInt8]) -> Void = { _ in }
    var onClosed: () -> Void = {}
    var log: (String) -> Void = { _ in }

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeChar: CBCharacteristic?
    private var notifyChar: CBCharacteristic?
    private var scanTimer: Timer?

    var penName: String? { UserDefaults.standard.string(forKey: Self.penNameKey) }
    var hasPen: Bool { knownID != nil }

    private var knownID: UUID? {
        get { UserDefaults.standard.string(forKey: Self.penKey).flatMap(UUID.init(uuidString:)) }
        set { UserDefaults.standard.set(newValue?.uuidString, forKey: Self.penKey) }
    }

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main, options: [
            CBCentralManagerOptionRestoreIdentifierKey: Self.restoreID,
            CBCentralManagerOptionShowPowerAlertKey: true,
        ])
    }

    // ---------------------------------------------------------------- comandi

    /// Prima volta: cerca una penna accesa e se la ricorda.
    func searchPen() {
        guard central.state == .poweredOn else { return }
        state = .searching
        log("Cerco la penna… (togli il tappo e tienila vicina)")
        central.scanForPeripherals(withServices: [Self.service16, Self.service128], options: nil)
        // alcune penne non annunciano il servizio: dopo qualche secondo si cerca anche per nome
        scanTimer?.invalidate()
        scanTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.state == .searching else { return }
                self.central.stopScan()
                self.central.scanForPeripherals(withServices: nil, options: nil)
                self.scanTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, self.state == .searching else { return }
                        self.central.stopScan()
                        self.log("Nessuna penna trovata. Togli il tappo e riprova.")
                        self.state = self.hasPen ? .waiting : .noPen
                    }
                }
            }
        }
    }

    func stopSearch() {
        scanTimer?.invalidate()
        central.stopScan()
        if state == .searching { state = hasPen ? .waiting : .noPen }
    }

    /// Dimentica la penna (per sceglierne un'altra).
    func forgetPen() {
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        peripheral = nil
        knownID = nil
        UserDefaults.standard.removeObject(forKey: Self.penNameKey)
        state = .noPen
        log("Penna dimenticata.")
    }

    /// Chiude il collegamento (la penna resta ricordata e si ricollega alla prossima accensione).
    func disconnect() {
        if let p = peripheral, p.state != .disconnected { central.cancelPeripheralConnection(p) }
    }

    /// Chiede a iOS di collegare la penna appena la vede (anche fra ore, anche con l'app in background).
    private func waitForPen() {
        guard central.state == .poweredOn, let id = knownID else { return }
        let p = peripheral ?? central.retrievePeripherals(withIdentifiers: [id]).first
        guard let p else {
            log("La penna ricordata non è più nota a iOS: cercala di nuovo.")
            knownID = nil
            state = .noPen
            return
        }
        peripheral = p
        p.delegate = self
        switch p.state {
        case .connected:
            discover(p)
        case .connecting:
            state = .waiting
        default:
            central.connect(p, options: nil)
            state = .waiting
        }
    }

    private func discover(_ p: CBPeripheral) {
        state = .connecting
        p.discoverServices([Self.service16, Self.service128])
    }

    // ---------------------------------------------------------------- PenLink

    /// Manda un comando alla penna (a pezzi se è più lungo di quello che il Bluetooth accetta in una volta).
    func send(_ bytes: [UInt8]) {
        guard let p = peripheral, let c = writeChar else { return }
        let type: CBCharacteristicWriteType = c.properties.contains(.write) ? .withResponse : .withoutResponse
        let limit = Swift.max(20, p.maximumWriteValueLength(for: type))
        var i = 0
        while i < bytes.count {
            let end = Swift.min(bytes.count, i + limit)
            p.writeValue(Data(bytes[i..<end]), for: c, type: type)
            i = end
        }
    }

    // ---------------------------------------------------------------- eventi (sul main thread)

    fileprivate func handleState() {
        switch central.state {
        case .poweredOn:
            if hasPen { waitForPen() } else if state != .searching { state = .noPen }
        case .poweredOff:
            state = .bluetoothOff
        case .unauthorized:
            state = .unauthorized
        default:
            break
        }
    }

    fileprivate func handleRestore(_ dict: [String: Any]) {
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        log("iOS ha riattivato l'app per la penna (\(restored.count) collegamenti ripresi).")
        if let p = restored.first(where: { $0.identifier == knownID }) ?? restored.first {
            peripheral = p
            p.delegate = self
        }
    }

    fileprivate func handleDiscovered(_ p: CBPeripheral, name: String?) {
        guard state == .searching else { return }
        let n = name ?? p.name ?? ""
        guard n.range(of: "neo|smartpen|nwp|lamy|m1", options: [.regularExpression, .caseInsensitive]) != nil else { return }
        scanTimer?.invalidate()
        central.stopScan()
        knownID = p.identifier
        UserDefaults.standard.set(n, forKey: Self.penNameKey)
        log("Trovata «\(n)»: me la ricordo.")
        peripheral = p
        p.delegate = self
        central.connect(p, options: nil)
        state = .connecting
    }

    fileprivate func handleConnected(_ p: CBPeripheral) {
        log("Penna accesa: collegata.")
        peripheral = p
        p.delegate = self
        discover(p)
    }

    fileprivate func handleDisconnected(_ p: CBPeripheral, error: Error?) {
        writeChar = nil
        notifyChar = nil
        log(error.map { "Penna scollegata (\($0.localizedDescription))." } ?? "Penna scollegata.")
        onClosed()
        // subito di nuovo in attesa: alla prossima accensione iOS la ricollega da solo
        if knownID == p.identifier {
            central.connect(p, options: nil)
            state = .waiting
        } else {
            state = .noPen
        }
    }

    fileprivate func handleFailed(_ p: CBPeripheral, error: Error?) {
        log("Collegamento non riuscito\(error.map { " (\($0.localizedDescription))" } ?? ""): riprovo.")
        state = .waiting
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            MainActor.assumeIsolated { self?.waitForPen() }
        }
    }

    fileprivate func handleServices(_ p: CBPeripheral, error: Error?) {
        let services = p.services ?? []
        if let s = services.first(where: { $0.uuid == Self.service16 }) {
            p.discoverCharacteristics([Self.notify16, Self.write16], for: s)
        } else if let s = services.first(where: { $0.uuid == Self.service128 }) {
            p.discoverCharacteristics([Self.notify128, Self.write128], for: s)
        } else {
            log("La penna non espone il servizio atteso\(error.map { " (\($0.localizedDescription))" } ?? "").")
            central.cancelPeripheralConnection(p)
        }
    }

    fileprivate func handleCharacteristics(_ p: CBPeripheral, service: CBService) {
        let chars = service.characteristics ?? []
        notifyChar = chars.first { $0.uuid == Self.notify16 || $0.uuid == Self.notify128 }
        writeChar = chars.first { $0.uuid == Self.write16 || $0.uuid == Self.write128 }
        guard let n = notifyChar, writeChar != nil else {
            log("Caratteristiche della penna mancanti.")
            central.cancelPeripheralConnection(p)
            return
        }
        if n.isNotifying {
            // canale già aperto (collegamento ripreso da iOS dopo un rilancio): si parte subito
            state = .ready
            onReady()
        } else {
            p.setNotifyValue(true, for: n)
        }
    }

    fileprivate func handleNotifying(_ c: CBCharacteristic, error: Error?) {
        guard c.isNotifying else {
            log("La penna non ha aperto il canale\(error.map { " (\($0.localizedDescription))" } ?? "").")
            return
        }
        state = .ready
        onReady()
    }

    fileprivate func handleValue(_ c: CBCharacteristic) {
        guard let d = c.value, !d.isEmpty else { return }
        onData([UInt8](d))
    }
}

// I metodi dei delegati arrivano sulla coda principale (queue: .main): si passano al main actor.

extension BLEManager: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated { handleState() }
    }

    nonisolated func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        MainActor.assumeIsolated { handleRestore(dict) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        MainActor.assumeIsolated { handleDiscovered(peripheral, name: name) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated { handleConnected(peripheral) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated { handleDisconnected(peripheral, error: error) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated { handleFailed(peripheral, error: error) }
    }
}

extension BLEManager: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        MainActor.assumeIsolated { handleServices(peripheral, error: error) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        MainActor.assumeIsolated { handleCharacteristics(peripheral, service: service) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated { handleNotifying(characteristic, error: error) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated { handleValue(characteristic) }
    }
}
