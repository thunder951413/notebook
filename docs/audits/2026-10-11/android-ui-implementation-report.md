# Notebook Android 系统笔记风格改版 · 实施验收

2026-10-11。根据用户授权的 OPPO 系统“笔记”研究，在独立 Android 仓库实现主要界面、交互与切换效果，保留原有 Markdown、笔记数据、附件、历史、待办和同步。用户已明确排除会议实时转写、AI 实际生成、OCR 实际处理、大字体专项适配，并在手机断开后选择优先完成模拟器验收。

## 可审核产物

- [独立预览 APK](/Users/surfing/tools/notebook/output/android-ui-implementation-2026-10-11/apk/Notebook-Android-UI-preview-20261011.apk)
- [实际界面与操作录屏浏览册](/Users/surfing/tools/notebook/output/android-ui-implementation-2026-10-11/index.html)
- [原应用的实机研究](/Users/surfing/tools/notebook/docs/audits/2026-10-11/android-ui-reference-study.md)及[研究浏览册](/Users/surfing/tools/notebook/output/android-reference-study-2026-10-11/index.html)
- [Android 工程说明](/Users/surfing/tools/notebook/notebook_android/docs/UI_REFERENCE_IMPLEMENTATION.md)

预览包名称为“Notebook UI 预览”，包名 `io.github.notebook.android.nexttest`，版本 `0.4.0-ui.1-debug` / `10042`，最低 API 26、目标 API 35，可与正式包并存。本轮没有安装到 OPPO 手机，没有发布正式版本。

## 最终行为

| 方向 | 实现与实际入口 |
| --- | --- |
| 首页 | 笔记／笔记库双标签；灰白背景、圆角卡片、浮动胶囊、创建菜单、长按快捷创建；AI 底部入口改为实际 Todo 入口 |
| 笔记库 | 12 色封面、新建／重命名、添加已有、移入／移出、解散保留笔记或连同笔记移入回收站；保留已有父级、笔记本和排序属性 |
| 搜索筛选 | 展开搜索并收起底部导航；正文深处摘要与关键词；修改／创建／标题排序、类型与归档筛选；二级菜单保留父层，返回按层关闭 |
| 批量与回收站 | 长按多选、复制内容、创建副本、移动、删除；删除确认、已删除预览、恢复与彻底删除确认 |
| 阅读编辑 | 阅读优先，编辑正文显示标题／粗斜体／删除线／列表／引用，以及原生图片、代码、表格；可切换 Markdown 源码；分组撤销重做、保存反馈、目录、标签、双链、历史 |
| 输入与表格 | 工具随 IME，格式与添加面板替换键盘；面板期间不会重新唤起键盘；根层保存选区与展示状态；全屏表格独立于可见列表项，横竖切换、增删末行／列、返回与完成保存 |
| 媒体与文件 | 原有图片、录音、文件／视频资源和系统打开能力；文本导入；Markdown、TXT、DOCX、PDF 与四套图片模板，长图／3:4／1:1 |
| 设置与多屏 | 分组设置、同步配置、编辑偏好、长按创建、普通阅读偏好、浅深色；840 dp 起的常驻三栏，首页工具组仅占列表栏 |
| 动效 | 卡片到全文的几何展开、圆角与遮罩；标签／工具转换、新建背景模糊、搜索、底部面板、父子浮窗与预测返回 |

Room 仍为 version 13。正文源、资源标识、数据实体和共享同步协议没有另起一套；WebDAV、旧 SFTP 和 HTTP 迁移能力继续复用。

## 数据与状态修复

