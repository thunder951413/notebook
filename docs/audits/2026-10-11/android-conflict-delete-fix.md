# Android 冲突笔记彻底删除修复与验收

日期：2026-10-11。分支 `codex/coloros-notes-ui`，提交 `1f6249fb6639a4d9c255cfc86baa148d8763f117`。本地已提交，未推送。

## 用户问题与范围

用户报告旧手机版 Notebook 同步冲突后，把笔记删到回收站，仍在同步冲突详情里看到该笔记；点“彻底删除”没有反应。本轮修复合并到当前系统笔记风格的 Android 工程，并同时验证冲突详情和最近删除多选两个入口。没有连接真实手机或生产同步目录。

## 原因与修复

1. 检查的旧代码 `b361308` 的冲突/回收站详情按钮调用永久删除后没有关闭详情，界面继续显示旧对象。当前版成功后退出详情，并显示删除失败原因。
2. 旧的永久删除没有清理持久草稿，也没有让持久 tombstone 拦截迟到保存。编辑器退出或进程重启时可重新插入已删除记录。新增测试在修复前实际复现了这一问题。
3. WebDAV pull-first 同步会重新拉入已删除笔记的远端冲突版本，使本机删除失效；SFTP 也缺少本地 tombstone 拉取保护。新增 WebDAV 回归在修复前实际复现远端冲突笔记重现。

永久删除现在与保存/同步互斥，在同一个 Room 事务内写入删除标记、提交删除 outbox、清理正文、草稿、同步投影与关联数据；附件和步骤等残留 upsert 替换为带所属页的 delete。持久删除标记优先于迟到草稿、重启恢复和旧远端版本。WebDAV/API 在重放旧记录时推进删除基线，HTTP API 乐观锁冲突保留可重试的删除操作；SFTP 不重新导入本机已永久删除的 ID。正常移入最近删除后的恢复仍保留。

进程恢复验收还发现 WebDAV 配置异步写入后立即终止进程，可读回旧 SFTP 配置。改为确认配置落盘，并在设置页显示保存失败；主机阶段加入同步后端断言，避免错误后端的断网失败被误判为通过。修复前的恢复失败日志保留于 `verification/process-restored-before-durable-settings.log`，最终三阶段均通过。

## 最终验证

- 完整构建：`testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest` 成功。
- 单元测试：178 项，0 失败、0 错误、0 跳过。
- 最终设备回归：52 项被枚举，47 项成功、5 项条件跳过、0 失败。跳过的 3 个主机驱动阶段已按顺序单独执行并通过；剩余 2 项为未配置的外部 HTTP API 与既有 SFTP 服务。
- 进程终止、离线重启、恢复网络三个阶段在最终 APK 上全部通过，并断言 WebDAV 后端保持正确。
- Lint：0 错误，30 项现有警告。
- ADB 设备：隔离 API 35 模拟器 `emulator-5554`。本机测试服务端口 2222（SFTP）、2223（WebDAV），使用独立测试目录和合成笔记。

聚焦场景包括：冲突详情彻底删除并退出、最近删除多选永久删除、不相关笔记保留、迟到已删草稿、重启草稿恢复、父/子页和依赖 outbox 清理、真实 SFTP 双端冲突、真实 WebDAV 双端冲突、连续同步、新设备恢复、HTTP API 删除版本冲突后的持久重试。

验收日志和机器摘要位于 `/Users/surfing/tools/notebook/output/android-conflict-delete-2026-10-11/verification`：`device-suite.log`、`device-status-counts.json`、`process-prepare.log`、`process-offline.log`、`process-restored.log`、`build.log`、`summary.json`。修复前两项失败复现见 `reproduction-before.log`。

## 安装包与状态

- 版本：`0.4.0-ui.2-debug`，versionCode `10043`。
- 显示名称：Notebook UI 预览。
- 包名：`io.github.notebook.android.nexttest`，独立于正式版。
- APK：`/Users/surfing/tools/notebook/output/android-conflict-delete-2026-10-11/apk/Notebook-Android-UI-conflict-fix-20261011.apk`。
- 大小：20933568 字节。
- SHA-256：`7784d829b061f03ddfac5db14a410dd07a61b2a0891cdab93d0c3254315baf12`。
- 分支与提交：`codex/coloros-notes-ui` / `1f6249fb6639a4d9c255cfc86baa148d8763f117`。

修复包已在隔离模拟器安装并验收；测试结束后重置该 debug 包并放入合成演示笔记。手机上的旧正式安装尚未替换，当前 APK 不能覆盖正式包的本地数据。Room schema 保持 13，没有数据迁移。
