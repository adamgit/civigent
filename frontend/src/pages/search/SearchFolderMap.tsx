/**
 * Sparse folder map: the shape of where the hits live.
 *
 * Only nodes that actually carry hits somewhere beneath them are drawn — an
 * empty branch is not "context", it is noise that makes the real answer harder
 * to find. Clicking a row selects that subtree; the inspector below then shows
 * every hit under it.
 */
import { Link } from "react-router-dom";
import { folderRouteForPath, stripLeadingSlashForRoute } from "../../app/docsRouteUtils";
import { DocPath } from "../../types/shared";
import type { SearchTreeNode } from "./search-hit-forest";
import { SEARCH_HIT_KIND_ORDER, SEARCH_HIT_KIND_TOKENS } from "./search-hit-kinds";

function KindBadges({ node }: { node: SearchTreeNode }) {
  return (
    <span className="ml-auto flex items-center gap-1 shrink-0">
      {SEARCH_HIT_KIND_ORDER.filter((kind) => node.descendantCounts[kind] > 0).map((kind) => {
        const tokens = SEARCH_HIT_KIND_TOKENS[kind];
        return (
          <span
            key={kind}
            className="inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded border"
            style={{
              color: tokens.foreground,
              background: tokens.background,
              borderColor: tokens.border,
            }}
            title={`${node.descendantCounts[kind]} × ${tokens.label}`}
          >
            <tokens.Icon size={11} />
            {node.descendantCounts[kind]}
          </span>
        );
      })}
    </span>
  );
}

function FolderMapRow({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: SearchTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const selected = selectedPath === node.path;
  const visibleChildren = node.children.filter((child) => child.totalDescendants > 0);
  // A folder row opens the folder BROWSER, not a document route — the row is a
  // real place in the tree, and `/docs/<folder>` is where the app already
  // browses folders.
  const openUrl =
    node.nodeKind === "folder"
      ? folderRouteForPath(node.path)
      : `/docs/${stripLeadingSlashForRoute(DocPath.parse(node.path))}`;

  return (
    <>
      <div
        className="flex items-center gap-2 rounded-md pr-2 border transition-colors hover:bg-section-hover"
        style={{
          borderColor: selected ? "var(--color-accent-border)" : "transparent",
          background: selected ? "var(--color-accent-light)" : "transparent",
        }}
      >
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          aria-pressed={selected}
          className="min-w-0 flex-1 flex items-center gap-2 text-left px-2 py-1 bg-transparent border-none"
          style={{ paddingLeft: 8 + depth * 16 }}
          title={`Show results under ${node.path}`}
        >
          <span
            className="shrink-0"
            style={{ color: node.nodeKind === "folder" ? "var(--color-agent2)" : "var(--color-accent-text)" }}
          >
            {node.nodeKind === "folder" ? (
              <SEARCH_HIT_KIND_TOKENS.path_segment.Icon size={14} />
            ) : (
              <SEARCH_HIT_KIND_TOKENS.filename.Icon size={14} />
            )}
          </span>
          <span
            className="truncate text-[13px]"
            style={{
              color: "var(--color-text-primary)",
              fontWeight: node.nodeKind === "folder" ? 600 : 400,
            }}
          >
            {node.label}
          </span>
          <KindBadges node={node} />
        </button>
        <Link
          to={openUrl}
          className="shrink-0 text-[11px] text-accent no-underline hover:underline"
          title={node.nodeKind === "folder" ? `Open folder ${node.path}` : `Open document ${node.path}`}
        >
          open →
        </Link>
      </div>
      {visibleChildren.map((child) => (
        <FolderMapRow
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function SearchFolderMap({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: SearchTreeNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="grid gap-0.5">
      <FolderMapRow node={tree} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
    </div>
  );
}
