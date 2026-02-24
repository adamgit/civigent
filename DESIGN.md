# Knowledge Store — Design & Infrastructure

Handover document for implementation planning. Read alongside the full [Implementation Document](docs/implementation.md) for detailed specs.

---

## What This Is

A wiki-like system where humans and AI agents co-author markdown documents. The unique property is section-level concurrency — two writers can edit different sections of the same document simultaneously with zero conflicts and zero data loss.

## System Architecture

Two loosely coupled systems:

- **System A (Knowledge Store):** Document storage, versioning, collaboration, conflict resolution. React frontend + Node.js backend + git. This is where all complexity lives.
- **System B (Agent Orchestrator):** Task queue that runs LLM agents. Agents interact with System A exclusively through its API (MCP tools). Intentionally simple.

## Document Model

Documents are stored as a **skeleton file** (heading structure with `{{section: filename.md}}` markers) plus a **folder of section files** (one per section). This is the core design decision — it makes section-level reads, writes, locks, and conflict detection operate on independent files with no parsing or reassembly.

```
content/ops/sales/
├── strategy.md                      ← skeleton
└── strategy.md.sections/
    ├── target-market.md             ← section content
    ├── pricing.md
    └── outreach-process.md
```

A read-only **snapshot** cache assembles complete `.md` files for tools like Obsidian.

## Collaboration Model (Three Layers)

| Layer | Mechanism | Purpose | Required? |
|-------|-----------|---------|-----------|
| 1. Correctness | Optimistic concurrency with section-level snapshot validation | Guarantees no silent data loss | Toggleable |
| 2. Optimisation | Advisory section-level locks (mandatory-wait when enabled) | Reduces wasted work from rejections | Toggleable |
| 3. Intent | Work proposal registry | Coordination + audit trail | Required |

Every edit (human or agent) is associated with a **work proposal** that declares read dependencies and write targets. Writers work in isolated **draft folders** containing copies of only the section files they're modifying. At commit time, Layer 1 compares the draft manifest's snapshot content against live canonical files — if anything the writer read or wrote has changed, the commit is rejected and the writer must create a fresh proposal.

## Data Directory Structure

All state lives in a single directory (`wiki-data/` for end users, `sample-wiki/` in the dev repo):

```
wiki-data/
├── content/        ← skeletons + section folders (source of truth)
├── proposals/      ← inflight / complete / cancelled (audit trail)
│   ├── inflight/
│   ├── complete/
│   └── cancelled/
├── drafts/         ← per-writer isolated working copies (ephemeral)
└── .git/           ← atomic commits + version history
```

Snapshot cache is mounted separately (Docker volume by default, optional host bind-mount for Obsidian integration).

## Infrastructure

### Container Design

Single multi-stage Dockerfile per service (frontend, backend). Each has `dev`, `build`, and `prod` targets:

- **Dev:** Source bind-mounted, hot reload, dev dependencies available.
- **Prod:** Lean image, compiled assets only. Backend serves API; frontend is static files behind nginx which proxies `/api/` to the backend.

### Two Compose Files

| File | Audience | What it does |
|------|----------|--------------|
| `compose.yaml` (repo root) | Developers | Builds from source, bind-mounts code, hot reload, uses `sample-wiki/` |
| `quickstart/compose.yaml` | End users | Pulls published images from GHCR, mounts `wiki-data/` |

### Devcontainer

`.devcontainer/devcontainer.json` references the root `compose.yaml`. VS Code users get one-click setup; CLI users get the same environment via `docker compose up`.

### File Ownership

Quickstart compose uses `user: "${UID:-1000}:${GID:-1000}"` — no root needed at startup. The backend process runs as the configured UID, owns all files it creates, and git operates cleanly.

## Key Implementation Notes

1. **All writes go through the API.** Nothing touches the filesystem directly. This enables future backend swaps (Postgres, S3, etc.) without changing consumers.

2. **Git is the commit mechanism, not the conflict detector.** Conflict detection uses snapshot comparison in draft manifests. Git provides atomic multi-file commits and version history.

3. **No user-facing branches.** Git branches may be used internally as an alternative draft isolation implementation, but are never exposed.

4. **Snapshot is a derived cache.** It can be regenerated from content at any time. It is not part of the source of truth and should not be backed up or version-controlled (unless explicitly enabled by admin for git history readability).

5. **Proposals are never amended.** A rejected commit results in a new proposal with a new UUID. The old proposal is cancelled with rejection details.

6. **Human proposals are created on first keystroke** (not on file open) and are not auto-cancelled on browser close — only by explicit action, admin timeout, or admin intervention.

## What Needs Building

| Component | Stack | Notes |
|-----------|-------|-------|
| Backend API | Node.js + Express/Fastify | Section CRUD, proposal lifecycle, draft management, git operations, lock state (in-memory), snapshot generation |
| Frontend | React + TypeScript + Vite | Sidebar nav, markdown editor (pluggable: Milkdown/Tiptap/ProseMirror), proposal UI, lock visibility, activity feed |
| MCP tool interface | Node.js | Thin wrapper exposing API operations as MCP tools for agents |
| Agent orchestrator | Node.js or Python | Task queue, worker pool, webhook/schedule triggers — intentionally simple |
| CI/CD | GitHub Actions | Build + push images to GHCR on release |
