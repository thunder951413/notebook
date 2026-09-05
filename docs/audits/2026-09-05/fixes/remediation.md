# Notebook 全端修复与验收

日期：2026-09-05。对应 [修复前评估](/Users/surfing/tools/notebook/docs/audits/2026-09-05/assessment.md)。

本轮处理 Electron、Android 和 `sub/` 网页的已定位缺陷，并补充相关数据保全与权限边界回归。初次验收时修复保存在本机工作区，未更改生产笔记库。后续补充了容量受限的日志与提交准备，见 [问题定位与日志说明](/Users/surfing/tools/notebook/docs/DIAGNOSTICS.md)。本文的原始 evidence 仅保留在本机，不提交 Git。

## 修复对应表

| 编号 | 处理结果 | 验证 |
| --- | --- | --- |
| A1 | Android 改用平台支持的受限 XmlPullParser；拒绝 DOCTYPE/实体、空响应、错误根节点、截断 XML、过深嵌套及超限响应；解析错误不再伪装成空目录 | API 35 WebDAV 8/8，新设备恢复、无变化快速路径、附件、冲突及恶意 XML |
| A2 | 浅色系统栏改用深色图标；强调文字改用深琥珀色，对比度约 6.49:1 | API 35 系统栏属性与截图 |
| A3 | 返回/生命周期保存读取编辑器直接维护的最新草稿，返回动作防重复；设备用例隔离旧任务和数据库状态 | UI/草稿/通知 19/19；快速返回重复 5/5；离线/进程重启分阶段 3/3 |
| W1 | 每页面独立保存队列，旧响应只确认对应快照；慢请求期间的新输入会继续保存 | 慢响应、连续编辑和跨页并行测试 |
| W2 | 切页立即提交；返回页面显示内存中的最新快照；修复草稿恢复位置；标题与元数据一起恢复；异常草稿可下载 | 草稿恢复、快速切页、返回未完成保存页面的 UI 回归 |
| W3 | 修正 ZIP 本地记录/中央目录，支持普通 DEFLATE 与数据描述符；中文 filename*；重复导出路径去重；补完整备份/空库恢复入口 | Python zipfile 互操作；两篇同名页面、已解锁私密本、完整数据与附件恢复 |
| W4 | 已锁笔记本改密、笔记本/分区修改、页面关联操作和移动目标统一检查访问权限 | 未授权接口回归 |
| W5 | 启动恢复附件关系；无关联附件拒绝访问；附件 private/no-store | 同一私密附件在重启后仍拒绝未授权访问 |
| W6 | 手机单栏编辑；导航/信息抽屉默认关闭且互斥；增加返回、遮罩、关闭、滚动工具栏和安全区/视口适配 | 真实 Chromium 360/390/430 像素宽度，正文不再为零宽 |
| W7 | 分别验证多个解锁令牌 | 两本同时解锁测试 |
| W8 | 新建弹窗直接采用任务复选框，移除第二次原生确认 | 任务创建 UI 回归 |
| W9 | 普通文档默认收起类型与提醒属性；信息面板按需打开 | 手机与桌面截图 |
| W10 | 计算每日/每周/每月发生时间、月末截断、完成任务排除和去重；提供用户主动启用系统通知入口 | 周期投影、月边界、不改变保存版本的测试；文档明确网页关闭后的限制 |
| W11 | 本机编辑队列与网络恢复重试；保存带 expectedUpdatedAt，409 保留草稿并要求明确处理 | 断网、重连、不同设备版本冲突回归；准确说明独立服务定位 |
| W12 | 正文/索引/附件/版本使用临时文件、fsync、重命名；持久化失败显式返回；损坏索引拒绝启动；正文写失败保持原版本并允许重试 | 故障注入、null/false/损坏索引、备份恢复校验与拒绝覆盖 |
| D1 | Electron 进入窄窗时收起两侧辅助栏；导航与右栏互斥，选页后收回导航 | 1480→920 像素实际窗口渲染、导航与右栏切换 |
| D2（复测新增） | Electron 菜单/⌘R 改为等待已有持久化握手；重复刷新去重，保存失败则保留页面并提示 | 新增 2 项回归；主审在隔离 Electron 实际按 ⌘R，确认刷新发生且刚输入文字保留 |
| E1 | 移除个人路径依赖；可安装 jsdom；统一临时数据和空闲端口测试；旧 shell 入口转到统一测试 | `npm test` 不依赖现成服务或个人笔记库 |
| E2 | Android 补跟踪的 AI_HANDOFF，明确 next 基线与真实同步协议；桌面 README 改为实际 AppImage 目标 | 文档与构建配置核对 |

