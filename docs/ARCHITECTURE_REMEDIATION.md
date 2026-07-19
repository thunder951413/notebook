# 架构评估核对与整改记录

本文记录 2026-07-19 架构评估的代码核对结果。数据安全优先于文件大小或抽象形式；任何后续拆分都必须保持同步契约、快照恢复和跨端回归测试通过。

## 已完成的高风险整改

- macOS 与 Android 共用 `notes/.index-write.lock`，锁已从“只保护 index 写入”提升为完整远程发布锁。
- 锁包含唯一 `owner`，客户端只能释放自己持有的锁；遗留锁先原子改名隔离再接管，避免旧客户端误删新锁。
- Android 在同一把远程锁内完成拉取、冲突判断、合并和发布；macOS 在锁内完成笔记、附件清单、资料库、阅读位置及索引发布。
- macOS 在修改任何远程笔记前预检全部待上传笔记。远程版本更高、相同版本哈希不同或已有删除墓碑时停止推送。
- `notes/index.json` 成功发布前不再更新本地“已同步”状态。失败时保留 dirty/pending 状态，可安全重试。
- 全量推送附件清单时保留仅存在于其他设备的远端条目；冲突笔记不会用本地附件清单覆盖远端状态。
- 远程锁策略与笔记发布判断从 `SSHSyncManager` 拆到独立、可单测的 `RemoteRepositoryWriteLock` / `RemoteNotePublicationGuard`。
- 删除未被 `AIService` 更新的全局 `isLoading/error` 状态；AI 面板的请求状态保留为面板会话本地状态，消除误导性的双状态源。

## 报告中已过时或需要修正的结论

- 报告称 macOS 没有远程锁已经过时：评估时代码已有 index 写锁，但覆盖范围不足。本次完成的是事务范围和所有权安全补强。
- `NoteSyncBackend` 不只是一个生产实现：测试使用 `TestNoteSyncBackend` 注入异常和未配置状态，它是有效测试边界，暂不删除。
- 版本 `contentHash` 用于远程索引、快照指纹和冲突判断；`lastSavedContentHash` 用于保存层脏检查。应用远程快照后清空后者是强制下一次保存重新校准，不是无效计算。
- `NotebookSchemaMigrationPlan` 当前明确作为历史 schema 文档和测试门禁，不接入 `ModelContainer` 是为了规避既有 SwiftData 自定义迁移风险；在替换恢复方案前不能直接删除。
- `ConfigSyncManager` 已复用 `SSHProcessTransport` 的路径查找、参数和环境策略，但仍保留了过程执行包装；后续可继续抽取，不属于当前数据风险。

## 后续渐进式路线

1. 为 SSH 进程、SCP 和远程文件操作定义可注入 transport，先覆盖现有集成测试，再从 `SSHSyncManager` 移出连接生命周期。
2. 按 Note / Attachment / Library / Reading Position 拆同步 engine；每次只移动一种职责，不同时修改远程协议。
3. 引入 Repository 隐藏 `ModelContext`，先从只读列表查询开始，再迁移写入路径。
4. Markdown 双向 AST、附件统一协议和 JSON Schema 代码生成属于协议演进，需要单独版本、双端兼容期和恢复演练。

禁止为了降低行数一次性重写保存或同步核心。每个阶段必须先生成可验证备份，并通过 macOS 全量测试、Android 单测/Lint/编译和共享契约门禁。
