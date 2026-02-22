import Foundation
import UserNotifications

@MainActor
final class NotificationManager {
    static let shared = NotificationManager()

    private let center = UNUserNotificationCenter.current()

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
        await requestAuthorizationIfNeeded()

        let id = noteID.uuidString
        center.removePendingNotificationRequests(withIdentifiers: [id])

        let content = UNMutableNotificationContent()
        content.title = title.isEmpty ? "笔记提醒" : title
        content.body = body
        content.sound = .default
        content.userInfo = ["noteID": id]

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
    }

    func cancel(noteID: UUID) {
        let id = noteID.uuidString
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }
}
