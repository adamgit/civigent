# Architecture Overview

Technical overview of Civigent's internals for contributors and power users.

---

## Design philosophy

Civigent is built on three core principles:

1. **Continuous shared situational awareness** — Every actor's attention is visible as a continuous signal. Coordination emerges from visibility, not from explicit locking protocols.

2. **Enforcement is the last resort** — Smart actors (humans and agents) self-coordinate when they can see the state of the system. Hard blocks exist only for the cases where self-coordination fails.

3. **Asymmetric actor economics** — Human work is expensive and irreplaceable. Agent work is cheap and regenerable. The system protects human content from agent overwrites but does not protect agent content from other agents ("last committed wins").

---

## Five-layer data architecture

Data flows through five layers from disk to the browser editor:

```
Layer 1: Canonical Store / Audit log (disk + git)
    ↑ commit / ↓ read
Layer 2: Session Overlays (disk)
    ↑ flush / ↓ reconstruct
Layer 3: Y.Doc (in-memory CRDT)
    ↑↓ sync
Layer 4: WebSocket Transport
    ↑↓ binary messages
Layer 5: Browser Editors (Milkdown)
```

### Critical abstraction classes

The data architecture is innovative and concise, underpinning many of the core features of the app. Details matter. To make sure implementers and downstream classes never make mistakes, we have centralised the core data architecture into a small number of elegant, encapsulated, classes that provide simple abstractions over the architecture. All code must use these and avoid ever directly editing data.

#### DocumentSkeleton

Owns the heading tree structure of a document: which sections exist, how they nest, and where their body files live on disk. All heading paths, section file paths, and tree structure derive from it. Abstracts the recursive skeleton-file / sub-skeleton / root-child disk format so callers never reason about `.sections/` directories or `{{section:}}` markers directly.

#### ContentLayer

Owns reading and writing section body content against a content root directory. Resolves `(docPath, headingPath)` to a file path via DocumentSkeleton, enforces the body-only invariant (strips heading lines), and supports overlay-first-then-canonical chaining for proposal/session reads. All durable section content I/O outside of CRDT sessions goes through this class.

#### FragmentStore

Owns the Y.Doc ↔ disk boundary for a single document's CRDT editing session. Pairs a Y.Doc (in-memory CRDT fragments) with a DocumentSkeleton, and is the sole owner of the dual-write pattern: raw fragments for crash safety, canonical-ready body files for REST/commit readiness. Handles structural normalization (splitting, renaming, merging sections) when users edit headings inline. Writes body files directly (not via ContentLayer) because it already owns the resolved skeleton and has already stripped headings — re-resolving per write would be redundant I/O on a hot path.

### Layer 1: Canonical store / Audit log

The core content of all documents, with a private (internal) git repository that provides an Audit Log of all changes to all documents.

Changes to the canonical store are generally semantic chunks - i.e. not just individual edits, but materially significant multi-document / multi-paragraph edits that represent a single 'piece of work'.

It is not possible to 100% guarantee the chunking, but AI Agents are forced to do it, and humans are able to precisely do it (using Proposals), or the system automatically guesses for humans what the semantic chunks are (via Sessions).

Experimental: we have a non-public branch that uses an LLM internally (e.g. via API to OpenAI/Anthropic) to replace the heuristics on human edits, giving us 100% 'every audit-log change has a clear stated reason'. This requires using an LLM, greatly increasing the running costs (and reducing performance) so it is currently NOT part of the core design

#### Detailed Structure: private, internal, may change in future

Presented publically as plain standard markdown files, but internally (privately) stored as exploded sections, one file per markdown-section, allowing for simpler implementations of most algorithms.

DocumentSkeleton.ts provides an abstraction over all this, allowing us to change in future if desired.

**Structure on disk:**
```
content/
├── .git/                          ← Full version history
├── my-document.md                 ← Skeleton file
└── my-document.md.sections/
    ├── sec_abc123.md              ← Section body content
    └── sec_abc123.md.sections/    ← Nested sub-sections
        └── sec_def456.md
```

