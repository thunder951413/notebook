# Notebook Android 真机推送与系统笔记 UI 校准

日期：2026-10-11。沿用用户已确认的目标：学习 ColorOS 系统“笔记” `com.oplus.aipaper` 的布局、交互与切换效果，改造 Android Notebook，同时保留现有笔记、Markdown、同步与加密能力。会议实时转写、实际 AI 生成、实际 OCR 和大字体专项适配不在范围内。

## 已安装交付

| 项目 | 结果 |
| --- | --- |
| 手机 | OPPO PMX110，Android 17／API 37，1080×2354，480 dpi |
| 应用名称 | Notebook UI 预览 |
| 包名 | `io.github.notebook.android.nexttest` |
| 版本 | `0.4.0-ui.3-debug`，versionCode 10044 |
| 工作分支 | 独立 Android 仓库的 `codex/coloros-notes-ui` |
| 本轮提交 | `9d1eecdeba20e1c7c7ef0481884ae9e5cc9de0b6` |
| 安装方式 | ADB 安装独立 debug 包，后续使用 `install -r` 保留预览数据 |
| APK 校验 | 手机已安装 APK 的 SHA-256 与交付 APK 相同 |
| SHA-256 | `bfb9a79b0ed141e75f67bc380729ec5503a37e7a9e07bd8231682d2ff7f456f6` |

交付 APK：[Notebook-Android-UI-phone-20261011.apk](/Users/surfing/tools/notebook/output/android-phone-refinement-2026-10-11/apk/Notebook-Android-UI-phone-20261011.apk)。安装校验记录：[installed-package.json](/Users/surfing/tools/notebook/output/android-phone-refinement-2026-10-11/verification/installed-package.json)。

未覆盖原有正式 Notebook，没有在真机运行清空 Room 的 instrumentation，没有配置生产同步目录。预览包使用显式 debug 入口幂等添加的 6 篇笔记和 3 个笔记库。系统“笔记”中仅创建并清理了自己的临时参考样本；清理后首页仍为 5 篇，最近删除仍为原有 3 篇。后续键盘对照使用空白新笔记，退出后没有留下新笔记。

## 本轮实现

| 区域 | 改动与实际行为 |
| --- | --- |
| 深色主题 | 修复根层文字／图标缺少前景色的问题。页面为黑色，卡片为深灰，悬浮胶囊和圆形工具使用渐变、描边及阴影。 |
| 首页 | 移除额外品牌标题，校准顶部工具位置、卡片间距、摘要和更新时间字号。“灵光一刻”取现有公开笔记的真实摘录，并能进入对应笔记。 |
| 底部导航 | 笔记／笔记库使用图标加文字，选中态改变前景色；新建按钮和 Todo／设置入口沿用圆形浮动控件。 |
| 新建菜单 | 写笔记、导入笔记均有实际入口。加入背景模糊和进入／退出动画；菜单打开时左侧入口切换为设置。 |
| 阅读页面 | 顶部创建时间、标题、标签排列与参考靠近；文档查找、反向链接、阅读设置保留在更多菜单。原有导出、版本历史、库归属、子页面、复制、删除入口继续可达。 |
| 编辑工具 | 校准目录、撤销、重做、完成的位置，压缩标签／库归属／提醒入口。底部保留格式、双链、图片、添加内容四个工具。源码切换收拢到添加内容面板。 |
| 格式面板 | 五种段落样式横排，选中态明确；粗体、斜体、删除线、代码、列表、缩进和待办改为图标网格，仍直接操作原 Markdown 源。 |
| 键盘与面板 | 使用 IME 实际高度与最近稳定高度承接面板，不再叠加根层 `imePadding`。面板关闭时保持占位等待键盘恢复。只在实际源码模式变化时恢复键盘，避免旧面板状态覆盖用户关闭自动键盘的偏好。 |

本轮没有修改 Room schema、正文持久化格式和同步协议；继承 `1f6249f` 的冲突详情彻底删除、tombstone、迟到保存及远端重放保护。

## 微信输入法问题与真机验证

最初编辑页面有光标，输入法的 `mInputShown`／`mIsInputViewShown` 为 true，但手机与 ADB 截图都没有完整键盘。随后在系统“笔记”的空白编辑页复现同样情况：这是同一个微信输入法服务的异常显示状态，不能仅用 shown 标志判定验收通过。

