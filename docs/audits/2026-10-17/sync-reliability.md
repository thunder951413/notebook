# Notebook 同步可靠性评估

日期：2026-10-17
范围：`next` 分支的坚果云 WebDAV v4.1 同步链路（Rust 传输层、渲染层同步引擎、共享存储层、协议 fixtures），以及旧 SSH 迁移路径的边界。
结论：**正常路径可靠，异常隔离不足。** 当前实现适合正常网络、客户端版本一致、数据完整的日常使用；但还不能说“任意场景都有明确处理方式”。在一份远端日志、一个对象或一条本地附件异常时，现有策略是整轮同步失败并无限重试；永久删除、隐私迁移、设备身份和 v4 日志容量也存在未闭环状态。

本轮**没有修改产品代码**。文中的“探针”是临时测试，运行后已删除；结论来自源码、现有测试和可复现的临时用例。

---

## 1. 结论摘要

### 1.1 总体判断

| 维度 | 评价 |
| --- | --- |
| 正常增量同步、无变化同步 | 可靠。head 提交点、强 ETag 缓存、批次游标和事务性 outbox 设计成熟 |
| 崩溃/取消/分页/断点续传 | 基本可靠。已应用批次保留，游标只推进到实际提交的位置 |
| 双设备并发编辑 | 有明确策略：本机保留、远端正文另存冲突副本、继续同步 |
| 单条异常隔离 | **不足**。一条坏记录、坏日志或坏对象会让整个仓库停在同一位置 |
| 永久删除与墓碑 | **不足**。远端删除不落墓碑、不级联，且旧分支可以把已彻底删除的笔记复活 |
| 隐私迁移 | **不足**。直接给页面加锁会撤回，但移动到私密笔记本/锁定笔记本不会撤回旧明文 |
| 设备与仓库身份 | **不足**。设备 ID 与游标分裂在 localStorage/IndexedDB；切换远端目录时版本基线不隔离 |
| 长期容量 | **有硬上限**。v4 journal 达到 10 万条或 100 MB 后没有可用修复路径 |
| 可观测性与自助修复 | 基础较好。有诊断日志、重新读取、全量重发；但不能修复坏日志、坏对象、缺失附件、密钥错误和容量上限 |

### 1.2 缺口一览

| 编号 | 级别 | 缺口 | 直接后果 |
| --- | --- | --- | --- |
| F1 | P1 | 远端单条异常不隔离（坏 journal/head、未知类型、坏 payload、缺对象、无法解密） | 整个仓库停在同一条记录，其他设备也无法同步 |
| F2 | P1 | 本地单条异常不隔离（缺附件/坏正文） | 一个附件缺失，所有待上传内容都停住 |
| F3 | P1 | 永久删除语义不闭环（不落墓碑、不级联、可被旧分支复活） | 已删笔记复活；云端重建后删除丢失 |
| F4 | P1 | 隐私迁移与密钥生命周期不闭环 | 旧明文残留；无密钥/错密钥时整库不可同步 |
| F5 | P1 | 游标/设备身份分裂存储；仓库切换与回滚未隔离 | 本地库丢失后无法从自己的 journal 恢复；切换仓库静默分叉 |
| F6 | P1/P2 | v4 journal 10 万条/100 MB 硬死路；无对象/设备 GC | 长期使用后无法再上传，且没有修复入口 |
| F7 | P2 | outbox 与跨设备记录缺少依赖顺序 | 新设备/Android 恢复可能卡住或跳过 |
| F8 | P1 | head 领先于被截断的 journal 时静默丢记录 | 同步显示成功，但记录永久缺失 |
| F9 | P2 | 慢网络下 push 的 60 秒上限与 8 MiB 批次不匹配 | 大对象/慢上行反复超时，无法完成首次同步 |
| F10 | P2 | 旧客户端写入的尾部被 head 永久隐藏 | 旧设备的新编辑永远不同步 |
| F11 | P2 | 远端对象损坏没有强制修复路径 | 一个坏对象让所有设备永久拉取失败 |
| F12 | P3 | 文档/实现漂移与小问题 | 预期不符、个别环境失败 |

### 1.3 最需要先处理的五件事

1. **给远端异常加隔离边界**：坏 journal、坏 head、未知实体、坏 payload、缺失对象、无法解密，不应让其他设备和其他记录一起停摆。
2. **给本地异常加逐项隔离**：一个缺失附件或损坏正文不应阻止其他笔记上传；当前实际上会一条都不传。
3. **闭环永久删除语义**：远端 `delete` 要落墓碑、级联清理；已彻底删除的页面不能被旧分支复活；重发时要带上删除墓碑。
4. **闭环隐私迁移**：移动到私密笔记本、锁定笔记本、移动分区都要撤回旧明文；增加密钥校验；没有密钥时不能让公有笔记也无法同步。
5. **修正身份与游标持久化**：数据库是权威，设备 ID 和游标不能只依赖 localStorage；切换仓库/云端回滚要有明确选择，而不是静默分叉。

---

## 2. 范围、方法与验证

### 2.1 覆盖的代码

- 传输层：`cross-platform/crates/notebook-sync/src/webdav.rs`、`cross-platform/apps/desktop/src/main/webdav.ts`、`cross-platform/apps/tauri/src-tauri/src/lib.rs`
- 同步引擎：`cross-platform/apps/renderer/src/sync/webdavSync.ts`、`webdavPayload.ts`、`webdavPrivacy.ts`、`webdavSettings.ts`、`syncLifecycle.ts`、`useWorkspaceSync.ts`
- 共享存储与合并：`cross-platform/packages/storage-renderer/src/repository/sync.ts`、`transfer.ts`、`content.ts`、`core.ts`、`database.ts`、`rebase.ts`
- 协议契约：`SyncContractFixtures/webdav-v4/*.json` 与三端 fixture runner
- 文档：`docs/JIANGUOYUN_SYNC_V5.md`、`docs/SYNC_RELIABILITY_2026-10-13.md`、`docs/SYNC_EFFICIENCY_2026-09-04.md`、`docs/SSH_MARKDOWN_SYNC_V3.md`

### 2.2 已执行的验证

| 检查 | 结果 |
| --- | --- |
| `cargo test`（notebook-sync，17 个传输测试 + 10 个 fixtures） | 全部通过 |
| `pnpm --filter @notebook/storage-renderer test` | 69 项通过 |
| `pnpm --filter @notebook/renderer test` | 313 项通过 |
| `pnpm --filter @notebook/desktop test` | 66 项通过，10 项现有条件跳过 |
| `pnpm typecheck`（7 个 workspace 项目） | 全部通过 |

### 2.3 未验证项

- 没有使用真实坚果云账号，因此没有验证真实 429/`Retry-After`、`If-Match`、750 条目录分页、服务端文件历史保留策略。
- 没有运行 Android 客户端；Android 行为依据仓库内文档和共享 fixtures 推断。
- 没有做真实断电、磁盘损坏、IndexedDB 配额耗尽、长期 10 万条/100 MB 压测。
- 没有验证 Windows/Linux、代理/PAC、重定向时的 `Authorization` 行为。
- 没有验证恶意服务端“返回 2xx 但未持久化数据”的场景。

### 2.4 临时探针

为了确认边界行为，本轮临时加入了 8 个探针用例，运行后删除，未留在仓库。关键输出见附录。它们确认了：

- 一条损坏的 peer journal 会让整个 `pull_journals` 返回错误；
- head 的 `lastSeq` 大于 journal 实际最大序号时，只读到现有行并给出 warning，之后游标仍可前进，缺失记录不会再被读取；
- 彻底删除的页面可以被远端后继 `upsert` 复活，墓碑仍在但不生效；
- 应用远端页面 `delete` 不会生成墓碑；
- 公开页面移动到锁定笔记本后，只排队了页面 upsert，没有 `privacyRetraction`；
- 首次发布时 outbox 的读取顺序不是入队顺序，子记录可能排在父记录之前；
- 一个缺失本地附件会让整次 push 调用次数为 0；
- 没有隐私密钥时，一条加密记录会让整轮拉取在应用任何公有记录之前失败。

---

## 3. 同步机制速览

### 3.1 远端布局（v4.1）

