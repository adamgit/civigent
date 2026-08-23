import type { DocumentTreeEntry } from "../../types/shared.js";

/** Bytes treated as one “page” when sizing a subtree dot. */
export const CONTENT_BYTES_PER_SCALE_UNIT = 2000;

export interface FolderTreeIconBranch {
  name: string;
  path: string;
  documentCount: number;
  descendantFolderCount: number;
  sizeBytes: number;
  rings: number;
  dashedOuterRing: boolean;
}

export interface FolderTreeIconReading {
  immediateSubfolderCount: number;
  totalDocuments: number;
  ringedCount: number;
  branches: FolderTreeIconBranch[];
}

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

/** Rings around a dot: nested folders under that immediate subfolder. */
export function haloCount(descendantFolderCount: number): number {
  if (descendantFolderCount === 0) return 0;
  if (descendantFolderCount <= 3) return 1;
  if (descendantFolderCount <= 15) return 2;
  return 3;
}

export function contentUnits(documentCount: number, sizeBytes: number): number {
  return Math.max(documentCount, sizeBytes / CONTENT_BYTES_PER_SCALE_UNIT);
}

export function readFolderTreeIcon(entry: DocumentTreeEntry): FolderTreeIconReading {
  const branches = (entry.children ?? [])
    .filter((child) => child.type === "directory")
    .map((child) => {
      const mass = treeMass(child);
      const descendantFolderCount = Math.max(0, mass.folderCount - 1);
      return {
        name: child.name,
        path: child.path,
        documentCount: mass.documentCount,
        descendantFolderCount,
        sizeBytes: mass.sizeBytes,
        rings: haloCount(descendantFolderCount),
        dashedOuterRing: descendantFolderCount >= 64,
      };
    });

  return {
    immediateSubfolderCount: branches.length,
    totalDocuments: branches.reduce((total, branch) => total + branch.documentCount, 0),
    ringedCount: branches.filter((branch) => branch.rings > 0).length,
    branches,
  };
}

function counted(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Distinct child-dot hues for the popup only. Index-stable with the renderer. */
const BRANCH_HUE_STEP_DEG = 137.508;
const BRANCH_HUE_SATURATION = "46%";
const BRANCH_HUE_LIGHTNESS = "38%";

export function folderTreeBranchHue(index: number): string {
  const hue = Math.round((index * BRANCH_HUE_STEP_DEG) % 360);
  return `hsl(${hue} ${BRANCH_HUE_SATURATION} ${BRANCH_HUE_LIGHTNESS})`;
}

export interface FolderTreeIconLegendFolder {
  path: string;
  name: string;
  detail: string;
  hue: string;
}

export interface FolderTreeIconLegend {
  summary: string;
  folders: FolderTreeIconLegendFolder[];
  leftoverNote: string | null;
}

function describeBranchDetail(branch: FolderTreeIconBranch): string {
  const facts: string[] = [];
  if (branch.descendantFolderCount > 0) {
    facts.push(counted(branch.descendantFolderCount, "nested folder", "nested folders"));
  }
  facts.push(counted(branch.documentCount, "document", "documents"));
  return facts.join("; ");
}

function namedBranches(reading: FolderTreeIconReading): FolderTreeIconBranch[] {
  if (reading.branches.length <= 6) {
    return reading.branches;
  }
  const ringed = reading.branches.filter((branch) => branch.rings > 0);
  const largest = reading.branches.reduce((current, branch) =>
    contentUnits(branch.documentCount, branch.sizeBytes) >
    contentUnits(current.documentCount, current.sizeBytes)
      ? branch
      : current,
  );
  if (ringed.some((branch) => branch.path === largest.path)) {
    return ringed;
  }
  if (largest.documentCount === 0 && largest.sizeBytes === 0) {
    return ringed;
  }
  return [...ringed, largest];
}

function folderTreeIconSummary(reading: FolderTreeIconReading): string {
  if (reading.branches.length === 0) {
    return "No immediate subfolders.";
  }
  const parts = [
    counted(reading.immediateSubfolderCount, "immediate subfolder", "immediate subfolders"),
    `${counted(reading.totalDocuments, "document", "documents")} across all subtrees`,
  ];
  if (reading.ringedCount > 0) {
    parts.push("nested folders underneath");
  }
  return parts.join(", ");
}

/** Instance-specific copy for this folder’s radial icon, matching the renderer. */
export function folderTreeIconLegend(reading: FolderTreeIconReading): FolderTreeIconLegend {
  const named = namedBranches(reading);
  const folders = named.map((branch) => ({
    path: branch.path,
    name: branch.name,
    detail: describeBranchDetail(branch),
    hue: folderTreeBranchHue(reading.branches.indexOf(branch)),
  }));
  const unnamed = reading.branches.length - named.length;
  return {
    summary: folderTreeIconSummary(reading),
    folders,
    leftoverNote:
      unnamed > 0
        ? `The other ${counted(unnamed, "dot has", "dots have")} no nested folders.`
        : null,
  };
}
