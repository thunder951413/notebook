# 问题定位与小容量日志

这套日志默认保存在设备本地，没有遥测上传。出现问题时，告诉我**大致发生时间（注明时区）、所在页面/操作、预期与实际结果**；再导出日志或把手机接上 adb，我就可以按会话与操作编号定位保存、同步、刷新和异常链路。

## 容量与记录原则

| 端 | 自动保留上限 | 获取方式 |
| --- | --- | --- |
| Electron | 2 MiB 活动文件 + 1 个归档，合计 4 MiB | 设置中的诊断区域 → 导出日志 / 显示日志位置 |
| Android | 512 KiB 活动文件 + 3 个归档，合计 2 MiB | 设置与同步 → 诊断日志 → 导出；Debug 可直接 adb 提取 |
| 网页服务器 | 512 KiB × 4 文件，合计 2 MiB | 设置 → 导出服务器诊断，或 DATA_DIR/diagnostics |
| 网页浏览器 | 最多 200 条，且不超过 256 KiB | 设置 → 导出浏览器诊断 |

旧记录按容量轮转淘汰，不承诺固定保存几天。不会记录逐字输入、正文快照或普通成功轮询。记录以启动、保存边界、同步开始/结果、失败、超时、冲突和恢复为主；队列有上限，突发噪音不会无限积压。

日志只保留时间、应用版本、会话/操作编号、耗时、计数、状态、错误类型和受限源码位置。笔记正文、标题、密码、令牌、完整 URL、服务端响应正文及异常原文不应进入日志。日志写入失败不改变保存/同步的成功与失败语义。

## Android：之后接手机即可处理

连接手机、启用 USB 调试并确认电脑授权后：

```sh
adb devices
adb shell pm list packages | grep io.github.notebook.android
```

如果当前是 Debug 测试包，可以直接把应用私有日志打包到电脑：

```sh
adb exec-out run-as io.github.notebook.android.nexttest tar -C files -cf - diagnostics > notebook-phone-diagnostics.tar
tar -tf notebook-phone-diagnostics.tar
```

多设备连接时，在 `adb` 后加 `-s 设备序列号`。正式发布包通常不允许 `run-as`；使用应用内**导出并分享诊断日志**，通过 Android 系统分享保存到电脑或你能访问的位置。没有添加可从外部无验证读取私有日志的广播入口。

如果问题发生在启动阶段，adb 还可补充 Android 系统崩溃缓冲区：

```sh
adb logcat -b crash -d -v threadtime > notebook-phone-crash.txt
```

系统 logcat 与应用的脱敏日志不同，可能包含其他应用/系统信息；定位时先筛选 Notebook 相关进程。应用内日志随进程重启保留，清除应用数据或卸载会移除它们。

完整 Android 说明见 [Android DIAGNOSTICS.md](https://github.com/thunder951413/notebook_android/blob/next/DIAGNOSTICS.md)。

## 桌面端

用应用中的“显示日志位置”确定实际路径，然后导出保留的完整日志。路径因安装名称和系统而异；不要只发最近几行，也不用打包整个笔记库。

查看 `storage/renderer-flush`、`lifecycle/renderer-reload` 和 `sync/webdav-*` 等操作的开始与结果。操作编号、时间和耗时用于区分：编辑没有进入保存、持久化失败、同步未发出、网络超时，或远端返回异常。详细字段与路径见 [桌面诊断说明](../cross-platform/apps/desktop/DIAGNOSTICS.md)。

## 网页端

同时导出浏览器与服务器两份日志。浏览器发送的 `X-Request-Id` 与服务器记录的 `operationId` 一致，可以从本机保存失败追到对应的 HTTP 状态、耗时和错误位置。断网请求只会留在浏览器日志中；服务器收到请求后才会有对应记录。

服务器文件为 `DATA_DIR/diagnostics/events.jsonl` 及 `.1`—`.3`。服务器登录启用时，诊断导出沿用登录权限。详见 [网页说明](../sub/README.md)。

## 开发与验收

日志验收覆盖容量轮转、敏感字段排除、写入失败隔离、请求关联、导出权限及 Android adb 提取。诊断日志和本地测试截图/原始日志不进入 Git；源码、回归测试和这份排查说明会提交。

原来的全端修复与验收摘要保存在 `docs/audits/2026-09-05/fixes/remediation.md`。其中本机绝对路径指向本次验证产物，原始 evidence 目录仅在本机保存。
