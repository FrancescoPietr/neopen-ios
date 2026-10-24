/** Bluetooth state of the pen as seen by the native module. */
export type BleState = "starting" | "bluetoothOff" | "unauthorized" | "noPen" | "searching" | "waiting" | "connecting" | "ready";

export type NeoPenBleModuleEvents = {
  onState: (e: { state: BleState; penName: string }) => void;
  /** The pen's notification channel is open: start the session. */
  onReady: () => void;
  /** Bytes from the pen (base64). */
  onData: (e: { base64: string }) => void;
  /** The pen disconnected (powered off or out of range). */
  onClosed: () => void;
  onLog: (e: { message: string }) => void;
  /** A request started with startBackgroundPost is over: Documents/http/<id>.done is there. */
  onHttpDone: (e: { id: string }) => void;
};

export type BleSnapshot = { state: BleState; penName: string; hasPen: boolean; launchedForBluetooth: boolean };
