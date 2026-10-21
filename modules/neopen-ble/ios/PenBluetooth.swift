import CoreBluetooth
import Foundation
import UIKit

/// Bluetooth with the pen, built to work in the background (everything runs on the main queue):
/// - the chosen pen is remembered (identifier saved) and iOS is asked to connect it "as soon as it sees it":
///   that request never times out, so when the cap comes off iOS connects it and wakes the app;
/// - with state restoration (restore identifier) iOS relaunches the app even if it had terminated it for memory
///   (not if the user force-quits it from the app switcher);
/// - when the pen powers off, a new pending connection is requested right away for next time.
///
/// It is created at launch by `NeoPenAppDelegate` (before JavaScript starts). Events for JavaScript are queued
/// until the module starts observing, so nothing that arrives during a background relaunch is lost.
final class PenBluetooth: NSObject, @unchecked Sendable {
  static let shared = PenBluetooth()

  static let restoreID = "neopen.central"
  private static let penKey = "neopen.penIdentifier"
  private static let penNameKey = "neopen.penName"

  // pen BLE services (same as the Obsidian plugin)
  static let service16 = CBUUID(string: "19F1")
  static let notify16 = CBUUID(string: "2BA1")
  static let write16 = CBUUID(string: "2BA0")
  static let service128 = CBUUID(string: "4F99F138-9D53-5BFA-9E50-B147491AFE68")
  static let notify128 = CBUUID(string: "64CD86B1-2256-5AEB-9F04-2CAF6C60AE57")
  static let write128 = CBUUID(string: "8BC8CC7D-88CA-56B0-AF9A-9BF514D0D61A")

  /// starting · bluetoothOff · unauthorized · noPen · searching · waiting · connecting · ready
  private(set) var state = "starting" {
    didSet { if state != oldValue { emit("onState", ["state": state, "penName": penName ?? ""]) } }
  }

  /// Delivers events to the JavaScript module; nil while JavaScript isn't listening (events are queued).
  var sink: ((String, [String: Any?]) -> Void)? {
    didSet { flushQueue() }
  }

  private var queue: [(String, [String: Any?])] = []
  private var central: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var writeChar: CBCharacteristic?
  private var notifyChar: CBCharacteristic?
  private var scanTimer: Timer?
  private(set) var launchedForBluetooth = false

  var penName: String? { UserDefaults.standard.string(forKey: Self.penNameKey) }
  var hasPen: Bool { knownID != nil }

  private var knownID: UUID? {
    get { UserDefaults.standard.string(forKey: Self.penKey).flatMap(UUID.init(uuidString:)) }
    set { UserDefaults.standard.set(newValue?.uuidString, forKey: Self.penKey) }
  }

  /// Creates the central manager (with the restore identifier). Must happen at launch.
  func start(launchedForBluetooth: Bool = false) {
    if launchedForBluetooth { self.launchedForBluetooth = true }
    guard central == nil else { return }
    central = CBCentralManager(delegate: self, queue: .main, options: [
      CBCentralManagerOptionRestoreIdentifierKey: Self.restoreID,
      CBCentralManagerOptionShowPowerAlertKey: true,
    ])
  }

  // ---------------------------------------------------------------- events for JavaScript

  private func emit(_ name: String, _ body: [String: Any?] = [:]) {
    if let sink {
      sink(name, body)
    } else {
      queue.append((name, body))
      // keep the queue bounded (a long background relaunch without JavaScript listening)
      if queue.count > 5000 { queue.removeFirst(queue.count - 5000) }
    }
  }

  private func flushQueue() {
    guard let sink, !queue.isEmpty else { return }
    let pending = queue
    queue = []
    for (n, b) in pending { sink(n, b) }
  }

  func log(_ message: String) { emit("onLog", ["message": message]) }

  func snapshot() -> [String: Any] {
    ["state": state, "penName": penName ?? "", "hasPen": hasPen, "launchedForBluetooth": launchedForBluetooth]
  }

  // ---------------------------------------------------------------- commands