```text
<remotePath>/
  journal/<deviceId>.jsonl      每设备一个只由该设备写入的日志
  journal/<deviceId>.head.json  提交标记：lastSeq、字节数、SHA-256
  objects/<xx>/<sha256>         内容寻址的正文/附件字节
```

- 每台设备只写自己的 journal，避免跨设备锁。
- `head.json` 是提交点：先 PUT journal，再 PUT head；读者只消费 head 已覆盖的序号前缀。
- 非 revision 实体按 `type:id` 只保留最新状态；revision 保留一个“历史环”。
- 大于 2 KiB 的 document 整体外置为对象，journal 只留 `$payloadObject` 标记。
- 同一实体在一个 peer journal 内的多条记录，拉取时只下载/应用最新一条。

### 3.2 拉取

1. PROPFIND `journal/`，枚举 `.jsonl` 与 `.head.json`。
2. 强 ETag 未变时复用 head 缓存；否则读取 head。
3. 根据本地每设备游标决定是否 GET journal。
4. 只暴露 `seq > known && seq <= head.lastSeq` 的记录。
5. 每 40 条一批：下载对象、解密、应用；数据、附件字节和每设备游标在同一个 Dexie 事务里提交。
6. 已应用批次在超时/取消后保留，下一次从提交点继续。

### 3.3 推送

1. `syncOutbox` 与本地写在同一事务中落盘。
2. 取最多 200 条 outbox，按实体隐私属性过滤。
3. 逐条准备 payload、外置大正文、计算附件哈希。
4. 按 25 个唯一对象 / 8 MiB / 256 KiB journal 字节 / 200 条分批。
5. 先 PUT 对象，再 `appendJournal`：GET 现有 journal、追加、压缩、PUT journal、PUT head。
6. 确认 `count/firstSeq` 后才删除 outbox 并推进版本；最后再做一次拉取，接住推送期间其他设备的发布。

### 3.4 冲突

- 日志里的 `ver` 是父版本；本地基线是“已接受父版本 + 1”。
- 自己的 journal 重放不算冲突；比基线更旧的记录按祖先跳过。
- 真正的并发：本机内容保留，本地基线提升到 `max(本地基线, 待上传父版本, 远端 ver + 1)`，本机修改作为后继发布；正文不同则把远端正文另存为冲突副本页面。
- 页面元数据、标签、步骤等冲突时保留本机；不生成副本。

### 3.5 删除

- 移入回收站：页面 `upsert`，payload 带 `deletedAt`。
- 彻底删除：先为子实体排队 `delete`，再为 document/page 排队 `delete`，同时写本地 tombstone 并删除本地数据。
- 远端 `delete`：本地只删除对应表的行，不生成墓碑，也不级联。

### 3.6 隐私

- 私密实体在未配置同步密钥时只留在本机；配置后使用 AES-256-GCM + PBKDF2-SHA256（310,000 次）加密，AAD 绑定 `type:id:op:ver`。
- 页面从公开变为 `locked` 时，撤回旧公开表示（`privacyRetraction` 删除 + 之后重发当前私密状态）。
- 私密页面收到未认证的明文远端记录时跳过，避免远端历史把它变回公开。

### 3.7 触发与节奏

- 启动、网络恢复、可见时 10 分钟轮询、编辑后静默窗口、失焦/切页边界、退出前 flush。
- 自动上传最短间隔 60 秒；失败退避 1/2/4/8/15 分钟；30 分钟请求预算 240 次；手动同步不受限。
- **注意**：`docs/SYNC_RELIABILITY_2026-10-13.md` 写“停止修改 30 秒后同步、持续编辑最多 3 分钟”，代码是 5 分钟静默窗口 + 5 分钟最大等待（`syncLifecycle.ts:17`）。这是文档与实现的漂移，不是同步正确性问题，但会影响用户对“多久能同步”的预期。

---

## 4. 场景矩阵

图例：✅ 有明确处理且测试覆盖；⚠️ 有处理但存在条件、文档未说明或体验不完整；❌ 缺失处理或会阻断整条链路。方括号是第 5 节的缺口编号。

### 4.1 配置、凭据与仓库身份

| 场景 | 当前处理 | 判定 |
| --- | --- | --- |
| 未配置服务器/用户名/应用密码 | 返回 `offline`，不发起网络请求 | ✅ |
| 401/403 认证失败 | 转成人话提示，按退避重试 | ✅ |
| 429/503 限流 | Rust 传输层对单请求最多重试 3 次（尊重整数 `Retry-After`），整轮失败后自动退避 | ✅ |
| 507/空间不足 | 明确提示空间已满 | ✅ |
| 非法 URL、非 HTTPS（除 loopback）、危险远端路径、`..` | 请求前拒绝，有共享 fixtures | ✅ |
| `journal/` 目录不存在 | 视为空仓库；本机无日志时触发全量重发 | ✅ |
| 本机 journal 在云端丢失/目录被清空 | 拉取结果不含本机设备时自动全量重发 | ✅ |
| 云端被恢复到旧备份，但本机 journal 仍在 | 不触发重发；只按旧 head 读取，可能静默缺少后来记录 | ❌ [F5] |
| 切换远端目录或账号 | 每设备游标按 fingerprint 分开，但实体版本基线/outbox 仍按 workspace 共享 | ❌ [F5] |
| 两台设备使用同一个 deviceId（克隆数据目录/迁移助手） | 没有检测；两台设备会写同一个 journal | ❌ [F5] |
| 同一台机器启动两个实例 | Tauri 有 single-instance 插件；Electron 未看到单实例锁 | ⚠️ |
| 旧客户端在 head 存在后继续写同一 journal | 旧客户端不更新 head，新读者只读到旧 `lastSeq`，尾部永远隐藏 | ❌ [F10] |
| 新设备 + 非空仓库 | 从 0 读取所有设备 journal，按实体取最新，重建库 | ✅（受 [F1] 对象缺失影响） |
| 新设备 + 仓库里有私密记录 + 未配置密钥 | 整轮拉取在第一条加密记录处失败，公有笔记也无法恢复 | ❌ [F4] |

### 4.2 本地写入与 outbox

| 场景 | 当前处理 | 判定 |
| --- | --- | --- |
| 编辑后在数据库提交前崩溃 | 保留上一次已提交状态；草稿机制负责最近输入 | ✅ |
| 数据库提交后、上传前崩溃/退出 | outbox 与本地写同事务，重启后继续 | ✅ |
| 重复保存相同内容 | `enqueueChange` 复用相同操作 ID，不制造新记录 | ✅ |
| 上传过程中继续编辑 | 新记录成为后继；ack 只把同一实体的下一个待上传项接到已确认父版本 | ✅ |
| outbox 超过 200 条 | 分批发；成功一轮后通过 `schedulePendingSyncBatch` 再排下一轮 | ⚠️ 可用，但尾部可能按分钟级推进 |
| outbox 内父/子记录顺序 | 使用 `workspaceId` 索引读取，同一 workspace 内按主键 UUID 顺序，**不是入队顺序** | ❌ [F7] |
| 一个附件在本地缺失 | 准备 entries 时直接抛错，**整批一条都不上传** | ❌ [F2] |
| 一个 document 缺少 Markdown/tiptapJson | `serializeWebdavPayload` 抛错，整批不上传 | ❌ [F2] |
| 私密实体且未配置密钥 | 不发布，网络操作结束后确认本地 outbox；本机保留 | ✅（但没有云端备份，见 [F4]） |
| 回收站/恢复/彻底删除 | 本地事务 + outbox + tombstone，重启可恢复 | ✅ |
| 导入完整备份 | 元数据、附件字节、outbox 在一个事务；先校验附件清单与内容数量 | ✅ |
| 数据库配额耗尽/事务失败 | 事务回滚，游标不前进；需要用户清理空间 | ⚠️ 没有自动清理/明确入口 |
| IndexedDB 被清空但 localStorage 游标/设备 ID 还在 | 只使用 localStorage 的旧游标，本机 journal 被当作“已消费”，不会重放 | ❌ [F5] |
| localStorage 被清空但 IndexedDB 还在 | 生成新 deviceId，已有数据仍在；旧 journal 变成 peer，可能留下长期孤儿日志 | ⚠️ [F5] |

### 4.3 拉取

