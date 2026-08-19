import { type NextFunction, type Request, type Response, type Router } from "express";
import type { HumanInvolvementPolicyResult } from "../../types/shared.js";
import { DocPath } from "../../types/shared.js";
import { getSystemState } from "../../startup-state.js";
import {
  resolveAuthenticatedWriter,
  isSingleUserMode,
  requireAdmin,
  type AuthenticatedWriter,
} from "../../auth/context.js";
import { checkDocPermission } from "../../auth/acl.js";
import { getMCPPublicURL } from "../../auth/oauth-config.js";
import { ProposalLockConflictError } from "../../domain/proposal-fsm-locks.js";
import { CommitPermissionError } from "../../storage/commit-pipeline.js";
import { PermissionError, authorizeDocRead, type AuthorizedDocRead } from "../../auth/authorized-read.js";

// Re-exports of auth gating consumed by HTTP-only route modules (which may not
// import auth/* directly). middleware.ts is the single auth-aware seam.
export { resolveAuthenticatedWriter, requireAdmin, getMCPPublicURL };
export type { AuthenticatedWriter };

/** Per-document write permission check (no response side-effects). */
export async function checkWritePermission(
  writer: AuthenticatedWriter | null,
  docPath: string,
): Promise<boolean> {
  return checkDocPermission(writer, docPath, "write");
}

// ─── Shared HTTP helpers ────────────────────────────────

export function sendApiError(res: Response, status: number, messageOrError: string | Error, details?: unknown): void {
  // Per error policy: NEVER hide or strip error details. Always include the
  // full stack trace when available.
  const message = messageOrError instanceof Error
    ? (messageOrError.stack || messageOrError.message)
    : messageOrError;
  res.status(status).json({ message, ...(details !== undefined ? { details } : {}) });
}

export function requireAuthenticatedWriter(req: Request, res: Response): AuthenticatedWriter | null {
  const writer = resolveAuthenticatedWriter(req);
  if (!writer) {
    sendApiError(res, 401, "Authentication required.");
    return null;
  }
  return writer;
}

/**
 * Check per-document read permission. Returns the writer (or null for public docs).
 * Sends 401 if unauthenticated and doc requires auth, 403 if authenticated but
 * lacking the required role. Returns null and sends the error response in both cases.
 */
export async function requireDocReadPermission(
  req: Request,
  res: Response,
  docPath: DocPath,
): Promise<AuthorizedDocRead | null> {
  const writer = resolveAuthenticatedWriter(req);
  try {
    return await authorizeDocRead(writer, docPath);
  } catch (error) {
    if (error instanceof PermissionError) {
      if (!writer) {
        sendApiError(res, 401, "Authentication required.");
      } else {
        sendApiError(res, 403, "You do not have permission to read this document.");
      }
      return null;
    }
    throw error;
  }
}

/**
 * Check per-document write permission. Returns the writer on success.
 * Sends 401 if unauthenticated, 403 if lacking the required role.
 */
export async function requireDocWritePermission(
  req: Request,
  res: Response,
  docPath: string,
): Promise<AuthenticatedWriter | null> {
  const writer = resolveAuthenticatedWriter(req);
  if (!writer) {
    sendApiError(res, 401, "Authentication required.");
    return null;
  }
  const allowed = await checkDocPermission(writer, docPath, "write");
  if (!allowed) {
    sendApiError(res, 403, "You do not have permission to write to this document.");
    return null;
  }
  return writer;
}

// ─── Request-pipeline middleware installers ─────────────

export function docPathParamOf(req: Request): DocPath {
  return DocPath.parse(req.params.docPath);
}

export function installSlashStrippedDocPathParamParser(router: Router): void {
  router.param("docPath", (req, _res, next, slashStrippedSegment) => {
    req.params.docPath = DocPath.fromSlashStrippedUrlSegment(slashStrippedSegment);
    next();
  });
}

/**
 * Lifecycle gate: reject requests while the system is not ready.
 * Exempt: /build-info, /auth/* (login page needs to load).
 *
 * Two distinct not-ready answers: `system_starting` (ordinary startup /
 * lockdown — retryable) and `system_fatal` (the durable fatal latch — carries
 * the retained report; clears only when the operator deletes fatal.json and
 * restarts).
 */
