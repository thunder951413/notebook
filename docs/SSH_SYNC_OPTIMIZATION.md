# Notebook Next SSH 同步优化设计

## 状态

坚果云 WebDAV 已是 Notebook 唯一正式的日常跨设备同步方式。本文档保留 SSH/SFTP v3 的历史优化与兼容恢复设计；SSH 不再推荐用于新的持续同步配置。

§2–§5 与 §7（Phase 1–4）描述的兼容实现仍可用于迁移和维护旧仓库。§6 是历史格式讨论，不是当前 WebDAV 同步路线。

实施时对设计的偏差（详见 §8）：
- **C2 push 模式**保留全量 pull+merge，不做"push 元数据拉取"——push 跳过
  merge 会让远端新建页面从远端索引中消失（数据丢失）；C1 无操作快速路径
  已覆盖"无变化同步近乎免费"的目标。
- **§7 helper 部署模型**由"用户手动上传脚本"改为"客户端内嵌单文件脚本，
  经 `ssh exec` 以 base64 注入 `python3 -c` 执行"——无需上传、无版本分发
  问题；前提是服务器具备 POSIX 环境和 python3（缺失时操作报错，同步本身回退
  纯 SFTP）。

## 目标

在不改变 repository v3 协议（任何远端文件格式均不变）的前提下，降低同步延迟、
减少传输与本地 I/O，并保持跨设备正确性：

1. 高延迟链路（移动网络、跨境）下显著减少 SFTP 往返次数。
2. 大仓库（数百笔记、数千附件）下减少 IndexedDB 导出与编码的无效工作。
3. 保持现有合并语义、锁契约、隐私加密与索引哈希校验不变。

## 1. 当前同步流程

```
renderer (legacySshSync.ts)
  exportData()                 ── 全量导出 IndexedDB bundle
  exportAssetContents()        ── 全量导出附件字节
  knownObjectHashes / knownNoteSignatures（本地缓存）
  ── IPC（base64）──> main (legacySftp.ts)
  pullLegacyRepository()       ── 读 index×2、逐文件 exists/stat/get
  ── IPC（base64）──> renderer
  decodeImport()               ── 解压 + 校验远端全部笔记
  mergeBundles()               ── 三路合并（local/remote/baseline）
  encodeMarkdownRepository()   ── 全量重新编码（含未变笔记的附件）
  ── IPC（base64）──> main
  pushLegacyRepository()       ── 锁 + 逐文件原子写（含读回校验）
```

每次同步 pull 与 push 各建立一条独立 SSH 连接。

## 2. 优化清单

### A. SFTP 网络层（P1，风险最低）

#### A1 一次同步复用一条 SSH 连接

- **现状**：`synchronizeLegacySshAttempt`（`apps/renderer/src/sync/legacySshSync.ts:277`）先
  `pull` 再 `push`，`pullLegacyRepository` 与 `pushLegacyRepository`
  （`apps/desktop/src/main/legacySftp.ts:294/387`）各自 `connect()`。每次连接包含
  TCP 握手 + SSH 密钥交换 + 主机密钥验证，约 2–4 RTT。
- **方案**：main 进程增加短生命周期连接会话（例如 `legacySftp:session` 返回
  sessionId，pull/push 携带），`connect()` 结果缓存到会话结束；`push` 沿用
  `pull` 已建立的连接，最后统一 `end()`。
- **预期收益**：高延迟链路省 2–4 RTT 与一次密钥交换 CPU；弱网下连接成功率提升。
- **风险**：会话泄漏会导致连接不释放。实现要点：`finally` 中强制释放；会话
  带 60s 空闲超时；`testLegacyConnection` 不参与会话。
- **兼容性**：仅涉及 main 进程内部与 IPC 参数，远端协议不变。

#### A2 pull 用目录列表替代逐文件 exists/stat

- **现状**：`readOptional`（`legacySftp.ts:203`）对每个文件执行
  `exists` → `stat` → `get`，3 次往返。拉取 N 个笔记 = 3N 次往返。
- **方案**：
  1. 对 `notes/`、`objects/<xx>/`、仓库根三个目录各执行一次 `client.list()`，
     得到全部文件 stat（1 次往返/目录）。
  2. 需要下载的文件直接 `client.get()`，下载后校验大小/哈希（大小不符即报错，
     内容哈希由 renderer 侧 `validateMarkdownNote` 兜底）。