| 场景 | 当前处理 | 判定 |
| --- | --- | --- |
| 无变化 | 1 次 PROPFIND；强 ETag 有效时连 head 都不重读，不 GET journal/对象 | ✅ |
| 增量拉取 | 只取 `seq > 游标` 且 `seq <= head.lastSeq` | ✅ |
| 首次全量恢复 | 每个 peer 每个实体只下载最新一条；40 条一批 | ✅ |
| 中途失败/超时/取消 | 已提交批次保留；游标只推进到已提交位置 | ✅ |
| 远端序号回退（journal 删除/重建） | 检测到 `head.lastSeq < known`，游标归零重读 | ✅ |
| 没有 head 的旧 journal | 读取全部记录，按 journal 最大序号回退检测 | ✅ |
| journal 已写、head 未写（尾部未提交） | 只暴露 `<= head.lastSeq`；写方下次同步补 head | ✅ |
| journal 被截断，但 head 仍指向更大的 lastSeq | 只返回现有行并 warning；游标仍可能前进，缺失序号不会再次读取 | ❌ [F8] |
| peer journal/head 格式损坏 | `parse_journal`/`parse_head` 返回错误，整个 `pull_journals` 失败 | ❌ [F1] |
| 未知实体类型/未来 schema/未知 operation | `supportedEntityTypes` 校验直接抛错，整个 pull 失败 | ❌ [F1] |
| payload id 不匹配、缺字段、跨 workspace | 抛错，整个 pull 失败（安全但不隔离） | ❌ [F1] |
| 正文/附件对象缺失或哈希不符 | `materialize` 抛错，整个 pull 失败，游标停在之前 | ❌ [F1]/[F11] |
| asset 行没有 objectHash/hash | 在写入元数据和游标前拒绝 | ✅（但同样会永久卡住） |
| 重复记录、自己的重放、更旧祖先 | 消费/跳过，不产生冲突 | ✅ |
| 私密记录 + 错误密钥 | 抛“密钥不匹配”，不覆盖本机、不推进游标 | ✅（但整轮都停） |
| 私密记录 + 未配置密钥 | 抛“请配置密钥”，整轮失败 | ❌ [F4] |
| 私密页面收到明文远端记录 | 消费但保留本机私密状态 | ✅ |
| 父页面与子 document 跨设备乱序 | 没有全局因果顺序；桌面可先落孤儿 document，Android 文档称会等待/48 小时后跳过 | ⚠️ [F7] |
| 拉取期间本地编辑同一实体 | 本地版本保留，远端正文进入冲突副本 | ✅ |
| “重新读取全部云端记录” | 清空游标后从头重放；幂等 | ✅ |
| 大库首次恢复超过 30 分钟 | 硬超时中止，但已应用批次保留，下次继续 | ✅（可能需要多轮） |
| journal > 100 MB 或对象 > 100 MB | 直接报错；没有修复入口 | ❌ [F6] |

### 4.4 推送与提交

| 场景 | 当前处理 | 判定 |
| --- | --- | --- |
| journal PUT 成功、head PUT 失败 | 读者停留在旧 head；写方 outbox 未确认，下次重推 | ✅ |
| 对象 PUT 失败 | 不写 journal，不确认 outbox | ✅ |
| 上传回执 count/firstSeq 不完整 | 不确认 outbox | ✅ |
| 取消/超时/退出 | 不确认未完成批次；本机修改保留 | ✅ |
| 429/503 | 传输层重试；整轮失败后自动退避 | ✅ |
| 慢网络下 8 MiB 批次超过 60 秒 | 渲染层 60 秒 deadline 先取消；Tauri 命令本身允许更长，但被上层截断 | ❌ [F9] |
| 单个本地附件缺失 | 准备阶段抛错，整次 push 0 条 | ❌ [F2] |
| 推送成功后应用崩溃、未 ack | outbox 保留，下次重推；其他设备按重复/祖先消费 | ✅ |
| 推送期间继续编辑 | 新版本接到已确认父版本，保持 pending | ✅ |
| “以本机为准”恢复模式 | 显式用户操作：本机内容作为后继发布，远端独有实体仍下载 | ✅ |
| SSH→WebDAV 迁移 | 先准备对象、分批提交、逐批持久化基线；失败保留 outbox | ✅ |
| 浏览器本地桥 push | 没有把 `minSeq` 传给 helper；远端 journal 丢失后可能不遵守“序号不回退” | ⚠️ [F12] |
| journal 达到 10 万条 / 100 MB | `append_journal` 报错，且压缩不会减少 revision 数；没有修复路径 | ❌ [F6] |
| 服务端返回 2xx 但实际未保存 | 只信任回执；没有回读校验 | ⚠️ |

### 4.5 并发与冲突

| 场景 | 当前处理 | 判定 |
| --- | --- | --- |
| 两台设备同时改同一篇笔记 | 本机保留，远端正文另存“冲突副本”，本机作为后继发布，同步继续 | ✅ |
| 两边正文相同（忽略首尾空白） | 不生成副本 | ✅ |
| 干净副本先收到一个兄弟分支 | 先应用；后到的兄弟若被发布为后继则正常应用 | ✅（依赖发布方最终同步） |
| 三台及以上同时产生兄弟分支 | 各设备独立解决；可能出现多个冲突副本，且没有全局合并版本 | ⚠️ 有收敛倾向，但不是强一致 |
| 页面标题/标签/步骤/目录并发 | 保留本机，远端元数据不另存副本 | ✅ 产品策略，但会丢远端该字段 |
| 远端正文为空、正文不同 | `trim()` 为空时不生成副本，远端“清空”版本丢失 | ⚠️ 产品策略未说明 |
| 连续多轮并发编辑 | 每轮都可能生成新冲突副本；没有去重/数量上限 | ⚠️ 可能堆积 |
| 冲突实体在本轮被排除上传 | `conflictKeys` 按 `type:id` 精确过滤 | ✅ |
| 进入冲突状态后自动同步 | 自动触发直接返回，等待用户“以本机为准”或修复 | ✅ |
| 冲突副本自身同步 | 作为普通 pending 页面排队；附件按本地内容复制/重映射 | ✅（受附件/顺序影响） |
| 旧客户端遗留 conflict 标记 | 拉到对应记录后清除 | ✅ |

### 4.6 删除、墓碑与回收站

| 场景 | 当前处理 | 判定 |
| --- | --- | --- |
| 移入回收站 | page `upsert` 带 `deletedAt`；回收站可恢复 | ✅ |
| 从回收站恢复 | 清除 tombstone，重发 page + document | ✅ |
| 彻底删除 | 子实体 delete + document/page delete + 本地 tombstone；本地数据清理 | ✅ |
| 收到远端页面 delete | 只 `pages.delete`；不写 tombstone，不级联 document/附件/标签/历史 | ❌ [F3] |
| 收到远端 notebook/section delete | 只删对应行；子节点可能成为孤儿 | ❌ [F3] |
| 已彻底删除的页面收到旧分支 upsert | 版本比较通过后直接 `pages.put`，页面复活；tombstone 被忽略 | ❌ [F3] |
| 彻底删除后云端目录被清空并重发 | 本机 tombstone 会进入 `buildWebdavSnapshot`，但远端 delete 产生的删除没有墓碑，重发可能丢失 | ❌ [F3] |
| 清空回收站 | 逐页 purge；本地/远端 delete 排队 | ✅ |
| 回收站页面被另一设备编辑 | page upsert 可能把 `deletedAt` 覆盖掉，页面回到可见区 | ⚠️ 版本策略的结果，需产品确认 |
| 私密页面收到明文 delete | 跳过，保留本机私密状态 | ✅ |
| 删除/隐私迁移后的对象字节 | `objects/` 从不删除；坚果云文件历史还可能保留旧 journal | ❌ [F4]/[F6] 物理层面未清除 |

### 4.7 隐私

