import SwiftUI

/// 颜色系统：支持浅色/深色并随系统自动切换（默认）。
struct AppColors {
    static func sidebarBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 30/255, green: 30/255, blue: 30/255) : Color(red: 247/255, green: 245/255, blue: 240/255)
    }

    static func listBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 40/255, green: 40/255, blue: 40/255) : Color(red: 250/255, green: 248/255, blue: 244/255)
    }

    static func editorBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 45/255, green: 45/255, blue: 45/255) : Color(red: 252/255, green: 250/255, blue: 246/255)
    }

    static func cardBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.22) : Color.white.opacity(0.86)
    }

    static func cardBorder(_ scheme: ColorScheme, isSelected: Bool) -> Color {
        isSelected ? accentYellow.opacity(0.9) : (scheme == .dark ? .white.opacity(0.06) : .black.opacity(0.06))
    }

    static func selectedFill(_ scheme: ColorScheme) -> Color {
        accentYellow.opacity(scheme == .dark ? 0.12 : 0.18)
    }

    static func textSecondary(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.65) : Color.black.opacity(0.55)
    }

    static let accentYellow = Color(red: 243/255, green: 186/255, blue: 0/255)

    static func divider(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.08)
    }
}

struct AttachmentAppearance {
    static var primaryTextColor: NSColor { .textColor }
    static var secondaryTextColor: NSColor { .secondaryLabelColor }
    static var backgroundColor: NSColor { .textBackgroundColor }
    static var secondaryBackgroundColor: NSColor { .controlBackgroundColor }
    static var borderColor: NSColor { .separatorColor }
    static var selectionColor: NSColor { .selectedContentBackgroundColor.withAlphaComponent(0.3) }
    static var uncheckedStrokeColor: NSColor { .tertiaryLabelColor }
}
