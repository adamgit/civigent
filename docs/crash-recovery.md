# Crash Recovery & Data Safety

> This document describes how the system recovers from crashes, the on-disk data roots, their corruption modes, and the proposal-backed recovery contract (finish-forward `committing`, durable `inprogress`, reconstruct from `inprogress` else canonical). It is a living document — update it as recovery logic evolves.

---

## Design: single-sourced live state

When the server crashes mid-operation, in-flight live editing is not scattered across a separate session tier that must be reconciled. Live edits flow continuously into the relevant `inprogress` proposal content tree through the proposal subsystem, so the durable representation of uncommitted work is always a structured, skeleton-resolved proposal — not a loose pile of body/fragment files that might or might not match the current skeleton.

This collapses the legacy "rebuild the document in layers, then surface orphans the user has to clean up" design. There is no orphaned-session-body collection step and no machine-generated "Recovered edits" section, because there is no parallel session tier whose structure can diverge from canonical.

### How it works

After a crash, the system has two jobs (see "Recovery contract (as implemented)" below):

1. **Finish forward any interrupted publish.** A `committing` proposal is finalized (or its absorb re-run from `proposals/committing/{id}/content`) so canonical lands exactly the work that was being published. A `pending` proposal is discarded as transient debris. An `inprogress` proposal is left untouched as durable live state.

2. **Reconstruct the live Y.Doc on next mount.** When a document is next opened, `YDocLifecycleManager` / `CRDTProposalGenerator` rebuild the Y.Doc from the current `inprogress` proposal content tree when one exists, otherwise from canonical, then run any required structural normalization before accepting connections.

The document is always servable: canonical is the safe baseline (rebuildable from git HEAD), and the `inprogress` proposal carries the freshest in-flight edits in a form that already resolves against the skeleton.

### Why this works

- **One durable in-flight surface.** Live edits and canonical advance through the same proposal subsystem, so there is no second durability surface to merge back and no skeleton-mismatch to reconcile.
- **No merge interface, no quarantine.** Recovery either finishes a publish forward or leaves durable `inprogress` work in place; the user simply resumes editing the live document.
- **Never rolls back.** A `committing` proposal may have already advanced canonical; finishing forward is idempotent, whereas a rollback could silently drop landed work.
- **Idempotent.** A second crash before completion leaves the same `committing`/`inprogress` proposal to finish on the next start.

### What Y.Doc reconstruction must guarantee

When a document is mounted after a restart (`YDocLifecycleManager` / `CRDTProposalGenerator`), Y.Doc reconstruction must **always succeed** for a servable document. Reconstruction is single-sourced (spec `05-ydoc-lifecycle.md` › Y.Doc Construction, Crash Recovery):

1. If a relevant `inprogress` proposal exists for the document, reconstruct the Y.Doc from that proposal's content tree, then run any required structural normalization before accepting connections.
2. Otherwise, build the Y.Doc from canonical only.

There is no session-overlay or raw-fragment precedence to consult, no orphaned-session-body collection step in this path, and no per-section "best-effort session body" merge. The proposal content tree (or canonical) is already a structured, skeleton-resolved representation, so a connection is never rejected because of a parallel session-data tier — there is no such tier.

---

## The core principle

There is no separate session-overlay or raw-fragment storage tier. In-flight live editing is durably represented by the relevant `inprogress` proposal content tree (spec `05-ydoc-lifecycle.md` › Disk Persistence Layout). The durable roots that matter to recovery form a short **freshness hierarchy**:

```
inprogress proposal > Canonical (committed) > Git History
  (freshest in-flight)                          (safest)
```

On restart, a document's live Y.Doc is reconstructed from the current `inprogress` proposal content tree when one exists, otherwise from canonical. Canonical remains a **cache of committed state** that can always be rebuilt from git HEAD.

Live edits and canonical advance through the existing proposal subsystem, so there is no parallel "uncommitted session" surface to merge back: the `inprogress` proposal *is* the durable representation of uncommitted live work, and `proposals/committing/{id}/content` is the durable representation of a publish that was in flight when the crash hit.

