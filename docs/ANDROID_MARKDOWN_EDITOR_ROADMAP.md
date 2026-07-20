# Android Markdown/Muya 后续实现清单

macOS 已采用 Muya + CodeMirror 的双编辑器方案。Android 可以独立实现 UI，远程数据协议不需要随之改变。建议按以下顺序推进。

## 第一阶段：先保住数据

- 保留现有 Room `drafts` 表；WebView 每次变更先写加密/受系统密钥保护的草稿，再进入数据库自动保存。
- 为编辑会话增加单调 revision 和 `dirty / saving / saved / failed` 状态；旧回调不得确认新修订。
- 切换笔记、返回、进入后台、同步前都调用同一个保存屏障。抓不到 WebView 最新 Markdown 时中止同步，不使用空字符串或旧 Room 内容兜底覆盖。
- 草稿记录 `noteID + baseVersion`。启动恢复只自动应用基准版本仍一致的草稿，其他记录进入恢复界面。

## 第二阶段：离线 Muya

- 将与 macOS 相同版本的 `@muyajs/core` 编译为 Android assets，WebView 只允许 `file:///android_asset/`、`data:` 和 `blob:`；禁用网络、混合内容、文件跨域访问和任意 JS interface。
- 使用 `WebMessagePort` 或限定 origin 的 `WebViewCompat.addWebMessageListener`，不要使用暴露任意对象方法的宽泛 `addJavascriptInterface`。
- 仅传输字符串 Markdown，不把 Muya JSON state 写入同步协议。图片选择/附件必须由 Kotlin 校验后通过受控 URI 返回。
- 外部链接交给 Android Intent，并对白名单 scheme 做校验；编辑器不能自己导航。
- 中文输入法组合文本期间不保存半成品；失焦、切换和显式保存必须先提交 composing text。

## 第三阶段：大文档与阅读状态

- 超过 250,000 UTF-16 code unit 默认使用 CodeMirror 6 源码模式，普通文档使用 Muya。允许按笔记记住用户选择。
- CodeMirror 提供视口虚拟化；不要把 600KB 文本拆成会破坏 Markdown 结构的固定字符页。
- 将 CodeMirror selection head / Muya 源字符锚点映射到现有 `anchorUTF16Offset`，视口映射到 `viewportOffsetFraction`。继续使用现有 `updatedAt + deviceID` 冲突规则同步。
- Android 的返回键顺序应是：关闭浮层/键盘 → flush WebView → Room 提交 → 更新保存状态 → 导航。

## 第四阶段：跨端验收

- 共享 fixtures 覆盖标题、段落、任务列表、表格、代码围栏、链接、中文/emoji、附件、未知块和空文档。
- 做 macOS → Android → macOS 往返，比较规范化 block 语义、附件 SHA-256、版本号和阅读位置，而不是比较各端编辑器内部状态。
- 回归场景至少包括：输入后立即切换、输入后立即同步、进程被杀、磁盘写失败、离线重启、远端版本领先、同版本不同哈希、删除墓碑、加密目录锁定。

## 不建议同时做的事

不要在接入 Muya 时一起替换 Room、同步协议或 block schema。这三个变化会让内容损坏时无法定位责任层。先让 WebView 只成为现有安全保存链路的一个编辑前端，再单独版本化协议演进。