- **预期收益**：3N → N+3 次往返；200ms RTT、50 个笔记约省 30 秒。
- **风险**：`list` 目录不存在时需吞错（仓库刚初始化时无 `notes/`）；`.tmp.*`
  临时文件需在过滤中排除（`list` 会看到未清理的残留）。
- **实现要点**：新增 `listOptional(client, path)`；`add` 辅助函数（
  `legacySftp.ts:311`）改用预取的 stat 表；保留 512MB 总量上限。

#### A3 push 读回校验收敛到关键文件

- **现状**：`atomicWrite`（`legacySftp.ts:278`）对每个文件执行
  put 临时文件 → get 读回 → sha256 比对 → rename，约 4–5 次往返/文件。
- **方案**：笔记与 objects 是内容寻址的，下次 pull 时索引 `contentHash` 与
  `assets_manifest.json` 的哈希会完整校验；上传损坏会在下一次同步被发现并
  重传。因此只对 `notes/index.json` 与 `notes/privacy.json` 保留读回校验，
  其余文件 put + rename 即可（posixRename 失败回退 delete+rename 保留）。
- **预期收益**：上传阶段往返减半以上；大仓库上传省时最明显。
- **风险**：单文件静默写坏后，损坏数据在下次 pull 校验时才被发现；因内容
  寻址 + 索引哈希兜底，不会产生不可恢复的数据丢失（远端旧版本仍在历史中）。
  若产品上希望更强保证，可改为“仅对 >1MB 文件保留读回”。
- **实现要点**：`atomicWrite` 增加 `verify: boolean` 参数，调用处按文件名决定。

#### A4 notes/objects 并发传输

- **现状**：pull 与 push 对文件逐个串行执行（`legacySftp.ts:341/424`）。
- **方案**：ssh2-sftp-client 支持同一 client 并发请求。实现一个固定大小
  （默认 4，可配）的 promise 池并行 `get`/`put`；objects 与笔记可分别排队，
  索引与 manifest 始终最后写（push 顺序约束 `priority` 排序保留）。
- **预期收益**：高延迟下下载/上传时间接近 ÷4；带宽瓶颈下无副作用。
- **风险**：服务端 SFTP 并发连接数限制（多数默认 10）；并发池上限 4 安全。
  出错时需等池内其余请求结束再抛错，避免连接中断后的乱序。
- **实现要点**：实现 `mapWithConcurrency` 工具函数；push 的
  `finishHeartbeat`/`releaseLock` 仍在其后执行。

### B. IPC 层（P2）

#### B1 Uint8Array 直传替代 base64

- **现状**：preload 契约 `legacySftp.pull/push` 用 `dataBase64` 字符串传输
  （`apps/desktop/src/preload/index.ts:68-69`），base64 膨胀 33%，且两端各做
  一次整仓库字节转换（`bytesToBase64`/`base64ToBytes`，
  `legacySshSync.ts:9-14`）。
- **方案**：契约改为 `data: Uint8Array`。Electron IPC（structured clone）与
  contextBridge 均支持 TypedArray 直接传递；`ipcRenderer.invoke` 参数与返回值
  同样支持。
- **预期收益**：IPC 字节量 -25%；省去两端大数组 base64 转换 CPU；
  `reusedNoteIds` 等小对象不受影响。
- **风险**：涉及 preload 类型、main 处理器、renderer 调用三处同步修改；
  `dataBase64` 还用于 `files:pickOpen/pickSave/readImage`（小文件，可不动）。
- **实现要点**：一次性改 `LegacySftpFile` 接口并更新全部调用点；保留
  `dataBase64` 兼容别名会引入重复，直接删除更干净（同步契约内部使用）。

### C. 编排快速路径（P2）

#### C1 空同步快速路径

- **现状**：每次手动同步都执行完整 `exportData`（IndexedDB 全量读）+ 全量
  编码，即使本地与远端都没变化。
- **方案**：同步开始前：
  1. 读取远端 `notes/index.json`（一次 `get`，约几 KB）。
  2. 与 localStorage 的远端签名缓存逐笔记比对；本地 `syncOutbox` 为空
     （`repository.listOutbox` 无记录）且索引签名完全一致 → 直接返回 synced。
  3. 不一致或 outbox 非空才走完整流程。
- **预期收益**：无变化时从“全量导出+编码+双连接”降为“1 次往返 + 几 KB”。
- **风险**：签名缓存缺失/陈旧时自动落入完整流程，无正确性风险；必须保证
  outbox 检查与索引比对同时成立才短路。

#### C2 push 模式元数据拉取

