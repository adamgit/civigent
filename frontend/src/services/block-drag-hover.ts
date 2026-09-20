import type { BlockDropEdge, BlockDropSlot, GripSourceKind } from "./block-drag-model";
import { resolveDragSessionEditorAt } from "./block-drag-editor-registry";
import { BLOCK_HANDLE_SELECTOR } from "./block-drag-grip-guard";
import { resolveGrippedBlock, resolveHoverOwnerBlock } from "./block-drag-pm-owner-resolver";
import { resolveStaticOwnerElement } from "./block-drag-static-hit-test";

export const GRIP_SECTION_ROW_SELECTOR = "[data-document-section][data-fragment-key]";

const GRIP_DEAD_ZONE_SELECTOR = [
  ".doc-topbar",
  ".doc-section-nav",
  ".doc-paper-header",
  ".doc-paper-sticky-header",
].join(",");

export type GripHoverSlot =
  | {
      readonly kind: "body";
      readonly slot: BlockDropSlot;
      readonly rect: DOMRect;
    }
  | {
      readonly kind: "outline";
      readonly fragmentKey: string;
      readonly edge: BlockDropEdge;
      readonly rect: DOMRect;
    };

export function dropEdgeFromRect(clientY: number, rect: DOMRect): BlockDropEdge {
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function resolveBodyOwnerSlot(
  hit: Element,
  row: HTMLElement,
  fragmentKey: string,
  clientY: number,
): Extract<GripHoverSlot, { kind: "body" }> | null {
  const editor = resolveDragSessionEditorAt(hit);
  if (editor && editor.fragmentKey === fragmentKey) {
    const handle = hit.closest(BLOCK_HANDLE_SELECTOR);
    const pm =
      handle instanceof HTMLElement
        ? resolveGrippedBlock(editor.view, handle.getBoundingClientRect())
        : editor.view.dom.contains(hit)
          ? resolveHoverOwnerBlock(editor.view, hit)
          : null;
    if (!pm) return null;
    return {
      kind: "body",
      slot: {
        fragmentKey,
        owner: pm.address,
        edge: dropEdgeFromRect(clientY, pm.rect),
      },
      rect: pm.rect,
    };
  }
  const staticHit = resolveStaticOwnerElement(hit, row);
  if (!staticHit) return null;
  const rect = staticHit.element.getBoundingClientRect();
  return {
    kind: "body",
    slot: {
      fragmentKey,
      owner: {
        path: staticHit.path,
        kind: staticHit.kind,
        fingerprint: staticHit.fingerprint,
      },
      edge: dropEdgeFromRect(clientY, rect),
    },
    rect,
  };
}

export function resolveGripPointerHover(
  clientX: number,
  clientY: number,
  sectionList: HTMLElement,
  source: { fragmentKey: string; sourceKind: GripSourceKind },
): { fragmentKey: string; slot: GripHoverSlot } | null {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!(hit instanceof Element) || !sectionList.contains(hit)) return null;
  if (hit.closest(GRIP_DEAD_ZONE_SELECTOR)) return null;
  const row = hit.closest(GRIP_SECTION_ROW_SELECTOR);
  if (!(row instanceof HTMLElement)) return null;
  const fragmentKey = row.getAttribute("data-fragment-key");
  if (!fragmentKey) return null;
  if (source.sourceKind === "identity-heading" && fragmentKey !== source.fragmentKey) {
    const rect = row.getBoundingClientRect();
    return {
      fragmentKey,
      slot: {
        kind: "outline",
        fragmentKey,
        edge: dropEdgeFromRect(clientY, rect),
        rect,
      },
    };
  }
  const body = resolveBodyOwnerSlot(hit, row, fragmentKey, clientY);
  if (!body) return null;
  return { fragmentKey, slot: body };
}
