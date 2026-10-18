# WebDAV v4 同步协议一致性 fixtures

同一套坚果云 WebDAV 日志协议（v4 日志 + v5 提交标记 `head.json`）目前有三份实现：

| 实现 | 位置 | runner |
| --- | --- | --- |
| Rust（Tauri 主壳的传输层） | `cross-platform/crates/notebook-sync/src/webdav.rs` | `cross-platform/crates/notebook-sync/tests/sync_contract_fixtures.rs`（`cargo test`） |
| TypeScript（Electron 传输层，已废弃但仍维护） | `cross-platform/apps/desktop/src/main/webdav.ts` | `cross-platform/apps/desktop/src/main/syncContract.fixtures.test.ts` |
| TypeScript（两个桌面壳共用的渲染层：隐私加密、合并） | `cross-platform/apps/renderer/src/sync/webdavPrivacy.ts`、`cross-platform/packages/storage-renderer` | `apps/renderer/src/sync/syncContract.fixtures.test.ts`、`packages/storage-renderer/src/syncContract.fixtures.test.ts` |
| Kotlin（Android） | `notebook_android/app/src/main/java/.../sync/WebdavSync.kt`、`WebdavClient.kt`、`WebdavPrivacy.kt` | `WebdavContractFixtureTest.kt`、`WebdavConflictFixtureTest.kt`（JVM 单元测试，Robolectric） |

本目录是唯一的规范来源。Android 仓库在 `app/src/test/resources/sync-contract/webdav-v4/` 保留一份副本以便独立构建；
当两个仓库按 `notebook/notebook_android` 嵌套检出时，`WebdavContractFixtureTest` 会逐字节比对，副本漂移即失败。
修改 fixture 后请同步复制到 Android 仓库。

## 文件与覆盖矩阵

| 文件 | 内容 | Rust | TS 传输层 | TS 渲染层 | Kotlin |
| --- | --- | --- | --- | --- | --- |
| `remote-path.json` | 远端目录规范化与拒绝规则 | ✓ | ✓ | – | ✓ |
| `base-url.json` | HTTPS 要求；`loopback` 用例 Android 正式版更严格地拒绝 | ✓ | ✓ | – | ✓ |
| `layout.json` | `journal/`、`head.json`、`objects/xx/` 路径 | ✓ | ✓ | – | ✓ |
| `journal-parse.json` | 日志逐行解析与校验 | ✓ | ✓ | – | ✓ |
| `journal-compact.json` | 压缩：每实体保留最新记录 + 修订历史环 | ✓ | ✓ | – | ✓ |
| `journal-head.json` | 提交标记的生成与解析 | ✓ | ✓ | – | ✓ |
| `committed-view.json` | 读游标、提交标记、回退重读与“仅读已提交部分” | ✓ | ✓ | – | ✓ |
| `pull-isolation.json` | 单台设备的日志/提交标记异常如何隔离（blocked 原因码、截断检测） | ✓ | ✓ | – | ✓ |
| `pull-order.json` | 多设备记录的应用顺序 | ✓ | ✓ | – | ✓ |
| `propfind-listing.json` | PROPFIND 目录响应解析 | ✓ | –¹ | – | ✓ |
| `privacy-envelope.json` | 加密笔记本封装（AES-256-GCM / PBKDF2），固定 salt/iv 逐字节复现 | 结构² | – | ✓ | ✓ |
| `conflict.json` | 并发编辑的合并与冲突副本 | –³ | – | ✓ | ✓ |

1. Electron 依赖 `webdav` npm 库解析 PROPFIND，不单独测试。
2. Tauri 壳只转发密文（加密在渲染层），Rust 只校验封装结构在传输中不被改写。
3. Tauri 壳的合并在共享渲染层（storage-renderer）完成。

## 约定

- 错误用例只断言“拒绝”，不比较错误文案（各端文案本地化不同）。
- 期望值由人工审定后写死在 JSON 中；哈希、密文等可由 Node 的 `crypto` 复算核对。
