# Notebook 全端评估

> 此文记录修复前状态。后续修复与复测见 [修复验收记录](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/remediation.md)。

评估日期：2026-09-05。范围：Electron 桌面应用、Android 原生应用、`sub/` 网页应用的电脑与手机体验。

## 结论

**Electron 是目前最成熟的实现；Android 的本地笔记流程已有较好基础，但同步存在发布阻断问题；网页端仍处于原型阶段，暂不适合承载重要笔记，手机网页当前不可用。**

这不是同一应用的三个等价入口。Electron 与 Android 围绕 WebDAV 协议工作；`sub/` 使用独立的服务端存储和 API，没有实现同一套同步协议。不能根据网页端功能清单，认为它已完成原应用的完整替代。

| 端 | 本轮结论 | 主要依据 |
| --- | --- | --- |
| Electron / macOS | 可继续作为主力版本迭代；需要改善窄窗口 | 编辑、刷新持久化、手动版本与恢复通过；类型检查、lint、构建和现有测试通过 |
| Android 原生 | 本地编辑可用；跨设备同步验收不通过 | 125 项单元测试通过；设备回归有一次保存时序失败；WebDAV 恢复稳定失败并定位到平台 XML 解析兼容性 |
| 网页 / 电脑 | 具备功能演示能力，暂不建议正式替代桌面端 | 正常编辑、搜索、任务等流程通过；保存竞态、草稿恢复、导出和隐私边界存在可复现缺陷 |
| 网页 / 手机 | 不可用 | 390×844 CSS 像素下主区域宽度为 0；编辑器和主要操作被固定侧栏挤出 |

优先处理顺序：**Android 同步 → 网页隐私与数据保全 → 手机网页布局 → 一般体验与性能优化。**

## 范围与证据边界

- Electron：当前仓库 `next`，提交 `f8d02c14`，应用版本 2.3.0。重新构建后，用独立数据目录启动真实 Electron，检查 1480×920、1280×800、920×620 的渲染视口。
- Android：独立仓库 `thunder951413/notebook_android` 的 `next`，提交 `f54d1e76408149b11f7a1789ec94bdad06a19fb5`。仓库默认分支 `main` 是较旧实现，本轮结论依据 `next`。Android 15 / API 35 ARM64 模拟器，1080×2400，420 dpi，独立测试包 `io.github.notebook.android.nexttest`。
- 网页：评估开始时已存在的未跟踪 `sub/`。localhost 隔离实例、独立数据目录；浏览器电脑视口 1200/1440 像素，手机视口 390×844。
- 测试未使用真实笔记、真实坚果云目录或生产同步凭据。没有修改产品源码、部署或提交代码。
- 未验证：Windows/Linux 原生安装与输入法、Android 真机厂商后台限制、iOS/Safari、平板、大字号完整矩阵、真实坚果云限流、真实跨设备相互编辑、长期稳定性、真实录音权限和音质、大数据量性能。手机网页模拟不等于真机验证；Android 测试是真实 Android 运行时，但不是实体手机。
- 所谓“全面”是覆盖各端的功能、数据、安全、体验与工程质量，不代表穷尽每种设备和异常组合。以下将实测、源码结论和未覆盖项分别标注。

## 高优先级问题

### A1 · P1 · Android 无法可靠发现远端 WebDAV 日志

**已复现，并定位到运行时原因。**

仓库自带 `WebdavSyncInstrumentedTest` 在本机隔离 WebDAV 服务上执行 6 项测试，4 项通过、2 项失败：

- `firstSyncPublishesLibraryAndRemoteRestoresIt`：发布笔记、移除本地副本、切换设备 ID 后再同步，预期恢复笔记，实际为 `null`；换独立远端目录单独重跑仍失败。
- `unchangedSyncOnlyReadsSmallHeads`：无变化同步仍出现 PUT，没有达到小 head 读取的预期。

请求记录显示服务端已保存 `.jsonl` 和 `.head.json`，后续客户端只有 PROPFIND，没有继续读取这些日志。

