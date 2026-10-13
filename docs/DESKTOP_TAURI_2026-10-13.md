# 桌面版迁移到 Tauri（2026-10-13）

## 为什么

| | Electron 版（notebook-next.app 2.4.0） | Tauri 版（Notebook.app 3.0.0） |
|---|---|---|
| 安装包 | 298 MB | 11 MB |
| 主进程内存 | 约 66 MB（另有 3 个辅助进程） | 约 33 MB（界面由系统 WebKit 承载） |
| 毛玻璃 | CSS 模拟 | 系统原生 vibrancy + CSS 玻璃 |

界面代码（`apps/renderer`）两个外壳共用；Electron 版仍可构建，作为后备保留。

## 结构

```
apps/tauri/
  index.html, src/entry.ts   先加载 bridge，再加载共享界面
  src/bridge.ts              用 Tauri 命令实现 window.notebookDesktop（与 Electron preload 同一接口）
  src-tauri/
    src/lib.rs               窗口、菜单、快捷键、安全退出、所有命令
    src/webdav.rs            WebDAV v4 日志协议（逐行移植自 apps/desktop/src/main/webdav.ts）
    src/webdav/tests.rs      17 项测试，跑在内存 WebDAV 服务器上
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

暂未移植：自动更新（菜单“检查更新”打开发布页）、本地 AI 接口（automation）、旧版 SSH/SFTP 同步、菜单栏图标。全局快速记录 ⇧⌘N 可用。

## 新界面

三栏：边栏（原生毛玻璃）→ 笔记列表（半透明）→ 编辑区（纸面）。

- 边栏：全部笔记 / 置顶 / 待办（角标）/ 回收站，笔记本（可展开页面树、拖拽排序），标签，底部同步状态。
- 列表：置顶在前，按日期分段（今天、昨天、最近 7 天…），分段标题悬浮；排序可选最近编辑 / 创建时间 / 标题，待办按截止状态；卡片或紧凑密度；上千篇笔记也只渲染可见部分。
- 搜索（⌘F）：多个词同时匹配、"短语"、-排除、#标签、拼音和拼音首字母；在笔记本内搜索时可一键扩大到全部笔记。
- 待办：列表顶部快速添加；圆圈勾选完成（可撤销）；即将到期的待办在列表顶部提示，可完成、稍后（1 小时）或不再提醒。
- 窗口变窄时像手机一样：边栏变成抽屉，再窄则列表和编辑区单栏切换，左上角返回。
- 快捷键：⌘N 新建，⌘F 搜索，⌃⌘S 边栏，⌃⌘L 列表，⌘, 设置，⌘P 命令面板，列表中 ↑↓ / j k 切换，回车进入编辑，⌘⌫ 移到回收站（可撤销），F11 专注。

## 构建与安装

```sh
cd cross-platform && pnpm install
cd apps/tauri
pnpm test:rust                                    # Rust 同步测试
export APPLE_SIGNING_IDENTITY="Apple Development: …"   # 可选，见 security find-identity -v -p codesigning
pnpm exec tauri build
cp -R src-tauri/target/release/bundle/macos/Notebook.app /Applications/
```

## 从 Electron 版迁移

两个应用使用不同的设备 ID，可以同时连接同一个坚果云目录，互不影响。在 Notebook.app 中打开 设置（⌘,）→ 同步与连接，填入与旧版相同的 WebDAV 地址、用户名、应用密码、远端目录和隐私同步密钥，开启自动同步即可恢复全部笔记。确认无误后再决定是否删除旧版。
