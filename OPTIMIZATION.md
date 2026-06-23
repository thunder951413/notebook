# Notebook 代码优化文档

> 基于对 77 个 Swift 源文件的全量代码评估生成。
> 评估时间：2026-06-20
> 整体质量评分：**3.0 / 5**

---

## 目录

- [一、问题优先级总览](#一问题优先级总览)
- [二、P0 高优先级（安全）](#二p0-高优先级安全)
- [三、P1 高优先级（架构）](#三p1-高优先级架构)
- [四、P2 中优先级（数据层）](#四p2-中优先级数据层)
- [五、P3 中优先级（规范）](#五p3-中优先级规范)
- [六、P4 低优先级（测试与并发）](#六p4-低优先级测试与并发)
- [七、项目亮点（保持）](#七项目亮点保持)
- [八、改进路线图](#八改进路线图)

---

## 一、问题优先级总览

| 优先级 | 类别 | 问题数 | 核心内容 |
|--------|------|--------|----------|
| **P0** | 安全 | 3 | 密码哈希算法、时序攻击、SSH 密码内存暴露 |
| **P1** | 架构 | 4 | 巨型文件、单例耦合、视图与业务混杂、职责不清 |
| **P2** | 数据层 | 3 | 缺 @Relationship、tagIDs 反范式、缺 Migration Plan |
| **P3** | 规范 | 4 | print 泛滥、try? 吞错、Keychain 重复、UUID 编解码重复 |
| **P4** | 测试与并发 | 4 | UI 测试空壳、@unchecked Sendable、DispatchQueue/Task 混用、脆弱启发式 |

---

## 二、P0 高优先级（安全）

### P0-1 密码哈希算法不当 🔴

**位置**：`Notebook/PasswordManager.swift:105-110`

**问题**：应用主密码使用 **SHA-256** 哈希存储。SHA-256 是通用哈希算法而非密码哈希算法，计算速度极快，哈希值易被暴力破解/彩虹表攻击。

**方案**：
- 替换为 **PBKDF2**（系统内置 `CryptoKit` 不支持，可用 `CommonCrypto.CCKeyDerivationPBKDF`）
- 或使用更现代的 **Argon2id**（需引入第三方库如 `swift-sodium`）
- 推荐参数：迭代次数 ≥ 100,000，盐值 ≥ 16 字节随机

**迁移**：检测旧 SHA-256 哈希时，引导用户在下次输入密码后自动升级为新算法。

### P0-2 密码比较存在时序攻击风险 🔴

**位置**：`Notebook/PasswordManager.swift:52`

**问题**：`inputHash == storedHash` 使用普通字符串比较，非常量时间，攻击者可通过响应时间差逐字节猜测哈希。

**方案**：使用常量时间比较：
```swift
import CryptoKit
let inputDigest = SHA256.hash(data: Data(input.utf8))
let storedDigest = SHA256.hash(data: Data(storedHash.utf8))
return inputDigest == storedDigest  // CryptoKit 的 == 是常量时间
```
或更通用：
```swift
func constantTimeCompare(_ a: String, _ b: String) -> Bool {
    guard a.count == b.count else { return false }
    var result: UInt8 = 0
    for (x, y) in zip(a.utf8, b.utf8) { result |= x ^ y }
    return result == 0
}
```

### P0-3 SSH 密码内存明文暴露 🟡

**位置**：`Notebook/SSHConfig.swift`

**问题**：
- `SSHConfig` 结构体包含 `var password: String = ""`，密码以明文 String 存于内存
- 标记为 `@unchecked Sendable`，编译器不检查线程安全

**方案**：
- 改用 `Data` 存储，使用后立即 `resetBytes(in:)` 清零
- 考虑使用 `CFStringCreateWithBytesNoCopy` + `kCFStringAllocatorNull` 创建不可变 String
- 缩小密码可见范围，仅在真正执行 SSH 命令时从 Keychain 取出，用完即清

---

## 三、P1 高优先级（架构）

### P1-1 巨型文件拆分 🔴

**现状**：

| 文件 | 行数(约) | 建议拆分方向 |
|------|---------|------------|
| `ContentView.swift` | ~4400 | 列表视图、编辑器宿主、AI 输入处理、图片提取、@提及解析 各拆独立文件 |
| `RichTextEditor.swift` | ~3700 | `RichTextController` / `NSTextViewDelegate` / 粘贴协调器 / 格式化命令 分离 |
| `DataExportManager.swift` | ~2900 | 配置导出、数据导出、迁移包构建、块级文档序列化 各成模块 |
| `Models.swift` | ~2140 | `NoteStore` 单独成文件；`BlockDocumentAttributedStringBuilder` 已独立但同文件；富文本/颜色/模型分离 |
| `SSHSyncManager.swift` | ~2100 | 远程索引、附件同步、冲突处理、SCP 上传校验 拆分 |
| `PersistenceController.swift` | ~1358 | Schema 定义、版本存储、合并逻辑 分文件 |

**目标**：单文件不超过 800 行，单一职责。

### P1-2 NoteStore 单例耦合 🟡

**位置**：`Notebook/Models.swift:527` `NoteStore`

**问题**：`NoteStore` 内部直接引用 5 个 `.shared` 单例（PersistenceController / StorageLocationManager / NoteSaveManager / AutoSyncCoordinator / EncryptedFolderManager），形成紧耦合，难以测试和替换。

**方案**：
- 改为**依赖注入**：通过 `init` 注入依赖，保留 `.shared` 作为默认值便于兼容
- 或引入轻量 `ServiceLocator` / 协议抽象
- 至少为同步相关依赖定义协议，便于单元测试 mock

### P1-3 ContentView 视图与业务逻辑混杂 🟡

**问题**：`ContentView` 直接调用 `EncryptedFolderManager.shared`、`AutoSyncCoordinator.shared` 等业务管理器，并包含 AI 输入处理、图片提取等本应独立的逻辑。

**方案**：
- 引入 `ViewModel`（`@MainActor` class，`ObservableObject`）承接业务逻辑
- 视图只负责渲染和事件转发
- AI 输入、图片提取、@提及解析抽到独立 Service

### P1-4 职责不清：ColorSystem 与 Model 混放 🟢

**位置**：`Notebook/Models.swift:9-45`

**问题**：`AppColors`、`AttachmentAppearance` 这些 UI 颜色常量放在 `Models.swift`，与数据模型混在一起。

**方案**：迁移到独立的 `Theme.swift` 或 `AppColors.swift`。

---

## 四、P2 中优先级（数据层）

### P2-1 未使用 SwiftData @Relationship 注解 🟡

**位置**：`Notebook/PersistenceController.swift:85-418`

**问题**：所有实体间关系用 UUID 字段手动关联（如 `noteID: UUID`、`folderID: UUID?`），未使用 `@Relationship`。

**影响**：
- 无法利用级联删除，需手动遍历删除（见 `Models.swift:1626-1642` 删除 blocks/assets）
- 查询需多次 fetch，性能不如关系预取
- 关系完整性靠业务代码保证，易遗漏

**方案**：迁移到 `@Relationship(.cascade)` / `@Relationship(.nullify)`：
```swift
@Model
final class BlockDocumentNoteEntity {
    @Relationship(deleteRule: .cascade, inverse: \BlockDocumentBlockEntity.note)
    var blocks: [BlockDocumentBlockEntity] = []
    
    @Relationship(deleteRule: .cascade, inverse: \BlockDocumentAssetEntity.note)
    var assets: [BlockDocumentAssetEntity] = []
}
```

**注意**：此变更需要 **Migration Plan** 配合（见 P2-3）。

### P2-2 tagIDs 反范式设计 🟡

**位置**：`Notebook/PersistenceController.swift:175`

**问题**：`BlockDocumentNoteEntity.tagIDs` 用逗号分隔 UUID 字符串存储，而非多对多关系表。

**影响**：
- 查询笔记的标签需字符串 split + UUID 解析
- 查询某标签下所有笔记需全表扫描 + 字符串匹配
- UUID 编解码逻辑在 3 处重复（`Models.swift:724`、`1342`、`PersistenceController.swift:1321`）
- 易不一致（顺序、去重、空值处理）

**方案**：建立 `BlockDocumentNoteTagEntity` 关联表（noteID + tagID），或使用 SwiftData 多对多 `@Relationship`。

### P2-3 缺少 SwiftData Migration Plan 🟡

**现状**：
- 有 `documentSchemaVersion` 字段但无对应迁移代码
- 仅靠 `recoveredLegacyTodoBlock`（`Models.swift:179`）等一次性兼容逻辑处理旧数据
- `EncryptedFolderManager.migrateOldEncryptedNotes` 有一次性迁移标记

**风险**：未来 Schema 变更（如 P2-1 引入 @Relationship）将导致数据库无法打开或数据丢失。

**方案**：
```swift
static let migrationPlan: SchemaMigrationPlan = {
    let v1 = SchemaVersion("1.0", entities: [...])
    let v2 = SchemaVersion("1.1", entities: [...])
    return SchemaMigrationPlan(from: v1, to: v2, stages: [
        .custom(stage: V1ToV2Migration())
    ])
}()
```

---

## 五、P3 中优先级（规范）

### P3-1 调试 print 泛滥 🟡

**现状**：31 个文件中共 **366+ 处 `print()`**：

| 文件 | print 数 |
|------|---------|
| `RichTextEditor.swift` | 74 |
| `ContentView.swift` | 42 |
| `DataExportManager.swift` | 45 |
| `Models.swift` | 32 |
| 其他 | ~173 |

而项目已有完善的 `Logger` 模块（8 模块 4 级别 + 5000 条环形缓冲 + 文件持久化）却仅 9 个文件使用。

**典型例子**：`Models.swift:1957` 每次保存笔记都会输出 `print("[StorageDebug] cleanedForStorage: checking attachments...")`。

**方案**：
- 全量替换为 `Logger.shared.log(.app, .debug, ...)`（Release 构建可自动剔除）
- 或对调试 print 用 `#if DEBUG` 包裹
- 推荐前者，统一日志出口

### P3-2 try? 静默吞错 🟡

**现状**：
- `Models.swift` 24 处 `try?`
- `PersistenceController.swift` 17 处 `try?`
- 典型：`try? context.save()` 保存失败不通知用户

**方案**：
- 对关键操作（save、delete）改用 `do { try ... } catch { Logger...; 抛出或提示 }`
- 对非关键操作（如缓存清理）保留 `try?` 但加日志
- 区分"可恢复"与"致命"错误，前者降级，后者上报

### P3-3 Keychain 操作重复 🟢

**现状**：3 个文件各自实现 Keychain CRUD：
- `Notebook/PasswordManager.swift`
- `Notebook/GitHubTokenManager.swift`
- `Notebook/SSHConfig.swift`

**方案**：抽取 `KeychainHelper.swift` 统一封装：
```swift
enum KeychainHelper {
    static func save(_ data: Data, service: String, account: String) throws
    static func load(service: String, account: String) -> Data?
    static func delete(service: String, account: String) throws
}
```

### P3-4 UUID 列表编解码重复 🟢

**位置**：
- `Models.swift:724-731` `decodeUUIDList`
- `Models.swift:1342-1348` 内联实现
- `PersistenceController.swift:1321-1325` `decodeUUIDList`

**方案**：统一到一处工具函数，删除重复实现。

---

## 六、P4 低优先级（测试与并发）

### P4-1 UI 测试空壳 🔴

**位置**：`NotebookUITests/NotebookUITests.swift`

**现状**：仅 8 行，只有一个 `testUITestBundleLoads()` 断言 `true`。

**方案**：补充关键流程 UI 测试：
- 新建笔记 → 编辑 → 保存 → 列表显示
- 文件夹创建 → 移动笔记 → 删除文件夹
- 设置入口 → SSH 配置
- Markdown 预览切换

### P4-2 @unchecked Sendable 并发风险 🟡

**位置**：`Notebook/SSHSyncManager.swift:115`、`Notebook/SSHConfig.swift`

**问题**：`@unchecked Sendable` 让编译器跳过并发安全检查，但类内部状态可能被多线程访问，存在数据竞争风险。

**方案**：
- 改为 `actor` 隔离状态（推荐）
- 或使用 `DispatchQueue` + barrier 串行化可变状态访问
- 或拆分不可变部分（Sendable）与可变部分（actor/Queue）

### P4-3 DispatchQueue 与 Task 混用 🟢

**现状**：`PasswordManager.swift:34` 用 `DispatchQueue.main.async`，其他地方用 `Task { @MainActor in }`。

**方案**：统一到 `Task { @MainActor in }`，弃用 `DispatchQueue.main.async`（除非有特殊性能需求）。

### P4-4 脆弱的复选框状态检测 🟡

**位置**：`Notebook/Models.swift:1071-1155` `detectIfCheckboxIsChecked`

**问题**：通过读取复选框图片**中心像素颜色**判断勾选状态，对主题、字体渲染、DPI 变化极度敏感，是脆弱启发式。

**方案**：
- 块级文档模型本就存储了 `checked: Bool`（`PersistenceController.swift:245`），应优先用元数据
- 仅在迁移旧数据时使用像素检测，新数据走元数据
- 长期目标：移除像素检测，统一走 Block 元数据

### P4-5 测试盲区 🟢

**缺失测试**：
- SSH 同步逻辑（最复杂、最易出错的部分）
- 加密文件夹安全
- 密码管理器（含 P0-1/P0-2 安全项）
- 并发安全
- Logger

**方案**：按风险排序补测，优先 SSH 同步和密码管理器。

---

## 七、项目亮点（保持）

以下设计应在重构中**保持不破坏**：

1. **块级文档架构**：笔记按 Block 存储，支持细粒度版本差异和增量同步
2. **成熟的同步冲突解决**：基于内容指纹（SHA-256）的三方合并 + 冲突标记 + diff 视图
3. **安全退出机制**：`AppDelegate.applicationShouldTerminate` 用 `.terminateLater` + TaskGroup + 8 秒超时
4. **灵活存储位置**：`StorageLocationManager` 支持 security-scoped bookmarks
5. **完善日志系统**：`Logger` 8 模块 4 级别 + 环形缓冲 + 文件持久化 + 导出（待推广使用）
6. **plan.md 演进清晰**：7 项同步改进均已完成

---

## 八、改进路线图

### 阶段一：安全加固（1-2 周）
- [x] P0-1 密码哈希升级 SHA-256 → PBKDF2
- [x] P0-2 密码比较改常量时间
- [x] P0-3 SSH 密码内存处理改进
- [x] P3-3 抽取 KeychainHelper

### 阶段二：规范清理（1 周）
- [ ] P3-1 清理 366+ 处 print → Logger
- [ ] P3-2 关键 `try?` 改为显式错误处理
- [x] P3-4 统一 UUID 编解码
- [x] P1-4 颜色常量迁移到 Theme.swift

### 阶段三：架构重构（2-4 周）
- [ ] P1-1 拆分 `ContentView.swift`（最大文件优先）
- [ ] P1-1 拆分 `RichTextEditor.swift`
- [x] P1-1 拆分 `DataExportManager.swift` / `PersistenceController.swift` / `Models.swift` 的低风险纯类型与工具模块
- [ ] P1-1 拆分 `ContentView.swift` / `RichTextEditor.swift` / `SSHSyncManager.swift` 的 UI 与同步状态模块
- [x] P1-2 NoteStore 依赖注入改造
- [ ] P1-3 ContentView 引入 ViewModel

### 阶段四：数据层升级（1-2 周）
- [ ] P2-3 制定 Migration Plan
  - [x] 已接入迁移前数据库目录自动备份与 store format version 记录
  - [ ] 下一步：在独立新 schema 上验证 `@Relationship` 迁移脚本与导入/回滚流程
- [ ] P2-1 引入 @Relationship（配合迁移）
- [ ] P2-2 tagIDs 改关系表

### 阶段五：测试与并发（1-2 周）
- [ ] P4-1 补充 UI 测试
- [ ] P4-5 补充 SSH/密码管理器测试
- [ ] P4-2 消除 @unchecked Sendable
- [ ] P4-3 统一并发原语
- [ ] P4-4 复选框检测去像素化

---

## 评分变化目标

| 维度 | 当前 | 目标 | 关键改进 |
|------|------|------|----------|
| 架构清晰度 | 2.5 | 4.0 | 巨型文件拆分 + 依赖注入 |
| 数据层设计 | 3.0 | 4.0 | @Relationship + Migration Plan |
| 代码规范 | 3.0 | 4.5 | print 清理 + 错误处理 |
| 安全性 | 2.5 | 4.5 | 密码哈希升级 + 常量时间比较 |
| 并发安全 | 3.0 | 4.0 | 消除 @unchecked Sendable |
| 测试覆盖 | 3.5 | 4.0 | UI 测试 + 同步/安全测试 |
| **整体质量** | **3.0** | **4.2** | — |

---

*本文档应随改进进度持续更新，已完成项打勾，新增问题追加到对应优先级。*
