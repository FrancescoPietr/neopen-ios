// The widgets of NeoTransfer (Calendario, Attività, Agenda) and its Live Activities, in SwiftUI.
// Shares the App Group with the app: the app writes widget.json, the widget reads it (and writes toggles.json).
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "NeoWidget",
  displayName: "NeoTransfer",
  bundleIdentifier: ".widget",
  deploymentTarget: "17.0",
  frameworks: ["SwiftUI", "WidgetKit", "ActivityKit", "AppIntents"],
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
