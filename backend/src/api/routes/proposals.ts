import { type Router } from "express";
import {
  CreateProposalRequest,
  UpdateProposalManifestRequest,
  UpsertProposalSectionsRequest,
  WriteProposalDocumentSectionsRequest,
} from "../../types/shared.js";
import type {
  CreateProposalResponse,
  CommitProposalResponse,
  WithdrawProposalResponse,
  AcquireLocksResponse,
  ListProposalsResponse,
  ReadProposalResponse,
  GetDocumentSectionsResponse,
  GetProposalSectionsResponse,
  WsServerEvent,
} from "../../types/shared.js";
import {
  sendApiError,
  requireAuthenticatedWriter,
  refuseScopedWriter,
  requireDocReadPermission,
  checkWritePermission,
  docPathParamOf,
} from "./middleware.js";
import { resolveAuthenticatedWriter } from "../../auth/context.js";
import {
  proposalTargetDocPathForDisplay,
  proposalSectionDocPathForDisplay,
} from "../../types/shared.js";
import {
  isProposalStatus,
  listProposalsForStatusFilter,
  listMyProposals,
  listDegradedProposalsUseCase,
  readProposalDto,
  validateCreateProposal,
  createProposalUseCase,
  modifyProposalUseCase,
  upsertProposalSectionsUseCase,
  writeProposalDocumentSectionsUseCase,
  acquireLocksUseCase,
  commitProposalUseCase,
  cancelProposalUseCase,
  ProposalNotFoundError,
  InvalidProposalStateError,
} from "../application/proposals.js";
import {
  readProposalSectionList,
  readProposalAllSections,
  verifyProposalForRead,
  broadcastAgentReading,
  SectionsReadForbiddenError,
  DocumentNotFoundError,
  InvalidDocPathError,
  DocumentAssemblyError,
} from "../application/sections.js";
import {
  emitProposalDraftEventsByDoc,
  emitProposalInProgressEventsByDoc,
  emitProposalWithdrawnEventsByDoc,
  emitContentCommittedEventsByDoc,
  emitSectionBlockState,
  groupSectionsByDocPath,
} from "../application/events.js";
import { refreshLiveSectionsState } from "../../ws/crdt-ws-coordinator.js";

