import express, { type NextFunction, type Request, type Response } from "express";
import type {
  AdminConfig,
  ChangesSinceResponse,
  CreateProposalRequest,
  CreateProposalResponse,
  CommitProposalResponse,
  WithdrawProposalResponse,
  UpdateProposalRequest,
  GetActivityResponse,
  GetAdminSnapshotHealthResponse,
  GetDocumentResponse,
  GetDocumentSectionsResponse,
  GetDocumentsTreeResponse,
  GetHeatmapResponse,
  HeatmapEntry,
  ListProposalsResponse,
  PublishRequest,
  PublishResponse,
  SessionInfoResponse,
  ReadDocStructureResponse,
  ReadProposalResponse,
  ReadSectionResponse,
  WriterDirtyState,
  WsServerEvent,
  SectionMeta,
  HumanHumanInvolvementPresetName,
  SectionScoreSnapshot,
} from "../../types/shared.js";
import { HUMAN_INVOLVEMENT_PRESETS } from "../../types/shared.js";
import path from "node:path";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { assertDataRootExists, getContentRoot, getDataRoot, getSessionDocsRoot, getSessionAuthorsRoot, getSessionFragmentsRoot } from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { buildSectionInvolvementMeta, broadcastAgentReading } from "../helpers/section-meta-builder.js";

import { getSessionState } from "../../storage/session-inspector.js";
import { getHeadSha, gitLogRecent, gitDiffForCommit } from "../../storage/git-repo.js";
import { readAssembledDocument, DocumentAssemblyError, DocumentNotFoundError, prependHeadings } from "../../storage/document-reader.js";
import { InvalidDocPathError, resolveDocPathUnderContent } from "../../storage/path-utils.js";
import { readActivity, readChangesSince } from "../../storage/activity-reader.js";
import {
  createProposal,
  readProposal,
  listProposals,
  findPendingProposalByWriter,
  updateProposalSections,
  transitionToWithdrawn,
  ProposalNotFoundError,
  InvalidProposalStateError,
} from "../../storage/proposal-repository.js";
import { readSection, readSectionWithHeading, SectionNotFoundError } from "../../storage/section-reader.js";
import { readDocumentStructure, readDocumentStructureWithOverlay, flattenStructureToHeadingPaths, HeadingNotFoundError, resolveAllSectionPaths } from "../../storage/heading-resolver.js";
import {
  evaluateProposalHumanInvolvement,
  commitProposalToCanonical,
} from "../../storage/commit-pipeline.js";
import {
  getSessionsForWriter,
  lookupDocSession,
} from "../../crdt/ydoc-lifecycle.js";
import { SectionGuard } from "../../domain/section-guard.js";
import { readDocSectionCommitInfo, type SectionCommitInfo } from "../../storage/section-activity.js";
import { SectionPresence } from "../../domain/section-presence.js";
import {
  readDocumentsTree,
  DocumentsTreePathNotFoundError,
  InvalidDocumentsTreePathError,
} from "../../storage/documents-tree.js";
import { resolveAuthenticatedWriter, type AuthenticatedWriter } from "../../auth/context.js";
import { parseImportDocument } from "../../storage/content-import.js";
import { listAuthMethods, loginHuman } from "../../auth/service.js";
import { readAgentKeys, addAgentKey, removeAgentKey } from "../../auth/agent-keys.js";
import { getSnapshotHealth, scheduleSnapshotRegeneration } from "../../storage/snapshot.js";
import {
  AdminConfigValidationError,
  getAdminConfig,
  updateAdminConfig,
} from "../../admin-config.js";
import { commitDirtySections } from "../../storage/auto-commit.js";
import { DocumentSkeleton, SECTIONS_DIR_SUFFIX } from "../../storage/document-skeleton.js";
import { generateSectionFilename } from "../../storage/markdown-sections.js";
import { gitExec } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";
import { renameDocument } from "../../storage/document-rename.js";


// ─── Helpers ────────────────────────────────────────────

function sendApiError(res: Response, status: number, message: string, details?: unknown): void {
  res.status(status).json({ message, ...(details !== undefined ? { details } : {}) });
}

function authCookieAttributes(req: Request): { secure: boolean } {
  const forwarded = String(req.headers.forwarded ?? "");
  const forwardedProtoMatch = /proto=([^;,\s]+)/i.exec(forwarded);
  const forwardedProto = (forwardedProtoMatch?.[1] ?? "").toLowerCase();
  const secure = req.secure || forwardedProto === "https";
  return { secure };
}

function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
): void {
  const { secure } = authCookieAttributes(req);
  const secureFlag = secure ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `ks_access_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=1800`,
  );
  res.append(
    "Set-Cookie",
    `ks_refresh_token=${encodeURIComponent(refreshToken)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=2592000`,
  );
}

function clearAuthCookies(req: Request, res: Response): void {
  const { secure } = authCookieAttributes(req);
  const secureFlag = secure ? "; Secure" : "";
  res.append("Set-Cookie", `ks_access_token=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`);
  res.append("Set-Cookie", `ks_refresh_token=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`);
}

function requireAuthenticatedWriter(req: Request, res: Response): AuthenticatedWriter | null {
  const writer = resolveAuthenticatedWriter(req);
  if (!writer) {
    sendApiError(res, 401, "Authentication required.");
    return null;
  }
  return writer;
}

const SECTION_LENGTH_WARNING_THRESHOLD = 2000; // words

function computeSectionLengthWarning(content: string): boolean {
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  return wordCount > SECTION_LENGTH_WARNING_THRESHOLD;
}

function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}

// ─── Router Options ─────────────────────────────────────

export interface CreateApiRouterOptions {
  onWsEvent?: (event: WsServerEvent) => void;
}

// ─── Router ─────────────────────────────────────────────