| 场景 | 当前处理 | 判定 |
| --- | --- | --- |
| 私密笔记本/页面，未配置同步密钥 | 本机保留，不上传明文 | ✅ |
| 配置密钥 | 页面、正文、历史、附件字节、关系、阅读位置加密；AAD 绑定上下文 | ✅ |
| 错误密钥 | 拒绝解密，不覆盖本机、不推进游标 | ✅（整轮停） |
| 新设备没有密钥 | 整轮失败，公有记录也拉不到 | ❌ [F4] |
| 密钥输错/两台设备密钥不同 | 没有仓库级 key-check；第一台设备可能把不可读密文传上去 | ❌ [F4] |
| 页面 `locked` 从 false→true | `savePage` 检测到并撤回旧公开表示 | ✅ |
| 页面移动到锁定笔记本（sectionId 变化） | 不触发撤回；旧明文仍留在远端 | ❌ [F4] |
| 分区移动到锁定笔记本 | `saveSection` 不检查隐私变化 | ❌ [F4] |
| 锁定整个笔记本 | `saveNotebook` 不检查隐私变化 | ❌ [F4] |
| 私密页面的冲突副本 | 继承私密分区/`locked`，按私密实体加密 | ✅ |
| 私密附件/历史 | 附件字节单独加密；revision 整体加密 | ✅ |
| 密钥轮换 | 没有流程；旧密文仍在新密钥设备上导致解密失败 | ❌ [F4] |
| 迁移前的明文残留 | 撤回只删除当前表示；旧 journal 文件版本和 `objects/` 明文可能仍在 | ❌ [F4] |

### 4.8 规模、跨端与版本

| 场景 | 当前处理 | 判定 |
| --- | --- | --- |
| v4 journal 持续增长 | 每次 push 重写自己的压缩日志；状态按实体压缩，revision 不压缩 | ⚠️ 已知 v4 限制 |
| revision 达到 10 万条 | `MAX_REVISION_ENTRIES = MAX_ENTRIES`；加上任何状态条目后超过 10 万，append 永久报错 | ❌ [F6] |
| journal 达到 100 MB | 同上，没有修复入口 | ❌ [F6] |
| 文档说 revision 环 256 条/2 MiB | 代码实际是 10 万条/100 MB（`webdav.rs:33`） | ❌ [F12] |
| 对象垃圾回收 | v4 没有删除对象的接口；已删除笔记的附件字节永久保留 | ❌ [F6] |
| 设备 journal 累积 | 每个设备一个文件，永不清理；PROPFIND 条目数长期增长 | ⚠️ [F6] |
| PROPFIND 750 条分页 | 一次 Depth:1 列表；没有分页或截断检测 | ⚠️ [F6] |
| Electron/Tauri 传输一致性 | 两份实现 + 共享 fixtures；常量一致，但仍是重复代码 | ⚠️ 需要持续对齐 |
| Android 兼容 | 共享 fixtures；但删除语义、无密钥行为、outbox 依赖顺序与桌面不完全一致 | ⚠️ [F3]/[F4]/[F7] |
| 时钟偏移 | 合并/游标/版本不依赖墙上时间；只有冲突副本标题和少量本地排序使用时间 | ✅ |
| 服务端重定向/认证头 | 未显式测试；依赖 reqwest/webdav 的默认行为 | ⚠️ |

### 4.9 生命周期、运维与用户入口

| 场景 | 当前处理 | 判定 |
| --- | --- | --- |
| 启动/联网/回前台/可见轮询/失焦/退出 | 有统一调度、合并、退避和 budget | ✅ |
| 自动同步关闭 | 自动触发全部跳过；手动可用 | ✅ |
| 冲突状态 | 自动触发跳过，避免反复下载同一前缀 | ✅ |
| 30 分钟请求预算 | 自动同步延后 5 分钟；手动绕过 | ✅ |
| 并发手动/自动同步 | `syncTask` 串行化；手动强制可排队 | ✅ |
| 超时/取消 | 终态恢复到上一状态，不残留“正在同步” | ✅ |
| 错误提示 | 401/403/404/429/503/507/网络/超时/密钥/缺附件都有中文说明 | ✅ |
| 诊断日志 | 有界、带 action/status/duration，敏感信息不在 URL | ✅ |
| “重新读取全部云端记录” | 幂等重放 | ✅ |
| “重新上传本机全部内容” | 全量排队、分批上传 | ✅ |
| 修复坏 journal/坏 head/坏对象/缺失附件/密钥错误/容量上限 | 没有对应入口 | ❌ [F1]/[F2]/[F4]/[F6]/[F11] |
| 最后成功时间/待上传数/冲突副本数 | 设置页可见 | ✅ |
| 退出前保存握手 | Tauri 有有限时长 flush；超时保留 outbox | ✅ |

---

## 5. 关键缺口

### F1 · P1 · 单条远端异常会阻断整个仓库

**场景**
- 任一设备的 journal 或 head 损坏；
- 任一记录是未知实体类型、未来 schema、缺字段、id 不匹配、跨 workspace；
- 任一正文/附件对象缺失或哈希不符；
- 任一私密记录无法解密（无密钥/错误密钥）。

**现状**
- `parse_journal`/`parse_head` 的任何一个错误都会让 `pull_journals` 整体返回 `Err`（`webdav.rs:519`、`:706`、`:787`），其他设备的记录也不会返回。
- `applyRemoteChanges` 对 `supportedEntityTypes` 之外的类型直接抛错（`sync.ts:208-210`）；一条非法记录会让整个批次事务回滚。
- `materializePayload`/`materializeDocument`/附件下载的异常会中止整轮 pull（`webdavSync.ts:441-450`）。
- 没有“隔离区/跳过并告警”的状态，下一次同步会在同一位置重复失败。

**影响**
一台旧版本客户端、一次不完整上传、一个损坏对象，就可能让所有设备都无法同步后续任何内容。用户看到的是“同步失败”，但错误信息通常只指向网络或某个对象，无法自助恢复。

**建议处理**
1. 在传输层按设备隔离：某设备 journal/head 损坏时，记录该设备为 `blocked`，继续返回其他设备的记录；不要把整个 `pull_journals` 变成 `Err`。
2. 在应用层按记录隔离：校验/下载/解密失败时，把原始记录写入 `syncQuarantine`（含 repository、deviceId、seq、type、id、reason、原始 payload、attempts、createdAt），推进游标并继续后面的记录；同步结果增加 `degraded/quarantined` 状态。
3. 未知实体类型默认“跳过并告警”，而不是致命错误；保留原始记录供未来版本重放。
4. 给隔离区提供“重试 / 导出诊断 / 删除”入口；删除前二次确认。不要在仍有隔离记录时显示纯粹的“已同步”。
5. 对“坏 journal 文件”这种无法逐条隔离的情况，至少让其他设备继续同步，并明确提示是哪台设备、哪条错误。

**验收**
- 两台 peer，一台 journal 损坏，另一台正常：正常设备的记录必须应用，游标推进；坏设备被标记；修复后能重读。
- 插入一条未知 type、一条坏 payload、一条缺对象记录：其余记录应用，隔离区出现 3 条，重试/删除可用。
- 无密钥的加密记录：公有记录继续应用，加密记录进入隔离区；配置密钥后可重放。

---

### F2 · P1 · 本地单条异常会阻断全部上传（队头阻塞）

**场景**
- 一个附件的 `assetContents` 缺失（数据库迁移、手工清理、恢复不完整）；
- 一个 document 缺少 Markdown 和 tiptapJson；
- 一个超大文档/附件超过传输上限。

**现状**
`syncWebdav` 在进入分批循环之前，先为所有 `pending` 构建 entries/objects；任何一个 `getAssetContent` 为空都会 `throw`（`webdavSync.ts:655-656`），此时**一条都不会上传**。探针确认：一个正常页面 + 一个缺失附件，`push` 调用次数为 0。

**影响**
用户可能只是丢了一个附件文件，但所有笔记、标签、阅读位置都停止上传；错误提示“相关变更暂缓上传。其他内容已正常同步”与事实不符。

**建议处理**
1. 逐项准备：每个 outbox item 单独 try/catch；成功项进入批次，失败项保留在 outbox 并记录 `lastError`/`attempts`。
2. 失败项不阻塞后续项；本轮结束后返回 `skipped/failed` 数量，UI 显示“N 条无法上传”并给出“重试 / 定位附件 / 移除该附件”的操作。
3. 对连续失败 N 次的项进入隔离区，避免每轮都重试；用户处理后可重放。
4. 超大对象在本地保存/导入阶段就拒绝，或明确标记为“不可同步”，不要等到 push 才失败。
5. 修正错误文案，只有确实完成了其他项才说“其他内容已同步”。

