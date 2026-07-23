# Notebook 跨平台重构执行方案

## 1. 产品目标

新版本以 Windows、macOS、Linux 桌面端为第一发布目标，同时复用同一套前端提供浏览器/PWA 版本。产品从单机 macOS 笔记应用升级为：

- OneNote 式笔记本、分区、页面组织；
- 页面文档与 Markdown 源码双向编辑；
- AI 对话、检索、改写和总结；
- 离线优先、恢复可靠、支持实时多人协作；
- 无损导入现有 macOS/Android 数据与附件；
- Windows、macOS、Linux 一致的编辑和渲染表现。

## 2. 已确认技术决策

### 2.1 桌面壳：Electron 为主，PWA 为并行目标

选择 Electron 的决定性原因是它捆绑统一 Chromium。富文本、Markdown、图片混排和协作选区需要一致渲染，统一渲染引擎比安装包体积更重要。

Tauri 保留为未来可选适配器，但不作为首发壳：Windows 使用 WebView2，而 macOS/Linux 使用 WebKit；Linux WebKitGTK 版本又由发行版决定。复杂编辑器会因此承担额外兼容矩阵。

Electron 安全基线：

- `contextIsolation: true`；
- `sandbox: true`；
- `nodeIntegration: false`；
- renderer 只调用经过类型约束和白名单控制的 preload API；
- 禁止任意导航、任意新窗口和 renderer 直接文件访问；
- AI 密钥进入操作系统凭据库，不写入网页存储；
- 外部内容先净化，再进入编辑器或预览。

### 2.2 Web 前端

- React + TypeScript + Vite；
- Fluent UI React v9：提供接近 OneNote/Microsoft 365 的可访问组件和设计令牌；
- Tiptap（ProseMirror）：结构化富文本编辑器；
- CodeMirror 6：Markdown 源码、代码块和大型纯文本编辑；
- Yjs：文档 CRDT、离线更新与多人合并；
- Hocuspocus：自托管 Yjs WebSocket 协作服务；
- Tiptap Markdown：GFM Markdown 解析、转换和安全渲染；
- Mermaid：图表；KaTeX：数学公式；Shiki：代码高亮；
- Dexie/IndexedDB：浏览器离线元数据；桌面端通过 repository 接口使用 SQLite。

不自行实现 Markdown 解释器、富文本排版引擎、CRDT、图布局、Canvas 手势系统或代码高亮器。

### 2.3 桌面和服务端数据

```text
React UI
  -> Repository / Platform API
     -> Electron: preload IPC -> SQLite + filesystem + OS credential vault
     -> Web/PWA: IndexedDB + File System Access API（可用时）
  -> Yjs document
     -> y-indexeddb（离线）
     -> Hocuspocus WebSocket（在线协作）

Collaboration service (TypeScript/Hocuspocus)
  -> authentication + presence + Yjs update persistence

Application API (Python/FastAPI)
  -> AI provider gateway
  -> document/OCR/audio ingestion jobs
  -> embeddings + semantic search
  -> retrieval APIs
```

Python 是服务端 AI/知识处理层，不是桌面 UI 后端。桌面端离线时仍可编辑、搜索本地数据并排队 AI/同步任务。

## 3. OneNote 式界面信息架构

桌面宽屏采用五个稳定区域：

```text
┌────────┬────────────────┬──────────────────┬──────────────────────────────┬────────────────┐
│ 功能轨 │ 笔记本/分区树  │ 页面列表         │ 页面 / Markdown              │ AI 面板         │
│ 56 px  │ 236 px         │ 300 px           │ 自适应                         │ 320 px 可收起   │
└────────┴────────────────┴──────────────────┴──────────────────────────────┴────────────────┘
```

- 功能轨：笔记、任务、AI、回收站和设置；
- 笔记本/分区树：对应 OneNote 的 Notebooks 和 Sections，同时兼容现有文件夹/标签；
- 页面列表：标题、摘要、标签、时间、协作者、同步状态；
- 主工作区：页面富文本和 Markdown 源码两种视图；
- 上方分区标签：保留 OneNote “活页夹标签”感觉，可横向切换常用分区；
- AI 面板：使用当前页面、选区或笔记本作为明确上下文，不遮挡正文；
- 小屏：功能轨常驻，其余面板按抽屉/主视图逐级收起；
- 所有面板可拖动调整宽度、用快捷键开关，并保存工作区布局。

