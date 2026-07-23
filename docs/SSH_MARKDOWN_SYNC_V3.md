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

## Resource collection

An object is live while referenced by any current note, any retained history entry, or a migration backup. Ordinary sync intentionally never deletes content-addressed objects. A future maintenance command may perform grace-period collection after producing a recovery manifest; clients must not infer that an unreferenced object is immediately disposable.
