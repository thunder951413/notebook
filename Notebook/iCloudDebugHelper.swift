//
//  iCloudDebugHelper.swift
//  Notebook
//
//  iCloud 调试助手 - 用于开发和测试
//

import Foundation

/// iCloud 调试模式管理器
@MainActor
final class iCloudDebugHelper {
    static let shared = iCloudDebugHelper()
    
    /// 是否启用本地模拟模式（用于测试）
    var isLocalSimulationMode: Bool {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "icloud_simulation_mode")
        #else
        return false
        #endif
    }
    
    /// 本地模拟存储
    private var localSimulationStore: [String: Data] = [:]
    
    private init() {}
    
    /// 启用本地模拟模式
    func enableLocalSimulationMode() {
        #if DEBUG
        UserDefaults.standard.set(true, forKey: "icloud_simulation_mode")
        print("[iCloudDebugHelper] ✅ Local simulation mode enabled")
        #endif
    }
    
    /// 禁用本地模拟模式
    func disableLocalSimulationMode() {
        #if DEBUG
        UserDefaults.standard.set(false, forKey: "icloud_simulation_mode")
        print("[iCloudDebugHelper] Local simulation mode disabled")
        #endif
    }
    
    /// 模拟设置值
    func setValue(_ data: Data, forKey key: String) {
        localSimulationStore[key] = data
        print("[iCloudDebugHelper] Set value for key: \(key)")
    }
    
    /// 模拟获取值
    func getValue(forKey key: String) -> Data? {
        return localSimulationStore[key]
    }
    
    /// 检查 iCloud 状态并给出建议
    func checkiCloudStatus() -> iCloudStatus {
        let token = FileManager.default.ubiquityIdentityToken
        let containerURL = FileManager.default.url(forUbiquityContainerIdentifier: nil)
        
        if token != nil && containerURL != nil {
            return .available
        } else if token == nil {
            return .notLoggedIn
        } else {
            return .containerNotAvailable
        }
    }
}

enum iCloudStatus {
    case available
    case notLoggedIn
    case containerNotAvailable
    
    var message: String {
        switch self {
        case .available:
            return "✅ iCloud 已就绪"
        case .notLoggedIn:
            return "⚠️ 未登录 iCloud 账户"
        case .containerNotAvailable:
            return "⚠️ iCloud Container 未配置"
        }
    }
    
    var suggestion: String {
        switch self {
        case .available:
            return "可以正常使用 iCloud 同步功能"
        case .notLoggedIn:
            return "请在系统设置中登录 iCloud 账户"
        case .containerNotAvailable:
            return "需要在 Xcode 中配置 iCloud Capability，或使用本地模拟模式"
        }
    }
}
