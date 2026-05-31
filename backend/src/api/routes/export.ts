import { type Router } from "express";
import { buildExport, DocumentsTreePathNotFoundError } from "../application/documents.js";

export function registerExportRoutes(router: Router): void {
  router.get("/export", async (req, res, next) => {
    try {
      const browsePath = typeof req.query.path === "string" ? req.query.path : "/";
      const { stream, filename } = await buildExport(browsePath);

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      stream.pipe(res);
    } catch (error) {
      if (error instanceof DocumentsTreePathNotFoundError) {
        res.status(404).json({ message: `Path not found: ${req.query.path}` });
        return;
      }
      next(error);
    }
  });
}