**验收**
- 一个缺失附件 + 一个正常页面：正常页面上传并 ack，缺失附件仍在 outbox 且有错误记录。
- 缺失附件移出 outbox 后，剩余内容继续同步。
- 连续失败达到阈值后不再自动重试，UI 可操作。

---

### F3 · P1 · 永久删除语义不闭环

**场景**
- A 彻底删除笔记；B 离线或未看到删除，基于旧版本编辑并发布；
- A 收到远端页面 `delete`，本地删除但没有墓碑；
- 云端目录被清空后重发，删除信息丢失；
- 删除 notebook/section，子节点变成孤儿。

**现状与复现**
- 远端 `delete` 只执行 `pages.delete`/`documents.delete` 等单行删除（`sync.ts:326-343`），不写 tombstone，不级联子实体。新版客户端的 `purgePage` 会额外排队子实体 delete，正常路径通常能清掉；但 apply 本身没有防御，旧客户端或丢失子记录时会留下孤儿。
- 已彻底删除的页面收到远端 upsert 时，版本比较通过后直接 `pages.put`（`sync.ts:343`）。探针结果：墓碑仍在，但页面被复活。
- `applyRemoteChanges` 的 delete 分支没有更新 `exportData` 的 tombstone 集合；重发时不会把远端删除带给其他设备。
- Android 最近的修复已经明确“持久删除标记优先于迟到草稿、重启恢复和旧远端版本”，桌面端没有对齐（参见 `docs/audits/2026-10-11/android-conflict-delete-fix.md`）。

**影响**
- 用户彻底删除的笔记可能“自己回来”；
- 云端清空/重建后，删除状态丢失，其他设备继续保留已删内容；
- 删除父节点后子数据残留，可能在新设备恢复时出现孤儿。

**建议处理（需要产品确认并写入同步策略）**
1. 远端 `delete` 视为永久删除。应用时在同一个事务中写 tombstone（`page:<id>`/`section:<id>`/`notebook:<id>`），并级联删除页面子数据：document、pageTags、taskSteps、assets + assetContents、pageLinks、readingPositions、revisions、drafts、editorCaches。
2. 在应用 page `upsert` 前检查 tombstone：若存在 `page:<id>` 且本地没有 live page（区分“回收站 tombstone + 页面仍存在”），则视为已永久删除：
   - 不复活页面；
   - 把 `syncVersions` 提升到 `change.version + 1`；
   - 重新排队一个 `delete` 作为后继，使其他设备收敛；
   - 把被跳过的远端版本写入隔离区（或提供“恢复此版本”的显式入口），不要静默丢弃。
   如果产品决定“编辑优先”，也必须把删除冲突显式呈现（例如保留删除标记 + 冲突副本），不能像现在这样静默复活。
3. 重发/全量快照必须包含所有 delete tombstone；确认 `buildWebdavSnapshot` 对 page/section/notebook 都生成 delete。
4. 对回收站页面（有 `deletedAt` 的 live page）保持现有“可恢复 upsert”语义，不要与永久删除混淆。
5. 明确告知用户：永久删除是逻辑删除，内容寻址对象和历史文件仍可能留在网盘；真正的物理清除需要新建远端目录或服务端历史清理。

**验收**
- 远端 delete 后，本地有 tombstone，document/附件/标签/历史均被清理。
- 删除后收到旧分支 upsert，页面不复活，delete 后继被发布，其他设备也删除。
- 云端清空后重发，其他设备收到 delete 并删除。
- 回收站页面仍可正常恢复。

---

### F4 · P1 · 隐私迁移与密钥生命周期不闭环

**场景**
- 公开页面移动到锁定笔记本；
- 公开分区移动到锁定笔记本；
- 直接锁定整个笔记本；
- 新设备没有密钥，但仓库有私密记录；
- 两台设备密钥不同/输错；
- 轮换密钥；
- 迁移前的明文仍在 journal 历史/对象里。

**现状与复现**
- `savePage` 只在 `page.locked` 从 false→true 时调用 `retractPublicPageForPrivacy`（`content.ts:267`）。
- `saveSection`/`saveNotebook` 只写记录 + enqueue，不检查隐私变化（`content.ts:82`、`:104`）。
- 探针：公开页面移动到锁定笔记本的 section 后，outbox 只有 page upsert，`isPrivateSyncItem` 返回 true，但没有 `privacyRetraction`。旧公开明文不会撤回。
- `WebdavPrivacyCipher` 没有仓库级 key-check；第一台设备输错密钥时仍会加密上传，其他设备无法解密。
- 没有密钥时，`cipher.decryptPayload` 直接抛错（`webdavPrivacy.ts:22`），整轮 pull 失败；探针确认公有记录也不会被应用。
- 撤回只删除当前表示；旧 journal 文件版本、`objects/` 中的明文正文/附件仍可能存在，坚果云文件历史也可能保留。

**影响**
- 用户以为“移动到私密笔记本就安全了”，但旧明文仍在云端；
- 新设备没有密钥时，整个同步不可用，公有笔记也无法恢复；
- 密钥输错/轮换会导致不可读密文长期留在仓库；
- 撤回不是物理擦除，隐私承诺需要更准确的说明。

**建议处理**
1. **隐私迁移检测**：在所有可能改变隐私归属的写路径上计算 before/after（page.locked、page.sectionId、section.notebookId、notebook.locked）。public→private 时，对 notebook、section、page 及其 document/asset/taskStep/pageTag/pageLink/readingPosition/revision 逐个排队 `privacyRetraction`，然后再发布当前私密状态；private→public 时正常发布。
2. **仓库级 key-check**：在远端根目录增加 `privacy-check.json`（随机 verifier 用当前密钥加密，带版本/Key ID）。配置新设备时先校验；不匹配则拒绝上传并提示，不允许把不可读密文写进仓库。轮换密钥时提供显式迁移流程。
3. **无密钥/错误密钥隔离**：拉取遇到加密记录且无法解密时，不要把整轮 pull 变成失败；把记录放入隔离区，继续应用公有记录，UI 持续显示“有 N 条私密内容等待密钥”。配置正确密钥后重放隔离区。
4. **物理残留说明与清理**：明确撤回只保证“当前表示不可读”，旧 journal 版本和对象可能仍在。提供“迁移到新远端目录”的向导：新建目录，只上传当前加密状态，确认后删除旧目录；或者实现对象 GC + journal 重写，并说明服务端历史保留期。
5. **测试**：页面/分区/笔记本三种迁移、无密钥、错误密钥、key-check 不匹配、冲突副本仍加密。

**验收**
- 移动到私密笔记本后，旧公开 page/document/附件关系都有 retraction，其他设备删除旧明文。
- 新设备无密钥：公有记录应用，私密记录隔离；配置密钥后补全。
- 错误密钥：拒绝上传/下载，仓库不出现新的不可读密文。
- 密钥轮换有明确步骤，旧密文不会被误判为损坏。

---

### F5 · P1 · 游标与设备身份分裂存储；仓库切换/回滚未隔离

**场景**
- IndexedDB 被清空，但 localStorage 还在；
- localStorage 被清空，但 IndexedDB 还在；
- 克隆数据目录/迁移助手导致两台设备同 deviceId；
- 用户切换远端目录/账号；
- 云端恢复到旧备份，但本机 journal 仍在。

**现状**
- `legacyDeviceId()` 把 deviceId 存在 localStorage（`legacySshSettings.ts:77`）；笔记、outbox、syncVersions 在 IndexedDB。
- `loadSeqs()` 优先 DB，但会和 localStorage 取最大值（`webdavSync.ts:189`）；`saveSeqs()` 先写 localStorage 再写 DB（`:201`）。
- 如果 IndexedDB 被清空而 localStorage 保留，设备会用旧游标过滤自己的 journal：`seq <= known` 全部被跳过，本机没有数据可恢复，且不会触发“journal 丢失”重发（journal 还在）。
- `syncVersions`/`syncOutbox` 的键只含 workspaceId，不含远端仓库身份（`core.ts:41`）；`syncVersions` 会把 A 仓库的版本带到 B 仓库。
- 切换远端目录时，seqs 按 fingerprint 分开，但版本基线不分开；B 仓库的低版本记录会被当成祖先跳过。
- 设备 ID 没有写入 IndexedDB；克隆后两台设备无法检测自己共享同一个 journal。

