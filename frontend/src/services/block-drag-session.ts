/**
 * DocumentGripDragSession — the document-scoped owner of a BlockEdit grip gesture.
 *
 * One session per mounted document view (standard and governance pages alike), so a
 * gesture that starts on one section's grip and travels over other sections — mounted
 * neighbours, static rows, page chrome — is one piece of state rather than per-editor
 * state that ends at the editor's own DOM.
 *
 * The session resolves the gripped block itself, from the handle element, through the
 * editor registry and the ProseMirror owner resolver. The handle's own rect is the only
 * input: Crepe positions the handle from its active block's rect, so the block beside the
 * handle is the block the gesture grips.
 *
 * Everything the gesture needs from the page arrives as `GripDragSessionDeps` readers
 * rather than as snapshots, so the session sees the canvas, the rows, the mounted editors,
 * and the transfer service as they are at the moment it asks — not as they were when the
 * page first mounted.
 */

import type { EditorView } from "@milkdown/prose/view";
import type { MilkdownEditorHandle } from "../components/MilkdownEditor";
import type { SectionTransferService } from "./section-transfer";
import { SectionId, type RenderSectionRef } from "../types/live-sections";
import {
  classifyGripCommit,
  classifyGripSourceKind,
  type GripCommitKind,
  type GripSourceKind,
} from "./block-drag-model";
import { resolveDragSessionEditorAt } from "./block-drag-editor-registry";
import { boundEditorOwnerMarkdown, resolveGrippedBlock, type PmOwnerHit } from "./block-drag-pm-owner-resolver";
import {
  GRIP_SECTION_ROW_SELECTOR,
  resolveGripPointerHover,
  type GripHoverSlot,
} from "./block-drag-hover";
import { GripDragPreview } from "./block-drag-preview";
import { applyIntraSectionBodyMove } from "./block-drag-intra-section";
import {
  commitIdentityHeadingOutlineMove,
  commitNeighbourEditorBodyMove,
  commitStaticSectionBodyMove,
} from "./block-drag-commits";

export interface GripDragSessionDeps {
  /** The document canvas (`.canvas-scroll`) — the only scrollport this gesture scrolls. */
  readonly getCanvasScrollElement: () => HTMLElement | null;
  /** The element every section row of this document renders inside. */
  readonly getSectionListElement: () => HTMLElement | null;
  /** The rendered section rows, in document order. */
  readonly getSections: () => readonly RenderSectionRef[];
  /** The mounted editor for a fragment key, or null when that row has none. */
  readonly getEditorHandle: (fragmentKey: string) => MilkdownEditorHandle | null;
  /** Advisory drop gating and the outline-move commit; null while no transport. */
  readonly getTransferService: () => SectionTransferService | null;
  readonly recordLocalEdit: (fragmentKey: string) => void;
  readonly onMoveRefused: (message: string) => void;
}

export interface GripDragSource {
  readonly fragmentKey: string;
  readonly view: EditorView;
  readonly handle: HTMLElement;
  /** The pointer this gesture captured on the handle, for the gesture's whole lifetime. */
  readonly pointerId: number;
  readonly block: PmOwnerHit;
  readonly sourceKind: GripSourceKind;
}

function fragmentKeyRowCount(sections: readonly RenderSectionRef[], fragmentKey: string): number {
  let count = 0;
  for (const section of sections) {
    if (SectionId.text(section.id) === fragmentKey) count += 1;
  }
  return count;
}

function paintedFragmentRowCount(sectionList: HTMLElement, fragmentKey: string): number {
  let count = 0;
  for (const el of sectionList.querySelectorAll(GRIP_SECTION_ROW_SELECTOR)) {
    if (el.getAttribute("data-fragment-key") === fragmentKey) count += 1;
  }
  return count;
}

function sectionRowOwnsEditor(handle: HTMLElement, fragmentKey: string, view: EditorView): boolean {
  const row = handle.closest(GRIP_SECTION_ROW_SELECTOR);
  return (
    row instanceof HTMLElement
    && row.getAttribute("data-fragment-key") === fragmentKey
    && row.contains(view.dom)
  );
}

