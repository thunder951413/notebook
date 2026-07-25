interface AutomationHandoffOptions {
  baseUrl: string
  token: string
}

export function buildAutomationHandoffText({ baseUrl, token }: AutomationHandoffOptions) {
  return `你现在可以通过 Notebook Next 的本机 HTTP API 帮我读取、整理、新建和修改笔记。

连接信息（仅用于本次本机操作，请勿复述、记录或发送给其他服务）：
- Base URL: ${baseUrl}
- Authorization: Bearer ${token}

开始前必须执行：
1. 使用能访问本机 127.0.0.1 的终端或后端 HTTP 工具请求 GET ${baseUrl}/v1/guide。
2. 请求 GET ${baseUrl}/v1/openapi.json，严格按返回的接口定义操作。
3. 所有请求都带请求头：Authorization: Bearer ${token}

工作流程：
1. 用 GET /v1/pages 分页读取或搜索笔记；需要正文时再用 GET /v1/pages/{pageId}。
2. 修改已有笔记时，原样使用读取结果中的 updatedAt 作为 expectedUpdatedAt。
3. 通过 POST /v1/proposals 提交一个主题明确的修改提案；不要假设提案已经生效。
4. 提交后告诉我提案标题和主要改动，等待我在 Notebook 中查看逐行差异并批准。
5. 如果收到 409，说明页面已变化：重新读取页面、重新规划，再提交新提案，禁止强行覆盖。

必须遵守：
- Markdown/GFM 是唯一正文格式。
- 保留 notebook-asset: 图片和附件引用，不得编造或改写资源 ID。
- 保留 Notebook 双链、块引用与层级语义，不要把界面展开的引用内容重复写回正文。
- 不得读取或推断隐私笔记；接口不会返回它们。
- 删除只能使用 delete-page 提案；它只会移到回收站，并要求用户在 Notebook 中二次确认。不得永久删除、直接修改数据库或绕过人工审阅。
- 不得写入脚本、javascript: 链接、data: 资源或外部追踪图片。
- 大规模整理先读取并理解现有结构，拆成范围清晰、便于审阅的提案。

可先用以下命令验证连接（不要在回答中打印 Token）：
curl --silent --show-error \\
  --header 'Authorization: Bearer ${token}' \\
  '${baseUrl}/v1/guide'

如果你当前没有访问本机 HTTP/终端的能力，请明确告诉我，不能假装已经读取或修改笔记。`
}