- **现状**：`mode='push'` 仍执行完整 pull（`legacySshSync.ts:306`）。首次同步
  或签名缓存失效时，会下载全部笔记正文，而 push 模式只关心远端索引与 objects
  是否存在。
- **方案**：`LegacySftpPullOptions` 增加 `metadataOnly: true`——只拉
  `notes/index.json`、`library.json`、`notes/assets_manifest.json`、
  `notes/reading_positions.json`、`notes/privacy.json`，不拉笔记正文；
  renderer 侧 `mode==='push'` 时启用，跳过 `decodeImport`/`mergeBundles`
  （push 语义本来就是“以本地为准发布”）。
- **预期收益**：push 首次同步从全量下载变为几百 KB 元数据。
- **风险**：push 前不合并会丢失“远端新增笔记”的知情权——这是当前
  `mode==='push'` 的既定语义（选择 push 即接受本地覆盖），需在文档/UI 文案
  中明确；`push` 流程仍保留 `expectedIndexHash` 并发保护。

#### C3 资产内容按需导出

- **现状**：`synchronizeLegacySshAttempt` 在 pull 之前对**全部页面**执行
  `exportAssetContents`（`legacySshSync.ts:286`），大仓库每次同步都从
  IndexedDB 读出全部附件字节。
- **方案**：
  1. `knownObjectHashes` 改为只用 `asset.checksum`（合法 sha256 时无需字节）。
  2. pull/merge 之后，只对“需要发布”的资产导出字节：变更/冲突页面、新增
     资产（`merged.bundle.assets` 中 `checksum` 不在 `remoteObjectHashes` 的）。
  3. `decodeImport` 所需的本地内容（若存在）按需传入。
- **预期收益**：99% 未变的大仓库同步不再读取全部附件字节（本地 I/O 大头）。
- **风险**：导出集合计算错误会导致附件丢失。实现要点：合并后的资产集合是
  唯一来源；对每个需要发布的资产做“有声明哈希则跳过导出，只有字节时才
  计算哈希”的双路径，并补测试。

### D. 渲染进程编码（P3）

#### D1 未变笔记的编码快速路径提前

- **现状**：`encodeMarkdownRepository`（`packages/sync-contract/src/markdownRepository.ts:193-226`）
  对每个页面先处理 assets（含 `imagePresentations` 遍历 + `files.set` 全部
  附件字节）后才检查 `reuseNoteSignatures` 复用；且开头无条件执行
  `encodeLegacyRepository` 全量导出。
- **方案**：
  1. 将 reuse 检查移到 assets 循环之前；复用页跳过附件处理与
     `extractNotebookReferences`（`linkedPageIDs` 对复用页不重新计算——
     注意：复用页内容未变，其引用不变，可安全使用远端既有值）。
  2. `encodeLegacyRepository` 改为可跳过（v3 只需其 `library.json` 与
     `skippedPageIds`，可为全复用场景提供轻量路径）。
- **预期收益**：未变页面占多数的仓库，编码阶段 CPU 与内存显著下降。
- **风险**：中。`linkedPageIDs` 是兼容性摘要（远端权威在 Markdown 本身），
  复用页跳过计算是安全的；需测试覆盖“全部复用”与“混合”两种场景。

#### D2 同步编排移入 main/worker（远期）

- **现状**：export、decode、merge、encode 全部在渲染进程执行，大仓库同步会
  造成 UI 卡顿（现有加载提示缓解，未根治）。
- **方向**：将解码/合并/编码流水线移入 main 进程或专用 worker，渲染层只负责
  触发与状态展示。这是跨包改动，独立于本设计其他项，另行评估。

### E. 健壮性（P3）

#### E1 push 端 objects exists 检查简化

- **现状**：`pushLegacyRepository` 对每个 objects 文件 `client.exists` 一次
  （`legacySftp.ts:425`），与 renderer 侧 `remoteObjectHashes` 过滤（
  `legacySshSync.ts:369-370`）重复。
- **方案**：renderer 把 `pulled.objectHashes` 传给 push，main 侧跳过已知
  哈希的 exists 检查；仅对未知对象保留 exists（防御孤儿对象）。

#### E2 重试退避加 jitter

- **现状**：`retryRemoteIndexChanges`（`legacySshSync.ts:259`）固定
  150ms/300ms 指数退避。
- **方案**：改为 `150 * 2^attempt + random(0, 150)`，并增加对 `EPIPE`/
  连接中断类错误的分类重试（当前仅重试“索引已变化”）。

