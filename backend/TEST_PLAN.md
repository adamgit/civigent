# Backend Test Plan

> Aligned to iteration3.3.md spec. Replaces all existing tests except performance tests.

STATUS: PARTIALLY IMPLEMENTED, UNDER REVIEW

## Guiding Principles

- Tests validate **spec-defined behavior**, not implementation details
- Each test file covers one subsystem; test names read as spec assertions
- Use real filesystem (temp dirs) for storage tests, not mocks
- API tests use supertest against the Express app
- WebSocket tests use real ws connections against a test server
- No snapshot tests — assert on structure/values

---

## 1. Auth (`auth/`)

### `auth-registration.test.ts`
- POST /api/auth/agent/register returns 201 with access_token, refresh_token, identity
- POST /api/auth/agent/register without display_name returns 400
- Registered agent identity has type "agent" and a generated UUID
- Transient agent tokens are valid JWTs that decode to the correct identity

### `auth-login.test.ts`
- POST /api/auth/login with valid credentials returns tokens + sets HttpOnly cookies
- POST /api/auth/login with invalid credentials returns 401
- POST /api/auth/login without username or password returns 400

### `auth-token-refresh.test.ts`
- POST /api/auth/token/refresh with valid refresh token returns new token pair
- POST /api/auth/token/refresh with invalid token returns 401
- POST /api/auth/token/refresh reads refresh_token from cookie if not in body

### `auth-session.test.ts`
- GET /api/auth/session with valid token returns authenticated: true + user info
- GET /api/auth/session without token returns authenticated: false
- GET /api/auth/methods lists available auth providers

### `auth-logout.test.ts`
- POST /api/auth/logout clears auth cookies (Max-Age=0)

### `auth-middleware.test.ts`
- Endpoints requiring auth return 401 when no token provided
- Endpoints requiring auth succeed with valid Bearer token
- Endpoints requiring auth succeed with valid cookie token

---

## 2. Documents — Read (`documents-read/`)

### `document-get.test.ts`
- GET /api/documents/:docPath returns assembled markdown content
- GET /api/documents/:docPath returns head_sha from git
- GET /api/documents/:docPath returns sections_meta array with human-involvement scores
- GET /api/documents/:docPath for non-existent doc returns 404
- GET /api/documents/:docPath with path traversal attempt returns 400/404
- GET /api/documents/:docPath by agent broadcasts agent:reading event

### `document-sections.test.ts`
- GET /api/documents/:docPath/sections returns all sections with content
- Each section includes heading_path, content, humanInvolvement_score, word_count
- section_length_warning is true when word_count exceeds threshold
- Sections read canonical content only (resolved through DocumentSkeleton); there is no session/overlay/live-state read path

### `document-structure.test.ts`
- GET /api/documents/:docPath/structure returns heading tree
- Structure reflects skeleton files, including nested sub-skeletons
- Structure resolves canonical skeleton only (no session overlay)

### `document-changes-since.test.ts`
- GET /api/documents/:docPath/changes-since?after_head=SHA returns changed sections
- Returns empty changes when SHA matches current HEAD
- Returns 400 for invalid doc path

---

## 3. Documents — Write (`documents-write/`)

### `document-create.test.ts`
- PUT /api/documents/:docPath creates empty document with skeleton + root section
- PUT /api/documents/:docPath commits creation to git
- PUT /api/documents/:docPath returns 409 if document already exists
- PUT /api/documents/:docPath returns 400 for invalid path

---

## 4. Documents Tree (`documents-tree/`)

### `documents-tree.test.ts`
- GET /api/documents/tree returns hierarchical file/directory listing
- GET /api/documents/tree?path=subdir scopes to subdirectory
- GET /api/documents/tree?path=nonexistent returns 404
- Entries include name, path, type ("file" | "directory"), and children

---

## 5. Sections (`sections/`)

### `section-read.test.ts`
- GET /api/sections?doc_path=X&heading_path=A/B returns section content
- GET /api/sections returns head_sha
- Missing doc_path or heading_path returns 400
- Non-existent section returns 404
- Agent caller triggers agent:reading broadcast

---

## 6. Proposals — Lifecycle (`proposals/`)