**Recovery = finish forward any interrupted `committing` proposal, discard transient `pending` debris, leave `inprogress` durable, and rebuild the live Y.Doc from `inprogress` else canonical.**

The dangerous anti-pattern is rolling a `committing` proposal backwards (it may have already advanced canonical) or committing a half-written canonical state. Recovery never rolls back and never silently commits a dirty tree it cannot explain.

---

## Data roots

### A. Canonical — `data/content/`

The single source of truth. Every committed document skeleton + body file lives here. Backed by a git repo rooted at `data/`.

**Lifetime:** Permanent. Created on first import or document creation. Only modified through git-committed writes.

**Mutators:** all canonical advances now flow through the proposal subsystem; there is no session-to-canonical commit path.
- `commitProposalToCanonical` / `publishProposalToCanonical` — absorbs a proposal's content tree into canonical (rewrites skeleton, writes body files), then `git add && commit`. This is the single absorb path used by both agent proposals and CRDTProposalGenerator-authored `inprogress` proposals.
- `publishCommittingProposalToCanonical` — the finish-forward re-run used by crash recovery for an interrupted `committing` proposal (idempotent; the absorb commits with `--allow-empty`).
- Direct writes in API routes that themselves go through proposal editing (create doc, move section, rename section, import).

**Corruption modes:**

| Wrong state | Cause | Impact if left | Impact if lost | What to do |
|---|---|---|---|---|
| Skeleton references missing body files | Half-finished absorb (crash mid-`commitProposalToCanonical`) | Readers crash with ENOENT on those sections | N/A — this IS loss | Finish forward the interrupted `committing` proposal (re-run absorb from `proposals/committing/{id}/content`), which re-derives a complete canonical state |
| Orphan body files (no skeleton entry) | Absorb deleted old skeleton entries but crash before new ones written | Wasted disk space, no functional impact | Fine to lose | Harmless, cleaned up on next skeleton write |
| Staged but uncommitted changes | Crash between `git add` and `git commit` | `git status` shows dirty | Recovery completes the `committing` proposal, which produces the commit | If the dirty tree is the by-product of an interrupted `committing` proposal, finish it forward; otherwise startup fails with a maintainer report (never silently committed) |

**Summary:** Canonical's "wrong" states are all from an interrupted proposal absorb. The fix is to finish that `committing` proposal forward (re-run the absorb), never to roll back or to blindly commit a dirty tree.

---

### B. Proposal content trees — `data/proposals/{status}/{proposalId}/content/`

Each proposal has its own content root, the durable representation of staged mutations over the canonical `DocumentSkeleton` (written through `ProposalEditor`). This is also where in-flight live editing lives: a live `DocSession`'s current `inprogress` proposal content tree carries the user's most recent CRDT edits across disconnects and restarts. There is no separate `sessions/` overlay or `sessions/fragments/` raw tier — those storage surfaces are removed.

**Lifetime:** Created with `createProposal()` (or lazily by the `DocSession` actor on the first materialized CRDT edit). Moves between `pending/`, `inprogress/`, `committing/`, `committed/`, `withdrawn/` directories by atomic directory rename. A committed proposal's content is kept indefinitely for history.

**Mutators:**
- `ProposalEditor` (`writeSection`, `createSection`, `moveSection`, etc.) — writes to the proposal's content root, for both agent proposals and CRDTProposalGenerator-authored `inprogress` proposals
- MCP tools / proposal API routes — drive the above for agent proposals
- `CRDTProposalGenerator` — materializes live Y.Doc edits into the current `inprogress` proposal content tree
- Proposal-FSM transitions (`inprogress -> committing -> committed`) — directory rename, owned by `proposal-repository` / `commit-pipeline`

**Corruption modes:**

