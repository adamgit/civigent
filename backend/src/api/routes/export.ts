import { type Router } from "express";
import { buildExport, DocumentsTreePathNotFoundError, type ExportLayout } from "../application/documents.js";
import { resolveAuthenticatedWriter } from "../../auth/context.js";

export function registerExportRoutes(router: Router): void {
  router.get("/export", async (req, res, next) => {
    try {
      const writer = resolveAuthenticatedWriter(req);
      const browsePath = typeof req.query.path === "string" ? req.query.path : "/";
      const rawLayout = req.query.layout;
      let layout: ExportLayout;
      if (rawLayout === undefined || rawLayout === "relative") {
        layout = "relative";
      } else if (rawLayout === "absolute") {
        layout = "absolute";
      } else {
        res.status(400).json({ message: `Invalid layout: ${String(rawLayout)} (expected "relative" or "absolute")` });
        return;
      }
      const { stream, filename } = await buildExport(writer, browsePath, layout);

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