另外修复了首次登录后路由未注册、登录会话刷新误回登录、预览任务勾选下标、中文计数和键盘可达性；静态脚本/样式改为重新验证缓存，避免部署后继续使用旧模块。新建桌面示例任务不再带固定的过期截止日期。

权限复核还修正了 `includeLocked=1` 搜索绕过、双重编码资源路径、登出后令牌仍有效，以及排队写操作使用过期授权的问题。备份导入校验页面/分区的归属、循环关系、锁配置和附件哈希。

## 自动化结果

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 网页 | Node 内置回归 20/20；原有五组 Markdown/DOM/流程/属性/锁定登录脚本通过，其中流程断言 55 项 | [统一日志](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/web-tests.log) |
| Electron / 共享代码 | 各包最终汇总 357 通过、10 跳过；typecheck、lint、build 通过。原全量 355 项基础上桌面包补 2 项后为 52 通过、10 跳过 | [原全量](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/desktop-tests.log)、[刷新补充回归](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/desktop-reload-tests.log)、[类型](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/desktop-typecheck.log)、[构建](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/desktop-build.log) |
| Android 单元与构建 | 18 个套件、125/125；lintDebug、assembleDebug 通过 | [单元报告](/Users/surfing/tools/notebook_android/app/build/reports/tests/testDebugUnitTest/index.html)、[lint](/Users/surfing/tools/notebook_android/app/build/reports/lint-results-debug.html) |
| Android API 35 | WebDAV 8/8；UI/草稿/通知 19/19；离线/进程重启 3/3；快速返回 5/5 | [WebDAV](/Users/surfing/tools/notebook_android/app/build/reports/remediation/webdav-connected/index.html)、[UI](/Users/surfing/tools/notebook_android/app/build/reports/remediation/ui-connected/index.html) |

Android 最终 [Debug APK](/Users/surfing/tools/notebook_android/app/build/outputs/apk/debug/app-debug.apk) 的 SHA-256 为 `00d13de0b1f3ba367f51c2e04fbd2103a8cb474646ed6ee05e39982af6f5c542`。这是隔离测试包 `io.github.notebook.android.nexttest`，并非已签名发布包。

桌面即时刷新实测中，渲染进程 timeOrigin 从 `1788571383698.3` 变为 `1788571481459`，刚输入的“主审即时刷新验收”仍存在，说明刷新确实执行且内容已落盘。见 [实际键盘刷新证据](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/electron-immediate-reload.log)。Android 五次快速返回由主审重新连续执行并保留 [逐次日志目录](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence)，三阶段离线/恢复同样使用最终 APK 重新执行。

## 实际界面

390×844 CSS 像素下正文宽度 390、高约 523；360 和 430 宽度下正文分别为 360、430，页面没有横向溢出。抽屉打开后可以用关闭按钮、遮罩或返回操作回到正文。

![手机网页编辑](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/web-390.png)

![手机导航抽屉](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/web-mobile-navigation.png)

![手机完整备份入口](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/web-mobile-settings.png)

Electron 920×760 渲染视口下，进入窄窗后导航和大纲收起，主内容宽度约 832。显式打开任一侧的面板会关闭另一侧。

![Electron 窄窗](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/electron-920.png)

![Android 浅色编辑页](/Users/surfing/tools/notebook/docs/audits/2026-09-05/fixes/evidence/android-editor.png)

## 保留的产品边界

- 网页仍是独立服务，不具有 Electron/Android WebDAV 协议、完整离线库或自动冲突合并。新增的是可靠编辑队列和冲突检测，详见 [网页说明](/Users/surfing/tools/notebook/sub/README.md)。
- 系统通知需浏览器支持、授权且网页继续运行；没有后台推送。提醒固定间隔/UTC 月规则不会自动调整夏令时。
- 完整备份为未加密 ZIP，仅恢复到空库；包含内容和笔记本隐私锁配置，排除服务器登录设置与会话。Markdown 导出不是完整备份。
- 文件写入原子化不等于跨正文和索引的数据库事务；在两个文件替换之间断电仍可能出现跨文件不一致，独立备份仍必要。
- 没有新增 TeX 排版引擎；网页公式标记保留原文。Windows/Linux 安装、iOS/Safari、Android 实体设备厂商后台、大库长期性能和真实公网 WebDAV 限流未在本机穷尽验证。
- 全部测试使用临时库、隔离 Electron 和 Android Debug 模拟器，没有使用真实笔记和生产同步凭据。

## 复测命令

```sh
cd /Users/surfing/tools/notebook/sub
npm ci
npm test

cd /Users/surfing/tools/notebook/cross-platform
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Android 的 JDK/SDK、隔离 WebDAV 与分阶段进程重启命令见 [AI_HANDOFF.md](/Users/surfing/tools/notebook_android/AI_HANDOFF.md)。