export function installStartupGate(router: Router): void {
  router.use((req: Request, res: Response, next: NextFunction) => {
    const lifecycle = getSystemState();
    if (lifecycle.state === "ready") {
      next();
      return;
    }
    const p = req.path;
    if (p === "/build-info" || p.startsWith("/auth/")) {
      next();
      return;
    }
    if (lifecycle.state === "fatal" && lifecycle.fatal) {
      res.status(503).json({
        error: "system_fatal",
        message: lifecycle.fatal.message,
        fatal: lifecycle.fatal,
      });
      return;
    }
    res.status(503)
      .setHeader("Retry-After", "5")
      .json({
        error: "system_starting",
        message: "The system is starting up. Please try again shortly.",
      });
  });
}

/**
 * Global auth middleware (opt-OUT via skip list).
 * Every route is auth-protected by default. Exempt paths must be listed explicitly.
 * Routes that handle their own auth (e.g. public-doc exception) are also exempt here.
 */
export function installGlobalAuth(router: Router): void {
  router.use((req: Request, res: Response, next: NextFunction) => {
    const p = req.path;
    // Always exempt: auth endpoints, build-info
    if (p === "/build-info" || p.startsWith("/auth/")) {
      next();
      return;
    }
    // In single_user mode, all routes are accessible without auth
    if (isSingleUserMode()) {
      next();
      return;
    }
    const writer = resolveAuthenticatedWriter(req);
    if (writer) {
      next();
      return;
    }
    // Unauthenticated: allow through to the per-document GET read surfaces
    // (canonical committed reads + workspace working-copy reads) so a PUBLIC doc
    // can be read without logging in. Each handler still enforces the per-document
    // read ACL via requireDocReadPermission (non-public docs are 401/403'd there).
    // The catalog `tree` stays excluded exactly as `/documents/tree` was.
    if (
      req.method === "GET" &&
      (p.startsWith("/canonical/") || (p.startsWith("/workspace/") && p !== "/workspace/tree"))
    ) {
      next();
      return;
    }
    sendApiError(res, 401, "Authentication required.");
  });
}

/**
 * CSRF protection: require X-Requested-With header on state-changing requests.
 * Runs AFTER auth middleware — unauthenticated requests get 401, not 403.
 * Requests with a Bearer token are exempt — CSRF exploits cookie-based auth, not header-based.
 */
export function installCsrfGuard(router: Router): void {
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const p = req.path;
    if (p.startsWith("/auth/")) {
      next();
      return;
    }
    if (req.headers.authorization?.startsWith("Bearer ")) {
      next();
      return;
    }
    if (!req.headers["x-requested-with"]) {
      sendApiError(res, 403, "Missing X-Requested-With header.");
      return;
    }
    next();
  });
}

/**
 * Shape an agent-write-policy result into a REST response body. Surfaces the
 * policy's prose `message`s (top-level + per-target) rather than bare codes.
 */
export function agentWritePolicyRouteBody(result: HumanInvolvementPolicyResult) {
  return {
    can_write: result.canWrite,
    message: result.message,
    targets: result.targets.map((t) => ({
      kind: t.target.kind,
      doc_path: t.target.doc_path,
      heading_path: t.target.kind === "section" ? t.target.heading_path : undefined,
      can_write: t.canWrite,
      message: t.message,
    })),
  };
}

/**
 * Final error-handling Express middleware. Installed LAST by assembly.
 *
 * A `ProposalLockConflictError` (raised by the mandatory commit-boundary FSM lock
 * gate, spec 12) is a CONFLICT, not a server fault: it is surfaced as 409 with the
 * top-level prose `message` AND the full structured `conflicts[]` (each carrying
 * the blocking proposal id/status/writer + prose), never collapsed into a bare
 * code or a generic 500.
 */
export function installErrorHandler(router: Router): void {
  router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ProposalLockConflictError) {
      sendApiError(res, 409, error.result.message, { conflicts: error.result.conflicts });
      return;
    }
    if (error instanceof CommitPermissionError) {
      sendApiError(res, 403, error.message);
      return;
    }
    if (error instanceof PermissionError) {
      sendApiError(res, error.writerWasAnonymous ? 401 : 403, error.message);
      return;
    }
    sendApiError(res, 500, error.stack || error.message);
  });
}
