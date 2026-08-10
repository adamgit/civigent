import { type Router } from "express";
import type {
  GetDocumentResponse,
  ReadDocStructureResponse,
  WsServerEvent,
} from "../../types/shared.js";
import {
  sendApiError,
  requireDocReadPermission,
  docPathParamOf,
} from "./middleware.js";
import {
  readCanonicalStructure,
  getHistory,
  getHistoryPreview,
  getBlame,
  readCanonicalDocument,
  broadcastAgentReading,
  isValidSha,
  DirectoryAtDocPathError,
  DocumentNotFoundError,
  DocumentAssemblyError,
  InvalidDocPathError,
} from "../application/documents.js";
import {
  QueryParamError,
  boundedIntParam,
} from "../helpers/query-params.js";

// ─── Canonical (committed, read-only, agent-facing) routes ──────────────
//
// Committed audit-log content reads + audit views. Never a write target (see the
// write invariant: every write edits a proposal and commits through the
// agent-write-policy pipeline). Content reads emit `agent:reading`.

export function registerCanonicalRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // GET /canonical/:docPath/structure
  router.get("/canonical/:docPath(*)/structure", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const { response, headingPaths } = await readCanonicalStructure(docPath);
      broadcastAgentReading(req, docPath, headingPaths, onWsEvent);
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

  // GET /canonical/:docPath/history
  router.get("/canonical/:docPath(*)/history", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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

  // GET /canonical/:docPath/history/:sha/preview
  router.get("/canonical/:docPath(*)/history/:sha/preview", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const { sha } = req.params;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      if (!isValidSha(sha)) {
        sendApiError(res, 400, new Error(`Invalid SHA format: "${sha}"`));
        return;
      }
      res.json(await getHistoryPreview(docPath, sha));
    } catch (error) {
      if (error instanceof DirectoryAtDocPathError) {
        sendApiError(res, 409, error);
        return;
      }
      if (error instanceof DocumentNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // GET /canonical/:docPath/blame/:sectionFile
  router.get("/canonical/:docPath(*)/blame/:sectionFile", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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
}

// ─── Canonical catch-all ────────────────────────────────
// Registered LAST so it never shadows the more-specific /canonical/ routes.
export function registerCanonicalCatchAllRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // GET /canonical/:docPath — read assembled committed document
  router.get("/canonical/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const accessResult = await requireDocReadPermission(req, res, docPath);
      if (!accessResult) return;
      const { response, headingPaths } = await readCanonicalDocument(docPath);
      broadcastAgentReading(req, docPath, headingPaths, onWsEvent);
      const out: GetDocumentResponse = response;
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
      if (error instanceof DocumentAssemblyError) {
        sendApiError(res, 500, error);
        return;
      }
      next(error);
    }
  });
}