**Skeleton files** contain `{{section: filename.md}}` markers instead of inline content. This separates structure from content, enabling section-level operations.

**Section files** can themselves be sub-skeletons (containing their own `{{section:}}` markers with their own `.sections/` directory). This recursive structure represents arbitrarily deep heading hierarchies.

When a section gains sub-headings, its file becomes a sub-skeleton and a **root child** entry (level=0, heading="") is prepended to hold the parent's body content.

`DocumentSkeleton` is the single in-memory model that reads this recursive structure and provides tree, flat, and resolve views. It is the **canonical source of section identity** — all heading paths, file paths, and tree structure derive from it.

**Empty-skeleton tombstone convention:** A skeleton file with zero entries signals document deletion in any overlay context (proposals, sessions). When `promoteOverlay()` encounters an empty skeleton, it deletes all canonical files for that document (skeleton, `.sections/` directory, section body files) rather than writing an empty file. Document rename is decomposed as: tombstone at old path + full copy at new path — reusing overlay-first read semantics with no new read logic. This ensures ALL document mutations (content edits, section structural changes, document deletion, document renaming) are expressible as skeleton + section file state in an overlay directory. No operation requires metadata, sentinels, or out-of-band state.

### Layer 2: Session overlays

Ephemeral files representing in-flight edits that haven't been collated into semantic bundles, haven't been added to the audit-log yet.

Layer2 is the intersection between CRDT (human-centric, live collaborative editing in-browser) and our on-disk backend/audit log (data-centric, clean, simple pure data).

**Two parallel formats:**

We have one format that mirrors Layer1 and one that mirrors Layer3. This enables Layer2 to be the gateway/translation between the two layers cleanly. Note that the transformation is **not** purely data-format: it often requires executing structural changes to documents, splitting/merging, moving sections, renaming docs, etc -- so Layer2 is non-trivial.

| Format | Location | Purpose | Freshness |
|--------|----------|---------|-----------|
| **Raw fragments** | `sessions/fragments/` | Crash-safety layer. One file per dirty Y.XmlFragment. Verbatim markdown (may contain embedded headings during structural edits). | ~1-2 seconds |
| **Canonical-ready** | `sessions/docs/content/` | Structurally valid session content. Mirrors canonical structure. Used by REST APIs and commit pipeline. | Written on flush when clean, or after normalization. |

**Author metadata** (`sessions/authors/{writerId}.json`): Tracks which user dirtied which sections. Used by the Mirror panel and auth-log attribution. Per-user, not per-session.

The overlay-first pattern: when reading content, the system checks `sessions/docs/content/` first, then falls back to `content/`. This ensures page reloads show unpublished changes.

### Layer 3: Y.Doc (in-memory CRDT)

One `Y.Doc` per document, containing one `Y.XmlFragment` per section.

**Fragment naming:** this is an internal detail.

**Lifecycle:**
- Created when the first editor connects to a document
- Destroyed when the last editor disconnects (after flush + normalize + commit)
- Survives commits (the Y.Doc stays alive, `baseHead` is updated)
- Reconstructed from disk on reconnect (prefers raw fragments, falls back to overlay+canonical)

**DocSession tracks:**
- `holders`: Set of connected writer IDs
- `sectionFocus`: Map of writerId → heading path (drives editingPresence and agent blocking)
- `perUserDirty`: Which user dirtied which fragments (for Mirror panel)
- `fragmentFirstActivity` / `fragmentLastActivity`: Activity timestamps per fragment
- `baseHead`: Git HEAD SHA when session was created

### Layer 4: WebSocket transport

Binary protocol over `/ws/crdt/{docPath}` with 9 message types:

