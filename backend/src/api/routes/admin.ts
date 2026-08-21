import { type Router } from "express";
import {
  SetAclDefaultsRequest,
  SetDocumentAclRequest,
  SetUserRolesRequest,
  CreateCustomRoleRequest,
} from "../../types/shared.js";
import type {
  ListProposalsResponse,
  WithdrawProposalResponse,
  WsServerEvent,
} from "../../types/shared.js";
import {
  sendApiError,
  requireAdmin,
  getMCPPublicURL,
  docPathParamOf,
} from "./middleware.js";
import { getAgentAuthPolicy } from "../../auth/oauth-config.js";
import { getToolKeyCatalog } from "../application/setup.js";
import {
  getAdminConfigWithDescription,
  updateAdminConfigWithDescription,
  readSnapshotHealth,
  readSnapshotHistory,
  triggerSnapshotNow,
  getActivity,
  listAgents,
  createAgent,
  deleteAgent,
  rotateAgent,
  getAgentsSummary,
  getAgentMcpPulse,
  getAcl,
  setAclDefaults,
  setDocAclEntry,
  removeDocAclEntry,
  setRoles,
  removeRoles,
  createCustomRole,
  removeCustomRole,
  getAgentActivity,
  readAgentActivityLogFileInfo,
  getHeatmap,
  getRuntimeMemory,
  listAdminProposals,
  readAdminProposal,
  forceCancelProposal,
  autofixProposalDefect,
  InvalidProposalStateError,
  ProposalNotFoundError,
  AdminConfigValidationError,
  SnapshotGenerationDisabledError,
  SnapshotRootNotWritableError,
  readGitBackupStatus,
  runGitBackup,
  verifyGitBackupRefs,
  readGitRestoreStatus,
  runGitBackupRestore,
  GitBackupOperationError,
  scanContentIntegrity,
} from "../application/admin.js";
import {
  emitProposalWithdrawnEventsByDoc,
  emitSectionBlockState,
  groupSectionsByDocPath,
} from "../application/events.js";
import { refreshLiveSectionsState } from "../../ws/crdt-ws-coordinator.js";