**影响**
- 本地数据库丢失后，无法从云端恢复自己的 journal，且可能静默不同步；
- 两台设备同 journal 会互相覆盖、丢失更新；
- 切换仓库/云端回滚后，用户看到“同步成功”，但两边内容不一致。

**建议处理**
1. **DB 权威**：deviceId、每设备游标、仓库 identity 都存入 IndexedDB；localStorage 只作为一次性迁移来源。加载时如果 DB 有同步状态，忽略 localStorage 的更大值。
2. **一致性检查**：如果 DB 有页面但没有任何本仓库游标，按 0 重读，不要信任 localStorage；如果 DB 为空但 localStorage 有游标，按 0 重读（避免跳过自己的 journal）。
3. **克隆检测**：head 增加 `writerInstance`（额外字段，旧读者忽略）；本机观察到自己的 journal 在“本轮没有成功 push”的情况下 lastSeq 增长，或 `writerInstance` 不是本进程，判定同 journal 双写；旋转 deviceId 并重发。
4. **仓库身份**：增加 `repository.json`（随机 repositoryId + epoch）。本地记录当前 repositoryId；切换/缺失时明确让用户选择“合并并重发本机内容”或“只下载远端”，不要静默比较版本。syncVersions/outbox 的键至少包含 repositoryId，或在切换时重置基线并全量重发。
5. **云端回滚检测**：保存上次看到的 `{repositoryId, per-device lastSeq/head hash}`；远端明显回退时提示“云端被恢复到旧状态”，提供重发/只读选择。
6. **测试**：清 DB 留 localStorage、清 localStorage 留 DB、克隆 deviceId、切换远端路径、远端回滚。

**验收**
- 清 IndexedDB 留 localStorage：能重新读取自己的 journal 并恢复，或明确提示“本机数据丢失，是否从云端恢复”。
- 克隆 deviceId：检测到双写，自动旋转并保留双方内容。
- 切换仓库：不把旧仓库版本当作新仓库祖先；用户明确选择合并/重发或只下载。

---

### F6 · P1/P2 · v4 日志规模上限是硬死路，且没有对象/设备 GC

**场景**
- 长期编辑导致 revision 实体累积到 10 万条；
- 单设备 journal 达到 100 MB；
- 已删除笔记的附件对象永久累积；
- 设备 journal 越积越多，接近 PROPFIND 750 条。

**现状**
- `MAX_REVISION_ENTRIES = MAX_ENTRIES = 100_000`，`MAX_REVISION_BYTES = MAX_LOG_BYTES = 100 MB`（`webdav.rs:33-34`）。
- `compact_journal` 对 revision 只保留最新 10 万条；`append_journal` 又要求压缩后总条目 `<= 100_000`（`:891`）。一旦 revision 数量接近 10 万，加上任何状态条目就会永久报错“设备日志条目数超过 10 万，请先压缩日志”。
- 这个“压缩”不会删除 revision（代码刻意保留完整历史），所以没有自助修复路径；`queueFullWebdavRepublish` 也不清理远端 revision。
- v4 没有删除 `objects/` 的接口；删除笔记/隐私撤回都不会物理删除对象。
- 每个 deviceId 一个 journal，永不清理。

**影响**
重度用户或多年使用后，设备可能突然无法再上传，且所有修复按钮都无效。文档说“10 万条保护不再形成无法自救的死锁”，但按当前 revision 策略，它仍然会形成一个最终死锁。

**建议处理**
1. **协议层**：按 v5 设计把历史移出可变 journal（不可变 segment/snapshot），让 head/journal 不随总历史线性增长；这是根治方案。
2. **过渡层（必须二选一）**：
   - 恢复文档承诺的 revision 预算（如 256 条/2 MiB），按时间淘汰最旧 revision，并发布明确的“历史已截断”记录/审计；
   - 或保留完整历史，但提供用户确认的“重建远端 journal”修复：只保留当前状态 + 最近 N 条 revision，记录丢弃清单，并继续使用 `minSeq` 防止序号回退。
3. **提前告警**：达到 80% 条目/字节预算时在同步状态中提示，并给出修复入口。
4. **对象 GC**：按“当前状态 + revision + asset manifest”做引用扫描，带宽限期和可审计清单；不能判断时 fail closed（参考 SSH v3 的 GC 说明）。
5. **设备清理**：列出长期不活跃的设备 journal，确认其内容已被其他设备覆盖后允许删除；为 PROPFIND 750 条分页做检测/提示。
6. **文档对齐**：`docs/JIANGUOYUN_SYNC_V5.md:27` 仍写 256 条/2 MiB，与代码不一致。

**验收**
- 合成 100,001 条 revision：当前实现会报错；修复后要么按预算淘汰并有审计，要么重建 journal 成功。
- 100 MB journal 的修复入口可用，且其他设备能重读。
- 删除笔记后，对象在宽限期后能被 GC（或明确不 GC 的产品说明）。

---

### F7 · P2 · outbox 与跨设备记录缺少依赖顺序

**场景**
- 首次发布/从备份恢复时，document 排在 page 前面；
- 附件 metadata 排在 asset 前面；
- 不同设备的 page 与 document 交错；
- Android 新设备恢复等待父记录。

**现状**
- `queueImportedData` 按“先 notebook、section、page，再 document/asset/…”入队（`transfer.ts:88`），但 `listOutbox` 使用 `where('workspaceId').equals(...).limit(200)`（`core.ts:59`）。IndexedDB 对同一索引键按主键排序，主键是随机 UUID，所以读取顺序不是入队顺序。
- 探针输出：`page:p1 | document:p1 | document:p2 | page:p3 | section:sec | page:p2 | notebook:nb | document:p3`，父记录明显晚于子记录。
- 拉取端按 `deviceId` 再按 `seq` 排序（`webdav.rs:sort_pulled_entries`），没有全局因果顺序；父记录可能在子记录之后。
- Android 文档称会“停在缺失父记录前等待，48 小时后跳过”；桌面端容忍孤儿 document，但这会让 Android 的恢复体验变差甚至丢记录。

**影响**
新设备/Android 首次恢复可能长时间卡住；冲突副本引用的附件可能尚未到达；孤儿 document 不会立刻报错，但后续行为不确定。

**建议处理**
1. 给 outbox 增加单调 `queueSequence`（或 `[workspaceId+createdAt]` 复合索引 + 依赖 rank 作为 tie-break），`listOutbox` 按该顺序返回；跨批次保持顺序。
2. 在 `queueImportedData`/`enqueueChange` 中维护依赖 rank：notebook < section < page < document/asset/tag/task_step/page_link/reading_position/revision；delete 的级联顺序反过来（子先于父）。
3. 拉取端增加有界依赖缓冲：子记录先到且父记录缺失时暂存（有上限），父记录到达后一起应用；超过上限则进入隔离区并告警，不要静默 48 小时后跳过。
4. 与 Android 共享同一个顺序/依赖契约，加入 fixtures（如“乱序恢复”用例）。

**验收**
- 打乱 outbox 插入顺序后，`listOutbox` 仍返回父先于子。
- 乱序 journal（document 先于 page）在桌面端能恢复；Android 端不丢记录。
- 依赖超过上限时进入隔离区，UI 可见。

---

### F8 · P1 · 日志被截断时静默丢记录

**场景**
- 服务端/外部工具截断 journal，但 head 仍指向更大的 `lastSeq`；
- 上传中断导致 journal 字节少于 head 的 `journalBytes`。

**现状**
- `committed_view` 只比较字节数/hash，返回 `mismatch`；`pull_journals` 把它降级为 warning（`webdav.rs:794`）。
- 探针：head `lastSeq=2`，journal 只有 1 行 → 返回 1 条记录 + warning；如果本地游标已经是 2，`plan_journal_read` 认为无需 fetch，直接跳过；如果游标是 1，下一次会反复 fetch 但没有任何新记录，也不会报错。
- 结果是“同步成功”，但第 2 条记录永久缺失。

**影响**
静默数据缺失比同步失败更危险；用户不会知道某篇笔记的某个版本没有到达。