### `proposal-create.test.ts`
- POST /api/proposals creates proposal and evaluates involvement immediately
- 2-phase commit: proposal always starts as status=pending, outcome=accepted (no auto-commit)
- When some sections blocked: status=pending, outcome=blocked
- Returns 400 if intent or sections missing
- Returns 400 if section missing doc_path, heading_path, or new_content
- Returns 401 without auth
- commit_proposal transitions pending→committed and broadcasts content:committed event

### `proposal-meta-enrichment.test.ts`
- Committed meta.json contains committed_head and humanInvolvement_at_commit
- Withdrawn meta.json contains withdrawal_reason

### `proposal-single-pending-invariant.test.ts`
- Second proposal from same writer returns 409 with existing_proposal_id
- POST /api/proposals?replace=true auto-withdraws existing and creates new
- Different writers can each have one pending proposal simultaneously
- Committed proposals do not block new proposals from same writer (2-phase commit)

### `proposal-modify.test.ts`
- PUT /api/proposals/:id updates sections on pending proposal
- PUT /api/proposals/:id returns 403 if not proposal owner
- PUT /api/proposals/:id returns 409 if proposal not in pending state
- PUT /api/proposals/:id re-evaluates involvement after modification

### `proposal-commit.test.ts`
- POST /api/proposals/:id/commit re-evaluates and commits if all sections pass
- POST /api/proposals/:id/commit returns blocked status if sections still contested
- POST /api/proposals/:id/commit returns 403 if not owner
- POST /api/proposals/:id/commit returns 409 if not pending
- Successful commit broadcasts content:committed event

### `proposal-cancel.test.ts`
- POST /api/proposals/:id/cancel moves proposal to withdrawn state
- POST /api/proposals/:id/cancel includes withdrawal_reason when provided
- POST /api/proposals/:id/cancel returns 403 if not owner
- POST /api/proposals/:id/cancel returns 409 if already committed/withdrawn

### `proposal-list.test.ts`
- GET /api/proposals returns all proposals
- GET /api/proposals?status=pending returns only pending proposals
- GET /api/proposals?status=committed returns only committed proposals
- GET /api/proposals?status=withdrawn returns only withdrawn proposals
- Invalid status filter returns 400

### `proposal-read.test.ts`
- GET /api/proposals/:id returns proposal with re-evaluated involvement for pending
- GET /api/proposals/:id returns 404 for non-existent proposal

---

## 7. Heatmap (`heatmap/`)

### `heatmap.test.ts`
- GET /api/heatmap returns all sections across all documents with human-involvement scores
- Each entry includes doc_path, heading_path, humanInvolvement_score, and live-work state
- Sections carried by a DocSession `inprogress` proposal (live human CRDT work) are reported as actively edited
- Response includes current admin preset name

---

## 8. Agent Write Policy & Proposal FSM Locks (`domain/`)

Section gating is now split into two concepts (spec 12-proposal-fsm-locking):
proposal FSM locks (transition-time exclusion) and the agent write-policy
(whether agents may write a section). The legacy dirty-session / live-focus /
recency-decay heuristics are removed; live human work is represented by the
DocSession's `inprogress` proposal, not by session focus or dirty files.

### `agent-write-policy.test.ts`
- AgentWritePolicy returns canWrite=true/false per proposal and per target; common callers branch on canWrite only
- A section covered by a human `inprogress` proposal (live CRDT work) returns canWrite=false for agents
- A section with only agent commits / no contention returns canWrite=true
- The human-involvement compatibility policy still surfaces a score inside its own typed details (not as the generic field)
- Humans are never blocked by agent write-policy (governed by RBAC + FSM locks)

### `proposal-fsm-locks.test.ts`
- BLOCKING_LOCK_STATUSES is policy ("inprogress" + "committing"), not hardcoded at call sites
- A `draft -> inprogress` transition is all-or-nothing: any conflicting exclusive claim keeps it draft and returns structured conflicts
- A `committing` proposal's targets are themselves an exclusive claim that blocks other transitions
- ProposalFsmLockIndex.build batches claim lookup and supports self-exclusion by proposal id
- Conflicts report blockingProposalId / blockingProposalStatus / blockingWriter (structured, not first-failure)

### `human-involvement-presets.test.ts`
- Each named preset (permissive, balanced, protective, lockdown) produces expected threshold behavior
- Admin config change to preset affects subsequent evaluations

---

## 9. Storage — Skeleton & Section Files (`storage/`)

