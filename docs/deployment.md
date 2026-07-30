# Deployment Guide

How to deploy Civigent for your team or organization.

---

## How to run Civigent

There are four ways to run Civigent. Each targets a different use case and exposes a different external port for web users.

### Production / evaluation / personal use

| Method | Launch command | User connects to | Notes |
|--------|---------------|-----------------|-------|
| **Quickstart (pre-built image)** | `docker compose up` from `quickstart/` | `http://localhost:${PORT}` (default **8080**) | Single container. Backend serves both API and frontend static files. Recommended for most users. |
| **Self-built Docker** | `docker compose up` from repo root | `http://localhost:5173` (frontend) | Two containers: backend on 3000, frontend Vite dev server on 5173. Frontend proxies API calls to backend. Useful for testing local changes before publishing an image. |

### Development / contributing

Before native dev or tests from a git checkout, install dependencies in **`sharedlibs/milkdown-serializer`** first (required for backend imports), then **`backend`** and **`frontend`**. See the root **README** (“First-time dependency install”). Skipping the serializer install causes missing-module errors when the backend starts.

| Method | Launch command | User connects to | Notes |
|--------|---------------|-----------------|-------|
| **Native dev** | `npm run dev` (runs `devtools/dev.sh`) | `http://localhost:5173` (frontend) | No Docker. Backend on port 3000 (configurable via `PORT`), frontend Vite dev server on 5173. Hot-reload on both. |
| **DevContainer** | Open in VS Code / Cursor / etc | IDE specific but usually `http://localhost:5173`  | VS Code auto-detects and forwards ports. The actual external port is assigned by the IDE and may differ from the internal port. Run the same dependency installs inside the container once. |

### Key differences

- **`KS_OIDC_PUBLIC_URL`** must match whatever URL users actually see in their browser. When not set explicitly, the server auto-derives it from `KS_EXTERNAL_HOSTNAME` + `KS_EXTERNAL_PORT` (both set automatically by the compose files). For custom domains or reverse proxy setups, set `KS_OIDC_PUBLIC_URL` explicitly.
- **The quickstart container listens internally on port 3000** but the compose file maps it to the host port `${PORT:-8080}`. The internal port and the external port are different numbers in this setup.
- **In dev modes (native + dev compose)** the backend port (3000) is exposed but only the frontend port (5173) is user-facing. The backend port is only used for the Vite proxy and direct API testing.
- **Users never connect directly to the backend.** In quickstart mode the backend serves the frontend statically; in all other modes a Vite dev server on port 5173 serves the frontend and proxies API requests to the backend.

---

## Auto-start on server boot (Ubuntu)

To have Civigent start automatically when your server boots, configure Docker and a systemd service.

### 1. Enable Docker to start on boot

```bash
sudo systemctl enable docker.service
sudo systemctl enable containerd.service
```

### 2. Add restart policy to compose.yaml

In your `quickstart/compose.yaml`, add `restart: unless-stopped` to the service so Docker itself will restart the container if it crashes:

```yaml
services:
  civigent:
    restart: unless-stopped
    # ... rest of your config
```

### 3. Create a systemd service

Create `/etc/systemd/system/civigent.service` (replace the two placeholders marked with `[ ]`):

```ini
[Unit]
Description=[your Civigent instance name]
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=[path to your quickstart/ folder]
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
ExecReload=/usr/bin/docker compose up -d
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

### 4. Enable the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now civigent.service
```

The `--now` flag starts it immediately without a reboot. From this point on, Civigent will start automatically on boot and restart if Docker restarts it.

**Useful commands:**
```bash
sudo systemctl status civigent   # check if it's running
sudo systemctl stop civigent     # stop without disabling auto-start
sudo systemctl start civigent    # start again
journalctl -u civigent -f        # follow logs
```

---

## Deployment scenarios

### Scenario A: Personal use on your own machine

**Profile:** Single user, one laptop, multiple AI agents.
**Deployment method:** Quickstart (pre-built image) in single-user mode — `docker compose up` from `quickstart/`.

This is the simplest deployment. Use the [Quickstart guide](quickstart.md) — it covers everything you need. Enable 'single_user' mode to disable the complex authentication / external auth etc.

