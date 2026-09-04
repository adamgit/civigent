import { type Router } from "express";
import type {
  GetDocumentsTreeResponse,
  GetFolderFileAgesResponse,
  ReadDocStructureResponse,
  WsServerEvent,
} from "../../types/shared.js";
import {
  sendApiError,
  requireAdmin,
  requireAuthenticatedWriter,
  resolveAuthenticatedWriter,
  requireDocReadPermission,
  requireDocWritePermission,
  agentWritePolicyRouteBody,
  docPathParamOf,
} from "./middleware.js";
import {
  readTree,
  readFolderFileAges,
  readWorkspaceStructure,
  getDiagnostics,
  restoreDocument,
  RestoreValidationError,
  adminOverwriteDocument,
  forcePublishDocument,
  renameDocument,
  createDocument,
  deleteDocument,
  isValidSha,
  DirectoryAtDocPathError,
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
  deleteFolder,
  renameFolder,
  FolderWritePermissionError,
  readLiveDocumentMarkdown,
} from "../application/documents.js";
import { emitCatalogMutationEvents, emitContentCommittedEventsByDoc } from "../application/events.js";
import { DocPath, FolderPath, InvalidFolderPathError } from "../../types/shared.js";
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
      const response: GetDocumentsTreeResponse = await readTree(writer, basePath);
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
      const { response } = await readWorkspaceStructure(access);
      const out: ReadDocStructureResponse = response;
      res.json(out);
    } catch (error) {
      if (error instanceof DirectoryAtDocPathError) {
        sendApiError(res, 409, error);
        return;
      }
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // GET /workspace/:docPath/live-markdown — raw live fragment truth export
  router.get("/workspace/:docPath(*)/live-markdown", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const markdown = await readLiveDocumentMarkdown(access);
      res.json({ doc_path: docPath, markdown });
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

      const { committedSha, targets } = await restoreDocument(docPath, sha, writer);
      emitContentCommittedEventsByDoc(onWsEvent, writer, [writer.id], committedSha, targets);
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

  // POST /workspace/:docPath/admin-overwrite (admin-only)
  router.post("/workspace/:docPath(*)/admin-overwrite", async (req, res, next) => {
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
        const { committedSha, targets } = await adminOverwriteDocument(docPath, markdown, admin);
        emitContentCommittedEventsByDoc(onWsEvent, admin, [admin.id], committedSha, targets);
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
        if (error instanceof DocumentAlreadyExistsError) {
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

  // GET /workspace-folder/:folderPath/file-ages — last-touch age per direct-child file
  router.get("/workspace-folder/:folderPath(*)/file-ages", async (req, res, next) => {
    try {
      const writer = resolveAuthenticatedWriter(req);
      const folder = FolderPath.fromSlashStrippedUrlSegment(req.params.folderPath);
      const response: GetFolderFileAgesResponse = await readFolderFileAges(writer, folder);
      res.json(response);
    } catch (error) {
      if (error instanceof InvalidFolderPathError) {
        sendApiError(res, 400, error);
        return;
      }
      if (error instanceof DocumentsTreePathNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // DELETE /workspace-folder/:folderPath — delete every document in a folder
  router.delete("/workspace-folder/:folderPath(*)", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      let folder;
      let outcome;
      try {
        folder = FolderPath.fromSlashStrippedUrlSegment(req.params.folderPath);
        outcome = await deleteFolder(folder, writer);
      } catch (error) {
        if (error instanceof InvalidFolderPathError) {
          sendApiError(res, 400, error);
          return;
        }
        if (error instanceof DocumentsTreePathNotFoundError) {
          sendApiError(res, 404, error);
          return;
        }
        if (error instanceof FolderWritePermissionError) {
          sendApiError(res, 403, error.message);
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

      const { result, deletedDocPaths } = outcome;
      if (result.kind === "blocked") {
        res.status(409).json({
          folder_path: folder,
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
          deletedDocPaths,
          renamed: null,
        },
        writer,
        result.committedHead,
      );

      res.status(200).json({
        folder_path: folder,
        deleted_doc_paths: deletedDocPaths,
        committed_head: result.committedHead,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /workspace-folder/:folderPath/rename — rename every document in a folder
  router.post("/workspace-folder/:folderPath(*)/rename", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const { new_path: newPath } = (req.body ?? {}) as { new_path?: unknown };
      if (newPath === undefined || typeof newPath !== "string") {
        sendApiError(res, 400, "Missing required field: new_path");
        return;
      }

      let from;
      let to;
      let outcome;
      try {
        from = FolderPath.fromSlashStrippedUrlSegment(req.params.folderPath);
        to = FolderPath.normalize(newPath);
        outcome = await renameFolder(from, to, writer);
      } catch (error) {
        if (error instanceof InvalidFolderPathError) {
          sendApiError(res, 400, error);
          return;
        }
        if (error instanceof DocumentsTreePathNotFoundError) {
          sendApiError(res, 404, error);
          return;
        }
        if (error instanceof FolderWritePermissionError) {
          sendApiError(res, 403, error.message);
          return;
        }
        if (error instanceof ActiveSessionConflictError) {
          sendApiError(res, 409, error.message);
          return;
        }
        if (error instanceof DocumentAlreadyExistsError) {
          sendApiError(res, 409, error.message);
          return;
        }
        throw error;
      }

      const { result, renames } = outcome;
      if (result.kind === "blocked") {
        res.status(409).json({
          folder_path: from,
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
          createdDocPaths: renames.map((r) => r.to),
          deletedDocPaths: renames.map((r) => r.from),
          renamed:
            renames.length === 1
              ? { oldPath: renames[0].from, newPath: renames[0].to }
              : null,
        },
        writer,
        result.committedHead,
      );

      res.status(200).json({
        old_folder_path: from,
        new_folder_path: to,
        renamed: renames.map((r) => ({ old_path: r.from, new_path: r.to })),
        committed_head: result.committedHead,
      });
    } catch (error) {
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

      const { markdown } = (req.body ?? {}) as { markdown?: unknown };
      if (markdown !== undefined && typeof markdown !== "string") {
        sendApiError(res, 400, new Error(`"markdown" must be a string when present in create request for "${docPath}".`));
        return;
      }

      let result;
      try {
        result = await createDocument(docPath, writer, markdown);
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