- 收拢 10 月的私密加密、快照与依赖修复，以及 9 月的诊断、草稿和安全 XML 加固。
- 主动恢复走明确恢复路径，旧草稿仍不能将已删除内容复活。
- SQLite 分块按 Unicode 码点推进；编辑／阅读分块不拆开 Emoji 的 UTF-16 代理对。
- 标题、正文键入和格式命令分开进入撤销组，避免一次撤销清空刚输入的整段内容。
- 编辑状态位于文档容器之外；面板或全屏表格期间抑制正文自动请求键盘。表格弹窗不会随 LazyColumn 项离开可见范围而消失。
- 创建副本复制资源字节并重新绑定标识，保留未知快照；完整映射旧附件编号，避免 `sidecar:1` 与 `sidecar:10` 混淆。大正文与快照使用分段查询复制。
- 普通库移动带上子页面；私密与普通归属仍有边界。录音停止与资源提交沿用独立保存作用域。

## 验收与复现

最终测试明细与日志位于 [verification](/Users/surfing/tools/notebook/output/android-ui-implementation-2026-10-11/verification)。最终统计在交付时生成 `summary.json`，以该文件为准。

- 单元测试、lint、debug APK 与测试 APK 构建真实执行。单元测试 174 项通过；lint 没有错误，保留现有 30 项警告。
- API 35 ARM64 隔离手机模拟器运行设备全集：48 项，43 项成功，5 项条件跳过；其中三个进程恢复方法按主机顺序另行执行。
- 进程恢复 prepare／offline／restored 三阶段均成功：断网强制停止后待同步内容仍在，恢复联网发布后另一份新数据库拉回内容。
- 界面专项 11 项通过，包括混合正文的表格旋转、内容块与源码往返、中文输入连接组合命令、格式撤销、长 Unicode 正文、库操作、复制与恢复、空笔记退出和实际导出。
- 浅深色、320／360／393／430 dp、API 35 平板 1280 × 800 dp 以及表格横竖方向进行实际截图检查。证据中的宽度变化只作用于专用模拟器。
- 导出样本的 Markdown 原文一致，DOCX XML 含正确中文，PDF 已渲染目视检查；PDF 提取文字需做 Unicode NFKC 归一化。四套模板 × 三种比例均有输出，正方形 1080 × 1080、3:4 为 1080 × 1440。

主要命令：

```bash
VERSION_CODE=10042 VERSION_NAME=0.4.0-ui.1 \
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
```

设备全集由 `adb -s emulator-5554 shell am instrument -w -r` 调用同一测试 APK 的 AndroidJUnitRunner，显式传入隔离 WebDAV 地址及 SFTP 测试指纹；避免对其他已连接模拟器或手机运行会清空 Room 的测试。三阶段命令脚本为 `output/android-ui-implementation-2026-10-11/verify_process_death.py`。

## 已知差异与边界

- 原厂私有模糊、字体、触感及逐帧运动参数未声称完全一致。用户选择先完成模拟器验收，OPPO 实机安装与最终手感校准仍待手机恢复连接。
- 正文字体、颜色、下划线和对齐未开放，因为现有桌面导入不能保证这些样式往返；需要作为共享格式契约扩展处理。
- 原生格式编辑的选区局限于活动文本块，跨块精确选择使用源码模式；超过 150,000 UTF-16 单位的正文分页源码编辑。
- Markdown 导出保留源；其他格式输出可读文字，原附件继续留在笔记中。固定比例图片无法容纳过长内容时会明确失败，不静默截断。
- 两项依赖外部旧服务的设备用例未配置。中文测试覆盖 Android InputConnection 组合命令与数据结果；没有把它等同于 OPPO 输入法候选栏的实机验收。

实现分支为 `codex/coloros-notes-ui`。源码只在独立 Android 仓库及本次审计文档中修改，桌面仓库已有的未提交开发内容保留。

## 交付校验

界面证据为 31 张截图、8 段 H.264 录屏。浏览器确认资源全部加载，正文筛选显示 12 张截图，放大后 Escape 能关闭，390 px 手机视图无横向溢出。

APK SHA-256：`fe57b43305ad885f0a29f9da37b708bf19b3471f76dd4306f6f2fd9d2d255a76`。完整机器可读结果见 `output/android-ui-implementation-2026-10-11/verification/summary.json`。

源码已提交：`8f934c9729a0fee7fc3f09fd6922fe37669da0bb`，独立 Android 工作区干净；未推送远端。
