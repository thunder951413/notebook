# Notebook Next 外部 AI 自动化接口

Notebook Next 的外部 AI 接口采用“读取 → 提案 → 人工审阅 → 应用”的工作流。它不会向外部进程暴露 IndexedDB，也不允许 AI 绕过应用直接写文件或数据库。

## 启用

1. 打开 Electron 版“设置 → AI 与自动化”。
2. 启用本地 AI 自动化接口。
3. 点击“复制 AI 接入说明”，把生成的整段指令直接粘贴给可信的 AI。该指令已经包含当前地址、Bearer Token、接口发现方式、提案流程和安全限制。
4. AI 会首先请求：
   - `GET /v1/guide`
   - `GET /v1/openapi.json`

服务只监听 `127.0.0.1`。默认端口为 `47831`，默认关闭。Token 为 256 位随机值，使用操作系统凭据加密保存，重新生成后旧 Token 立即失效。

“复制 AI 接入说明”只有接口启用时才可使用，避免复制出无法连接的配置。复制内容含有完整访问 Token，不应发布到公共聊天、Issue、日志或代码仓库。若只需要自行编写客户端，也可以分别使用“复制 Token”和“复制规则地址”。

```bash
export NOTEBOOK_URL=http://127.0.0.1:47831
export NOTEBOOK_TOKEN='设置中复制的 Token'

curl -H "Authorization: Bearer $NOTEBOOK_TOKEN" \
  "$NOTEBOOK_URL/v1/guide"
```

## 读取与搜索

```bash
curl -H "Authorization: Bearer $NOTEBOOK_TOKEN" \
  "$NOTEBOOK_URL/v1/pages?query=项目计划&limit=50"

curl -H "Authorization: Bearer $NOTEBOOK_TOKEN" \
  "$NOTEBOOK_URL/v1/pages/PAGE_ID"
```

列表接口返回页面标题、摘要、层级、`updatedAt` 和正文大小。单页接口返回完整 Markdown。隐私笔记和回收站页面不会返回。

## 提交修改提案

已有页面必须带上读取时得到的 `expectedUpdatedAt`：

```bash
curl -X POST \
  -H "Authorization: Bearer $NOTEBOOK_TOKEN" \
  -H "Content-Type: application/json" \
  "$NOTEBOOK_URL/v1/proposals" \
  -d '{
    "title": "整理项目计划",
    "explanation": "统一结构，保留原始事实和资源引用",
    "source": "external-agent",
    "operations": [
      {
        "type": "update-page",
        "pageId": "PAGE_ID",
        "expectedUpdatedAt": "2026-07-25T08:00:00.000Z",
        "title": "项目计划",
        "markdown": "# 项目计划\n\n整理后的正文"
      },
      {
        "type": "create-page",
        "sectionId": "SECTION_ID",
        "parentPageId": "PAGE_ID",
        "title": "后续行动",
        "markdown": "# 后续行动\n\n- [ ] 第一项"
      }
    ]
  }'
```

接口返回 `201` 只表示提案保存成功，并不表示笔记已经改变。用户需要在 AI 独占工作区或“设置 → AI 与自动化 → 待审阅修改”中查看逐行差异并批准。

## 应用时的保护

- 提案生成后页面发生变化，提案会标记为“已过期”，不能覆盖新内容。
- 每篇已有页面应用前都会创建手动历史版本。
- 正文仍以 Markdown/GFM 保存，编辑器 JSON 只是可重建缓存。
- 应用后的页面使用原有 outbox、版本历史和 SSH 同步链路。
- 删除操作只会生成“移到回收站”的提案；应用含删除的批次还需要用户再次确认，不提供永久删除。
- 外部 AI 不能读取或修改隐私笔记。
- 页面后来被锁定、移入隐私笔记本或删除后，旧提案接口只返回状态摘要，不再返回其中缓存的正文快照。
- AI 不得新增或删除已有 `notebook-asset:` 资源引用；脚本、事件处理器、危险 URI、HTML 图片和外部图片会在提案创建及应用时分别复检。
- 每次提案最多 200 项操作；单篇 Markdown 最大 2 MB；提案正文合计最大 8 MB；HTTP 请求正文最大 2 MB。
- 同时最多处理 8 个外部请求，单个请求 20 秒超时；应用端停止接口时，等待中的请求会明确返回服务不可用。
- 浏览器跨站请求被拒绝，降低恶意网页调用本地接口的风险。

## AI 必须遵循的正文规则

- 支持标题、粗体、斜体、链接、代码块、表格、任务列表和引用。
- 图片、附件和录音使用现有 `notebook-asset:` 引用。不得编造或更改未知资源 ID。
- 保留 Notebook 双链与块引用语法，不要把界面中展开显示的引用内容复制回正文。
- 不写入 `<script>`、`javascript:`、`data:` 或跟踪图片。
- 移动页面只能使用读取接口返回的 `sectionId` 和 `pageId`。
- 不把页面移动到它自己或它的后代下。
- 不确定事实时保留原文并在提案说明中标注，而不是猜测后覆盖。

## 状态查询

```bash
curl -H "Authorization: Bearer $NOTEBOOK_TOKEN" \
  "$NOTEBOOK_URL/v1/proposals"

curl -H "Authorization: Bearer $NOTEBOOK_TOKEN" \
  "$NOTEBOOK_URL/v1/proposals/PROPOSAL_ID"
```

状态包括：

- `pending`：等待用户审阅
- `applied`：已经应用
- `rejected`：用户拒绝
- `stale`：页面在提案后变化，需要重新读取
