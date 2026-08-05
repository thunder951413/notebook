# SSH Markdown repository v3

## Canonical data model

Repository v3 keeps SSH/SFTP and makes GFM Markdown the only durable note body. Tiptap/ProseMirror JSON is a rebuildable local editor cache and is never synchronized or written to history.

`notes/index.json` stays compact, uncompressed UTF-8 JSON and declares:

```json
{
  "repositoryFormat": {
    "version": 3,
    "noteEncoding": "gzip",
    "contentFormat": "markdown-gfm",
    "assetAddressing": "sha256"
  }
}
```

Each `notes/<UUID>.json.gz` contains metadata, one current Markdown content hash, a map of unique Markdown strings keyed by SHA-256, and a history list containing hashes rather than snapshots. Consecutive equal revisions collapse; a final revision equal to the current body is omitted. A non-consecutive return to an older body remains in the timeline.

## Mixed Markdown and resources

Images use `![alt](notebook-asset:<asset-id> "caption")`. Files and recordings use normal links with the same stable URI scheme. Per-note asset metadata maps that ID to its SHA-256 object, MIME type, filename, dimensions, duration, alignment, and caption.

Binary resources live once at `objects/<first-two-hash-characters>/<sha256>`. They are never Base64-encoded into Markdown or copied into revision history. JPEG, PNG, audio, video, and archives are not recompressed.

The supported durable formatting surface is GFM headings, emphasis, links, code, tables, task lists, lists, quotes, and inline images/resources. Font family, font size, arbitrary text color, absolute positioning, handwriting, and free canvas data are intentionally outside the format.

## Ordered page hierarchy

Every page remains an independently addressable Markdown document. Navigation hierarchy is stored in the note metadata, never encoded into the Markdown body:

- `parentPageId`: optional parent page UUID; absence means a section root.
- `sortOrder`: a floating-point sibling order key. Clients normally allocate gaps of 1000 and may insert between two siblings without rewriting the subtree.
- `treeUpdatedAt`: the timestamp of the last structural move, independent from `updatedAt` for body edits.

Electron and Android merge this structural clock independently from the body revision. An older client that edits Markdown but does not send hierarchy fields therefore cannot flatten a tree created by a newer client. Importers clear self-links, missing/cross-section parents and cycles. Moving a page between sections moves its whole subtree; deleting, restoring and permanently deleting a parent apply to its subtree.

The hierarchy is not a linked list: each page stores only its parent and sibling order. This keeps a single-page move local, allows arbitrary depth, and makes interrupted synchronization easier to validate and repair.

## Private notes

Notes marked as private wrap the complete note envelope (title, preview, Markdown objects, history and note-local metadata) in AES-256-GCM. The key is derived from the configured SSH password with PBKDF2-HMAC-SHA256 (310,000 iterations); the note ID is authenticated as additional data. Electron and Android reject a wrong password or modified ciphertext without replacing local content. Binary resource objects are not encrypted by this layer and continue to rely on SSH transport, account permissions and server-disk protection.

Repositories containing private notes also publish `notes/privacy.json`, an authenticated key-check record using the same KDF and cipher. Both clients verify it before importing any note. A wrong or changed SSH password therefore stops before merge; clients never “skip” an unreadable private note and rebuild an index that could orphan it.

## Performance

- Notes are compressed independently with gzip level 9 and loaded on demand.
- Synchronization compares hashes and uploads only changed notes or new binary objects.
- Resource downloads are lazy and verified by SHA-256.
- Search uses the local Markdown index; it does not scan or decompress the remote repository.
- The local search index is reused between queries and invalidated by page edits instead of being rebuilt for every keystroke.
- Compression and SSH run outside the Electron renderer.

## Atomic migration

Writers retain the repository lock and temporary-file hash verification. A complete migration uploads content-addressed objects and every `.json.gz` note first, then publishes `notes/index.json` last. Readers select v3 paths only when the committed index declares version 3. Interrupted pre-commit migrations therefore continue to read the intact v1 repository.

Electron and Android read v1/v2/v3. After a committed v3 index is observed, both preserve v3, validate current/history hashes, write Markdown envelopes and use content-addressed resources. Duplicate index rows are normalized deterministically by highest version before use.

The Electron synchronizer never writes a pulled merge into IndexedDB before remote publication succeeds. Its final local commit is transactionally rebased against the snapshot taken at sync start, so edits made while SFTP is in flight remain pending. A conflicted page is kept at its existing remote version in the publication package, allowing unrelated pages to synchronize without overwriting either side of the conflict.

The verified pre-migration archive must be retained until Electron-to-Android round-trip, history restore, mixed image rendering, and repository-size checks all pass. Obsolete v1 note files and attachment paths may only be removed afterward.

## Server maintenance helper

The Electron-only server helper is an optional, manual maintenance tool. It does not participate in daily synchronization or automatically accelerate a first sync; ordinary SFTP remains the normal path and fallback. It runs over SSH only on POSIX servers with `python3` available.

`export-tar` acquires the shared repository lock, keeps it alive with heartbeats, verifies repository integrity, then emits a consistent tar snapshot. `import-tar` first unpacks into a stage and validates archive paths and limits, object and note hashes, cross-file references, and overall repository integrity. Only a valid stage is published while holding the lock, with overwritten files retained in the private recovery area and `notes/index.json` committed last; a rejected import leaves the existing repository unchanged. `verify` reports the concrete broken object, note, index, manifest, or reference rather than a generic failure.

`pull --tail` and `delta` are intentionally not implemented.

## Resource collection

An object is live while referenced by any current note, any retained history entry, or an asset manifest. Ordinary sync intentionally never deletes content-addressed objects. The manual helper's `gc` scans all of those references and only moves an unreferenced object older than its grace period into a private quarantine/recovery area, together with a recovery manifest. If an encrypted note prevents the helper from proving the complete historical object graph, collection fails closed without moving anything. A later `gc` run purges a quarantine batch only after a longer retention period, so collection is recoverable during that window; clients must not infer that an unreferenced object is immediately disposable.
