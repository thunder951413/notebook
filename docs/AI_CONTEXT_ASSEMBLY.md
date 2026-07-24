# Notebook Next AI 上下文组装契约

## 状态

接口与纯函数组装器已经实现，具体 AI 服务接入尚未启用。后续 AI 功能应调用
`@notebook/sync-contract` 导出的 `buildAIContextBundle`，不能在 React 组件或网络
客户端中另写一套双链展开逻辑。

## 目标

发送一篇文章、一个段落或一个连续块组给 AI 前，临时生成只读上下文快照：

1. 根内容使用最新的规范 Markdown。
2. 默认只展开显式嵌入 `![[...]]`；用户选择“包含所有链接内容”时传入
   `policy.expansion: "all"`。
3. 页面、单块与连续块组统一通过稳定 ID 解析。
4. 每份内容保留标题、目标 ID、关系类型、深度和更新时间，供回答引用来源。
5. 展开结果只存在于本次请求内，不写回笔记，不制造重复正文或历史版本。

## 接口边界

组装器不知道 IndexedDB、SSH、Electron、编辑器或具体 AI 厂商。调用方提供：

```ts
type AIContextSourceResolver = (
  target: NotebookReferenceTarget
) => Promise<AIContextResolvedSource | undefined>
```

解析器负责从当前本地数据读取目标页面或块，并返回：

- `ready`：可安全使用的最新 Markdown；
- `locked`：隐私笔记尚未解锁；
- `missing`：目标不存在或尚未下载；
- `deleted`：目标已删除。

组装器绝不绕过解析器的访问决定。隐私笔记即使被普通文章间接引用，也不会因为
展开双链而泄露。

输出 `AIContextBundle` 同时包含：

- `items`：结构化来源，适合支持 citations 的模型接口；
- `markdown`：带明确来源边界的确定性文本，适合普通文本模型；
- `warnings`：循环、重复、锁定、缺失、深度或预算截断等问题；
- `totalCharacters` 与 `truncated`：供界面在发送前提示用户。

## 默认策略

- 展开方式：仅显式嵌入；
- 最大深度：4 层，根页面为第 0 层；
- Markdown 正文总预算：80,000 字符；
- 相同页面、块或块组在一个上下文包中只加入一次；
- 访问路径重复时停止，避免 A → B → A；
- 图片、录音和附件二进制不进入文本包。

调用方可选择加入资源的安全元数据（文件名、MIME 类型、说明文字）。未来接入视觉
或音频模型时，由单独的多模态适配层依据用户授权读取内容寻址资源，不能把二进制
内嵌进 Markdown。

## 后续 AI 接入步骤

1. 在存储层实现 `AIContextSourceResolver`，用规范 Markdown 解析整页、块和块组。
2. AI 面板增加“仅当前文章 / 包含嵌入 / 包含所有链接”的发送范围；最后一项必须由
   用户显式选择。
3. 发送前显示来源数量、锁定或缺失项、是否截断。
4. 将 `bundle.items` 映射为服务端 citations，同时把 `bundle.markdown` 作为实际上下文。
5. 回答展示来源标题，并支持点击回到页面或块。
6. 加入 token 估算器后，将字符预算替换为模型相关 token 预算；组装契约保持不变。

## 不变量

- Markdown 仍是唯一正文格式。
- 展开内容是派生快照，不参与保存、历史或 SSH 同步。
- 引用目标变更后，下次组装自然获得最新内容。
- 缓存可以删除并从 Markdown 重建。
- AI 不得因为双链间接访问未解锁的隐私内容。