**建议处理**
1. 区分两种 mismatch：
   - `journal_last_seq > head.lastSeq`：journal 尾部未提交，只读已提交前缀（现有行为正确）。
   - `journal_last_seq < head.lastSeq`：**完整性错误**。不要把状态报告为 `synced`；标记该设备为 blocked，游标不越过缺口，UI 显示具体设备/序号。
2. 提供修复：
   - “让该设备重新发布”（推荐）；
   - “以现有 journal 为准重建 head”：至少连续两次读取确认 journal 字节稳定，用 ETag/If-Match 写入新 head（lastSeq=实际最大序号），记录审计事件；这会放弃缺失记录，必须用户确认。
3. 对 `journal_bytes`/hash 不匹配但 journal 完整且尾部更大的情况，参考 F10 的“提交标记修复”。

**验收**
- 截断到 1 行、head 指向 2：同步状态为 degraded/error，游标停在 1，UI 有明确提示；修复后恢复。
- 已消费到 2 的客户端也必须在 head/journal 校验时发现异常，而不是直接跳过。

---

### F9 · P2 · 慢网络下推送 60 秒上限与批次大小不匹配

**场景**
- 8 MiB 批次在 1–2 Mbps 上行需要 32–64 秒以上；
- 移动网络抖动、坚果云限速；
- 大批量首次发布。

**现状**
- 渲染层 `boundedTransport.push` 使用 `WEBDAV_OPERATION_TIMEOUT_MS = 60_000`（`webdavSync.ts:313`）。
- Tauri 命令本身给 push 更长 deadline（`60s + 5s/object`，最多 900s，`lib.rs:651`），但被渲染层 60 秒先取消，实际不生效。
- 整轮 watchdog 的空闲超时是 120 秒，且只在传输操作完成时 `alive()`；一个长时间 push 没有进度心跳。

**影响**
慢网络下同一批对象可能永远无法完成上传，表现为反复超时、outbox 保留；用户看到“网络较慢”，但换网也不一定好。

**建议处理**
1. 为 push 单独设置 deadline（例如 5 分钟），或在 push 期间由渲染层定期调用 `alive()` 心跳；同时保留取消能力。
2. 根据实测吞吐自适应调整 `WEBDAV_UPLOAD_BATCH_BYTES`（例如先把批次降到 1–2 MiB），而不是固定 8 MiB。
3. 记录每批耗时/字节/吞吐到诊断日志，便于判断是限流还是链路慢。
4. 对单个超大对象给出明确的“过大，无法同步”提示，不要重复重试。

**验收**
- 模拟 1 Mbps 上行、8 MiB 批次：不会在 60 秒被取消；进度心跳保持 watchdog；最终成功或明确失败。
- 取消操作仍然能中止。

---

### F10 · P2 · 旧客户端写入的尾部被 head 永久隐藏

**场景**
- 新客户端已经为某设备写入 head；
- 用户降级/另一台旧客户端继续写同一 journal，但旧客户端不更新 head。

**现状**
- 读者只暴露 `seq <= head.lastSeq`；旧客户端的新记录在 head 之后，永远不可见。
- 文档承认这一点（`docs/JIANGUOYUN_SYNC_V5.md:31`：“需由新版所属设备再次发布 head”），但代码没有“再次发布 head”的路径；旧设备不会自己升级。
- `warnings` 只提示 mismatch，不会修复。

**影响**
旧设备上的新编辑永远不同步到其他设备，直到用户升级旧设备或手动重建 head；用户很难定位。

**建议处理**
1. 对“journal 完整、hash 可解析、`journal_last_seq > head.lastSeq`”的情况，在连续两次读取确认稳定后，提供“修复提交标记”：
   - 用 journal 的实际字节/最大序号写新 head；
   - 使用 If-Match/ETag 避免与旧写入者竞争；
   - 记录审计事件和旧/新 lastSeq。
2. 或者在 UI 中明确告警“设备 X 的日志有未提交记录”，并引导升级。
3. 如果产品决定不支持旧客户端混用，至少在文档和设置页明确最低版本，并在检测到旧格式 tail 时提示。

**验收**
- 模拟 head.lastSeq=5、journal 有 6–8 行完整记录：修复后 lastSeq=8，其他设备收到 6–8。
- 并发旧写入时 If-Match 冲突，重读后重试，不覆盖。

---

### F11 · P2 · 远端对象损坏缺少强制修复

**场景**
- `objects/<hash>` 被替换/损坏；
- 多个设备都已有该对象路径，上传时 `put_object` 发现 exists 就跳过；
- “重新上传本机全部内容”也不会强制重传对象。

**现状**
- 下载时 `get_object` 会校验 SHA-256，失败即抛错（`webdav.rs:828`）。
- 上传时 `put_object` 只看 `exists`，不校验远端已有内容（`webdav.rs:834`）；`queueFullWebdavRepublish` 也只排队实体，不会让 `put_object` 忽略 presence 缓存。
- 文档说 Android 会在有待发布变更时校验同 hash 的远端对象并重传；Electron/Rust 没有对齐（`docs/JIANGUOYUN_SYNC_V5.md:28`）。

**影响**
一个损坏对象会让所有需要它的设备永久拉取失败；用户点“重新上传”也无法修复，因为上传端认为对象已经存在。

**建议处理**
1. 下载哈希失败时，把该 hash 标记为 corrupt（负缓存），并通知上传路径强制重传。
2. 提供“强制校验并重传对象”的修复：忽略 `OBJECT_PRESENCE`，对本地仍有的对象逐个 `GET` 校验或直接 `PUT`（内容寻址，重复写安全）。
3. 若本地也没有正确字节，隔离引用该对象的记录并提示“源设备需要重新上传”。
4. 在 `put_object` 中可选地做远端校验（成本高），至少在“修复模式”下做。

**验收**
- 服务端对象被篡改：普通 pull 失败并标记 corrupt；“修复”后重新上传正确字节，pull 恢复。
- 修复不会误删其他对象。

---

### F12 · P3 · 文档/实现漂移与小问题

| 问题 | 现状 | 建议 |
| --- | --- | --- |
| revision 环容量 | 文档 256 条/2 MiB（`JIANGUOYUN_SYNC_V5.md:27`），代码 10 万条/100 MB（`webdav.rs:33`） | 明确产品策略；要么恢复预算，要么更新文档并说明死锁修复路径 |
| 自动同步节奏 | 文档 30 秒/3 分钟（`SYNC_RELIABILITY_2026-10-13.md:42`），代码 5 分钟/5 分钟（`syncLifecycle.ts:17`） | 更新文档或调整常量；在设置页显示实际节奏 |
| 缺附件文案 | 提示“其他内容已正常同步”，实际整批不上传 | 修正文案（见 F2） |
| 浏览器桥 `minSeq` | `bridgeTransport.push` 没有转发 `minSeq`（`webdavSync.ts:163`） | 补参数；helper 端支持序号下限 |
| baseUrl 查询/片段 | 校验只要求 http(s)，带 `?`/`#` 时拼接路径可能出错 | 拒绝 query/fragment，或规范化 |
| Electron 单实例 | 没有看到 `requestSingleInstanceLock` | 已废弃但仍应加锁，避免同数据目录双实例 |
| deviceId 校验 | Rust 正则是 `^[0-9a-f-]{36}$`，比 UUID 宽松 | 收紧为 UUID 格式 |
| `Retry-After` 日期格式 | 只解析整数秒 | 支持 HTTP-date，或明确忽略并记日志 |
| 同名标签 | 两台设备离线各建同名标签会得到两个 ID | 合并策略/UI 提示，非阻塞 |


### 5.13 需要产品确认的决策（建议默认值）

| 决策 | 建议默认处理 |
| --- | --- |
| 永久删除 vs 并发编辑 | 删除优先；被跳过的远端版本进入隔离区，可手动查看/恢复，不自动复活 |
| 未知实体/未来 schema | 跳过并隔离，不阻塞其他记录；保留原始记录供升级后重放 |
| 坏 journal/head | 该设备标记 blocked，其他设备继续；不自动删除远端文件 |
| 无密钥 | 公有记录继续同步，私密记录隔离；配置密钥后重放 |
| 密钥不匹配 | 拒绝上传/下载并提示；不清空本地、不覆盖远端 |
| revision 数量上限 | 优先 v5 分段；过渡期按明确预算淘汰并写审计，或提供“重建 journal” |
| 切换仓库/云端回滚 | 必须让用户选择“合并并重发本机”或“只下载远端”，不静默比较版本 |
| 物理删除 | 明确为逻辑删除；需要物理隔离时使用“新建远端目录并迁移” |

