import type { EditorView } from "@milkdown/prose/view";
import type { BlockDropEdge, BlockOwnerAddress } from "./block-drag-model";
import { resolveOwnerBlockByAddress } from "./block-drag-pm-owner-resolver";

export function applyIntraSectionBodyMove(
  view: EditorView,
  sourceAddress: BlockOwnerAddress,
  targetAddress: BlockOwnerAddress,
  edge: BlockDropEdge,
): boolean {
  const source = resolveOwnerBlockByAddress(view, sourceAddress);
  const target = resolveOwnerBlockByAddress(view, targetAddress);
  if (!source || !target) return false;
  const insertAt = edge === "before" ? target.range.from : target.range.to;
  const tr = view.state.tr.delete(source.range.from, source.range.to);
  const mapped = tr.mapping.map(insertAt, source.range.from < insertAt ? -1 : 1);
  if (mapped === source.range.from) return false;
  tr.insert(mapped, source.node);
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}
