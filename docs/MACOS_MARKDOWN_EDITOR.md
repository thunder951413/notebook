# macOS Markdown 编辑器与数据安全

## 交付范围

macOS 对 Markdown 来源笔记采用本地离线编辑器：

- 普通 Markdown 默认使用 Muya 所见即所得编辑，支持标题、列表、表格、代码块、链接、数学和常用快捷插入。
- 正文达到 250,000 个 UTF-16 code unit 时默认使用 CodeMirror 6 源码模式。CodeMirror 只创建可见视口，对 600KB 级文本不会构造完整 NSTextView 布局。
- 用户可以在“所见即所得 / 源码”间切换；选择按笔记保存在本机。阅读锚点仍写入既有同步协议，因此其他终端可恢复位置。
- 编辑器、Mermaid 和所有字体/脚本随应用发布；CSP 禁止连接网络，外部链接只能交给系统浏览器打开。

## 不改变的数据边界

这次没有引入新的远端笔记格式。Muya/CodeMirror 的 Markdown 字符串仍进入既有 `LegacyNoteDocumentConverter`，最终保存为相同的 block、asset、history、conflict 和 tombstone 结构。`documentSource` 只复用现有元数据字段，值为 `TextFileDrop` 或 `MuyaMarkdown` 时选择 Markdown 编辑器；未知客户端可忽略它。

因此 macOS、Android 可以使用不同 UI 编辑器，但必须共同遵守：

1. 未知块和未知字段读取后原样保留。
2. 发布前执行编辑器保存屏障，失败则中止同步。
3. 同步冲突不能静默覆盖，删除继续使用墓碑。
4. 阅读位置继续使用 UTF-16 锚点、相对视口位置、时间戳和设备 ID 仲裁。

## 保存与恢复链路

每次编辑在进入数据库去抖队列之前先写独立加密草稿：

1. RTFD 快照用 Keychain 中的 256-bit 密钥进行 AES-GCM 加密。
2. 临时文件写入后执行 `fsync`、SHA-256 回读校验和原子替换；目录权限为 0700，文件权限为 0600。
3. 数据库事务成功后才删除对应草稿。
4. 下次启动只自动恢复“草稿基准版本 == 数据库当前版本”的记录；版本不符、密钥不符或损坏文件全部保留，绝不覆盖同步后的新版本。

编辑会话使用单调 revision。旧保存回调即使晚到，也不能把随后输入的内容标成“已保存”。顶部状态统一显示未保存、保存中、已保存或保存失败。

## 资源构建

发行包直接使用已提交的 `Notebook/MarkdownEditor.bundle`，编译 Notebook 不依赖旁边的 MarkText 仓库。只有升级 Muya/CodeMirror 时才运行：

```bash
./scripts/build-markdown-editor.sh
```

脚本从 `MARKTEXT_DIR`（默认 `../marktext`）取得依赖并重新生成离线 bundle。升级后必须检查第三方许可证、CSP、资源哈希、600KB 文档输入、中文输入法、表格/代码块以及切换笔记时的最后一次输入。
