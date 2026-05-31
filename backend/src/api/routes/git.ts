import { type Router } from "express";
import { sendApiError } from "./middleware.js";
import { getGitLog, getGitDiff, isValidSha } from "../application/git.js";

export function registerGitRoutes(router: Router): void {
  router.get("/git/log", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const docPath = (req.query.doc_path as string) || undefined;
      const entries = await getGitLog({ limit, offset, docPath });
      res.json(entries);
    } catch (error) {
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
