# Architecture Overview

Technical overview of Civigent's internals for contributors and power users.

---

## Design philosophy

Civigent is built on three core principles:

1. **Continuous shared situational awareness** — Every actor's attention is visible as a continuous signal. Coordination emerges from visibility, not from explicit locking protocols.

2. **Enforcement is the last resort** — Smart actors (humans and agents) self-coordinate when they can see the state of the system. Hard blocks exist only for the cases where self-coordination fails.

3. **Asymmetric actor economics** — Human work is expensive and irreplaceable. Agent work is cheap and regenerable. The system protects human content from agent overwrites but does not protect agent content from other agents ("last committed wins").

---

## Layered data architecture

Data flows from disk to the browser editor through the canonical store, the proposal subsystem, the in-memory Y.Doc, the WebSocket transport, and the browser editors. There is no separate session-overlay disk tier: in-flight live editing is durably represented by the relevant `inprogress` proposal content tree (spec `05-ydoc-lifecycle.md` › Disk Persistence Layout), and live↔canonical materialization is owned by `CRDTProposalGenerator`.

```
Layer 1: Canonical Store / Audit log (disk + git, content/)
    ↑ proposal absorb (commit) / ↓ read
Layer 2: Proposal subsystem (disk, proposals/{status}/{id}/content/)
         - one CRDT-owned `inprogress` proposal per live DocSession is the
           durable in-flight live-edit state
    ↑ materialize live edits / ↓ reconstruct Y.Doc (inprogress else canonical)
Layer 3: Y.Doc (in-memory CRDT) — one Y.Doc/document, one Y.XmlFragment/section
    ↑↓ sync
Layer 4: WebSocket Transport (per-document /ws/crdt/{docPath})
    ↑↓ binary frames (Yjs sync/update + publish-pause)
Layer 5: Browser Editors (Milkdown, per-section)
```

The live editing pipeline is: live CRDT edits materialize into the DocSession's single `inprogress` proposal; `PublishTriggerPolicy` decides when to publish; the DocSession actor runs a publish pause and drives `inprogress -> committing -> committed`, advancing canonical through the existing proposal subsystem. On restart, the Y.Doc is reconstructed from the current `inprogress` proposal when present, else from canonical.

### Critical abstraction classes

The data architecture is innovative and concise, underpinning many of the core features of the app. Details matter. To make sure implementers and downstream classes never make mistakes, we have centralised the core data architecture into a small number of elegant, encapsulated, classes that provide simple abstractions over the architecture. All code must use these and avoid ever directly editing data.

#### DocumentSkeleton

Owns the heading tree structure of a document: which sections exist, how they nest, and where their body files live on disk. All heading paths, section file paths, and tree structure derive from it. Abstracts the recursive skeleton-file / sub-skeleton / root-child disk format so callers never reason about `.sections/` directories or `{{section:}}` markers directly.

#### ContentLayer

The low-level section-body content engine. Resolves `(docPath, headingPath)` to a file path via DocumentSkeleton and enforces the body-only invariant (strips heading lines). `ProposalShadowContentLayer` (a skeleton-aware layer that shadows a base content root) is the engine behind proposal content trees and the arbitrary-markdown upsert paths. Proposal-scoped reads/writes are exposed through the `ProposalReader` / `ProposalEditor` facades over `ProposalShadowContentLayer`; canonical reads go through the section/document readers.

#### YDocLifecycleManager / DocSession

`YDocLifecycleManager` (module-level functions + the `sessions` map in `crdt/ydoc-lifecycle.ts`) owns Y.Doc lifecycle: a Y.Doc is alive whenever ≥1 transport is connected; retain-vs-discard otherwise is its perf/caching policy. Each live document has one `DocSession` actor: an ordered command lane (`enqueue`) through which every Y.Doc / proposal-boundary op runs, plus the `CRDTProposalGenerator` and `DocSessionPublishPause` for that document. The DocSession holds no parallel durable session state — live in-flight state is the `inprogress` proposal.

#### CRDTProposalGenerator

The single boundary component owning live↔canonical materialization (`crdt/crdt-proposal-generator.ts`). It lazily creates the DocSession's one current `inprogress` proposal on the first materialized CRDT edit, materializes subsequent live edits into it (through `ProposalEditor`), runs identity-preserving structural normalization inside a single `Y.transact`, and applies committed canonical deltas back into the live Y.Doc using the same primitive. `PublishTriggerPolicy` (same module) decides when the current proposal should attempt publication.