## 3. 分阶段实施计划

| 阶段 | 内容 | 影响范围 | 预计收益 |
|---|---|---|---|
| Phase 1 | A1 连接复用、A2 目录列表、A3 读回收敛、A4 并发池、E1 | `apps/desktop/src/main/legacySftp.ts` + preload 参数 | 高延迟链路同步时间 -50%~-70% |
| Phase 2 | B1 Uint8Array、C1 空同步快速路径、C2 push 元数据拉取 | preload + `legacySshSync.ts` + 两端调用 | 无变化同步近乎免费；IPC -25% |
| Phase 3 | C3 资产按需导出、D1 编码快速路径、E2 重试 jitter | `legacySshSync.ts` + `sync-contract` | 大仓库本地 I/O 与 CPU 显著下降 |
| Phase 4（已实施） | 服务端 helper 增强层（§7） | 新增 `ssh exec` 通道 + 内嵌 python3 脚本 | 手动、可验证的 tar 备份恢复；verify/gc 仓库卫生 |

每个阶段独立可发布；Phase 1 完全不触碰协议与 renderer 编排，风险最低。
Phase 1–4 保持 repository v3 协议不变；v4 格式方向（§6）与旧客户端兼容性解耦，
作为独立演进，不与 Phase 1–4 混做。

> 注：C2（push 模式元数据拉取）实施时保留全量 pull+merge，未采用"跳过
> merge"的元数据拉取；无变化场景由 C1 快速路径覆盖。详见 §8。

## 4. 验证策略

- **单元测试**：`apps/desktop/src/main/legacySftp.test.ts` 扩充——
  并发池顺序保证、目录列表缺失容错、读回收敛后的 index 校验、
  会话复用与释放；`legacySshSync.test.ts` 扩充——空同步快速路径、
  push 元数据拉取、C3 双路径导出。
- **协议兼容**：`SyncContractFixtures` 与现有 importer/encode 测试必须全绿，
  证明远端文件格式未变。
- **手动场景**：
  1. 高延迟模拟（`tc netem` 或代理 +200ms）同步 50 笔记仓库，对比耗时。
  2. 千级附件仓库连续同步 3 次，观察本地 I/O 与内存。
  3. Android 与 Electron 互相同步，验证无变化时两端均无实际传输。
  4. 弱网中断：pull/push 中途断连，验证锁释放与重试行为。
- **回归门禁**：`pnpm typecheck && pnpm test && pnpm lint && pnpm build`。

## 5. 不做的事

- Phase 1–3 不修改 repository v3 协议与任何远端文件格式（旧客户端必须继续
  兼容）；v4 是独立方向（§6），按新格式迁移，不与旧客户端兼容。
- 不改变合并冲突语义、隐私加密、锁契约（v3 阶段）。
- Phase 1–3 不引入服务端组件；服务端 helper 仅作为可选增强层在 §7 评估。

## 6. v4 方向：不考虑旧客户端

### 6.1 旧客户端约束的两个层面

1. **格式兼容层**（丢弃旧客户端后可直接删除的代码）：
   - `usesCompressedNotes` / `encodeCompressedIndex` 的 v2 分支
     （`legacySftp.ts:43-50, 95-103, 145-150`）；
   - `repositoryEntrySignatures` 的 v2/v3 编码探测（`legacySshSync.ts:25`）；
   - `normalizeRepositoryIndex` 的排序规范化（`legacySftp.ts:105-135`，
     防御无序写入，旧客户端产物）；
   - `hasMarkdownRepository` 的 v1/v2 探测（`legacySshSync.ts:313-320`）；
   - 锁契约本身（`legacySftp.ts:212` 注释明确其为
     “legacy Android/macOS lock contract”：owner 文件 + 目录 mtime 陈旧判定）。
2. **v3 格式本体**：笔记 `.json.gz` 独立文件、每笔记自包含信封
   （per-note `contentObjects`）、`index.json` 全量重写、PBKDF2 310k 迭代。

重要事实：**旧客户端约束的是文件格式，不是传输效率**。§2 的 Phase 1/2 优化
（连接复用、往返削减、并发、IPC 二进制、快速路径）与旧客户端无关，v4 不改变
它们的收益。

### 6.2 解锁项

#### 6.2.1 v4 日志模型：消灭锁与重试（最大结构性收益）

现状的竞争核心：`index.json` 是共享可变文件，任何写者都要重写它，因此必须
加锁、读两次校验、并在“索引已变化”时重试（`retryRemoteIndexChanges`）。

