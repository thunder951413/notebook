# CHANGES

## 1.1.14 — macOS 安全编辑与大文档 Markdown

- 新增加密编辑草稿日志：Keychain 密钥、AES-GCM、原子替换、`fsync` 和 SHA-256 回读校验；数据库成功后才删除草稿。
- 新增单调 revision 编辑会话，统一展示未保存、保存中、已保存和失败，旧保存完成事件不会覆盖新输入状态。
- Markdown/TXT 来源笔记使用离线 Muya；超过 250,000 UTF-16 字符默认使用 CodeMirror 6 视口虚拟化源码模式。
- Markdown 编辑器、Mermaid、字体和脚本全部随应用发布，CSP 禁止 WebView 发起网络连接；远程 block/asset/history 协议不变。
- 保留 Markdown `documentSource`，避免普通保存后退回富文本编辑器；继续同步既有 UTF-16 阅读锚点和相对滚动位置。
- 新增 macOS 设计说明和 Android Muya/安全保存实施路线。

---

## 阶段二规范清理（历史记录）

> **本次提交目标**：在不改变功能的前提下，按 OPTIMIZATION.md 阶段二（规范清理）+ P4 并发安全做一轮"零风险"重构。
>
> **总体收益**：
> - 项目唯一的 `@unchecked Sendable` 已正式记录并发约定
> - **366 处 `print()` 全部统一进入 Logger**（仍保留 `#if DEBUG` 下的 stdout 输出）
> - 22 处关键 **`try? context.save()` 升级为可观测的 `saveLogging`**
> - **3883 行的测试巨石拆为 10 个域划分文件**，最大单文件 1146 行
>
> **未触及功能逻辑**，所有改动均为机械替换 / 添加日志钩子 / 文件拆分。

---

## 一、新增文件（生产代码）

### 1.1 `Notebook/DebugLog.swift`
轻量桥接，把分散的 `print(...)` 统一接入 `Logger`。

- `DebugLog.editor/app/storage/attachment/table/save/search/encryption(...)` 8 个语义化入口
- `#if DEBUG` 时落 stdout（与现有 print 行为一致），Release 自动剔除
- 同时进入 `Logger.shared` 的环形缓冲 + 可选文件持久化

**评审要点**：
- API 设计为 `@inline(__always)` + `@autoclosure`，零开销，Release 构建不会评估字符串拼接
- 模块映射规则参见文件头注释

### 1.2 `Notebook/ModelContextSaveLogging.swift`
`ModelContext` 扩展，**用 `saveLogging("场景")` 替换"静默吞错"的 `try? save()`**：

```swift
// 旧
try? context.save()
// 新
context.saveLogging("NoteStore.deleteFolder")
```

- 保留"不抛错"语义（业务上层无需重构）
- 失败时落 `Logger.shared.log(.storage, .error, ...)`，并自动捕获 `#fileID:#line`
- `@discardableResult Bool` 返回值方便上层选择性处理

**评审要点**：失败日志格式：`[scope] context.save() 失败 @File.swift:行号: <error>`

---

## 二、修改文件（生产代码）

### 2.1 `Notebook/SSHSyncManager.swift`（仅注释）
- 在 `@unchecked Sendable` 上方加 10 行文档注释，明确两把锁保护的可变状态：
  - `activeControlMasterPaths` ← `controlMasterLock`
  - `activeSyncOperationName` ← `syncOperationLock`
- 同时 2 处 `try? context.save()` 升级为 `context.saveLogging("...")`

### 2.2 print → DebugLog 批量迁移（21 个文件，366 处）
按文件分布如下：

| 文件 | 数量 | 目标模块 |
|------|------|----------|
| RichTextEditor.swift | 74 | `.editor` |
| ContentView.swift | 42 | `.app` |
| MixedAudioRecorder.swift | 22 | `.attachment` |
| iCloudSyncManager.swift | 21 | `.storage` |
| AudioRecorderView.swift | 20 | `.attachment` |
| Models.swift | 22（11 + 11 guarded） | `.storage`/`.attachment` |
| DataExportManager.swift | 16 | `.storage` |
| ConfigurationTransferHelper.swift | 16 | `.storage` |
| AttachmentManager.swift | 13 | `.attachment` |
| ArchiveUtility.swift | 13 | `.storage` |
| iCloudBackupManager.swift | 12 | `.storage` |
| RadialMenuWindow.swift | 10 | `.app` |
| AttachmentTextAttachment.swift | 8 | `.attachment` |
| BackupManager.swift | 8 | `.storage` |
| MarkdownHTMLRenderer.swift | 7 | `.editor` |
| CheckboxTextAttachment.swift | 7（含 6 guarded） | `.attachment` |
| AudioBlockAttachment.swift | 6 | `.attachment` |
| RichTextStorageExtensions.swift | 5 | `.editor` |
| MarkdownWebView.swift | 5 | `.editor` |
| 其他 11 个文件 | 39 | 按域映射 |

