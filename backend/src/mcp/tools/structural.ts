/**
 * Tier 3 structural MCP tools — section creation, deletion, movement, renaming.
 *
 * Tools: create_section, delete_section, move_section, rename_section,
 *        delete_document
 *
 * All structural tools operate directly on the DocumentSkeleton + section
 * files on disk. They are guarded by human-involvement checks, proposal contention
 * checks, and active session checks before committing changes via git.
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult, textToolResult } from "../tool-registry.js";
import { makeToolErrorResult } from "../protocol.js";
import { deleteDocument } from "./filesystem.js";
import { renameDocument } from "../../storage/document-rename.js";
import { getContentRoot, getDataRoot } from "../../storage/data-root.js";
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import { generateSectionFilename } from "../../storage/markdown-sections.js";
import { gitExec } from "../../storage/git-repo.js";
import { DocumentNotFoundError } from "../../storage/document-reader.js";
import { InvalidDocPathError } from "../../storage/path-utils.js";
import { lookupDocSession, getAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { listProposals } from "../../storage/proposal-repository.js";
import { SectionRef } from "../../domain/section-ref.js";
import { SectionGuard } from "../../domain/section-guard.js";
import { readDocSectionCommitInfo } from "../../storage/section-activity.js";
import type { McpToolCallResult } from "../protocol.js";
import path from "node:path";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";

// ─── Helper: git commit structural changes ──────────────

async function gitCommitStructural(message: string, affectedDocPath?: string): Promise<void> {
  const dataRoot = getDataRoot();
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Knowledge Store",
      "-c", "user.email=system@knowledge-store.local",
      "commit",
      "-m", message,
      "--allow-empty",
    ],
    dataRoot,
  );

  // Update baseHead on active sessions whose docPath matches the committed document
  const newHead = await getHeadSha(dataRoot);
  if (affectedDocPath) {
    const session = lookupDocSession(affectedDocPath);
    if (session) {
      session.baseHead = newHead;
    }
  } else {
    // No specific doc — update all sessions (e.g. bulk operations)
    for (const session of getAllSessions().values()) {
      session.baseHead = newHead;
    }
  }
}

// ─── Contention guard ────────────────────────────────────

/**
 * Check for active CRDT sessions on the document. Returns an error result if blocked.
 */
function checkDocSessionGuard(docPath: string): McpToolCallResult | null {
  const session = lookupDocSession(docPath);
  if (!session) return null;
  if (session.holders.size > 0) {
    return makeToolErrorResult(
      `Cannot modify document structure: active editing session exists on "${docPath}".`,
    );
  }
  // Block when dirty fragments exist without active holders — uncommitted overlay
  // files would be overwritten or orphaned by the structural git commit.
  for (const dirtySet of session.perUserDirty.values()) {
    if (dirtySet.size > 0) {
      return makeToolErrorResult(
        `Cannot modify document structure: uncommitted edits exist on "${docPath}". Wait for auto-commit to flush.`,
      );
    }
  }
  return null;
}

/**
 * Check for pending proposals that reference any of the given sections.
 * Returns an error result if blocked.
 */
async function checkProposalGuard(
  docPath: string,
  headingPaths: string[][],
): Promise<McpToolCallResult | null> {
  const pending = await listProposals("pending");
  for (const proposal of pending) {
    for (const section of proposal.sections) {
      if (section.doc_path !== docPath) continue;
      for (const hp of headingPaths) {
        if (SectionRef.headingPathsEqual(section.heading_path, hp)) {
          return makeToolErrorResult(
            `Cannot modify section "${hp.join(" > ")}": pending proposal ${proposal.id} (${proposal.writer.displayName}) references it.`,
          );
        }
      }
    }
  }
  return null;
}

/**
 * Check human-involvement scores for affected sections. Returns an error result
 * if any section has high human involvement (blocked).
 */
