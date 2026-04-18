# Notebook - 极简 macOS 富文本笔记与提醒工具

Notebook 是一款专为 macOS 设计的轻量级富文本笔记应用。它结合了优雅的界面设计与实用的功能，支持多层级文件夹管理、富文本编辑、音频录制以及强大的提醒系统。

## ✨ 功能特性

- **📂 智能分类**：支持自定义文件夹，轻松管理不同主题的笔记。
- **📝 强大编辑**：基于 `NSTextView` 的富文本编辑器，支持：
  - 粗体、斜体、下划线、标题样式。
  - 列表、多选框（Checklist）。
  - 图片与附件插入。
- **🎙️ 语音记录**：直接在笔记中录制音频，并以附件形式保存和播放。
- **⏰ 定时提醒**：为笔记设置一次性或周期性（每天、每周、每月）提醒，通过 macOS 系统通知确保不错过重要事项。
- **🔍 快速搜索**：全局实时搜索笔记内容和标题。
- **💎 状态栏集成**：
  - 隐藏在菜单栏的快捷图标。
  - 快速查看最近笔记。
  - 点击放大按钮即可快速唤起主界面。
- **💾 灵活存储**：支持自定义数据存放位置，保障数据隐私。
- **🌓 自动主题**：完美适配 macOS 浅色与深色模式。

## 🛠️ 技术架构

- **SwiftUI**：构建现代化、响应式的用户界面。
- **SwiftData**：苹果最新的高性能数据持久化框架。
- **AppKit**：深度定制底层窗口行为与富文本能力。
- **AVFoundation**：实现高质量音频录制与播放。
- **UserNotifications**：精准的本地推送系统。

## 🚀 快速开始

### 环境要求
- macOS 14.0 (Sonoma) 或更高版本
- Xcode 15.0+

### 安装与运行
1. 克隆仓库：
   ```bash
git clone https://github.com/thunder951413/notebook.git
   ```
2. 使用 Xcode 打开 `Notebook.xcodeproj`。
3. 编译并运行项目。

## 📦 发版

仓库已配置 GitHub Actions 自动发布流程：当推送 `v*` 格式的 tag 时，会自动构建并创建 GitHub Release。

可使用本地脚本一键发版：

```bash
./scripts/release.sh 1.0.1
```

脚本会自动执行以下步骤：

- 检查当前 Git 工作区是否干净
- 更新 `Notebook.xcodeproj/project.pbxproj` 中的 `MARKETING_VERSION`
- 更新 `Notebook.xcodeproj/project.pbxproj` 中的 `CURRENT_PROJECT_VERSION`
- 创建发版提交
- 创建如 `v1.0.1` 的注释 tag
- 推送提交和 tag 到 `origin`，从而触发 GitHub Release 工作流

常用参数：

```bash
# 指定 build number
./scripts/release.sh 1.0.1 42

# 仅预览，不实际修改
./scripts/release.sh 1.0.1 --dry-run

# 只在本地创建提交和 tag，不推送
./scripts/release.sh 1.0.1 --no-push
```

## 📸 预览

*(在此处添加你的应用截图)*

## 📄 开源协议

本项目采用 [MIT 许可协议](LICENSE)。

---

*由 [Yan Yan](https://github.com/thunder951413) 开发*
