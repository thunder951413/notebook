# AI review workspace contract

Notebook AI uses a review-first transaction model. Chat output is never a durable note by itself.

## Built-in model and external AI

The Electron app can configure OpenAI, DeepSeek, or another OpenAI Chat Completions compatible
provider under Settings > AI and automation. The endpoint must use HTTPS. Electron stores the API
key in operating-system encrypted credentials, never in IndexedDB, exports, or the SSH repository.
Official OpenAI and DeepSeek keys are restricted to their official API hosts. A custom-provider key
is bound to the exact normalized HTTPS base URL, so changing a custom endpoint cannot reuse a key
saved for another host. Keys can be written, tested, or deleted only through the main-process AI
bridge and are never returned to the renderer.

The built-in chat can send pages explicitly selected with `@` and, when the user enables **Search notebook
library**, a bounded set of locally selected Markdown chunks. Search, block splitting, and ranking happen
on the user's device. The app sends at most 8 retrieved chunks and 20,000 retrieved characters, not the
whole notebook library, and the user can expand the message's **sent relevant chunks** disclosure to audit
the exact Markdown and source page. Explicit `@` context retains its own independent context budget.
Opening the AI workspace and reviewing proposals do not transmit note content. If the built-in provider
is disabled, the app can continue to use the existing local `127.0.0.1:8787` AI service. Provider requests
and local streams have a two-minute timeout, explicit cancellation, bounded output, and no redirect
following. Locked content is never model eligible; locally unlocking a privacy notebook only permits
viewing and does not grant AI access.

The right panel exposes two explicit modes instead of placing two ambiguous actions beside one composer:

- **Ask notebook library** produces a read-only answer. It can use bounded local retrieval and an optional
  `@` scope. The answer can later be staged as an append or replacement, but is never written implicitly.
- **Edit notes** produces structured rename, Markdown, move, create, or trash operations. It requires an
  explicit `@` authorization scope and has one primary action: generate a review draft.

Existing-page operations are rejected unless their page IDs were explicitly authorized with `@`.
Notebook topology supplies valid public section and parent IDs without exposing locked content. The
renderer validates that whitelist first; the automation bridge then adds fresh `updatedAt` baselines and
performs its normal schema, privacy, hierarchy, and stale-page checks.

The localhost automation API is a separate channel for an external agent. Both channels still end in
the same staged proposal, diff review, and explicit human approval flow.

## Session lifecycle

1. Read a page snapshot, including its canonical Markdown and `updatedAt`.
2. Build a proposal containing page-level operations.
3. Keep the proposal in the local `automationProposals` table with status `pending`.
4. Show only affected pages in the AI workspace and compare the proposal with the baseline.
5. Let the user accept or reject each change.
6. Recheck every accepted existing page's `updatedAt`.
7. In one IndexedDB transaction:
   - save a manual recovery revision for each accepted existing page;
   - write accepted page/document changes or move accepted deletes to trash;
   - enqueue normal page, document, revision, or tombstone synchronization records;
   - persist accepted and rejected change IDs on the proposal.

If a page changed after the proposal was created, applying the proposal fails as stale. The user must ask
the agent to read the latest state and submit another proposal. Rejected and unapproved changes never enter
history or synchronization.

## Review workspace layout

The review flow is arranged left to right:

1. **Batch changes** groups affected pages by notebook and preserves the proposed page hierarchy. A compact
   summary separates content changes, create operations, structural rename/move operations, and deletes.
2. **Editorial review** shows title/location metadata separately from body changes. The default editorial
   view favors readable before/suggestion blocks; side-by-side and unified Markdown views remain available.
   Each change can be ignored or restored, and previous/next navigation makes a large batch deterministic.
3. **AI collaboration** keeps conversation, actual retrieval sources, `@` scope, and the Ask/Edit boundary
   visible beside the diff.

At narrow widths the three panels become an explicit Changes / Review / AI tab switcher; no pane is silently
discarded. Very large diffs collapse long unchanged ranges and bound rendered changed lines so review cannot
freeze the interface. The complete canonical note remains available through **Open original note**.

## Supported staged operations

- `update-page`: Markdown, title, parent, section, or sort order.
- `create-page`: a new ordinary page in an existing public section.
- `delete-page`: a recoverable move to trash. Permanent deletion is not exposed to AI.

Moving a parent between sections and deleting a parent expand descendants into explicit changes. This keeps
indirect effects visible in the left change list and prevents hidden subtree mutations. A partial review
cannot accept the parent operation while omitting a required descendant operation.

## Conversation context and `@`

The chat composer uses `@` to select one or more public pages. Each selected root is resolved through the
existing AI context assembler:

- canonical Markdown is sent with a page ID and source boundary;
- explicit embeds can be expanded by default;
- all links can be expanded only when the user selects that scope;
- cycles, missing pages, locked pages, deleted pages, depth limits, and character budgets are reported as
  context warnings;
- resource metadata may be included, but binary attachments are not silently uploaded.

An answer can be staged as a replacement or append operation for any selected `@` page. This creates a
normal proposal; it does not call the note save API directly.

## Local library retrieval

Question answering and write authorization are deliberately separate:

- Page-level candidates come from Notebook's local incremental full-text index.
- Only the highest-ranked public candidate pages are loaded.
- Tiptap's existing Markdown serializer splits those pages along real top-level blocks while retaining
  heading paths; no second Markdown parser is maintained.
- A second local rank selects a maximum of 8 chunks and 20,000 characters. Locked/private pages and task
  records are rejected again before any document is loaded.
- The selected chunks are labelled with page and heading provenance in the model context and remain
  inspectable in the conversation.
- Retrieved pages are read-only evidence. They do **not** become eligible for rename, move, content
  replacement, creation below them, or deletion. Existing-page proposal operations remain restricted to
  the explicit `@` whitelist.

This first local retrieval layer is deterministic and works offline. The existing optional semantic-search
service remains an enhancement point for vector recall/reranking; it is not required for safe notebook
question answering and is never treated as a source of write authorization.

## External agents

Electron can expose the same proposal model over a loopback-only HTTP API. An external agent must read:

- `GET /v1/guide`
- `GET /v1/openapi.json`

It then reads public pages and submits a proposal. The API uses a random Bearer token, excludes private
notebooks, validates Markdown and hierarchy constraints, and requires `expectedUpdatedAt` for updates and
deletes. The token is encrypted by the operating system at rest. Requests are body-limited, concurrency-
limited, and time-limited. If a page becomes locked or deleted after a proposal was stored, the external
proposal-status endpoint redacts its cached page snapshots.

## Sync and history boundaries

AI proposal and chat state are device-local review state. They are intentionally not synchronized.
Accepted note changes are indistinguishable from careful user edits at the durable layer: they produce
recovery history, page/document updates, outbox entries, and the normal SSH conflict checks. This prevents a
partially reviewed AI plan from becoming visible on Android or another Electron device.
