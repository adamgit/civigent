import { type Router } from "express";
import type {
  GetDocumentResponse,
  GetDocumentsTreeResponse,
  ReadDocStructureResponse,
  WsServerEvent,
} from "../../types/shared.js";
import {
  sendApiError,
  requireAdmin,
  resolveAuthenticatedWriter,
  requireDocReadPermission,
  requireDocWritePermission,
  agentWritePolicyRouteBody,
} from "./middleware.js";
import {
  readTree,
  readStructure,
  getChangesSince,
  getHistory,
  getHistoryPreview,
  getDiagnostics,
  getBlame,
  readDocument,
  restoreDocument,
  RestoreValidationError,
  overwriteDocument,
  renameDocument,
  createDocument,
  patchDocument,
  deleteDocument,
  broadcastAgentReading,
  isValidSha,
  DocumentNotFoundError,
  DocumentAssemblyError,
  InvalidDocPathError,
  DocumentsTreePathNotFoundError,
  InvalidDocumentsTreePathError,
  DocumentDoesNotExistError,
  DocSessionHandoffFailedError,
  ActiveSessionConflictError,
  DocumentAlreadyExistsError,
  DocumentPendingDeletionError,
  DocumentNotFoundForDeleteError,
  UncommittedSessionFilesError,
} from "../application/documents.js";
import {
  emitCatalogMutationEvents,
  emitContentCommittedForSections,
} from "../application/events.js";
import {
  QueryParamError,
  optionalStringParam,
  boundedIntParam,
} from "../helpers/query-params.js";