### `document-skeleton.test.ts`
- DocumentSkeleton.fromDisk reads skeleton file and resolves section entries
- Nested sub-skeletons are recursively read and flattened
- Root child entries (level=0, heading="") represent parent body content
- skeleton.flat returns all leaf entries in document order
- skeleton.structure returns the tree form
- DocumentSkeleton.createEmpty creates valid skeleton with root section
- skeleton.persist writes skeleton files to disk

### `heading-resolver.test.ts`
- resolveAllSectionPaths maps heading paths to absolute file paths
- Paths resolve against the canonical content root (no overlay root)
- flattenStructureToHeadingPaths extracts ordered heading paths from structure tree

### `document-reader.test.ts`
- readAssembledDocument concatenates all section content in skeleton order
- readAssembledDocument returns DocumentNotFoundError for missing doc

### `section-reader.test.ts`
- readSection returns content for valid heading path
- readSection returns SectionNotFoundError for invalid heading path

### `path-utils.test.ts`
- resolveDocPathUnderContent normalizes and validates doc paths
- Path traversal attempts (../) are rejected with InvalidDocPathError
- Paths with null bytes are rejected

### `git-repo.test.ts`
- ensureGitRepoReady initializes git repo if none exists
- getHeadSha returns current HEAD commit SHA
- gitExec runs arbitrary git commands in the data root

### `proposal-store.test.ts`
- createProposal writes JSON to proposals/pending/
- readProposal reads from whichever status directory contains the file
- listProposals scans all status directories, applies optional filter
- findPendingProposalByWriter finds the correct proposal by writer ID
- updateProposalSections modifies sections on disk
- transitionToWithdrawn moves file from pending/ to withdrawn/
- ProposalNotFoundError for non-existent ID
- InvalidProposalStateError for state-violating operations

### `commit-pipeline.test.ts`
- evaluateProposalHumanInvolvement computes per-section human-involvement scores
- commitProposalToCanonical writes sections to canonical, makes git commit
- commitProposalToCanonical moves proposal file to committed/ directory
- committed proposal includes committed_head SHA and humanInvolvement_at_commit snapshot

### `section-commit-history.test.ts`
- readDocSectionCommitInfo returns per-section git commit metadata
- Recent commits have recency data usable for human-involvement scoring

### `activity-reader.test.ts`
- readActivity returns recent git log entries
- readChangesSince returns sections changed after a given SHA

---

## 9b. Proposal-backed Publish Pipeline (`crdt/`)

Canonical advances through the existing proposal subsystem; there is no
flush/destroy/idle-timeout commit path. Live CRDT activity materializes into the
DocSession's single `inprogress` proposal, and PublishTriggerPolicy drives the
DocSession publish pause then `inprogress -> committing -> committed` -> canonical
(spec 05 "Proposal Publication", spec 09 §14).

### `publish-pipeline.test.ts`
- PublishTriggerPolicy firing drives the DocSession actor through the publish pause: pause_start -> ordered ready acks -> final materialization -> commit
- Successful publish transitions inprogress -> committing -> committed and advances canonical; the current-proposal reference clears only after success
- A failed/aborted publish keeps the same proposal as the DocSession's current inprogress and resumes editing after pause_end (no successor / copy-on-write rollover)
- Manual PublishNow fires PublishTriggerPolicy on the current inprogress rather than running a separate flush+commit path
- Reconstruction after restart: Y.Doc rebuilt from the current inprogress proposal when present, otherwise from canonical
- No idle timer and no last-holder-disconnect commit trigger

### `human-proposals.test.ts`
- POST /api/proposals from a human writer creates pending proposal with empty sections
- Human writer proposals skip human-involvement evaluation (accepted immediately)
- PUT /api/proposals/:id for human writer proposals updates section content
- POST /api/proposals/:id/commit for human writer proposals always commits (no human-involvement check)
- A human `draft -> inprogress` proposal acquires proposal FSM locks on its targets, blocking other exclusive transitions for both agents and other humans
- POST /api/proposals/:id/cancel for human writer proposals discards edits

---

## 9c. Structural Normalization (`crdt/`)

Structural normalization is owned by CRDTProposalGenerator and runs inside a
single identity-preserving `Y.transact`, triggered by per-section CRDT-activity
quiescence (not a session-wide timer, focus, or session-end). It mutates the live
Y.Doc and the `inprogress` proposal content tree; there is no raw-fragment /
canonical-ready disk pair (spec 05 "Structural Normalization").