| Code | Name | Direction | Purpose |
|------|------|-----------|---------|
| 0x00 | SYNC_STEP_1 | Bidirectional | Y.js sync initiation |
| 0x01 | SYNC_STEP_2 | Bidirectional | Y.js sync response |
| 0x02 | YJS_UPDATE | Bidirectional | Y.js incremental update |
| 0x03 | AWARENESS | Bidirectional | Presence/cursor data |
| 0x04 | SESSION_FLUSHED | Server→Client | Confirms which fragments were saved |
| 0x05 | SECTION_FOCUS | Client→Server | Reports which section the user is editing |
| 0x06 | SESSION_FLUSH_STARTED | Server→Client | Signals flush I/O in progress |
| 0x07 | ACTIVITY_PULSE | Client→Server | Keep-alive for active editing (~2-3s debounced) |
| 0x08 | STRUCTURE_WILL_CHANGE | Server→Client | Structural normalization notification |

### Layer 5: Browser editors

Per-section Milkdown editors: this enables us to render custom UX on each section (e.g. who last edited, different colors for sections that are locked by an in-progress proposal, etc).

The choice to mount a separate Milkdown editor per-section enables most of the human-centric features, but requires considerable work to translate CRDT into the main system.

---

## Proposal lifecycle (FSM)

Proposals are the mechanism for all content changes. The filesystem **is** the state machine — each state is a directory, and transitions are file moves.

```
Agent/Human creates proposal
  │
  └─► proposals/pending/{id}/        (Pending — mutable)
       │
       ├─► Agent modifies via PUT    (stays in pending/)
       │
       ├─► Agent/Human commits
       │     │
       │     ├─► All sections pass
       │     │     └─► proposals/committing/{id}/  (transient, milliseconds)
       │     │           └─► proposals/committed/{id}/  (terminal)
       │     │
       │     └─► Some sections blocked
       │           └─► stays in pending/
       │
       └─► Agent/Human cancels
             └─► proposals/withdrawn/{id}/  (terminal)
```

**States:**

| State | Mutable? | Directory | Meaning |
|-------|----------|-----------|---------|
| `pending` | Yes | `proposals/pending/` | Active. Agent can modify sections, add justifications. |
| `committing` | No | `proposals/committing/` | Writing to canonical + git. Transient (milliseconds). |
| `committed` | No | `proposals/committed/` | Successfully committed. Terminal. |
| `withdrawn` | No | `proposals/withdrawn/` | Cancelled. Terminal. |

**Key invariants:**
1. Experimental: currently only one pending proposal per writer (409 Conflict if violated)
2. No edits in non-pending states
3. Commit requires pending state
4. Human proposals override Agent proposals, but can still conflict with other Human proposals

---

## Indicators of human/agent activity

### editingPresence (server-authoritative)

"A user has an active CRDT session with sectionFocus on this section, or dirty session files exist."

- Drives agent blocking and human-involvement scoring
- Implemented via `MSG_SECTION_FOCUS` + `SectionPresence.check()`
- Never derived from Y.js Awareness

### viewingPresence (client-informational)

"A user is looking at this section."

- Drives cosmetic UI (colored dots, name badges)
- Carried via Y.js Awareness CRDT (`user.viewingSections`)
- Never used for agent gating or involvement scoring
- Signal source can change (editor focus, IntersectionObserver, mouse hover) without affecting backend correctness

### dirtyTracking (save status)

"This section has unsaved changes."

- Drives the blue/amber/green persistence dots
- Derived from Y.Doc `afterTransaction` fragment attribution
- Decoupled from both presence signals — a section can be dirty without being focused, and focused without being dirty

---

## Human-involvement scoring

The core conflict-prevention mechanism. Protects human-authored content from agent overwrites. Calculated per-section, per-document, as a continuous float from 0.0 (no recent human activity) to 1.0 (human actively editing).

### Why continuous, not binary

Every overwrite is contested in principle — someone authored the current content. But agent-authored content overwritten by another agent is not protected (agents are cheap to rewrite). The system only protects human work, and it does so as a **spectrum** rather than a lock/unlock binary. This enables nuanced decisions: an agent can overwrite a section a human touched 3 hours ago but not one touched 30 seconds ago.

