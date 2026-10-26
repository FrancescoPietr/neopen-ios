import ActivityKit
import Foundation

// The data of the app's Live Activity on the lock screen: the coming appointments with a countdown, and the tasks of
// today (older versions also had a separate "event" countdown).
// The SAME definition is in targets/widget/NeoAttributes.swift: iOS pairs the app and the widget by this type.
public struct NeoAttributes: ActivityAttributes {
  public struct Item: Codable, Hashable {
    public var title: String
    public var time: String
    public var done: Bool
    /// Calendar events only: when it starts and ends, and the color of its calendar.
    public var start: Date?
    public var end: Date?
    public var color: String?
  }

  public struct ContentState: Codable, Hashable {
    /// "today" (appointments + tasks), or the older "event" / "tasks".
    public var kind: String
    public var title: String
    public var subtitle: String
    public var start: Date
    public var end: Date
    public var color: String
    public var items: [Item]
    /// "today": the appointments, nearest first (items holds the tasks).
    public var events: [Item]?
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
