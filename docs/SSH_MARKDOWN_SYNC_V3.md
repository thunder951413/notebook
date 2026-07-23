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

## Performance

- Notes are compressed independently with gzip level 9 and loaded on demand.
- Synchronization compares hashes and uploads only changed notes or new binary objects.
- Resource downloads are lazy and verified by SHA-256.
- Search uses the local Markdown index; it does not scan or decompress the remote repository.
- Compression and SSH run outside the Electron renderer.

## Atomic migration

Writers retain the repository lock and temporary-file hash verification. A complete migration uploads content-addressed objects and every `.json.gz` note first, then publishes `notes/index.json` last. Readers select v3 paths only when the committed index declares version 3. Interrupted pre-commit migrations therefore continue to read the intact v1 repository.

Electron reads v1/v2/v3 and performs the complete v3 migration. Android reads and writes v1/v2 until it observes a committed v3 index, then preserves v3 and writes Markdown envelopes and content-addressed resources.

The verified pre-migration archive must be retained until Electron-to-Android round-trip, history restore, mixed image rendering, and repository-size checks all pass. Obsolete v1 note files and attachment paths may only be removed afterward.

## Resource collection

An object is live while referenced by any current note, any retained history entry, or a migration backup. Garbage collection uses a grace period and produces a recovery manifest before deletion; objects are never deleted during ordinary sync.
