# Document block-drag plan

Replace Milkdown Crepe’s native HTML5 block-handle drag with a host-owned pointer gesture, and make drop mean what the handle and the drop preview say — including when the pointer leaves the section that started the drag.

This is one project: gesture, canvas scrolling, preview, and commit. It is not a scroll patch on top of the current drop pipeline.

Audience: a team that will break this into engineering and test work items. This document states scope, semantics, where the work lives, and impact. It does not prescribe function names or diffs.

---

## Why this exists

The document view is a stack of sections. Only the focused section and its two neighbours mount Milkdown. Every other section is static React markdown. The real scroller is the inner canvas (`.canvas-scroll`) inside a viewport-tall `overflow: hidden` shell. The window does not scroll.

Crepe’s BlockEdit grip is `draggable`. While that HTML5 drag is live:

- Chromium does not apply the mouse wheel to scroll. The user cannot wheel toward an off-screen drop.
- Milkdown’s own autoscroll writes `scrollTop` on `view.dom.parentElement` (the wrapper around that section’s ProseMirror). That wrapper grows with the section and is not a scrollport. The 20px edge test is against that box, often off-screen. The canvas never moves.
- Browser viewport-edge autoscroll has nothing to move, because the document/window is not the scroller. The top and bottom of the screen are page chrome (topbar, fixed paper header, footer), which are not descendants of the canvas.

Separately, a drop that leaves the source editor is wired as a cross-section transfer whose adapters still build a block slice, a caret offset, and a “delete from source” callback. `SectionTransferService.execute()` ignores all of that and calls `liveMoveSection`: the **entire source section** is placed immediately before the target section. ProseMirror’s dropcursor (neighbour editor) and the blue caret line (static section) still look like “insert this block here.”

So two things are broken in the same gesture:

1. The user often cannot reach a target that is off-screen.
2. When they can reach another section, the commit is the wrong mutation for a block handle.

This project owns the gesture so the host can scroll the canvas, show one honest preview, and commit the mutation that preview names.

---

## What the user should be able to do

Using the existing BlockEdit grip (the floating handle beside a block):

1. Reorder a block **inside** the section whose editor started the drag. Same outcome as today’s intra-editor Milkdown drop.
2. Move a **body block** (paragraph, list, blockquote, code block, table as a whole, and similar non-identity nodes) into **another** section — whether that row is a mounted Milkdown neighbour or a static React section — and drop it **before or after a chosen block** in that section. The block is removed from the source.
3. Move a **section** in the document outline by dragging that section’s **identity heading**. Dropping onto another section places the source section before or after the target (the existing live-move meaning), with a preview that says “move this section,” not “insert a heading into this body.”
4. While the pointer is down, **wheel** the document canvas and **edge-autoscroll** it when the pointer sits in a band at the top or bottom of the canvas (or viewport). Holding still in that band continues to scroll. Chrome must work; this is a reason the gesture cannot stay HTML5.
5. See a **refused** affordance (no-drop) when the existing `canDrop` rules fail: transport not connected / publish-pause, proposal lock on the target, CRDT block-state on the target. Refusal text stays the verdict’s prose.

The mount window stays focus ± 1. Dragging does not remount editors under the pointer. Static rows are first-class drop targets and must be writable without already having a Milkdown instance.

---

## What this is not

- Not a change to Crepe’s slash / “add block” menu. BlockEdit stays on for that chrome. Only the grip’s **drag** is taken over.
- Not a change to the three-editor mount window, unless a later design needs mount-on-drop (this plan prefers a write path that does not require that).
- Not Milkdown table **internal** row/column drag. That is a separate Crepe feature. Dragging a **whole table** as one block is in scope if the handle offers it.
- Not sidebar tree drag, folder file drag, or static-to-static HTML5 drag that did not start on the Milkdown grip. Those sources stay as they are unless a follow-up unifies them.
- Not switching the document to window/`document` scroll.
- Not patching or forking `@milkdown/plugin-block`.
- Not cloning ProseMirror’s dropcursor plugin or its line-box internals. The host draws the indicator from block rects (top/bottom half). Pixel-identical match with `prosemirror-dropcursor` is not a requirement.
- Not a caret-in-paragraph drop, and not a character-offset write into painted markdown.

