import SwiftUI
import UIKit

@main
struct NeoPenApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(AppModel.shared)
        }
    }
}

/// Quando iOS rilancia l'app in background per la penna non apre nessuna finestra:
/// il Bluetooth va ricreato subito, qui, con lo stesso identificatore di ripristino.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated {
            if let restored = launchOptions?[.bluetoothCentrals] as? [String], !restored.isEmpty {
                AppModel.shared.write("Rilanciata da iOS per il Bluetooth.")
            } else {
                _ = AppModel.shared
            }
        }
        return true
    }
}
