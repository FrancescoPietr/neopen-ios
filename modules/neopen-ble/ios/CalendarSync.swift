import EventKit
import Foundation

/// Calendari dell'iPhone sempre aggiornati: iOS scarica le novità di Google/iCloud solo quando qualcuno lo chiede
/// (di solito l'app Calendario). Qui lo chiediamo noi, e avvisiamo l'app quando il database dei calendari cambia.
enum CalendarSync {
  nonisolated(unsafe) private static let store = EKEventStore()
  nonisolated(unsafe) private static var observer: NSObjectProtocol?

  /// Chiede a iOS di scaricare subito gli account dei calendari (Google, iCloud, Exchange) se è il caso.
  static func refresh() {
    store.refreshSourcesIfNecessary()
  }

  /// `onChange` a ogni cambiamento dei calendari (un evento arrivato da Google, uno spostato nell'app Calendario).
  static func observe(_ onChange: @escaping () -> Void) {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { _ in onChange() }
  }

  static func stop() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
  }
}