---

## How the gesture works

On interaction with `.milkdown-block-handle`:

1. **Kill the native drag.** `preventDefault` the HTML5 `dragstart` (and any equivalent) so Crepe never enters `view.dragging` / `dataTransfer` for this gesture. If that leaks, a second drag session runs under the pointer session.
2. **Capture the pointer** and record the source: fragment key, the block’s document range in that editor, a serialized markdown (or ProseMirror slice) of the block, and whether the block is the section’s identity heading.
3. **While moving:** hit-test with `elementFromPoint` against the document canvas, then `closest` to the nearest marked drop block (the point often lands on `em`, `a`, `code`). Classify the hover as: same editor; other mounted editor; static section; page chrome / dead zone; canvas edge.
4. **Preview:** one host-owned indicator. Body-block over a body → insertion line **before or after the hovered block** (top half vs bottom half of that block’s rect). Identity heading over a section → before/after section slot. Refused target → no-drop. Neighbour Milkdowns use the same host widget; do not leave their dropcursor visible. The rAF path is geometry only: which block, which edge, draw the line. It does not walk text nodes, parse markdown, or compute character offsets.
5. **Scroll:** wheel events `scrollBy` the document canvas. A `requestAnimationFrame` loop changes `scrollTop` while the pointer is in the edge band. The loop must not depend on move events (holding still at the edge must keep scrolling). Sticky header and footer are not the scrollport; the edge band is defined against the canvas (and, if needed, against the viewport so chrome does not create a dead strip).
6. **On release:** commit from the last legal **block slot** (fragment + which block + before/after), or no-op if none. Map that slot to a write against the live fragment at hover-change or pointer-up — not inside the scroll/preview loop. Clear capture, preview, and scroll loop.

The same session object serves intra-section, neighbour-editor, and static-section outcomes. Target type is a commit adapter, not a second drag system.

### Drop position: before/after a block, not a caret

A block-handle drag inserts **between blocks**. That is the same granularity as Milkdown’s intra-section gap drop. It is not a caret inside a sentence.

| Surface | What the pointer names | Commit key |
|---|---|---|
| Source or neighbour ProseMirror | Before/after the hovered PM block (top/bottom half of its rect) | That view’s node position / slot |
| Static React body | Before/after the hovered marked block (same 50% rule) | A **block slot** bound at render time (below), applied to the **live** fragment |
| Identity heading over a row | Before/after the section row | `liveMoveSection` slot |

Do **not** use `caretRangeFromPoint` plus `domPosToMarkdownOffset` (or any `\n\n`-split + `p, li, tr, …` walk). That helper already disagrees with real markdown: one list is one blank-line chunk and several `li`s; a table is one chunk and many `tr`s; a `blockquote` contains a `p` so both match. Do not reuse it to fill data attributes either.

Do **not** treat a character offset in the painted string (`245`) as the write API. Static paint is `getDisplayMarkdown` (live paint, seed, or proposal overlay). The write hits the live fragment. Heading prefix, trailing newlines, overlay vs replica, and any normalize between paint and apply make a raw index point at the wrong place even when it was correct at render. Insert **before/after this block** in a parse of the string that will actually be written.

`elementFromPoint` is enough for preview. Binding DOM → commit key is done **once when the static row renders**, not at 60fps. Neighbour Milkdowns need no static stamps; they use the same *geometry* rule and a ProseMirror slot as the key.

Nested ownership must be explicit on the marked nodes: drop on a list item is before/after **that item**, not the outer list, unless the hit is the list’s own gap; `blockquote > p` and table cells need a single owner each. Work items should list those cases rather than “every `<p>` gets a number.”

This static bind **does not** de-risk the two-fragment write (item 5). It only makes hover and commit name the same block slot.

---

## Semantic changes (the work)

These are the product and pipeline changes. They are the backlog, not an implementation order.

### 1. Host owns the grip gesture

Milkdown still draws and positions the handle. The host owns pointer-down through pointer-up, including cancellation of HTML5 drag. Crepe sets `draggable="true"` on the handle at init and does not expose a flag to turn that off — after the handle exists, set `draggable` false on it. Still cancel `dragstart` if one fires. Pointer capture on pointerdown is the ownership already required in the gesture (including when the pointer leaves the editor or the window).

