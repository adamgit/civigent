# Knowledge Store

A collaborative knowledge management system where humans and AI agents co-author markdown documents with full version history, conflict-free concurrent editing, and section-level locking.

## Quick start (end users)

See [`quickstart/README.md`](quickstart/README.md). You need Docker and three files.

## Development

This is dual-configured to run a dev-environment as:
 1. EITHER: a fully preconfigured DevContainer (works in Cursor, VSCode - RECOMMENDED)
 2. OR: a preconfigured development Docker container (works in all systems, less seamless)

### Prerequisites

- Docker and Docker Compose
- (Optional, Recommended) VS Code with the Dev Containers extension

### Option A: VSCode devcontainer

Open the repo in VS Code → "Reopen in Container" when prompted.

Same environment, with full IDE integration.

Run development stack with one command:

```bash
npm run dev
```

What this does:
- Initializes `/workspace/dev-data` from `sample-wiki` if needed
- Starts backend (`PORT=3000`) using `KS_DATA_ROOT=/workspace/dev-data`
- Starts frontend Vite dev server (`PORT=5173`) proxying to backend

Optional overrides:
- `PORT=3100 npm run dev` (move backend port)
- `DEV_DATA_ROOT=/workspace/other-data npm run dev` (different local data root)
- `npm run dev:single-user` (quick local single-user auth mode)
- `KS_USER_NAME="Local User" KS_USER_EMAIL="local-user@ks.local" npm run dev:single-user` (custom single-user identity)

Frontend: `http://localhost:5173` (Vite, hot reload)  
Backend API: `http://localhost:3000` (Node.js, hot reload)

Single-user mode is opt-in for local testing/trials only; default remains non-single-user auth mode.

### Option B: docker dev-environment

```bash
git clone https://github.com/adamgit/civigent.git
cd civigent
docker compose up
```

Single-user mode with docker dev stack (optional):

```bash
KS_AUTH_MODE=single_user docker compose up
```

Frontend: `http://localhost:5173` (Vite, hot reload)
Backend API: `http://localhost:3000` (Node.js, hot reload)

Source is bind-mounted — edit files on your host, changes reflect immediately.

### OPTIONAL: /snapshot/ mount

Assembled on-demand or periodically from content that lives elsewhere (skeletons + sections). It should never be edited directly. It doesn't need to be backed up or version-controlled. It can be regenerated from scratch at any time.

The snapshot is a real folder on the host, browsable and mountable (e.g. in Obsidian as a standalone (read-only) wiki), but it's visually and structurally separate from the source of truth. If you delete it, the app regenerates it.

If you never mount it, the app either uses a tmpfs or a named volume internally — it is effectively ignored/disabled.

### OPTIONAL: /import/ mount for content import

To import existing markdown files on first startup, the system checks: if `/import` exists and `content/` is empty, it automatically imports all `.md` files into the Knowledge Store format (skeleton + sections).

**Using sample-wiki as import source:**

In development, sample-wiki can be used two ways:

1. **Demo mode** (default in `compose.yaml`): `./sample-wiki:/app/data` — use sample content as-is
2. **Template mode**: Import sample-wiki to get a modifiable copy — mount it at `/import:ro` instead of `/app/data`

### Project structure

```
knowledge-store/
├── frontend/               React app (Vite + TypeScript)
│   └── Dockerfile          Multi-stage: dev / build / prod (nginx)
├── backend/                Node.js API (Express/Fastify + git)
│   └── Dockerfile          Multi-stage: dev / build / prod
├── sample-wiki/            Seed data used in development
│   ├── content/            Example skeleton + section files
│   ├── proposals/          Example completed proposal
│   └── drafts/
├── quickstart/             End-user deployment files
│   ├── compose.yaml
│   ├── .env.example
│   └── README.md
├── .devcontainer/          VS Code devcontainer config
├── compose.yaml            Dev compose (used by devcontainer + CLI)
└── README.md               This file
```

### Running tests

Tests use [Vitest](https://vitest.dev/) and run inside whichever container environment you're using.

**From inside the devcontainer:**

```bash
npm test                              # all packages
npm test -w @ks/backend               # backend only
npm test -w @ks/frontend              # frontend only
npm run test:watch -w @ks/backend     # watch mode (re-runs on save)
```

**From outside, via Docker Compose:**

```bash
docker compose exec backend npm test
docker compose exec frontend npm test
docker compose exec backend npm run test:watch    # watch mode
```

See [`TRANSIENT WORKING DOCS/official-testing-design.md`](TRANSIENT%20WORKING%20DOCS/official-testing-design.md) for the full testing design.

## Architecture

See [`DESIGN.md`](DESIGN.md) for the full system design.

## License

See LICENSE