export interface GripDragHover {
  readonly fragmentKey: string;
  readonly targetIsOtherSection: boolean;
  readonly commitKind: GripCommitKind;
  readonly slot: GripHoverSlot | null;
}

const SOURCE_UNAVAILABLE_REFUSAL = "This section is temporarily unavailable for editing.";
const EDGE_SCROLL_BAND_PX = 40;
const EDGE_SCROLL_MAX_PX = 16;

function canvasEdgeScrollDelta(clientY: number, canvas: HTMLElement): number {
  const rect = canvas.getBoundingClientRect();
  if (clientY < rect.top + EDGE_SCROLL_BAND_PX) {
    const t = (rect.top + EDGE_SCROLL_BAND_PX - clientY) / EDGE_SCROLL_BAND_PX;
    return -EDGE_SCROLL_MAX_PX * Math.min(1, Math.max(0, t));
  }
  if (clientY > rect.bottom - EDGE_SCROLL_BAND_PX) {
    const t = (clientY - (rect.bottom - EDGE_SCROLL_BAND_PX)) / EDGE_SCROLL_BAND_PX;
    return EDGE_SCROLL_MAX_PX * Math.min(1, Math.max(0, t));
  }
  return 0;
}

export class DocumentGripDragSession {
  private source: GripDragSource | null = null;
  private hover: GripDragHover | null = null;
  private lastPointer: { readonly x: number; readonly y: number } | null = null;
  private sourceRefusal: string | null = null;
  private targetRefusal: string | null = null;
  private readonly preview = new GripDragPreview();
  private wheelListener: ((event: WheelEvent) => void) | null = null;
  private edgeScrollFrame: number | null = null;

  constructor(private readonly deps: GripDragSessionDeps) {}

  /** The block this gesture grips, or null while no grip gesture is in progress. */
  get gripSource(): GripDragSource | null {
    return this.source;
  }

  get gripHover(): GripDragHover | null {
    return this.hover;
  }

  get gripSourceRefusal(): string | null {
    return this.sourceRefusal;
  }

  get gripNoDropReason(): string | null {
    return this.sourceRefusal ?? this.targetRefusal;
  }

  /**
   * Records the exact block gripped by `handle`, captures `pointerId` on that handle, and
   * opens the gesture. Returns null without opening anything (and without capturing) when
   * the handle is not inside this document's section list, not inside a registered editor,
   * or when that editor cannot resolve an owner block beside the handle.
   *
   * The capture is what keeps the gesture alive once the pointer leaves the source editor,
   * the canvas, or the window — every later pointer event retargets to the handle.
   */
  startGripDrag(handle: HTMLElement, pointerId: number): GripDragSource | null {
    if (this.source) {
      throw new Error("DocumentGripDragSession: a grip drag is already in progress");
    }
    const sectionList = this.deps.getSectionListElement();
    if (!sectionList || !sectionList.contains(handle)) return null;
    const editor = resolveDragSessionEditorAt(handle);
    if (!editor) return null;
    const block = resolveGrippedBlock(editor.view, handle.getBoundingClientRect());
    if (!block) return null;
    const markdown = boundEditorOwnerMarkdown(editor.view);
    if (markdown == null) return null;
    const row = this.deps.getSections().find((section) => SectionId.text(section.id) === editor.fragmentKey);
    const identity =
      row && row.headingPath.length > 0
        ? {
            heading: row.headingPath[row.headingPath.length - 1]!,
            headingLevel: Number(row.headingLevel),
          }
        : null;
    const sourceKind = classifyGripSourceKind({ owner: block.address, markdown, identity });
    if (sourceKind === "identity-heading") {
      const beforeFirstHeading = !row || row.headingPath.length === 0;
      const duplicateRow =
        fragmentKeyRowCount(this.deps.getSections(), editor.fragmentKey) > 1
        || paintedFragmentRowCount(sectionList, editor.fragmentKey) > 1;
      if (beforeFirstHeading || (duplicateRow && !sectionRowOwnsEditor(handle, editor.fragmentKey, editor.view))) {
        return null;
      }
    }
    this.source = { fragmentKey: editor.fragmentKey, view: editor.view, handle, pointerId, block, sourceKind };
    handle.setPointerCapture(pointerId);
    document.documentElement.classList.add("grip-drag-active");
    this.installWheelForwarding();
    this.startEdgeScroll();
    this.refreshSourceRefusal();
    return this.source;
  }