#### ProposalReader / ProposalEditor

The proposal-scoped content facades (`storage/proposal-reader.ts`, `storage/proposal-editor.ts`) over `ProposalShadowContentLayer`. `ProposalEditor.writeSection(...)` / `createSection` / `moveSection` / etc. are how both agent proposals and CRDTProposalGenerator-authored `inprogress` proposals mutate their content trees. `DocumentSkeleton` remains the section-identity authority underneath.

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

**Skeleton files** contain `{{section: filename.md}}` markers instead of inline content. This separates structure from content, enabling section-level operations. See [Internal Data Formats](developerdocs/internal-data-formats.md) for the full skeleton spec and section body newline policy.

**Section files** can themselves be sub-skeletons (containing their own `{{section:}}` markers with their own `.sections/` directory). This recursive structure represents arbitrarily deep heading hierarchies.

When a section gains sub-headings, its file becomes a sub-skeleton and a **root child** entry (level=0, heading="") is prepended to hold the parent's body content.

`DocumentSkeleton` is the single in-memory model that reads this recursive structure and provides tree, flat, and resolve views. It is the **canonical source of section identity** — all heading paths, file paths, and tree structure derive from it.

**Empty-skeleton tombstone convention:** A skeleton file with zero entries signals document deletion in a proposal content tree. When a proposal absorb encounters an empty skeleton, it deletes all canonical files for that document (skeleton, `.sections/` directory, section body files) rather than writing an empty file. Document rename is decomposed as: tombstone at old path + full copy at new path — reusing the shadow-content-layer read semantics with no new read logic. This ensures ALL document mutations (content edits, section structural changes, document deletion, document renaming) are expressible as skeleton + section file state in a proposal content tree. No operation requires metadata, sentinels, or out-of-band state.

### Layer 2: Proposal subsystem (durable in-flight state)

In-flight live edits are not stored in a parallel session-overlay tier — that tier is removed. Instead, live CRDT activity is materialized into the DocSession's single CRDT-owned `inprogress` proposal content tree under `proposals/inprogress/{id}/content/`. This makes the proposal subsystem the one durable representation of both staged agent work and in-flight human live edits, eliminating the dual-format / overlay-first / flush machinery.

- **One `inprogress` proposal per live DocSession.** Created lazily by the DocSession actor on the first materialized CRDT edit; subsequent live edits materialize into the same proposal. It clears only after a successful publish.
- **Materialization, not flush.** `CRDTProposalGenerator` writes live edits into the proposal content tree via `ProposalEditor` and performs identity-preserving structural normalization (split/merge/rename) inside a single `Y.transact`. There is no `sessions/fragments/` raw tier, no `sessions/sections/` canonical-ready mirror, no overlay-first read path, and no `.writers.json` sidecar — writer attribution for the audit log is carried by the proposal/commit metadata.
- **Reconstruction.** On mount after a restart, the Y.Doc is rebuilt from the current `inprogress` proposal content tree when present, otherwise from canonical (see Crash recovery).

Canonical reads (REST `GET /api/documents/:docPath/sections` etc.) resolve canonical content only through `DocumentSkeleton`; non-CRDT consumers see new content when proposal commits advance canonical.

### Layer 3: Y.Doc (in-memory CRDT)

One `Y.Doc` per document, containing one `Y.XmlFragment` per section.

**Fragment naming:** `"section::" + sectionFileStem` (BFH uses `"section::__beforeFirstHeading__"`); owned by `crdt/ydoc-fragments.ts`. An internal detail clients never see.

**Lifecycle (owned by `YDocLifecycleManager`):**
- Created when the first section is edited / first transport connects
- Alive whenever ≥1 transport is connected; last-transport-disconnect triggers the manager's retain-vs-discard policy (no idle timeout, no session-end-as-commit)
- Survives commits
- Reconstructed on mount from the current `inprogress` proposal content tree, else from canonical (the `inprogress` proposal carries in-flight state across disconnect)

**DocSession (one actor per live document) holds:**
- `enqueue`: the ordered command lane — every Y.Doc / proposal-boundary op runs through it
- `generator`: the `CRDTProposalGenerator` owning live↔canonical materialization and the one current `inprogress` proposal
- `publishPause`: the per-DocSession `DocSessionPublishPause` FSM (never global)
- `liveFragments`: the thin Y.Doc fragment adapter (`LiveFragmentStringsStore`) for live fragment string reads/writes
- `holders`: Map of writerId → `HolderEntry { editorSocketIds, observerSocketIds }`
- `contributors`: Map of writerId → WriterIdentity — accumulated for the git co-author list at commit
- `perUserDirty` / `fragmentFirstActivity` / `fragmentLastActivity`: per-section live-activity attribution used for status reads (not a durable session store)
- `baseHead`: Git HEAD when the session was created; `docSessionId`: explicit Y.Doc-lifetime identity boundary

