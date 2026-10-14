# Android 笔记层级交付

研究开始于 2026-10-11，完成于 2026-10-12。用户确认 Android 优先，沿用已有跨端关系，采用“笔记库 → 主笔记 → 子笔记”。主笔记同时承载正文，子笔记可继续嵌套。

## 已交付

独立预览应用“Notebook UI 预览”，包名 `io.github.notebook.android.nexttest`，版本 `0.4.0-ui.4-debug`／10045，已通过 `adb install -r` 更新到 OPPO PMX110。保留正式 Notebook 和系统“笔记”；没有在真机运行会清空数据库的 instrumentation，没有连接生产同步目录。

- 首页常驻结构入口；卡片显示归属路径和下级数量，独立定位按钮直达所在结构。
- 结构树按库分组，用缩进、分支线、数量和选中态表达层次。箭头展开／收起，标题打开正文。定位展开全部祖先，滚动并高亮目标。
- 搜索标题、路径或正文摘要；完整标题优先，结果显示完整路径和摘要。同名笔记可区分；相同标题与父级也能通过摘要识别。最多展示 100 项并提示收窄，首页原全文搜索继续保留。
- 固定／最近打开提供快速入口，保存本机导航 ID；每次显示重新检查可访问性。
- 阅读与编辑页显示可点击的库和祖先路径，并能一键定位当前笔记。进入结构前保存最新编辑内容并隐藏原键盘，保存失败保留页面提示。
- 局部结构图以当前笔记为中心显示上级、同级和直接子级。点击节点改变关注点，打开进入同一篇正文；可切回树定位。直接子项超过 24 时转入树查看全部。
- 树内就地创建子笔记、移动到新父级或提升到顶层。移动目标展示路径，禁止自身和后代，保持现有私密边界。跨库移动携带子树，ID 和正文保留。

全局结构使用树，局部理解使用图；正文标题目录、笔记归属和引用链接分别表达。这是针对手机快速定位与结构可读性作出的设计选择。

## 参考依据

研究使用应用官方文档及其中的界面示例，未声称逐一登录这些应用进行实际操作。

