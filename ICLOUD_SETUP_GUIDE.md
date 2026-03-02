# iCloud 同步配置指南

本文档介绍如何在 Reminder 应用中配置 iCloud 同步功能。

## 功能概述

本项目提供三种 iCloud 同步方案：

1. **NSUbiquitousKeyValueStore** - 轻量级配置同步（设置、主题等）
2. **SwiftData + CloudKit** - 完整数据同步（笔记、文件夹、标签）
3. **iCloud Documents** - 文件备份同步（附件、备份文件）

## 配置步骤

### 1. 启用 iCloud 功能

在 Xcode 中配置 iCloud 能力：

1. 选中项目 → Target → Signing & Capabilities
2. 点击 "+ Capability"
3. 添加以下能力：
   - **iCloud**
     - 勾选 "Key-value storage"
     - 勾选 "CloudKit"
     - 选择或创建 Container（如 `iCloud.com.yourcompany.reminder`）
   - **App Groups**（可选，用于多应用共享数据）

### 2. 配置 Entitlements

确保 `Reminder.entitlements` 文件包含：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.developer.icloud-container-identifiers</key>
    <array>
        <string>iCloud.$(CFBundleIdentifier)</string>
    </array>
    <key>com.apple.developer.icloud-services</key>
    <array>
        <string>CloudKit</string>
        <string>KeyValueStorage</string>
    </array>
    <key>com.apple.developer.ubiquity-container-identifiers</key>
    <array>
        <string>iCloud.$(CFBundleIdentifier)</string>
    </array>
</dict>
</plist>
```

### 3. 配置 CloudKit Dashboard

如果使用 CloudKit 同步笔记数据：

1. 访问 [CloudKit Dashboard](https://icloud.developer.apple.com/dashboard/)
2. 选择你的 Container
3. 在 "Schema" 中创建以下 Record Types：

#### Note Record Type
```
Record Name: Note
Fields:
- title: String
- content: String (可选)
- createdAt: Date
- updatedAt: Date
- folderName: String
- tagIDs: String
- reminderAt: Date (可选)
- recurrenceRule: String (可选)
- version: Int
- rtfdData: Bytes (可选)
```

#### Folder Record Type
```
Record Name: Folder
Fields:
- id: String
- name: String
- sortOrder: Int
- createdAt: Date
- isSystem: Int
```

#### Tag Record Type
```
Record Name: Tag
Fields:
- id: String
- name: String
- color: String
- sortOrder: Int
- createdAt: Date
```

4. 在 "Deployment" 中将 Schema 部署到 Production

### 4. 代码集成

#### 4.1 在 App 启动时初始化

在 `ReminderApp.swift` 中添加：

```swift
import SwiftUI
import SwiftData

@main
struct ReminderApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(iCloudSyncManager.shared)
        }
        .modelContainer(PersistenceController.shared.modelContainer!)
    }
}

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {
        // 检查 iCloud 可用性
        iCloudSyncManager.shared.checkiCloudAvailability()
        
        // 监听 iCloud 账户变化
        NotificationCenter.default.addObserver(
            forName: NSNotification.Name.CKAccountChanged,
            object: nil,
            queue: .main
        ) { _ in
            iCloudSyncManager.shared.checkiCloudAvailability()
        }
        
        return true
    }
}
```

#### 4.2 在设置界面添加 iCloud 选项

在设置视图中添加 iCloud 设置入口：

```swift
import SwiftUI

struct SettingsView: View {
    @StateObject private var appSettings = AppSettings.shared
    @StateObject private var syncManager = iCloudSyncManager.shared
    
    var body: some View {
        Form {
            Section(header: Text("iCloud 同步")) {
                Toggle("启用 iCloud 同步", isOn: $appSettings.isiCloudSyncEnabled)
                
                if appSettings.isiCloudSyncEnabled {
                    NavigationLink("iCloud 同步设置") {
                        iCloudSettingsView()
                    }
                }
            }
        }
    }
}
```

### 5. 使用 iCloud 同步

#### 同步配置

```swift
// 保存设置到 iCloud
AppSettings.shared.syncToiCloud()

// 从 iCloud 恢复设置
AppSettings.shared.restoreFromiCloud()
```

#### 同步笔记数据

```swift
// 上传笔记
Task {
    try? await iCloudSyncManager.shared.uploadNote(note)
}

// 下载所有笔记
Task {
    let notes = try? await iCloudSyncManager.shared.downloadAllNotes()
}
```

#### 使用 SwiftData + CloudKit（推荐）

```swift
// 配置支持 CloudKit 的 ModelContainer
try? PersistenceController.shared.configureWithCloudKit()

// SwiftData 会自动处理同步
// 你只需正常操作数据即可
```

## 测试 iCloud 同步

### 模拟器测试

1. 登录 iCloud 账户（Settings → Sign In）
2. 启用 iCloud Drive
3. 运行应用并测试同步功能

### 真机测试

1. 使用两个 iOS 设备
2. 使用相同的 iCloud 账户登录
3. 在一台设备上创建/修改笔记
4. 在另一台设备上验证同步

### 调试技巧

1. 查看控制台日志：
   ```swift
   // 启用 CloudKit 调试日志
   -com.apple.CoreData.CloudKitDebug 1
   -com.apple.CoreData.Logging.stderr 1
   ```

2. 使用 CloudKit Dashboard 查看数据

3. 检查 iCloud 状态：
   ```swift
   print(iCloudSyncManager.shared.isiCloudAvailable)
   ```

## 常见问题

### Q: iCloud 不可用？

A: 检查以下几点：
- 设备是否登录 iCloud 账户
- 是否启用 iCloud Drive
- Xcode Capabilities 是否正确配置
- Bundle Identifier 是否与 Container 匹配

### Q: 数据没有同步？

A: 可能原因：
- 网络连接问题
- CloudKit 配额已满
- Schema 未正确部署
- 记录类型不匹配

### Q: 冲突如何解决？

A: 使用 ConflictResolver：
```swift
ConflictResolver.shared.strategy = .newerWins // 或 .serverWins, .clientWins
```

## 注意事项

1. **隐私合规**：确保符合 GDPR、CCPA 等隐私法规
2. **数据安全**：敏感数据建议加密后再同步
3. **配额限制**：CloudKit 有免费配额限制
4. **离线支持**：考虑离线场景下的数据一致性
5. **版本兼容**：旧版本应用可能无法读取新格式数据

## 参考文档

- [Apple CloudKit Documentation](https://developer.apple.com/documentation/cloudkit)
- [NSUbiquitousKeyValueStore](https://developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestore)
- [SwiftData Sync](https://developer.apple.com/documentation/swiftdata/syncing-data-with-icloud)