| Wrong state | Cause | Impact if left | Impact if lost | What to do |
|---|---|---|---|---|
| Partial `inprogress` content | Crash mid-edit | The live Y.Doc reconstructs from whatever last landed in the tree; user resumes editing | User loses only the unmaterialized tail of edits | Reconstruct Y.Doc from `inprogress`, resume — no rollback |
| Stuck in `committing/` | Crash during publish | Blocks new exclusive transitions on its targets | Finish-forward re-derives the commit | Finished forward, never rolled back (see recovery flow) |
| Partial agent-proposal content | Agent crashed mid-write | Incomplete proposal; agent can resume or user cancels | Agent re-generates | Let agent resume or user cancel |
| Content after commit (`committed/`) | Normal | Historical record | Lose proposal history | Keep for audit trail |

**Summary:** Proposal content is the single durable in-flight surface. `inprogress` is durable live state (never rolled back); `committing` is finished forward; `pending` is transient debris; `committed` is history.

---

### C. (removed) Session Overlay & Raw Fragments

The legacy `data/sessions/sections/` overlay tier and `data/sessions/fragments/` raw-fragment tier no longer exist. `sessions/` is not a durable storage surface in this architecture (spec `05-ydoc-lifecycle.md` › Disk Persistence Layout, Session Persistence). All in-flight live state is the `inprogress` proposal content tree described above; there is no overlay-first read path, no `flush()`/`cleanupSessionFiles()` lifecycle, and no raw-fragment recovery buffer.

---

### E. Git Repo — `data/.git/`

Version history for everything under `data/content/` and `data/proposals/`. Provides the "last known good" baseline.

**Lifetime:** Permanent. Initialized on first startup.

**Mutators:**
- `gitExec(["commit", ...])` in commit-pipeline, auto-commit, crash-recovery
- `gitExec(["add", ...])` staging

**Corruption modes:**

| Wrong state | Cause | Impact if left | Impact if lost | What to do |
|---|---|---|---|---|
| Dirty working tree | Crash between file writes and commit | Confuses recovery logic | `git checkout --` restores HEAD | Restore, don't commit the mess |
| Dirty index (staged, not committed) | Crash between `git add` and `git commit` | Same | `git reset` clears index | Restore |
| Corrupt pack/objects | Power loss during git internals | Git commands fail | Re-init + commit from canonical | Extremely rare, git is crash-safe |

**Summary:** Git is the safety net. Its "wrong" states are almost always a dirty working tree, which should be *restored* not *committed*.

---

## What happens when on-disk data is illegal/malformed?

Beyond "wrong but structurally valid" data (stale, partial, inconsistent), each root can contain data that is structurally illegal — files that violate format assumptions. This section traces what happens when the app loads such data during startup, crash recovery, or normal operation.

### A. Canonical — illegal skeleton content

**Malformed skeleton file** (e.g., truncated write, binary garbage, missing `{{section:}}` markers):
- `parseSkeletonToEntries()` silently skips non-matching lines. A truncated skeleton produces fewer entries than expected — some sections become invisible.
- `DocumentSkeleton.fromDisk()` succeeds with a partial tree. No error thrown.
- **Consequence:** Sections whose skeleton entries were lost are orphaned on disk. The app serves a document missing those sections. Body files still exist but nothing points to them.
- **During recovery:** Canonical is not rewritten from any session tier. If an interrupted `committing` proposal exists, finishing it forward re-derives a complete canonical skeleton from `proposals/committing/{id}/content`; otherwise the partial skeleton is served as-is and fixed through normal editing.

**Duplicate root entries** (two `level=0, heading=""` nodes):
- `validateNoDuplicateRoots()` in `DocumentSkeleton.fromDisk()` **throws immediately**.
- **Consequence:** Any code path that loads this skeleton crashes. Because Y.Doc reconstruction sources from the `inprogress` proposal content tree (or canonical), a corrupt canonical skeleton is surfaced as a load error rather than masked by a parallel session skeleton; recovery never silently deletes uncommitted work to "fix" it.

**Skeleton references a section file that doesn't exist on disk:**
- `readFile` throws ENOENT. In `readAssembledDocument`, this is caught and the section is added to `missingSections[]`, eventually throwing `DocumentAssemblyError`.
- In `readSection`, ENOENT falls through to the fallback layer. If no fallback, throws `SectionNotFoundError`.
- **During recovery:** Missing body files are not "filled in" from a session tier. A `committing` proposal re-run re-derives the complete content; otherwise the assembly error surfaces and is fixed through normal editing. No silent commit-time drop occurs because canonical is not re-committed from sessions during recovery.

