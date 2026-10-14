# Electron Release 与自动更新

> **已废弃**：Electron 外壳自 2026-10-14 起进入淘汰期，桌面主壳改为 Tauri（`apps/tauri`）。本文档仅用于需要回退时手动打包，见 [桌面版迁移到 Tauri](../../../docs/DESKTOP_TAURI_2026-10-13.md)。

Notebook Next 的 Electron 版本从 `2.0.0` 开始。旧版 macOS Notebook 的 `v1.x` Release
不属于 Electron 更新通道，客户端只识别带 electron-builder 更新元数据的公开 Release。

当前仓库为私有仓库。客户端不能内置仓库 Token；需要在“设置 → 常规 → 应用更新”中配置
只授予该仓库 `Contents: Read` 的 fine-grained Token。它由 Electron `safeStorage` 使用操作
系统凭据加密保存，并同时用于 Release 检查、更新元数据和安装包下载。仓库改为公开后可
清除该 Token。

## 支持矩阵

| 平台 | 推荐安装包 | 更新元数据 | 应用内安装 |
| --- | --- | --- | --- |
| macOS | DMG（同时发布 ZIP） | `latest-mac.yml` | 支持；必须签名，正式分发应公证 |
| Windows | NSIS | `latest.yml` | 支持；正式分发应使用代码签名 |
| Windows | Portable | `latest.yml` | 只检测，跳转 Release 手动替换 |
| Linux | AppImage / DEB | `latest-linux.yml` | electron-updater 支持；受发行版安装权限约束 |

任何平台在缺少安装元数据或使用不支持的包型时，仍会检查 GitHub Release，并明确回退到
发布页，不会静默失败。

## 发布约束

1. 在 `apps/desktop/package.json` 更新版本，版本必须大于现有 Electron Release。
2. 在对应操作系统上执行 `pnpm --filter @notebook/desktop dist -- --publish always`。
3. macOS、Windows、Linux 的产物必须上传到**同一个草稿 Release**，并确认同时存在：
   `latest-mac.yml`、`latest.yml`、`latest-linux.yml`。
4. 验证签名、SHA-512 元数据和下载链接后，再把草稿发布为正式 Release。草稿和预发布版本
   不会推送给普通客户端。
5. 发布后分别从上一正式版本执行“设置 → 常规 → 应用更新”，验证发现版本、下载进度、
   校验、保存当前笔记、重启安装和版本号。

不要只上传 DMG、EXE、AppImage 等二进制而遗漏 YAML；客户端会把这种 Release 视为不完整，
从而避免下载到旧版或其他平台的安装包。

## 签名与公证环境

- macOS 签名由 electron-builder 从钥匙串或 `CSC_LINK` / `CSC_KEY_PASSWORD` 读取证书，并
  强制启用 hardened runtime 与仓库内的 `build/entitlements.mac.plist`。
- macOS 公证优先读取 App Store Connect API Key：
  `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`；也支持
  `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。
- Windows Authenticode 由 electron-builder 使用 `CSC_LINK` / `CSC_KEY_PASSWORD`。
- CI 中没有签名凭据时只执行构建验证，不产生可发布安装包。正式 Release 不得发布未签名
  的 macOS 或 Windows 自动更新产物。