### Decision policy: accept or block

- Score < 0.5 for all sections → **accepted**, auto-committed to canonical
- Score >= 0.5 for any section → **blocked**, proposal stays in pending state
- Pending human proposal on the section → **hard-blocked** (score = 1.0, regardless of decay)

### Justification bonus

Agents can provide a per-section justification explaining why they are overwriting. This reduces the involvement score by a fixed 0.1. A section at score 0.6 (blocked without justification) becomes 0.5 (accepted) with justification. This is most valuable with the Eager preset, where justification buys ~75 minutes of additional access.

### What humans see

Human-involvement scores are **not shown to regular human users** on the editing view. They are internal to the agent negotiation system. Humans can always edit freely regardless of scores. Scores are visible on the admin heatmap page and in agent proposal responses.

### Delivery mechanism

Scores are included in REST API responses (computed at request time) and polled for the heatmap view. They are not pushed via WebSocket — the decay is continuous, so pushing would mean either high-frequency updates or accepting staleness. Existing WS events (`presence:editing`, `presence:done`, `content:committed`) serve as hints for when to refresh.

---

## Content flush and commit pipeline

### Content flush (frequent, almost realtime)

Triggered by user typing/editing, or by timer, disconnect, or shutdown. This is the main autosave.

1. Write raw fragments to `sessions/fragments/` (always — crash safety)
2. If structurally clean (no embedded headings), also write canonical-ready to `sessions/docs/content/` ... otherwise the write to `sessions` is done by the later Normalization stage (see below)
3. Send SESSION_FLUSHED to connected clients (triggers green dots)
4. Update author metadata in `sessions/authors/`

### Structural normalization (event-driven)

Required because: humans can insert new sections into existing sections while editing; we need to detect that, process it, alter the stored data. While a human is typing the new section name we would waste performance continually re-doing the structural changes - so we instead delay structural normalization until we're confident the human has finished, giving them fast typing performance and preserving the system integrity.

Detects embedded headings in fragments and splits them into proper sub-sections.

**Triggered by:**
- Focus change - they've finished editing/renaming sections (user leaves a section with embedded headings)
- Idle timeout (60s without cursor movement)
- Disconnect (all fragments with embedded headings)
- Manual publish

**Never runs mid-edit** — fires only after the user has in some sense 'finished' or 'moved away'.

**Important:** `normalizeStructure()` mutates the Y.Doc in memory — it does not write to disk directly. Disk writes happen on the next content flush.

### Auth-log commmits / semantic chunking

Runs when human indicates a set of related edits have been performed, or (as fallback) on various heuristic catch-alls: e.g. after session destruction, manual publish, shutdown, or crash recovery.

1. Read dirty sections from `sessions/docs/content/`
2. Compare against canonical
3. Write changed sections to canonical `content/`
4. Make git commit (with writer attribution)
5. Delete committed files from both `sessions/docs/` and `sessions/fragments/`
6. Update author metadata — remove committed sections

### Proposal commit (agent or human)

1. Evaluate human-involvement per section (skipped for human proposals)
2. Move proposal file from `proposals/pending/` to `proposals/committing/` — the file move IS the lock
3. Write sections to canonical
4. Git commit with proposal metadata
5. Move proposal file to `proposals/committed/` (terminal state)

---

## Crash recovery

On server start:

1. Scan `sessions/fragments/` (source of truth — always fresh within ~2s)
2. Normalize all fragments (resolve embedded headings)
3. Write results to `sessions/docs/content/`
4. Compare against canonical
5. Commit under "crash recovery" identity
6. Clean up all session files

**Data loss window:** ~2 seconds (the time between automatic flush cycles).

---

## Agent-reading detection

The system automatically detects when agents read content (because agents can only read via API) and broadcasts `agent:reading` events.

**Trigger endpoints:**
- `GET /api/documents/:docPath`
- `GET /api/documents/:docPath/sections`
- `GET /api/documents/:docPath/structure`

