import { type Router } from "express";
import {
  sendApiError,
  resolveAuthenticatedWriter,
} from "./middleware.js";
import {
  search,
  DiscoveryValidationError,
  DiscoveryNotFoundError,
  SearchTextPatternError,
  SearchTextExecutionError,
} from "../application/documents.js";

export function registerSearchRoutes(router: Router): void {
  router.get("/search", async (req, res, next) => {
    try {
      const pattern = req.query.pattern;
      const syntax = req.query.syntax;
      const root = req.query.root;
      const caseSensitiveRaw = req.query.case_sensitive;
      const maxResultsRaw = req.query.max_results;
      const contextBytesRaw = req.query.context_bytes;

      if (typeof pattern !== "string" || pattern.length === 0) {
        sendApiError(res, 400, "pattern query param is required.");
        return;
      }
      if (syntax !== "literal" && syntax !== "regexp") {
        sendApiError(res, 400, 'syntax query param is required and must be "literal" or "regexp".');
        return;
      }

      let caseSensitive: boolean | undefined;
      if (caseSensitiveRaw !== undefined) {
        if (caseSensitiveRaw === "true") {
          caseSensitive = true;
        } else if (caseSensitiveRaw === "false") {
          caseSensitive = false;
        } else {
          sendApiError(res, 400, 'case_sensitive must be "true" or "false".');
          return;
        }
      }

      let maxResults: number | undefined;
      if (maxResultsRaw !== undefined) {
        if (typeof maxResultsRaw !== "string" || !/^\d+$/.test(maxResultsRaw)) {
          sendApiError(res, 400, "max_results must be an integer >= 1.");
          return;
        }
        maxResults = Number.parseInt(maxResultsRaw, 10);
      }

      let contextBytes: number | undefined;
      if (contextBytesRaw !== undefined) {
        if (typeof contextBytesRaw !== "string" || !/^\d+$/.test(contextBytesRaw)) {
          sendApiError(res, 400, "context_bytes must be an integer >= 0.");
          return;
        }
        contextBytes = Number.parseInt(contextBytesRaw, 10);
      }

      const result = await search(resolveAuthenticatedWriter(req), {
        pattern,
        syntax,
        root: typeof root === "string" ? root : undefined,
        case_sensitive: caseSensitive,
        max_results: maxResults,
        context_bytes: contextBytes,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof DiscoveryValidationError || error instanceof SearchTextPatternError) {
        sendApiError(res, 400, error.message);
        return;
      }
      if (error instanceof DiscoveryNotFoundError) {
        sendApiError(res, 404, error.message);
        return;
      }
      if (error instanceof SearchTextExecutionError) {
        sendApiError(res, 502, error.message);
        return;
      }
      next(error);
    }
  });
}
