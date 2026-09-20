# Split caret

After a live split, the caret is either in the **kept prefix** of the source fragment or in the **leaving suffix** of one promoted heading — and in that suffix it is either in the **heading** or in the **body**. Every current and reported failure is a disagreement between parallel strategies that encode that fact differently. Replace them with one location, one plan, one placement, one source seal.

Do not change when the server splits. Do not remint into a different Yjs shape. Do not add heading-caret protocol. Merge and heading-deletion stay on `resolveFocusAfterTopologyChange`.

---

## Why

`frontend/src/pages/caret-recovery.ts` decides stay-vs-leave with y-prosemirror RelPos **after** apply, then places with a flat text offset **from the start of the heading**, then “corrects” with a whole-document fingerprint, then falls back to `startOfBodyPos`. Those four mechanisms disagree.

- RelPos can still resolve after the promoted nodes are tombstoned (association to a leftover item). The plan stays on the survivor. The caret sits at the cut — before the new heading — or later keystrokes write into that hole.
- `offsetInBlock` counts `heading + "\n" + body` as one string. An empty paragraph after Enter has no text node. `posAtTextOffset` returns `lastTextEnd` (end of the heading). Empty fingerprint `after` is treated as a match, so that heading position is accepted.
- Empty-body remint is heading-only (`buildFragmentContent` → `## Name`). `startOfBodyPos` on a one-child doc returns `1` (inside the heading). `MilkdownEditor.focus("start")` is the same position.
- The destination editor does not exist at apply time. Until it mounts, ySyncs, and a rAF runs `focusAtPos`, the survivor still has DOM focus. Keys in that window go into the deleted region.

The existing “happy path” (caret already in a non-empty promoted body) works because the flat offset and the reminted body happen to line up. `# heading` + Enter, and `# heading` + Enter + type, are the same path with an empty or short body slot — not new kinds of split.

---

## Model

```ts
type SplitCaretLocation =
  | { kind: "kept-prefix" }
  | {
      kind: "promoted";
      headingOrdinal: number; // 0 = first heading at-or-after the split boundary
      slot: "heading" | "body";
      offset: number;         // text offset inside that slot only
    };

type SplitCaretPlan =
  | { action: "stay"; sectionId: SectionId; fragmentKey: string }
  | {
      action: "follow-promotion";
      sectionId: SectionId;
      fragmentKey: string;
      slot: "heading" | "body";
      offset: number;
      fingerprint: CaretFingerprint; // taken from, and matched inside, the slot
    };
```

The survivor heading is the same one the server keeps: the top-level heading that matches the fragment’s authoritative identity (text + level). If none matches, the first heading (rename-in-place). BFH has no survivor heading.

| Where the caret is at capture | Location |
|---|---|
| Orphan preamble (before the first heading) | `kept-prefix` |
| Inside the survivor heading, or its body until the next heading | `kept-prefix` |
| Inside a heading that is not the survivor | `promoted` / `heading` / offset in that heading’s text |
| In that heading’s body, until the next heading | `promoted` / `body` / offset from the first body child of that heading |
| No heading in the source | `kept-prefix` |

`headingOrdinal` counts leaving headings in document order (every heading except the survivor). Insert-before (`before` in `section-split`) and insert-after (`after`) use the same ordinal → `newRefs` map.

---

## Locate — `locateCaretInSplit(doc, caretPos, isBeforeFirstHeading, identity?)`

Walk top-level children. Do **not** measure from the heading start across blocks. Do **not** assume the first heading is the survivor — insert-between by editing the later section puts the new heading first and keeps the identity heading.

- No heading owns the caret (preamble, or no headings) → `{ kind: "kept-prefix" }`.
- Owning heading is the identity match (or the first heading when none match) → `{ kind: "kept-prefix" }`.
- Owning heading is any other heading → `{ kind: "promoted", headingOrdinal, slot, offset }` with the offset inside that slot only. An empty paragraph is offset `0`.

Capture passes the focused row’s leaf heading + level from the pre-apply topology. BFH passes no identity.

Delete `computePromotedAddress` and `offsetInBlock`. A body caret must never include the heading’s characters in its offset.

`captureCaretBeforeStructuralApply` stores `sourceFragmentKey`, the `SplitCaretLocation`, and a fingerprint **clipped to the slot’s text range** (heading text only, or body text only). Drop `relSel`, `binding`, and `getRelativeSelection` from the capture. They exist only to classify stay-vs-leave; the tree at capture already knows that.

---

## Plan — `planCaretAfterSplit({ location, sourceFragmentKey, fingerprint, prevTopology, nextTopology })`

Topology unchanged → `null` (content-only frame; do nothing).

`kept-prefix` and the source id is still in `nextTopology` → `{ action: "stay" }` on the source. y-prosemirror owns the selection. RelPos is not consulted.

`promoted` → `{ action: "follow-promotion" }` on `newRefs[clamp(headingOrdinal)]`, carrying `slot`, `offset`, and the slot fingerprint. **Always.** A RelPos that still resolves in the source is not a veto.

Source gone, no new ids (merge / heading-deletion) → `null`. `resolveFocusAfterTopologyChange` keeps that family.

