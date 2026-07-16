import SwiftUI
import Combine

/// 环形菜单项
struct RadialMenuItem: Identifiable, Equatable {
    let id: UUID
    var action: ShortcutAction
    var position: Int // 0-7 表示8个位置

    init(id: UUID = UUID(), action: ShortcutAction, position: Int) {
        self.id = id
        self.action = action
        self.position = position
    }
}

// 用于存储的 Codable 版本
private struct RadialMenuItemData: Codable {
    let id: UUID
    let actionRawValue: String
    let position: Int

    init(from item: RadialMenuItem) {
        self.id = item.id
        self.actionRawValue = item.action.rawValue
        self.position = item.position
    }

    func toItem() -> RadialMenuItem? {
        guard let action = ShortcutAction(rawValue: actionRawValue) else { return nil }
        return RadialMenuItem(id: id, action: action, position: position)
    }
}

/// 环形菜单设置管理
final class RadialMenuSettings: ObservableObject {
    static let shared = RadialMenuSettings()

    @Published var isEnabled: Bool {
        didSet {
            NotebookDefaults.shared.set(isEnabled, forKey: "radialMenuEnabled")
        }
    }

    @Published var trigger: RadialMenuTrigger {
        didSet {
            NotebookDefaults.shared.set(trigger.rawValue, forKey: "radialMenuTrigger")
            // 通知监控器重新配置
            RadialMenuEventMonitor.shared.restartMonitoring()
        }
    }

    @Published var menuItems: [RadialMenuItem] {
        didSet {
            saveMenuItems()
        }
    }

    @Published var menuRadius: CGFloat {
        didSet {
            NotebookDefaults.shared.set(menuRadius, forKey: "radialMenuRadius")
        }
    }

    @Published var itemSize: CGFloat {
        didSet {
            NotebookDefaults.shared.set(itemSize, forKey: "radialMenuItemSize")
        }
    }

    @Published var menuScale: CGFloat {
        didSet {
            NotebookDefaults.shared.set(menuScale, forKey: "radialMenuScale")
        }
    }

    private init() {
        self.isEnabled = NotebookDefaults.shared.bool(forKey: "radialMenuEnabled")

        // 加载触发方式
        let triggerRawValue = NotebookDefaults.shared.string(forKey: "radialMenuTrigger") ?? ""
        self.trigger = RadialMenuTrigger(rawValue: triggerRawValue) ?? .middleClick

        self.menuRadius = NotebookDefaults.shared.object(forKey: "radialMenuRadius") as? CGFloat ?? 120
        self.itemSize = NotebookDefaults.shared.object(forKey: "radialMenuItemSize") as? CGFloat ?? 50
        self.menuScale = NotebookDefaults.shared.object(forKey: "radialMenuScale") as? CGFloat ?? 1.0
        self.menuItems = RadialMenuSettings.loadMenuItems()

        // 如果为空，设置默认项
        if self.menuItems.isEmpty {
            self.menuItems = RadialMenuSettings.defaultMenuItems()
        }
    }
    
    private static func loadMenuItems() -> [RadialMenuItem] {
        guard let data = NotebookDefaults.shared.data(forKey: "radialMenuItems"),
              let itemsData = try? JSONDecoder().decode([RadialMenuItemData].self, from: data) else {
            return []
        }
        return itemsData.compactMap { $0.toItem() }
    }

    private func saveMenuItems() {
        let itemsData = menuItems.map { RadialMenuItemData(from: $0) }
        if let data = try? JSONEncoder().encode(itemsData) {
            NotebookDefaults.shared.set(data, forKey: "radialMenuItems")
        }
    }
    
    static func defaultMenuItems() -> [RadialMenuItem] {
        let defaultActions: [ShortcutAction] = [
            .newNote,
            .saveNote,
            .toggleBold,
            .toggleItalic,
            .toggleBulletList,
            .toggleNumberedList,
            .toggleCheckbox,
            .focusSearch
        ]
        
        return defaultActions.enumerated().map { index, action in
            RadialMenuItem(action: action, position: index)
        }
    }
    
    func updateItem(at position: Int, action: ShortcutAction) {
        if let index = menuItems.firstIndex(where: { $0.position == position }) {
            menuItems[index].action = action
        } else {
            menuItems.append(RadialMenuItem(action: action, position: position))
        }
    }
    
    func removeItem(at position: Int) {
        menuItems.removeAll { $0.position == position }
    }
    
    func resetToDefaults() {
        menuItems = RadialMenuSettings.defaultMenuItems()
    }
}

/// 环形菜单位置计算
enum RadialMenuPosition: Int, CaseIterable {
    case top = 0
    case topRight = 1
    case right = 2
    case bottomRight = 3
    case bottom = 4
    case bottomLeft = 5
    case left = 6
    case topLeft = 7

    var angle: Double {
        return Double(self.rawValue) * .pi / 4 - .pi / 2 // 从顶部开始，顺时针
    }

    /// 扇形起始角度（度数，从正上方顺时针）
    var sectorStartAngle: Double {
        let baseAngle = Double(self.rawValue) * 45.0 // 每个扇形45度
        return baseAngle - 22.5 // 居中偏移
    }

    /// 扇形结束角度（度数）
    var sectorEndAngle: Double {
        return sectorStartAngle + 45.0
    }

    func point(in radius: CGFloat, center: CGPoint) -> CGPoint {
        let x = center.x + radius * cos(angle)
        let y = center.y + radius * sin(angle)
        return CGPoint(x: x, y: y)
    }

    var displayName: String {
        switch self {
        case .top: return "顶部"
        case .topRight: return "右上"
        case .right: return "右侧"
        case .bottomRight: return "右下"
        case .bottom: return "底部"
        case .bottomLeft: return "左下"
        case .left: return "左侧"
        case .topLeft: return "左上"
        }
    }
}
