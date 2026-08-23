import { memo } from "react";
import type { DocumentTreeEntry } from "../../types/shared.js";
import {
  CONTENT_BYTES_PER_SCALE_UNIT,
  folderTreeBranchHue,
  readFolderTreeIcon,
} from "./folder-tree-icon-reading";

const WIDTH = 32;
const HEIGHT = 32;
const CENTRE_X = WIDTH / 2;
const CENTRE_Y = HEIGHT / 2;
const CENTRE_DOT_RADIUS = 0.85;
const MIN_BRANCH_RADIUS = 1.15;
const HALO_GAP = 1.1;

function maxBranchRadius(branchCount: number): number {
  if (branchCount <= 8) return 3.25;
  if (branchCount <= 14) return 2.6;
  return 2;
}

function orbitRadius(branchCount: number): number {
  if (branchCount <= 6) return 8;
  if (branchCount <= 10) return 9.5;
  return 10.5;
}

function branchRadius(
  sizeBytes: number,
  documentCount: number,
  maximumRadius: number,
): number {
  const contentUnits = Math.max(documentCount, sizeBytes / CONTENT_BYTES_PER_SCALE_UNIT);
  const radius = MIN_BRANCH_RADIUS + Math.log2(contentUnits + 1) * 0.38;
  return Math.min(maximumRadius, radius);
}

export const FolderTreeRadialDots = memo(function FolderTreeRadialDots({
  entry,
  className = "h-7 w-7 shrink-0 text-folder-link",
  nativeTitles = true,
  colorizeBranches = false,
}: {
  entry: DocumentTreeEntry;
  className?: string;
  nativeTitles?: boolean;
  /** Popup only. Off by default so the card / watermark / home marks stay monochrome. */
  colorizeBranches?: boolean;
}) {
  const reading = readFolderTreeIcon(entry);
  const branches = reading.branches;
  const maximumRadius = maxBranchRadius(branches.length);
  const radiusOfOrbit = orbitRadius(branches.length);
  const label =
    branches.length === 0
      ? "Folder tree: no immediate subfolders"
      : `Folder tree: ${branches.length} immediate subfolder${branches.length === 1 ? "" : "s"} ` +
        `containing ${reading.totalDocuments} document${reading.totalDocuments === 1 ? "" : "s"} recursively`;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={className}
      role="img"
      aria-label={label}
    >
      {nativeTitles ? <title>{label}</title> : null}
      {branches.map((branch, index) => {
        const angle = branches.length === 1 ? 0 : (index / branches.length) * Math.PI * 2;
        const x = CENTRE_X + Math.cos(angle) * radiusOfOrbit;
        const y = CENTRE_Y + Math.sin(angle) * radiusOfOrbit;
        const branchColor = colorizeBranches ? folderTreeBranchHue(index) : "currentColor";
        return (
          <line
            key={`line-${branch.path}`}
            x1={CENTRE_X}
            y1={CENTRE_Y}
            x2={x}
            y2={y}
            stroke={branchColor}
            strokeWidth="0.65"
            opacity="0.3"
          />
        );
      })}
      <circle
        cx={CENTRE_X}
        cy={CENTRE_Y}
        r={CENTRE_DOT_RADIUS}
        fill="currentColor"
        opacity="0.95"
      />
      {branches.map((branch, index) => {
        const angle = branches.length === 1 ? 0 : (index / branches.length) * Math.PI * 2;
        const cx = CENTRE_X + Math.cos(angle) * radiusOfOrbit;
        const cy = CENTRE_Y + Math.sin(angle) * radiusOfOrbit;
        const radius = branchRadius(branch.sizeBytes, branch.documentCount, maximumRadius);
        const branchColor = colorizeBranches ? folderTreeBranchHue(index) : "currentColor";
        const approximatePages =
          branch.documentCount === 0
            ? 0
            : Math.max(1, Math.round(branch.sizeBytes / CONTENT_BYTES_PER_SCALE_UNIT));
        const branchLabel =
          `${branch.name}: ${branch.documentCount} document` +
          `${branch.documentCount === 1 ? "" : "s"}, ${branch.descendantFolderCount} descendant folder` +
          `${branch.descendantFolderCount === 1 ? "" : "s"}, ~${approximatePages} page` +
          `${approximatePages === 1 ? "" : "s"} in its tree`;
        return (
          <g key={branch.path}>
            {nativeTitles ? <title>{branchLabel}</title> : null}
            {Array.from({ length: branch.rings }, (_, ringIndex) => (
              <circle
                key={ringIndex}
                cx={cx}
                cy={cy}
                r={radius + HALO_GAP * (ringIndex + 1)}
                fill="none"
                stroke={branchColor}
                strokeWidth="0.55"
                strokeDasharray={
                  branch.dashedOuterRing && ringIndex === branch.rings - 1 ? "1.2 1.2" : undefined
                }
                opacity={0.2 + ringIndex * 0.05}
              />
            ))}
            <circle cx={cx} cy={cy} r={radius} fill={branchColor} opacity="0.72" />
          </g>
        );
      })}
    </svg>
  );
});
