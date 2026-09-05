# Desktop diagnostics

Notebook Next keeps a small local JSON Lines log for diagnosing save, reload, renderer, sync, automation, and AI failures. Open **Settings → Diagnostics** to view recent entries, export the retained history, or reveal the active log in the system file manager.

Each entry includes its timestamp, app session, app version, operating system, CPU architecture, category, action, and status. Longer operations also include a correlation `operationId` and duration. Resource references contain only a resource type and a restricted identifier. Errors use the exception type, code, and up to five sanitized stack frames. Note titles, note bodies, raw URLs, credentials, authorization values, and server response bodies must not be recorded.

The active file is `notebook-next-diagnostics.jsonl`. It rotates before an incoming entry would make it exceed 2 MiB. One archive, `notebook-next-diagnostics.jsonl.1`, is retained, so the normal on-disk maximum is 4 MiB plus negligible filesystem metadata. The export includes every valid entry in both retained files; the in-app list remains capped at 500 recent entries for responsive display. Diagnostic writes use a bounded queue and fail open: inability to write this log never blocks saving, synchronization, reload, or shutdown.

Electron normally places the log under these directories for the packaged `Notebook Next` app:

| System | Default directory |
| --- | --- |
| macOS | `~/Library/Logs/Notebook Next/` |
| Windows | `%APPDATA%\Notebook Next\logs\` |
| Linux | `~/.config/Notebook Next/logs/` |

The exact directory can vary with packaging or environment configuration. **Reveal log** is authoritative for the running installation.

Common error codes include:

| Code | Typical meaning |
| --- | --- |
| `ENOSPC` | The local disk or quota is full. |
| `EACCES`, `EPERM` | The app cannot write the selected directory. |
| `ETIMEDOUT` | A network or renderer flush operation exceeded its deadline. |
| `ECONNRESET` | A server or proxy reset the connection. |
| `ENOTFOUND`, `ERR_NAME_NOT_RESOLVED` | DNS could not resolve the server name. |
| certificate or TLS codes | The server certificate, trust chain, or TLS connection failed. |

For a save or reload problem, look for events with the same `operationId`: `storage/renderer-flush` records the durable-save handshake, and `lifecycle/renderer-reload` records the reload boundary. For WebDAV, `sync/webdav-*` events reuse the request ID across start and completion. A `failed` event with no message is intentional; use its error type, code, sanitized frames, action, timing, and neighboring events rather than expecting raw exception text.