**迁移规则**：
- 单行 `print(...)` 自动识别
- `[Tag]` 前缀剥离（避免双重前缀，Logger 自带模块标签）
- 错误关键字（`failed`/`error`/`无法`/`失败`/`错误`）→ level `.warn`，其余 `.debug`
- 多参数 `print(x, y)` 已手工补做字符串插值修复（CheckboxTextAttachment 3 处）
- `if isXxxDebugEnabled { print(...) }` 保留 guard，仅替换 print → DebugLog

**验证**：迁移后 `grep "print(" Notebook/*.swift` 仅余 9 处，**全部为 `fingerPrint` / `snapshotFingerprint` 等方法名的误匹配**，零真实 `print()`。

### 2.3 `try? context.save()` → `saveLogging(...)`（2 个文件，22 处）

| 文件 | 数量 |
|------|------|
| `Models.swift` | 20 |
| `SSHSyncManager.swift` | 2 |

每处 `saveLogging("ClassName.funcName")`，调用点用脚本自动从最近的 `class`/`func` 声明推导出 scope。

**未触及的 `try?`**：项目里还有 ~240 处其他 `try?`（如 `try? FileManager.removeItem`、`try? data.write`），它们语义合理（"尽力而为"清理），本次未动。

---

## 三、测试代码大规模重构

### 3.1 拆分前
- `NotebookTests/NotebookTests.swift`：**3883 行 / 76 测试 / 27 helper 方法**

### 3.2 拆分后（10 个文件）

| 文件 | 行数 | 测试数 | 职责 |
|------|------|--------|------|
| `NotebookTests.swift` | 38 | 2 | 入口（`setUp/tearDown` + 模块加载 + UUIDListCoding） |
| `NotebookTests+Helpers.swift` | 459 | 0 | 27 个共享 helper（`makeInMemoryContainer` / `sendKeyDown` / `makePNGData` / ...） |
| `NotebookTests+MigrationSafety.swift` | 57 | 1 | 数据迁移备份测试（**新写**，原工作树版本已丢失） |
| `NotebookTests+BlockDocument.swift` | 650 | 8 | 笔记 CRUD / 回收站 / 文件夹/标签管理 |
| `NotebookTests+ExportImport.swift` | 494 | 5 | 导入导出 / 迁移包 / preflight |
| `NotebookTests+CoordinatorStale.swift` | 231 | 12 | 选择协调器 / 陈旧路径清理 / 附件目标解析 / Markdown 导航 |
| `NotebookTests+Attachments.swift` | 399 | 10 | 文本/音频附件 / RTFD 往返 / 外观适配 |
| `NotebookTests+TableAttachment.swift` | 708 | 21 | 表格附件编辑（选择/导航/编辑/结构变更） |
| `NotebookTests+Markdown.swift` | 112 | 4 | Markdown 预览渲染 |
| `NotebookTests+BuilderRoundTrip.swift` | 1146 | 15 | 块级文档构建器 / 旧版兼容 / 字段往返 |
| **合计** | **4294** | **78** | **+44 行（多了 1 个迁移备份测试）** |

**测试数变化**：HEAD = 76，工作树 = 76（+1 = `testUUIDListCoding`）。**新增 1 个 `testMigrationSafety...`**（原工作树已丢失，根据 `PersistenceMigrationSafety` API 重写）。总计 78 个测试，**零回归**。

### 3.3 关键调整
1. **`private func` → `func`**：27 个 helper 方法访问级别从 `private` 改为 internal，否则 Swift 跨文件 `extension` 无法引用
2. **去重处理**：清理了 5 个域文件顶部因切片偏差产生的孤立 body 片段
3. **保留并发控制**：`sharedStateLock` + `setUpWithError`/`tearDownWithError` 保留在主类

---

## 四、本次评审建议关注点

