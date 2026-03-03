import Foundation
import AppKit

/// 环形菜单触发方式
enum RadialMenuTrigger: String, CaseIterable, Identifiable, Codable {
    case middleClick = "middle_click"
    case rightClick = "right_click"
    case leftClick = "left_click"
    case shiftMiddleClick = "shift_middle_click"
    case shiftRightClick = "shift_right_click"
    case shiftLeftClick = "shift_left_click"
    case commandMiddleClick = "command_middle_click"
    case commandRightClick = "command_right_click"
    case optionMiddleClick = "option_middle_click"
    case optionRightClick = "option_right_click"
    case controlMiddleClick = "control_middle_click"
    case controlRightClick = "control_right_click"
    
    var id: String { rawValue }
    
    var displayName: String {
        switch self {
        case .middleClick: return "鼠标中键"
        case .rightClick: return "鼠标右键"
        case .leftClick: return "鼠标左键"
        case .shiftMiddleClick: return "Shift + 鼠标中键"
        case .shiftRightClick: return "Shift + 鼠标右键"
        case .shiftLeftClick: return "Shift + 鼠标左键"
        case .commandMiddleClick: return "⌘ + 鼠标中键"
        case .commandRightClick: return "⌘ + 鼠标右键"
        case .optionMiddleClick: return "⌥ + 鼠标中键"
        case .optionRightClick: return "⌥ + 鼠标右键"
        case .controlMiddleClick: return "⌃ + 鼠标中键"
        case .controlRightClick: return "⌃ + 鼠标右键"
        }
    }
    
    /// 对应的鼠标按键编号
    var buttonNumber: Int {
        switch self {
        case .middleClick, .shiftMiddleClick, .commandMiddleClick, .optionMiddleClick, .controlMiddleClick:
            return 2  // 中键
        case .rightClick, .shiftRightClick, .commandRightClick, .optionRightClick, .controlRightClick:
            return 1  // 右键
        case .leftClick, .shiftLeftClick:
            return 0  // 左键
        }
    }
    
    /// 是否需要 Shift 键
    var requiresShift: Bool {
        switch self {
        case .shiftMiddleClick, .shiftRightClick, .shiftLeftClick:
            return true
        default:
            return false
        }
    }
    
    /// 是否需要 Command 键
    var requiresCommand: Bool {
        switch self {
        case .commandMiddleClick, .commandRightClick:
            return true
        default:
            return false
        }
    }
    
    /// 是否需要 Option 键
    var requiresOption: Bool {
        switch self {
        case .optionMiddleClick, .optionRightClick:
            return true
        default:
            return false
        }
    }
    
    /// 是否需要 Control 键
    var requiresControl: Bool {
        switch self {
        case .controlMiddleClick, .controlRightClick:
            return true
        default:
            return false
        }
    }
    
    /// 检查事件是否匹配此触发方式
    func matches(event: NSEvent) -> Bool {
        // 检查按键
        guard event.buttonNumber == buttonNumber else { return false }
        
        // 检查修饰键
        let modifierFlags = event.modifierFlags
        let hasShift = modifierFlags.contains(.shift)
        let hasCommand = modifierFlags.contains(.command)
        let hasOption = modifierFlags.contains(.option)
        let hasControl = modifierFlags.contains(.control)
        
        return hasShift == requiresShift &&
               hasCommand == requiresCommand &&
               hasOption == requiresOption &&
               hasControl == requiresControl
    }
}