Source gone, new ids exist (BFH dissolve) → `follow-promotion` onto `newRefs[ordinal]` (ordinal `0` if the location was `kept-prefix` because the source vanished).

Source present, `kept-prefix`, no new ids → `stay`.

Delete `recoverCaret`’s `classify` hook and `relSelResolvesInSource`.

`lastCaretRecoveryRef` / `caretOwningId` still feed `resolveFocusAfterTopologyChange`. `stay` and `follow-promotion` both expose `sectionId`.

---

## Place — `pmPosForPlacement(doc, { slot, offset, fingerprint })`

**`slot: "heading"`.** Offset in the first heading’s text. Fingerprint may slide inside that heading only.

**`slot: "body"`.** `firstBodyBlockPos(doc)` is the start of the first top-level child after the leading heading. If that child does not exist (heading-only remint), insert an empty paragraph through the destination view (a y-prosemirror transaction; an empty section the user is about to type in should have a body block) and use the start of that paragraph. Then apply `offset` as a text offset **inside the body region only**.

Fingerprint search, if used, is restricted to the same slot. Empty `after` must not accept a position in the heading when the slot is body.

Delete `resolveRetargetPmPos`, `posAtTextOffset` over the whole doc, whole-doc needle search, and `startOfBodyPos` as a last-ditch fallback. `MilkdownEditor.focus("start")` stays for cursor-exit into an adjacent section. It is not a retarget fallback.

---

## Seal — `sealEditorForCaretTransit(view)`

On `follow-promotion`, in `afterApply`, before React paints:

1. Blur the source `EditorView`.
2. Make it non-editable (view `editable: () => false`, or the existing read-only path) so `beforeinput` cannot write into the survivor.
3. Then write the pending dest target (`setRetargetCaretTarget`).

The dest still mounts, waits for ySync ready, and applies `pmPosForPlacement` on the next frame. Keys during that gap are dropped, not applied to the cut. Unseal is automatic: the source is no longer focused; eviction / `readOnly={!isFocused}` already matches.

Do not call `handle.focus("start")` if the dest handle exists but `getView()` is null — wait for ready.

---

## Names and files

| Today | After |
|---|---|
| `frontend/src/pages/caret-recovery.ts` | `frontend/src/pages/split-caret.ts` |
| `computePromotedAddress` | `locateCaretInSplit` |
| `PromotedCaretAddress` | `SplitCaretLocation` |
| `recoverCaret` | `planCaretAfterSplit` |
| `CaretRecovery` `survivor` / `retarget` | `SplitCaretPlan` `stay` / `follow-promotion` |
| `RetargetCaretPlacement` `{ offsetInBlock, fingerprint }` | `{ slot, offset, fingerprint }` |
| `resolveRetargetPmPos` | `pmPosForPlacement` |
| `startOfBodyPos` | `firstBodyBlockPos` (primary for `slot: "body"`) |
| `useCaretRecoveryGlue` | `useSplitCaretHandoff` |
| `useCaretRecoveryGlue.ts` | `useSplitCaretHandoff.ts` |

`CaretFrameHooks` (`beforeApply` / `afterApply`) stay. `useLiveSectionReplica` keeps calling them around `ingestUpdate`.

---

## Wiring

`useSplitCaretHandoff.afterApply`: `planCaretAfterSplit` → store plan on the ref (for `caretOwningId`) → if `follow-promotion`, `sealEditorForCaretTransit(sourceView)` then `onRetarget`.

`DocumentPage` and `GovernanceDocumentPage` `onRetarget` pass `{ slot, offset, fingerprint }` into `setRetargetCaretTarget`. The topology effect is unchanged: read `sectionId`, clear the ref, `resolveFocusAfterTopologyChange`.

`useSectionFocus` retarget variant stores the new placement. When `readyEditors` has the dest key, rAF: `focusAtPos(pmPosForPlacement(view.state.doc, placement))`.

Call-site imports: `caret-recovery` → `split-caret`; glue hook rename; `useDocumentSessionController` only if it re-exports the retarget setter type.

Rewrite the “Caret capture/recover” and “Caret recovery wiring (A1–A4)” sections of `assumptions-august-2026.md` to this model (RelPos is not the classifier; offset is per-slot; source is sealed). Do not add explanatory comments in the code.

---

## What is deleted

- RelPos capture and `relativePositionToAbsolutePosition` as stay-vs-leave.
- Flat `offsetInBlock` from the heading start.
- Whole-document fingerprint search.
- Triple fallback in `resolveRetargetPmPos`.
- `focus("start")` on the retarget path.
- Any special case that says “empty paragraph,” “heading-only remint,” or “user was typing.” Those are `body` / `0`, `firstBodyBlockPos` + insert, and seal.

---

## What does not change

- Server quiescence (2s of no CRDT activity) and `applyStructuralSplitPlan` (delete promoted nodes from the survivor, seed the new fragment from markdown).
- Empty-body mint remaining `## Name` with no body. Placement inserts the empty paragraph on the dest if needed.
- Mount window (focus ± 1). The dest is the new focus, so it mounts.
- Arrow-key section exit (`handleCursorExit` / `focus("start" \| "end")`).
- Removal handoff when the source is gone and no section was created.