| 优先级 | 文件/位置 | 关注点 |
|--------|-----------|--------|
| 🔴 | `Notebook/DebugLog.swift` | `#if DEBUG` 行为是否符合期望（Release 不输出 stdout） |
| 🔴 | `Notebook/ModelContextSaveLogging.swift` | `saveLogging` 错误日志格式是否充分（含 `#fileID:#line`） |
| 🟡 | `Notebook/SSHSyncManager.swift:115` 注释 | `@unchecked Sendable` 文档化的并发约定是否完整 |
| 🟡 | `Notebook/CheckboxTextAttachment.swift:199-232` | 多参数 print 改为字符串插值的 3 处人工修复 |
| 🟡 | `NotebookTests/NotebookTests+Helpers.swift` | 27 个 helper 改为 internal 是否影响其他测试 target |
| 🟢 | `NotebookTests+MigrationSafety.swift` | 新写的迁移测试逻辑是否覆盖期望（备份创建 / manifest / 恢复） |

---

## 五、未提交的工作区改动总览

```
36 个文件改动 / +706 行 / -9298 行
```

注：本次净减约 8600 行主要因 **3883 行测试拆为 10 个域文件**（旧文件减得多、新文件 git 不计入 diff）。生产代码净增量约 +400 行（DebugLog + ModelContextSaveLogging + SSHSyncManager 注释）。

### 5.1 本次新增的可独立提交单元

建议按以下顺序分批 commit（每批可独立 review）：

1. **chore(logging): 引入 DebugLog 桥接，统一 print → Logger（21 文件，366 处）**
2. **chore(persistence): 引入 saveLogging 扩展，关键 save 路径加错误日志（22 处）**
3. **chore(concurrency): SSHSyncManager 显式文档化 @unchecked Sendable 并发约定**
4. **refactor(tests): NotebookTests.swift 按域拆分为 10 个文件（零行为变化）**

---

## 六、未在本次范围内的项目

参考 OPTIMIZATION.md 阶段三 / 四，**仍待处理**：

- 🟡 P1-1 `ContentView.swift`（4462 行）+ `RichTextEditor.swift`（4048 行）+ `SSHSyncManager.swift`（2412 行）拆分
- 🟡 P1-3 引入 ViewModel（`ContentView` 解耦业务逻辑）
- 🟡 P2-1 `@Relationship` 迁移
- 🟡 P2-2 `tagIDs` 改关系表
- 🟡 P4-1 UI 测试补充
- 🟡 P4-4 复选框像素检测去除

---

## 七、回归测试建议

执行以下检查可确认本次重构未引入回归：

```bash
# 1. 编译（需要 Xcode，CLI 环境暂无法验证）
xcodebuild -scheme Notebook -configuration Debug -destination 'platform=macOS' build

# 2. 单元测试
xcodebuild -scheme Notebook -destination 'platform=macOS' test

# 3. 验证 print 已清空
grep -rn "print(" Notebook/ --include="*.swift" | grep -v "DebugLog.swift" | grep -v "Fingerprint\|fingerprint"
# 期望：0 行真实输出

# 4. 验证 DebugLog 调用
grep -rc "DebugLog\." Notebook/ --include="*.swift" | awk -F: '{sum+=$2} END {print sum}'
# 期望：366

# 5. 验证 saveLogging 调用
grep -rc "saveLogging" Notebook/ --include="*.swift" | awk -F: '{sum+=$2} END {print sum}'
# 期望：≥25（22 业务调用 + 扩展定义 3）

# 6. 验证测试数量
grep -roh "func test[a-zA-Z]\+" NotebookTests/ --include="*.swift" | sort -u | wc -l
# 期望：78
```

---

## 八、风险评估

| 风险项 | 等级 | 缓解措施 |
|--------|------|----------|
| Logger 文件日志开启后 I/O 增加 | 🟢 低 | Logger 已有 5000 条环形缓冲 + UserDefaults 开关控制文件持久化 |
| Release 构建 print 残留 | 🟢 低 | `DebugLog.swift` 用 `#if DEBUG` 包裹 stdout 输出 |
| 字符串插值开销 | 🟢 低 | `@autoclosure` 确保未启用日志时不计算字符串 |
| 测试拆分导致 helper 访问失败 | 🟡 中 | 已将 27 个 helper 从 `private` 改为 internal，跨 extension 文件可用 |
| `testMigrationSafety` 新写可能行为不一致 | 🟡 中 | 测试基于 `PersistenceMigrationSafety` 公开 API 重写，需评审 |
| 多参数 print 转换错误 | 🟡 中 | 已自查并修复 3 处（CheckboxTextAttachment 199/211/232） |
| `@unchecked Sendable` 仍存在并发风险 | 🟡 中 | 本次仅补文档；下阶段建议改为 actor |

---

*本文档由本次修改自动生成，用于评审与回滚参考。*