| 应用 | 官方说明 | 采用的设计 |
| --- | --- | --- |
| Notion | [侧栏导航](https://www.notion.com/help/navigate-with-the-sidebar) | 页面可嵌套、折叠、最近与固定入口 |
| UpNote | [子笔记本](https://help.getupnote.com/organize-and-manage-notes/organize-with-notebooks/sub-notebooks) | 明确父级、就地创建、结构移动 |
| Craft | [导航](https://support.craft.do/zh-Hans/introduction/navigation) | 区分正文目录和文件夹结构 |
| Obsidian | [快速切换](https://obsidian.md/help/plugins/quick-switcher)、[关系图](https://obsidian.md/help/plugins/graph) | 快速打开；图只表达实际关系，避免混淆链接与归属 |

## 数据与实现

产品源码在独立仓库 `notebook_android` 的 `codex/coloros-notes-ui`，基线 `9d1eecd`，交付提交 `3cfc2fcb343a15dbbe40fd26e7eaf7b05b17dda9`（本地已提交，未推送）。复用已有 `parentPageId`、`sortOrder`、`treeUpdatedAt` 与同步接口，Room schema 和协议不变。

`NoteHierarchy.kt` 对可访问摘要建立索引，使用迭代遍历、子项计数与路径缓存。缺失父级、自指、跨库父级及环在展示时降级，避免笔记消失，不隐式修复持久化数据。已删除／Todo 不进入笔记树，未解锁私密数据不进入树、图、搜索、固定或最近。

`ReferenceHierarchy.kt` 实现结构面板、树、图、路径和搜索。UI 库／笔记键分别加前缀，未分类区独立，支持合法非 UUID ID。`ReferenceHome.kt` 与 `MainActivity.kt` 接入入口和定位；移动目标复用已有对话框。

实际测试复现了移动后迟到草稿将笔记移回旧父级的故障，失败证据保存于 `stale-structure-before.log`。`SyncRepository.persistDraft` 保留较新树时间对应的库、父级、排序，同时保存新正文。`movePage` 推进到整个子树最大时间之后，并在面板退出时完成操作；在阅读页移动另一篇笔记只刷新当前笔记自己的结构元数据。

## 验证

| 检查 | 结果与范围 |
| --- | --- |
| 最终构建 | `testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest` 成功 |
| 单元测试 | 187 项通过、0 失败／错误／跳过；9 项层级索引测试含 5,000 同层节点和 1,500 层深链 |
| Lint | 0 errors／33 warnings；含可保存 ArrayList 状态的集合提示，所有状态更新均替换集合，不原地修改 |
| 深色综合设备回归 | 44 项通过，覆盖层级、原界面、编辑、通知导航和草稿恢复 |
| 浅色受影响设备回归 | 23 项通过，覆盖层级与原界面 |
| 最终两项细化后 | 最终安装包层级专项深色 12 项、浅色 12 项全部通过 |
| 真机 | 实际微信九宫格触摸输入中文，检索“验收记录”、区分两条路径、树定位、图中切换、打开正文、固定／最近、重启后保留 |
| 更新数据 | 独立预览 16 篇演示／4 个库；原中文“你好测试”精确保留一次，10 篇新增层级的父子关系和正文检查通过 |
| 安装一致性 | 手机已安装 APK 的 SHA-256 与交付 APK 相同 |

清空 Room 的设备回归仅在 API 35 `emulator-5554` 运行。真机为 API 37 OPPO PMX110，serial `3B169G003ZY00000`，1080×2354、480 dpi、深色模式。没有通过 ADB 硬件字符注入替代中文触摸输入；默认输入法和 `show_ime_with_hard_keyboard=0` 未改动。

结构新增的 12 项设备用例覆盖路径定位、图／树切换、固定最近重建、移动非当前节点、主笔记保留与新建子笔记、私密过滤、当前库／全部范围、跨库子树和 Activity 重建、迟到草稿／未来结构时间、编辑跳转保存与旧键盘隐藏、合法 ID 键冲突以及同名同父级正文摘要。

完整 44／23 项回归在最后 UI 键命名空间与摘要细化前完成；随后针对最终包重跑全部 12 项层级用例，不能把旧综合测试数量表述为最终包重新运行的数量。本轮未实际连接生产跨端同步；协议与字段复用不等于已在生产环境完成同步验收。大规模性能证据来自索引测试，真机仅使用演示数据。

## 交付文件

相对路径基于桌面工作区 `/Users/surfing/tools/notebook`。

- APK：`output/notes-hierarchy-design-2026-10-11/apk/Notebook-Android-Hierarchy-20261012.apk`
- SHA-256：`863ed8b2c56bfc46ba907421455159ce8a654ff37adbf7894d77ede65ec89ac6`
- 校验文件：`output/notes-hierarchy-design-2026-10-11/apk/SHA256SUMS`
- 四图总览：`output/notes-hierarchy-design-2026-10-11/evidence/hierarchy-overview.png`
- 实际操作录屏：`output/notes-hierarchy-design-2026-10-11/evidence/hierarchy-final-flow.mp4`（30.53 秒，包含搜索定位、结构图与同级关注切换；抽帧检查已完成）
- 阅读路径：`output/notes-hierarchy-design-2026-10-11/evidence/hierarchy-final-reader-navigation.png`
- 构建、回归与数据核对：`output/notes-hierarchy-design-2026-10-11/verification/`
- 产品设计：`notebook_android/docs/NOTE_HIERARCHY_DESIGN.md`

研究来源缓存仅保留 URL 与标题，原文提取内容已移除。本地临时预览数据库副本在核对后删除，取证过程只读取独立演示包。
