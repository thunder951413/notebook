# Notebook Next

Notebook Next 是面向 Windows、Linux 和 macOS 的 Electron 桌面笔记应用。`next` 分支只维护 Electron 产品及其运行所需的渲染层、共享数据模型、SSH/SFTP 同步协议和迁移工具；旧 Swift/macOS 应用不在本分支中。

## 核心能力

- Markdown/GFM 是唯一持久正文格式，支持标题、粗体、斜体、链接、代码、表格、任务列表和引用。
- 图片、附件和录音作为内容寻址资源保存，不写入正文或历史快照。
- 本地优先编辑、版本历史、回收站、提醒、任务、导入导出和隐私笔记本访问锁。
- 通过 SSH/SFTP 与 Android 共享 Markdown repository v3。
- Electron 打包目标：Windows NSIS/portable、Linux AppImage/deb、macOS dmg/zip。

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

隐私笔记本提供应用内访问控制，不等同于端到端加密；远端 SSH 账户和服务器磁盘仍需妥善保护。

## 许可

[MIT](LICENSE)