**Where:** document editor adapter (`MilkdownEditor` and the Crepe mount), plus a document-scoped drag session that can see the canvas scroller and every section row. Both `DocumentPage` and `GovernanceDocumentPage` use the same session; they already share the transfer and drag-drop wiring.

**Impact:** intra-section reorder is no longer Crepe’s `drop` / `view.dragging` path. That path must be reimplemented against the source `EditorView` (node move / replace) so the one working reorder today does not regress.

### 2. Host owns canvas scrolling during the gesture

Wheel and edge autoscroll always target the document canvas ref, never `view.dom.parentElement` and never `window`.

**Where:** the drag session, subscribed for the life of a grip drag; canvas is `scrollContainerRef` on the document pages.

**Impact:** new behaviour (today there is none that works). Must not break normal wheel when not dragging. Must not fight the section-nav overlay’s existing wheel-forwarding when the nav is the hover target (nav is not a drop target for this gesture unless a later item adds it).

### 3. One preview language

A single host-drawn insertion/slot/refused widget. Every body-block hover uses the same rule: line before or after the hovered **block rect**. Target type only supplies that rect (and, later, the commit key). It does not get a different affordance.

| Hover | Geometry | Widget |
|---|---|---|
| Any mounted ProseMirror (source or neighbour) | Top/bottom half of the hovered PM block’s bounding rect | Insertion line at that edge |
| Static section body | Top/bottom half of the hovered marked block’s bounding rect | Same insertion-line widget |
| Identity heading over a section row | Before/after slot on the row box | Section-slot line (must not look like an in-body caret) |
| Refused / chrome | None | No-drop |

Do not keep `prosemirror-dropcursor` as the intra-editor or neighbour-editor preview for this gesture: it will not run after HTML5 `dragstart` is cancelled, and a caret that only some Milkdowns still paint is the current two-language bug.

Honest mapping means the **block slot** in the last preview is the slot the commit uses. Coarsening from caret-in-paragraph to before/after-block is required, not a shortcut. Coarsening further to “append to this section” (or a whole-row fill) while the commit still targets a mid-body slot is still a lie.

**Where:** document canvas / section wrappers. Suppress or ignore dropcursor for the life of the session. Retire the HTML5-only blue bar in `useSectionDragDrop` as the Milkdown-source preview.

**Impact:** visual QA across wide and narrow document chrome, including the fixed paper header covering the top of the paper. Neighbour editors must show the host line, not a leftover PM dropcursor.

### 4. Intra-section commit is a block move in the source editor

Drop still inside the source ProseMirror: move the recorded block to the indicated **before/after sibling slot**. Apply that as **one** Transaction and **one** `dispatch` (delete and insert on the same `tr`, with the insert position mapped through the delete). Two dispatches split the editor undo stack and y-prosemirror / Y.UndoManager into two user edits. Authorship must treat the move as a real user edit (same class as typing), not a remote apply.

**Where:** source `EditorView` via the existing editor handle (`getView()`).

**Impact:** this is the regression-sensitive core. Lists, headings inside the section body, tables-as-blocks, and empty-section edges need explicit tests.

### 5. Body-block drop outside the source section is a two-fragment content move

This mutation does not exist today. `execute()` only reorders whole sections. The adapters’ slice / `insertionOffset` / `deleteSourceCallback` fields are unused.

Required behaviour: remove the block from the source fragment; insert it **before or after the named target block** in the target fragment; both sides persist through the live document session (CRDT fan-out), with the same kind of flush/ordering barrier live-move already uses so in-flight keystrokes are not lost.

This must work for:

- **Neighbour Milkdown** (target has a view and a Y binding). Slot is the ProseMirror block named by the same 50% hit-test.
- **Static section** (target has no editor). Slot is the render-time bind on that marked block (item 8), resolved against the **live** fragment at commit — not a character index in the painted markdown.

The mount window will not follow the pointer, so “mount then insert” is not the plan. There must be a durable write into a fragment that is not mounted.

