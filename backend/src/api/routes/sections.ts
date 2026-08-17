import { type Router } from "express";
import { LiveMoveSectionRequest } from "../../types/shared.js";
import type { GetDocumentSectionsResponse, WsServerEvent } from "../../types/shared.js";
import {
  sendApiError,
  requireDocReadPermission,
  requireDocWritePermission,
  agentWritePolicyRouteBody,
  docPathParamOf,
} from "./middleware.js";
import {
  readCanonicalSectionList,
  readWorkspaceSectionList,
  deleteSectionUseCase,
  moveSectionUseCase,
  renameSectionUseCase,
  liveMoveSectionUseCase,
  hasActiveSession,
  broadcastAgentReading,
  SectionNotFoundForMoveError,
  InvalidDocPathError,
  DirectoryAtDocPathError,
  DocumentNotFoundError,
  DocumentAssemblyError,
} from "../application/sections.js";
import { emitCanonicalStructureChanged, resolveSectionFragmentKey } from "../application/events.js";


function parseHeadingPathParam(raw: string): string[] {
  return raw.split(":").map((s) => decodeURIComponent(s.trim())).filter(Boolean);
}

export function registerSectionRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  
  // GET /canonical/:docPath/sections — committed section list (emits agent:reading)
  router.get("/canonical/:docPath(*)/sections", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;

      const { response, headingPaths } = await readCanonicalSectionList(access);
      broadcastAgentReading(req, docPath, headingPaths, onWsEvent);

      const out: GetDocumentSectionsResponse = response;
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

  // GET /workspace/:docPath/sections — working-copy section list (no agent:reading)
  router.get("/workspace/:docPath(*)/sections", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;

      const { response } = await readWorkspaceSectionList(access);

      const out: GetDocumentSectionsResponse = response;
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

  // DELETE /workspace/:docPath/sections/:headingPath
  router.delete("/workspace/:docPath(*)/sections/:headingPath", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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

      await emitCanonicalStructureChanged(onWsEvent, docPath);
      
      
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

  
  
  
  
  
  router.post("/workspace/:docPath(*)/live-move", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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

  
  router.put("/workspace/:docPath(*)/sections/:headingPath/move", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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

      await emitCanonicalStructureChanged(onWsEvent, docPath);

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

  
  router.put("/workspace/:docPath(*)/sections/:headingPath/rename", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
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

      await emitCanonicalStructureChanged(onWsEvent, docPath);

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
