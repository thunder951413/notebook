# Notebook 数据安全与恢复手册

## 基本规则

- 不在唯一一份数据库上执行迁移、修复或恢复试验。
- 覆盖写入前必须备份数据库当前持久化内容，而不是即将写入的新内容。
- 数据库保存成功后才允许同步；保存、备份或校验失败时中止同步。
- 备份、日志和测试输出不得包含笔记标题、正文、密码或附件内容。
- `recovery/`、数据库、附件和导出包不得进入 Git。

## 创建阶段基线

正常安装的应用和数据位于默认位置时执行：

```bash
bash scripts/create-verified-backup.sh
```

自定义位置可使用：

```bash
NOTEBOOK_SOURCE_BASE="/path/to/base" \
NOTEBOOK_RECOVERY_ROOT="/path/to/secure/recovery" \
NOTEBOOK_APP_PATH="/Applications/Notebook.app" \
bash scripts/create-verified-backup.sh
```

脚本会正常退出应用、执行 WAL checkpoint、SQLite 在线备份、复制完整数据和附件、比较逻辑内容哈希、校验附件 SHA-256，并让正式应用在禁用同步的隔离测试模式打开恢复副本。原应用在成功完成后自动重新启动。

默认备份目录为 `~/Library/Application Support/NotebookRecovery`。目录和文件仅允许当前用户访问，阶段基线不得被日常备份清理任务删除。

## 验证要求

一个可接受的备份至少应包含：

- `notebook-consistent.store`
- `NotebookData/`
- `ApplicationSupport-Notebook/`
- `Notebook-installed.app/`
- `database-semantic-hashes.txt`
- `entity-counts.txt`
- `restore-drill-hashes.txt`
- `SHA256SUMS`

并满足：

- 所有数据库 `pragma integrity_check` 返回 `ok`。
- 源数据库、SQLite 在线备份和完整目录副本的逻辑转储哈希一致。
- 源附件和复制附件的逐文件哈希一致。
- 正式应用打开隔离恢复副本前后的逻辑转储哈希一致。

## 远端同步安全流程

1. 先只读下载远端 `library.json`、笔记索引、所有笔记信封、阅读位置和附件清单。
2. 校验 JSON 可解码、索引引用完整、附件大小与哈希一致，并生成不含正文的统计清单。
3. 使用远端快照在隔离数据库上做离线拉取/合并演练，禁止连接生产远端写入。
4. 比较演练前后的笔记、块、附件、版本、墓碑和内容哈希；任何无解释减少都中止。
5. 重新推送时逐笔记上传到临时文件并读回校验，最后才原子替换索引。
6. 不删除原远端目录。需要整体重建时写入带时间戳的新目录，验证完成后切换配置。
7. 本地数据库提交失败、备份失败或内容灾难性缩减时禁止推送。

禁止直接用本地目录覆盖远端目录，也禁止先清空远端再重新上传。

## 恢复步骤

1. 退出 Notebook，并确认进程已经结束。
2. 先把当前损坏数据整体移动到新的隔离目录，不要删除。
3. 校验目标快照的 `SHA256SUMS`。
4. 从 `NotebookData/` 恢复数据库和附件；不要只复制单独的 `.store` 文件。
5. 第一次启动时禁止自动同步，验证笔记、附件、版本和加密目录。
6. 再次执行数据库完整性与实体数量检查。
7. 确认本地内容完整后，才恢复远端同步。

## 必须停止并回滚的情况

- 笔记、块或附件数量无解释地减少。
- 内容哈希在没有用户编辑时发生变化。
- SQLite 完整性检查失败。
- 远端同步数据突然缩减到近空内容。
- 隔离恢复副本无法打开或打开后自行改变数据。
- macOS 与 Android 对同一同步信封产生不同语义结果。
