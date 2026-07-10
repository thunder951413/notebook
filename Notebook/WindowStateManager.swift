import Foundation
import SwiftUI
import Combine

// MARK: - 窗口状态

struct WindowState: Codable {
    var isLeftSidebarExpanded: Bool
    var isRightSidebarExpanded: Bool
    var leftSidebarWidth: CGFloat
    var rightSidebarWidth: CGFloat
    var windowFrame: CGRect
    var isMaximized: Bool
    
    init(
        isLeftSidebarExpanded: Bool = true,
        isRightSidebarExpanded: Bool = false,
        leftSidebarWidth: CGFloat = 220,
        rightSidebarWidth: CGFloat = 320,
        windowFrame: CGRect = CGRect(x: 100, y: 100, width: 1200, height: 800),
        isMaximized: Bool = false
    ) {
        self.isLeftSidebarExpanded = isLeftSidebarExpanded
        self.isRightSidebarExpanded = isRightSidebarExpanded
        self.leftSidebarWidth = leftSidebarWidth
        self.rightSidebarWidth = rightSidebarWidth
        self.windowFrame = windowFrame
        self.isMaximized = isMaximized
    }
}

// MARK: - 窗口状态管理器

@MainActor
class WindowStateManager: ObservableObject {
    static let shared = WindowStateManager()
    
    @Published var state: WindowState
    
    private let stateKey = "app.windowState"
    private var cancellables = Set<AnyCancellable>()
    private var saveTimer: Timer?
    
    private init() {
        // 加载保存的状态或创建默认状态
        if let data = NotebookDefaults.shared.data(forKey: stateKey),
           let decoded = try? JSONDecoder().decode(WindowState.self, from: data) {
            state = decoded
        } else {
            state = WindowState()
        }
        
        // 监听状态变化，延迟保存
        setupAutoSave()
    }
    
    private func setupAutoSave() {
        $state
            .debounce(for: .seconds(0.5), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                self?.saveState()
            }
            .store(in: &cancellables)
    }
    
    func saveState() {
        if let encoded = try? JSONEncoder().encode(state) {
            NotebookDefaults.shared.set(encoded, forKey: stateKey)
        }
    }
    
    // MARK: - 便捷方法
    
    var isLeftSidebarExpanded: Bool {
        get { state.isLeftSidebarExpanded }
        set {
            DispatchQueue.main.async {
                self.state.isLeftSidebarExpanded = newValue
                self.saveState()
            }
        }
    }

    var isRightSidebarExpanded: Bool {
        get { state.isRightSidebarExpanded }
        set {
            DispatchQueue.main.async {
                self.state.isRightSidebarExpanded = newValue
                self.saveState()
            }
        }
    }

    var leftSidebarWidth: CGFloat {
        get { state.leftSidebarWidth }
        set {
            DispatchQueue.main.async {
                self.state.leftSidebarWidth = max(180, min(newValue, 400))
                self.saveState()
            }
        }
    }

    var rightSidebarWidth: CGFloat {
        get { state.rightSidebarWidth }
        set {
            DispatchQueue.main.async {
                self.state.rightSidebarWidth = max(250, min(newValue, 600))
                self.saveState()
            }
        }
    }

    var windowFrame: CGRect {
        get { state.windowFrame }
        set {
            DispatchQueue.main.async {
                self.state.windowFrame = newValue
                self.saveState()
            }
        }
    }

    var isMaximized: Bool {
        get { state.isMaximized }
        set {
            DispatchQueue.main.async {
                self.state.isMaximized = newValue
                self.saveState()
            }
        }
    }
    
    // MARK: - 更新方法
    
    func updateLeftSidebar(expanded: Bool? = nil, width: CGFloat? = nil) {
        DispatchQueue.main.async {
            if let expanded = expanded {
                self.state.isLeftSidebarExpanded = expanded
            }
            if let width = width {
                self.state.leftSidebarWidth = max(180, min(width, 400))
            }
            self.saveState()
        }
    }

    func updateRightSidebar(expanded: Bool? = nil, width: CGFloat? = nil) {
        DispatchQueue.main.async {
            if let expanded = expanded {
                self.state.isRightSidebarExpanded = expanded
            }
            if let width = width {
                self.state.rightSidebarWidth = max(250, min(width, 600))
            }
            self.saveState()
        }
    }

    func updateWindowFrame(_ frame: CGRect, isMaximized: Bool? = nil) {
        DispatchQueue.main.async {
            self.state.windowFrame = frame
            if let isMaximized = isMaximized {
                self.state.isMaximized = isMaximized
            }
            self.saveState()
        }
    }
}
