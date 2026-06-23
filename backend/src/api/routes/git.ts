import { type Router } from "express";
import { sendApiError } from "./middleware.js";
import { getGitLog, getGitDiff, isValidSha } from "../application/git.js";
import {
  QueryParamError,
  optionalStringParam,
  boundedIntParam,
} from "../helpers/query-params.js";

export function registerGitRoutes(router: Router): void {
  router.get("/git/log", async (req, res, next) => {
    try {
      const limit = boundedIntParam(req.query.limit, "limit", { fallback: 30, min: 1, max: 100 });
      const offset = boundedIntParam(req.query.offset, "offset", { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
      const docPath = optionalStringParam(req.query.doc_path, "doc_path") || undefined;
      const entries = await getGitLog({ limit, offset, docPath });
      res.json(entries);
    } catch (error) {
      if (error instanceof QueryParamError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  router.get("/git/log/:sha/diff", async (req, res, next) => {
    try {
      const { sha } = req.params;
      if (!isValidSha(sha)) {
        sendApiError(res, 400, "Invalid SHA format");
        return;
      }
      const result = await getGitDiff(sha);
      res.json({ sha, ...result });
    } catch (error) {
      next(error);
    }
  });
}
