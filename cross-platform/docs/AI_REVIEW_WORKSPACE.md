# AI review workspace contract

Notebook AI uses a review-first transaction model. Chat output is never a durable note by itself.

## Built-in model and external AI

The Electron app can configure OpenAI, DeepSeek, or another OpenAI Chat Completions compatible
provider under Settings > AI and automation. The endpoint must use HTTPS. Electron stores the API
key in operating-system encrypted credentials, never in IndexedDB, exports, or the SSH repository.

The built-in chat uploads only the pages explicitly selected with `@` and references allowed by the
chosen context scope, and only after the user presses Send. Opening the AI workspace and reviewing
proposals do not transmit note content. If the built-in provider is disabled, the app can continue to
use the existing local `127.0.0.1:8787` AI service.

The right chat offers two distinct actions. Send produces a discussion answer that can be staged as an
append or replacement. Generate proposal asks the model for structured rename, Markdown, move, create,
or trash operations. Existing-page operations are rejected unless their page IDs were explicitly
authorized with `@`. Notebook topology supplies valid public section and parent IDs without exposing
locked content. The renderer validates that whitelist first; the automation bridge then adds fresh
`updatedAt` baselines and performs its normal schema, privacy, hierarchy, and stale-page checks.

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

## Supported staged operations

- `update-page`: Markdown, title, parent, section, or sort order.
- `create-page`: a new ordinary page in an existing public section.
- `delete-page`: a recoverable move to trash. Permanent deletion is not exposed to AI.

Moving a parent between sections and deleting a parent expand descendants into explicit changes. This keeps
indirect effects visible in the left change list and prevents hidden subtree mutations.

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

## External agents

Electron can expose the same proposal model over a loopback-only HTTP API. An external agent must read:

- `GET /v1/guide`
- `GET /v1/openapi.json`

It then reads public pages and submits a proposal. The API uses a random Bearer token, excludes private
notebooks, validates Markdown and hierarchy constraints, and requires `expectedUpdatedAt` for updates and
deletes.

## Sync and history boundaries

AI proposal and chat state are device-local review state. They are intentionally not synchronized.
Accepted note changes are indistinguishable from careful user edits at the durable layer: they produce
recovery history, page/document updates, outbox entries, and the normal SSH conflict checks. This prevents a
partially reviewed AI plan from becoming visible on Android or another Electron device.
