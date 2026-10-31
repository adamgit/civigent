import { $prose } from "@milkdown/utils";
import type { Node as PmNode } from "@milkdown/prose/model";
import { Plugin } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { firstBodyBlockPos } from "../pages/split-caret";
import { SectionId, type RenderSectionRef } from "../types/live-sections";
import { selectionAtSectionEdge } from "./sectionEdge";

export type SectionAltJumpSlot = "title" | "body";

export interface SectionAltJumpRequest {
  sourceFragmentKey: string;
  toward: "up" | "down";
  slot: SectionAltJumpSlot;
}

export interface SectionAltJumpHandle {
  getView(): EditorView | null;
  focusAtPos(pos: number): void;
}

export interface SectionAltJumpHost {
  sections(): readonly RenderSectionRef[];
  canFocus(section: RenderSectionRef): boolean;
  getHandle(fragmentKey: string): SectionAltJumpHandle | null;
  proposalMode(): boolean;
  focusLive(section: RenderSectionRef): void;
  focusProposal(section: RenderSectionRef): void;
}

export interface SectionAltJumpPluginOptions {
  commandsRef: {
    readonly current: {
      jumpSection: ((request: SectionAltJumpRequest) => void) | null;
    };
  };
}

const PLACE_ATTEMPTS = 120;

/**
 * Alt+Up / Alt+Down moves the caret to the previous or next section.
 * The landing matches the block the caret is in: a heading lands on a
 * heading, a body block lands on a body. A section with no body receives
 * the caret at its start.
 *
 * The listener is capture-phase so it runs before the arrow-exit plugin,
 * which treats a plain ArrowUp at the top edge as a move to the previous
 * section's end.
 */
export class SectionAltJump {
  private token = 0;
  private pendingFragmentKey: string | null = null;

  constructor(
    private readonly hostRef: { current: SectionAltJumpHost | null },
  ) {}

  readonly jump = (request: SectionAltJumpRequest): void => {
    const host = this.hostRef.current;
    if (!host) return;
    const sections = host.sections();
    const sourceKey = this.pendingFragmentKey ?? request.sourceFragmentKey;
    const index = sections.findIndex((row) => SectionId.text(row.id) === sourceKey);
    if (index < 0) return;
    const step = request.toward === "up" ? -1 : 1;
    let target = index + step;
    while (target >= 0 && target < sections.length && !host.canFocus(sections[target]!)) {
      target += step;
    }
    if (target < 0 || target >= sections.length) return;
    const section = sections[target]!;
    const fragmentKey = SectionId.text(section.id);
    const token = ++this.token;
    this.pendingFragmentKey = fragmentKey;
    if (host.proposalMode()) host.focusProposal(section);
    else host.focusLive(section);
    let attempts = 0;
    const place = (): void => {
      if (token !== this.token) return;
      const current = this.hostRef.current;
      const handle = current?.getHandle(fragmentKey) ?? null;
      const view = handle?.getView() ?? null;
      if (!handle || !view || !view.editable || !view.dom.isConnected) {
        attempts += 1;
        if (attempts < PLACE_ATTEMPTS) requestAnimationFrame(place);
        else if (this.pendingFragmentKey === fragmentKey) this.pendingFragmentKey = null;
        return;
      }
      handle.focusAtPos(SectionAltJump.landingPos(view.state.doc, request.slot));
      if (this.pendingFragmentKey === fragmentKey) this.pendingFragmentKey = null;
    };
    requestAnimationFrame(place);
  };

  static plugin({ commandsRef }: SectionAltJumpPluginOptions) {
    return $prose(() => new Plugin({
      view(editorView) {
        const onKeyDown = (event: KeyboardEvent): void => {
          if (!SectionAltJump.isAltSectionArrow(event)) return;
          const jump = commandsRef.current.jumpSection;
          if (!jump) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          const source = editorView.dom
            .closest("[data-document-section][data-fragment-key]")
            ?.getAttribute("data-fragment-key");
          if (!source) return;
          jump({
            sourceFragmentKey: source,
            toward: event.key === "ArrowUp" ? "up" : "down",
            slot: SectionAltJump.caretSlot(editorView),
          });
        };
        editorView.dom.addEventListener("keydown", onKeyDown, true);
        return {
          destroy() {
            editorView.dom.removeEventListener("keydown", onKeyDown, true);
          },
        };
      },
    }));
  }

  private static isAltSectionArrow(event: KeyboardEvent): boolean {
    if (!event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return false;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
    const target = event.target;
    if (!(target instanceof Node)) return false;
    if (target instanceof HTMLElement && target.closest("input, textarea, select")) return false;
    return true;
  }

  private static caretSlot(view: EditorView): SectionAltJumpSlot {
    const { doc, selection } = view.state;
    if (doc.childCount === 0) return "body";
    let index = selection.$head.index(0);
    if (index >= doc.childCount) index = doc.childCount - 1;
    if (index < 0) return "body";
    return doc.child(index).type.name === "heading" ? "title" : "body";
  }

  private static landingPos(doc: PmNode, slot: SectionAltJumpSlot): number {
    if (slot === "body") {
      const body = firstBodyBlockPos(doc);
      if (body !== null) return body;
    }
    return selectionAtSectionEdge(doc, "start").head;
  }
}
