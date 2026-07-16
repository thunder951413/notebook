import Foundation
import UserNotifications

struct NotificationScheduleRevisionTracker {
    private var revisions: [UUID: UInt64] = [:]

    mutating func begin(for itemID: UUID) -> UInt64 {
        let revision = (revisions[itemID] ?? 0) &+ 1
        revisions[itemID] = revision
        return revision
    }

    mutating func invalidate(for itemID: UUID) {
        _ = begin(for: itemID)
    }

    func isCurrent(_ revision: UInt64, for itemID: UUID) -> Bool {
        revisions[itemID] == revision
    }
}

@MainActor
final class NotificationManager {
    static let shared = NotificationManager()

    private let center = UNUserNotificationCenter.current()
    private var revisionTracker = NotificationScheduleRevisionTracker()

    private init() {}

    func requestAuthorizationIfNeeded() async {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
        case .denied:
            break
        default:
            break
        }
    }

    func schedule(noteID: UUID, title: String, body: String, reminderAt: Date, recurrence: String = "none") async {
        await schedule(itemID: noteID, itemType: "note", title: title, body: body, reminderAt: reminderAt, recurrence: recurrence)
    }

    func schedule(todoID: UUID, title: String, body: String, reminderAt: Date, recurrence: String = "none") async {
        await schedule(itemID: todoID, itemType: "todo", title: title, body: body, reminderAt: reminderAt, recurrence: recurrence)
    }

    private func schedule(itemID: UUID, itemType: String, title: String, body: String, reminderAt: Date, recurrence: String) async {
        let revision = revisionTracker.begin(for: itemID)
        await requestAuthorizationIfNeeded()
        guard revisionTracker.isCurrent(revision, for: itemID) else { return }

        let id = itemID.uuidString
        center.removePendingNotificationRequests(withIdentifiers: [id])

        let content = UNMutableNotificationContent()
        content.title = title.isEmpty ? l10n(L10nKeys.Note.reminderTitle) : title
        content.body = body
        content.sound = .default
        content.userInfo = [
            "itemID": id,
            "itemType": itemType,
            // Compatibility for notifications scheduled before Todo support.
            "noteID": id
        ]

        let trigger: UNNotificationTrigger
        if recurrence == "none" {
            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: reminderAt)
            trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        } else {
            var comps = DateComponents()
            let sourceComps = Calendar.current.dateComponents([.hour, .minute], from: reminderAt)
            comps.hour = sourceComps.hour
            comps.minute = sourceComps.minute
            
            switch recurrence {
            case "daily":
                // 仅匹配小时/分钟，每天重复
                trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: true)
            case "weekly":
                // 匹配周几 + 小时/分钟
                let weekdayComps = Calendar.current.dateComponents([.weekday], from: reminderAt)
                comps.weekday = weekdayComps.weekday
                trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: true)
            case "monthly":
                // 匹配几号 + 小时/分钟
                let dayComps = Calendar.current.dateComponents([.day], from: reminderAt)
                comps.day = dayComps.day
                trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: true)
            default:
                let fullComps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: reminderAt)
                trigger = UNCalendarNotificationTrigger(dateMatching: fullComps, repeats: false)
            }
        }

        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        try? await center.add(request)

        // schedule 在 await 期间可能被“完成/删除”取消；防止旧任务随后把重复提醒加回来。
        if !revisionTracker.isCurrent(revision, for: itemID) {
            center.removePendingNotificationRequests(withIdentifiers: [id])
            center.removeDeliveredNotifications(withIdentifiers: [id])
        }
    }

    func cancel(noteID: UUID) {
        revisionTracker.invalidate(for: noteID)
        let id = noteID.uuidString
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }
}