async function checkInvolvementGuard(
  docPath: string,
  headingPaths: string[][],
): Promise<McpToolCallResult | null> {
  const commitInfo = await readDocSectionCommitInfo(docPath, headingPaths.length);
  for (const hp of headingPaths) {
    const ref = new SectionRef(docPath, hp);
    const verdict = await SectionGuard.evaluate(ref, commitInfo);
    if (verdict.blocked) {
      return makeToolErrorResult(
        `Cannot modify section "${hp.join(" > ")}": human involvement score is ${verdict.humanInvolvement_score.toFixed(2)} (blocked). Wait for involvement to decay or ask the human to step away.`,
      );
    }
  }
  return null;
}

// ─── create_section ──────────────────────────────────────

const createSectionHandler: ToolHandler = async (args) => {
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const content = (args.content as string | undefined) ?? "";
  const level = (args.level as number | undefined) ?? 2;

  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Missing required parameter: heading_path (non-empty array)");
  }

  // Contention guards
  const sessionBlock = checkDocSessionGuard(docPath);
  if (sessionBlock) return sessionBlock;

  // Check proposals referencing the parent heading path (structural insertion affects it)
  const parentPath = headingPath.slice(0, -1);
  if (parentPath.length > 0) {
    const proposalBlock = await checkProposalGuard(docPath, [parentPath]);
    if (proposalBlock) return proposalBlock;
  }

  try {
    const contentRoot = getContentRoot();
    const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
    const heading = headingPath[headingPath.length - 1];

    const added = skeleton.addSectionsFromRootSplit([{ heading, level, body: content }]);
    await skeleton.persist();

    for (const entry of added) {
      if (!entry.isSubSkeleton) {
        const dir = path.dirname(entry.absolutePath);
        await mkdir(dir, { recursive: true });
        await writeFile(entry.absolutePath, content, "utf8");
      }
    }

    await gitCommitStructural(`create section "${heading}" in ${docPath}`, docPath);

    return jsonToolResult({ doc_path: docPath, heading_path: headingPath, created: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── delete_section ──────────────────────────────────────

const deleteSectionHandler: ToolHandler = async (args) => {
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;

  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Cannot delete the root section.");
  }

  // Contention guards
  const sessionBlock = checkDocSessionGuard(docPath);
  if (sessionBlock) return sessionBlock;
  const proposalBlock = await checkProposalGuard(docPath, [headingPath]);
  if (proposalBlock) return proposalBlock;
  const involvementBlock = await checkInvolvementGuard(docPath, [headingPath]);
  if (involvementBlock) return involvementBlock;

  try {
    const contentRoot = getContentRoot();
    const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
    const result = skeleton.replace(headingPath, []);
    await skeleton.persist();

    for (const removed of result.removed) {
      await rm(removed.absolutePath, { force: true });
      await rm(`${removed.absolutePath}.sections`, { recursive: true, force: true });
    }

    await gitCommitStructural(`delete section "${headingPath.join(" > ")}" from ${docPath}`, docPath);

    return jsonToolResult({ doc_path: docPath, heading_path: headingPath, deleted: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── move_section ────────────────────────────────────────

const moveSectionHandler: ToolHandler = async (args) => {
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const newParentPath = args.new_parent_path as string[] | undefined;

  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Cannot move the root section.");
  }
  if (!Array.isArray(newParentPath)) {
    return makeToolErrorResult("Missing required parameter: new_parent_path (string[])");
  }

  // Contention guards
  const sessionBlock = checkDocSessionGuard(docPath);
  if (sessionBlock) return sessionBlock;
  const proposalBlock = await checkProposalGuard(docPath, [headingPath]);
  if (proposalBlock) return proposalBlock;
  const involvementBlock = await checkInvolvementGuard(docPath, [headingPath]);
  if (involvementBlock) return involvementBlock;

  try {
    const contentRoot = getContentRoot();
    const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);

    // Read current body content
    const entry = skeleton.resolve(headingPath);
    let bodyContent = "";
    try {
      bodyContent = await readFile(entry.absolutePath, "utf8");
    } catch (err: unknown) {
      // Section file may not exist yet (new section with no body).
      // Only swallow ENOENT; re-throw anything unexpected.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const heading = headingPath[headingPath.length - 1];

    // Determine the target level based on new parent depth
    const targetLevel = newParentPath.length === 0
      ? entry.level  // Moving to root: keep original level
      : newParentPath.length + 1;  // Moving under parent: one deeper than parent

    // Remove from old position
    const removeResult = skeleton.replace(headingPath, []);

    // Insert under the specified parent path
    const addedEntries = skeleton.insertSectionUnder(newParentPath, {
      heading,
      level: targetLevel,
      body: bodyContent,
    });
    await skeleton.persist();

    // Clean up old files
    for (const removed of removeResult.removed) {
      await rm(removed.absolutePath, { force: true });
      await rm(`${removed.absolutePath}.sections`, { recursive: true, force: true });
    }

    // Write body for new entries
    for (const e of addedEntries) {
      if (!e.isSubSkeleton) {
        const dir = path.dirname(e.absolutePath);
        await mkdir(dir, { recursive: true });
        await writeFile(e.absolutePath, bodyContent, "utf8");
      }
    }

    await gitCommitStructural(`move section "${headingPath.join(" > ")}" in ${docPath}`, docPath);

    return jsonToolResult({ doc_path: docPath, heading_path: headingPath, new_parent_path: newParentPath, moved: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── rename_section ──────────────────────────────────────

const renameSectionHandler: ToolHandler = async (args) => {
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const newHeading = args.new_heading as string | undefined;

  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Cannot rename the root section.");
  }
  if (!newHeading) return makeToolErrorResult("Missing required parameter: new_heading");

  // Contention guards
  const sessionBlock = checkDocSessionGuard(docPath);
  if (sessionBlock) return sessionBlock;
  const proposalBlock = await checkProposalGuard(docPath, [headingPath]);
  if (proposalBlock) return proposalBlock;
  const involvementBlock = await checkInvolvementGuard(docPath, [headingPath]);
  if (involvementBlock) return involvementBlock;

  try {
    const contentRoot = getContentRoot();
    const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);

    // Read current body content
    const entry = skeleton.resolve(headingPath);
    let bodyContent = "";
    try {
      bodyContent = await readFile(entry.absolutePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    // Replace with new heading, same content
    const result = skeleton.replace(headingPath, [
      { heading: newHeading, level: entry.level, body: bodyContent },
    ]);
    await skeleton.persist();

    // Write new body file
    for (const added of result.added) {
      if (!added.isSubSkeleton) {
        const dir = path.dirname(added.absolutePath);
        await mkdir(dir, { recursive: true });
        await writeFile(added.absolutePath, bodyContent, "utf8");
      }
    }

    // Clean up old files
    for (const removed of result.removed) {
      await rm(removed.absolutePath, { force: true });
      await rm(`${removed.absolutePath}.sections`, { recursive: true, force: true });
    }

    await gitCommitStructural(`rename section "${headingPath.join(" > ")}" to "${newHeading}" in ${docPath}`, docPath);

    const newHeadingPath = [...headingPath.slice(0, -1), newHeading];
    return jsonToolResult({ doc_path: docPath, old_heading_path: headingPath, new_heading_path: newHeadingPath, renamed: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── delete_document ─────────────────────────────────────

const deleteDocumentHandler: ToolHandler = async (args) => {
  const docPath = args.path as string | undefined;
  if (!docPath) return makeToolErrorResult("Missing required parameter: path");

  // Contention guards
  const sessionBlock = checkDocSessionGuard(docPath);
  if (sessionBlock) return sessionBlock;

  // Load skeleton to get all section heading paths for proposal/human-involvement checks
  try {
    const contentRoot = getContentRoot();
    const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
    const headingPaths: string[][] = [];
    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath, _absolutePath, isSubSkeleton) => {
      if (!isSubSkeleton) headingPaths.push([...headingPath]);
    });

    const proposalBlock = await checkProposalGuard(docPath, headingPaths);
    if (proposalBlock) return proposalBlock;
    const involvementBlock = await checkInvolvementGuard(docPath, headingPaths);
    if (involvementBlock) return involvementBlock;
  } catch (error) {
    if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
      // Document doesn't exist or invalid path — let deleteDocument handle the error
    } else {
      throw error;
    }
  }

  return deleteDocument(docPath);
};

// ─── rename_document ─────────────────────────────────────

const renameDocumentHandler: ToolHandler = async (args) => {
  const docPath = args.doc_path as string | undefined;
  const newPath = args.new_path as string | undefined;
  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!newPath) return makeToolErrorResult("Missing required parameter: new_path");

  // Contention guard: doc-level session check
  const sessionBlock = checkDocSessionGuard(docPath);
  if (sessionBlock) return sessionBlock;

  // Contention guard: check proposals referencing this document
  const pending = await listProposals("pending");
  const conflicting = pending.filter((p) =>
    p.sections.some((s) => s.doc_path === docPath),
  );
  if (conflicting.length > 0) {
    return makeToolErrorResult(
      `Cannot rename document: pending proposals reference it: ${conflicting.map((p) => p.id).join(", ")}`,
    );
  }

  // Involvement guard: check all sections
  try {
    const contentRoot = getContentRoot();
    const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
    const headingPaths: string[][] = [];
    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath, _absolutePath, isSubSkeleton) => {
      if (!isSubSkeleton) headingPaths.push([...headingPath]);
    });
    const involvementBlock = await checkInvolvementGuard(docPath, headingPaths);
    if (involvementBlock) return involvementBlock;
  } catch {
    // Skeleton not found — let renameDocument handle the error
  }

  try {
    const result = await renameDocument(docPath, newPath);
    return jsonToolResult(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── Registration ────────────────────────────────────────

export function registerStructuralTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "create_section",
      description: "Create a new section within a document.",
      inputSchema: {
        type: "object",
        properties: {
          doc_path: { type: "string", description: "Document path" },
          heading_path: { type: "array", items: { type: "string" }, description: "Heading path for the new section" },
          content: { type: "string", description: "Initial content (markdown)" },
          after_heading_path: { type: "array", items: { type: "string" }, description: "Insert after this section" },
        },
        required: ["doc_path", "heading_path"],
      },
    },
    createSectionHandler,
  );

  registry.register(
    {
      name: "delete_section",
      description: "Delete a section from a document.",
      inputSchema: {
        type: "object",
        properties: {
          doc_path: { type: "string", description: "Document path" },
          heading_path: { type: "array", items: { type: "string" }, description: "Section heading path to delete" },
        },
        required: ["doc_path", "heading_path"],
      },
    },
    deleteSectionHandler,
  );

  registry.register(
    {
      name: "move_section",
      description: "Move a section to a new position in the document hierarchy.",
      inputSchema: {
        type: "object",
        properties: {
          doc_path: { type: "string", description: "Document path" },
          heading_path: { type: "array", items: { type: "string" }, description: "Current heading path" },
          new_parent_path: { type: "array", items: { type: "string" }, description: "New parent heading path" },
          after_sibling: { type: "array", items: { type: "string" }, description: "Insert after this sibling" },
        },
        required: ["doc_path", "heading_path"],
      },
    },
    moveSectionHandler,
  );

  registry.register(
    {
      name: "rename_section",
      description: "Rename a section heading.",
      inputSchema: {
        type: "object",
        properties: {
          doc_path: { type: "string", description: "Document path" },
          heading_path: { type: "array", items: { type: "string" }, description: "Current heading path" },
          new_heading: { type: "string", description: "New heading text" },
        },
        required: ["doc_path", "heading_path", "new_heading"],
      },
    },
    renameSectionHandler,
  );

  registry.register(
    {
      name: "delete_document",
      description: "Delete an entire document from the Knowledge Store.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Document path to delete" },
        },
        required: ["path"],
      },
    },
    deleteDocumentHandler,
  );

  registry.register(
    {
      name: "rename_document",
      description: "Rename a document (move to a new path).",
      inputSchema: {
        type: "object",
        properties: {
          doc_path: { type: "string", description: "Current document path" },
          new_path: { type: "string", description: "New document path" },
        },
        required: ["doc_path", "new_path"],
      },
    },
    renameDocumentHandler,
  );
}