**Where:** new or extended control-plane/live-edit path (frontend service + backend session), plus serializers already used for cross-section copy (`proseMirrorNodeToMarkdown`). Document pages stop sending grip-originated body drops through `liveMoveSection`. Do not route this commit through `drop-position.ts`.

**Impact:** this is still the largest item. The hard part is the write (unmounted target, paint string ≠ live fragment, barrier, refusals, fan-out), not computing an offset in the drag loop. A correct static bind (item 8) only makes the hover and the write name the same slot.

**CRDT: one document session, not a session per section.** Mounting Milkdown is a view binding (`ySyncPlugin` on one `Y.XmlFragment`). It is not how the client “joins” the target. The live replica already holds the whole `Y.Doc`: one WebSocket, one fragment per section in topology. Static rows are not a second store. Once the replica is live authority, `paintMarkdown` is `getLiveSection(id).readMarkdown()` from that fragment (contracts F1 / F3). Each row’s `replicaFragmentVersion` is `observeDeep` on that fragment so a change can rememo the static React tree. Remote frames call `ingestUpdate` → `notify()` → the page re-reads those versions and paints again (F3 / F4).

So a static target is already in the same session. There is no second CRDT to open, and no requirement to mount Milkdown to “participate.” A body-block drop must mutate the **existing** source and target fragments in that doc (same class of write as typing, or the same backend-transact + fan-out live-move already uses). After apply, the static row must show the new fragment without mounting an editor.

What this does **not** invent: a per-section session, a write into React-only markdown, or a REST body that later `ySync` attach would fight.

One implementation gap to close, not a new product rule: `LiveSectionReplica.notify()` today runs on inbound frames / bootstrap / pause, not on a local `Y.Doc` transaction. Remote edits to a static row already repaint. A **local** write to an unmounted fragment will bump `getFragmentVersion` via `observeDeep` but may not `forceRender` until something else notifies. The content-move commit must make that row paint — either notify after the local transact, or apply via a fan-out the replica already ingests. Work items should test: drop onto a never-mounted row; that row’s static markdown matches `readMarkdown()` afterwards, with no Milkdown on the target.

Planning must decide, and record in the work items:

- How identity of the moved nodes is handled (plain content copy-delete vs any mark/attr that must survive).
- What happens if the source editor unmounts mid-gesture (user cannot change focus by dragging; eviction is still possible if focus changes by other means — treat as cancel).
- Proposal / lock / block-state: `canDrop` on the **target** remains the gate; source-side block-state should cancel or refuse as well.
- How the local two-fragment write becomes a static-row paint (notify vs fan-out), so it does not depend on an incidental parent re-render.

### 6. Identity-heading drag is an outline move, not a body insert

If the gripped node is the section’s identity heading (the heading that *is* that row), drop onto another section is `liveMoveSection` with an explicit before/after slot. Preview and cursor must not look like in-body insertion.

**Where:** existing `liveMoveSection` / `SectionTransferService.execute()` stay the commit for this case only. The session chooses this adapter from source-node kind + target slot, not from “any drop that left the editor.”

**Impact:** today’s accidental “any cross-editor drop moves the whole section” becomes a deliberate, heading-only path. Dragging a paragraph must not hit this adapter.

**Before-first-heading (BFH) rows** and **duplicate fragment-key rows** (corrupt draft: one fragment rendered twice) need an explicit rule: refuse, or treat as non-identity. Duplicate rows already must not mount two editors on the same fragment; do not invent a second binding here.

### 7. Embedded (non-identity) headings

A heading that is **not** the row’s identity heading is a structural object in this product (split/merge / proposal generator), not a normal paragraph.

**Scope default for this project:** do not silently transplant an embedded heading into another section as if it were a paragraph, and do not treat it as `liveMoveSection` of the parent row. Refuse the drop (or restrict the gesture so the handle does not start a drag on those nodes) until a later structural-drag project.

Work items should include that refusal and a test, so it is not left as “whatever ProseMirror does.”

### 8. Static rows are first-class targets, with a render-time block bind