OneNote 值得保留的部分：笔记本→分区→页面层级、快速捕获和长页面。需要补强的部分：语义检索、版本历史、可靠同步和可审计 AI。

## 4. 领域模型

核心身份全部使用 UUID，迁移时保留旧 ID：

- Workspace / Member / Role
- Notebook / Section / Page
- PageDocument（Tiptap JSON + Yjs state）
- Tag / PageTag
- Link / Backlink / Mention
- Task / TaskStep / Reminder
- Asset / AssetVariant / Upload
- Revision / Snapshot
- AIThread / AIMessage / Citation / ToolRun
- SyncCursor / Tombstone / ImportJob

现有 `Folder(noteFolder|todoList)` 导入为 Section；`Note(note|todo)` 导入为 Page 或 Task；现有 block JSON 和 Markdown 都通过版本化 importer 进入 PageDocument。旧 SSH/SFTP 格式保持只读/双写兼容期，直到所有已安装客户端完成迁移。

## 5. 功能迁移验收矩阵

| 能力 | macOS 现状 | Android 现状 | 新版本要求 |
|---|---|---|---|
| 笔记/文件夹/标签 | 已有 | 已有 | Notebook/Section/Page + 标签，无损导入 |
| 三栏导航 | 已有 | Pad 已有 | OneNote 式可调整多栏布局 |
| 富文本 | TextKit + Muya | 基础编辑 | Tiptap，表格/任务/公式/代码/链接/附件 |
| Markdown 源码 | CodeMirror | 基础 | CodeMirror 6，双向转换和差异提示 |
| Markdown 预览 | 自有 renderer + Web | Markwon | Tiptap Markdown，不再维护自有解析器 |
| 长文 | 分块加载 | 分块阅读 | 虚拟化、增量保存、性能基准 |
| Todo/步骤/提醒 | 已有 | 已有 | 任务视图、日历、负责人、重复规则 |
| 图片/音频/文件 | 已有 | 已有 | 上传、预览、转码、OCR/转录、引用 |
| 录音 | 麦克风/系统混录 | 麦克风 | 跨平台录音；系统音频按平台能力降级 |
| 搜索 | 本地全文 | 本地全文 | 全文 + 语义 + 当前文档搜索 |
| AI 多模型 | 已有基础 | 未完整 | Provider adapter、流式响应、引用、工具调用 |
| 实时协作 | 无 | 无 | Yjs、在线状态、光标、版本快照 |
| SSH/SFTP 同步 | 已有 | 已有 | 兼容导入/双写；新协作服务为主同步 |
| iCloud/本地同步 | 已有 | 不适用 | 迁移入口；通用云端/自托管同步 |
| 冲突/墓碑/锁 | 已有 | 已有 | CRDT 文档 + 元数据冲突策略 + 审计日志 |
| 回收站 | 已有 | 已有 | 可恢复软删除与保留策略 |
| 导入导出/备份 | 已有 | 部分 | Markdown、HTML、PDF、JSON、旧数据包、自动备份 |
| 加密文件夹 | 已有 | 已有基础 | OS 凭据库、本地加密、可选端到端加密空间 |
| 通知 | 已有 | 已有 | Electron/浏览器通知、深链和跨设备去重 |
| 菜单栏/托盘 | 已有 | 不适用 | 三平台托盘、快速记录、全局快捷键 |
| 快捷键/径向菜单 | 已有 | 不适用 | 命令面板、可配置快捷键；径向菜单作为插件 |
| 国际化/主题 | 中英/深浅色 | 深浅色 | 中英、深浅/高对比、系统缩放与无障碍 |
| 自动更新 | GitHub Release | GitHub Release | 签名更新、Windows/macOS/Linux 发布通道 |

