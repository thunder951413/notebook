# Notebook AI service

Python/FastAPI application service for provider-neutral chat streaming, semantic retrieval and cursor-based metadata synchronization. LiteLLM supplies the mature provider adapters; SQLAlchemy supports SQLite for local/self-hosted development and PostgreSQL-compatible deployments. API keys stay in service environment variables and are never persisted by the web renderer.

```bash
python -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/uvicorn notebook_ai.main:app --host 127.0.0.1 --port 8787
```

Production must set `NOTEBOOK_AI_API_TOKEN`; desktop development may keep the service bound to `127.0.0.1`.

## Reuse the legacy SSH/SFTP repository

The Electron desktop app connects to the old SSH repository directly. Choose
`旧版 SSH/SFTP` in Settings and enter the same host, port, user, password and
remote directory used by Android/Electron. It reads and writes `library.json`,
`notes/index.json`, note envelopes, reading positions, attachment manifests and
attachments with the legacy lock and atomic-write contract.

A normal browser cannot open an SSH socket. For the local browser build, start
the loopback-only helper together with the web app from the repository root:

```bash
./ctl start
```

Or run it manually:

```bash
NOTEBOOK_AI_ENABLE_LOCAL_SFTP_BRIDGE=true \
  .venv/bin/uvicorn notebook_ai.main:app --host 127.0.0.1 --port 8787
```

Never expose the local SFTP bridge on a public interface. It is disabled by
default, checks that both the HTTP host and client address are loopback, and can
also require `NOTEBOOK_AI_API_TOKEN`. In the browser, the SSH password is kept
only for the current tab session; Electron encrypts it with the OS credential
facility. The first successful connection records the server's SHA256 host-key
fingerprint. Verify that value before trusting the connection.

The web app and Android app use the same `/v1/sync/push`, `/v1/sync/pull` and
`/v1/sync/assets/{id}` contract. Set the same service URL, workspace ID and token
on both clients. For a hosted browser build, set `NOTEBOOK_AI_ALLOWED_ORIGINS` to
the exact HTTPS origins allowed to call the service, separated by commas. The
defaults only cover the packaged Electron renderer and local ports 5173/8057.

## Remote server with automatic HTTPS

The HTTPS API is an optional alternative for multi-user or browser-hosted
deployments. It is not required when all clients use the legacy SSH/SFTP mode.

1. Point a DNS A/AAAA record such as `notes.example.com` to the server and allow
   inbound TCP 80/443 in the host and cloud firewalls.
2. Install Docker Engine with the Compose plugin, then copy this directory to
   the server over SSH.
3. Copy `.env.example` to `.env`, set `NOTEBOOK_DOMAIN`, generate a token with
   `openssl rand -hex 32`, and set the allowed browser origins.
4. Start the stack and verify it:

```bash
docker compose up -d --build
curl https://notes.example.com/health
```

Caddy obtains and renews the TLS certificate automatically. The SQLite database
and uploaded attachment blobs live in the named `notebook-data` volume; include
that volume in server backups. In Notebook settings and Android's `Notebook Next`
mode, enter the same `https://notes.example.com`, workspace ID and API token.

If the server has no public domain/ports, use the SSH/SFTP mode on Electron and
Android. A standalone browser still needs the loopback helper above because web
sandboxing deliberately prevents direct SSH connections.