**Key settings:**
```env
KS_AUTH_MODE=single_user
KS_USER_NAME=Your Name
KS_USER_EMAIL=you@example.com
```

No public URL, no OIDC, no agent keys needed. OAuth auto-approves for agents. Any agent running on your local machine can self-register.

---

### Scenario B: Team server with a domain

**Profile:** Multiple humans, multiple agents, accessible over the network.
**Deployment method:** Quickstart (pre-built image) in multi-user mode, behind a reverse proxy, or self-built Docker for customised builds.

The server runs on a cloud host or on-premises machine with a domain name (e.g., `https://wiki.company.com`).

**Required configuration:**

```env
# The URL where users and agents reach this server (REQUIRED)
KS_OIDC_PUBLIC_URL=https://wiki.company.com

# JWT signing secret (REQUIRED — generate with: openssl rand -hex 32)
KS_AUTH_SECRET=<your-generated-secret>
```

**Getting started:** Copy the `quickstart/` folder from the release, then edit the `.env` file to add the settings above. The provided `compose.yaml` and `.env.example` contain the base Docker configuration, including a host-visible `./snapshots/` cache outside `wiki-data/`.

```bash
cp .env.example .env
mkdir -p wiki-data snapshots
# Edit .env with your settings, then:
docker compose up
```

With plain Docker bind mounts, `wiki-data/` and `snapshots/` must both exist on the host first and must be writable by the container process.

### Scenario C: Enterprise with network-gated agents

**Profile:** Team server where the network itself provides agent authentication (VPN, internal network).
**Deployment method:** Same as Scenario B (quickstart or self-built), with additional env var configuration.

**Optional:** Relax the agent auth policy

On a public (non-localhost) hostname the default policy is `confidential`: agents must be admin-created and present a `client_secret` at the token endpoint. When the network itself gates access (VPN, internal network), you can relax this to allow anonymous self-registration:

```env
KS_AGENT_AUTH_POLICY=open
```

Or keep self-registration but require a signed-in human to approve each agent's first connection in the browser (not compatible with `KS_AUTH_MODE=single_user`):

```env
KS_AGENT_AUTH_POLICY=approve
```

