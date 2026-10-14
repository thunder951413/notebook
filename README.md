# Notebook Next

Notebook Next 是本地优先的 Markdown 桌面笔记应用。`next` 分支维护桌面外壳、两者共用的渲染层、共享数据模型、坚果云 WebDAV 同步协议和旧数据迁移工具；旧 Swift/macOS 应用不在本分支中。

> **桌面主壳是 Tauri（`cross-platform/apps/tauri`，Notebook.app 3.x）。Electron 外壳（`cross-platform/apps/desktop`，notebook-next 2.x）已废弃，进入淘汰期：**
> 只修复严重问题，不再增加功能，CI 默认不再打包；代码暂时保留以便回退，计划在 Tauri 版覆盖 Windows/Linux 后删除。
> 两个外壳的功能差距与迁移方法见 [桌面版迁移到 Tauri](docs/DESKTOP_TAURI_2026-10-13.md)。

坚果云 WebDAV 是当前正式、推荐的跨设备同步方式。SSH/SFTP 只保留为旧仓库迁移与故障恢复兼容工具，不建议继续作为日常同步后端。

## 核心能力

- Markdown/GFM 是唯一持久正文格式，支持标题、粗体、斜体、链接、代码、表格、任务列表和引用。
- 图片、附件和录音作为内容寻址资源保存，不写入正文或历史快照。
- 本地优先编辑、版本历史、回收站、提醒、任务、导入导出和隐私笔记本访问锁。
- 即时崩溃草稿、退出前保存握手、原子数据目录切换和 Markdown-only 历史压缩。
- 通过坚果云 WebDAV 与 Android 共享笔记、附件、版本和阅读位置。
- 桌面发行：Tauri 版（macOS Apple Silicon，`desktop-v*` 标签发布）；已废弃的 Electron 版仍可手动打包 Windows NSIS/portable、Linux AppImage、macOS dmg/zip。

## 目录

```text
cross-platform/
  apps/tauri/         Tauri 桌面主壳（Rust 命令 + window.notebookDesktop 桥）
  apps/desktop/       [已废弃] Electron 主进程、预加载脚本与打包配置
  apps/renderer/      两个外壳共用的 React 界面（不是独立 Web 产品）
  crates/             与 Tauri 无关、可在任何平台构建测试的 Rust 库（WebDAV 同步、本地自动化接口）
  packages/           领域模型、Electron 渲染层存储和同步协议
  services/ai/        可选 AI 服务
  services/collaboration/  可选在线协作服务
  scripts/            旧数据导入和仓库迁移工具
SyncContractFixtures/ 跨版本导入与同步兼容测试数据；webdav-v4/ 是三端（Rust/TS/Kotlin）共用的协议一致性 fixtures
docs/                 当前架构、迁移和 SSH v3 文档
```

Android 客户端在独立仓库中维护，本仓库仅保留与它共享的远端协议和兼容测试。

## 开发

需要 Node.js 24、pnpm 11.9 和 Rust stable：

```bash
cd cross-platform
pnpm install --frozen-lockfile
cd apps/tauri && pnpm tauri:dev      # Tauri 主壳
```

质量检查：

```bash
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path crates/notebook-sync/Cargo.toml        # 同步协议 + 共享 fixtures
cargo test --manifest-path crates/notebook-automation/Cargo.toml  # 本地自动化接口
(cd apps/tauri && pnpm test:rust)                                 # Tauri 壳（需要 macOS 或 WebKitGTK）
```

生成 Notebook.app：`cd apps/tauri && pnpm tauri:build`。已废弃的 Electron 安装包只在需要回退时手动生成：`pnpm --filter @notebook/desktop dist`。

## 数据与同步

Electron 数据目录与旧 SwiftData 数据库不兼容，旧数据必须通过导出包导入。不要把旧 `NotebookData` 或 `notebook.store` 直接设为 Electron 数据目录。具体见 [数据迁移说明](docs/DATA_MIGRATION_READINESS.md) 和 [SSH Markdown v3](docs/SSH_MARKDOWN_SYNC_V3.md)。

隐私笔记本提供应用内访问控制。配置两端相同的隐私同步密钥后，WebDAV 将私密笔记本、正文、附件字节、历史和关系使用 AES-256-GCM 加密同步。密钥由系统凭据存储保存，网盘只接收密文；未配置密钥时私密内容仍保留在本机。错误密钥或损坏密文不会覆盖本机内容或推进同步位置。旧 SSH 迁移兼容路径仍会加密私密正文，但私密附件不会上传。

可选在线协作服务通过 WebSocket 协议接收客户端令牌，并校验工作区与页面范围；绑定非本机地址时必须配置 `NOTEBOOK_JWT_SECRET`。`owner` 和 `editor` 可编辑，`viewer` 由服务端强制只读，编辑器同时禁用正文修改入口。连接完成验证前保持只读；令牌刷新导致权限降级时，现有连接与界面立即应用新权限。

## 桌面发行

- **Tauri（默认）**：每次推送到 `next` 都在 CI 中构建 Notebook.app 并作为工作流产物上传；推送 `desktop-v<版本>` 标签发布 `Notebook-macos-arm64.zip`，应用内自动更新读取该 Release。
- **Electron（已废弃）**：只在手动运行 “Electron (deprecated)” 工作流或推送 `v*` 标签时为 Windows、Linux 和 macOS 打包。

项目没有 Apple Developer 账号，因此 macOS 产物有意保持未签名、未公证；下载后如被系统隔离，可在终端对解压出的应用执行：

```bash
xattr -rc /Applications/Notebook.app
```

然后从 Finder 打开。该命令只应对从本项目 Release 下载并核对过 SHA-256 的应用执行。

## 许可

[MIT](LICENSE)

## 问题诊断

各端都提供容量受限的本地诊断日志。发生问题时提供时间和操作，按 [日志提取说明](docs/DIAGNOSTICS.md) 导出；Android Debug 可通过 adb 提取。
