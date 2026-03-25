import SwiftUI
import Combine
import AppKit

/// 主题管理器 - 管理应用的主题颜色
final class ThemeManager: ObservableObject {
    static let shared = ThemeManager()

    @Published var accentColor: Color = AppSettings.shared.accentColor
    @Published var appearanceMode: AppSettings.AppearanceMode = AppSettings.shared.appearanceMode

    private init() {
        self.accentColor = AppSettings.shared.accentColor
        self.appearanceMode = AppSettings.shared.appearanceMode
        applyAppearance()
    }

    func updateAccentColor(_ color: Color) {
        AppSettings.shared.accentColor = color
        self.accentColor = color
    }

    func updateAppearanceMode(_ mode: AppSettings.AppearanceMode) {
        AppSettings.shared.appearanceMode = mode
        self.appearanceMode = mode
        applyAppearance()
    }

    func refresh() {
        self.accentColor = AppSettings.shared.accentColor
        self.appearanceMode = AppSettings.shared.appearanceMode
        applyAppearance()
    }

    private func applyAppearance() {
        let appearance: NSAppearance? = switch appearanceMode {
        case .system:
            nil
        case .light:
            NSAppearance(named: .aqua)
        case .dark:
            NSAppearance(named: .darkAqua)
        }

        NSApp.appearance = appearance
        NSApp.windows.forEach { $0.appearance = appearance }
    }
}

/// 主题颜色修饰符
struct ThemeColorModifier: ViewModifier {
    @ObservedObject private var themeManager = ThemeManager.shared

    func body(content: Content) -> some View {
        content
            .tint(themeManager.accentColor)
            .accentColor(themeManager.accentColor)
    }
}

extension View {
    /// 应用主题颜色
    func applyTheme() -> some View {
        self.modifier(ThemeColorModifier())
    }
}

struct AppearanceCommands: Commands {
    @ObservedObject private var themeManager = ThemeManager.shared

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Divider()

            ForEach(AppSettings.AppearanceMode.allCases, id: \.self) { mode in
                Button {
                    themeManager.updateAppearanceMode(mode)
                } label: {
                    Text(menuTitle(for: mode))
                }
            }
        }
    }

    private func menuTitle(for mode: AppSettings.AppearanceMode) -> String {
        let title = switch mode {
        case .system: "自动主题"
        case .light: "亮色主题"
        case .dark: "暗色主题"
        }

        return themeManager.appearanceMode == mode ? "✓ \(title)" : title
    }
}
