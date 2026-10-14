# Notebook Next

Notebook Next 是面向 Windows、Linux 和 macOS 的 Electron 桌面笔记应用。`next` 分支维护 Electron 产品及其运行所需的渲染层、共享数据模型、坚果云 WebDAV 同步协议和旧数据迁移工具；旧 Swift/macOS 应用不在本分支中。

坚果云 WebDAV 是当前正式、推荐的跨设备同步方式。SSH/SFTP 只保留为旧仓库迁移与故障恢复兼容工具，不建议继续作为日常同步后端。

## 核心能力

- Markdown/GFM 是唯一持久正文格式，支持标题、粗体、斜体、链接、代码、表格、任务列表和引用。
- 图片、附件和录音作为内容寻址资源保存，不写入正文或历史快照。
- 本地优先编辑、版本历史、回收站、提醒、任务、导入导出和隐私笔记本访问锁。
- 即时崩溃草稿、退出前保存握手、原子数据目录切换和 Markdown-only 历史压缩。
- 通过坚果云 WebDAV 与 Android 共享笔记、附件、版本和阅读位置。
- Electron 打包目标：Windows NSIS/portable、Linux AppImage、macOS dmg/zip。

## 目录

```text
cross-platform/
  apps/desktop/       Electron 主进程、预加载脚本与打包配置
  apps/renderer/      Electron React 渲染进程（不是独立 Web 产品）
  packages/           领域模型、Electron 渲染层存储和同步协议
  services/ai/        可选 AI 服务
  services/collaboration/  可选在线协作服务
  scripts/            旧数据导入和仓库迁移工具
SyncContractFixtures/ 跨版本导入与同步兼容测试数据
docs/                 当前架构、迁移和 SSH v3 文档
```

Android 客户端在独立仓库中维护，本仓库仅保留与它共享的远端协议和兼容测试。

## 开发

需要 Node.js 24 和 pnpm 11.9：

```bash
cd cross-platform
pnpm install --frozen-lockfile
pnpm dev
```

质量检查：

```bash
pnpm typecheck
pnpm test
pnpm build
```

生成当前平台安装包：

```bash
pnpm --filter @notebook/desktop dist
```

## 数据与同步

Electron 数据目录与旧 SwiftData 数据库不兼容，旧数据必须通过导出包导入。不要把旧 `NotebookData` 或 `notebook.store` 直接设为 Electron 数据目录。具体见 [数据迁移说明](docs/DATA_MIGRATION_READINESS.md) 和 [SSH Markdown v3](docs/SSH_MARKDOWN_SYNC_V3.md)。

隐私笔记本提供应用内访问控制。配置两端相同的隐私同步密钥后，WebDAV 将私密笔记本、正文、附件字节、历史和关系使用 AES-256-GCM 加密同步。密钥由系统凭据存储保存，网盘只接收密文；未配置密钥时私密内容仍保留在本机。错误密钥或损坏密文不会覆盖本机内容或推进同步位置。旧 SSH 迁移兼容路径仍会加密私密正文，但私密附件不会上传。

可选在线协作服务通过 WebSocket 协议接收客户端令牌，并校验工作区与页面范围；绑定非本机地址时必须配置 `NOTEBOOK_JWT_SECRET`。`owner` 和 `editor` 可编辑，`viewer` 由服务端强制只读，编辑器同时禁用正文修改入口。连接完成验证前保持只读；令牌刷新导致权限降级时，现有连接与界面立即应用新权限。

## 桌面发行

版本标签会为 Windows、Linux 和 macOS 生成安装包及 SHA-256 清单。项目没有 Apple Developer 账号，因此 macOS 产物有意保持未签名、未公证；下载后如被系统隔离，可在终端对解压出的应用执行：

```bash
xattr -rc "/Applications/notebook-next.app"
```

然后从 Finder 打开。该命令只应对从本项目 Release 下载并核对过 SHA-256 的应用执行。

## 许可

[MIT](LICENSE)

## 问题诊断

各端都提供容量受限的本地诊断日志。发生问题时提供时间和操作，按 [日志提取说明](docs/DIAGNOSTICS.md) 导出；Android Debug 可通过 adb 提取。