  sourceEditorIsCurrent(): boolean {
    const source = this.source;
    if (!source) return true;
    const view = this.deps.getEditorHandle(source.fragmentKey)?.getView() ?? null;
    if (view !== source.view) return false;
    const registered = resolveDragSessionEditorAt(source.handle);
    return (
      registered !== null
      && registered.view === source.view
      && registered.fragmentKey === source.fragmentKey
    );
  }

  revalidateSourceEditor(): void {
    if (this.source && !this.sourceEditorIsCurrent()) this.endGripDrag();
  }

  recheckSourceAvailability(): void {
    if (this.lastPointer && this.source) {
      this.updateHover(this.lastPointer.x, this.lastPointer.y);
      return;
    }
    this.refreshSourceRefusal();
  }

  updateHover(clientX: number, clientY: number): GripDragHover | null {
    this.lastPointer = { x: clientX, y: clientY };
    this.revalidateSourceEditor();
    const source = this.source;
    if (!source) {
      this.hover = null;
      return null;
    }
    this.refreshSourceRefusal();
    const sectionList = this.deps.getSectionListElement();
    const resolved = sectionList
      ? resolveGripPointerHover(clientX, clientY, sectionList, source)
      : null;
    if (!resolved) {
      this.targetRefusal = null;
      this.hover = this.sourceRefusal
        ? {
            fragmentKey: source.fragmentKey,
            targetIsOtherSection: false,
            commitKind: "refuse",
            slot: null,
          }
        : null;
      this.syncPreview();
      return this.hover;
    }
    const targetIsOtherSection = resolved.fragmentKey !== source.fragmentKey;
    let commitKind: GripCommitKind = this.sourceRefusal
      ? "refuse"
      : classifyGripCommit({
          sourceKind: source.sourceKind,
          targetIsOtherSection,
        });
    if (!this.sourceRefusal) {
      const verdict = this.deps.getTransferService()?.canDrop(resolved.fragmentKey);
      if (verdict && !verdict.allowed) {
        this.targetRefusal = verdict.message ?? "Drop is not allowed here.";
        commitKind = "refuse";
      } else {
        this.targetRefusal = null;
      }
    }
    this.hover = {
      fragmentKey: resolved.fragmentKey,
      targetIsOtherSection,
      commitKind,
      slot: commitKind === "refuse" ? null : resolved.slot,
    };
    this.syncPreview();
    return this.hover;
  }

  private syncPreview(): void {
    this.preview.sync(this.hover?.slot ?? null, this.gripNoDropReason, this.lastPointer);
  }

  private installWheelForwarding(): void {
    if (this.wheelListener) return;
    this.wheelListener = (event: WheelEvent) => {
      const canvas = this.deps.getCanvasScrollElement();
      if (!canvas || !this.source) return;
      event.preventDefault();
      event.stopPropagation();
      canvas.scrollBy({ top: event.deltaY, left: event.deltaX });
    };
    document.addEventListener("wheel", this.wheelListener, { capture: true, passive: false });
  }

  private removeWheelForwarding(): void {
    if (!this.wheelListener) return;
    document.removeEventListener("wheel", this.wheelListener, true);
    this.wheelListener = null;
  }

  private startEdgeScroll(): void {
    if (this.edgeScrollFrame !== null) return;
    const step = () => {
      this.edgeScrollFrame = null;
      if (!this.source) return;
      const canvas = this.deps.getCanvasScrollElement();
      const pointer = this.lastPointer;
      if (canvas && pointer) {
        const dy = canvasEdgeScrollDelta(pointer.y, canvas);
        if (dy !== 0) {
          canvas.scrollBy({ top: dy });
          this.updateHover(pointer.x, pointer.y);
        }
      }
      if (!this.source) return;
      this.edgeScrollFrame = requestAnimationFrame(step);
    };
    this.edgeScrollFrame = requestAnimationFrame(step);
  }

  private stopEdgeScroll(): void {
    if (this.edgeScrollFrame === null) return;
    cancelAnimationFrame(this.edgeScrollFrame);
    this.edgeScrollFrame = null;
  }

