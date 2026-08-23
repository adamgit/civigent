import { type Router } from "express";
import { sendApiError } from "./middleware.js";
import { getGitLog, getReadableGitLog, getReadableGitDiff, isValidSha } from "../application/git.js";
import {
  QueryParamError,
  optionalStringParam,
  boundedIntParam,
} from "../helpers/query-params.js";
import { resolveAuthenticatedWriter } from "../../auth/context.js";
import { authorizeDocRead } from "../../auth/authorized-read.js";
import { DocPath, InvalidDocPathError } from "../../types/shared.js";

export function registerGitRoutes(router: Router): void {
  router.get("/git/log", async (req, res, next) => {
    try {
      const writer = resolveAuthenticatedWriter(req);
      const limit = boundedIntParam(req.query.limit, "limit", { fallback: 30, min: 1, max: 100 });
      const offset = boundedIntParam(req.query.offset, "offset", { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
      const docPath = optionalStringParam(req.query.doc_path, "doc_path") || undefined;

      if (docPath !== undefined) {
        await authorizeDocRead(writer, DocPath.parse(docPath));
        res.json(await getGitLog({ limit, offset, docPath }));
        return;
      }

      res.json(await getReadableGitLog(writer, { limit, offset }));
    } catch (error) {
      if (error instanceof QueryParamError || error instanceof InvalidDocPathError) {
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
      const result = await getReadableGitDiff(resolveAuthenticatedWriter(req), sha);
      res.json({ sha, ...result });
    } catch (error) {
      next(error);
    }
  });
}
