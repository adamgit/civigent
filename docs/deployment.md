# Deployment Guide

How to deploy Civigent for your team or organization.

---

## Deployment scenarios

### Scenario A: Personal use on your own machine

**Profile:** Single user, one laptop, multiple AI agents.

This is the simplest deployment. Use the [Quickstart guide](quickstart.md) — it covers everything you need.

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

The server runs on a cloud host or on-premises machine with a domain name (e.g., `https://wiki.company.com`).

**Required configuration:**

```env
# The URL where users and agents reach this server (REQUIRED)
KS_PUBLIC_URL=https://wiki.company.com

# JWT signing secret (REQUIRED — generate with: openssl rand -hex 32)
KS_AUTH_SECRET=<your-generated-secret>

# OIDC provider for human login
KS_OIDC_ISSUER=https://auth.company.com/realms/main
KS_OIDC_CLIENT_ID=civigent
KS_OIDC_CLIENT_SECRET=<your-oidc-secret>
```

**Getting started:** Copy the `quickstart/` folder from the release, then edit the `.env` file to add the settings above. The provided `compose.yaml` and `.env.example` already contain all the Docker configuration — you only need to set your environment variables.

```bash
cp .env.example .env
# Edit .env with your settings, then:
docker compose up
```

### Scenario C: Enterprise with network-gated agents

**Profile:** Team server where the network itself provides agent authentication (VPN, internal network).

**Optional:** Disable 'anonymous AI Agents' 

Most deployments will restrict access at the network layer, and anonymous agents are safe. However for added security you can remove the 'anonymous' route and force all AI agents to be pre-authorized by an admin user in the admin pages:

```env
KS_AGENT_ANONYMOUS=false
```

---

## Startup validation

The server validates its configuration at startup and refuses to start if critical settings are missing:

| Condition | Result |
|-----------|--------|
| Multi-user mode without `KS_PUBLIC_URL` | **Refuses to start** with instructions |
| Multi-user mode without `KS_AUTH_SECRET` | **Refuses to start** with instructions |
| Single-user mode without `KS_PUBLIC_URL` | Auto-derives `http://localhost:${PORT}` |
| Single-user mode without `KS_AUTH_SECRET` | Uses development default (acceptable for localhost) |

---

## Data directory structure

All persistent state lives under a single data directory (mounted as `/app/data` in Docker):

```
wiki-data/
├── snapshots/            ← Pure markdown files, read-only, enabling any standard 3rd party tool to read the data
├── content/              ← Published content (canonical), markdown stored in a custom format
│   ├── .git/             ← Private audit-log of all changed to /content/
│   ├── document-name.md  ← Skeleton file (privately stored and maintained, you should never need to edit or view this raw)
│   └── document-name.md.sections/ (part of the custom internal markdown format)
│       ├── sec_abc123.md           ← Section content file
│       └── sec_abc123.md.sections/ ← Sub-sections (for nested headings)
│
├── sessions/             ← In-flight editing state (ephemeral, survives restarts)
│   ├── fragments/        ← Raw Y.Doc fragments (crash-safety layer, ~2s freshness)
│   ├── docs/             ← Canonical-ready session content (structurally valid)
│   │   └── content/      ← Mirrors canonical structure with dirty section overlays
│   └── authors/          ← Per-user attribution metadata (which user dirtied which sections)
│
├── proposals/            ← Agent and human proposals (filesystem = state machine)
│   ├── pending/          ← Active proposals (mutable)
│   ├── committing/       ← Being committed right now (transient, milliseconds)
│   ├── committed/        ← Successfully committed (terminal, audit trail)
│   └── withdrawn/        ← Cancelled proposals (terminal, audit trail)
│
│
└── auth/                 ← Authentication state
    └── agents.keys       ← Pre-authenticated agent credentials (optional)
```

### Backing up

The `content/` directory is the most important — it contains all published content and full git history. Back it up like any git repository.

