import path from "node:path";
import { access, readdir } from "node:fs/promises";
import { OverlayContentLayer } from "../storage/content-layer.js";
import { getContentRoot } from "../storage/data-root.js";
import { resolveDocPathUnderContent, InvalidDocPathError } from "../storage/path-utils.js";
import { proposalContentRoot } from "../storage/proposal-repository.js";
import type { AnyProposal, WriterType, WsServerEvent } from "../types/shared.js";

const SECTIONS_DIR_SUFFIX = ".sections";
const TOMBSTONE_SUFFIX = ".tombstone";

export interface CatalogMutationSummary {
  catalogChanged: boolean;
  createdDocPaths: string[];
  deletedDocPaths: string[];
  renamed:
    | {
        oldPath: string;
        newPath: string;
      }
    | null;
}

export async function canonicalDocumentExists(docPath: string): Promise<boolean> {
  try {
    const resolvedPath = resolveDocPathUnderContent(getContentRoot(), docPath);
    await access(resolvedPath);
    return true;
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      return false;
    }
    return false;
  }
}

export async function summarizeProposalCatalogMutations(
  proposal: Pick<AnyProposal, "id" | "status" | "sections">,
): Promise<CatalogMutationSummary> {
  const canonicalRoot = getContentRoot();
  const overlayRoot = proposalContentRoot(proposal.id, proposal.status);
  const overlayLayer = new OverlayContentLayer(overlayRoot, canonicalRoot);
  const overlayDocPaths = await listOverlayDocPaths(overlayRoot);
  const docPaths = Array.from(new Set([
    ...proposal.sections
      .map((section) => section.doc_path)
      .filter((docPath): docPath is string => typeof docPath === "string" && docPath.trim().length > 0),
    ...overlayDocPaths,
  ]));

  const createdDocPaths: string[] = [];
  const deletedDocPaths: string[] = [];

  for (const docPath of docPaths) {
    const [existsInCanonical, overlayState] = await Promise.all([
      canonicalDocumentExists(docPath),
      overlayLayer.getDocumentState(docPath),
    ]);

    if (!existsInCanonical && overlayState === "live") {
      createdDocPaths.push(docPath);
      continue;
    }

    if (existsInCanonical && overlayState === "tombstone") {
      deletedDocPaths.push(docPath);
    }
  }

  const renamed =
    createdDocPaths.length === 1 && deletedDocPaths.length === 1
      ? { oldPath: deletedDocPaths[0], newPath: createdDocPaths[0] }
      : null;

  return {
    catalogChanged: createdDocPaths.length > 0 || deletedDocPaths.length > 0,
    createdDocPaths,
    deletedDocPaths,
    renamed,
  };
}

export function emitCatalogMutationEvents(
  emitEvent: ((event: WsServerEvent) => void) | undefined,
  summary: CatalogMutationSummary,
  writer: { type: WriterType; displayName: string },
  committedHead?: string,
): void {
  if (!emitEvent) {
    return;
  }
  if (summary.renamed && committedHead) {
    emitEvent({
      type: "doc:renamed",
      old_path: summary.renamed.oldPath,
      new_path: summary.renamed.newPath,
      committed_head: committedHead,
    });
  }
  if (!summary.catalogChanged) {
    return;
  }
  emitEvent({
    type: "catalog:changed",
    added_doc_paths: summary.createdDocPaths,
    removed_doc_paths: summary.deletedDocPaths,
    writer_type: writer.type,
    writer_display_name: writer.displayName,
  });
}

async function listOverlayDocPaths(root: string): Promise<string[]> {
  const docPaths = new Set<string>();
  await walkOverlayTree(root, "", docPaths);
  return Array.from(docPaths);
}

async function walkOverlayTree(root: string, relativeDir: string, docPaths: Set<string>): Promise<void> {
  const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const nextRelative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.endsWith(SECTIONS_DIR_SUFFIX)) {
        continue;
      }
      await walkOverlayTree(root, nextRelative, docPaths);
      continue;
    }

    if (entry.name.endsWith(".md")) {
      docPaths.add(`/${nextRelative}`);
      continue;
    }

    if (entry.name.endsWith(`.md${TOMBSTONE_SUFFIX}`)) {
      docPaths.add(`/${nextRelative.slice(0, -TOMBSTONE_SUFFIX.length)}`);
    }
  }
}