export function createApiRouter(options?: CreateApiRouterOptions): express.Router {
  const router = express.Router();
  const onWsEvent = options?.onWsEvent;

  // ─── Health ───────────────────────────────────────────

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // ─── Auth ─────────────────────────────────────────────

  router.get("/auth/methods", async (_req, res, next) => {
    try {
      const methods = await listAuthMethods();
      res.json({ methods });
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/session", (req, res) => {
    const writer = resolveAuthenticatedWriter(req);
    const response: SessionInfoResponse = writer
      ? {
          authenticated: true,
          user: {
            id: writer.id,
            type: writer.type,
            displayName: writer.displayName,
            email: writer.email,
          },
        }
      : { authenticated: false };
    res.json(response);
  });

  // POST /auth/agent/register removed — replaced by POST /oauth/register (OAuth 2.1 DCR)

  router.post("/auth/login", async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (!username || !password) {
        sendApiError(res, 400, "username and password are required.");
        return;
      }
      const result = loginHuman({ provider: "credentials", username, password });
      setAuthCookies(req, res, result.access_token, result.refresh_token);
      res.json({
        user: result.identity,
        access_token: result.access_token,
        refresh_token: result.refresh_token,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /auth/token/refresh removed — replaced by POST /oauth/token with grant_type=refresh_token

  router.post("/auth/logout", (req, res) => {
    clearAuthCookies(req, res);
    res.json({ success: true });
  });

  // ─── Documents ────────────────────────────────────────

  router.get("/documents/tree", async (req, res, next) => {
    try {
      const basePath = (req.query.path as string) ?? "";
      const tree = await readDocumentsTree(basePath);
      const response: GetDocumentsTreeResponse = { tree };
      res.json(response);
    } catch (error) {
      if (error instanceof DocumentsTreePathNotFoundError) {
        sendApiError(res, 404, error.message);
        return;
      }
      if (error instanceof InvalidDocumentsTreePathError) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  router.get("/documents/:docPath(*)/structure", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const sessionDocsContentRoot = path.join(getSessionDocsRoot(), "content");
      const structure = await readDocumentStructureWithOverlay(docPath, sessionDocsContentRoot);

      broadcastAgentReading(req, docPath, flattenStructureToHeadingPaths(structure), onWsEvent);

      const response: ReadDocStructureResponse = { doc_path: docPath, structure };
      res.json(response);
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error.message);
        return;
      }
      next(error);
    }
  });

  router.get("/documents/:docPath(*)/sections", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const sessionDocsContentRoot = path.join(getSessionDocsRoot(), "content");
      const skeleton = await DocumentSkeleton.fromDisk(docPath, sessionDocsContentRoot, getContentRoot());

      // Build headingPaths and sectionFileByKey in one forEachSection pass
      const headingPaths: string[][] = [];
      const sectionFileByKey = new Map<string, string>();
      skeleton.forEachSection((_heading, _level, sectionFile, headingPath) => {
        const hp = [...headingPath];
        headingPaths.push(hp);
        sectionFileByKey.set(SectionRef.headingKey(hp), sectionFile);
      });

      // ── Batch pre-fetch: all I/O happens here, loop below is pure compute ──
      const liveSession = lookupDocSession(docPath);
      const sectionsOverlayRoot = path.join(getSessionDocsRoot(), "content");
      const sectionsOverlay = new ContentLayer(sectionsOverlayRoot, new ContentLayer(getContentRoot()));
      const bulkContent = prependHeadings(skeleton, await sectionsOverlay.readAllSectionsOverlaid(docPath));

      // Overlay live content from Y.Doc where available
      if (liveSession) {
        for (const [key, live] of liveSession.fragments.readAllLiveContent()) {
          bulkContent.set(key, live);
        }
      }

      // 2. Involvement metadata via shared helper
      const involvementMeta = await buildSectionInvolvementMeta(docPath, headingPaths, bulkContent);

      // Build sections response
      const sections: GetDocumentSectionsResponse["sections"] = [];
      for (const headingPath of headingPaths) {
        const headingKey = SectionRef.headingKey(headingPath);
        const content = bulkContent.get(headingKey) ?? "";
        const meta = involvementMeta.get(headingKey);
        if (!meta) continue;

        sections.push({
          heading: headingPath[headingPath.length - 1] ?? "",
          heading_path: headingPath,
          depth: headingPath.length,
          content,
          humanInvolvement_score: meta.humanInvolvement_score,
          crdt_session_active: meta.crdt_session_active,
          section_length_warning: meta.section_length_warning,
          word_count: meta.word_count,
          section_file: sectionFileByKey.get(headingKey) ?? "",
        });
      }

      broadcastAgentReading(req, docPath, headingPaths, onWsEvent);

      const response: GetDocumentSectionsResponse = { doc_path: docPath, sections };
      res.json(response);
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error.message);
        return;
      }
      if (error instanceof DocumentAssemblyError) {
        sendApiError(res, 500, error.message);
        return;
      }
      next(error);
    }
  });

  router.get("/documents/:docPath(*)/changes-since", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const afterHead = req.query.after_head as string | undefined;
      const result = await readChangesSince(docPath, afterHead);
      res.json(result);
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  router.get("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const assembled = await readAssembledDocument(docPath);

      // Compute per-section metadata
      const structure = await readDocumentStructure(docPath).catch(() => []);
      const headingPaths = flattenStructureToHeadingPaths(structure);

      // Pre-fetch content and compute human-involvement metadata via shared helper
      const docOverlayRoot = path.join(getSessionDocsRoot(), "content");
      const docOverlay = new ContentLayer(docOverlayRoot, new ContentLayer(getContentRoot()));
      const bulkContent = await docOverlay.readAllSectionsOverlaid(docPath);
      const involvementMeta = await buildSectionInvolvementMeta(docPath, headingPaths, bulkContent);

      const sectionsMeta: SectionMeta[] = [];
      for (const headingPath of headingPaths) {
        const headingKey = SectionRef.headingKey(headingPath);
        const meta = involvementMeta.get(headingKey);
        if (!meta) continue;

        sectionsMeta.push({
          heading_path: headingPath,
          humanInvolvement_score: meta.humanInvolvement_score,
          crdt_session_active: meta.crdt_session_active,
          section_length_warning: meta.section_length_warning,
          word_count: meta.word_count,
        });
      }

      broadcastAgentReading(req, docPath, sectionsMeta.map((s) => s.heading_path), onWsEvent);

      const headSha = await getHeadSha(getDataRoot());
      const response: GetDocumentResponse = {
        doc_path: docPath,
        content: assembled,
        head_sha: headSha,
        sections_meta: sectionsMeta,
      };
      res.json(response);
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error.message);
        return;
      }
      if (error instanceof DocumentAssemblyError) {
        sendApiError(res, 500, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Create Document ────────────────────────────────────

  router.put("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const contentRoot = getContentRoot();
      const resolvedPath = resolveDocPathUnderContent(contentRoot, docPath);

      // Check if skeleton file already exists
      try {
        await access(resolvedPath);
        sendApiError(res, 409, "Document already exists.");
        return;
      } catch {
        // File does not exist — proceed
      }

      const skeleton = DocumentSkeleton.createEmpty(docPath, contentRoot);
      await skeleton.persist();

      // Write empty root section body file through ContentLayer
      const canonical = new ContentLayer(contentRoot);
      await canonical.writeSection(new SectionRef(docPath, []), "");

      // Git add + commit
      const dataRoot = getDataRoot();
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

      res.status(201).json({ doc_path: docPath });
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Patch Document (unified diff) ──────────────────────

  router.patch("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const docPath = req.params.docPath;
      const diffText = typeof req.body === "string" ? req.body : req.body?.diff;

      if (!diffText || typeof diffText !== "string") {
        sendApiError(res, 400, "Request body must be a unified diff (text/x-diff or text/plain, or JSON with 'diff' field).");
        return;
      }

      // Read current document content
      let currentContent: string;
      try {
        currentContent = await readAssembledDocument(docPath);
      } catch (error) {
        if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
          sendApiError(res, 404, `Document not found: ${docPath}`);
          return;
        }
        throw error;
      }

      // Parse and apply the diff
      const { applyUnifiedDiff, DiffParseError, DiffApplyError } = await import("../../storage/diff-parser.js");
      let patchedContent: string;
      try {
        patchedContent = applyUnifiedDiff(currentContent, diffText);
      } catch (error) {
        if (error instanceof DiffParseError || error instanceof DiffApplyError) {
          sendApiError(res, 400, error.message);
          return;
        }
        throw error;
      }

      // No-op detection: skip proposal if nothing changed
      if (patchedContent === currentContent) {
        res.status(200).json({ doc_path: docPath, no_changes: true });
        return;
      }

      // Submit the patched content as a proposal (root section overwrite)
      const intent = `Patch document: ${docPath}`;
      const existing = await findPendingProposalByWriter(writer.id);
      if (existing) {
        await transitionToWithdrawn(existing.id, "auto-withdrawn by PATCH");
      }

      const { proposal, contentRoot } = await createProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        intent,
        [{ doc_path: docPath, heading_path: [] }],
      );
      // Write content to proposal's content directory via ContentLayer
      const proposalContentLayer = new ContentLayer(contentRoot);
      await proposalContentLayer.writeSection(new SectionRef(docPath, []), patchedContent);

      const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal);

      if (evaluation.all_sections_accepted) {
        const scores: SectionScoreSnapshot = {};
        for (const s of sections) {
          scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
        }

        const committedHead = await commitProposalToCanonical(proposal, scores);

        if (onWsEvent) {
          onWsEvent({
            type: "content:committed",
            doc_path: docPath,
            sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
            commit_sha: committedHead,
            source: "agent_proposal",
            writer_id: writer.id,
            writer_display_name: writer.displayName,
          });
        }

        res.status(200).json({
          doc_path: docPath,
          committed_head: committedHead,
          status: "committed",
        });
      } else {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: proposal.id,
          status: "pending",
          outcome: "blocked",
          blocked_sections: sections.filter((s) => s.blocked),
        });
      }
    } catch (error) {
      next(error);
    }
  });

  // ─── Delete Document ────────────────────────────────────

  router.delete("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const docPath = req.params.docPath;
      const contentRoot = getContentRoot();
      const resolvedPath = resolveDocPathUnderContent(contentRoot, docPath);

      // Verify document exists
      try {
        await access(resolvedPath);
      } catch {
        sendApiError(res, 404, `Document not found: ${docPath}`);
        return;
      }

      // Check for active CRDT sessions
      const docSession = lookupDocSession(docPath);
      if (docSession) {
        sendApiError(res, 409, "Cannot delete document with active editing session.");
        return;
      }

      // Check for pending proposals that reference this document
      const pendingProposals = await listProposals("pending");
      const conflicting = pendingProposals.filter((p) =>
        p.sections.some((s) => s.doc_path === docPath),
      );
      if (conflicting.length > 0) {
        sendApiError(res, 409, `Cannot delete document referenced by pending proposals: ${conflicting.map((p) => p.id).join(", ")}`);
        return;
      }

      // Check for orphaned dirty session files (flushed but not yet committed)
      const sessionDocsContentRoot = path.join(getSessionDocsRoot(), "content");
      const sessionDocPath = resolveDocPathUnderContent(sessionDocsContentRoot, docPath);
      let hasDirtySessionFiles = false;
      try { await access(sessionDocPath); hasDirtySessionFiles = true; } catch { /* not found */ }
      if (!hasDirtySessionFiles) {
        try { await access(sessionDocPath + SECTIONS_DIR_SUFFIX); hasDirtySessionFiles = true; } catch { /* not found */ }
      }
      if (hasDirtySessionFiles) {
        sendApiError(res, 409, "Cannot delete document: uncommitted session files exist.");
        return;
      }

      // Delete the skeleton file and its .sections/ directory
      await rm(resolvedPath, { force: true });
      await rm(resolvedPath + SECTIONS_DIR_SUFFIX, { recursive: true, force: true });

      // Clean up any remaining session artifacts
      await rm(sessionDocPath, { force: true });
      await rm(sessionDocPath + SECTIONS_DIR_SUFFIX, { recursive: true, force: true });

      // Git add + commit the deletion
      const dataRoot = getDataRoot();
      await gitExec(["add", "content/"], dataRoot);
      await gitExec(
        [
          "-c", "user.name=Knowledge Store",
          "-c", "user.email=system@knowledge-store.local",
          "commit",
          "-m", `delete document: ${docPath}`,
          "--allow-empty",
        ],
        dataRoot,
      );

      res.status(200).json({ doc_path: docPath, deleted: true });
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Rename Document ─────────────────────────────────────

  router.post("/documents/:docPath(*)/rename", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const docPath = req.params.docPath;
      const { new_path: newPath } = req.body as { new_path?: string };
      if (!newPath || typeof newPath !== "string") {
        sendApiError(res, 400, "Missing required field: new_path");
        return;
      }

      // Check for active CRDT sessions
      const docSession = lookupDocSession(docPath);
      if (docSession && docSession.holders.size > 0) {
        sendApiError(res, 409, "Cannot rename document with active editing session.");
        return;
      }

      // Check for pending proposals referencing this document
      const pendingProposals = await listProposals("pending");
      const conflicting = pendingProposals.filter((p) =>
        p.sections.some((s) => s.doc_path === docPath),
      );
      if (conflicting.length > 0) {
        sendApiError(res, 409, `Cannot rename document referenced by pending proposals: ${conflicting.map((p) => p.id).join(", ")}`);
        return;
      }

      const result = await renameDocument(docPath, newPath);

      // Broadcast doc:renamed to all connected clients
      if (onWsEvent) {
        onWsEvent({
          type: "doc:renamed",
          old_path: result.old_path,
          new_path: result.new_path,
          committed_head: result.committed_head,
        });
      }

      res.status(200).json(result);
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Sections ─────────────────────────────────────────

  router.get("/sections", async (req, res, next) => {
    try {
      const docPath = req.query.doc_path as string;
      const headingPathRaw = req.query.heading_path as string;

      if (!docPath || !headingPathRaw) {
        sendApiError(res, 400, "doc_path and heading_path query params are required.");
        return;
      }

      const headingPath = headingPathRaw.split("/").map((s) => s.trim()).filter(Boolean);
      const content = await readSectionWithHeading(docPath, headingPath);

      broadcastAgentReading(req, docPath, [headingPath], onWsEvent);

      const headSha = await getHeadSha(getDataRoot());
      const response: ReadSectionResponse = {
        doc_path: docPath,
        heading_path: headingPath,
        content,
        head_sha: headSha,
      };
      res.json(response);
    } catch (error) {
      if (error instanceof SectionNotFoundError || error instanceof HeadingNotFoundError) {
        sendApiError(res, 404, error.message);
        return;
      }
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Section Mutations ──────────────────────────────────

  // Helper: parse heading path from URL param (colon-separated)
  function parseHeadingPathParam(raw: string): string[] {
    return raw.split(":").map((s) => decodeURIComponent(s.trim())).filter(Boolean);
  }

  // Helper: git commit a structural change
  async function gitCommitStructuralChange(message: string): Promise<void> {
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
  }

  // POST /api/documents/:docPath/sections — Create a new section
  router.post("/documents/:docPath(*)/sections", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const docPath = req.params.docPath;

      // Prevent structural changes during active CRDT editing
      const activeSession = lookupDocSession(docPath);
      if (activeSession) {
        sendApiError(res, 409, "Cannot modify document structure while an active editing session exists.");
        return;
      }

      const { heading, content } = req.body ?? {};

      if (!heading || typeof heading !== "string") {
        sendApiError(res, 400, "heading (string) is required.");
        return;
      }

      const contentRoot = getContentRoot();
      const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);

      // Determine the heading level from context
      // Default: level 2 (##) for top-level sections
      const level = req.body.level ?? 2;

      // Add as a new top-level sibling via addSectionsFromRootSplit
      const added = skeleton.addSectionsFromRootSplit([
        { heading, level, body: content ?? "" },
      ]);

      // Persist skeleton and write body files
      await skeleton.persist();

      const contentLayer = new ContentLayer(contentRoot);
      for (const entry of added) {
        if (!entry.isSubSkeleton) {
          await contentLayer.writeSection(new SectionRef(docPath, entry.headingPath), content ?? "");
        }
      }

      await gitCommitStructuralChange(`create section "${heading}" in ${docPath}`);

      // Broadcast structure change
      if (onWsEvent) {
        onWsEvent({
          type: "doc:structure-changed",
          doc_path: docPath,
        } as any);
      }

      res.status(201).json({
        doc_path: docPath,
        heading_path: [heading],
        created: true,
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error.message);
        return;
      }
      next(error);
    }
  });

  // DELETE /api/documents/:docPath/sections/:headingPath — Delete a section
  router.delete("/documents/:docPath(*)/sections/:headingPath", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const docPath = req.params.docPath;

      const activeSession = lookupDocSession(docPath);
      if (activeSession) {
        sendApiError(res, 409, "Cannot modify document structure while an active editing session exists.");
        return;
      }

      const headingPath = parseHeadingPathParam(req.params.headingPath);

      if (headingPath.length === 0) {
        sendApiError(res, 400, "Cannot delete the root section.");
        return;
      }

      const contentRoot = getContentRoot();
      const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);

      // Use replace with empty array to remove the section
      const result = skeleton.replace(headingPath, []);

      await skeleton.persist();

      // Delete the removed files from disk
      for (const removed of result.removed) {
        await rm(removed.absolutePath, { force: true });
        // Also try removing .sections/ subdir if it was a sub-skeleton
        await rm(removed.absolutePath + SECTIONS_DIR_SUFFIX, { recursive: true, force: true });
      }

      await gitCommitStructuralChange(`delete section "${headingPath.join(" > ")}" from ${docPath}`);

      if (onWsEvent) {
        onWsEvent({
          type: "doc:structure-changed",
          doc_path: docPath,
        } as any);
      }

      res.status(200).json({
        doc_path: docPath,
        heading_path: headingPath,
        deleted: true,
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error.message);
        return;
      }
      next(error);
    }
  });

  // PUT /api/documents/:docPath/sections/:headingPath/move — Move a section
  router.put("/documents/:docPath(*)/sections/:headingPath/move", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const docPath = req.params.docPath;

      const activeSession = lookupDocSession(docPath);
      if (activeSession) {
        sendApiError(res, 409, "Cannot modify document structure while an active editing session exists.");
        return;
      }

      const headingPath = parseHeadingPathParam(req.params.headingPath);

      if (headingPath.length === 0) {
        sendApiError(res, 400, "Cannot move the root section.");
        return;
      }

      const { new_parent_path } = req.body ?? {};

      if (!Array.isArray(new_parent_path)) {
        sendApiError(res, 400, "new_parent_path (string[]) is required.");
        return;
      }

      const contentRoot = getContentRoot();
      const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);

      // 1. Capture entire subtree (section + descendants) with body content
      const subtree = await skeleton.collectSubtree(headingPath);

      // 2. Remove from old position
      const removeResult = skeleton.replace(headingPath, []);

      // 3-4. Re-insert at new position, preserving subtree structure
      const topEntry = subtree[0];
      const children = subtree.slice(1);

      // Track heading paths + content for writing through ContentLayer after persist
      const writePlan: Array<{ headingPath: string[]; content: string }> = [];

      if (new_parent_path.length === 0) {
        skeleton.addSectionsFromRootSplit([
          { heading: topEntry.heading, level: topEntry.level, body: topEntry.bodyContent },
        ]);
      } else {
        skeleton.insertSectionUnder(new_parent_path, {
          heading: topEntry.heading, level: topEntry.level, body: topEntry.bodyContent,
        });
      }

      // Reconstruct the new parent path for the moved section
      const newTopPath = new_parent_path.length === 0
        ? [topEntry.heading]
        : [...new_parent_path, topEntry.heading];

      writePlan.push({ headingPath: newTopPath, content: topEntry.bodyContent });

      // Re-insert each descendant under its relative parent within the moved subtree
      for (const child of children) {
        // Compute relative path within the subtree: strip the old top heading path prefix
        const relPath = child.headingPath.slice(headingPath.length);
        // The parent for this child is the new top path + all but the last segment of relPath
        const childParentPath = [...newTopPath, ...relPath.slice(0, -1)];

        skeleton.insertSectionUnder(childParentPath, {
          heading: child.heading, level: child.level, body: child.bodyContent,
        });
        writePlan.push({ headingPath: [...childParentPath, child.heading], content: child.bodyContent });
      }

      // 5. Persist skeleton and write body files through ContentLayer
      await skeleton.persist();

      const moveCanonical = new ContentLayer(contentRoot);
      for (const { headingPath: hp, content } of writePlan) {
        await moveCanonical.writeSection(new SectionRef(docPath, hp), content);
      }

      // 6. Clean up old files
      for (const removed of removeResult.removed) {
        await rm(removed.absolutePath, { force: true });
        await rm(removed.absolutePath + SECTIONS_DIR_SUFFIX, { recursive: true, force: true });
      }

      await gitCommitStructuralChange(`move section "${headingPath.join(" > ")}" in ${docPath}`);

      if (onWsEvent) {
        onWsEvent({
          type: "doc:structure-changed",
          doc_path: docPath,
        } as any);
      }

      res.status(200).json({
        doc_path: docPath,
        heading_path: headingPath,
        new_parent_path,
        moved: true,
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error.message);
        return;
      }
      next(error);
    }
  });

  // PUT /api/documents/:docPath/sections/:headingPath/rename — Rename a section heading
  router.put("/documents/:docPath(*)/sections/:headingPath/rename", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const docPath = req.params.docPath;

      const activeSession = lookupDocSession(docPath);
      if (activeSession) {
        sendApiError(res, 409, "Cannot modify document structure while an active editing session exists.");
        return;
      }

      const headingPath = parseHeadingPathParam(req.params.headingPath);

      if (headingPath.length === 0) {
        sendApiError(res, 400, "Cannot rename the root section.");
        return;
      }

      const { new_heading } = req.body ?? {};
      if (!new_heading || typeof new_heading !== "string") {
        sendApiError(res, 400, "new_heading (string) is required.");
        return;
      }

      const contentRoot = getContentRoot();
      const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);

      // Read current body content through ContentLayer
      const renameCanonical = new ContentLayer(contentRoot);
      const entry = skeleton.resolve(headingPath);
      let bodyContent = "";
      try {
        bodyContent = await renameCanonical.readSection(new SectionRef(docPath, headingPath));
      } catch {
        // empty
      }

      // Replace with same content but new heading
      const replaceResult = skeleton.replace(headingPath, [
        { heading: new_heading, level: entry.level, body: bodyContent },
      ]);

      await skeleton.persist();

      // Write body content through ContentLayer (skeleton now has the renamed entry)
      const newHeadingPathForWrite = [...headingPath.slice(0, -1), new_heading];
      await renameCanonical.writeSection(new SectionRef(docPath, newHeadingPathForWrite), bodyContent);

      // Clean up old files
      for (const removed of replaceResult.removed) {
        if (removed.absolutePath !== replaceResult.added[0]?.absolutePath) {
          await rm(removed.absolutePath, { force: true });
          await rm(removed.absolutePath + SECTIONS_DIR_SUFFIX, { recursive: true, force: true });
        }
      }

      await gitCommitStructuralChange(`rename section "${headingPath.join(" > ")}" to "${new_heading}" in ${docPath}`);

      if (onWsEvent) {
        onWsEvent({
          type: "doc:structure-changed",
          doc_path: docPath,
        } as any);
      }

      const newHeadingPath = [...headingPath.slice(0, -1), new_heading];
      res.status(200).json({
        doc_path: docPath,
        old_heading_path: headingPath,
        new_heading_path: newHeadingPath,
        renamed: true,
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Heatmap ──────────────────────────────────────────

  router.get("/heatmap", async (req, res, next) => {
    try {
      const config = getAdminConfig();
      const sections: HeatmapEntry[] = [];

      // Enumerate all documents and their sections
      const humanProposalLockIndex = await SectionPresence.prefetchHumanProposalLocks();
      const tree = await readDocumentsTree("");
      for (const entry of flattenTree(tree)) {
        if (entry.type !== "file") continue;
        const docPath = entry.path;

        try {
          const structure = await readDocumentStructure(docPath);
          const headingPaths = flattenStructureToHeadingPaths(structure);

          // Batch pre-fetch per document
          const [dirtyFileSet, gitCommitInfo, canonicalPaths] = await Promise.all([
            SectionPresence.prefetchDirtyFiles(docPath),
            readDocSectionCommitInfo(docPath, headingPaths.length),
            resolveAllSectionPaths(getContentRoot(), docPath),
          ]);

          const commitByHeading = new Map<string, SectionCommitInfo>();
          for (const [headingKey, resolved] of canonicalPaths) {
            const relFromDataRoot = path.relative(getDataRoot(), resolved.absolutePath);
            const info = gitCommitInfo.get(relFromDataRoot);
            if (info) commitByHeading.set(headingKey, info);
          }

          for (const headingPath of headingPaths) {
            const headingKey = SectionRef.headingKey(headingPath);
            const verdict = SectionGuard.evaluateWithPrefetch(
              { doc_path: docPath, heading_path: headingPath },
              dirtyFileSet, commitByHeading, humanProposalLockIndex,
            );
            const commitInfo = commitByHeading.get(headingKey);

            sections.push({
              doc_path: docPath,
              heading_path: headingPath,
              humanInvolvement_score: verdict.humanInvolvement_score,
              crdt_session_active: !!verdict.crdt_session_active,
              last_human_commit_sha: commitInfo?.sha ?? null,
              last_commit_author: commitInfo?.authorName ?? null,
              last_commit_timestamp: commitInfo ? new Date(commitInfo.timestampMs).toISOString() : null,
            });
          }
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
      }

      const preset = HUMAN_INVOLVEMENT_PRESETS[config.humanInvolvement_preset];
      const response: GetHeatmapResponse = {
        preset: config.humanInvolvement_preset,
        humanInvolvement_midpoint_seconds: preset.midpoint_seconds,
        humanInvolvement_steepness: preset.steepness,
        sections,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // ─── Proposals ────────────────────────────────────────

  // POST /api/proposals — Submit proposal (v3: immediate evaluation)
  router.post("/proposals", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const body = req.body as CreateProposalRequest;

      if (!body.intent) {
        sendApiError(res, 400, "intent is required.");
        return;
      }

      // Human reservations can start with empty sections
      if (writer.type === "agent") {
        if (!Array.isArray(body.sections) || body.sections.length === 0) {
          sendApiError(res, 400, "sections[] is required for agent proposals.");
          return;
        }
        for (const section of body.sections) {
          if (!section.doc_path || !Array.isArray(section.heading_path) || typeof section.content !== "string") {
            sendApiError(res, 400, "Each section must have doc_path, heading_path, and content.");
            return;
          }
        }
      }

      // Check for existing pending proposal (single-pending-per-writer invariant)
      const existing = await findPendingProposalByWriter(writer.id);
      if (existing) {
        const replaceFlag = req.query.replace === "true";
        if (replaceFlag) {
          await transitionToWithdrawn(existing.id, "auto-withdrawn by replace flag");
        } else {
          res.status(409).json({
            error: "Writer already has a pending proposal.",
            existing_proposal_id: existing.id,
          });
          return;
        }
      }

      const sections = (body.sections ?? []).map((s) => ({
        doc_path: s.doc_path,
        heading_path: s.heading_path,
        justification: s.justification,
      }));

      // Capture content for writing to proposal content dir after creation
      const sectionContents = (body.sections ?? []).map((s) => ({
        doc_path: s.doc_path,
        heading_path: s.heading_path,
        content: s.content,
      }));

      // Human reservation contention checks
      if (writer.type === "human") {
        // Block overlapping human reservation sections
        const pendingProposals = await listProposals("pending");
        for (const pending of pendingProposals) {
          if (pending.writer.type !== "human") continue;
          for (const existingSection of pending.sections) {
            for (const requestedSection of sections) {
              if (
                existingSection.doc_path === requestedSection.doc_path &&
                SectionRef.headingPathsEqual(existingSection.heading_path, requestedSection.heading_path)
              ) {
                res.status(409).json({
                  error: `Section ${requestedSection.heading_path.join(" > ")} is already reserved by writer ${pending.writer.displayName} (proposal ${pending.id}).`,
                });
                return;
              }
            }
          }
        }

        // Block reservation on sections with active CRDT sessions
        for (const section of sections) {
          if (SectionPresence.checkLiveSessionOnly(new SectionRef(section.doc_path, section.heading_path))) {
            res.status(409).json({
              error: `Section ${section.heading_path.join(" > ")} has an active editing session.`,
            });
            return;
          }
        }
      }

      // Create proposal
      const { proposal, contentRoot: propContentRoot } = await createProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        body.intent,
        sections,
      );

      // Write section content to proposal's content directory
      if (sectionContents.length > 0) {
        const pContentLayer = new ContentLayer(propContentRoot);
        for (const sc of sectionContents) {
          await pContentLayer.writeSection(new SectionRef(sc.doc_path, sc.heading_path), sc.content);
        }
      }

      // Human reservations skip human-involvement evaluation — go straight to pending
      if (writer.type === "human") {
        const response: CreateProposalResponse = {
          proposal_id: proposal.id,
          status: "pending",
          outcome: "accepted",
          evaluation: {
            all_sections_accepted: true,
            aggregate_impact: 0,
            aggregate_threshold: 0,
            blocked_sections: [],
            passed_sections: [],
          },
          sections: [],
        };
        // Broadcast proposal:created for human reservations
        if (onWsEvent && sections.length > 0) {
          onWsEvent({
            type: "proposal:pending",
            proposal_id: proposal.id,
            doc_path: sections[0].doc_path,
            heading_paths: sections.map((s) => s.heading_path),
            writer_id: writer.id,
            writer_display_name: writer.displayName,
            intent: body.intent,
          });
        }

        res.status(201).json(response);
        return;
      }

      // Agent proposals: evaluate human involvement (informational — must commit explicitly)
      const { evaluation, sections: evalSections } = await evaluateProposalHumanInvolvement(proposal);

      if (onWsEvent && evalSections.length > 0) {
        onWsEvent({
          type: "proposal:pending",
          proposal_id: proposal.id,
          doc_path: evalSections[0].doc_path,
          heading_paths: evalSections.map((s) => s.heading_path),
          writer_id: writer.id,
          writer_display_name: writer.displayName,
          intent: body.intent,
        });
      }

      const response: CreateProposalResponse = {
        proposal_id: proposal.id,
        status: "pending",
        outcome: evaluation.all_sections_accepted ? "accepted" : "blocked",
        evaluation,
        sections: evalSections,
      };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/proposals — List proposals
  router.get("/proposals", async (req, res, next) => {
    try {
      const statusFilter = req.query.status as string | undefined;
      const validStatuses = ["pending", "committing", "committed", "withdrawn"];

      if (statusFilter && !validStatuses.includes(statusFilter)) {
        sendApiError(res, 400, `Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
        return;
      }

      const proposals = await listProposals(statusFilter as any);
      const response: ListProposalsResponse = { proposals };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/my-proposals — List proposals for the authenticated writer only
  router.get("/my-proposals", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const statusFilter = req.query.status as string | undefined;
      const validStatuses = ["pending", "committing", "committed", "withdrawn"];

      if (statusFilter && !validStatuses.includes(statusFilter)) {
        sendApiError(res, 400, `Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
        return;
      }

      const allProposals = await listProposals(statusFilter as any);
      const myProposals = allProposals.filter((p) => p.writer.id === writer.id);
      const response: ListProposalsResponse = { proposals: myProposals };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/proposals/:id — Read proposal (with live involvement re-evaluation)
  router.get("/proposals/:id", async (req, res, next) => {
    try {
      const proposal = await readProposal(req.params.id);

      // Re-evaluate human-involvement for pending proposals
      let involvementEvaluation = proposal.humanInvolvement_evaluation;
      if (proposal.status === "pending") {
        const { evaluation } = await evaluateProposalHumanInvolvement(proposal);
        involvementEvaluation = evaluation;
      }

      const response: ReadProposalResponse = {
        proposal: { ...proposal, humanInvolvement_evaluation: involvementEvaluation },
      };
      res.json(response);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error.message);
        return;
      }
      next(error);
    }
  });

  // PUT /api/proposals/:id — Modify blocked proposal sections
  router.put("/proposals/:id", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const proposal = await readProposal(req.params.id);
      if (proposal.writer.id !== writer.id) {
        sendApiError(res, 403, "You can only modify your own proposals.");
        return;
      }
      if (proposal.status !== "pending") {
        sendApiError(res, 409, `Cannot modify proposal in ${proposal.status} state.`);
        return;
      }

      const body = req.body as UpdateProposalRequest;
      if (!Array.isArray(body.sections) || body.sections.length === 0) {
        sendApiError(res, 400, "sections[] is required.");
        return;
      }

      // Human reservation: check newly-added sections for contention
      if (proposal.writer.type === "human") {
        const existingSectionKeys = new Set(
          proposal.sections.map((s) => new SectionRef(s.doc_path, s.heading_path).globalKey),
        );
        const newSections = body.sections.filter(
          (s) => !existingSectionKeys.has(new SectionRef(s.doc_path, s.heading_path).globalKey),
        );

        if (newSections.length > 0) {
          // Check overlapping human_reservations
          const pendingProposals = await listProposals("pending");
          for (const pending of pendingProposals) {
            if (pending.writer.type !== "human" || pending.id === proposal.id) continue;
            for (const existingSection of pending.sections) {
              for (const newSection of newSections) {
                if (
                  existingSection.doc_path === newSection.doc_path &&
                  SectionRef.headingPathsEqual(existingSection.heading_path, newSection.heading_path)
                ) {
                  res.status(409).json({
                    error: `Section ${newSection.heading_path.join(" > ")} is already reserved by writer ${pending.writer.displayName} (proposal ${pending.id}).`,
                  });
                  return;
                }
              }
            }
          }

          // Check active CRDT sessions on new sections
          for (const section of newSections) {
            if (SectionPresence.checkLiveSessionOnly(new SectionRef(section.doc_path, section.heading_path))) {
              res.status(409).json({
                error: `Section ${section.heading_path.join(" > ")} has an active editing session.`,
              });
              return;
            }
          }
        }
      }

      const { proposal: updated, contentRoot: updContentRoot } = await updateProposalSections(
        proposal.id,
        body.sections.map((s) => ({
          doc_path: s.doc_path,
          heading_path: s.heading_path,
          justification: s.justification,
        })),
        body.intent,
      );

      // Write updated section content to proposal's content directory
      {
        const pContentLayer = new ContentLayer(updContentRoot);
        for (const s of body.sections) {
          await pContentLayer.writeSection(new SectionRef(s.doc_path, s.heading_path), s.content);
        }
      }

      // Broadcast proposal:pending with updated sections
      if (onWsEvent && updated.sections.length > 0) {
        onWsEvent({
          type: "proposal:pending",
          proposal_id: updated.id,
          doc_path: updated.sections[0].doc_path,
          heading_paths: updated.sections.map((s: { heading_path: string[] }) => s.heading_path),
          writer_id: writer.id,
          writer_display_name: writer.displayName,
          intent: updated.intent,
        });
      }

      // Human reservations skip involvement re-evaluation
      if (proposal.writer.type === "human") {
        res.json({
          proposal: updated,
          sections: [],
        });
        return;
      }

      // Re-evaluate human-involvement for agent proposals
      const { evaluation, sections } = await evaluateProposalHumanInvolvement(updated);

      res.json({
        proposal: { ...updated, humanInvolvement_evaluation: evaluation },
        sections,
      });
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error.message);
        return;
      }
      if (error instanceof InvalidProposalStateError) {
        sendApiError(res, 409, error.message);
        return;
      }
      next(error);
    }
  });

  // POST /api/proposals/:id/commit — Commit a pending proposal
  router.post("/proposals/:id/commit", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const proposal = await readProposal(req.params.id);
      if (proposal.writer.id !== writer.id) {
        sendApiError(res, 403, "You can only commit your own proposals.");
        return;
      }
      if (proposal.status !== "pending") {
        sendApiError(res, 409, `Cannot commit proposal in ${proposal.status} state.`);
        return;
      }

      // Human reservations always commit (no human-involvement evaluation)
      if (proposal.writer.type === "human") {
        const scores: SectionScoreSnapshot = {};
        for (const s of proposal.sections) {
          scores[SectionRef.fromTarget(s).globalKey] = 0;
        }

        const committedHead = await commitProposalToCanonical(proposal, scores);

        const source = "human_publish" as const;
        if (onWsEvent) {
          onWsEvent({
            type: "content:committed",
            doc_path: proposal.sections[0]?.doc_path ?? "",
            sections: proposal.sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
            commit_sha: committedHead,
            source,
            writer_id: writer.id,
            writer_display_name: writer.displayName,
          });
        }

        const response: CommitProposalResponse = {
          proposal_id: proposal.id,
          status: "committed",
          outcome: "accepted",
          committed_head: committedHead,
          evaluation: {
            all_sections_accepted: true,
            aggregate_impact: 0,
            aggregate_threshold: 0,
            blocked_sections: [],
            passed_sections: [],
          },
          sections: [],
        };
        res.json(response);
        return;
      }

      // Agent proposals: evaluate human-involvement
      const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal);

      if (evaluation.all_sections_accepted) {
        const scores: SectionScoreSnapshot = {};
        for (const s of sections) {
          scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
        }

        const committedHead = await commitProposalToCanonical(proposal, scores);

        if (onWsEvent) {
          onWsEvent({
            type: "content:committed",
            doc_path: sections[0]?.doc_path ?? "",
            sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
            commit_sha: committedHead,
            source: "agent_proposal",
            writer_id: writer.id,
            writer_display_name: writer.displayName,
          });
        }

        const response: CommitProposalResponse = {
          proposal_id: proposal.id,
          status: "committed",
          outcome: "accepted",
          committed_head: committedHead,
          evaluation,
          sections,
        };
        res.json(response);
      } else {
        const response: CommitProposalResponse = {
          proposal_id: proposal.id,
          status: "pending",
          outcome: "blocked",
          evaluation,
          sections,
        };
        res.json(response);
      }
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error.message);
        return;
      }
      if (error instanceof InvalidProposalStateError) {
        sendApiError(res, 409, error.message);
        return;
      }
      next(error);
    }
  });

  // POST /api/proposals/:id/cancel — Withdraw a proposal
  router.post("/proposals/:id/cancel", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const proposal = await readProposal(req.params.id);
      if (proposal.writer.id !== writer.id) {
        sendApiError(res, 403, "You can only withdraw your own proposals.");
        return;
      }

      const reason = req.body?.reason as string | undefined;
      const withdrawn = await transitionToWithdrawn(proposal.id, reason);

      // Broadcast proposal:withdrawn
      if (onWsEvent && proposal.sections.length > 0) {
        onWsEvent({
          type: "proposal:withdrawn",
          proposal_id: proposal.id,
          doc_path: proposal.sections[0].doc_path,
          heading_paths: proposal.sections.map((s: { heading_path: string[] }) => s.heading_path),
        });
      }

      const response: WithdrawProposalResponse = {
        proposal_id: withdrawn.id,
        status: "withdrawn",
      };
      res.json(response);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error.message);
        return;
      }
      if (error instanceof InvalidProposalStateError) {
        sendApiError(res, 409, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Dirty State / Mirror ─────────────────────────────

  // GET /api/writers/:id/dirty — Writer dirty state
  router.get("/writers/:id/dirty", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const writerId = req.params.id;
      const writerSessions = getSessionsForWriter(writerId);
      const docMap = new Map<string, Array<{ heading_path: string[]; base_head: string; change_magnitude: number }>>();

      for (const session of writerSessions) {
        const dirtyFragments = session.perUserDirty.get(writerId);
        if (!dirtyFragments || dirtyFragments.size === 0) continue;

        if (!docMap.has(session.docPath)) {
          docMap.set(session.docPath, []);
        }

        for (const fragmentKey of dirtyFragments) {
          // Fragment keys are file-ID-based (e.g. "section::sec_abc123def").
          // Use the skeleton to resolve back to the canonical heading path.
          const prefix = "section::";
          let headingPath: string[] = [];
          if (fragmentKey.startsWith(prefix)) {
            const fileId = fragmentKey.slice(prefix.length);
            if (fileId === "__root__") {
              headingPath = [];
            } else {
              try {
                const entry = session.fragments.skeleton.resolveByFileId(fileId);
                headingPath = entry.headingPath;
              } catch {
                // Fragment references a section no longer in skeleton (e.g. deleted)
                // — skip this dirty entry
                continue;
              }
            }
          }
          docMap.get(session.docPath)!.push({
            heading_path: headingPath,
            base_head: session.baseHead,
            change_magnitude: 0,
          });
        }
      }

      // Fall back to disk if no in-memory sessions found for this writer.
      // sessions/authors/{writerId}.json persists dirty state across restarts.
      if (writerSessions.length === 0) {
        const authorFile = path.join(getSessionAuthorsRoot(), `${writerId}.json`);
        try {
          const raw = await readFile(authorFile, "utf8");
          const data = JSON.parse(raw) as { writerId: string; dirtySections: Array<{ docPath: string; headingPath: string[] }> };
          for (const entry of data.dirtySections) {
            if (!docMap.has(entry.docPath)) {
              docMap.set(entry.docPath, []);
            }
            docMap.get(entry.docPath)!.push({
              heading_path: entry.headingPath,
              base_head: "",
              change_magnitude: 0,
            });
          }
        } catch {
          // No author file on disk — writer has no dirty state
        }
      }

      const response: WriterDirtyState = {
        writer_id: writerId,
        documents: [...docMap.entries()].map(([doc_path, dirty_sections]) => ({
          doc_path,
          dirty_sections,
        })),
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/publish — Manual publish
  router.post("/publish", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      if (writer.type !== "human") {
        sendApiError(res, 403, "Only humans can publish.");
        return;
      }

      const body = req.body as PublishRequest;
      const result = await commitDirtySections(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        body?.doc_path,
        body?.heading_paths,
      );

      if (!result.committed) {
        sendApiError(res, 404, "No dirty sections to publish.");
        return;
      }

      const response: PublishResponse = {
        committed_head: result.commitSha!,
        sections_published: result.sectionsPublished,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // ─── Activity ─────────────────────────────────────────

  router.get("/activity", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 500);
      const days = Math.max(Number(req.query.days ?? 30), 1);
      const items = await readActivity(limit, days);
      const response: GetActivityResponse = { items };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // ─── Admin ────────────────────────────────────────────

  router.get("/admin/config", (_req, res) => {
    const config = getAdminConfig();
    const preset = HUMAN_INVOLVEMENT_PRESETS[config.humanInvolvement_preset];
    res.json({
      ...config,
      preset_description: preset.description,
    });
  });

  router.put("/admin/config", (req, res, next) => {
    try {
      const body = req.body;
      const updated = updateAdminConfig(body);
      const preset = HUMAN_INVOLVEMENT_PRESETS[updated.humanInvolvement_preset];
      res.json({
        ...updated,
        preset_description: preset.description,
      });
    } catch (error) {
      if (error instanceof AdminConfigValidationError) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Import ─────────────────────────────────────────────

  router.post("/import", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      if (writer.type !== "human") {
        sendApiError(res, 403, "Only human writers can import files.");
        return;
      }

      const { target_folder, files } = req.body ?? {};

      if (typeof target_folder !== "string") {
        sendApiError(res, 400, "target_folder (string) is required.");
        return;
      }
      if (!Array.isArray(files) || files.length === 0) {
        sendApiError(res, 400, "files (non-empty array) is required.");
        return;
      }
      for (const f of files) {
        if (typeof f.name !== "string" || !f.name.endsWith(".md")) {
          sendApiError(res, 400, `Each file name must end in .md. Got: ${f.name}`);
          return;
        }
        if (typeof f.content !== "string") {
          sendApiError(res, 400, `Each file must have a content string.`);
          return;
        }
      }

      const contentRoot = getContentRoot();
      const dataRoot = getDataRoot();
      const createdDocuments: string[] = [];
      const allSections: Array<{ doc_path: string; heading_path: string[] }> = [];
      const sectionContents: Array<{ doc_path: string; heading_path: string[]; content: string }> = [];

      for (const file of files) {
        const folder = target_folder.replace(/^\/+|\/+$/g, "");
        const docPath = folder ? `${folder}/${file.name}` : file.name;

        // Validate path
        resolveDocPathUnderContent(contentRoot, docPath);

        // Parse markdown into sections
        const parsed = parseImportDocument(docPath, file.content);

        // Check if document exists
        let docExists = false;
        try {
          await access(resolveDocPathUnderContent(contentRoot, docPath));
          docExists = true;
        } catch {
          // Does not exist
        }

        if (!docExists) {
          // Create the document (skeleton + empty root section)
          const skeleton = DocumentSkeleton.createEmpty(docPath, contentRoot);
          await skeleton.persist();

          // Write empty root section body file through ContentLayer
          const importCanonical = new ContentLayer(contentRoot);
          await importCanonical.writeSection(new SectionRef(docPath, []), "");

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

        // Collect sections — root section gets the preamble (body before first heading)
        // and each parsed section becomes a proposal section
        const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);

        // Root section: content before first heading
        const rootBody = parsed.sections.length === 0 ? file.content : "";
        if (rootBody || parsed.sections.length === 0) {
          allSections.push({ doc_path: docPath, heading_path: [] });
          sectionContents.push({ doc_path: docPath, heading_path: [], content: rootBody });
        }

        for (const section of parsed.sections) {
          // Build heading path from depth info
          const headingPath = [section.heading];
          allSections.push({ doc_path: docPath, heading_path: headingPath });
          sectionContents.push({ doc_path: docPath, heading_path: headingPath, content: section.body });

          // Ensure the section exists in the skeleton
          try {
            skeleton.resolve(headingPath);
          } catch {
            // Section doesn't exist — create it
            skeleton.addSectionsFromRootSplit([{
              heading: section.heading,
              level: section.depth,
              body: "",
            }]);
          }
        }

        if (skeleton.dirty) {
          await skeleton.persist();

          // Write empty body files for new sections
          const emptyFilePromises: Promise<void>[] = [];
          skeleton.forEachSection((_heading, _level, _sectionFile, _headingPath, absolutePath, isSubSkeleton) => {
            if (isSubSkeleton) return;
            emptyFilePromises.push((async () => {
              const dir = path.dirname(absolutePath);
              await mkdir(dir, { recursive: true });
              try {
                await access(absolutePath);
              } catch {
                await writeFile(absolutePath, "", "utf8");
              }
            })());
          });
          await Promise.all(emptyFilePromises);

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

      // Create human proposal
      const { proposal, contentRoot: propContentRoot } = await createProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        `Import ${files.length} file${files.length > 1 ? "s" : ""} to ${target_folder || "/"}`,
        allSections.map(s => ({
          doc_path: s.doc_path,
          heading_path: s.heading_path,
        })),
      );

      // Write content to proposal
      const propLayer = new ContentLayer(propContentRoot);
      for (const sc of sectionContents) {
        await propLayer.writeSection(new SectionRef(sc.doc_path, sc.heading_path), sc.content);
      }

      // Evaluate and attempt commit
      const { evaluation, sections: evalSections } = await evaluateProposalHumanInvolvement(proposal);

      if (evaluation.all_sections_accepted) {
        const scores: SectionScoreSnapshot = {};
        for (const s of evalSections) {
          scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
        }

        const committedHead = await commitProposalToCanonical(proposal, scores);

        if (onWsEvent) {
          onWsEvent({
            type: "content:committed",
            doc_path: evalSections[0]?.doc_path ?? "",
            sections: evalSections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
            commit_sha: committedHead,
            source: "agent_proposal",
            writer_id: writer.id,
            writer_display_name: writer.displayName,
          });
        }

        res.status(201).json({
          proposal_id: proposal.id,
          status: "committed",
          outcome: "accepted",
          committed_head: committedHead,
          evaluation,
          sections: evalSections,
          created_documents: createdDocuments,
        });
      } else {
        if (onWsEvent && evalSections.length > 0) {
          onWsEvent({
            type: "proposal:pending",
            proposal_id: proposal.id,
            doc_path: evalSections[0].doc_path,
            heading_paths: evalSections.map((s) => s.heading_path),
            writer_id: writer.id,
            writer_display_name: writer.displayName,
            intent: proposal.intent,
          });
        }

        res.status(201).json({
          proposal_id: proposal.id,
          status: "pending",
          outcome: "blocked",
          evaluation,
          sections: evalSections,
          created_documents: createdDocuments,
        });
      }
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Export ────────────────────────────────────────────

  router.get("/export", async (req, res, next) => {
    try {
      const browsePath = typeof req.query.path === "string" ? req.query.path : "/";
      const tree = await readDocumentsTree(browsePath, true);

      // Flatten tree to collect all file paths
      const filePaths: string[] = [];
      const walk = (nodes: import("../../types/shared.js").DocumentTreeEntry[]) => {
        for (const node of nodes) {
          if (node.type === "file") {
            filePaths.push(node.path);
          } else if (node.children) {
            walk(node.children);
          }
        }
      };
      walk(tree);

      const { ZipFile } = await import("yazl");
      const zipFile = new ZipFile();

      const exportErrors: string[] = [];
      for (const docPath of filePaths) {
        try {
          const assembled = await readAssembledDocument(docPath);
          // Strip leading "/" for clean zip paths
          const zipPath = docPath.replace(/^\/+/, "");
          zipFile.addBuffer(Buffer.from(assembled, "utf8"), zipPath);
        } catch (assemblyError) {
          const msg = assemblyError instanceof Error
            ? assemblyError.stack ?? assemblyError.message
            : String(assemblyError);
          exportErrors.push(`${docPath}: ${msg}`);
        }
      }

      if (exportErrors.length > 0) {
        zipFile.addBuffer(
          Buffer.from(exportErrors.join("\n\n"), "utf8"),
          "export-errors.txt",
        );
      }

      zipFile.end();

      const folderName = browsePath === "/" ? "all" : browsePath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\//g, "-") || "all";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `export-${folderName}-${timestamp}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      zipFile.outputStream.pipe(res);
    } catch (error) {
      if (error instanceof DocumentsTreePathNotFoundError) {
        res.status(404).json({ message: `Path not found: ${req.query.path}` });
        return;
      }
      next(error);
    }
  });

  // ─── Admin ─────────────────────────────────────────────

  router.get("/admin/snapshot-health", async (_req, res, next) => {
    try {
      const health = await getSnapshotHealth();
      const response: GetAdminSnapshotHealthResponse = health;
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // ─── Git history ──────────────────────────────────────

  router.get("/git/log", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const docPath = (req.query.doc_path as string) || undefined;
      const dataRoot = getDataRoot();
      const entries = await gitLogRecent(dataRoot, { limit, offset, docPath });
      res.json(entries);
    } catch (error) {
      next(error);
    }
  });

  router.get("/git/log/:sha/diff", async (req, res, next) => {
    try {
      const { sha } = req.params;
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
        sendApiError(res, 400, "Invalid SHA format");
        return;
      }
      const dataRoot = getDataRoot();
      const result = await gitDiffForCommit(dataRoot, sha);
      res.json({ sha, ...result });
    } catch (error) {
      next(error);
    }
  });

  // ─── Session state inspector ──────────────────────────

  router.get("/admin/session-state", async (_req, res, next) => {
    try {
      res.json(await getSessionState());
    } catch (error) {
      next(error);
    }
  });

  // ─── Setup / connection info (public) ────────────────

  router.get("/setup", (req, res) => {
    let defaultServerName: string;
    try {
      const host = req.hostname;
      const isLocalhost = host === "localhost" || host === "127.0.0.1";
      if (isLocalhost) {
        defaultServerName = "civigent-local";
      } else {
        const hostEnd = host.slice(-10);
        defaultServerName = `civigent-${hostEnd.replace(/[^a-zA-Z0-9-]/g, "-")}`;
      }
    } catch {
      defaultServerName = "civigent-local";
    }

    res.json({
      defaultServerName,
    });
  });

  // ─── Pre-authenticated agent management ────────────────

  router.get("/admin/agents", async (_req, res, next) => {
    try {
      const entries = await readAgentKeys();
      res.json(entries.map((e) => ({ agent_id: e.agentId, display_name: e.displayName })));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/agents", async (req, res, next) => {
    try {
      const { display_name, agent_id } = req.body ?? {};
      if (!display_name || typeof display_name !== "string") {
        sendApiError(res, 400, "display_name is required.");
        return;
      }
      const id = (typeof agent_id === "string" && agent_id.trim())
        ? agent_id.trim()
        : `agent-${crypto.randomUUID()}`;
      const plainSecret = await addAgentKey(id, display_name.trim());
      res.status(201).json({
        agent_id: id,
        display_name: display_name.trim(),
        secret: plainSecret,
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/agents/:agentId", async (req, res, next) => {
    try {
      const removed = await removeAgentKey(req.params.agentId);
      if (!removed) {
        sendApiError(res, 404, "Agent not found.");
        return;
      }
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // ─── Error handler ────────────────────────────────────

  router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    sendApiError(res, 500, error.stack || error.message);
  });

  return router;
}


// ─── Structure Helpers ──────────────────────────────────

function flattenTree(
  entries: Array<{ name: string; path: string; type: "file" | "directory"; children?: any[] }>,
): Array<{ name: string; path: string; type: "file" | "directory" }> {
  const result: Array<{ name: string; path: string; type: "file" | "directory" }> = [];
  for (const entry of entries) {
    result.push({ name: entry.name, path: entry.path, type: entry.type });
    if (entry.children?.length) {
      result.push(...flattenTree(entry.children));
    }
  }
  return result;
}