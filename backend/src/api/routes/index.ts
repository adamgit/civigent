import express from "express";
import type { WsServerEvent } from "../../types/shared.js";
import {
  installSlashStrippedDocPathParamParser,
  installStartupGate,
  installGlobalAuth,
  installCsrfGuard,
  installErrorHandler,
} from "./middleware.js";
import { registerAuthRoutes } from "./auth.js";
import { registerCanonicalRoutes, registerCanonicalCatchAllRoutes } from "./canonical.js";
import { registerWorkspaceRoutes, registerWorkspaceCatchAllRoutes } from "./workspace.js";
import { registerSectionRoutes } from "./sections.js";
import { registerProposalRoutes } from "./proposals.js";
import { registerImportRoutes } from "./imports.js";
import { registerAdminRoutes } from "./admin.js";
import { registerGitRoutes } from "./git.js";
import { registerSearchRoutes } from "./search.js";
import { registerExportRoutes } from "./export.js";

// ─── Router Options ─────────────────────────────────────

export interface CreateApiRouterOptions {
  onWsEvent?: (event: WsServerEvent) => void;
}

// ─── Router assembly ────────────────────────────────────
//
// This file is route ASSEMBLY ONLY: it creates the router, installs the
// request-pipeline middleware in order, mounts the HTTP-only route modules,
// installs the error handler last, and returns the router. All handler
// behaviour lives in `routes/*.ts` (HTTP) + `application/*.ts` (use cases).
// It must not import storage/crdt/domain/mcp/diagnostics.

export function createApiRouter(options?: CreateApiRouterOptions): express.Router {
  const router = express.Router();
  const onWsEvent = options?.onWsEvent;

  // Request pipeline (order matters): docPath parser → startup gate →
  // global auth → CSRF guard.
  installSlashStrippedDocPathParamParser(router);
  installStartupGate(router);
  installGlobalAuth(router);
  installCsrfGuard(router);

  // Route modules.
  registerAuthRoutes(router);
  registerCanonicalRoutes(router, onWsEvent);
  registerWorkspaceRoutes(router, onWsEvent);
  registerSectionRoutes(router, onWsEvent);
  registerSearchRoutes(router);
  registerProposalRoutes(router, onWsEvent);
  registerImportRoutes(router, onWsEvent);
  registerExportRoutes(router);
  registerAdminRoutes(router);
  registerGitRoutes(router);

  // Catch-all (`:docPath(*)`) routes MUST register last so they never shadow the
  // more-specific /canonical/ and /workspace/ routes.
  registerCanonicalCatchAllRoutes(router, onWsEvent);
  registerWorkspaceCatchAllRoutes(router, onWsEvent);

  // Error handler installed last.
  installErrorHandler(router);

  return router;
}
