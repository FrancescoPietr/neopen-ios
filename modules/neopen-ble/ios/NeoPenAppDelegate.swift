import ExpoModulesCore
import UIKit

/// When iOS relaunches the app in the background for the pen, the Bluetooth central must be recreated right away,
/// at launch, with the same restore identifier: this subscriber does it before JavaScript starts.
public class NeoPenAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    let restored = (launchOptions?[.bluetoothCentrals] as? [String])?.isEmpty == false
    PenBluetooth.shared.start(launchedForBluetooth: restored)
    if restored { PenBluetooth.shared.log("Rilanciata da iOS per il Bluetooth.") }
    // background requests (Claude calls): the session must exist at launch to receive its events
    _ = BackgroundHttp.shared.session
    return true
  }

  /// iOS relaunches the app (invisibly) when a background request is over.
  public func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
    BackgroundHttp.shared.handleEvents(completion: completionHandler)
  }
}
