# Civigent

A collaborative wiki where humans and AI agents co-author markdown documents in real time.

Civigent solves the problem of humans and AI agents editing the same content simultaneously. Instead of locking or last-write-wins, it uses continuous human-involvement scoring to protect human work from agent overwrites while letting agents work freely on uncontested sections. The result: humans and agents collaborate on the same documents without stepping on each other.

* It is **AI Native** providing MCP-first access in the backend that gives Agents all the tools they need to operate and collaborate with humans.
* It is **Human Native** providing a modern UI for humans to collaboratively edit docs together in realtime, and see what the AI Agents are doing/planning/changing.

Powerful uses include:
1. Control a swarm of agents more easily via a large number of documents, instead of manually via Chat sessions and text files
2. (meta) Store an Agent's own internal Memory.MD files in Civigent, letting you peek into its brain and control its actions and thinking effortlessly (works for any agents that use Markdown as their internal format)
3. Allow a swarm of agents to collaborate with your existing human teams on editing business documents across your organization - but with strong governance controls on Agent activity

## Status

This is the first public release. It has been extensively tested and is in use by some small orgs, but there are probably significant bugs - use with caution.

## Key features

- **Real-time collaborative editing** — CRDT-based (Yjs) with per-section Milkdown editors, multi-tab support via SharedWorker
- **Human-involvement scoring** — continuous decay function protects recently-edited human content from agent overwrites, with admin-configurable presets (30s to 8h)
- **Proposal workflow** — agents submit proposals that are evaluated per-section; blocked sections can be justified or reworked
- **Full audit log** — every change is a git commit with writer attribution and semantic chunking
- **MCP agent support** — three tiers of MCP tools, from simple filesystem-style reads/writes to full proposal-based collaboration
- **No database** — all state lives on the filesystem (content, sessions, proposals, auth). An `ls` shows the complete system state.

## Quick start (end users)

You don't need the source code. Civigent is distributed as a Docker image — just grab the `quickstart/` folder from a release, or download the files directly, and follow the steps below. For more options/alternatives, see the [Quickstart Guide](docs/quickstart.md)

Briefly:

1. Copy the `quickstart/` folder to anywhere on your machine
2. `cp .env.example .env` and edit the minimal items: your name + email (optional but will be used in the Audit Log to store the history of who edited which files)
3. `docker compose up`

Open **http://localhost:8080**. Docker pulls the image automatically. See the [Quickstart Guide](docs/quickstart.md) for full details.

## Documentation

Full documentation is in the [`docs/`](docs/) folder:

| Guide | Audience | Description |
|-------|----------|-------------|
| [Quickstart](docs/quickstart.md) | Everyone | Get running in under 5 minutes |
| [Key Concepts](docs/concepts.md) | Everyone | Sections, proposals, human/agent collaboration |
| [Editing Guide](docs/editing-guide.md) | Everyone | The editing experience |
| [Deployment](docs/deployment.md) | Admins | Docker setup, data directory, env vars, reverse proxy |
| [Configuration](docs/configuration.md) | Admins | Involvement presets, snapshots, auth modes |
| [Agent Management](docs/agent-management.md) | Admins | OAuth, anonymous vs pre-auth agents, MCP tools |
| [Architecture](docs/architecture.md) | Developers | Five-layer data model, proposal FSM, scoring, storage |
| [Testing](docs/testing.md) | Developers | Test organization and patterns |
| [Error Handling](docs/error-handling.md) | Developers | Error philosophy and patterns |

## Development

For contributors working on the Civigent source code.

### Prerequisites

- Docker and Docker Compose
- (Recommended) VS Code or Cursor with the Dev Containers extension

### Option A: DevContainer (recommended)

Open the repo in VS Code/Cursor and "Reopen in Container" when prompted. This gives you a full development environment with all dependencies pre-installed.

To build and run your local changes:

```bash
npm run dev:single-user
```

This starts the backend (port 3000) and frontend Vite dev server (port 5173) with hot reload from your local source. Multi-user auth mode is available but requires OIDC configuration — single-user is the default for development.

### Option B: Docker Compose (no IDE integration)

```bash
git clone https://github.com/adamgit/civigent.git
cd civigent
KS_AUTH_MODE=single_user docker compose up
```

Frontend: http://localhost:5173 | Backend API: http://localhost:3000

Your local source files are bind-mounted into the containers, so edits you make on your host are reflected immediately without rebuilding.

### Running tests

```bash
cd backend && npm test       # backend
cd frontend && npm test      # frontend
```

## Core maintainers

To trigger the GHCR auto-build of the public Docker container:

```bash
git fetch origin && git push origin origin/main:releases
```


## License

See LICENSE
