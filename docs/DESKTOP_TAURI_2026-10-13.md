# 桌面版迁移到 Tauri（2026-10-13）

## 为什么

| | Electron 版（notebook-next.app 2.4.0） | Tauri 版（Notebook.app 3.0.0） |
|---|---|---|
| 安装包 | 298 MB | 11 MB |
| 主进程内存 | 约 66 MB（另有 3 个辅助进程） | 约 33 MB（界面由系统 WebKit 承载） |
| 毛玻璃 | CSS 模拟 | 系统原生 vibrancy + CSS 玻璃 |

界面代码（`apps/renderer`）两个外壳共用。**Tauri 是桌面主壳；Electron 版已废弃（2026-10-14 起进入淘汰期）**：只修严重问题、不再加功能，CI 默认产物改为 Tauri，Electron 只在手动触发或 `v*` 标签时打包。代码暂时保留以便回退。

## 结构

```
apps/tauri/
  index.html, src/entry.ts   先加载 bridge，再加载共享界面
  src/bridge.ts              用 Tauri 命令实现 window.notebookDesktop（与 Electron preload 同一接口）
  src-tauri/
    src/lib.rs               窗口、菜单、快捷键、安全退出、所有命令
    src/automation.rs        本地 AI 自动化接口的 Tauri 接线（事件转发、钥匙串令牌）
crates/notebook-sync/        WebDAV v4 日志协议（与 Tauri 无关，任何平台可测）+ 共享 fixtures runner
crates/notebook-automation/  本地自动化 HTTP 接口（127.0.0.1 + Bearer Token），移植自 Electron automationServer.ts
    src/secrets.rs           钥匙串：所有凭据存在一个条目里（JSON）
    src/diagnostics.rs       诊断日志 ~/Library/Logs/io.github.notebook.desktop/
    src/ai.rs                AI 请求代理（API Key 不进入网页进程）
    native/input_source.c    Vim 普通模式切换到 ABC 输入法
```

关键行为：

- **同步**：协议与 Electron / Android 完全一致（journal + head 提交标记 + objects）。每个请求有 60 秒期限（上传按对象数延长），可从界面取消，结果写入诊断日志。
- **安全退出**：关闭窗口只是隐藏（同步继续，重新打开瞬间完成）；⌘Q、Dock 退出、重新载入前都会先让界面保存草稿并做一次有时限的同步，保存失败会询问是否仍要退出。
- **凭据**：一个钥匙串条目。本地构建用 Apple Development 证书签名，钥匙串的“始终允许”在重新构建后仍然有效。
- **数据位置**：笔记库在 `~/Library/WebKit/io.github.notebook.desktop`（WebKit IndexedDB）。新安装不放示例笔记，连接坚果云后自动恢复。
- **Dock 角标**：显示已逾期 + 今天到期的待办数。

## 与 Electron 版的功能对照（2026-10-14）

| 功能 | Electron | Tauri | 说明 |
| --- | --- | --- | --- |
| 坚果云 WebDAV 同步 | ✓ | ✓ | 协议由 `SyncContractFixtures/webdav-v4` 三端共测 |
| 安全退出 / 保存握手 / 草稿 | ✓ | ✓ | |
| 钥匙串凭据、AI Key 隔离 | ✓ | ✓ | |
| 诊断日志、导出 | ✓ | ✓ | |
| 自动更新 | ✓ | ✓ | Tauri 用自带下载器 + SHA-256 |
| Dock 角标、通知、全局快速记录 ⇧⌘N | ✓ | ✓ | |
| Vim 模式切换 ABC 输入法 | ✓ | ✓ | |
| 本地 AI 自动化接口（`/v1/pages`、`/v1/proposals`） | ✓ | ✓（本次补齐） | 同一路由、令牌、错误码；令牌存钥匙串，配置在 `automation-api.v1.json` |
| 菜单栏图标（快速记录 / 打开 / 检查更新 / 退出） | ✓ | ✓（本次补齐） | |
| Windows / Linux 安装包 | ✓ | ✗ | Tauri 版目前只发布 macOS arm64；跨平台是删除 Electron 的前提 |
| 更换数据目录 | ✓ | ✗（不计划） | 数据在 WebKit IndexedDB，由系统管理 |
| 旧版 SSH/SFTP 同步 | ✓ | ✗（不计划） | 只用于旧仓库迁移；需要时临时用 Electron 版导入后改用 WebDAV |

全局快速记录 ⇧⌘N 可用。

## 新界面

三栏：边栏（原生毛玻璃）→ 笔记列表（半透明）→ 编辑区（纸面）。

- 边栏：全部笔记 / 置顶 / 待办（角标）/ 回收站，笔记本（可展开页面树、拖拽排序），标签，底部同步状态。
- 列表：置顶在前，按日期分段（今天、昨天、最近 7 天…），分段标题悬浮；排序可选最近编辑 / 创建时间 / 标题，待办按截止状态；卡片或紧凑密度；上千篇笔记也只渲染可见部分。
- 搜索（⌘F）：多个词同时匹配、"短语"、-排除、#标签、拼音和拼音首字母；在笔记本内搜索时可一键扩大到全部笔记。
- 待办：列表顶部快速添加；圆圈勾选完成（可撤销）；即将到期的待办在列表顶部提示，可完成、稍后（1 小时）或不再提醒。
- 窗口变窄时像手机一样：边栏变成抽屉，再窄则列表和编辑区单栏切换，左上角返回。
- 快捷键：⌘N 新建，⌘F 搜索，⌃⌘S 边栏，⌃⌘L 列表，⌘, 设置，⌘P 命令面板，列表中 ↑↓ / j k 切换，回车进入编辑，⌘⌫ 移到回收站（可撤销），F11 专注。

## 自动更新

- 发布：推送标签 `desktop-v<版本>`（或在 Actions 里手动运行 “Desktop (Tauri)” 并填写版本），`.github/workflows/desktop-tauri.yml` 在 macOS 上构建，发布 `Notebook-macos-arm64.zip` 和 `.sha256`。
- 应用启动 20 秒后检查一次，之后每 6 小时检查；发现新版本自动下载并校验 SHA-256，下载完成后弹出“重启并更新”。设置 → 常规 里也能手动检查。
- 仓库是私有的：需要在 设置 → 常规 → 更新 里填写一个有 repo 读取权限的 GitHub 令牌（存在钥匙串里）。
- 应用没有 Apple 签名。应用内更新用自己的下载器（文件不带隔离标记），解压后执行 `xattr -cr`，退出后由一个小脚本替换 /Applications 里的 Notebook.app 并重新打开；替换失败会还原旧版本。
- 手动下载安装：解压，拖到“应用程序”，执行 `xattr -cr /Applications/Notebook.app`。

## 构建与安装

```sh
cd cross-platform && pnpm install
cd apps/tauri
pnpm test:rust                                    # Rust 同步测试
export APPLE_SIGNING_IDENTITY="Apple Development: …"   # 可选，见 security find-identity -v -p codesigning
pnpm tauri:build
cp -R src-tauri/target/release/bundle/macos/Notebook.app /Applications/
```

## 从 Electron 版迁移

两个应用使用不同的设备 ID，可以同时连接同一个坚果云目录，互不影响。在 Notebook.app 中打开 设置（⌘,）→ 同步与连接，填入与旧版相同的 WebDAV 地址、用户名、应用密码、远端目录和隐私同步密钥，开启自动同步即可恢复全部笔记。确认无误后再决定是否删除旧版。
