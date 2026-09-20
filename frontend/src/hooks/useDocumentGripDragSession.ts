/**
 * useDocumentGripDragSession — owns one `DocumentGripDragSession` for the document view
 * that calls it, and adapts that view's React state into the session's dependency
 * readers. `DocumentPage` and `GovernanceDocumentPage` both call this hook, so the grip
 * gesture is one shared implementation across the two surfaces rather than a per-page
 * copy.
 *
 * The readers go through a ref holding the latest options, so a session created on the
 * first render still sees the current canvas element, rows, editors, and transfer service
 * on every later render.
 */

import { useEffect, useRef, type RefObject } from "react";
import type { MilkdownEditorHandle } from "../components/MilkdownEditor";
import type { SectionTransferService } from "../services/section-transfer";
import type { RenderSectionRef } from "../types/live-sections";
import { DocumentGripDragSession } from "../services/block-drag-session";
import { BLOCK_HANDLE_SELECTOR } from "../services/block-drag-grip-guard";

export interface UseDocumentGripDragSessionOptions {
  /** The document canvas (`.canvas-scroll`) this gesture scrolls. */
  canvasScrollRef: RefObject<HTMLDivElement | null>;
  /** The container every section row renders inside. */
  sectionListRef: RefObject<HTMLDivElement | null>;
  /** The rendered section rows, in document order. */
  sections: readonly RenderSectionRef[];
  /** Mounted editor handles by fragment key. */
  editorRefs: RefObject<Map<string, MilkdownEditorHandle>>;
  /** Advisory drop gating and the outline-move commit; null while no transport. */
  transferService: SectionTransferService | null;
  /** Live set of fragment keys whose Milkdown instance is ready. */
  readyEditors: ReadonlySet<string>;
  recordLocalEdit: (fragmentKey: string) => void;
  onMoveRefused: (message: string) => void;
}

export function useDocumentGripDragSession(
  opts: UseDocumentGripDragSessionOptions,
): DocumentGripDragSession {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const sessionRef = useRef<DocumentGripDragSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new DocumentGripDragSession({
      getCanvasScrollElement: () => optsRef.current.canvasScrollRef.current,
      getSectionListElement: () => optsRef.current.sectionListRef.current,
      getSections: () => optsRef.current.sections,
      getEditorHandle: (fragmentKey) => optsRef.current.editorRefs.current?.get(fragmentKey) ?? null,
      getTransferService: () => optsRef.current.transferService,
      recordLocalEdit: (fragmentKey) => optsRef.current.recordLocalEdit(fragmentKey),
      onMoveRefused: (message) => optsRef.current.onMoveRefused(message),
    });
  }
  const session = sessionRef.current;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const handle = target.closest(BLOCK_HANDLE_SELECTOR);
      if (!(handle instanceof HTMLElement)) return;
      const sectionList = optsRef.current.sectionListRef.current;
      if (!sectionList || !sectionList.contains(handle)) return;
      if (session.gripSource) return;
      if (session.startGripDrag(handle, event.pointerId)) {
        session.updateHover(event.clientX, event.clientY);
      }
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (session.gripSource?.pointerId !== event.pointerId) return;
      session.updateHover(event.clientX, event.clientY);
    };
    const onDragStart = (event: DragEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest(BLOCK_HANDLE_SELECTOR)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (session.gripSource?.pointerId !== event.pointerId) return;
      session.commitGripDrag();
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (session.gripSource?.pointerId !== event.pointerId) return;
      session.endGripDrag();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !session.gripSource) return;
      session.endGripDrag();
    };
    const onWindowBlur = () => { session.endGripDrag(); };
    const onScroll = () => {
      if (!session.gripSource) return;
      session.recheckSourceAvailability();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("dragstart", onDragStart, true);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [session]);

  useEffect(() => () => { session.endGripDrag(); }, [session]);

  useEffect(() => {
    session.revalidateSourceEditor();
  }, [session, opts.readyEditors]);

  useEffect(() => {
    session.recheckSourceAvailability();
  }, [session, opts.sections, opts.transferService]);

  return session;
}