  /// First time: look for a powered-on pen and remember it.
  func searchPen() {
    guard let central, central.state == .poweredOn else { return }
    state = "searching"
    log("Cerco la penna… (togli il tappo e tienila vicina)")
    central.scanForPeripherals(withServices: [Self.service16, Self.service128], options: nil)
    // some pens don't advertise the service: after a few seconds search by name too
    scanTimer?.invalidate()
    scanTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
      guard let self, self.state == "searching", let central = self.central else { return }
      central.stopScan()
      central.scanForPeripherals(withServices: nil, options: nil)
      self.scanTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
        guard let self, self.state == "searching" else { return }
        self.central?.stopScan()
        self.log("Nessuna penna trovata. Togli il tappo e riprova.")
        self.state = self.hasPen ? "waiting" : "noPen"
      }
    }
  }

  func stopSearch() {
    scanTimer?.invalidate()
    central?.stopScan()
    if state == "searching" { state = hasPen ? "waiting" : "noPen" }
  }

  /// Forgets the pen (to choose another one).
  func forgetPen() {
    if let p = peripheral { central?.cancelPeripheralConnection(p) }
    peripheral = nil
    knownID = nil
    UserDefaults.standard.removeObject(forKey: Self.penNameKey)
    state = "noPen"
    log("Penna dimenticata.")
  }

  /// Closes the connection (the pen stays remembered and reconnects when it powers on again).
  func disconnect() {
    if let p = peripheral, p.state != .disconnected { central?.cancelPeripheralConnection(p) }
  }

  /// Sends bytes to the pen (in pieces if longer than what Bluetooth accepts at once).
  func send(_ data: Data) {
    guard let p = peripheral, let c = writeChar else { return }
    let type: CBCharacteristicWriteType = c.properties.contains(.write) ? .withResponse : .withoutResponse
    let limit = max(20, p.maximumWriteValueLength(for: type))
    var i = 0
    while i < data.count {
      let end = min(data.count, i + limit)
      p.writeValue(data.subdata(in: i..<end), for: c, type: type)
      i = end
    }
  }

  /// Asks iOS to connect the pen as soon as it sees it (even hours later, even with the app in the background).
  private func waitForPen() {
    guard let central, central.state == .poweredOn, let id = knownID else { return }
    guard let p = peripheral ?? central.retrievePeripherals(withIdentifiers: [id]).first else {
      log("La penna ricordata non è più nota a iOS: cercala di nuovo.")
      knownID = nil
      state = "noPen"
      return
    }
    peripheral = p
    p.delegate = self
    switch p.state {
    case .connected:
      discover(p)
    case .connecting:
      state = "waiting"
    default:
      central.connect(p, options: nil)
      state = "waiting"
    }
  }

  private func discover(_ p: CBPeripheral) {
    state = "connecting"
    p.discoverServices([Self.service16, Self.service128])
  }
}

// MARK: - CBCentralManagerDelegate (main queue)

extension PenBluetooth: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn:
      if hasPen { waitForPen() } else if state != "searching" { state = "noPen" }
    case .poweredOff:
      state = "bluetoothOff"
    case .unauthorized:
      state = "unauthorized"
    default:
      break
    }
  }

  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
    log("iOS ha riattivato l'app per la penna (\(restored.count) collegamenti ripresi).")
    if let p = restored.first(where: { $0.identifier == knownID }) ?? restored.first {
      peripheral = p
      p.delegate = self
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard state == "searching" else { return }
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
    guard name.range(of: "neo|smartpen|nwp|lamy|m1", options: [.regularExpression, .caseInsensitive]) != nil else { return }
    scanTimer?.invalidate()
    central.stopScan()
    knownID = peripheral.identifier
    UserDefaults.standard.set(name, forKey: Self.penNameKey)
    log("Trovata «\(name)»: me la ricordo.")
    self.peripheral = peripheral
    peripheral.delegate = self
    central.connect(peripheral, options: nil)
    state = "connecting"
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    log("Penna accesa: collegata.")
    self.peripheral = peripheral
    peripheral.delegate = self
    discover(peripheral)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    writeChar = nil
    notifyChar = nil
    log(error.map { "Penna scollegata (\($0.localizedDescription))." } ?? "Penna scollegata.")
    emit("onClosed")
    // pending again right away: at the next power-on iOS reconnects it by itself
    if knownID == peripheral.identifier {
      central.connect(peripheral, options: nil)
      state = "waiting"
    } else {
      state = "noPen"
    }
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    log("Collegamento non riuscito\(error.map { " (\($0.localizedDescription))" } ?? ""): riprovo.")
    state = "waiting"
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.waitForPen() }
  }
}

// MARK: - CBPeripheralDelegate (main queue)

extension PenBluetooth: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    let services = peripheral.services ?? []
    if let s = services.first(where: { $0.uuid == Self.service16 }) {
      peripheral.discoverCharacteristics([Self.notify16, Self.write16], for: s)
    } else if let s = services.first(where: { $0.uuid == Self.service128 }) {
      peripheral.discoverCharacteristics([Self.notify128, Self.write128], for: s)
    } else {
      log("La penna non espone il servizio atteso\(error.map { " (\($0.localizedDescription))" } ?? "").")
      central?.cancelPeripheralConnection(peripheral)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    let chars = service.characteristics ?? []
    notifyChar = chars.first { $0.uuid == Self.notify16 || $0.uuid == Self.notify128 }
    writeChar = chars.first { $0.uuid == Self.write16 || $0.uuid == Self.write128 }
    guard let n = notifyChar, writeChar != nil else {
      log("Caratteristiche della penna mancanti.")
      central?.cancelPeripheralConnection(peripheral)
      return
    }
    if n.isNotifying {
      // channel already open (connection resumed by iOS after a relaunch): go
      state = "ready"
      emit("onReady")
    } else {
      peripheral.setNotifyValue(true, for: n)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.isNotifying else {
      log("La penna non ha aperto il canale\(error.map { " (\($0.localizedDescription))" } ?? "").")
      return
    }
    state = "ready"
    emit("onReady")
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard let d = characteristic.value, !d.isEmpty else { return }
    emit("onData", ["base64": d.base64EncodedString()])
  }
}
