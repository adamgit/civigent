import { type Request, type Router } from "express";
import type { WsServerEvent } from "../../types/shared.js";
import {
  sendApiError,
  requireAuthenticatedWriter,
  agentWritePolicyRouteBody,
} from "./middleware.js";
import {
  createImport,
  listImports,
  scanImport,
  commitImport,
  removeImport,
  writeUploadedFiles,
  spoolImportZipUpload,
  extractImportZipSpool,
  stagingFolderExists,
  ImportUploadError,
  ImportEmptyError,
  ImportZipTooLargeError,
  humanBypassPolicyResult,
} from "../application/imports.js";
import { emitContentCommittedForSections } from "../application/events.js";
import { DocPath, FolderPath, InvalidFolderPathError } from "../../types/shared.js";

// ─── Multipart wire-format parsing (HTTP-layer body handling) ──

function parseMultipartBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2] ?? null;
}

async function readRequestBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseMultipartUploadFiles(body: Buffer, boundary: string): Array<{ name: string; content: string }> {
  const raw = body.toString("latin1");
  const parts = raw.split(`--${boundary}`);
  const files: Array<{ name: string; content: string }> = [];

  for (const part of parts) {
    if (!part || part === "--" || part === "--\r\n") continue;
    const normalizedPart = part.startsWith("\r\n") ? part.slice(2) : part;
    const headerEnd = normalizedPart.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;

    const headerBlock = normalizedPart.slice(0, headerEnd);
    let contentBlock = normalizedPart.slice(headerEnd + 4);
    if (contentBlock.endsWith("\r\n")) {
      contentBlock = contentBlock.slice(0, -2);
    }

    const dispositionLine = headerBlock
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-disposition:"));
    if (!dispositionLine) continue;

    const fieldName = /name="([^"]+)"/i.exec(dispositionLine)?.[1];
    if (fieldName !== "files") continue;

    const filename = /filename="([^"]*)"/i.exec(dispositionLine)?.[1];
    if (!filename) continue;

    files.push({
      name: filename,
      content: Buffer.from(contentBlock, "latin1").toString("utf8"),
    });
  }

  return files;
}

export function registerImportRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  router.post("/imports", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      if (writer.type !== "human") {
        sendApiError(res, 403, "Only human writers can create imports.");
        return;
      }
      const { target_folder: targetFolderRaw } = (req.body ?? {}) as { target_folder?: unknown };
      if (typeof targetFolderRaw !== "string") {
        sendApiError(res, 400, "Missing required field: target_folder");
        return;
      }
      let targetFolder;
      try {
        targetFolder = FolderPath.normalize(targetFolderRaw);
      } catch (error) {
        if (error instanceof InvalidFolderPathError) {
          sendApiError(res, 400, error);
          return;
        }
        throw error;
      }
      const { importId, stagingPath } = await createImport(targetFolder);
      res.status(201).json({ import_id: importId, staging_path: stagingPath, target_folder: targetFolder });
    } catch (error) {
      next(error);
    }
  });

  router.post("/imports/:id/upload", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      if (writer.type !== "human") {
        sendApiError(res, 403, "Only human writers can upload import files.");
        return;
      }

      const importId = req.params.id;
      const boundary = parseMultipartBoundary(req.headers["content-type"]);
      if (!boundary) {
        sendApiError(res, 400, "multipart/form-data with one or more files parts is required.");
        return;
      }

      if (!(await stagingFolderExists(importId))) {
        sendApiError(res, 404, `Import ${importId} not found.`);
        return;
      }

      const files = parseMultipartUploadFiles(await readRequestBody(req), boundary);
      if (files.length === 0) {
        sendApiError(res, 400, "At least one uploaded Markdown file is required.");
        return;
      }

      try {
        const uploaded = await writeUploadedFiles(importId, files);
        res.status(200).json({ uploaded });
      } catch (error) {
        if (error instanceof ImportUploadError) {
          sendApiError(res, 400, error.message);
          return;
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  router.post("/imports/:id/upload-zip", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      if (writer.type !== "human") {
        sendApiError(res, 403, "Only human writers can upload import files.");
        return;
      }

      const importId = req.params.id;
      const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/zip") {
        sendApiError(res, 400, "An application/zip request body is required.");
        return;
      }

      if (!(await stagingFolderExists(importId))) {
        sendApiError(res, 404, `Import ${importId} not found.`);
        return;
      }

      try {
        await spoolImportZipUpload(importId, req);
        const uploaded = await extractImportZipSpool(importId);
        res.status(200).json({ uploaded });
      } catch (error) {
        if (error instanceof ImportZipTooLargeError) {
          sendApiError(res, 413, error.message);
          return;
        }
        if (error instanceof ImportUploadError) {
          sendApiError(res, 400, error.message);
          return;
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/imports", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      res.json(await listImports());
    } catch (error) {
      next(error);
    }
  });

  router.get("/imports/:id", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const importId = req.params.id;
      if (!(await stagingFolderExists(importId))) {
        sendApiError(res, 404, `Import ${importId} not found.`);
        return;
      }
      res.json(await scanImport(importId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/imports/:id/commit", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      if (writer.type !== "human") {
        sendApiError(res, 403, "Only human writers can commit imports.");
        return;
      }

      const importId = req.params.id;
      const { description } = req.body ?? {};
      if (typeof description !== "string" || description.trim().length === 0) {
        sendApiError(res, 400, "description (non-empty string) is required.");
        return;
      }

      let result;
      try {
        result = await commitImport(importId, writer, description);
      } catch (error) {
        if (error instanceof ImportEmptyError) {
          sendApiError(res, 400, error.message);
          return;
        }
        throw error;
      }

      if (result.sections.length > 0) {
        emitContentCommittedForSections(
          onWsEvent,
          DocPath.parse(result.sections[0].doc_path),
          result.sections,
          result.committedHead,
          writer,
          [writer.id],
        );
      }

      res.status(201).json({
        proposal_id: result.proposalId,
        status: "committed",
        outcome: "accepted",
        committed_head: result.committedHead,
        agent_write_policy: agentWritePolicyRouteBody(humanBypassPolicyResult()),
        sections: result.sections,
        diagnostics: result.diagnostics,
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/imports/:id", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      await removeImport(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
}
