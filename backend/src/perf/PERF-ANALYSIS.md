# Performance test analysis

Run: `cd backend && npx vitest run src/perf/`

## Dev-data under test

Three documents in `dev-data/content/`:

| File | Size | Lines |
|------|------|-------|
| test.md | 292 KB | 21,875 |
| tsmaller.md | 133 KB | 10,002 |
| tminor.md | 67 KB | 5,001 |

## Test results

| # | Test | Simulates | Time | Pass/Fail |
|---|------|-----------|------|-----------|
| 1 | Sidebar: auth/session + documents/tree | Opening the app — sidebar loads | 24 ms | PASS |
| 2 | DocumentPage: structure + sections + changes-since | Clicking a document in the sidebar | 1,180 ms | PASS |
| 3 | DocumentPage + enter edit mode | Clicking a section to start editing | 12,710 ms | **FAIL** |
| 4 | DocumentPage + edit mode, then reload sidebar | Navigating away while a CRDT session is active | 13,074 ms (sidebar portion: fast) | PASS |
| 5 | Two docs editing, then open documents view | Two tabs editing different docs, third opens /docs | 15,214 ms (docs view portion: fast) | PASS |

Threshold: any single measured operation > 10 s = failure.

## What each test exercises

### Test 1 — Sidebar

Parallel calls matching `AppLayout` mount:

- `GET /api/auth/session` — token validation, no I/O
- `GET /api/documents/tree` — `readDocumentsTree()` walks `content/` directory

No performance concern. Both endpoints are lightweight.

### Test 2 — DocumentPage load

Parallel calls matching `DocumentPage` mount:

- `GET /api/documents/:docPath/structure` — parses the skeleton (heading tree) from the `.md` and `.sections/` files
- `GET /api/documents/:docPath/sections` — reads all section content, computes involvement scores via `evaluateSectionInvolvementBulk`, runs `readDocSectionCommitInfo` (git log), `resolveAllSectionPaths`, `getDirtySessionFileSet`
- `GET /api/documents/:docPath/changes-since` — git diff since last visit

The `/sections` endpoint is the heaviest — it does bulk disk I/O + git subprocess calls. At ~1.2 s for the largest document, it's within budget but already the dominant cost.

### Test 3 — DocumentPage + enter edit mode

Sequential: load page (test 2 work), then `acquireDocSession`.

`acquireDocSession` calls `constructYDoc` which:

1. `readDocumentStructureWithOverlay` — parses heading tree (fast)
2. `readAllSectionsWithOverlay` — bulk reads all section files (moderate)
3. **For each section**: `initFragmentFromMarkdown(ydoc, fragmentKey, content)` which runs:
   - `markdownToJSON(markdown)` — markdown string → ProseMirror JSON via the milkdown serializer
   - `prosemirrorJSONToYDoc(schema, json, fragmentName)` — ProseMirror JSON → temporary Y.Doc
   - `Y.applyUpdate(targetDoc, Y.encodeStateAsUpdate(tempDoc))` — merge into main Y.Doc

This loop is **synchronous and CPU-bound**. For a document with hundreds of sections (test.md), it blocks the Node.js event loop for 10+ seconds. During this time, no other requests can be served — the server is completely unresponsive.

**This is the primary performance bottleneck.**

### Test 4 — Edit mode + sidebar reload

Setup (untimed): load page + acquire CRDT session.
Timed: sidebar endpoints while CRDT session is in memory.

The sidebar endpoints are unaffected by active CRDT sessions — they don't touch Y.Doc state. This confirms the problem is the *construction* of the Y.Doc, not its *presence* in memory.

### Test 5 — Two docs editing + documents view

Setup (untimed): load two different docs, acquire CRDT sessions for both.
Timed: sidebar endpoints with two active sessions.

Same conclusion as test 4: once sessions are constructed, their presence doesn't degrade other endpoints. The 15s total time is dominated by the two sequential `acquireDocSession` calls during setup.

## Root cause: `constructYDoc` in `ydoc-lifecycle.ts`

Call chain:

```
acquireDocSession (ydoc-lifecycle.ts:124)
  └─ constructYDoc (ydoc-lifecycle.ts:72)
       └─ for each section:
            initFragmentFromMarkdown (ydoc-fragments.ts:46)
              ├─ markdownToJSON         — CPU-bound, synchronous
              ├─ prosemirrorJSONToYDoc  — CPU-bound, synchronous
              └─ Y.applyUpdate          — CPU-bound, synchronous
```

Key file: `backend/src/crdt/ydoc-fragments.ts:46-55`

For each section of the document, three synchronous transforms run back-to-back with no yielding. On a document with many sections, this monopolises the CPU for the entire duration.

### Why two tabs make it worse

When a user opens two documents in separate tabs, each tab triggers `acquireDocSession` independently. Since Node.js is single-threaded:

1. Tab 1 requests CRDT → event loop blocked for ~10 s building Y.Doc for doc 1
2. Tab 2's CRDT request queues behind it → another ~10 s blocked
3. Any other request (sidebar refresh, section fetch, health check) queued during this period gets no response until both Y.Docs finish

Total hang time is additive: ~20 s with two large docs.

### Why the "hang" feels worse than the numbers suggest

The `constructYDoc` loop doesn't just slow down the CRDT endpoint — it **blocks the entire event loop**. During construction:

- No HTTP responses are sent (including in-progress ones)
- No WebSocket messages are processed
- No timers fire (setTimeout, setInterval)
- The frontend receives no feedback — no loading indicator update, no partial results

From the user's perspective, the entire application freezes.