  private refreshSourceRefusal(): void {
    const source = this.source;
    if (!source) {
      this.sourceRefusal = null;
      return;
    }
    const row = this.deps.getSections().find((section) => SectionId.text(section.id) === source.fragmentKey);
    const transfer = this.deps.getTransferService();
    const blocked = transfer?.fragmentBlockState(source.fragmentKey);
    if (!row || !transfer || blocked !== false) {
      this.sourceRefusal = SOURCE_UNAVAILABLE_REFUSAL;
      return;
    }
    this.sourceRefusal = null;
  }

  commitGripDrag(): void {
    if (this.lastPointer) this.updateHover(this.lastPointer.x, this.lastPointer.y);
    const source = this.source;
    const hover = this.hover;
    if (
      source
      && hover
      && hover.commitKind === "intra-section"
      && hover.slot?.kind === "body"
      && hover.fragmentKey === source.fragmentKey
    ) {
      const moved = applyIntraSectionBodyMove(
        source.view,
        source.block.address,
        hover.slot.slot.owner,
        hover.slot.slot.edge,
      );
      if (moved) this.deps.recordLocalEdit(source.fragmentKey);
      this.endGripDrag();
      return;
    }
    if (
      source
      && hover
      && hover.commitKind === "content-move"
      && hover.slot?.kind === "body"
    ) {
      const req = {
        sourceFragmentKey: source.fragmentKey,
        targetFragmentKey: hover.slot.slot.fragmentKey,
        sourceAddress: source.block.address,
        targetAddress: hover.slot.slot.owner,
        edge: hover.slot.slot.edge,
        serializedNode: JSON.stringify(source.block.node.toJSON()),
      };
      const targetMounted = this.deps.getEditorHandle(req.targetFragmentKey)?.getView() != null;
      const transfer = this.deps.getTransferService();
      this.endGripDrag();
      if (!transfer) return;
      const commit = targetMounted ? commitNeighbourEditorBodyMove : commitStaticSectionBodyMove;
      void commit(transfer, req).then((result) => {
        if (result.success) {
          this.deps.recordLocalEdit(req.sourceFragmentKey);
          this.deps.recordLocalEdit(req.targetFragmentKey);
          return;
        }
        if (result.error) this.deps.onMoveRefused(result.error);
      });
      return;
    }
    if (
      source
      && hover
      && hover.commitKind === "outline-move"
      && hover.slot?.kind === "outline"
    ) {
      const outline = hover.slot;
      const sections = this.deps.getSections();
      const sourceRow = sections.find((section) => SectionId.text(section.id) === source.fragmentKey);
      const targetRow = sections.find((section) => SectionId.text(section.id) === outline.fragmentKey);
      const transfer = this.deps.getTransferService();
      const position = outline.edge;
      const targetFragmentKey = outline.fragmentKey;
      this.endGripDrag();
      if (!transfer || !sourceRow || !targetRow) return;
      void commitIdentityHeadingOutlineMove(transfer, {
        sourceHeadingPath: [...sourceRow.headingPath],
        targetHeadingPath: [...targetRow.headingPath],
        targetFragmentKey,
        position,
      }).then((result) => {
        if (!result.success && result.error) this.deps.onMoveRefused(result.error);
      });
      return;
    }
    this.endGripDrag();
  }

  /**
   * Closes the gesture and releases its pointer capture. Every exit path — pointerup,
   * pointercancel, Escape, window blur, page teardown — funnels here, so the capture
   * cannot outlive the gesture. Idempotent, and re-entrant-safe: the source is cleared
   * before the release, so a `lostpointercapture` that ends up calling back in finds
   * nothing to do.
   */
  endGripDrag(): void {
    const source = this.source;
    this.source = null;
    this.hover = null;
    this.lastPointer = null;
    this.sourceRefusal = null;
    this.targetRefusal = null;
    this.preview.clear();
    this.removeWheelForwarding();
    this.stopEdgeScroll();
    document.documentElement.classList.remove("grip-drag-active");
    if (!source) return;
    if (source.handle.hasPointerCapture(source.pointerId)) {
      source.handle.releasePointerCapture(source.pointerId);
    }
  }
}