export function registerProposalRoutes(
  router: Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // POST /api/proposals — Submit proposal
  router.post("/proposals", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const parsed = CreateProposalRequest.parse(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, parsed.message);
        return;
      }
      const body = parsed.value;

      // Check write permission for all target documents
      const targetDocPaths = new Set((body.sections ?? []).map((s) => s.doc_path).filter(Boolean));
      for (const docPath of targetDocPaths) {
        const allowed = await checkWritePermission(writer, docPath);
        if (!allowed) {
          sendApiError(res, 403, `You do not have permission to write to document "${docPath}".`);
          return;
        }
      }

      const validation = validateCreateProposal(writer.type, body);
      if (!validation.ok) {
        sendApiError(res, validation.status, validation.message);
        return;
      }

      const replaceFlag = req.query.replace === "true";
      const outcome = await createProposalUseCase(writer, body, replaceFlag);

      emitProposalDraftEventsByDoc(onWsEvent, outcome.proposalId, writer, outcome.intent, outcome.draftTargets);

      const response: CreateProposalResponse = {
        proposal_id: outcome.proposalId,
        status: "draft",
        outcome: outcome.outcome,
        agentWritePolicy: outcome.agentWritePolicy,
      };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/proposals — List proposals
  router.get("/proposals", async (req, res, next) => {
    try {
      if (refuseScopedWriter(resolveAuthenticatedWriter(req), res)) return;
      const statusFilterRaw = req.query.status;
      if (statusFilterRaw !== undefined && !isProposalStatus(statusFilterRaw)) {
        sendApiError(res, 400, "Invalid status filter.");
        return;
      }
      const statusFilter = isProposalStatus(statusFilterRaw) ? statusFilterRaw : undefined;
      const { proposals, undecodable } = await listProposalsForStatusFilter(statusFilter);
      const response: ListProposalsResponse = { proposals, undecodable };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/my-proposals — List proposals for the authenticated writer only
  router.get("/my-proposals", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const statusFilterRaw = req.query.status;
      if (statusFilterRaw !== undefined && !isProposalStatus(statusFilterRaw)) {
        sendApiError(res, 400, "Invalid status filter.");
        return;
      }
      const statusFilter = isProposalStatus(statusFilterRaw) ? statusFilterRaw : undefined;
      const { proposals, undecodable } = await listMyProposals(writer.id, statusFilter);
      const response: ListProposalsResponse = { proposals, undecodable };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/proposals/degraded — List degraded (quarantined) proposals only.
  // Registered BEFORE /proposals/:id so the literal path is not captured by the
  // :id param route. Scans only the degradable statuses (never full history).
  router.get("/proposals/degraded", async (req, res, next) => {
    try {
      if (refuseScopedWriter(resolveAuthenticatedWriter(req), res)) return;
      const response = await listDegradedProposalsUseCase();
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/proposals/:id — Read proposal
  router.get("/proposals/:id", async (req, res, next) => {
    try {
      const dto = await readProposalDto(req.params.id);
      const scope = resolveAuthenticatedWriter(req)?.scope;
      if (scope) {
        const claimedDocPaths = new Set<string>([
          ...dto.targets.map(proposalTargetDocPathForDisplay),
          ...dto.sections.map(proposalSectionDocPathForDisplay),
        ]);
        if (!claimedDocPaths.has(scope.docPath)) {
          sendApiError(res, 403, "This action is not available to shared-link sessions.");
          return;
        }
      }
      const response: ReadProposalResponse = { proposal: dto };
      res.json(response);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // PUT /api/proposals/:id — Update the proposal MANIFEST (intent + target scope)
  // ONLY. Staged section content is written through PUT /api/proposals/:id/sections
  // (bulk) and PUT /api/proposals/:id/documents/:docPath/sections (per-document).
  router.put("/proposals/:id", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const parsed = UpdateProposalManifestRequest.parse(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, parsed.message);
        return;
      }
      const body = parsed.value;
      const result = await modifyProposalUseCase(req.params.id, writer, body);
      if (!result.ok) {
        sendApiError(res, result.status, result.message);
        return;
      }

      // If the proposal no longer targets some docs, clear stale doc-local indicators there.
      emitProposalWithdrawnEventsByDoc(onWsEvent, result.updated.id, result.removedTargets);

      if (result.eventStatus === "inprogress") {
        emitProposalInProgressEventsByDoc(onWsEvent, result.updated.id, writer, result.intent, result.eventTargets);
      } else {
        emitProposalDraftEventsByDoc(onWsEvent, result.updated.id, writer, result.intent, result.eventTargets);
      }

      if (result.isHuman) {
        res.json({ proposal: result.updated, sections: [] });
        return;
      }
      res.json({ proposal: result.updated });
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

  // GET /api/proposals/:id/sections — bulk read of the effective proposal-scoped
  // section list + content for every document the proposal targets.
  router.get("/proposals/:id/sections", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      try {
        await verifyProposalForRead(req.params.id, writer.id);
      } catch (error) {
        if (error instanceof SectionsReadForbiddenError) {
          sendApiError(res, 403, error.message);
          return;
        }
        throw error;
      }

      const { documents } = await readProposalAllSections(req.params.id);
      const response: GetProposalSectionsResponse = { proposal_id: req.params.id, documents };
      res.json(response);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error);
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

  // GET /api/proposals/:id/documents/:docPath/sections — effective proposal-scoped
  // section list + content for a single document (proposal-content-first with
  // canonical fallback).
  router.get("/proposals/:id/documents/:docPath(*)/sections", async (req, res, next) => {
    try {
      const docPath = docPathParamOf(req);
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;

      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      try {
        await verifyProposalForRead(req.params.id, writer.id);
      } catch (error) {
        if (error instanceof SectionsReadForbiddenError) {
          sendApiError(res, 403, error.message);
          return;
        }
        throw error;
      }

      const { response, headingPaths } = await readProposalSectionList(req.params.id, docPath);
      broadcastAgentReading(req, docPath, headingPaths, onWsEvent);

      const out: GetDocumentSectionsResponse = response;
      res.json(out);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error);
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

  // PUT /api/proposals/:id/sections — bulk staged-content partial upsert across docs (omitted entries are untouched).
  router.put("/proposals/:id/sections", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const parsed = UpsertProposalSectionsRequest.parse(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, parsed.message);
        return;
      }
      const result = await upsertProposalSectionsUseCase(req.params.id, writer, parsed.value);
      if (!result.ok) {
        sendApiError(res, result.status, result.message);
        return;
      }
      res.json({ proposal: result.proposal });
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

  // PUT /api/proposals/:id/documents/:docPath/sections — per-document staged write.
  router.put("/proposals/:id/documents/:docPath(*)/sections", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const parsed = WriteProposalDocumentSectionsRequest.parse(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, parsed.message);
        return;
      }
      const result = await writeProposalDocumentSectionsUseCase(
        req.params.id,
        writer,
        docPathParamOf(req),
        parsed.value,
      );
      if (!result.ok) {
        sendApiError(res, result.status, result.message);
        return;
      }
      res.json({ proposal: result.proposal });
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

  // POST /api/proposals/:id/acquire-locks — Transition draft → inprogress
  router.post("/proposals/:id/acquire-locks", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const result = await acquireLocksUseCase(req.params.id, writer.id);
      if (result.kind === "error") {
        sendApiError(res, result.status, result.message);
        return;
      }
      if (result.kind === "not_acquired") {
        const response: AcquireLocksResponse = {
          proposal_id: result.proposalId,
          acquired: false,
          message: result.message,
          conflicts: result.conflicts,
        };
        res.json(response);
        return;
      }

      const acquiredProposal = result.acquiredProposal;
      if (acquiredProposal) {
        emitProposalInProgressEventsByDoc(
          onWsEvent,
          acquiredProposal.id,
          acquiredProposal.writer,
          acquiredProposal.intent,
          acquiredProposal.targets,
        );
        for (const [docPath, headingPaths] of groupSectionsByDocPath(
          acquiredProposal.sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
        )) {
          await emitSectionBlockState(onWsEvent, docPath, headingPaths, "section:blocked");
          await refreshLiveSectionsState(docPath);
        }
      }

      const response: AcquireLocksResponse = {
        proposal_id: result.proposalId,
        acquired: true,
        status: "inprogress",
      };
      res.json(response);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        sendApiError(res, 404, error.message);
        return;
      }
      if (error instanceof InvalidProposalStateError) {
        sendApiError(res, 409, error.message);
        return;
      }
      next(error);
    }
  });

  // POST /api/proposals/:id/commit — Commit a proposal
  router.post("/proposals/:id/commit", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const result = await commitProposalUseCase(
        req.params.id,
        writer,
        (docPath) => checkWritePermission(writer, docPath),
      );

      if (result.kind === "error") {
        sendApiError(res, result.status, result.message);
        return;
      }
      if (result.kind === "blocked") {
        const response: CommitProposalResponse = {
          proposal_id: result.proposalId,
          status: "draft",
          outcome: "blocked",
          message: result.agentWritePolicy.message,
          agentWritePolicy: result.agentWritePolicy,
        };
        res.json(response);
        return;
      }

      emitContentCommittedEventsByDoc(onWsEvent, writer, [writer.id], result.committedHead, result.targets);

      for (const [docPath, headingPaths] of groupSectionsByDocPath(result.sections)) {
        await emitSectionBlockState(onWsEvent, docPath, headingPaths, "section:unblocked");
        await refreshLiveSectionsState(docPath);
      }

      const response: CommitProposalResponse = {
        proposal_id: result.proposalId,
        status: "committed",
        outcome: "accepted",
        committed_head: result.committedHead,
        agentWritePolicy: result.agentWritePolicy,
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

  // POST /api/proposals/:id/cancel — Withdraw a proposal
  router.post("/proposals/:id/cancel", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const reason = req.body?.reason as string | undefined;
      const result = await cancelProposalUseCase(req.params.id, writer.id, reason);
      if (result.kind === "error") {
        sendApiError(res, result.status, result.message);
        return;
      }

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
}