### Layer 4: WebSocket transport

A unified endpoint `/ws/crdt/{docPath}` handles all clients (editors and observers).

**Mode transition protocol (all clients start detached):**

Every new connection starts with `requestedMode: "none"` and `attachmentState: "detached"`. The frontend sends `MSG_MODE_TRANSITION_REQUEST` (0x0C) to request a role, and the backend replies with `MSG_MODE_TRANSITION_RESULT` (0x0D). The backend is authoritative — the frontend waits for the result rather than assuming the transition succeeded.

**CRDT remote-session types** (defined in `sharedlibs/shared-types/src/index.ts`, re-exported everywhere):

| Type | Description |
|------|-------------|
| `ClientRole` | `"observer" \| "editor"` — applied server role for a connected participant |
| `ClientInstanceId` | Per-tab runtime identity (UUID). Never use `writerId` for live-socket identity. |
| `RequestedMode` | `"none" \| "observer" \| "editor"` — desired mode requested by the tab-local controller |
| `AttachmentState` | `"detached" \| "waiting_for_session" \| "attached_to_session"` — relative to a live DocSession |
| `DocSessionId` | Explicit identity of one live backend DocSession. Hard boundary between Y.Doc lifetimes. |
| `EditorFocusTarget` | `{ heading_path: string[] }` — the one section actively edited by this tab |
| `RemoteParticipant` | Server-authoritative runtime state for one connected tab (holds all of the above) |
| `ModeTransitionRequest` | Frontend → backend request to change mode |
| `ModeTransitionResult` | Backend → frontend ack/reject (discriminated union `success \| rejected`) |
| `DocumentSessionControllerState` | Frontend-only single source of truth for this tab's CRDT state |

**Binary message types** (the binary CRDT *editor channel* frame codec, `ws/crdt-ws-frames.ts`). The legacy session-overlay / focus / pulse / mutate / receipt / idle-timeout opcodes are removed; the DocSession publish-pause control messages ride this same ordered editor channel as Yjs updates.

| Code | Name | Direction | Purpose |
|------|------|-----------|---------|
| 0x00 | SYNC_STEP_1 | Bidirectional | Y.js sync initiation |
| 0x01 | SYNC_STEP_2 | Server→Client | Y.js sync response (editors may also send) |
| 0x02 | YJS_UPDATE | Bidirectional | Y.js incremental update (editor→server and server→all). Structural normalization is delivered as a normal YJS_UPDATE delta. |
| 0x03 | AWARENESS | Bidirectional | Presence/cursor data |
| 0x0B | DOCUMENT_REPLACEMENT_NOTICE | Server→Client | Reconnect notice delivered after restore/overwrite |
| 0x0C | MODE_TRANSITION_REQUEST | Client→Server | Request mode transition |
| 0x0D | MODE_TRANSITION_RESULT | Server→Client | Mode transition ack/reject |
| 0x10 | DOC_PUBLISH_PAUSE_START | Server→Client | DocSession publish pause begun; freeze editors |
| 0x11 | DOC_PUBLISH_READY | Client→Server | Editors frozen / no more Yjs txns (ordered ack) |
| 0x12 | DOC_PUBLISH_PAUSE_END | Server→Client | Publish attempt ended (commit or abort); editors may unfreeze |

Opcode `0x08` (legacy `STRUCTURE_WILL_CHANGE`) is permanently reserved-removed and must never be redefined — the design does not expose live fragment-key remaps as a client contract.

