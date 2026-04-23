# 同步逻辑改进计划

## 1. ✅ 🔴 冲突解决机制
**问题**：拉取时若本地和远程都修改了同一笔记，当前逻辑是远程版本高则覆盖本地，两台设备同时编辑时先推送的修改会被后推送的覆盖，本地未同步的修改会丢失。

**方案**：
- 在 `syncDownloadedRemoteNotePayload` 中检测冲突：当本地有未推送修改（`lastSyncedVersion < note.version`）且远程版本更高时，标记为冲突
- 冲突策略：保留两份，将本地版本复制为"冲突副本"（标题加 `[冲突副本]` 后缀），然后应用远程版本
- 在 `NoteSyncMergeResult` 中增加冲突标记，让 UI 层可以提示用户

**涉及文件**：
- `SSHSyncManager.swift` — `syncDownloadedRemoteNotePayload` / `syncRemoteNotesInBatches`
- 可能需要新增冲突相关的数据结构

## 2. ✅ 🟡 推送防抖间隔缩短
**问题**：`savePushDebounceInterval = 10 * 60`（10 分钟）过长，用户编辑后切换设备时可能拿不到最新数据。

**方案**：
- 将防抖间隔从 10 分钟缩短为 2 分钟（`2 * 60`）
- 首次保存后 2 分钟推送，后续连续编辑期间不再重复触发（已有防抖机制）

**涉及文件**：
- `AutoSyncCoordinator.swift` — `savePushDebounceInterval`

## 3. ✅ 🟡 离线持久化队列
**问题**：`hasPendingLocalChanges` 仅在内存中标记，应用重启后此状态丢失，不会自动重试推送。

**方案**：
- 将 `hasPendingLocalChanges` 持久化到 UserDefaults
- 应用启动时检查该标志，若有未推送修改则调度一次推送
- 推送成功后清除标志

**涉及文件**：
- `AutoSyncCoordinator.swift` — `hasPendingLocalChanges` 改为 UserDefaults 持久化

## 4. ✅ 🟢 推送失败指数退避
**问题**：推送失败后重新调度仍用固定 10 分钟间隔，网络持续不佳时反复尝试无退避。

**方案**：
- 引入 `pushRetryCount` 计数器
- 退避公式：`min(baseInterval * 2^retryCount, maxInterval)`，base=2min，max=30min
- 推送成功后重置计数器

**涉及文件**：
- `AutoSyncCoordinator.swift` — `scheduleDebouncedPush` / `runAutomaticPush`

## 5. ✅ 🟢 版本号脏检查
**问题**：每次保存都 `version + 1`，即使内容实际未变，导致不必要的同步传输。

**方案**：
- 保存前计算内容的 contentHash，与上次保存的 hash 对比
- 仅在 hash 不同时才递增 version
- 在 `BlockDocumentNoteEntity` 或 `NoteSyncStateEntity` 中记录 `lastSavedContentHash`

**涉及文件**：
- `NoteSaveManager.swift` — `saveBlockDocumentNote` 中 version 递增逻辑
- 可能需要在 Entity 中新增字段

## 6. ✅ 🟢 sshpass 密码传递方式改进
**问题**：`-p config.password` 让密码出现在 `ps` 输出中，任何本机用户可见。

**方案**：
- 将 `-p` 改为 `-f`（从文件描述符读取），通过 pipe 传递密码
- 或使用 `-e`（环境变量 `SSHPASS`）方式

**涉及文件**：
- `SSHSyncManager.swift` — 所有 `sshArguments` / `executeProcess` 调用处

## 7. ✅ 🟢 SCP 上传后校验
**问题**：上传文件后没有验证远程文件哈希是否与本地一致，网络抖动可能导致文件损坏未被发现。

**方案**：
- 上传后通过 SSH 执行 `sha256sum` 计算远程文件哈希
- 与本地文件哈希对比，不一致则重试（最多 2 次）
- 仅对笔记 `.json` 文件做校验（附件文件较大，可选校验）

**涉及文件**：
- `SSHSyncManager.swift` — `syncNoteToRemote` 中 SCP 上传后