### B. Proposal content — illegal content

**Proposal `meta.json` is malformed/truncated:**
- `JSON.parse` throws. Proposal listing endpoints catch this and skip the proposal.
- **Consequence:** The proposal is invisible in the UI but its directory still exists. Not a crash.
- **During recovery:** A `committing` proposal is finished forward by directory-rename finalize (when `committed_head` is present) or by re-running the absorb from its `content/` tree; the finalize path does not depend on a readable `meta.json` enrichment. A `pending` proposal is discarded as transient debris. An `inprogress` proposal with corrupt metadata is left in place (durable), surfaced for maintainer attention rather than silently destroyed.

**Proposal skeleton is malformed:**
- Same as canonical skeleton — `parseSkeletonToEntries` silently drops unparseable lines. A re-run absorb would read fewer sections than expected.
- **Consequence:** Partial proposal absorb. Some sections silently missing from the absorbed result — fixed through normal editing once surfaced.

### C. Git Repo — illegal state

**HEAD points to a nonexistent commit (corrupt ref):**
- `git rev-parse HEAD` fails. `getHeadSha` throws.
- **Consequence:** Any commit operation fails. The git-integrity phase of `detectAndRecoverCrash` (`recoverDirtyWorkingTree`) cannot run `git status`.
- **During recovery:** Recovery throws before completing; the server fails to start with a maintainer report. Durable state (`inprogress`/`committing` proposal content) is preserved because nothing is deleted — this is the correct outcome.

**Index/staging area is corrupt:**
- `git add` or `git status` fails with git internal errors.
- **Consequence:** Same as above — recovery throws, the server does not start, and durable proposal content is preserved.

### Summary: no silent drop, no rollback

The recovery contract removes the legacy silent-drop and rollback hazards by construction:

- There is no session-to-canonical commit during recovery, so there is no `forEachSection`-skips-then-`cleanupSessionFiles`-deletes path to silently lose work.
- `inprogress` proposals are durable and never rolled back or deleted; live state is re-sourced from them.
- `committing` proposals are finished forward (finalize or re-run absorb), never rolled back to `pending`.
- A dirty working tree is only acceptable as the by-product of completing a `committing` proposal; any other dirty state fails startup with a maintainer report instead of being silently committed.

---

## Recovery contract (as implemented)

The legacy session-recovery bug class (commit-corrupt-canonical, unconditional `cleanupSessionFiles`, wrong recovery ordering, `FragmentStore.fromDisk` throwing on corrupt session data) no longer applies: there is no session-recovery path. `crash-recovery.ts` is narrowed to two concerns (spec `05-ydoc-lifecycle.md` › Crash Recovery; `02-proposal-fsm.md`):

1. **Proposal-FSM cleanup.**
   - `pending` proposals are transient debris and are discarded.
   - `committing` proposals are *finished forward*, never rolled back: if `meta.json` already carries an enriched `committed_head` (crash between the enriched-meta write and the atomic dir rename), finalize the `committing -> committed` rename; otherwise re-run `publishCommittingProposalToCanonical` from `proposals/committing/{id}/content` (idempotent — the absorb commits with `--allow-empty`, so a re-run after an already-landed delta is a no-op-delta finalize).
   - `inprogress` proposals are durable live-edit state and are left untouched.

2. **Git integrity.** A dirty working tree is acceptable only as the by-product of completing an interrupted `committing` proposal (the rerun-absorb produces the canonical commit itself, leaving a clean tree). After committing proposals are handled, any remaining dirty tracked `content/` / `proposals/` path fails startup with a maintainer report (`recoverDirtyWorkingTree`).

Recovery functions route their git/fs I/O through `RecoveryContext` so that breadcrumbs (phase, doc, operation) are captured at the exact failure point. There is no session-file reconstruction, merge, or write-back; live CRDT state is re-sourced from the `inprogress` proposal content tree when a document is next mounted.