### `crdt-structural-normalization.test.ts`
- No-op for a root body edit (no headings in root fragment) and for a simple body edit (heading/level unchanged)
- Splits a section when additional headings are typed; identity is preserved (split keeps the original fragment as one half)
- Renames a heading when text changes but level stays
- Handles heading-level changes (updates skeleton nesting)
- Handles heading deletion (orphaned content merged into the survivor; merge extends the survivor)
- Atomicity: peers/observers see only pre- or post-state; the YJS_UPDATE delta is the broadcast (no STRUCTURE_WILL_CHANGE / doc:structure-changed signal)
- Pre-flight clock check on affected fragments aborts and retries on concurrent Y.Doc movement

---

## 11. CRDT / Y.Doc (`crdt/`)

### `ydoc-lifecycle.test.ts`
- Creating a DocSession initializes the Y.Doc with per-section fragments from canonical
- A DocSession with a current inprogress proposal reconstructs the Y.Doc from that proposal content tree (else from canonical)
- Adding a holder increments the holders set
- Removing the last holder defers to YDocLifecycleManager's retain-vs-discard policy; the inprogress proposal carries in-flight state across disconnect (no overlay import, no idle teardown)
- lookupDocSession returns session by docPath
- getAllSessions returns all active sessions
- getSessionsForWriter returns sessions where writer is a holder

### `ydoc-fragments.test.ts`
- fragmentKeyFromSectionFile produces correct fragment keys (section::sec_abc123def)
- sectionFileFromFragmentKey extracts section file stem from fragment key
- ROOT_FRAGMENT_KEY is used for root sections (level=0, heading="")

### `heading-deletion-merge-target.test.ts`
- Sibling merge: delete ## B merges orphaned content into ## A
- Nested sibling merge: delete ### SubB merges into ### SubA
- First child merge: delete ### SubA merges into ## B (parent body)
- First top-level section: delete ## A merges into root

---

## 12. WebSocket — Hub (`ws/`)

### `ws-hub.test.ts`
- Hub accepts WebSocket connections on /ws
- broadcast sends JSON event to all connected clients
- Disconnected clients are cleaned up
- Events include type field for client routing

### `ws-hub-events.test.ts`
- content:committed event contains doc_path, sections, commit_sha, source, writer info
- agent:reading event contains actor_id, actor_display_name, doc_path, heading_paths
- section block-state events (section:blocked, section:unblocked, section:gone) carry doc_path + section identity and keep frontend editability aligned with server reality

---

## 13. WebSocket — CRDT Sync (`ws/`)

### `crdt-sync.test.ts`
- Client connects to /ws/crdt/:docPath (per-document, no heading_path param) and receives sync step 2 with the full doc state
- Client sends YJS_UPDATE and other clients receive it
- DOC_PUBLISH_PAUSE_START (0x10) is sent to active editor sockets when a publish attempt begins
- DOC_PUBLISH_READY (0x11) ack from each active editor socket is required before publish proceeds (ordered on the editor channel)
- DOC_PUBLISH_PAUSE_END (0x12) is sent when the publish attempt ends (commit or abort); editors unfreeze only after it
- AWARENESS messages are relayed between clients
- Disconnect removes holder from DocSession
- Legacy SECTION_FOCUS / ACTIVITY_PULSE / SESSION_OVERLAY / STRUCTURE_WILL_CHANGE (0x08) opcodes are gone; opcode 0x08 is permanently reserved-removed

---

## 14. Admin (`admin/`)

### `admin-config.test.ts`
- GET /api/admin/config returns current config with preset description
- PUT /api/admin/config updates human-involvement preset
- PUT /api/admin/config rejects invalid preset names with 400

### `admin-snapshot-health.test.ts`
- GET /api/admin/snapshot-health returns snapshot cache status

---

## 15. Publish (`publish/`)

### `publish.test.ts`
- POST /api/publish commits dirty sections for authenticated human
- POST /api/publish returns committed_head and sections_published count
- POST /api/publish returns 404 when no dirty sections exist
- POST /api/publish returns 403 for agent callers
- POST /api/publish with doc_path scopes to that document
- POST /api/publish with heading_paths scopes to specific sections