The removed `register` / `verify` values refuse startup. See [Authentication — Agent auth policy](authentication.md#agent-authentication-policy) for details on all three levels and migration notes.

---

## Startup validation

The server validates its configuration at startup and refuses to start if critical settings are missing:

| Condition | Result |
|-----------|--------|
| Multi-user mode without `KS_OIDC_PUBLIC_URL` | **Refuses to start** with instructions |
| Multi-user mode without `KS_AUTH_SECRET` | **Refuses to start** with instructions |
| Missing `KS_EXTERNAL_PORT` (any mode) | **Refuses to start** — running outside a compose environment is not supported. Both compose files set this automatically. |
| Single-user mode without `KS_OIDC_PUBLIC_URL` | Auto-derives from `KS_EXTERNAL_HOSTNAME` + `KS_EXTERNAL_PORT`. Scheme is `https` for non-localhost hostnames, `http` for localhost/127.0.0.1. Port omitted for standard ports (80/443). Set `KS_OIDC_PUBLIC_URL` explicitly to override. |
| Single-user mode without `KS_AUTH_SECRET` | Uses development default (acceptable for localhost) |

---

## Tuning behavior

Once the server is running, see the [Configuration Reference](configuration.md) for:

- **Human-involvement presets** — control how long human edits protect sections from agent overwrites (`yolo` / `aggressive` / `eager` / `conservative`)
- **Hard block conditions** — conditions that always block agents regardless of preset
- **Snapshot configuration** — enable pre-assembled document snapshots for external tools
- **Fatal-error policy** — `KS_FATAL_ERRORS_MODE` controls process behaviour on an invariant failure. Default `report` keeps the process alive and surfaces the error to every connected client over the app WebSocket (browser tabs show the fatal screen; a tab opened after the fatal still receives it on connect). Set `crash` to have the process exit so your orchestrator/supervisor can restart it. `report` accepts continued availability with the risk of further corruption after a fatal.
- **Admin API** — change presets and read system health programmatically

---

## Data directory, backup, restore, and import

See [Architecture Overview — Data directory structure](architecture.md#data-directory-structure) for the full directory layout.

For first-time import of existing markdown files, private Git remote backup, and whole-instance restore onto a virgin target, see [Backup, Restore, and Import](backup-restore.md). That guide covers:

- `IMPORT_CONTENT_FROM` — first-time import from a host directory of markdown files
- `KS_BACKUP_GIT_REMOTE` / `KS_BACKUP_GIT_AUTH_MODE` in `.env` (plus optional `KS_BACKUP_KNOWN_HOSTS_ENABLED=true` for host-key pinning), with the key — and, when pinning, the `known_hosts` file — under `./backup-secrets/` (`compose.yaml` mounts the folder and owns in-container credential paths)
- Restore onto a virgin target and the companion secrets (`KS_AUTH_SECRET`, `KS_AGENT_ANON_SALT`, OIDC) that must be copied separately

Backup and restore both run under a full-process lockdown that fences off new HTTP requests, WebSocket upgrades, and MCP tool calls for the duration. Git credentials never touch Civigent data, auth state, browser storage, or backup refs — the SSH key file, agent socket, and `known_hosts` file are all supplied by the deployment environment.

---

## Reverse proxy setup

If running behind nginx, Apache, or similar, ensure:

1. **WebSocket upgrade** is supported for `/ws` paths
2. **Proxy headers** are forwarded (`X-Forwarded-For`, `X-Forwarded-Proto`)
3. **`KS_OIDC_PUBLIC_URL`** matches the externally reachable URL (not the internal port)
4. **SSE responses** at `/api/system/events` are not buffered (set `proxy_buffering off` in nginx, or `X-Accel-Buffering: no` — only relevant in dev mode)

### Example nginx configuration

```nginx
server {
    listen 443 ssl;
    server_name wiki.company.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

---

## Docker details

### User/group ID

The container runs as the host UID/GID you specify (default: 1000). This ensures files in the mounted data directory are owned by your host user, and git commits have predictable authorship.

```yaml
user: "${UID:-1000}:${GID:-1000}"
```

### Git dependency

The backend container includes `git` because the audit log is stored as a private, internal, git repository. Git is initialized automatically on first startup.

Git is NOT used for anything else, and it is NOT a general git repository.

### Health check

The backend responds to `GET /` with:
```json
{ "service": "civigent-backend", "status": "ok" }
```

### Backend lifecycle SSE (dev only)

In development, a lightweight supervisor process (`dev-supervisor.ts`) sits between the public port and the real backend (`server.ts`). If the backend worker crashes, the supervisor stays alive and broadcasts a fatal error report to all connected browsers via SSE at `GET /api/system/events`. The frontend renders a full-page error screen with the stack trace.

This only applies to dev mode (`npm run dev`). Production deployments run `server.ts` directly — no supervisor, no SSE endpoint, no proxy overhead. Container restarts handle crash recovery in production.

---

## Snapshots (optional)

Snapshots are pre-assembled versions of documents — useful for external tools that need to read complete markdown without calling the API.

```env
KS_SNAPSHOT_ENABLED=true
```

In quickstart deployments, `compose.yaml` writes snapshots to `./snapshots/` on the host by default, using `KS_SNAPSHOT_ROOT` inside the container.

When using host bind mounts, manually create `wiki-data/` and `snapshots/` before first start and ensure both host folders are writable by the container process. If snapshot runs fail with `EACCES`, fix the host-folder permissions and retry.

If you need a different in-container snapshot path, set `KS_SNAPSHOT_ROOT` and update the snapshots bind mount in `compose.yaml` to match.

Snapshots are a **derived cache** — they can be regenerated from /content at any time. Don't include them in backups.

---

## What's next

- [Configuration Reference](configuration.md) — env var reference, involvement presets, snapshots, admin API
- [Backup, Restore, and Import](backup-restore.md) — first-time markdown import, private Git remote backup, and restore onto a virgin target
- [Agent Management](agent-management.md) — manage agent identities and access
- [Architecture Overview](architecture.md) — understand the system internals