`useSectionDragDrop` today is HTML5 `dragover`/`drop` on `[data-document-section]` and skips rows with a mounted editor. Grip-originated drags will no longer produce those events. Far sections (the common case once you scroll) are the main new success path for body-block moves. That is why item 5 cannot assume a target `EditorView`.

The static React markdown renderer does the DOM → slot bind **when it paints**, so the drag loop never reverse-engineers the tree.

- Stamp each drop-owning block with a bind the session can read (`data-*` on the element, or an equivalent side table keyed from the node). `elementFromPoint` + `closest` yields the bind; the 50% rule yields before/after.
- The bind must come from the markdown **source map** used to produce that DOM (remark/MDAST `position` on the node, or an explicit block list built from the same parse). It must not be invented by walking painted `p`/`li`/`tr` and pairing them with `markdown.split(/\n\n/)`.
- The bind identifies a **block in a parse**, not a character offset in `getDisplayMarkdown`. At commit, resolve that slot in the live fragment (same parse rules, after any heading-prefix / overlay normalize the write path already owns).
- Mark ownership, not every inner tag: list item vs list, blockquote vs its inner paragraph, table as one block (whole-table drag is in scope; cell-level is not).
- Other static consumers of the same renderer (underlay, degraded CRDT, agent cold page) may receive the attributes. They are inert unless a drag session reads them.

**Where:** static section markdown renderer and the session hit-test. The HTML5 hook can remain for **static-origin** drags (not this project) but must not be the Milkdown-source path.

**Impact:** static hover is cheap and testable (fixture markdown → marked DOM → slot). It does not replace item 5. If paint and live fragment diverge, the bind is stale — that is a write-path / freshness bug, not a reason to map DOM text at 60fps.

### 9. Neighbour editors are the same hit-test, not ProseMirror’s drop

A drop on the neighbour’s `.ProseMirror` must not fall through to Crepe/ProseMirror `handleDrop` for this gesture. The host session commits (item 4, 5, or 6). Paper padding around an editor that is not a mapped drop position is a dead zone (no-op), not a silent section move.

**Where:** `crossSectionDropPlugin`’s HTML5 `handleDrop` / `dragover` for grip-originated sessions is removed or becomes inert. Do not leave two commit paths.

### 10. Gating stays advisory `canDrop`, commit stays refused in prose

Transport unavailable, target locked, target block-state: no-drop during move; execute/apply still rechecks and surfaces backend prose on 409. Human transfers stay ungated on agent write-policy.

**Where:** existing `SectionTransferService.canDrop` and live-move refusal rendering. The new content-move path must use the same verdict shape and the same “render backend prose verbatim” rule.

### 11. Authorship and live-edit side effects

A successful body-block move is a local edit on the source and on the target (when the target is live). Uncommitted indicators, presence, and `onLocalEdit` / session authorship must update for both fragments. An outline move stays the existing live-move side effects (structure fan-out, no fake two-body edit).

### 12. Governance document page parity

The same gesture, scroll, preview, and commits apply on `GovernanceDocumentPage` if that surface shows the same section list + Milkdown mount window. Do not ship document-page-only.

---

## Where the work sits (map, not a file list)

| Area | Role |
|---|---|
| Document canvas / page shell | Scrollport, section row identity (`data-fragment-key`), sticky header geometry, wide vs narrow chrome |
| Milkdown editor adapter | Grip event interception, source `EditorView`, intra-section node move, kill HTML5 drag |
| Host drag session (new) | Pointer capture, hit-test, preview, wheel + edge scroll, dispatch to commit adapters |
| Cross-section HTML5 plugin + static HTML5 hook | Stop being the Milkdown-source pipeline; keep or isolate non-grip sources |
| Section transfer / live-move | Identity-heading outline move only |
| New two-fragment content move | Body-block transplant, including unmounted targets; ordering barrier; refusals |
| Static markdown renderer | Render-time block bind (source map → marked DOM); not a 60fps mapper |
| Serializers | Block → markdown (or structured payload) for the content-move write |
| Drop-position helpers (`domPosToMarkdownOffset` / `\n\n` walk) | Not used for this gesture |
| Backend document session | Persist the content move; fan-out; 409 prose; do not reuse live-move for body blocks |

---

## Impact