**Frontend behavior:** Time-decaying indicator per section ("Agent 'writer-bot' reading"), fading after 3-5 seconds. Debounced: max one signal per agent per section per 10-second window.

This is a **courtesy signal only** — it does not block reads, create state, or affect involvement scoring.

---

## Auth architecture

### Stateless by design

No database, no Redis, no session store. All auth state is either:
- In environment variables (secrets, OIDC config)
- In flat files under `data/auth/` that survive restarts (see RBAC section below)
- In stateless signed tokens (JWTs, anonymous `client_id` tokens, authorization codes)

### Three-file RBAC authorization model

JWT tokens carry identity only (`sub`, `type`, `display_name`, `email` — no role flags). Authorization is evaluated at request time against three flat files in `{data_root}/auth/`:

| File | Format | Purpose |
|---|---|---|
| `defaults.json` | `{ "read": "authenticated", "write": "authenticated" }` | System-wide default permission level |
| `roles.json` | `{ "<userUUID>": ["admin"] }` | User-role assignments |
| `acl.json` | `{ "<docPath>": { "read": "public" } }` | Per-document permission overrides (sparse) |

All three files are cached in-memory; cache is invalidated immediately after any write. An absent file is treated as empty (no entries). Operators can delete a file to recover from corruption.

**Admin bootstrap by auth mode:**
- `single_user`: The singleton env-var identity is always admin — no `roles.json` lookup needed.
- `credentials`: The credentials env-var user is always admin (same deterministic UUID algorithm as token issuance).
- `oidc` / `hybrid`: No built-in bootstrap. Operator populates `roles.json` directly as a deployment step.

**Route guards:**
- `requireAdmin()`: Requires an authenticated human with the "admin" role. Agents are structurally excluded (agents never appear in `roles.json`).
- `resolvePublicOrAuthenticated()`: Checks ACL for the specific `docPath`. Unauthenticated callers pass through for public documents; authenticated callers always pass through.

**Document tree filtering:** Unauthenticated callers to `GET /documents/tree` receive only documents where `getDocReadPermission() === "public"`. The full document list is never exposed to anonymous callers.

### Token structure

All tokens are JWT signed with HMAC-SHA256 (`KS_AUTH_SECRET`):

```json
{
  "sub": "agent-a1b2c3d4",
  "type": "agent",
  "display_name": "marketing-strategy-agent",
  "token_use": "access",
  "exp": 1741854600,
  "iat": 1741852800,
  "jti": "<uuid>"
}
```

Key claims: `sub` (identity), `type` ("human" | "agent"), `display_name`, `token_use` ("access" | "refresh").

**NOTE:** the 'type' field is important and is used to change how the account's edits are prioritized.

### OAuth 2.1 endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/oauth-protected-resource` | Resource discovery (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | AS metadata (RFC 8414) |
| `POST /oauth/register` | Dynamic Client Registration (RFC 7591) |
| `GET /oauth/authorize` | Authorization (browser consent or auto-approve) |
| `POST /oauth/token` | Code exchange + refresh |

---

## Frontend architecture

### Page load

1. Fetch document structure and section metadata via REST
2. REST responses overlay dirty session content on canonical (so reloads show unpublished changes)

### Edit mode

1. Create one Y.Doc for the document
2. Create one CrdtProvider (single WebSocket to `/ws/crdt/{docPath}`)
3. After sync, mount Milkdown editors for chosen sections 

### Lazy editor mounting

Current implementation: Only 3 Milkdown editors mounted initially: focused section + neighbors (n-1, n, n+1). Others render as read-only previews. Transition cost: ~5ms for pre-mounted neighbors.

This is done to preserve performance even on huge files (e.g. thousands of sections)

### Editor modes

| Mode | Y.js sync | Undo | Used when |
|------|-----------|------|-----------|
| Normal | Yes (via Y.js sync + undo plugins) | Y.js undo manager | Normal editing |
| Proposal | No (standalone ProseMirror) | Standard ProseMirror undo | Editing within a human proposal |

