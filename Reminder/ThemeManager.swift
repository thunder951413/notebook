import SwiftUI
import Combine

/// 主题管理器 - 管理应用的主题颜色
final class ThemeManager: ObservableObject {
    static let shared = ThemeManager()

    @Published var accentColor: Color = AppSettings.shared.accentColor

    private init() {
        // 初始化时从设置加载颜色
        self.accentColor = AppSettings.shared.accentColor
    }

    /// 更新主题色
    func updateAccentColor(_ color: Color) {
        AppSettings.shared.accentColor = color
        self.accentColor = color
    }

    /// 刷新主题色（从设置重新加载）
    func refresh() {
        self.accentColor = AppSettings.shared.accentColor
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