**User-facing.** Dragging the grip can reach any section on the canvas. Wheel and edge-scroll work in Chromium. A paragraph dropped on another section appears there and disappears from the source. Dragging a section title still reorders sections, and looks like that. The current “drop a paragraph, the whole section jumps” behaviour goes away.

**Performance.** One pointer session and a rAF scroll loop for the duration of a drag. No change to how many Milkdowns are mounted. The content-move write must not require mounting the target editor.

**Failure modes to design for.** HTML5 drag leak (double gesture). Source view gone before commit. Target fragment deleted or locked mid-drag. Publish-pause between preview and commit. Paint string ≠ live fragment (stale bind). Ambiguous nested hits if ownership is unmarked (`li` vs `ul`, `blockquote > p`). Duplicate fragment rows.

**Documentation.** `docs/editing-guide.md` does not describe block-handle drag. Update it when behaviour ships. `docs/developerdocs/milkdown-integration.md` still lists BlockEdit as overlay-only; note that the grip’s drag is host-owned.

---

## Testing scope

The reviewing team should plan tests as first-class work, not an afterthought. Suggested partitions:

**Gesture isolation**

- Grip pointer session starts; no HTML5 `dragstart` default / no `view.dragging` on the source view.
- Pointer cancel / Escape / drag ending off the window: no commit, preview and scroll loop gone.

**Intra-section (must not regress)**

- Reorder paragraph, list item/block, body heading (non-identity), table-as-block.
- Drop back on the original position: no-op or identity.
- y-prosemirror: after fan-out / refresh, order matches.

**Body-block → neighbour Milkdown**

- Insert before/after the named PM block; source deleted; both fragments persist.
- `canDrop` refusal: no mutation.
- Does not call `liveMoveSection`.

**Body-block → static section**

- Same assertions with **no** Milkdown on the target before, during, or after (unless the product later focuses that row for other reasons).
- Far from the mount window (not merely the other neighbour).
- Top half / bottom half of a marked block commits before / after that block, not a mid-paragraph caret.
- Bind comes from the source map, not `split(/\n\n/)` vs `querySelectorAll("p, li, …")`.
- List item, blockquote, and table ownership: the named slot is the intended owner.
- Commit resolves the slot against the live fragment, not a character index in the painted string.
- After commit, `getLiveSection(target).readMarkdown()` matches the static paint; no Milkdown was mounted on the target. A second client (or this client after a remote frame) sees the same body.

**Identity heading → outline move**

- Before/after slot; `liveMoveSection` (or equivalent) only.
- Preview is a section slot, not an in-body caret.
- Body-block drag never takes this path.

**Embedded heading**

- Drag refused or handle does not start; no transplant; no outline move.

**Scrolling**

- Wheel during the gesture moves `.canvas-scroll` (Chromium).
- Pointer held in the top/bottom band keeps scrolling without further moves.
- Edge band still works when the sticky paper header or footer occupies the screen edge.
- Wheel when **not** dragging is unchanged.

**Preview honesty**

- During the gesture, neighbour Milkdowns do not show ProseMirror dropcursor; the host widget is the only insertion line.
- The commit slot matches the last preview slot (before/after that block), not “append to section” unless that was the preview.

**Chrome / dead zones**

- Drop on topbar, footer, section-nav, editor padding that is not a mapped slot: no-op.
- Narrow vs wide document layout.

**Session / locks**

- Disconnected / publish-pause: no-drop and no commit.
- Target proposal-locked or CRDT-blocked: no-drop; 409 prose if apply races.
- Live-move and content-move both flush in-flight edits before apply (no lost keystrokes).

**Surfaces**

- `DocumentPage` and `GovernanceDocumentPage`.

**Automation vs live**

- Unit/integration: pointer events against fixtures (two fragments, one canvas scroller, one static row). Do not rely on HTML5 `DragEvent` as the stand-in for this gesture.
- Static bind in isolation: fixture markdown → marked DOM; `elementFromPoint` / `closest` returns the intended owner for lists, quotes, and tables; bind survives a paint that is not the live fragment string (test that commit must re-resolve).
- Live Chromium: wheel, edge hold-to-scroll, sticky header, a document long enough that targets start off-screen.

---