export function registerAdminRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // ─── Activity (not admin-gated) ───────────────────────
  router.get("/activity", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 500);
      const days = Math.max(Number(req.query.days ?? 30), 1);
      res.json(await getActivity(limit, days));
    } catch (error) {
      next(error);
    }
  });

  // ─── Heatmap ──────────────────────────────────────────
  router.get("/heatmap", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await getHeatmap());
    } catch (error) {
      next(error);
    }
  });

  // ─── Config ───────────────────────────────────────────
  router.get("/admin/config", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await getAdminConfigWithDescription());
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/config", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await updateAdminConfigWithDescription(req.body));
    } catch (error) {
      if (error instanceof AdminConfigValidationError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // ─── Snapshots ────────────────────────────────────────
  router.get("/admin/snapshot-health", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await readSnapshotHealth());
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/snapshot-history", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await readSnapshotHistory());
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/snapshot-now", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      await triggerSnapshotNow();
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof SnapshotGenerationDisabledError || error instanceof SnapshotRootNotWritableError) {
        sendApiError(res, 409, error);
        return;
      }
      next(error);
    }
  });

  // ─── Setup / connection info (public) ─────────────────
  router.get("/setup", (req, res) => {
    let defaultServerName: string;
    try {
      const host = req.hostname;
      const isLocalhost = host === "localhost" || host === "127.0.0.1";
      if (isLocalhost) {
        defaultServerName = "civigent-local";
      } else {
        const hostEnd = host.slice(-10);
        defaultServerName = `civigent-${hostEnd.replace(/[^a-zA-Z0-9-]/g, "-")}`;
      }
    } catch {
      defaultServerName = "civigent-local";
    }

    res.json({
      defaultServerName,
      internalPort: Number(process.env.PORT ?? "3000"),
      mcpUrl: `${getMCPPublicURL(req)}/mcp`,
      agent_auth_policy: getAgentAuthPolicy(),
      // Stable key → current wire name, so the frontend can resolve `{{tool:key}}`
      // tokens in the served skill.md / cursor-rule.md templates at render time.
      toolKeys: getToolKeyCatalog(),
    });
  });

  // ─── Pre-authenticated agent management ───────────────
  router.get("/admin/agents", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await listAgents());
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/agents", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { display_name, agent_id, generate_secret } = req.body ?? {};
      if (!display_name || typeof display_name !== "string") {
        sendApiError(res, 400, "display_name is required.");
        return;
      }
      if (generate_secret === false) {
        sendApiError(res, 400, "Secretless agents are no longer supported; every created agent receives a client secret.");
        return;
      }
      const result = await createAgent(display_name, typeof agent_id === "string" ? agent_id : undefined);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/agents/:agentId", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const removed = await deleteAgent(req.params.agentId);
      if (!removed) {
        sendApiError(res, 404, "Agent not found.");
        return;
      }
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/agents/:agentId/rotate-secret", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await rotateAgent(req.params.agentId));
    } catch (error) {
      next(error);
    }
  });

  // ─── Proposal administration ──────────────────────────
  router.get("/admin/proposals", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const result = await listAdminProposals();
      const response: ListProposalsResponse = result;
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/proposals/:id", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await readAdminProposal(req.params.id));
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  router.post("/admin/proposals/:id/force-cancel", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const reason = typeof req.body?.reason === "string"
        ? req.body.reason
        : `Force-cancelled by administrator ${admin.displayName}.`;
      const result = await forceCancelProposal(req.params.id, reason);

      emitProposalWithdrawnEventsByDoc(onWsEvent, result.proposalId, result.targets);
      for (const [docPath, headingPaths] of groupSectionsByDocPath(result.sections)) {
        await emitSectionBlockState(onWsEvent, docPath, headingPaths, "section:unblocked");
        await refreshLiveSectionsState(docPath);
      }

      const response: WithdrawProposalResponse = {
        proposal_id: result.proposalId,
        status: "withdrawn",
      };
      res.json(response);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      if (error instanceof InvalidProposalStateError) {
        sendApiError(res, 409, error);
        return;
      }
      next(error);
    }
  });

  // ─── Proposal defect autofix ──────────────────────────
  router.post("/admin/proposals/:id/autofix/:detectorId", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const result = await autofixProposalDefect(req.params.id, req.params.detectorId);
      if (!result.ok) {
        sendApiError(res, result.status, result.message);
        return;
      }
      res.json({ proposal: result.proposal });
    } catch (error) {
      next(error);
    }
  });

  // ─── Agent activity summary ───────────────────────────
  router.get("/agents/summary", async (_req, res, next) => {
    try {
      res.json(await getAgentsSummary());
    } catch (error) {
      next(error);
    }
  });

  // Home pulse: last-N-hours MCP calls (not admin-gated — humans watch agents).
  router.get("/agents/mcp-pulse", async (req, res, next) => {
    try {
      const hours = Math.min(Math.max(Number(req.query.hours ?? 24), 1), 168);
      res.json(await getAgentMcpPulse(hours));
    } catch (error) {
      next(error);
    }
  });

  // ─── Admin ACL/RBAC management ────────────────────────
  router.get("/admin/acl", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await getAcl());
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/acl/defaults", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const parsed = SetAclDefaultsRequest.parse(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, parsed.message);
        return;
      }
      await setAclDefaults(parsed.value);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/acl/doc/:docPath(*)", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const parsed = SetDocumentAclRequest.parse(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, parsed.message);
        return;
      }
      await setDocAclEntry(docPathParamOf(req), parsed.value);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/acl/doc/:docPath(*)", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      await removeDocAclEntry(docPathParamOf(req));
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/roles/:userId", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const parsed = SetUserRolesRequest.parse(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, parsed.message);
        return;
      }
      await setRoles(req.params.userId, parsed.value);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/roles/:userId", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      await removeRoles(req.params.userId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/custom-roles", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const parsed = CreateCustomRoleRequest.parse(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, parsed.message);
        return;
      }
      await createCustomRole(parsed.value);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof Error && (error.message.includes("magic role") || error.message.includes("already exists"))) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  router.delete("/admin/custom-roles/:name", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      await removeCustomRole(req.params.name);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof Error && (error.message.includes("magic role") || error.message.includes("does not exist"))) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Runtime memory ───────────────────────────────────
  router.get("/admin/runtime-memory", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(getRuntimeMemory());
    } catch (error) {
      next(error);
    }
  });

  // ─── Content integrity scan (on-demand, in-memory) ────
  router.post("/admin/content-integrity-scan", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await scanContentIntegrity());
    } catch (error) {
      next(error);
    }
  });

  // ─── Agent MCP activity log ───────────────────────────
  router.get("/admin/agent-activity", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await getAgentActivity());
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/agent-activity/download", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const logFile = await readAgentActivityLogFileInfo();
      if (!logFile.exists) {
        sendApiError(res, 404, "No agent MCP activity log has been written yet.");
        return;
      }
      res.download(logFile.path, "agent-mcp-activity.jsonl", (error) => {
        if (error) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  // ─── Git backup / restore ─────────────────────────────
  //
  // Every route below is admin-gated. Actionable failures the admin can act
  // on (misconfigured env, unreachable remote, refused restore, active
  // proposals without an acknowledgement) come out of the service layer as
  // `GitBackupOperationError` and are surfaced as `409` so the admin UI
  // shows the prose message from the plan doc directly.
  router.get("/admin/git-backup/status", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await readGitBackupStatus());
    } catch (error) {
      if (error instanceof GitBackupOperationError) {
        sendApiError(res, 409, error.message);
        return;
      }
      next(error);
    }
  });

  router.post("/admin/git-backup/run", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await runGitBackup());
    } catch (error) {
      if (error instanceof GitBackupOperationError) {
        sendApiError(res, 409, error.message);
        return;
      }
      next(error);
    }
  });

  router.post("/admin/git-backup/verify", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await verifyGitBackupRefs());
    } catch (error) {
      if (error instanceof GitBackupOperationError) {
        sendApiError(res, 409, error.message);
        return;
      }
      next(error);
    }
  });

  router.get("/admin/git-backup/restore-status", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await readGitRestoreStatus());
    } catch (error) {
      if (error instanceof GitBackupOperationError) {
        sendApiError(res, 409, error.message);
        return;
      }
      next(error);
    }
  });

  router.post("/admin/git-backup/restore", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await runGitBackupRestore());
    } catch (error) {
      if (error instanceof GitBackupOperationError) {
        sendApiError(res, 409, error.message);
        return;
      }
      next(error);
    }
  });
}