v4 改为**每设备 append-only 日志**（`journal/<deviceID>.jsonl`）：

- 每个设备只 append 自己的日志（SFTP 原始 handle `open('a')` 追加写；现有
  代码已有 `(client as unknown as { sftp }).sftp` 访问先例，
  `legacySftp.ts:250`）。**单写者无竞争 → 无锁、无索引重写、无重试**。
- 读者按字节游标**只读日志尾部**（增量拉取），替代下载并规范化整个 index。
- 笔记正文仍内容寻址存放于 `objects/`，日志记录只含变更元数据与哈希引用；
  删除 = 日志中的墓碑记录。仓库不再需要全局 `index.json`。
- 压缩：每个设备重写**自己的**日志即可（唯一写者），无跨设备竞争。
- 合并语义不变：按实体版本 + baseline hash 冲突检测（与 v3 相同），
  跨设备变更天然可交换。

可行性：ssh2-sftp-client 的 `put` 不支持追加 flags，需走底层
`sftp.open(path, 'a')` + `write`；读者小日志可直接 `get` 全文，大日志用
底层 handle 按偏移 `read`。

#### 6.2.2 全局内容去重

- v3 中每笔记信封自带 `contentObjects`，相同正文/历史跨笔记重复存储。
- v4 把内容对象移到仓库级（`objects/` 已存在，正文 hash 也进对象库），
  笔记只引用 hash。模板页、重复正文、共享历史可跨笔记去重，大仓库瘦身显著。
- 代价：笔记不再自包含，读单个笔记需要对象引用解析（本地缓存后无感）。

#### 6.2.3 压缩与 KDF 自由

- `noteEncoding: gzip` 是旧客户端协议约定。v4 可用 zstd/brotli（Node 生态
  现成）或调低 gzip level（推送压缩 CPU 3–5 倍下降，体积 +1–3%）。
- PBKDF2 310k 迭代是为与旧客户端密钥一致；v4 可换 Argon2id 或降低迭代
  （隐私笔记加密/解密有缓存，KDF 每会话一次，收益有限，主要是自由度）。

#### 6.2.4 代码面收敛

删除 §6.1 格式兼容层后，同步路径预计净减 150+ 行；`legacySftp.ts`、
`legacySshSync.ts`、`sync-contract` 的 v2 分支全部消失。

### 6.3 v3 → v4 迁移

- 首次运行：读 v3 仓库（现有 `pull` + `decodeImport` 路径复用），重建为
  v4 布局（objects + 设备日志）后原子发布（先传对象，最后写首个日志，
  类似现有原子迁移顺序）。
- 迁移不可逆；完成后旧客户端停止同步（产品上明确提示）。
- 现有 `SyncContractFixtures` 保留，用于验证 v3 读取路径不被破坏。

## 7. 服务端 helper 盘点（已实施）

> helper 是 Electron 的可选、手动维护能力，不参与日常同步，也不会自动加速首次
> 同步；普通 SFTP 始终是默认路径与回退。它内嵌为零依赖 python3 单文件脚本
> （`legacySftp.ts` 的 `REPOSITORY_HELPER`），经 `ssh exec` 以 base64 注入
> `python3 -c` 执行。脚本、操作名与仓库根路径均走 base64，无 shell 注入面；
> stdin 仅承载 `import-tar` 载荷。服务器必须具备 POSIX 环境与 python3；不满足时
> 只有维护操作报错，普通同步不受影响。已实现 `export-tar` / `import-tar` /
> `verify` / `gc`；`pull --tail` 与 `delta` 不实施。

helper 与 §6 的 v4 方向正交，可独立取舍，且版本随客户端内嵌分发，无需用户上传。

### 7.1 部署模型与约束

- **形态**：单文件、零第三方依赖的 python3 标准库脚本，**内嵌在客户端**
  （`apps/desktop/src/main/legacySftp.ts` 的 `REPOSITORY_HELPER`），无需用户
  上传或下载；设置页"服务器仓库维护"面板直接调用。
- **通道**：`ssh exec`。桌面端显式声明 `ssh2` 直接依赖（原为
  ssh2-sftp-client 的传递依赖），helper 走独立 `connectExec` 连接（同一套
  指纹验证），与 SFTP 会话互不影响。
- **安全**：脚本、操作名、仓库根路径均以 base64 载荷注入 `python3 -c`，
  不含 shell 元字符、无拼接注入面；stdin 仅承载 import-tar 二进制；
  复用现有主机指纹验证；helper 本身拥有服务器任意执行权（即用户自己的
  凭据与服务器）。