**Section block-state events are NOT binary frames.** `section:blocked` / `section:unblocked` / `section:gone` travel on the JSON application WebSocket as server events (they keep the frontend's per-section editability — `editable | blocked | gone` — aligned with server reality). They derive from proposal lock-acquisition events and canonical structural changes (rename/delete commits).

**Application-level close codes** (`ws/crdt-ws-frames.ts`):

| Code | Meaning | Client behaviour |
|------|---------|-----------------|
| 4010–4019 | Hard rejection (bad auth, bad URL, ydoc init failed) | Do not reconnect |
| 4021 | Session ended (last editor left) | Reconnect and wait for next session |
| 4022 | Document replaced (restore/overwrite invalidation) | Reconnect immediately (no backoff) |
| 4023 | Superseded by new tab | Close the old tab's editor socket |
| 4024 | Admin force-rebuild invalidation | Reconnect immediately and reseed from canonical |

There is no `4020 idle_timeout` — there is no idle timer in this architecture.

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

"Real, live human work covers this section." A section is hard-contested when it is covered by live human CRDT work carried by `CRDTProposalGenerator` / its `inprogress` proposal, or when a human proposal lock already owns the section.

- Drives agent gating (via `agent-write-policy` + proposal-FSM locks) and human-involvement scoring
- Derived from the DocSession's `inprogress`-proposal state and proposal lock ownership — not from browser focus, dirty session files, `MSG_SECTION_FOCUS`, or the deleted `SectionPresence`/`section-guard`/`section-recency` heuristics
- Never derived from Y.js Awareness (browser focus/hover/Awareness are intentionally out of scope for gating)

### viewingPresence (client-informational)

"A user is looking at this section."

- Drives cosmetic UI (colored dots, name badges)
- Carried via Y.js Awareness CRDT (`user.viewingSections`)
- Never used for agent gating or involvement scoring
- Signal source can change (editor focus, IntersectionObserver, mouse hover) without affecting backend correctness

### unpublishedState (save status)

"This section has live edits not yet published to canonical."

- If surfaced in the UI at all, it derives from the existence of the DocSession's `inprogress` proposal (and which sections it covers), not from a flush/dirty-file lifecycle or `SESSION_FLUSHED` events
- The old document-level `SaveStatus` state machine and blue/amber/green flush-driven dots are removed; rich persistence-status UX is intentionally left to the frontend (transport-failure banners, publish-pause state, or nothing)
- Coarse invalidation events (e.g. proposal-commit notifications, publish-pause start/end) tell the frontend when to refetch authoritative state rather than streaming per-section dirty deltas

---

## Human-involvement scoring

The core conflict-prevention mechanism. Protects human-authored content from agent overwrites. Calculated per-section, per-document, as a continuous float from 0.0 (no recent human activity) to 1.0 (human actively editing).

### Why continuous, not binary

Every overwrite is contested in principle — someone authored the current content. But agent-authored content overwritten by another agent is not protected (agents are cheap to rewrite). The system only protects human work, and it does so as a **spectrum** rather than a lock/unlock binary. This enables nuanced decisions: an agent can overwrite a section a human touched 3 hours ago but not one touched 30 seconds ago.

### Decision policy: a selected agent write-policy

Agent gating is expressed through the `agent-write-policy` layer (spec `12-proposal-fsm-locking.md`), which exposes a generic `canWrite` result per proposal and per target. Human-involvement scoring is one concrete compatibility policy behind that interface; its details (a per-section score, an aggregate threshold) live inside that policy's typed detail shape, not as a hardcoded app-wide contract. The current compatibility policy behaves as:

- `canWrite` for all targets (score below threshold) → the proposal may commit (subject to proposal-FSM locks)
- any target not `canWrite` (score at/above threshold) → the proposal stays draft/pending; the response explains, per target, which sections are unavailable
- a section under live human work or a human proposal lock → hard-blocked (the proposal-FSM lock / live-work hard block, independent of decay)

Proposal-FSM locks (transition-time exclusion) and the agent write-policy are kept as separate concepts; CRDT section block/gone/publish-pause state is separate again.

### Justification bonus

Agents can provide a per-section justification explaining why they are overwriting. This reduces the involvement score by a fixed 0.1. A section at score 0.6 (blocked without justification) becomes 0.5 (accepted) with justification. This is most valuable with the Eager preset, where justification buys ~75 minutes of additional access.

### What humans see

Human-involvement scores are **not shown to regular human users** on the editing view. They are internal to the agent negotiation system. Humans can always edit freely regardless of scores. Scores are visible on the admin heatmap page and in agent proposal responses.

### Delivery mechanism

Scores are included in REST API responses (computed at request time) and polled for the heatmap view. They are not pushed via WebSocket — the decay is continuous, so pushing would mean either high-frequency updates or accepting staleness. Coarse WS events (e.g. `content:committed`, the proposal-commit notification, and section block-state events) serve as hints for when to refresh.

---

## Live-edit publish pipeline

Canonical advances through the existing proposal subsystem. There is no separate flush path, no `sessions/`-cleanup phase, and no session-end / Y.Doc-destroyed commit trigger.

### Live materialization (continuous)

Live CRDT edits are materialized by `CRDTProposalGenerator` into the DocSession's one current `inprogress` proposal content tree (created lazily on the first edit). This is the durable in-flight state; there is no raw-fragment / canonical-ready dual write and no `SESSION_FLUSHED` event.

### Structural normalization (event-driven, owned by CRDTProposalGenerator)

Resolving embedded headings, heading deletions, and heading-level changes within a section is owned by `CRDTProposalGenerator`. The trigger is per-section CRDT-activity quiescence detected by its observation surface — **not** a 60s timer, focus change, or session-end. The mutation runs inside a single identity-preserving `Y.transact` (splits keep the original fragment as one half; merges extend the survivor; cross-section moves use capture-and-recover on the cursor). The atomicity guarantees peers/observers see only pre- or post-state; the resulting `YJS_UPDATE` delta is the broadcast — there is no `STRUCTURE_WILL_CHANGE` warning protocol.

### Publish (PublishTriggerPolicy → DocSession publish pause → commit)

1. `PublishTriggerPolicy` decides the current `inprogress` proposal should attempt publication.
2. The DocSession actor starts a publish pause: sends `doc_publish_pause_start` to active editor sockets, waits for an ordered `doc_publish_ready` ack from every required socket (the ack, riding the same ordered channel as prior Yjs updates, proves those updates already reached the actor).
3. It performs final materialization from the live Y.Doc into the current proposal content tree and commits `inprogress -> committing -> committed` through the proposal subsystem; canonical advances and the audit-log entry is written. The current-proposal reference clears only after success.
4. `doc_publish_pause_end` unfreezes editors. On abort or commit failure, the same proposal remains `inprogress` and editing resumes — no successor / copy-on-write rollover.

`PublishNow` is just an immediate `PublishTriggerPolicy` fire on the current `inprogress`, not a separate flush+commit path.

### Proposal commit (agent or human)

1. Two gates for agent proposals: proposal-FSM locks (no overlapping exclusive claim blocks the commit transition) and agent write-policy (`canWrite: true`). Human proposals skip agent write-policy (governed by RBAC + the FSM-lock lifecycle).
2. `pending -> committing` (the directory move IS the exclusive claim) → write sections to canonical → git commit with proposal metadata → `committing -> committed` (terminal).
3. On a successful commit, `CRDTProposalGenerator` applies the canonical delta back into any live Y.Doc using the same `Y.transact`-based primitive.

---

## Crash recovery

On server start, recovery is narrowed to proposal-FSM cleanup + git integrity (see [Crash Recovery & Data Safety](crash-recovery.md)):

1. Discard `pending` proposals as transient debris.
2. Finish interrupted `committing` proposals forward — finalize the `committing -> committed` rename when `committed_head` already landed, else re-run `publishCommittingProposalToCanonical` from `proposals/committing/{id}/content`. Never roll back.
3. Leave `inprogress` proposals untouched (durable live state).
4. A dirty working tree is acceptable only as the by-product of completing a `committing` proposal; any other dirty tracked state fails startup with a maintainer report.

When a document is next mounted, its Y.Doc is reconstructed from the current `inprogress` proposal content tree when present, otherwise from canonical. There is no `sessions/fragments/` scan and no flush-cycle data-loss window.

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
2. REST responses return canonical content only (resolved through `DocumentSkeleton`); there is no session-overlay read path. Live unpublished edits are seen by entering edit mode (Y.Doc sync) or via the read-only observer channel, not by overlaying session files onto canonical REST reads.

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

**Server event broadcasting:** When the server sends a JSON app-WS event (e.g. `content:committed`, the proposal-commit notification, `agent:reading`, or section block-state events), the worker relays it to all tabs simultaneously. Every tab receives the same real-time updates, which is why features like the Mirror panel stay consistent across tabs without special cross-tab logic. (The removed `dirty:changed`/`presence:*` session events are no longer part of this stream.)

**Tab lifecycle:** Tabs register on connect and are swept after 7 seconds of inactivity. When the last tab closes, the WebSocket is closed. When a new tab opens, the WebSocket reconnects on demand.

**BroadcastChannel fallback:** When SharedWorker is unavailable (older browsers, test environments), a fallback uses `BroadcastChannel` with leader election. Tabs elect a leader (lexicographic sort of tab IDs), and only the leader maintains the WebSocket. Non-leader tabs send messages via the BroadcastChannel, and the leader forwards them. This achieves the same single-WebSocket guarantee without SharedWorker support.

**Note:** The SharedWorker handles the `/ws` presence hub connection only. Each document's CRDT connection (`/ws/crdt/{docPath}`) is a separate per-document WebSocket managed by `CrdtProvider`, independent of the SharedWorker.

---

## Dev supervisor and backend fatal SSE

In development (`npm run dev`), a lightweight supervisor process (`backend/src/dev-supervisor.ts`) sits in front of the real backend (`backend/src/server.ts`):

- **Supervisor** owns the public port, serves `GET /api/system/events` (SSE), and proxies all other HTTP/WS traffic to the worker via `http-proxy`.
- **Worker** (`server.ts`) binds an ephemeral port, IPCs it to the supervisor, and sends lifecycle messages (`starting`, `listening`, `ready`, `fatal`).
- If the worker crashes, the supervisor stays alive, retains the fatal error report in memory, and broadcasts it to all connected browsers via SSE. The frontend renders a full-page error screen with the stack trace.
- New browser tabs that open after a crash immediately receive the retained fatal state.

In production, `server.ts` runs directly — no supervisor, no SSE endpoint, no proxy hop. The supervised-mode code paths are dead code when `process.send` is undefined.

---

## Invariants for implementers

1. **DocumentSkeleton is canonical source of identity** — never independently derive paths from level numbers
2. **CRDT is transport, not parallel storage** — the live Y.Doc exists while holders are connected; durable in-flight state is the `inprogress` proposal content tree, not a session sidecar
3. **All durable state visible on disk** — `ls` shows complete system state; no hidden database
4. **REST endpoints return canonical only** — they resolve canonical content through `DocumentSkeleton`; there is no session-overlay or raw-fragment read path
5. **One `inprogress` proposal per live DocSession** — live edits materialize into it; canonical advances only through proposal commits; reconstruction is from `inprogress` else canonical
6. **Agent gating is policy, not hardcoded** — agent writes pass one selected agent write-policy (`canWrite`) plus proposal-FSM locks; do not hardcode score thresholds or `inprogress`-as-only-blocking-status at call sites

---

## Data directory structure

Canonical persistent state lives under a single data directory (mounted as `/app/data` in Docker). Snapshots are a separate derived cache that lives outside the data root by default:

```
app/
├── snapshots/           ← Pure markdown files, read-only, derived cache for external tools
└── data/
    ├── content/              ← Published content (canonical), markdown stored in a custom format
    │   ├── .git/             ← Private audit-log of all changes to /content/
    │   ├── document-name.md  ← Skeleton file (privately stored and maintained, you should never need to edit or view this raw)
    │   └── document-name.md.sections/ (part of the custom internal markdown format)
    │       ├── sec_abc123.md           ← Section content file
    │       └── sec_abc123.md.sections/ ← Sub-sections (for nested headings)
    │
    ├── proposals/            ← Agent and human proposals (filesystem = state machine)
    │   ├── pending/          ← Draft proposals (mutable)
    │   ├── inprogress/       ← Durable in-flight live-edit state (one CRDT-owned proposal per live DocSession) + human-explicit-acquire proposals
    │   ├── committing/       ← Being committed right now (transient, milliseconds)
    │   ├── committed/        ← Successfully committed (terminal, audit trail)
    │   └── withdrawn/        ← Cancelled proposals (terminal, audit trail)
    │
    └── auth/                 ← Authentication and authorization state
        ├── defaults.json     ← System-wide default permission levels (read/write)
        ├── roles.json        ← User-to-role mappings (e.g. admin)
        ├── acl.json          ← Per-document permission overrides (sparse)
        └── agents.keys       ← Pre-authenticated agent credentials (optional)
```

### Backing up

- **`content/`** — all published content and full git history. The most critical directory.
- **`proposals/`** — the audit trail of all proposals (committed and withdrawn) AND the durable in-flight live-edit state (`inprogress/`). Contains all unpublished edits (up to minutes of human work); back this up for both data safety and audit compliance.
- **`auth/`** — agent credentials and RBAC files. Small but important.

---

## What's next

- [Internal Data Formats](developerdocs/internal-data-formats.md) — skeleton format, section body newline policy, boundary transforms
- [Testing Guide](testing.md) — test patterns and infrastructure
- [Error Handling](error-handling.md) — error philosophy and patterns
