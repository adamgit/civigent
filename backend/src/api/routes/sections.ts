import { type Router } from "express";
import { LiveMoveSectionRequest } from "../../types/shared.js";
import type { GetDocumentSectionsResponse, WsServerEvent } from "../../types/shared.js";
import {
  sendApiError,
  requireDocReadPermission,
  requireDocWritePermission,
  agentWritePolicyRouteBody,
} from "./middleware.js";
import {
  readSingleSection,
  readCanonicalSectionList,
  deleteSectionUseCase,
  moveSectionUseCase,
  renameSectionUseCase,
  liveMoveSectionUseCase,
  hasActiveSession,
  broadcastAgentReading,
  SectionNotFoundForMoveError,
  SectionNotFoundError,
  HeadingNotFoundError,
  InvalidDocPathError,
  DocumentNotFoundError,
  DocumentAssemblyError,
} from "../application/sections.js";
import { emitDocStructureChanged, resolveSectionFragmentKey } from "../application/events.js";
import { QueryParamError, optionalStringParam } from "../helpers/query-params.js";

// Helper: parse heading path from URL param (colon-separated)
function parseHeadingPathParam(raw: string): string[] {
  return raw.split(":").map((s) => decodeURIComponent(s.trim())).filter(Boolean);
}

export function registerSectionRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // GET /sections — read a single section by query params
  router.get("/sections", async (req, res, next) => {
    try {
      const docPath = optionalStringParam(req.query.doc_path, "doc_path");
      const headingPathRaw = optionalStringParam(req.query.heading_path, "heading_path");

      if (!docPath || !headingPathRaw) {
        sendApiError(res, 400, "doc_path and heading_path query params are required.");
        return;
      }

      const headingPath = headingPathRaw.split("/").map((s) => s.trim()).filter(Boolean);
      const response = await readSingleSection(docPath, headingPath);

      broadcastAgentReading(req, docPath, [headingPath], onWsEvent);
      res.json(response);
    } catch (error) {
      if (error instanceof QueryParamError) {
        sendApiError(res, 400, error);
        return;
      }
      if (error instanceof SectionNotFoundError || error instanceof HeadingNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // GET /documents/:docPath/sections — CANONICAL section list with involvement
  // metadata. Proposal-scoped reads live on the dedicated
  // `GET /api/proposals/:id/documents/:docPath/sections` route — this route is
  // canonical-only and takes no proposal_id parameter.
  router.get("/documents/:docPath(*)/sections", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;

      const { response, headingPaths } = await readCanonicalSectionList(docPath);
      broadcastAgentReading(req, docPath, headingPaths, onWsEvent);

      const out: GetDocumentSectionsResponse = response;
      res.json(out);
    } catch (error) {
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

  // POST /api/documents/:docPath/sections — DISABLED per items 323-327.
  router.post("/documents/:docPath(*)/sections", async (_req, res) => {
    sendApiError(
      res,
      410,
      "POST /api/documents/:docPath/sections is disabled because it mixed " +
        "structural inputs (heading, level) with arbitrary markdown content " +
        "without a defined reconciliation contract. Example: level=2 with " +
        "content starting `# New Heading` is ambiguous (preserve level 2? " +
        "normalize to the markdown heading? reject? split/rewrite?). The " +
        "route must not be re-enabled until ONE contract is chosen. Future " +
        "implementers: either (a) redesign as a pure upsert-style content " +
        "API around upsertSection(), or (b) redesign as a " +
        "strictly structural API with content rules that forbid structural " +
        "ambiguity.",
    );
  });

  // DELETE /api/documents/:docPath/sections/:headingPath — Delete a section
  router.delete("/documents/:docPath(*)/sections/:headingPath", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;

      if (hasActiveSession(docPath)) {
        sendApiError(res, 409, "Cannot modify document structure while an active editing session exists.");
        return;
      }

      const headingPath = parseHeadingPathParam(req.params.headingPath);
      if (headingPath.length === 0) {
        sendApiError(res, 400, "Cannot delete the before-first-heading section. Use document delete to remove the entire document.");
        return;
      }

      // MW-5: resolve the section's CRDT fragment_key BEFORE the delete commits —
      // afterwards the section no longer resolves in the canonical layout. We emit
      // the captured `section:gone` only once the delete actually succeeds.
      const goneFragmentKey = await resolveSectionFragmentKey(docPath, headingPath);

      const result = await deleteSectionUseCase(docPath, headingPath, writer);
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

      emitDocStructureChanged(onWsEvent, docPath);
      // MW-5: the section's canonical identity was deleted → emit `section:gone`
      // keyed by the pre-delete fragment_key so live viewers un-mount it.
      if (onWsEvent && goneFragmentKey) {
        onWsEvent({
          type: "section:gone",
          doc_path: docPath,
          fragment_key: goneFragmentKey,
          heading_path: headingPath,
        });
      }

      res.status(200).json({
        doc_path: docPath,
        heading_path: headingPath,
        deleted: true,
        committed_head: result.committedHead,
        agent_write_policy: agentWritePolicyRouteBody(result.policyResult),
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // POST /api/documents/:docPath/live-move — LIVE human drag-drop cross-section
  // move (claim-review 03 / Option E). A refusable CONTROL operation on the open
  // DocSession, explicitly OUTSIDE the CRDT binary protocol: 200 {ok} on success,
  // 409 {message} (prose) on refusal. DISTINCT from the agent proposal-structure
  // move route below.
  router.post("/documents/:docPath(*)/live-move", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;

      const parsed = LiveMoveSectionRequest.parse(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, parsed.message);
        return;
      }
      const { source_heading_path, target_heading_path, position } = parsed.value;

      const result = await liveMoveSectionUseCase(docPath, source_heading_path, target_heading_path, position);
      if (!result.ok) {
        // Apply-time refusal → 409 with the backend's prose (never a bare code).
        sendApiError(res, 409, result.message ?? "The section move was refused.");
        return;
      }
      res.status(200).json({ ok: true });
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // PUT /api/documents/:docPath/sections/:headingPath/move — Move a section
  router.put("/documents/:docPath(*)/sections/:headingPath/move", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;

      if (hasActiveSession(docPath)) {
        sendApiError(res, 409, "Cannot modify document structure while an active editing session exists.");
        return;
      }

      const headingPath = parseHeadingPathParam(req.params.headingPath);
      if (headingPath.length === 0) {
        sendApiError(res, 400, "Cannot move the before-first-heading section.");
        return;
      }

      const { new_parent_path } = req.body ?? {};
      if (!Array.isArray(new_parent_path)) {
        sendApiError(res, 400, "new_parent_path (string[]) is required.");
        return;
      }

      let result;
      try {
        result = await moveSectionUseCase(docPath, headingPath, new_parent_path, writer);
      } catch (error) {
        if (error instanceof SectionNotFoundForMoveError) {
          sendApiError(res, 404, error.message);
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

      emitDocStructureChanged(onWsEvent, docPath);

      res.status(200).json({
        doc_path: docPath,
        heading_path: headingPath,
        new_parent_path,
        moved: true,
        committed_head: result.committedHead,
        agent_write_policy: agentWritePolicyRouteBody(result.policyResult),
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // PUT /api/documents/:docPath/sections/:headingPath/rename — Rename a section heading
  router.put("/documents/:docPath(*)/sections/:headingPath/rename", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;

      if (hasActiveSession(docPath)) {
        sendApiError(res, 409, "Cannot modify document structure while an active editing session exists.");
        return;
      }

      const headingPath = parseHeadingPathParam(req.params.headingPath);
      if (headingPath.length === 0) {
        sendApiError(res, 400, "Cannot rename the before-first-heading section (it has no heading).");
        return;
      }

      const { new_heading } = req.body ?? {};
      if (!new_heading || typeof new_heading !== "string") {
        sendApiError(res, 400, "new_heading (string) is required.");
        return;
      }

      const { result, newHeadingPath } = await renameSectionUseCase(docPath, headingPath, new_heading, writer);
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

      emitDocStructureChanged(onWsEvent, docPath);

      res.status(200).json({
        doc_path: docPath,
        old_heading_path: headingPath,
        new_heading_path: newHeadingPath,
        renamed: true,
        committed_head: result.committedHead,
        agent_write_policy: agentWritePolicyRouteBody(result.policyResult),
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });
}
