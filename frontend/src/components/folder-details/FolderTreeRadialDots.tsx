import { memo } from "react";
import type { DocumentTreeEntry } from "../../types/shared.js";

const WIDTH = 32;
const HEIGHT = 32;
const CENTRE_X = WIDTH / 2;
const CENTRE_Y = HEIGHT / 2;
const CENTRE_DOT_RADIUS = 0.85;
const MIN_BRANCH_RADIUS = 1.15;
const CONTENT_BYTES_PER_SCALE_UNIT = 2000;
const HALO_GAP = 1.1;

interface TreeMass {
  documentCount: number;
  folderCount: number;
  sizeBytes: number;
}

function treeMass(entry: DocumentTreeEntry): TreeMass {
  if (entry.type === "file") {
    return { documentCount: 1, folderCount: 0, sizeBytes: entry.size_bytes ?? 0 };
  }

  let documentCount = 0;
  let folderCount = 1;
  let sizeBytes = 0;
  for (const child of entry.children ?? []) {
    const childMass = treeMass(child);
    documentCount += childMass.documentCount;
    folderCount += childMass.folderCount;
    sizeBytes += childMass.sizeBytes;
  }
  return { documentCount, folderCount, sizeBytes };
}

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

function haloCount(descendantFolderCount: number): number {
  if (descendantFolderCount === 0) return 0;
  if (descendantFolderCount <= 3) return 1;
  if (descendantFolderCount <= 15) return 2;
  return 3;
}

export const FolderTreeRadialDots = memo(function FolderTreeRadialDots({
  entry,
  className = "h-7 w-7 shrink-0 text-folder-link",
}: {
  entry: DocumentTreeEntry;
  className?: string;
}) {
  const branches = (entry.children ?? [])
    .filter((child) => child.type === "directory")
    .map((child) => ({ entry: child, ...treeMass(child) }));
  const maximumRadius = maxBranchRadius(branches.length);
  const radiusOfOrbit = orbitRadius(branches.length);
  const totalDocuments = branches.reduce((total, branch) => total + branch.documentCount, 0);
  const label =
    branches.length === 0
      ? "Folder tree: no immediate subfolders"
      : `Folder tree: ${branches.length} immediate subfolder${branches.length === 1 ? "" : "s"} ` +
        `containing ${totalDocuments} document${totalDocuments === 1 ? "" : "s"} recursively`;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={className}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {branches.map((branch, index) => {
        const angle = branches.length === 1 ? 0 : (index / branches.length) * Math.PI * 2;
        const x = CENTRE_X + Math.cos(angle) * radiusOfOrbit;
        const y = CENTRE_Y + Math.sin(angle) * radiusOfOrbit;
        return (
          <line
            key={`line-${branch.entry.path}`}
            x1={CENTRE_X}
            y1={CENTRE_Y}
            x2={x}
            y2={y}
            stroke="currentColor"
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
        const descendantFolderCount = Math.max(0, branch.folderCount - 1);
        const rings = haloCount(descendantFolderCount);
        const approximatePages =
          branch.documentCount === 0
            ? 0
            : Math.max(1, Math.round(branch.sizeBytes / CONTENT_BYTES_PER_SCALE_UNIT));
        const branchLabel =
          `${branch.entry.name}: ${branch.documentCount} document` +
          `${branch.documentCount === 1 ? "" : "s"}, ${descendantFolderCount} descendant folder` +
          `${descendantFolderCount === 1 ? "" : "s"}, ~${approximatePages} page` +
          `${approximatePages === 1 ? "" : "s"} in its tree`;
        return (
          <g key={branch.entry.path}>
            <title>{branchLabel}</title>
            {Array.from({ length: rings }, (_, ringIndex) => {
              const isOutermostLargeTree =
                descendantFolderCount >= 64 && ringIndex === rings - 1;
              return (
                <circle
                  key={ringIndex}
                  cx={cx}
                  cy={cy}
                  r={radius + HALO_GAP * (ringIndex + 1)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="0.55"
                  strokeDasharray={isOutermostLargeTree ? "1.2 1.2" : undefined}
                  opacity={0.2 + ringIndex * 0.05}
                />
              );
            })}
            <circle cx={cx} cy={cy} r={radius} fill="currentColor" opacity="0.72" />
          </g>
        );
      })}
    </svg>
  );
});