---

## 6. 修复优先级

| 阶段 | 内容 | 目标 |
| --- | --- | --- |
| **P1-a（最先）** | F1 远端隔离 + F2 本地逐项隔离 + F8 截断检测 | 任何单条异常不再让整个仓库停摆；同步状态能如实反映“有隔离内容” |
| **P1-b** | F3 删除语义 + F4 隐私迁移/密钥 + F5 游标身份 | 删除不复活、不丢墓碑；隐私迁移不残留旧明文；本地数据丢失/克隆/切换仓库有明确处理 |
| **P2** | F7 依赖顺序 + F9 慢网络 + F10 旧客户端 tail + F11 对象修复 | 跨端恢复稳定；慢网可用；旧版本可收敛；坏对象可修 |
| **P3** | F6 的 v5 根治、对象/设备 GC、文档对齐（F6 的 80% 告警与“重建 journal”修复入口应提前到 P2） | 长期不撞硬上限；运维可解释 |

建议的验收门槛（在宣称“同步可靠”之前）：

1. 注入一条坏 journal、一条未知类型、一条缺对象、一个错误密钥：其他记录/其他设备必须继续同步，隔离区可见且可重试。
2. 一个缺失本地附件 + 10 条正常变更：10 条正常变更上传成功，缺失项单独报错。
3. 彻底删除后，旧分支 upsert 到达：不复活；其他设备最终也删除。
4. 公开页面移动到私密笔记本：旧公开表示被撤回；新设备无密钥时公有笔记仍可同步。
5. 清空 IndexedDB 但保留 localStorage：能重新读取自己的 journal，或明确提示恢复；不能静默跳过。
6. 云端恢复到旧备份、切换远端目录：不静默分叉，必须有用户可见的选择。
7. 10 万条 revision 压测：不会进入无法自救的死锁。

---

## 7. 现有测试覆盖与建议新增

### 7.1 已有覆盖（值得保留）

- 传输层：head 先 journal 后 head、无 head 旧日志、未提交尾部、序号回退、强/弱 ETag、目录被删除、对象哈希、路径安全、HTTPS 限制、共享 fixtures。
- 存储层：outbox 合并、上传中编辑、conflict 自动解决、冲突副本、own replay、祖先跳过、legacy bootstrap、资产/游标原子提交、删除/恢复/彻底删除、导入/恢复事务。
- 同步引擎：分批、取消、超时、回执不完整、私有发布、隐私撤回、重发、二次拉取、scoped sync、浏览器桥、SSH 迁移。
- 桌面：Electron 传输、fixtures、目录/缓存、重载生命周期。

### 7.2 建议新增（按优先级）

1. 坏 peer journal + 正常 peer：正常 peer 仍应用；坏 peer blocked；修复后恢复。
2. 未知实体类型/未来 schema/坏 payload：隔离并继续。
3. 缺失/损坏对象：隔离；修复模式强制重传；恢复。
4. 无密钥/错误密钥：公有记录继续；私密记录隔离；配置密钥后重放。
5. 缺失本地附件 + 正常变更：正常变更上传，缺失项单独失败。
6. 远端 delete：生成墓碑、级联、重发包含删除。
7. 彻底删除 + 旧分支 upsert：不复活，后继 delete 发布。
8. 页面/分区/笔记本隐私迁移：retraction 覆盖所有子实体。
9. 清 IndexedDB 留 localStorage、清 localStorage 留 DB、克隆 deviceId。
10. outbox 乱序：父先于子；乱序 journal 恢复。
11. head 领先截断 journal：degraded/error，游标不越过缺口。
12. 100k revision/100MB journal：修复路径。
13. 慢网络 8 MiB 上传：不被 60 秒截断。
14. 旧客户端 tail：提交标记修复。
15. 切换远端目录/云端回滚：用户选择，版本不串仓。

---

## 8. 限制与说明

- 本评估是代码与合成用例评估，不是真实坚果云环境验收。真实 429/`Retry-After`、750 条分页、`If-Match`、流量配额、服务端历史保留仍需专用测试账号和隔离目录。
- Android 客户端不在本仓库；本文对 Android 的判断来自 `docs/SYNC_RELIABILITY_2026-10-13.md`、`docs/JIANGUOYUN_SYNC_V5.md` 和共享 fixtures，未做 Android 运行时验证。
- “彻底删除/隐私撤回”的物理字节清除涉及内容寻址对象和网盘文件历史，超出 v4 协议能力；本文只评估逻辑可见性，并把物理残留列为产品需要明确说明的限制。
- 本文的“P1/P2”是可靠性优先级，不是安全严重性评级；隐私相关项同时具有安全影响。
- 探针用例已删除，未改变仓库工作区。复现命令见附录。

---

## 9. 附录：探针输出与复现

### 9.1 探针输出（节选）

```text
PROBE corrupt journal result: Err("远端日志 ...jsonl 第 1 行格式不正确：EOF while parsing an object at line 1 column 36")
PROBE truncated head lastSeq=2 entries=1 warnings=["... 的日志与提交标记不一致（日志序号 1，标记 2），仅读取已提交部分"]
PROBE after cursor 2 entries=0 warnings=[]
PROBE resurrect result {"cursor":1,"conflicts":[]} page={... "title":"又被另一台设备改回来了" ...} tombstone={... "deletedAt":"2026-01-03T00:00:00.000Z" ...}
PROBE delete page=undefined tombstone=undefined
PROBE privacy move outbox=[{"type":"page","op":"upsert"}] isPrivate=true
PROBE outbox order=page:p1 | document:p1 | document:p2 | page:p3 | section:sec | page:p2 | notebook:nb | document:p3
PROBE missing asset push calls: 0
PROBE no-key apply calls: 0
```

### 9.2 复现方式

- Rust：在 `crates/notebook-sync/src/webdav/tests.rs` 临时加入“坏 journal + 正常 journal”“head 领先截断 journal”用例，运行 `cargo test probe_ -- --nocapture`。
- 存储层：在 `packages/storage-renderer/src/` 临时加入 `applyRemoteChanges`/`savePage` 探针，运行 `pnpm exec vitest run src/auditProbe.test.ts`。
- 同步引擎：在 `apps/renderer/src/sync/webdavSync.test.ts` 临时加入缺失附件/无密钥探针，运行 `pnpm exec vitest run src/sync/webdavSync.test.ts -t PROBE`。
- 以上临时文件在评估结束后已删除；仓库工作区保持干净。

### 9.3 关键源码位置

| 主题 | 位置 |
| --- | --- |
| head/journal 读取与 committed view | `cross-platform/crates/notebook-sync/src/webdav.rs:654`、`:706`、`:787` |
| journal 解析/压缩/上限 | `cross-platform/crates/notebook-sync/src/webdav.rs:519`、`:556`、`:863` |
| 对象上传/下载 | `cross-platform/crates/notebook-sync/src/webdav.rs:824`、`:834` |
| 拉取与批次/游标 | `cross-platform/apps/renderer/src/sync/webdavSync.ts:392`、`:424`、`:513` |
| 推送准备/缺失附件 | `cross-platform/apps/renderer/src/sync/webdavSync.ts:638`、`:655` |
| 推送 deadline | `cross-platform/apps/renderer/src/sync/webdavSync.ts:313`、`cross-platform/apps/tauri/src-tauri/src/lib.rs:651` |
| outbox 读取顺序 | `cross-platform/packages/storage-renderer/src/repository/core.ts:59` |
| 远端变更应用/删除/冲突 | `cross-platform/packages/storage-renderer/src/repository/sync.ts:194`、`:208`、`:326` |
| 隐私撤回入口 | `cross-platform/packages/storage-renderer/src/repository/content.ts:223`、`:267` |
| 设备 ID / 游标 | `cross-platform/apps/renderer/src/sync/legacySshSettings.ts:77`、`webdavSync.ts:189` |
| 密钥派生/解密 | `cross-platform/apps/renderer/src/sync/webdavPrivacy.ts:17` |
