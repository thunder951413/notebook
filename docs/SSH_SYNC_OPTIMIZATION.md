# Notebook Next SSH 同步优化设计

## 状态

本文档是 SSH/SFTP 同步的优化设计，尚未实施。文中行号对应实施时的当前代码；
实施前需重新核对。

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

每个阶段独立可发布；Phase 1 完全不触碰协议与 renderer 编排，风险最低。

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

- 不修改 repository v3 协议与任何远端文件格式（旧客户端必须继续兼容）。
- 不改变合并冲突语义、隐私加密、锁契约。
- 不引入服务端组件；纯端侧优化。