export function registerDocumentRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // GET /documents/tree
  router.get("/documents/tree", async (req, res, next) => {
    try {
      const writer = resolveAuthenticatedWriter(req);
      const basePath = optionalStringParam(req.query.path, "path") ?? "";
      const response: GetDocumentsTreeResponse = await readTree(basePath, writer !== null);
      res.json(response);
    } catch (error) {
      if (error instanceof QueryParamError) {
        sendApiError(res, 400, error);
        return;
      }
      if (error instanceof DocumentsTreePathNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      if (error instanceof InvalidDocumentsTreePathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // GET /documents/:docPath/structure
  router.get("/documents/:docPath(*)/structure", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const { response, headingPaths } = await readStructure(docPath);
      broadcastAgentReading(req, docPath, headingPaths, onWsEvent);
      const out: ReadDocStructureResponse = response;
      res.json(out);
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // GET /documents/:docPath/changes-since
  router.get("/documents/:docPath(*)/changes-since", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const afterHead = optionalStringParam(req.query.after_head, "after_head");
      res.json(await getChangesSince(docPath, afterHead));
    } catch (error) {
      if (error instanceof QueryParamError || error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // GET /documents/:docPath/history
  router.get("/documents/:docPath(*)/history", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const limit = boundedIntParam(req.query.limit, "limit", { fallback: 30, min: 1, max: 100 });
      const offset = boundedIntParam(req.query.offset, "offset", { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
      res.json(await getHistory(docPath, limit, offset));
    } catch (error) {
      if (error instanceof QueryParamError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // GET /documents/:docPath/history/:sha/preview
  router.get("/documents/:docPath(*)/history/:sha/preview", async (req, res, next) => {
    try {
      const { docPath, sha } = req.params;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      if (!isValidSha(sha)) {
        sendApiError(res, 400, new Error(`Invalid SHA format: "${sha}"`));
        return;
      }
      res.json(await getHistoryPreview(docPath, sha));
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // POST /documents/:docPath/restore
  router.post("/documents/:docPath(*)/restore", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const { sha } = req.body as { sha?: string };
      if (!sha || !isValidSha(sha)) {
        sendApiError(res, 400, new Error(`Invalid or missing SHA in restore request for "${docPath}". Body: ${JSON.stringify(req.body)}`));
        return;
      }

      const { committedSha } = await restoreDocument(docPath, sha, writer);
      res.json({ committed_sha: committedSha });
    } catch (error) {
      // C5: a failed pre-handoff publish leaves the live edits intact — surface
      // prose so the admin knows to have editors pause and retry (never restored).
      if (error instanceof DocSessionHandoffFailedError) {
        sendApiError(res, 409, error.message);
        return;
      }
      if (error instanceof RestoreValidationError) {
        sendApiError(res, 422, error);
        return;
      }
      next(error);
    }
  });

  // POST /documents/:docPath/overwrite
  router.post("/documents/:docPath(*)/overwrite", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const admin = await requireAdmin(req, res);
      if (!admin) return;

      const { markdown } = req.body as { markdown?: string };
      if (!markdown || typeof markdown !== "string") {
        sendApiError(res, 400, new Error(`Missing or empty "markdown" field in overwrite request for "${docPath}".`));
        return;
      }

      try {
        const { committedSha } = await overwriteDocument(docPath, markdown, admin);
        res.json({ committed_sha: committedSha });
      } catch (error) {
        if (error instanceof DocumentDoesNotExistError) {
          sendApiError(res, 404, new Error(error.message));
          return;
        }
        // C5: failed pre-handoff publish — do not overwrite; surface prose.
        if (error instanceof DocSessionHandoffFailedError) {
          sendApiError(res, 409, error.message);
          return;
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  // GET /documents/:docPath/diagnostics
  router.get("/documents/:docPath(*)/diagnostics", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const accessResult = await requireDocReadPermission(req, res, docPath);
      if (!accessResult) return;
      res.json(await getDiagnostics(docPath));
    } catch (error) {
      next(error);
    }
  });

  // GET /documents/:docPath/blame/:sectionFile
  router.get("/documents/:docPath(*)/blame/:sectionFile", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const response = await getBlame(docPath, req.params.sectionFile);
      res.json(response);
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // POST /documents/:docPath/rename
  router.post("/documents/:docPath(*)/rename", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const { new_path: newPath } = req.body as { new_path?: string };
      if (!newPath || typeof newPath !== "string") {
        sendApiError(res, 400, "Missing required field: new_path");
        return;
      }

      let result;
      try {
        result = await renameDocument(docPath, newPath, writer);
      } catch (error) {
        if (error instanceof ActiveSessionConflictError) {
          sendApiError(res, 409, error.message);
          return;
        }
        throw error;
      }
      if (result.kind === "blocked") {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: result.proposalId,
          status: "draft",
          outcome: "blocked",
          message: result.policyResult.message,
          agent_write_policy: agentWritePolicyRouteBody(result.policyResult),
        });
        return;
      }

      emitCatalogMutationEvents(
        onWsEvent,
        {
          catalogChanged: true,
          createdDocPaths: [newPath],
          deletedDocPaths: [docPath],
          renamed: { oldPath: docPath, newPath },
        },
        writer,
        result.committedHead,
      );

      res.status(200).json({ old_path: docPath, new_path: newPath, committed_head: result.committedHead });
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });
}

// ─── Document catch-all routes ──────────────────────────
// Registered LAST so they never shadow more-specific /documents/ routes.
export function registerDocumentCatchAllRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // GET /documents/:docPath — read assembled document
  router.get("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const accessResult = await requireDocReadPermission(req, res, docPath);
      if (!accessResult) return;
      const { response, headingPaths } = await readDocument(docPath);
      broadcastAgentReading(req, docPath, headingPaths, onWsEvent);
      const out: GetDocumentResponse = response;
      res.json(out);
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      if (error instanceof DocumentAssemblyError) {
        sendApiError(res, 500, error);
        return;
      }
      next(error);
    }
  });

  // PUT /documents/:docPath — create document
  router.put("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;

      let result;
      try {
        result = await createDocument(docPath, writer);
      } catch (error) {
        if (error instanceof DocumentAlreadyExistsError) {
          sendApiError(res, 409, error.message);
          return;
        }
        if (error instanceof DocumentPendingDeletionError) {
          sendApiError(res, 409, error.message);
          return;
        }
        throw error;
      }
      if (result.kind === "blocked") {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: result.proposalId,
          status: "draft",
          outcome: "blocked",
          message: result.policyResult.message,
          agent_write_policy: agentWritePolicyRouteBody(result.policyResult),
        });
        return;
      }

      emitCatalogMutationEvents(
        onWsEvent,
        {
          catalogChanged: true,
          createdDocPaths: [docPath],
          deletedDocPaths: [],
          renamed: null,
        },
        writer,
      );
      res.status(201).json({ doc_path: docPath, committed_head: result.committedHead });
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // PATCH /documents/:docPath — apply unified diff
  router.patch("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const diffText = typeof req.body === "string" ? req.body : req.body?.diff;

      if (!diffText || typeof diffText !== "string") {
        sendApiError(res, 400, "Request body must be a unified diff (text/x-diff or text/plain, or JSON with 'diff' field).");
        return;
      }

      const result = await patchDocument(docPath, diffText, writer);
      if (result.kind === "not_found") {
        sendApiError(res, 404, result.error);
        return;
      }
      if (result.kind === "parse_error") {
        sendApiError(res, 400, result.error);
        return;
      }
      if (result.kind === "no_changes") {
        res.status(200).json({ doc_path: docPath, no_changes: true });
        return;
      }
      if (result.kind === "blocked") {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: result.proposalId,
          status: "draft",
          outcome: "blocked",
          message: result.policyResult.message,
          agent_write_policy: agentWritePolicyRouteBody(result.policyResult),
        });
        return;
      }

      emitContentCommittedForSections(onWsEvent, docPath, result.sections, result.committedHead, writer, [writer.id]);

      res.status(200).json({
        doc_path: docPath,
        committed_head: result.committedHead,
        status: "committed",
      });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /documents/:docPath — delete document
  router.delete("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;

      let result;
      try {
        result = await deleteDocument(docPath, writer);
      } catch (error) {
        if (error instanceof DocumentNotFoundForDeleteError) {
          sendApiError(res, 404, error.message);
          return;
        }
        if (error instanceof ActiveSessionConflictError) {
          sendApiError(res, 409, error.message);
          return;
        }
        if (error instanceof UncommittedSessionFilesError) {
          sendApiError(res, 409, error.message);
          return;
        }
        throw error;
      }
      if (result.kind === "blocked") {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: result.proposalId,
          status: "draft",
          outcome: "blocked",
          message: result.policyResult.message,
          agent_write_policy: agentWritePolicyRouteBody(result.policyResult),
        });
        return;
      }

      emitCatalogMutationEvents(
        onWsEvent,
        {
          catalogChanged: true,
          createdDocPaths: [],
          deletedDocPaths: [docPath],
          renamed: null,
        },
        writer,
      );
      res.status(200).json({ doc_path: docPath, deleted: true, committed_head: result.committedHead });
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });
}
