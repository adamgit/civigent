# Crash Recovery & Data Safety

> This document describes how the system recovers from crashes, the on-disk data roots, their corruption modes, and the self-healing design. It is a living document — update it as recovery logic evolves.

---

## Design: self-healing documents

When the server crashes mid-operation, documents can end up in a state where some editing session data cannot be cleanly applied. The system's recovery strategy is designed around one rule: **the document is always functional, and any unrecoverable content is placed into the document itself for the user to deal with using normal editing.**

There are no notifications, no banners, no merge-conflict dialogs, no quarantine states. The document is the recovery interface.

### How it works

After a crash, the system rebuilds each affected document in layers:

1. **Start from git HEAD.** Restore canonical to the last fully committed state. This is always valid and complete. The document is now servable and editable.

2. **Apply session body files.** For each section in the canonical skeleton, check if a session body file exists (matched by section filename). If yes, use the session body — it contains the user's most recent edits. If no, keep the canonical body.

3. **Collect orphaned session content.** Session body files that don't match any section in the canonical skeleton are "orphans." These are bodies from sections that were created, renamed, or structurally corrupted during the crash. Their content — the part the user actually cares about — may still be valuable.

4. **Append orphaned content as a document section.** If there are orphaned bodies with non-empty content, append a section to the document:

```markdown
## Recovered edits

The following content was found in an editing session that could not be
cleanly applied to this document. The session's structure was damaged
during a server restart. This content may duplicate or update sections
already in this document.

Review this content and move anything useful into the appropriate
section above, then delete this section when done.

| Section | Status |
|---|---|
| Background | Applied to existing section |
| Current major work projects | Could not be matched — content below |

### Current major work projects

[the orphaned body content appears here verbatim]
```

5. **Commit the healed document.** The recovered state (canonical skeleton + session bodies + recovery section) is committed to git. The recovery section is a real section — it appears in the editor, in the section navigator, in the skeleton. It is part of the document's git history.

### Why this works

- **Bodies are what matter.** Section titles are small and trivially re-created. Section bodies contain hours of human thought. The system preserves bodies above all else.
- **No merge interface.** The recovery section is just content in a document. The user reads it, copies what they need into the right place, and deletes the section. This is normal editing, not conflict resolution.
- **Every visitor sees the same thing.** Sessions are per-document, not per-user. The recovery section is written into the document structure, so all users opening the doc see it. Whoever gets to it first can clean it up.
- **Self-documenting.** The table in the recovery section tells the user what happened: which sections were recovered normally, which are orphaned. No external UI needed.
- **Naturally disappears.** Once the user deletes the recovery section, it's gone. The next commit records the cleanup in git history.
- **Idempotent.** If the system crashes again before the user cleans up, the recovery section just stays there. It's a normal section.

### What `FragmentStore.fromDisk` must guarantee

`FragmentStore.fromDisk` must **always succeed** — it must never throw due to corrupt session data. Instead it returns:

- A functional Y.Doc (built from canonical skeleton + best-effort session bodies)
- A list of orphaned bodies (session files that couldn't be matched to the skeleton)

The caller checks for orphaned bodies and, if any exist, appends the recovery section before handing the Y.Doc to the CRDT sync layer. The WebSocket connection is never rejected due to session data problems.

---

## The core principle

There are five content roots on disk, plus the git repo itself. They form a **freshness hierarchy**:

```
Raw Fragments > Session Overlay > Canonical (committed) > Git History
  (freshest)                                                (safest)
```

Recovery flows **right to left**: start from the safest baseline (git HEAD), then layer on progressively fresher data.

Canonical is a **cache of committed state**. It can always be rebuilt from git HEAD. Session data (overlay + raw fragments) is the source of truth for uncommitted work.

**Recovery = restore cache from git + apply source of truth + surface anything that couldn't be applied.**

The dangerous anti-pattern is committing a half-written canonical state (cementing corruption), then deleting session files (destroying the only recovery path).

---

## Data roots

### A. Canonical — `data/content/`

The single source of truth. Every committed document skeleton + body file lives here. Backed by a git repo rooted at `data/`.

**Lifetime:** Permanent. Created on first import or document creation. Only modified through git-committed writes.

**Mutators:**
- `commitHumanChangesToCanonical` — writes body files via `resolveHeadingPath`, then `git add && commit`
- `commitProposalToCanonical` — `promoteOverlay()` (rewrites skeleton, deletes orphans), writes body files, `git add && commit`
- `commitSessionFilesToCanonical` — same pattern: `promoteOverlay()` then body writes then commit
- Direct writes in API routes (create doc, move section, rename section, import)
- MCP filesystem tools (`write_file`, `write_files`)

**Corruption modes:**

| Wrong state | Cause | Impact if left | Impact if lost | What to do |
|---|---|---|---|---|
| Skeleton references missing body files | Half-finished `promoteOverlay` | Readers crash with ENOENT on those sections | N/A — this IS loss | `git checkout -- content/` to restore last committed state, then re-apply session overlay |
| Body file overwritten with sub-skeleton content | `resolve()` returned wrong path (now fixed) | Document structure destroyed, HeadingNotFoundError | N/A | Same as above |
| Orphan body files (no skeleton entry) | `promoteOverlay` deleted old skeleton entries but crash before new ones written | Wasted disk space, no functional impact | Fine to lose | Harmless, cleaned up on next skeleton write |
| Staged but uncommitted changes | Crash between `git add` and `git commit` | `git status` shows dirty, next operations may be confused | Git reset restores clean state | `git checkout -- content/` (not `git add && commit`!) |

**Summary:** Canonical's "wrong" states are all from interrupted multi-step writes. The fix is always the same: restore from git HEAD (the last complete commit), then re-apply session data. We never want to commit a half-written canonical state.

---

### B. Session Overlay (docs) — `data/sessions/docs/content/`

Mirrors the `content/` structure. When a Y.Doc is flushed to disk, normalized body files land here. Skeleton files are also written here when structural changes happen (heading renames, splits). Read with overlay-first semantics: `new ContentLayer(sessionDocsContent, new ContentLayer(canonical))`.

**Lifetime:** Created when `flush()` runs on a dirty Y.Doc. Deleted by `cleanupSessionFiles()` after successful commit, or on crash recovery.

**Mutators:**
- `FragmentStore.flush()` — writes body files + skeleton via `skeleton.ensureOverlayExists()`
- `FragmentStore.normalizeStructure()` — skeleton mutations + body writes on structural changes
- `cleanupSessionFiles()` — `rm -rf`

**Corruption modes:**

| Wrong state | Cause | Impact if left | Impact if lost | What to do |
|---|---|---|---|---|
| Overlay has newer content than canonical | Normal operation (user edited, not yet committed) | This IS the normal state | **DATA LOSS** — user's uncommitted work gone | Commit to canonical, then clean up |
| Stale overlay (already committed) | Crash between commit and cleanup | Re-committed on recovery (idempotent, harmless) | No impact | Clean up |
| Partial overlay (some sections flushed, others not) | Crash during multi-section flush | Missing sections fall through to canonical (correct behavior) | Lost sections fall through to canonical (also correct) | Commit what's there, canonical fills gaps |
| Skeleton without matching body files | Structural change persisted but body not yet written | Readers fall through to canonical for body (correct) | Falls through to canonical (correct) | Normal — overlay is sparse by design |

**Summary:** Session overlay is almost always "right" or harmlessly stale. The only catastrophic scenario is deleting it when canonical is also corrupt. **Never delete session files unless canonical is known-good.**

---

### C. Raw Fragments — `data/sessions/fragments/{docPath}/`

Raw markdown fragments directly from Y.XmlFragment serialization. Each file contains heading + body together (not yet split into canonical format). Written on every `flush()` as a crash-safe format.

**Lifetime:** Created on `flush()`, consumed by `recoverRawFragments()` during crash recovery, deleted by `cleanupSessionFiles()`.

**Mutators:**
- `writeRawFragment()` — writes on flush
- `deleteRawFragment()` / `deleteAllRawFragments()` — cleanup
- `cleanupSessionFiles()` — `rm -rf`

**Corruption modes:**

| Wrong state | Cause | Impact if left | Impact if lost | What to do |
|---|---|---|---|---|
| Raw fragments exist (not yet normalized) | Normal — waiting for recovery to process | Processed by `recoverRawFragments()` | Lost user edits | Process into session overlay, then delete |
| Truncated fragment file | Power loss during write | Bad markdown, may cause parse errors | Lost that one section's latest edit | Skip truncated files, fall back to overlay/canonical |
| Stale fragments (already processed/committed) | Crash between commit and cleanup | Re-processed (idempotent) | No impact | Clean up |

**Summary:** Same as session overlay — critical during recovery, harmless if stale. Never delete unless committed.

---

### D. Proposal Overlay — `data/proposals/{status}/{proposalId}/content/`

Each proposal has its own content root. Agent writes go here. On commit, `promoteOverlay()` copies skeleton to canonical and body files are read from here.

**Lifetime:** Created with `createProposal()`. Moves between `pending/`, `committing/`, `committed/`, `withdrawn/` directories (atomic directory rename). Kept indefinitely after commit for history.

**Mutators:**
- MCP tools (`write_section`, `create_section`, `move_section`, etc.) — write to proposal's content root
- API routes (proposal create, update sections, PATCH)
- `transitionToCommitting()` / `transitionToCommitted()` — directory rename (state FSM)

**Corruption modes:**

| Wrong state | Cause | Impact if left | Impact if lost | What to do |
|---|---|---|---|---|
| Partial content | Agent crashed mid-write | Incomplete proposal, agent can resume | Agent re-generates | Let agent resume or user cancel |
| Stuck in `committing/` | Crash during commit | Blocks new proposals from same agent | Rollback to pending works | `rollbackCommittingToPending()` — already handled |
| Content after commit (`committed/`) | Normal | Historical record | Lose proposal history | Keep for audit trail |

**Summary:** Proposal content is agent-generated and re-generable. Loss is inconvenient, not catastrophic.

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
- **During recovery:** `commitSessionFilesToCanonical` iterates the skeleton's `forEachSection` — orphaned sections are silently skipped. Their session overlay content is never committed, then `cleanupSessionFiles` deletes it.

**Duplicate root entries** (two `level=0, heading=""` nodes):
- `validateNoDuplicateRoots()` in `DocumentSkeleton.fromDisk()` **throws immediately**.
- **Consequence:** Any code path that loads this skeleton crashes. During recovery, `recoverRawFragments` calls `FragmentStore.fromDisk` which calls `DocumentSkeleton.fromDisk` — the throw propagates up to `recoverSessionFiles` which catches it and (currently, pre-fix) proceeds to delete the session files.

**Skeleton references a section file that doesn't exist on disk:**
- `readFile` throws ENOENT. In `readAssembledDocument`, this is caught and the section is added to `missingSections[]`, eventually throwing `DocumentAssemblyError`.
- In `readSection`, ENOENT falls through to the fallback layer. If no fallback, throws `SectionNotFoundError`.
- In `commitSessionFilesToCanonical`, the `forEachSection` loop tries `readFile(absolutePath)` and catches ENOENT → skips that section. The section is silently not committed.
- **During recovery:** Missing body files cause sections to be silently dropped from the commit. Not an error, but silent data loss.

### B. Session Overlay — illegal content

**Overlay skeleton file exists but is empty or malformed:**
- `DocumentSkeleton.fromDisk(docPath, overlayRoot, canonicalRoot)` tries overlay first. An empty file produces zero entries → `skeleton.isEmpty` is true.
- The overlay "wins" over canonical because overlay existed → `overlayExisted = true`. The canonical skeleton is never consulted.
- **Consequence:** During `commitSessionFilesToCanonical`, the skeleton appears empty — no sections to commit. The overlay skeleton masks the canonical skeleton entirely.
- **During recovery:** `recoverSessionFiles` commits zero sections (skeleton says the doc is empty), then deletes session files. Canonical retains its pre-crash state but session edits are lost.

**Body file contains markdown with embedded headings (multi-section content in a single file):**
- `readFile` succeeds — it's valid UTF-8. The content is used as-is.
- In `commitHumanChangesToCanonical`, the body file is written to canonical verbatim. The skeleton still points to it as a single section. Readers assemble the document with this section's body containing headings that don't match the skeleton structure.
- **Consequence:** The assembled document has duplicate/phantom headings — the skeleton's heading plus embedded ones. Document structure and UI become inconsistent.
- **During recovery:** Same — the multi-heading content is committed to canonical as a single section body. Not a crash, but structural corruption that persists.

**Overlay body file is binary/non-UTF-8:**
- `readFile(path, "utf8")` in Node returns a string with replacement characters (U+FFFD). No throw.
- The garbled content is committed to canonical as if it were valid markdown.
- **During recovery:** Binary content is committed. Persistent corruption of that section.

### C. Raw Fragments — illegal content

**Truncated markdown (power loss mid-write):**
- `readRawFragment` returns the truncated string. `markdownToJSON()` (ProseMirror parser) is tolerant — it produces a valid document node from whatever partial markdown it gets.
- `prosemirrorJSONToYDoc` succeeds. The truncated content becomes the Y.Doc state.
- **Consequence:** The section has truncated content, but no crash. During `normalizeStructure`, the truncated content is parsed and may produce unexpected structural changes (e.g., if a heading line was cut mid-write).
- **During recovery:** `recoverRawFragments` calls `FragmentStore.fromDisk` which loads truncated content into a Y.Doc, then `normalizeStructure` may misinterpret the structure. The truncated content is written to session overlay, then committed to canonical.

**Raw fragment file exists for a section not in the skeleton:**
- `FragmentStore.fromDisk` iterates `skeleton.forEachSection` and checks `rawFileSet.has(sectionFile)`. Extra raw files not referenced by the skeleton are silently ignored — never loaded into Y.Doc.
- **Consequence:** Orphaned raw fragments. No crash, no data corruption, but the content in those files is lost.
- **During recovery:** `recoverRawFragments` lists raw files, iterates them, calls `fragmentKeyFromSectionFile` to get a key, then `fragments.normalizeStructure(fragmentKey)`. If the fragment key doesn't resolve in the skeleton (`resolveEntryForKey` returns null), normalization is a no-op. The raw file remains on disk until `cleanupSessionFiles` deletes it.

**Raw fragment references a section file that changed names (heading rename before crash):**
- The raw file has the old filename. The skeleton has the new filename. `rawFileSet.has(sectionFile)` misses it — the raw content is not loaded. Falls back to overlay/canonical which may have stale content.
- **Consequence:** The freshest edit (in the raw fragment) is silently ignored in favor of older content.
- **During recovery:** Same — the raw fragment is orphaned by the rename. Its content is lost.

### D. Proposal Overlay — illegal content

**Proposal `meta.json` is malformed/truncated:**
- `JSON.parse` throws. Proposal listing endpoints catch this and skip the proposal.
- **Consequence:** The proposal is invisible in the UI but its directory still exists. Not a crash.
- **During recovery:** `recoverCommittingProposals` lists directories in `committing/`, calls `rollbackCommittingToPending` which does a directory rename — doesn't read `meta.json`. Recovery succeeds even with malformed metadata. The proposal becomes visible in `pending/` but may fail to load when accessed.

**Proposal skeleton is malformed:**
- Same as canonical skeleton — `parseSkeletonToEntries` silently drops unparseable lines. Commit reads fewer sections than expected.
- **Consequence:** Partial proposal commit. Some sections silently missing from the committed result.

### E. Git Repo — illegal state

**HEAD points to a nonexistent commit (corrupt ref):**
- `git rev-parse HEAD` fails. `getHeadSha` throws.
- **Consequence:** Any commit operation fails. `recoverDirtyWorkingTree` crashes on `git status`.
- **During recovery:** `detectAndRecoverCrash` throws before any recovery logic runs. Server fails to start. Session files are preserved (no cleanup ran) — this is the correct outcome.

**Index/staging area is corrupt:**
- `git add` or `git status` fails with git internal errors.
- **Consequence:** Same as above — recovery throws, server doesn't start, session files preserved.

### Summary: the silent-drop problem

The most dangerous pattern across all roots is **silent dropping**:

- `parseSkeletonToEntries` silently drops unparseable lines → sections vanish
- `forEachSection` skipping sections whose body files are ENOENT → silent data loss
- Raw fragments for renamed sections silently ignored → freshest edits lost
- Empty/malformed overlay skeleton masking canonical → all sections invisible

In every case, the code **does not crash** — it produces a partial result and continues. During normal operation this is arguably the right behavior (graceful degradation). But during **crash recovery**, silent dropping means data is silently lost and then `cleanupSessionFiles` destroys the evidence.

The self-healing design addresses this: orphaned content is never silently dropped. It is placed into the document as a recovery section, where the user can see it, evaluate it, and deal with it through normal editing.

---

## Known bugs (pre-fix)

These bugs are tracked in `TRANSIENT WORKING DOCS/checklist.md` with full analysis in `TRANSIENT WORKING DOCS/crash-recovery-proposal.md`.

1. **`recoverDirtyWorkingTree` commits corrupt canonical.** It does `git add content/ && git commit` on any dirty tracked files, cementing half-finished `promoteOverlay()` state into history. Should `git checkout -- content/` instead.

2. **`cleanupSessionFiles` runs unconditionally.** Even when `commitSessionFilesToCanonical` throws, session files are deleted. Should only clean up on success.

3. **Recovery ordering is wrong.** `recoverDirtyWorkingTree` runs before session recovery, so session recovery sees a canonical that was corrupted-then-committed. Should restore canonical first, then apply session data.

4. **`FragmentStore.fromDisk` throws on corrupt session data.** If the session skeleton is corrupt (e.g., duplicate headings), the entire document becomes inaccessible — the CRDT WebSocket rejects the connection with error 4014. Should always return a functional Y.Doc built from canonical, with orphaned session content collected for the recovery section.