重启并重新绑定 `com.tencent.wetype/.plugin.hld.WxHldService` 后，系统“笔记”与 Notebook 都恢复完整九宫格。该操作没有清除输入法数据。临时尝试的 `show_ime_with_hard_keyboard` 已恢复原值 0，默认输入法也保持不变。异常出现于 ADB 硬件字符注入之后；这是一条观察到的关联，未把未经证明的内部原因当成结论。

随后用实际屏幕按键拼出 `ce'shi` 并点击“测试”候选，正文提交一次。此前选择的“你好”也保留一次。打开格式面板时键盘退出，关闭格式面板后完整键盘恢复。点击完成、更新安装、停止应用并重新打开后，原演示正文及“你好测试”完整保留。读取独立预览包的本地数据库只核对这一条自建样本，检查原文前缀和中文提交次数；临时数据库副本随后删除。

持久化证据：[phone-persisted-chinese.json](/Users/surfing/tools/notebook/output/android-phone-refinement-2026-10-11/verification/phone-persisted-chinese.json)。

## 最终验证结果

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `testDebugUnitTest` | 178 tests，0 failures，0 errors，0 skipped | `verification/build-summary.json` |
| `lintDebug` | 0 errors，0 fatal，30 warnings | `verification/build.log` 及 Android 构建报告 |
| 深色 API 35 模拟器 | 34 项通过，包含 MainActivity、ReferenceUi、通知导航、草稿恢复 | `verification/device-ui-latest-dark.log` |
| 浅色 API 35 模拟器 | 14 项受影响回归通过；是上述用例的浅色复测，不按独立新增用例累计 | `verification/device-ui-latest-light-affected.log` |
| 真机手动验收 | 首页／库／新建／阅读／编辑／格式、完整输入法、中文保存重启通过 | 最终截图、两段真机录屏及安装／持久化记录 |
| 仓库检查 | `git diff --check` 通过 | 本地工作区 |

新增键盘回归直接等待系统 IME 可见性，验证进入编辑自动弹出与关闭格式面板后恢复，没有调用辅助 `showSoftInput` 来替应用弹键盘。另一项回归覆盖面板操作之后关闭自动键盘再进入编辑。现有格式撤销、混合内容块、源码往返、库归属与解散等回归继续通过。

测试期间曾误写通知测试类名，导致 runner 初始化失败；已改用实际的 `NotificationNavigationTest`，最终深色日志明确为 `OK (34 tests)`。先前失败日志保留用于追溯，不计作最终通过证据。同步后端未在本轮重新运行服务集成测试，上一轮冲突删除修复的 47 项设备回归和进程死亡分阶段结果详见旧修复报告。

## 可查看成果

六屏真机总览仅包含自建预览数据：[phone-ui-contact-sheet.png](/Users/surfing/tools/notebook/output/android-phone-refinement-2026-10-11/phone-ui-contact-sheet.png)。参考应用的原始取证截图留在本地，不包含在总览中。

- [格式面板与完整键盘往返录屏](/Users/surfing/tools/notebook/output/android-phone-refinement-2026-10-11/clips/phone-final-ime-panel.mp4)
- [笔记库切换、卡片展开与返回录屏](/Users/surfing/tools/notebook/output/android-phone-refinement-2026-10-11/clips/phone-final-document-motion.mp4)
- [完整微信输入法截图](/Users/surfing/tools/notebook/output/android-phone-refinement-2026-10-11/evidence/preview-final-full-keyboard.png)
- [格式面板截图](/Users/surfing/tools/notebook/output/android-phone-refinement-2026-10-11/evidence/preview-final-format-panel.png)

## 后续复刻边界与顺序

主要手机布局、编辑／阅读逻辑与切换流程已经可使用，当前交付是独立真机预览。后续精细比对优先处理带图卡片、长标题、标签较多时的布局及容器展开曲线；当前使用公共 Android／Compose 动画、模糊和系统字体，不声称与原厂私有组件逐帧一致。

正文字体、颜色、下划线和对齐仍需先确定 Android 与桌面端共同支持的样式表示和往返规则，再扩展持久化编辑命令；当前没有加入只在一端显示或可能丢失的样式入口。普通 Markdown、源码和未知内容继续保留。用户明确排除的 AI 生成、OCR、会议转写与大字体专项仍不实现。

正式签名包的升级应继续沿用已有签名与数据路径。当前预览包内的演示数据没有被写进原正式包，也没有与原生产同步空间混合。