---

## 17. Crash Recovery (`recovery/`)

### `crash-recovery.test.ts`
- Interrupted `committing` proposals are finished forward, NEVER rolled back: if meta.json already carries committed_head, finalize the committing -> committed rename; otherwise rerun publishCommittingProposalToCanonical from proposals/committing/{id}/content
- `pending` proposals are deleted as transient debris on startup
- `inprogress` proposals are treated as durable live state and preserved
- The dirty working tree is used only to complete an interrupted committing proposal, else startup fails with a maintainer report (never a silent rollback)

---

## 18. Content Import (`import/`)

### `content-import.test.ts`
- importContentFromDirectoryIfNeeded imports markdown files from import directory
- Imported files are converted to skeleton + section structure
- Import is idempotent — second run is a no-op
- Git commit records the import

---

## 19. CRDT Observer (`crdt-observer/`)

### `crdt-observer-sync.test.ts`
- Observer WS to /ws/crdt-observe/<docPath> connects successfully
- Observer receives initial Y.Doc state when editing session exists
- Observer receives MSG_YJS_UPDATE when editor makes changes (including the normalization Y.transact delta)
- Observer connection has no effect on Y.Doc retention policy or commit cadence
- Observer connection does NOT trigger any session/presence side-effects
- Observer disconnect does NOT trigger any canonical commit
- When the last editor disconnects, observer sockets are closed with code 4021 (session_ended) and fall back to REST
- Observer that connects before any editor receives sync when editor joins
- Observer that sends MSG_YJS_UPDATE is ignored (no Y.Doc mutation)
- Multiple observers + one editor: all observers see editor's changes

---

## File Organization

```
backend/src/__tests__/
  auth/
    auth-registration.test.ts
    auth-login.test.ts
    auth-token-refresh.test.ts
    auth-session.test.ts
    auth-logout.test.ts
    auth-middleware.test.ts
  documents-read/
    document-get.test.ts
    document-sections.test.ts
    document-structure.test.ts
    document-changes-since.test.ts
  documents-write/
    document-create.test.ts
  documents-tree/
    documents-tree.test.ts
  sections/
    section-read.test.ts
  proposals/
    proposal-create.test.ts
    proposal-single-pending-invariant.test.ts
    proposal-modify.test.ts
    proposal-commit.test.ts
    proposal-cancel.test.ts
    proposal-list.test.ts
    proposal-read.test.ts
  heatmap/
    heatmap.test.ts
  domain/
    agent-write-policy.test.ts
    proposal-fsm-locks.test.ts
    human-involvement-presets.test.ts
  storage/
    document-skeleton.test.ts
    heading-resolver.test.ts
    document-reader.test.ts
    section-reader.test.ts
    path-utils.test.ts
    git-repo.test.ts
    proposal-store.test.ts
    commit-pipeline.test.ts
    section-commit-history.test.ts
    activity-reader.test.ts
  proposals-publish/
    publish-pipeline.test.ts
    human-proposals.test.ts
  crdt/
    ydoc-lifecycle.test.ts
    ydoc-fragments.test.ts
    crdt-structural-normalization.test.ts
  ws/
    ws-hub.test.ts
    ws-hub-events.test.ts
    crdt-sync.test.ts
  admin/
    admin-config.test.ts
    admin-snapshot-health.test.ts
  publish/
    publish.test.ts
  recovery/
    crash-recovery.test.ts
  import/
    content-import.test.ts
  crdt-observer/
    crdt-observer-sync.test.ts
  helpers/
    auth.ts              (reuse: token generation for test requests)
    temp-data-root.ts    (reuse: isolated temp dirs per test)
    test-server.ts       (new: supertest app factory with onWsEvent capture)
    sample-content.ts    (new: canonical doc fixtures with known sections)
```

## Test Helpers Needed

### `test-server.ts`
Factory that creates an Express app + HTTP server with:
- Captured WsServerEvents for assertion
- Pre-initialized temp data root with git repo
- Auth tokens for human and agent test users
- Cleanup on afterAll

### `sample-content.ts`
Creates a known document structure on disk:
- A multi-section document with nested headings
- A second document for cross-document proposal tests
- Known content strings for assertion

### Existing helpers to keep
- `auth.ts` — token generation
- `temp-data-root.ts` — temp directory lifecycle