`WebdavClient.parseHrefs()` 为 XML 工厂设置 `FEATURE_SECURE_PROCESSING` 等四个选项。在本次 API 35 运行时，这四项分别抛出 `ParserConfigurationException`。整个解析被 `runCatching` 包住，异常被转换成空列表。后续逻辑把解析失败当成远端没有日志，恢复和无变化同步因而失效。

建议：采用 Android 支持、具有明确实体/DOCTYPE 防护的 XML 解析方案；解析失败应明确报错，不能返回“空仓库”。重新验收新设备恢复、无变化同步、附件、冲突和进程重启。不能通过简单移除安全保护来修复。

证据：[设备测试](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/android-webdav-tests.log)、[独立重跑](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/android-webdav-retry.log)、[Android 平台 XML 诊断](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/android-xml-platform.log)。源码：[WebdavClient.kt](https://github.com/thunder951413/notebook_android/blob/f54d1e76408149b11f7a1789ec94bdad06a19fb5/app/src/main/java/io/github/notebook/android/sync/WebdavClient.kt#L225)。平台诊断只新增在临时检出的测试工程中，没有更改应用实现。

### W1 · P1 · 网页保存期间继续输入会丢失最后的修改

**已在真实服务端 + jsdom 事件流程中复现。**

1. 输入 `FIRST SAVE`，触发保存。
2. 将这次保存响应延迟 2 秒；等待请求发出后，继续输入 `SECOND SAVE MUST SURVIVE`。
3. 第二次防抖触发时，`state.saving` 仍为 true，直接返回。
4. 第一次响应到达后，界面标记“已保存”，并删除本地草稿。

结果：编辑器显示第二次内容，服务器只有第一次内容，本地草稿为 `null`。用户刷新或退出后会失去后一部分输入。

建议：以页面 ID 和编辑版本号管理保存队列；只确认请求对应的快照，响应后若有新修改必须再次提交；不能用旧响应清理新草稿。

源码：[app.js:1273](/Users/surfing/tools/notebook/sub/web/js/app.js:1273)。证据：[race-probe.log](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/race-probe.log)。

### W2 · P1 · 网页快速切页未保存，草稿恢复又会静默删除草稿

**两段链路均已复现。**

在 A 页输入后，900 毫秒防抖到期前切到 B 页：A 正文没有保存。路由只保存阅读位置，没有刷新 A 的待保存正文。

再次打开 A 时，代码尝试把恢复条插到 `id="editor-header"` 前面，但 HTML 只有 `class="editor-header"`，没有该 ID。空对象访问抛错后被外层 catch 吞掉，并执行 `localStorage.removeItem(draftKey)`。最终没有恢复提示，唯一的草稿也被删除。浏览器直接放入差异草稿后刷新，同样得到“提示不存在、草稿变成 null”。

建议：切页前完成当前页保存或保留独立队列；修正恢复 UI 目标；解析损坏、UI 异常与用户主动丢弃不能共用删除草稿逻辑。草稿还应保存标题与元数据，否则只改标题/截止时间时无法完整恢复。

源码：[路由](/Users/surfing/tools/notebook/sub/web/js/app.js:1039)、[草稿读取](/Users/surfing/tools/notebook/sub/web/js/app.js:1201)、[恢复条](/Users/surfing/tools/notebook/sub/web/js/app.js:1229)、[HTML](/Users/surfing/tools/notebook/sub/web/index.html:65)。

### W3 · P1 · 网页“导出全部”的 ZIP 结构损坏；中文标题单页导出返回 500

**已用标准 ZIP 读取器和实际 HTTP 请求复现。**

`buildZip()` 将中央目录头混入每条文件的本地数据区，又在末尾追加中央目录；偏移计算不包含混入的头。两条笔记的导出包：

- Python `zipfile` 能列出文件名，但读取两条文件都报 `BadZipFile: Bad magic number for file header`。
- 应用自己的 `readZip()` 遇到第一条中央目录头就停止，只导回第一条笔记。
- 以“参考笔记”为标题导出单页，响应 500：`Invalid character in header content ["Content-Disposition"]`。文件名没有按 HTTP 下载头正确编码。

即使修好 ZIP，“导出全部”当前也只打包 Markdown 正文，没有附件二进制、历史、标签、任务元数据和关系，不是完整备份。附件引用仍指向原服务器。

建议：使用可靠 ZIP 实现或修正结构并进行标准工具互操作；用编码后的 `filename*` 和安全的 ASCII fallback；明确区分“导出正文”和“完整备份”，验收从空实例恢复。

源码：[util.js:76](/Users/surfing/tools/notebook/sub/server/util.js:76)、[api.js:514](/Users/surfing/tools/notebook/sub/server/api.js:514)。证据：[中文标题导出响应](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/chinese-export.log)、[损坏样本](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/export-probe.zip)、[storage-probes.log](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/storage-probes.log)。

### W4 · P1 · 网页隐私锁可以在未解锁时被重新设置密码

**API 实测：403 → 重设密码 200 → 用新密码解锁 200 → 读取私密正文 200。**

`POST /api/notebooks/:id/lock` 不验证现有锁的密码或当前解锁权限。知道笔记本 ID、且能访问服务器 API 的用户，可为已经锁定的笔记本设置自己选择的密码。

服务器登录开启时仍要求服务器登录；此问题绕过的是独立笔记本隐私锁，不是服务器登录。默认未启用服务器登录时，能接入该服务的人也能执行该操作。

建议：已锁定笔记本的改密必须验证现有权限；笔记本/分区删除等写操作也应统一复核锁权限。

源码：[api.js:227](/Users/surfing/tools/notebook/sub/server/api.js:227)。证据：[api-probes.log](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/api-probes.log)。

### W5 · P1 · 网页重启后丢失附件关联，私密附件访问检查随之失效

**存储重开与 HTTP 访问均已复现。**

索引文件中有 1 条附件关系，关闭并重新初始化 Store 后内存关系变为 0，因为 `init()` 的恢复字段清单漏了 `assets`。附件文件仍存在，但页面信息面板无法列出它们。

更严重的是，附件读取权限依赖关联关系找到页面和笔记本；找不到关联时没有拒绝访问。相同私密附件 URL，在重启前返回 403，重启后返回 200 和原始私密内容。复现使用已知的测试附件 URL，不意味着可以枚举所有未知哈希。

建议：完整加载附件关系并做启动一致性验证；无关联/缺失页面时应拒绝访问；私密资源缓存策略也不能与公开资源共用 `public, immutable`。

源码：[store.js:36](/Users/surfing/tools/notebook/sub/server/store.js:36)、[api.js:448](/Users/surfing/tools/notebook/sub/server/api.js:448)。证据：[storage-probes.log](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/storage-probes.log)。

### W6 · P1 · 手机网页主编辑区被压到零宽

**浏览器 390×844 实测。**

| 元素 | x | 宽度 |
| --- | ---: | ---: |
| 左侧导航 | 0 | 300 |
| 主区域 | 300 | 0 |
| 右侧信息栏 | 300 | 300 |

侧栏都固定 300 像素，没有手机断点、抽屉导航或单栏编辑模式。屏幕只显示左侧导航和右侧信息的一部分，正文、标题与主要按钮不可用。关闭右栏后，左侧导航仍会占去绝大多数宽度。

建议：手机采用“列表 → 全屏编辑器”；导航和页面信息分别做抽屉，默认关闭；编辑/预览在手机互斥，工具栏可横向滚动，并适配软键盘和安全区。

源码：[style.css:97](/Users/surfing/tools/notebook/sub/web/css/style.css:97)。截图：

![手机网页：主编辑区被挤出](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/web-mobile.png)

## 中优先级问题与体验评估

| 编号 | 端 / 优先级 | 发现、影响与建议 |
| --- | --- | --- |
| W7 | 网页 P2 | 连续解锁两个私密本后，两个页面均返回 403。API 把多个 token 用逗号拼接，但 Store 将整个串与单个 token 精确比较。应逐 token 验证并合并权限。见 `api.js:54`、`store.js:317` 与 API 探针。 |
| W8 | 网页 P2 | 新建弹窗的“创建为任务页面”复选框未被读取；点击创建后又弹原生 confirm，并以 confirm 结果决定类型。选项与实际结果不一致。应只保留一次明确选择。源码 `app.js:787–830`。 |
| W9 | 网页 P2 | 元数据面板占据大量空间，文档默认同时显示截止、提醒、任务类型等。建议文档模式收起任务字段；正文、任务与附件信息分层呈现。电脑 1200px 分屏时正文每栏约 300px，长表格和代码体验受限。 |
| W10 | 网页 P2 | README 声称浏览器通知和重复提醒，但实现只有页面内每分钟轮询与 toast，未看到系统 Notification 或重复时间推进。页面关闭/挂后台后的通知不能依赖这套实现。应补后台机制或明确产品限制。 |
| W11 | 网页 P2 | “本地优先”实际上以服务端为正文存储、浏览器只保留当前页草稿；没有离线启动、完整离线库与冲突合并。多设备最后写入覆盖已在 README 承认。建议准确说明产品定位，增加离线队列和版本冲突检测后再与原生端比较。 |
| W12 | 网页 P2 | 正文通过直接 `writeFile` 覆盖；索引读取失败被当作首次启动。断电/磁盘写失败与索引损坏恢复尚无可靠验收。源码风险，未做故障注入；应增加原子正文写入、持久化失败状态和损坏索引隔离。 |
| D1 | Electron P2 | 920×620 支持的窄视口中，导航与大纲同时以浮层覆盖正文，默认状态留下很窄的可见编辑带。手动收起两栏后可正常编辑。建议进入窄窗时自动收起辅助栏，浮层互斥，选页后收回导航。 |
| A2 | Android P2 | API 35 浅色编辑页的状态栏时间/图标呈白色，背景接近白色；黄色附件/录音/提醒文字的对比也偏弱。应同步系统栏深浅图标，并为正文文字使用更深的强调色。属于截图体验发现，未完成全应用 WCAG 审计。 |
| A3 | Android P2 待定位 | 19 项设备用例中 `backNavigationFlushesUnsavedTyping` 首次超时，单独重跑通过；手动输入、返回、强制结束并重开后正文保留。记录为不稳定保存回归，不直接宣称稳定丢字；应检查测试隔离、Compose 最新状态与保存时序。 |
| E1 | 工程 P2 | `sub/test` 多处写死本机绝对路径和现有 jsdom 包路径，没有统一 test 脚本；锁测试默认只会有一个锁定笔记本，在混合数据环境误点并崩溃。换干净隔离实例后原测试通过。应以临时服务、独立数据与可安装依赖实现可重复 CI。 |
| E2 | 文档 P2 | Android README 链接的 `AI_HANDOFF.md` 在本次 next 源码中不存在；默认 main 与实际 next 的同步说明差异明显。桌面 README 包含 Linux deb，但当前打包配置仅列 AppImage。应统一当前版本、能力与交接文档。 |

### Electron 使用体验

优点：文档树、笔记/任务/回收站的结构明确；正文保存与版本恢复实测可用；大纲、双链、附件、录音、AI 均有独立入口；设置把外观、备份、同步和 AI 分类；主要图标按钮具备可访问名称。Electron 窗口启用了 `contextIsolation`、sandbox，关闭 Node integration，并限制外部打开链接协议。

改进重点：窄窗面板管理；新用户应更容易理解“已保存在本机”和“已同步远端”的区别；当前初始示例夹杂 2026/7/21 的过期任务，可能让新用户误以为自己的工作区已有逾期事项。实际设备安装、退出保存故障与系统输入法仍需补测。

![桌面端正常宽度](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/desktop-home.png)

![桌面端窄窗辅助栏覆盖正文](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/desktop-editor-small.png)

### Android 使用体验

优点：采用单栏列表与全屏编辑器，符合手机使用方式；新建、预览、返回、历史、删除入口明确；真实软键盘弹出后仍有正文输入区域；手动英文输入、返回并重启应用后正文保留。设备测试覆盖中文内容、页面双链、私密文件夹隐藏、删除确认、Activity 重建等。

改进重点：首先修复同步发现；其次修正系统栏、低对比强调文字和长文编辑体验。仍需实体手机验证中文输入法组合输入、分享导入、文件选择器、录音、来电打断、Android 后台限制与提醒权限。Android 私密笔记只保留在本机是现有设计约束，不能承诺云端恢复。

![Android 编辑与软键盘](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/android-keyboard.png)

### 网页电脑体验

正常流程已经具备：浏览笔记、Markdown 编辑/预览、简单任务复选框、收藏、历史列表、标签、步骤、评论、任务视图、搜索、设置、笔记移动。Raw HTML 转义和基本 URL 白名单是有价值的基础防护。

但“界面上有入口”不等于功能达到生产质量。草稿、备份与隐私都在正常冒烟通过之后发现了严重问题。数学公式当前主要保留文本样式，不等价于 Electron 的排版渲染；中文“字数”按空白拆词也不准确。界面键盘可达性不足，笔记卡片和树行较多使用没有键盘语义的 div。

![网页电脑端编辑器](/Users/surfing/tools/notebook/docs/audits/2026-09-05/evidence/web-desktop.png)

## 测试结果

| 检查 | 结果 | 解释 |
| --- | --- | --- |
| Electron 工作区 `pnpm typecheck` | 通过 | 所有工作区类型检查完成 |
| `pnpm lint` | 通过 | 当前配置的 oxlint 规则 |
| `pnpm build` | 通过 | 包含 Electron 主进程、预加载与 renderer |
| `pnpm test` | 355 通过，10 跳过 | 63 个测试文件；跳过的测试不记作验证成功 |
| Electron 实际运行 | 通过所测流程 | 编辑后刷新保留、创建版本、修改后恢复版本、任务/回收站/设置进入 |
| Android 单元测试 | 125 通过，0 失败 | 18 个输出测试套件；不能覆盖真实 Android XML 工厂差异 |
| Android lint/build | 通过 | lint 有 25 项 Warning，无 Error；包含依赖与 SharedPreferences 等提示 |
| Android UI/草稿/通知设备测试 | 18 通过，1 失败 | 保存返回用例单独重跑通过，保留首次失败记录 |
| Android WebDAV 设备测试 | 4 通过，2 失败 | 恢复测试独立重跑仍失败；运行时 XML 诊断确认不支持的解析选项 |
| 网页 Markdown / flow / metadata | 通过 | 现有正常流程用例通过 |
| 网页 lock/login | 干净实例通过 | 原混合数据跑失败；确认是测试选取首个锁定本的隔离问题 |
| 新增网页异常探针 | 复现 W1–W5、W7 | 包括慢响应、切页、ZIP 标准读取、密码重设、多锁、存储重开与附件权限 |
| 手机网页布局 | 不通过 | 主区域 0px |

构建产物有约 4.13MB 的主 renderer JS 与约 1.05MB Markdown worker（未压缩）。这是包体优化线索，不是卡顿结论。没有采集真实大库的 p95 搜索、输入延迟、内存和同步流量，因此不报告“性能合格”或虚构性能分数。网页搜索/图谱存在随笔记数增长的遍历和正文读取，需用 1k/10k 笔记数据集单独压测。

## 建议验收顺序

1. **修复并重测数据/隐私阻断项**：Android XML 解析；网页保存队列、草稿、ZIP、中文下载头、锁权限、附件索引与失效权限。每个修复必须用本轮复现输入回归。
2. **统一跨端边界**：明确 sub 是独立服务器产品还是第三个同步客户端。若要成为正式第三端，复用同步契约与 Markdown/附件/备份模型；不能继续维护一套同名但不等价的数据语义。
3. **完成手机网页重排**：360/390/430px、软键盘、横屏、文件上传、长文和大字号；主编辑区不能被侧栏压缩。
4. **补关键真实环境验收**：全新 Android 从真实隔离 WebDAV 恢复；桌面与手机双向附件/冲突/删除恢复；断网重连、进程终止；Windows/macOS/Linux 输入法与关闭保存；Android 厂商省电策略下提醒。
5. **再做体验和性能优化**：窄窗浮层互斥、统一术语、可访问名称/键盘操作、系统栏对比、笔记大库与长文性能预算。

本次只做评估与证据归档。报告和测试资产位于当前目录，产品源码保持原状。
