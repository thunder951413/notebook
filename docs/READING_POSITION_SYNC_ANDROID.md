# 阅读位置同步协议与 Android 实现

## 目标与边界

阅读位置是独立于笔记正文的同步元数据。浏览或滚动笔记不会增加正文 `version`，也不会创建历史版本或正文冲突。

macOS 当前实现位置：

- 数据结构与合并：`Notebook/BlockDocumentEntities.swift`
- 本地读取/写入：`Notebook/Models.swift`
- AppKit 捕获与恢复：`Notebook/RichTextEditor.swift`
- SSH 聚合同步：`Notebook/SSHSyncManager.swift`

## 远程协议

SSH 仓库中的权威文件是：

```text
<repositoryPath>/notes/reading_positions.json
```

示例：

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-07-16T06:00:00Z",
  "deviceID": "device-uuid",
  "positions": [
    {
      "noteID": "NOTE-UUID",
      "anchorUTF16Offset": 1532,
      "viewportOffsetFraction": 0.08,
      "updatedAt": "2026-07-16T05:59:58Z",
      "deviceID": "device-uuid"
    }
  ]
}
```

字段约定：

- `anchorUTF16Offset`：完整渲染文本中的 UTF-16 code unit 偏移。Swift 的 `NSAttributedString` 与 Android/Kotlin 的 `String`、`CharSequence` 都使用这一索引单位，不要换算成 Unicode code point。
- `viewportOffsetFraction`：锚点顶部相对可视区域顶部的比例，通常接近 `0`。它用于抵消字体、行高和窗口高度差异。
- `updatedAt`：ISO-8601 UTC 时间。
- `deviceID`：安装级稳定 UUID，用于时间相同时的确定性裁决。
- 附件在扁平文本中按一个 `U+FFFC` 字符计算；块之间的换行规则必须与 macOS 渲染文本一致。

每篇笔记的普通同步 JSON 中也有可选的 `readingPosition` 字段，供本地目录/iCloud 类型的整篇导入导出兼容。SSH 应优先使用独立聚合文件，避免正文版本未变化时漏传。

## 冲突合并

按 `noteID` 做 last-write-wins：

1. `updatedAt` 较新的记录胜出。
2. 时间完全相同时，`deviceID` 字典序较大的记录胜出。
3. 拉取后先把胜出记录写入本地；推送前下载远程文件、双向合并，再原子替换远程文件。
4. 不要用正文 `version` 判断阅读位置是否更新。

Kotlin 核心模型可写为：

```kotlin
data class NoteReadingPosition(
    val noteID: String,
    val anchorUTF16Offset: Int,
    val viewportOffsetFraction: Double,
    val updatedAt: Instant,
    val deviceID: String,
)

fun wins(candidate: NoteReadingPosition, current: NoteReadingPosition?): Boolean =
    current == null || candidate.updatedAt > current.updatedAt ||
        (candidate.updatedAt == current.updatedAt && candidate.deviceID > current.deviceID)
```

Room 表以 `noteID` 为主键，另外保存上述四个值即可。应用启动、同步完成后加载；滚动停止后本地 upsert。

## Android TextView/EditText 捕获

在内容完成排版后使用 `Layout`，不要保存 `scrollY`：

```kotlin
fun capturePosition(view: TextView): Pair<Int, Double>? {
    val layout = view.layout ?: return null
    if (view.text.isEmpty() || view.height <= 0) return null
    val contentTop = view.scrollY.coerceAtLeast(0)
    val line = layout.getLineForVertical(contentTop)
    val offset = layout.getLineStart(line) // Kotlin String 偏移就是 UTF-16
    val anchorTop = layout.getLineTop(line)
    val fraction = (anchorTop - view.scrollY).toDouble() / view.height
    return offset to fraction.coerceIn(-1.0, 1.0)
}
```

滚动事件做约 450 ms 防抖；切换笔记、页面销毁或进后台时立即 flush。相同位置无需反复写库，只有偏移或比例有实际变化时才更新时间。

## Android 恢复

必须等正文加载、字体应用并完成 layout 后执行：

```kotlin
fun restorePosition(view: TextView, position: NoteReadingPosition) {
    view.post {
        val layout = view.layout ?: return@post
        if (view.text.isEmpty()) return@post
        val offset = position.anchorUTF16Offset.coerceIn(0, view.text.length - 1)
        val line = layout.getLineForOffset(offset)
        val anchorTop = layout.getLineTop(line)
        val desiredY = anchorTop - position.viewportOffsetFraction * view.height
        val maxY = (layout.height - view.height).coerceAtLeast(0)
        view.scrollTo(view.scrollX, desiredY.toInt().coerceIn(0, maxY))
    }
}
```

恢复期间屏蔽滚动监听，避免刚恢复就生成一个更新的本地时间戳并覆盖远程记录。

macOS 的 Markdown 纯预览没有与富文本一一对应的 DOM 字符索引，因此该模式按正文 UTF-16 长度映射相对阅读进度；文本/分屏编辑模式使用精确字符锚点。Android 若能给渲染节点保留源文本区间，应优先恢复到精确源偏移。

## 分块/滚动窗口加载

若 Android 只加载笔记的一段窗口，不要要求先拼出全部正文。为每个块在列表元数据中保留：

- `blockID`
- `utf16Length`（包含与 macOS 一致的块尾换行）
- 块顺序

用长度前缀和定位 `anchorUTF16Offset` 所在块，只加载该块附近窗口；恢复后把目标块放到 `viewportOffsetFraction` 对应位置。编辑导致块长度变化时应同步更新前缀和。正文内容本身仍然按需读取，列表只需读取这些长度元数据。

## 建议测试

- 同一笔记切换出去再切回，位置误差不超过一行。
- 退出并重启，位置仍恢复。
- 中文、emoji、组合字符和附件之前/之后的偏移一致。
- 不同字号、窗口高度下仍落在同一段文字。
- 两端离线产生位置后合并，`updatedAt` 新者胜出；同时间按 `deviceID`。
- 恢复动作不会触发一次新的本地位置写入。
- 远程没有该文件、旧客户端没有 `readingPosition` 字段时均能正常同步。
