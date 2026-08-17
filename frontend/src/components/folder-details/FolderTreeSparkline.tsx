import type { DocumentTreeEntry } from "../../types/shared.js";

const MAX_BRANCHES = 4;
const MAX_RENDERED_DEPTH = 4;
const WIDTH = 54;
const HEIGHT = 18;
const ROOT_X = 2.5;
const FIRST_NODE_X = 13;
const DEPTH_STEP = 9;

interface SubtreeStats {
  documentCount: number;
  folderCount: number;
  maxFolderDepth: number;
}

interface RenderedBranch extends SubtreeStats {
  key: string;
  collapsed: boolean;
}

function subtreeStats(entry: DocumentTreeEntry): SubtreeStats {
  if (entry.type === "file") {
    return { documentCount: 1, folderCount: 0, maxFolderDepth: 0 };
  }

  let documentCount = 0;
  let folderCount = 0;
  let maxFolderDepth = 0;
  for (const child of entry.children ?? []) {
    const childStats = subtreeStats(child);
    documentCount += childStats.documentCount;
    folderCount += childStats.folderCount;
    if (child.type === "directory") {
      folderCount += 1;
      maxFolderDepth = Math.max(maxFolderDepth, childStats.maxFolderDepth + 1);
    }
  }
  return { documentCount, folderCount, maxFolderDepth };
}

function aggregateBranches(entries: DocumentTreeEntry[]): RenderedBranch[] {
  const folders = entries.filter((entry) => entry.type === "directory");
  if (folders.length <= MAX_BRANCHES) {
    return folders.map((folder) => ({
      ...subtreeStats(folder),
      key: folder.path,
      collapsed: false,
    }));
  }

  const visible = folders.slice(0, MAX_BRANCHES - 1).map((folder) => ({
    ...subtreeStats(folder),
    key: folder.path,
    collapsed: false,
  }));
  const remainder = folders.slice(MAX_BRANCHES - 1).map(subtreeStats);
  visible.push({
    key: "collapsed-branches",
    collapsed: true,
    documentCount: remainder.reduce((total, stats) => total + stats.documentCount, 0),
    folderCount: remainder.reduce((total, stats) => total + stats.folderCount + 1, 0),
    maxFolderDepth: remainder.reduce(
      (depth, stats) => Math.max(depth, stats.maxFolderDepth),
      0,
    ),
  });
  return visible;
}

function canopyRadius(documentCount: number): number {
  if (documentCount === 0) return 1.5;
  return Math.min(4.25, 1.6 + Math.log2(documentCount + 1) * 0.48);
}

export function FolderTreeSparkline({ entry }: { entry: DocumentTreeEntry }) {
  const branches = aggregateBranches(entry.children ?? []);
  if (branches.length === 0) return null;

  const totals = subtreeStats(entry);
  const branchGap = HEIGHT / (branches.length + 1);
  const firstY = branchGap;
  const lastY = branchGap * branches.length;
  const label =
    `Folder tree: ${totals.documentCount} document${totals.documentCount === 1 ? "" : "s"} ` +
    `across ${totals.folderCount} nested folder${totals.folderCount === 1 ? "" : "s"}, ` +
    `depth ${totals.maxFolderDepth}`;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-[18px] w-[54px] shrink-0 overflow-visible text-folder-link"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {branches.length > 1 ? (
        <path
          d={`M ${ROOT_X} ${firstY} V ${lastY}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          opacity="0.38"
        />
      ) : null}
      {branches.map((branch, branchIndex) => {
        const y = branchGap * (branchIndex + 1);
        const renderedDepth = Math.min(
          MAX_RENDERED_DEPTH,
          Math.max(1, branch.maxFolderDepth + 1),
        );
        const endX = FIRST_NODE_X + (renderedDepth - 1) * DEPTH_STEP;
        const radius = canopyRadius(branch.documentCount);
        return (
          <g key={branch.key}>
            <path
              d={`M ${ROOT_X} ${y} H ${endX}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
              strokeDasharray={branch.collapsed ? "2 2" : undefined}
              opacity="0.42"
            />
            {Array.from({ length: renderedDepth - 1 }, (_, depthIndex) => (
              <circle
                key={depthIndex}
                cx={FIRST_NODE_X + depthIndex * DEPTH_STEP}
                cy={y}
                r="1"
                fill="currentColor"
                opacity="0.48"
              />
            ))}
            <circle
              cx={endX}
              cy={y}
              r={radius}
              fill={branch.documentCount > 0 ? "currentColor" : "none"}
              fillOpacity={branch.documentCount > 0 ? 0.72 : undefined}
              stroke="currentColor"
              strokeWidth="1"
              opacity={branch.documentCount > 0 ? 1 : 0.52}
            />
          </g>
        );
      })}
    </svg>
  );
}