## 6. 实施阶段和退出标准

1. **基础仓库和 UI 壳**：Web/PWA 与 Electron 启动；Fluent 主题、多栏布局、响应式和无障碍冒烟测试。
2. **本地领域层**：Repository 接口、SQLite/IndexedDB、草稿日志、软删除、附件事务和迁移夹具。
3. **编辑器**：Tiptap、CodeMirror、Markdown 导入导出、表格/公式/Mermaid/附件、长文基准。
4. **组织与任务**：Notebook/Section/Page、标签、搜索、Todo、提醒、回收站。
5. **AI**：FastAPI、provider adapters、RAG、引用、结构化写回和权限确认。
6. **协作**：Yjs/Hocuspocus、presence、快照、离线重连和权限。
7. **兼容迁移**：SwiftData 导出包、Android/SSH 协议、附件校验、双写演练。
8. **系统能力和发布**：凭据、通知、录音、托盘、快捷键、更新、签名安装包。
9. **最终验收**：矩阵无缺项；Windows/macOS/Linux E2E；数据损坏/断网/崩溃恢复测试；视觉回归和性能预算通过。

## 7. 参考依据

- OneNote 导航和组织：https://support.microsoft.com/en-us/onenote/onenote-help-and-learning/navigate-your-notes-with-onenote
- OneNote 页面与分区：https://support.microsoft.com/en-us/onenote/organize-your-notes
- Fluent UI React：https://fluent2.microsoft.design/components/web/react/
- Electron 架构：https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron 安全：https://www.electronjs.org/docs/latest/tutorial/security
- Tauri WebView 差异：https://v2.tauri.app/reference/webview-versions/
- Tiptap：https://tiptap.dev/docs/editor/getting-started/overview
- Yjs：https://docs.yjs.dev/
- Yjs 离线：https://docs.yjs.dev/getting-started/allowing-offline-editing

## 8. 已交付实现与验收结果

截至 2026-07-22，`cross-platform/` 已提供可运行的 Web/PWA 与 Electron 实现：

- OneNote 式笔记本、分区、页面、Todo、回收站、页面重命名和跨正文全文检索；
- Tiptap/ProseMirror 富文本、官方 GFM Markdown 双向编辑、表格、任务列表、代码块、KaTeX 公式和 HTML/Markdown/PDF 输出；
- 每页 Yjs + y-indexeddb 离线文档，配置 Hocuspocus 地址后启用鉴权协作、在线状态和协作光标；
- LiteLLM 流式问答、全文与向量混合检索、引用、FastAPI 语义索引；
- 游标式元数据同步、幂等 outbox、乐观冲突、自动版本快照与恢复；
- 附件 Blob、麦克风录音、提醒通知、托盘、快速记录、系统凭据存储；
- macOS/Android 共享契约和 macOS 文档迁移包批量导入，含 UUID、日期、任务步骤、标签、链接、阅读位置、版本、墓碑、附件与 sidecar；直接打开旧 SwiftData 数据库不受支持，接入边界见 `DATA_MIGRATION_READINESS.md`；
- Markdown/HTML/纯文本/JSON/ZIP 导入，含附件的完整 ZIP 备份，以及 PBKDF2 + AES-256-GCM `.nbx` 加密备份；
- Electron 安全基线、Windows NSIS/portable、macOS DMG/ZIP、Linux AppImage/DEB、PWA 和 GitHub 草稿发布/自动更新工作流。

本地验收包括 monorepo 全量 TypeScript 类型检查、Vitest、Python API、Web/PWA 与 Electron production build、响应式布局和隔离数据目录冒烟。Windows/Linux 安装包由同一 GitHub Actions 矩阵在对应原生 runner 生成；原生安装与签名仍以 CI 产物为最终验收依据。

生产部署必须提供相应外部配置：AI 模型提供方密钥、应用 API/Hocuspocus 地址、JWT 或自托管令牌，以及 macOS/Windows 代码签名凭据。没有服务地址时应用保持离线优先，本地编辑、搜索、任务、附件、版本和备份不受影响。
