import path from "node:path";
import { readdir } from "node:fs/promises";
import { canonicalDocumentExists } from "../storage/document-reader.js";
import { docPathFromContentRelativeFsPath } from "../storage/path-utils.js";
import { ProposalReader } from "../storage/proposal-reader.js";
import type { ActiveProposal, WriterType, WsServerEvent } from "../types/shared.js";
import { DocPath } from "../types/shared.js";

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

export { canonicalDocumentExists };

export async function summarizeProposalCatalogMutations(
  proposal: Pick<ActiveProposal, "id" | "status" | "sections">,
): Promise<CatalogMutationSummary> {
  const reader = ProposalReader.open(proposal.id, proposal.status);
  const overlayDocPaths = await listOverlayDocPaths(reader.proposalContentRoot);
  const docPaths = Array.from(new Set<DocPath>([
    ...proposal.sections.map((section) => section.doc_path),
    ...overlayDocPaths,
  ]));

  const createdDocPaths: DocPath[] = [];
  const deletedDocPaths: DocPath[] = [];

  for (const docPath of docPaths) {
    const [existsInCanonical, overlayState] = await Promise.all([
      canonicalDocumentExists(docPath),
      reader.getDocumentState(docPath),
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

async function listOverlayDocPaths(root: string): Promise<DocPath[]> {
  const docPaths = new Set<DocPath>();
  await walkOverlayTree(root, "", docPaths);
  return Array.from(docPaths);
}

async function walkOverlayTree(root: string, relativeDir: string, docPaths: Set<DocPath>): Promise<void> {
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
      docPaths.add(docPathFromContentRelativeFsPath(nextRelative));
      continue;
    }

    if (entry.name.endsWith(`.md${TOMBSTONE_SUFFIX}`)) {
      docPaths.add(docPathFromContentRelativeFsPath(nextRelative.slice(0, -TOMBSTONE_SUFFIX.length)));
    }
  }
}
