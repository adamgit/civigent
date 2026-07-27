import { type Router } from "express";
import type {
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
  docPathParamOf,
} from "./middleware.js";
import {
  readTree,
  readWorkspaceStructure,
  getDiagnostics,
  restoreDocument,
  RestoreValidationError,
  overwriteDocument,
  forcePublishDocument,
  renameDocument,
  createDocument,
  deleteDocument,
  isValidSha,
  DocumentNotFoundError,
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
import { emitCatalogMutationEvents } from "../application/events.js";
import { DocPath } from "../../types/shared.js";
import {
  QueryParamError,
  optionalStringParam,
} from "../helpers/query-params.js";

// ─── Workspace (human working-copy) routes ──────────────────────────────
//
// The human frontend surface: working-copy reads (in-progress proposal first,
// canonical fallback — see openWorkspaceReader), the catalog/tree the sidebar
// renders, and human edits. Human edits are proposal edits against the working
// copy that commit through the agent-write-policy pipeline (write invariant).
// Workspace reads do NOT emit `agent:reading` (they are human-facing).

export function registerWorkspaceRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // GET /workspace/tree
  router.get("/workspace/tree", async (req, res, next) => {
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

  // GET /workspace/:docPath/structure — working-copy structure (no agent:reading)
  router.get("/workspace/:docPath(*)/structure", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const { response } = await readWorkspaceStructure(docPath);
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

  // GET /workspace/:docPath/diagnostics — live-crdt-vs-canonical comparison
  router.get("/workspace/:docPath(*)/diagnostics", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const accessResult = await requireDocReadPermission(req, res, docPath);
      if (!accessResult) return;
      res.json(await getDiagnostics(docPath));
    } catch (error) {
      next(error);
    }
  });

  // POST /workspace/:docPath/restore
  router.post("/workspace/:docPath(*)/restore", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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

  // POST /workspace/:docPath/overwrite (admin-only)
  router.post("/workspace/:docPath(*)/overwrite", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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

  // POST /workspace/:docPath/force-publish
  // User-initiated force publish of the document's live in-flight edits. Returns
  // the `PublishAttemptOutcome` verbatim (committed / noop / aborted / failed) —
  // a non-success outcome is a legitimate user-facing result here, not a server
  // error, so it is delivered as JSON rather than routed to the process-fatal
  // autonomous path (FP2).
  router.post("/workspace/:docPath(*)/force-publish", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const outcome = await forcePublishDocument(docPath);
      res.json(outcome);
    } catch (error) {
      next(error);
    }
  });

  // POST /workspace/:docPath/rename
  router.post("/workspace/:docPath(*)/rename", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const { new_path: newPath } = req.body as { new_path?: string };
      if (!newPath || typeof newPath !== "string") {
        sendApiError(res, 400, "Missing required field: new_path");
        return;
      }

      let result;
      try {
        result = await renameDocument(docPath, DocPath.parse(newPath), writer);
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

// ─── Workspace catch-all routes ─────────────────────────
// Registered LAST so they never shadow the more-specific /workspace/ routes.
export function registerWorkspaceCatchAllRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // PUT /workspace/:docPath — create document
  router.put("/workspace/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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

  // DELETE /workspace/:docPath — delete document
  router.delete("/workspace/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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
