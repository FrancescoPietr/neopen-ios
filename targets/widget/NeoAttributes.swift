import ActivityKit
import Foundation

// The data of the app's Live Activities (the countdown to the next appointment, the tasks of today).
// The SAME definition is in targets/widget/NeoAttributes.swift: iOS pairs the app and the widget by this type.
public struct NeoAttributes: ActivityAttributes {
  public struct Item: Codable, Hashable {
    public var title: String
    public var time: String
    public var done: Bool
  }

  public struct ContentState: Codable, Hashable {
    /// "event" (countdown) or "tasks" (the tasks of today).
    public var kind: String
    public var title: String
    public var subtitle: String
    public var start: Date
    public var end: Date
    public var color: String
    public var items: [Item]
    public var more: Int
    public var done: Int
    public var total: Int
    public var paper: String
    public var ink: String
    public var soft: String
    public var accent: String
    public var hand: Bool
  }

  public var kind: String
}
