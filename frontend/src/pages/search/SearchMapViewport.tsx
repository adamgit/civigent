/**
 * The map slot. Knows which presentation is active and nothing else — no
 * fetching, no URL, no selection policy — so a third map presentation is one
 * more case here and nothing else changes.
 */
import type { SearchTreeNode } from "./search-hit-forest";
import { SearchFolderMap } from "./SearchFolderMap";
import { SearchTreemap } from "./SearchTreemap";
import type { SearchMapMode } from "./SearchMapChrome";

export function SearchMapViewport({
  tree,
  mode,
  selectedPath,
  onSelect,
}: {
  tree: SearchTreeNode;
  mode: SearchMapMode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (mode === "treemap") {
    return <SearchTreemap tree={tree} selectedPath={selectedPath} onSelect={onSelect} />;
  }
  return <SearchFolderMap tree={tree} selectedPath={selectedPath} onSelect={onSelect} />;
}
