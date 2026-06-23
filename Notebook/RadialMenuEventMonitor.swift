import SwiftUI
import AppKit
import Combine

/// 鼠标事件监控器 - 支持可配置的触发方式
final class RadialMenuEventMonitor: ObservableObject {
    static let shared = RadialMenuEventMonitor()

    private var localMonitor: Any?
    private var isMonitoring = false

    @Published var lastMouseLocation: CGPoint = .zero

    private init() {}

    func startMonitoring() {
        guard !isMonitoring else { return }

        let settings = RadialMenuSettings.shared
        guard settings.isEnabled else { return }

        let trigger = settings.trigger

        // 根据触发方式选择事件类型
        var eventMask: NSEvent.EventTypeMask = []
        switch trigger.buttonNumber {
        case 0:
            eventMask = .leftMouseDown
        case 1:
            eventMask = .rightMouseDown
        case 2:
            eventMask = .otherMouseDown
        default:
            eventMask = .otherMouseDown
        }

        // 使用本地监控（应用内）
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: eventMask) { [weak self] event in
            guard let self = self else { return event }

            // 检查是否匹配触发条件
            guard trigger.matches(event: event) else { return event }

            // 获取鼠标位置
            let location: CGPoint
            if let window = event.window {
                let windowPoint = event.locationInWindow
                let screenPoint = window.convertToScreen(NSRect(origin: windowPoint, size: .zero)).origin
                location = screenPoint
            } else {
                location = NSEvent.mouseLocation
            }

            self.lastMouseLocation = location

            // 显示环形菜单
            DispatchQueue.main.async {
                RadialMenuWindowController.shared.show(at: location)
            }

            // 阻止事件继续传播（除了左键，避免影响正常操作）
            if trigger.buttonNumber != 0 {
                return nil
            }
            return event
        }

        isMonitoring = true
        DebugLog.app("Started monitoring for: \(trigger.displayName)", level: .debug)
    }

    func stopMonitoring() {
        guard isMonitoring else { return }

        if let monitor = localMonitor {
            NSEvent.removeMonitor(monitor)
            localMonitor = nil
        }

        isMonitoring = false
        DebugLog.app("Stopped monitoring", level: .debug)
    }

    func restartMonitoring() {
        stopMonitoring()
        startMonitoring()
    }
}

/// 用于在 SwiftUI 视图中检测鼠标事件的 NSViewRepresentable
struct RadialMenuMouseDetector: NSViewRepresentable {
    func makeNSView(context: Context) -> RadialMenuMouseView {
        return RadialMenuMouseView()
    }

    func updateNSView(_ nsView: RadialMenuMouseView, context: Context) {}
}

/// 检测鼠标事件的 NSView
class RadialMenuMouseView: NSView {
    override func mouseDown(with event: NSEvent) {
        handleEvent(event, superCall: { super.mouseDown(with: $0) })
    }

    override func rightMouseDown(with event: NSEvent) {
        handleEvent(event, superCall: { super.rightMouseDown(with: $0) })
    }

    override func otherMouseDown(with event: NSEvent) {
        handleEvent(event, superCall: { super.otherMouseDown(with: $0) })
    }

    private func handleEvent(_ event: NSEvent, superCall: (NSEvent) -> Void) {
        let settings = RadialMenuSettings.shared

        // 检查是否启用
        guard settings.isEnabled else {
            superCall(event)
            return
        }

        let trigger = settings.trigger

        // 检查是否匹配触发条件
        guard trigger.matches(event: event) else {
            superCall(event)
            return
        }

        // 获取鼠标位置
        let location = convert(event.locationInWindow, from: nil)
        let windowLocation = window?.convertToScreen(NSRect(origin: location, size: .zero)).origin ?? location

        // 显示环形菜单
        DispatchQueue.main.async {
            RadialMenuWindowController.shared.show(at: windowLocation)
        }

        // 阻止事件继续传播（除了左键）
        if trigger.buttonNumber != 0 {
            return
        }

        superCall(event)
    }
}