The `proposals/` directory contains the audit trail of all proposals (committed and withdrawn). Back this up if you need audit compliance.

The `sessions/` directory is ephemeral — it's automatically cleaned up after commits and crash recovery. You don't need to back it up.

---

## Importing content

### First-time import from markdown files

Set `IMPORT_CONTENT_FROM` to point at a directory of markdown files:

```env
IMPORT_CONTENT_FROM=/path/to/your/markdown
```

The import runs **once** on first startup when the content directory is empty. After that, it's skipped automatically (idempotent).

### Import behavior

- Each `.md` file becomes a document
- An atomic staging pattern ensures partial imports don't corrupt data

### Import rules

- **Case-insensitive duplicate detection**: Two headings at the same level with the same name (even different capitalization) cause the file to fail
- **`.importignore` support**: Place a `.importignore` file in the source directory to exclude files/folders (gitignore-style patterns: `*.obsidian/`, `node_modules/`, `.git/`)
- **Read-only mount**: The import source is mounted read-only (`/import:ro`) — your original files are never modified

### Import summary

The server logs a summary after import:
```
Import complete: 150 imported, 0 failed, 0 skipped
```

If files fail (e.g., duplicate headings), the summary includes error details per file.

---

## Reverse proxy setup

If running behind nginx, Apache, or similar, ensure:

1. **WebSocket upgrade** is supported for `/ws` paths
2. **Proxy headers** are forwarded (`X-Forwarded-For`, `X-Forwarded-Proto`)
3. **`KS_PUBLIC_URL`** matches the externally reachable URL (not the internal port)

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

---

## Snapshots (optional)

Snapshots are pre-assembled versions of documents — useful for external tools that need to read complete markdown without calling the API.

```env
SNAPSHOT_ENABLED=true
```

To expose snapshots on the host filesystem, use the provided `compose.snapshot.yaml` overlay:

```bash
docker compose -f compose.yaml -f compose.snapshot.yaml up
```

You can set `SNAPSHOT_DIR` in your `.env` to control where snapshots appear on the host.

Snapshots are a **derived cache** — they can be regenerated from /content at any time. Don't include them in backups.

---

## Environment variable reference

### Required for production

| Variable | Purpose | Example |
|----------|---------|---------|
| `KS_PUBLIC_URL` | URL where the server is reachable by users and agents | `https://wiki.company.com` |
| `KS_AUTH_SECRET` | JWT signing secret (generate with `openssl rand -hex 32`) | `a1b2c3...` |
| `KS_OIDC_ISSUER` | OIDC provider URL | `https://auth.company.com/realms/main` |
| `KS_OIDC_CLIENT_ID` | OIDC client ID | `civigent` |
| `KS_OIDC_CLIENT_SECRET` | OIDC client secret | `secret-value` |

### Optional

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Port the server listens on inside the container | `3000` |
| `KS_AUTH_MODE` | Set to `single_user` for personal use | (multi-user) |
| `KS_USER_NAME` | Human display name (single-user mode) | `Local User` |
| `KS_USER_EMAIL` | Human email (single-user mode) | `local-user@ks.local` |
| `KS_USER_ID` | Human ID override (single-user mode) | (auto-generated) |
| `KS_AGENT_ANONYMOUS` | Allow anonymous agent self-registration | `true` |
| `KS_AGENT_ANON_SALT` | Salt for signing anonymous agent tokens (change to revoke all) | (auto-generated) |
| `IMPORT_CONTENT_FROM` | Path to markdown files for initial import | (none) |
| `SNAPSHOT_ENABLED` | Enable assembled document snapshots | `false` |
| `KS_IMPORT_ROOT` | Override import mount path inside container | `/import` |

---

## What's next

- [Configuration Reference](configuration.md) — tune involvement presets and admin settings
- [Agent Management](agent-management.md) — manage agent identities and access
- [Architecture Overview](architecture.md) — understand the system internals