- **限制**：服务器需具备 POSIX 环境和 python3；缺失时维护操作报错并明确提示，
  日常同步仍使用纯 SFTP。Windows 服务器（OpenSSH for Windows）无 POSIX 环境，
  helper 不可用。

### 7.2 能力清单与收益排序

| 能力 | 做什么 | 收益 | 优先级 |
|---|---|---|---|
| `export-tar` | 在共享锁与心跳保护下先校验，再导出一致的 tar 快照 | 手动备份可避免与发布并发时混入不同版本 | 高 |
| `import-tar` | 在暂存区校验路径、限制、哈希、跨文件引用和仓库完整性；持锁后保留覆盖前副本并最后发布索引 | 无效备份不改变当前仓库，覆盖可回退，恢复过程可验证 | 高 |
| `verify` | 输出具体的 object、note、index、manifest 或跨文件引用错误 | 让仓库损坏可定位，而非只返回泛化失败 | 高 |
| `gc` | 扫描当前笔记、历史和附件清单；超宽限期孤儿移至带恢复清单的私有隔离区 | 可恢复的仓库卫生；无法证明加密笔记完整引用图时安全拒绝；隔离批次超过更长保留期后由后续 `gc` 清除 | 高 |
| `pull --tail` | 聚合返回所有设备日志尾部，替代客户端逐个读 | 每同步省若干往返；收益随设备数增长 | 中 |
| `delta`（rsync 式） | 只传变化字节块 | **对当前仓库收益有限**：正文与附件均为内容寻址（改一次一个新对象），无就地修改文件；日志是 append-only，本身即增量。除非未来引入就地修改文件，否则不建议做 | 低 |

结论：**内容寻址仓库 + append-only 日志让 rsync 式差分无利可图**。helper
的价值集中在手动、可验证的备份恢复与仓库卫生，而非自动同步或增量传输。

### 7.3 风险与成本（实施后更新）

- 部署摩擦已消除：脚本随客户端内嵌分发，无需上传；前置条件是服务器具备
  POSIX 环境与 python3（缺失时维护操作给出明确错误）。
- Windows 服务器不支持；`ssh exec` 已新增通道（`connectExec`）与 `ssh2`
  直接依赖。
- helper 是端侧自由软件，用户可审查；但服务器上执行任意脚本仍是信任边界
  （与使用 SSH 本身同等信任模型）。
- `export-tar` 在共享锁、心跳和完整性校验后生成一致快照；`import-tar` 必须先在
  暂存区通过路径、限额、哈希、引用与仓库完整性校验，并在锁内保留覆盖前副本、
  最后发布索引。失败导入不会修改当前仓库。
- `verify` 返回具体的跨文件、对象、note、index 与 manifest 错误。`gc` 不会立即
  删除对象：它只将超过宽限期且未被当前笔记、历史或 manifest 引用的对象移入私有
  隔离/恢复区，并写入恢复清单；无法证明加密笔记的完整历史对象引用图时会安全拒绝，
  隔离批次超过更长保留期后只由后续 `gc` 清除。
- 已实现 `export-tar`、`import-tar`、`verify`、`gc` 四项；`pull --tail` 与 `delta`
  未实施。

## 8. 实施偏差记录

- **C2（push 元数据拉取）未按原文案实施**。原方案让 push 模式跳过 pull 与
  merge，直接推送本机内容；分析确认这会让远端新建/修改的页面从远端索引中
  消失（远端索引被本地发布覆盖），构成数据丢失。实施保留 push 模式的全量
  pull+merge，仅在**双向模式**下启用 C1 无操作快速路径（outbox 为空 +
  远端状态缓存比对通过 → 直接返回 synced），达到原 C2 预期的"无变化同步
  近乎免费"。
- **§7 helper 部署模型**由"用户上传脚本"改为"客户端内嵌 + base64 注入
  `python3 -c`"（见 §7.1），版本随客户端分发。
- **D1 可复用页的 manifest**：为防服务端 GC 与远端设备误判引用，可复用页
  仍声明其对象哈希（size 取 `asset.byteSize`），但不重新上传对象字节。
- **C1 探针比对**除索引哈希与签名映射外，还比对
  `reading_positions.json`、`library.json`、`notes/assets_manifest.json` 与
  `notes/privacy.json` 的哈希；这些元数据都可能在不改索引的情况下变化。