In proposal mode, the editor disconnects from CRDT and works against the proposal file directly.

### SharedWorker for multi-tab

A SharedWorker maintains a single WebSocket connection across browser tabs, preventing duplicate connections. This is critical because multiple tabs opening separate WebSockets would cause duplicate subscriptions, conflicting focus state, and unnecessary server load.

**Architecture:**

The SharedWorker (`ws-shared-worker.ts`) runs as a singleton browser process shared by all tabs of the same origin. Each tab communicates with the worker via a `MessagePort`.

```
Tab 1 ──port──┐
Tab 2 ──port──┤  SharedWorker  ──── single WebSocket ──── Server /ws
Tab 3 ──port──┘
```

**Subscription aggregation:** Each tab reports its subscriptions (which documents it cares about) and focus state (which section the user is editing). The worker aggregates all tabs' subscriptions into a single set and tracks the most recently focused document across all tabs, sending only diffs to the server.

**Server event broadcasting:** When the server sends an event (e.g. `presence:editing`, `dirty:changed`, `content:committed`), the worker relays it to all tabs simultaneously. Every tab receives the same real-time updates, which is why features like the Mirror panel stay consistent across tabs without special cross-tab logic.

**Tab lifecycle:** Tabs register on connect and are swept after 7 seconds of inactivity. When the last tab closes, the WebSocket is closed. When a new tab opens, the WebSocket reconnects on demand.

**BroadcastChannel fallback:** When SharedWorker is unavailable (older browsers, test environments), a fallback uses `BroadcastChannel` with leader election. Tabs elect a leader (lexicographic sort of tab IDs), and only the leader maintains the WebSocket. Non-leader tabs send messages via the BroadcastChannel, and the leader forwards them. This achieves the same single-WebSocket guarantee without SharedWorker support.

**Note:** The SharedWorker handles the `/ws` presence hub connection only. Each document's CRDT connection (`/ws/crdt/{docPath}`) is a separate per-document WebSocket managed by `CrdtProvider`, independent of the SharedWorker.

---

## Invariants for implementers

1. **DocumentSkeleton is canonical source of identity** — never independently derive paths from level numbers
2. **CRDT is transport, not storage** — Y.Doc only exists while holders are connected
3. **All durable state visible on disk** — `ls` shows complete system state; no hidden database
4. **REST endpoints return canonical-ready only** — never read raw fragments (may contain un-normalized content)
5. **Human-involvement is a 0-1 float** — single threshold (0.5), never cached, computed on every evaluation
6. **Dirty ownership contract**: Content dirtiness is shared (`sessions/docs/`); attribution dirtiness is per-user (`sessions/authors/`)

---

## Data directory structure

All persistent state lives under a single data directory (mounted as `/app/data` in Docker):

```
data/
├── snapshots/            ← Pure markdown files, read-only, enabling any standard 3rd party tool to read the data
├── content/              ← Published content (canonical), markdown stored in a custom format
│   ├── .git/             ← Private audit-log of all changes to /content/
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
└── auth/                 ← Authentication and authorization state
    ├── defaults.json     ← System-wide default permission levels (read/write)
    ├── roles.json        ← User-to-role mappings (e.g. admin)
    ├── acl.json          ← Per-document permission overrides (sparse)
    └── agents.keys       ← Pre-authenticated agent credentials (optional)
```

### Backing up

- **`content/`** — all published content and full git history. The most critical directory.
- **`sessions/`** — in-flight editing state. Contains all unpublished edits (up to minutes of human work).
- **`proposals/`** — the audit trail of all proposals (committed and withdrawn). Back this up for audit compliance.
- **`auth/`** — agent credentials and RBAC files. Small but important.

---

## What's next

- [Testing Guide](testing.md) — test patterns and infrastructure
- [Error Handling](error-handling.md) — error philosophy and patterns
