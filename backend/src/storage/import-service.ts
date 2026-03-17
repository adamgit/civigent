/**
 * import-service.ts — Shared import pipeline via proposals.
 *
 * importFilesToProposal() is the single codepath that both browser-upload
 * and CLI staging folder import converge on. Everything goes through the
 * proposal system — no direct skeleton creation, no direct git commits.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ContentLayer } from "./content-layer.js";
import { DocumentSkeleton } from "./document-skeleton.js";
import { SectionRef } from "../domain/section-ref.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { gitExec } from "./git-repo.js";
import { createProposal } from "./proposal-repository.js";
import { parseImportDocument } from "./content-import.js";
import type { Proposal, ProposalSection, WriterIdentity } from "../types/shared.js";

export interface ImportFile {
  docPath: string;
  content: string;
}

export interface ImportFilesToProposalResult {
  proposal: Proposal;
  contentRoot: string;
  createdDocuments: string[];
}

/**
 * Import markdown files into the Knowledge Store through a proposal.
 *
 * For each file:
 *   1. If the document doesn't exist, create its skeleton + empty root
 *      section in canonical (bootstrapping commit) so the skeleton exists
 *      for the proposal to reference.
 *   2. Parse the markdown into sections via parseImportDocument().
 *   3. Ensure all sections exist in the skeleton (add missing ones).
 *   4. Collect all sections + content for the proposal.
 *
 * Then creates a single proposal containing all sections from all files,
 * writes the content into the proposal overlay, and returns the proposal
 * for the caller to evaluate and commit.
 */
export async function importFilesToProposal(
  files: ImportFile[],
  writer: WriterIdentity,
  description: string,
): Promise<ImportFilesToProposalResult> {
  const contentRoot = getContentRoot();
  const dataRoot = getDataRoot();
  const createdDocuments: string[] = [];
  const allSections: ProposalSection[] = [];
  const sectionContents: Array<{ doc_path: string; heading_path: string[]; content: string }> = [];

  for (const file of files) {
    const { docPath, content } = file;
    const parsed = parseImportDocument(docPath, content);

    // Check if document exists
    let docExists = false;
    try {
      const skelPath = path.join(contentRoot, docPath);
      await access(skelPath);
      docExists = true;
    } catch {
      // Does not exist
    }

    if (!docExists) {
      // Bootstrap: create skeleton + empty root in canonical so the proposal
      // can reference the document. This is the minimal structural commit
      // needed before sections can be addressed by heading path.
      const skeleton = DocumentSkeleton.createEmpty(docPath, contentRoot);
      await skeleton.persist();

      const bootstrapLayer = new ContentLayer(contentRoot);
      await bootstrapLayer.writeSection(new SectionRef(docPath, []), "");

      await gitExec(["add", "content/"], dataRoot);
      await gitExec(
        [
          "-c", "user.name=Knowledge Store",
          "-c", "user.email=system@knowledge-store.local",
          "commit",
          "-m", `create document: ${docPath}`,
          "--allow-empty",
        ],
        dataRoot,
      );
      createdDocuments.push(docPath);
    }

    // Load skeleton (now guaranteed to exist)
    const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);

    // Root section: for no-heading docs the full content goes to root,
    // for headed docs root gets empty string (content lives in headed sections).
    const rootBody = parsed.sections.length === 0 ? content : "";
    if (rootBody || parsed.sections.length === 0) {
      allSections.push({ doc_path: docPath, heading_path: [] });
      sectionContents.push({ doc_path: docPath, heading_path: [], content: rootBody });
    }

    // Each parsed heading becomes a proposal section
    for (const section of parsed.sections) {
      const headingPath = [section.heading];
      allSections.push({ doc_path: docPath, heading_path: headingPath });
      sectionContents.push({ doc_path: docPath, heading_path: headingPath, content: section.body });

      // Ensure the section exists in the skeleton
      try {
        skeleton.resolve(headingPath);
      } catch {
        skeleton.addSectionsFromRootSplit([{
          heading: section.heading,
          level: section.depth,
          body: "",
        }]);
      }
    }

    // If skeleton was modified, persist and commit structural changes
    if (skeleton.dirty) {
      await skeleton.persist();

      // Ensure body files exist for all sections
      const bodyFilePromises: Promise<void>[] = [];
      skeleton.forEachSection((_heading, _level, _sectionFile, _headingPath, absolutePath, isSubSkeleton) => {
        if (isSubSkeleton) return;
        bodyFilePromises.push((async () => {
          const dir = path.dirname(absolutePath);
          await mkdir(dir, { recursive: true });
          try {
            await access(absolutePath);
          } catch {
            await writeFile(absolutePath, "", "utf8");
          }
        })());
      });
      await Promise.all(bodyFilePromises);

      await gitExec(["add", "content/"], dataRoot);
      await gitExec(
        [
          "-c", "user.name=Knowledge Store",
          "-c", "user.email=system@knowledge-store.local",
          "commit",
          "-m", `import: create sections in ${docPath}`,
          "--allow-empty",
        ],
        dataRoot,
      );
    }
  }

  // Create a single proposal for all imported content
  const { proposal, contentRoot: propContentRoot } = await createProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    description,
    allSections,
  );

  // Write content to proposal overlay
  const propLayer = new ContentLayer(propContentRoot);
  for (const sc of sectionContents) {
    await propLayer.writeSection(new SectionRef(sc.doc_path, sc.heading_path), sc.content);
  }

  return { proposal, contentRoot: propContentRoot, createdDocuments };
}

