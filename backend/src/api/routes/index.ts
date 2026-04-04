import express, { type NextFunction, type Request, type Response } from "express";
import { isSystemReady } from "../../startup-state.js";
import type {
  AdminConfig,
  ChangesSinceResponse,
  CreateProposalRequest,
  CreateProposalResponse,
  CommitProposalResponse,
  WithdrawProposalResponse,
  UpdateProposalRequest,
  GetActivityResponse,
  GetAdminSnapshotHealthResponse,
  GetAdminSnapshotHistoryResponse,
  GetDocumentResponse,
  GetDocumentSectionsResponse,
  GetDocumentsTreeResponse,
  GetHeatmapResponse,
  HeatmapEntry,
  ListProposalsResponse,
  PublishRequest,
  PublishResponse,
  SessionInfoResponse,
  ReadDocStructureResponse,
  ReadProposalResponse,
  ReadSectionResponse,
  WriterDirtyState,
  WsServerEvent,
  SectionMeta,
  HumanInvolvementPresetName,
  SectionScoreSnapshot,
  ProposalDTO,
} from "../../types/shared.js";
import { HUMAN_INVOLVEMENT_PRESETS } from "../../types/shared.js";
import path from "node:path";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { assertDataRootExists, getContentRoot, getDataRoot, getSessionDocsContentRoot, getSessionAuthorsRoot } from "../../storage/data-root.js";
import { ContentLayer, OverlayContentLayer } from "../../storage/content-layer.js";
import { buildSectionInvolvementMeta, broadcastAgentReading } from "../helpers/section-meta-builder.js";

import { getSessionState } from "../../storage/session-inspector.js";
import { getHeadSha, gitLogRecent, gitDiffForCommit, isValidSha } from "../../storage/git-repo.js";
import { readAssembledDocument, DocumentAssemblyError, DocumentNotFoundError, prependHeadings } from "../../storage/document-reader.js";
import { InvalidDocPathError, resolveDocPathUnderContent } from "../../storage/path-utils.js";
import { readActivity, readChangesSince } from "../../storage/activity-reader.js";
import {
  createProposal,
  createTransientProposal,
  readProposal,
  readProposalWithContent,
  listProposals,
  findDraftProposalByWriter,
  updateProposalSections,
  transitionToWithdrawn,
  ProposalNotFoundError,
  InvalidProposalStateError,
} from "../../storage/proposal-repository.js";
import { readSection, readSectionWithHeading, SectionNotFoundError } from "../../storage/section-reader.js";
import { readDocumentStructure, readDocumentStructureWithOverlay, flattenStructureToHeadingPaths, HeadingNotFoundError, resolveAllSectionPaths } from "../../storage/heading-resolver.js";
import {
  evaluateProposalHumanInvolvement,
  commitProposalToCanonical,
} from "../../storage/commit-pipeline.js";
import {
  getSessionsForWriter,
  lookupDocSession,
  countEditorSockets,
  invalidateSessionForRestore,
} from "../../crdt/ydoc-lifecycle.js";
import { preemptiveFlushAndCommit } from "../../storage/auto-commit.js";
import { SectionGuard } from "../../domain/section-guard.js";
import { readDocSectionCommitInfo, type SectionCommitInfo } from "../../storage/section-activity.js";
import { SectionPresence } from "../../domain/section-presence.js";
import {
  readDocumentsTree,
  DocumentsTreePathNotFoundError,
  InvalidDocumentsTreePathError,
} from "../../storage/documents-tree.js";
import { resolveAuthenticatedWriter, requireAdmin, isSingleUserMode, type AuthenticatedWriter } from "../../auth/context.js";
import {
  getDocReadPermission,
  checkDocPermission,
  getAclSnapshot,
  updateDefaults,
  setDocAcl,
  removeDocAcl,
  setUserRoles,
  removeUserRoles,
  listCustomRoles,
  addCustomRole,
  deleteCustomRole,
} from "../../auth/acl.js";
import { listAuthMethods, buildOidcIdentity, isBootstrapAvailable, redeemBootstrapCode } from "../../auth/service.js";
import { issueTokenPair } from "../../auth/tokens.js";
import { isOidcConfigured, getOidcDisplayName, getOidcPublicUrl } from "../../auth/oauth-config.js";
import { generateOidcState, generateOidcNonce, storeOidcState, retrieveAndClearOidcState } from "../../auth/oidc-state.js";
import { buildOidcRedirectUrl, redeemOidcCode } from "../../auth/oidc-provider.js";
import type { AuthMethod } from "../../types/shared.js";
import { readAgentKeysAndErrors, readAgentKeysSkipErrors, addAgentKey, removeAgentKey } from "../../auth/agent-keys.js";
import { getSnapshotHealth, getSnapshotHistory, snapshotAllDocs } from "../../storage/snapshot.js";
import {
  AdminConfigValidationError,
  getAdminConfig,
  updateAdminConfig,
} from "../../admin-config.js";
import { commitDirtySections } from "../../storage/auto-commit.js";
import { SECTIONS_DIR_SUFFIX } from "../../storage/document-skeleton.js";
import { SectionRef } from "../../domain/section-ref.js";
import {
  createStagingFolder,
  listStagingFolders,
  scanStagingFolder,
  readStagingFiles,
  deleteStagingFolder,
  getImportStagingRoot,
} from "../../storage/import-staging.js";
import { importFilesToProposal } from "../../storage/import-service.js";

const BUILD_INFO_FILE_URL = new URL("../../../build-info.json", import.meta.url);


// ─── Helpers ────────────────────────────────────────────

/**
 * Sanitize a return_to URL to prevent open redirect attacks.
 * Uses URL parser (OWASP-recommended) instead of string prefix checks.
 */
export function sanitizeReturnTo(raw: string): string {
  if (!raw || typeof raw !== "string") return "/";
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "");
  try {
    const parsed = new URL(cleaned, "http://localhost");
    if (parsed.hostname !== "localhost") return "/";
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return "/";
  }
}

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

function parseMultipartUploadFiles(
  body: Buffer,
  boundary: string,
): Array<{ name: string; content: string }> {
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

function sendApiError(res: Response, status: number, messageOrError: string | Error, details?: unknown): void {
  // Per error policy: NEVER hide or strip error details. Always include the
  // full stack trace when available.
  const message = messageOrError instanceof Error
    ? (messageOrError.stack || messageOrError.message)
    : messageOrError;
  res.status(status).json({ message, ...(details !== undefined ? { details } : {}) });
}

function authCookieAttributes(req: Request): { secure: boolean } {
  const forwarded = String(req.headers.forwarded ?? "");
  const forwardedProtoMatch = /proto=([^;,\s]+)/i.exec(forwarded);
  const forwardedProto = (forwardedProtoMatch?.[1] ?? "").toLowerCase();
  const secure = req.secure || forwardedProto === "https";
  return { secure };
}

function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
): void {
  const { secure } = authCookieAttributes(req);
  const secureFlag = secure ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `ks_access_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=1800`,
  );
  res.append(
    "Set-Cookie",
    `ks_refresh_token=${encodeURIComponent(refreshToken)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=2592000`,
  );
}

function clearAuthCookies(req: Request, res: Response): void {
  const { secure } = authCookieAttributes(req);
  const secureFlag = secure ? "; Secure" : "";
  res.append("Set-Cookie", `ks_access_token=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`);
  res.append("Set-Cookie", `ks_refresh_token=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`);
}

function requireAuthenticatedWriter(req: Request, res: Response): AuthenticatedWriter | null {
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
async function requireDocReadPermission(
  req: Request,
  res: Response,
  docPath: string,
): Promise<AuthenticatedWriter | "public" | null> {
  const writer = resolveAuthenticatedWriter(req);
  const allowed = await checkDocPermission(writer, docPath, "read");
  if (allowed) return writer ?? "public";
  if (!writer) {
    sendApiError(res, 401, "Authentication required.");
  } else {
    sendApiError(res, 403, "You do not have permission to read this document.");
  }
  return null;
}

/**
 * Check per-document write permission. Returns the writer on success.
 * Sends 401 if unauthenticated, 403 if lacking the required role.
 */
async function requireDocWritePermission(
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

const SECTION_LENGTH_WARNING_THRESHOLD = 2000; // words

function computeSectionLengthWarning(content: string): boolean {
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  return wordCount > SECTION_LENGTH_WARNING_THRESHOLD;
}

function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}

async function filterTreeToPublic(entries: import("../../types/shared.js").DocumentTreeEntry[]): Promise<import("../../types/shared.js").DocumentTreeEntry[]> {
  const result: import("../../types/shared.js").DocumentTreeEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "file") {
      const perm = await getDocReadPermission(entry.path);
      if (perm === "public") {
        result.push(entry);
      }
    } else {
      // directory: recurse and include only if it has public children
      const children = await filterTreeToPublic(entry.children ?? []);
      if (children.length > 0) {
        result.push({ ...entry, children });
      }
    }
  }
  return result;
}

// ─── Router Options ─────────────────────────────────────

export interface CreateApiRouterOptions {
  onWsEvent?: (event: WsServerEvent) => void;
}

// ─── Router ─────────────────────────────────────────────

export function createApiRouter(options?: CreateApiRouterOptions): express.Router {
  const router = express.Router();
  const onWsEvent = options?.onWsEvent;

  // Restore leading slash that Express strips from :docPath(*) params
  router.param("docPath", (req, _res, next, value) => {
    req.params.docPath = "/" + value;
    next();
  });

  // ─── Startup gate: reject requests during crash recovery ────
  // Exempt: /build-info, /auth/* (login page needs to load)
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (isSystemReady()) {
      next();
      return;
    }
    const p = req.path;
    if (p === "/build-info" || p.startsWith("/auth/")) {
      next();
      return;
    }
    res.status(503)
      .setHeader("Retry-After", "5")
      .json({
        error: "system_starting",
        message: "The system is starting up. Please try again shortly.",
      });
  });

  // ─── Global auth middleware (opt-OUT via skip list) ────
  // Every route is auth-protected by default. Exempt paths must be listed explicitly.
  // Routes that handle their own auth (e.g. public-doc exception) are also exempt here.
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
    // Unauthenticated: allow through to all document GET routes (each handler
    // checks per-document read permission via requireDocReadPermission)
    if (req.method === "GET" && p.startsWith("/documents/") && p !== "/documents/tree") {
      next();
      return;
    }
    sendApiError(res, 401, "Authentication required.");
  });

  // ─── CSRF protection: require X-Requested-With header on state-changing requests ──
  // Runs AFTER auth middleware — unauthenticated requests get 401, not 403.
  // Requests with a Bearer token are exempt — CSRF exploits cookie-based auth, not header-based.
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

  router.get("/build-info", async (_req, res, next) => {
    try {
      const raw = await readFile(BUILD_INFO_FILE_URL, "utf8");
      const parsed = JSON.parse(raw);
      const version = typeof parsed?.version === "string" ? parsed.version : null;
      const sha = typeof parsed?.sha === "string" ? parsed.sha : null;
      const date = typeof parsed?.date === "string" ? parsed.date : null;
      if (!version || !sha || !date) {
        sendApiError(res, 500, "build-info.json is malformed. Expected { version, sha, date } strings.");
        return;
      }
      res.status(200).json({ version, sha, date });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        sendApiError(res, 404, "build-info.json is not available on this server.");
        return;
      }
      next(error);
    }
  });

  // ─── Auth ─────────────────────────────────────────────

  router.get("/auth/methods", async (_req, res, next) => {
    try {
      const rawMethods = listAuthMethods();
      const methods: AuthMethod[] = rawMethods.map((m) => {
        if (m === "oidc") {
          return { type: "oidc", displayName: getOidcDisplayName(), authUrl: "/api/auth/oidc/authorize" };
        }
        return { type: "single_user", displayName: "Single-user session" };
      });
      res.json({ methods, bootstrap_available: isBootstrapAvailable() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/oidc/authorize", async (req, res, next) => {
    try {
      if (!isOidcConfigured()) {
        sendApiError(res, 503, "OIDC is not configured on this server.");
        return;
      }
      const returnTo = sanitizeReturnTo((req.query.return_to as string) ?? "");

      const state = generateOidcState();
      const nonce = generateOidcNonce();
      storeOidcState(state, nonce, returnTo);

      let url: string;
      try {
        url = await buildOidcRedirectUrl(state, nonce);
      } catch (err) {
        sendApiError(res, 503, err instanceof Error ? err : String(err));
        return;
      }
      res.redirect(302, url);
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/oidc/callback", async (req, res, next) => {
    try {
      const { code, state } = req.query;
      if (!code || !state) {
        sendApiError(res, 400, "Missing code or state in OIDC callback.");
        return;
      }

      const stored = retrieveAndClearOidcState(String(state));
      if (!stored) {
        sendApiError(res, 400, "OIDC state expired or invalid.");
        return;
      }

      const callbackUrl = new URL(req.originalUrl, getOidcPublicUrl());
      let claims: { issuer: string; subject: string; email?: string; name?: string };
      try {
        claims = await redeemOidcCode(callbackUrl, String(state), stored.nonce);
      } catch (err) {
        sendApiError(res, 401, err instanceof Error ? err : String(err));
        return;
      }

      const identity = buildOidcIdentity(claims.issuer, claims.subject, claims.email, claims.name);
      const { access_token, refresh_token } = issueTokenPair(identity);
      setAuthCookies(req, res, access_token, refresh_token);
      res.redirect(302, stored.returnTo);
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/session", (req, res) => {
    const writer = resolveAuthenticatedWriter(req);
    const response: SessionInfoResponse = writer
      ? {
          authenticated: true,
          user: {
            id: writer.id,
            type: writer.type,
            displayName: writer.displayName,
            email: writer.email,
          },
        }
      : { authenticated: false };
    res.json(response);
  });

  // POST /auth/agent/register removed — replaced by POST /oauth/register (OAuth 2.1 DCR)

  router.post("/auth/bootstrap", async (req, res, next) => {
    try {
      const writer = resolveAuthenticatedWriter(req);
      if (!writer) {
        sendApiError(res, 401, "You must be authenticated (via OIDC) before using the bootstrap code.");
        return;
      }
      const { code } = req.body ?? {};
      if (!code) {
        sendApiError(res, 400, "Bootstrap code is required.");
        return;
      }
      await redeemBootstrapCode(String(code), writer.id);
      res.json({ success: true, message: "Admin role granted." });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid bootstrap code")) {
        sendApiError(res, 403, error.message);
        return;
      }
      if (error instanceof Error && error.message.includes("not available")) {
        sendApiError(res, 410, error.message);
        return;
      }
      next(error);
    }
  });

  // POST /auth/token/refresh removed — replaced by POST /oauth/token with grant_type=refresh_token

  router.post("/auth/logout", (req, res) => {
    clearAuthCookies(req, res);
    res.json({ success: true });
  });

  // ─── Documents ────────────────────────────────────────

  router.get("/documents/tree", async (req, res, next) => {
    try {
      const writer = resolveAuthenticatedWriter(req);
      const basePath = (req.query.path as string) ?? "";
      const tree = await readDocumentsTree(basePath);

      // Unauthenticated callers only see documents with public read permission
      let filteredTree = tree;
      if (!writer) {
        filteredTree = await filterTreeToPublic(tree);
      }

      const response: GetDocumentsTreeResponse = { tree: filteredTree };
      res.json(response);
    } catch (error) {
      if (error instanceof DocumentsTreePathNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      if (error instanceof InvalidDocumentsTreePathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  router.get("/documents/:docPath(*)/structure", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const sessionDocsContentRoot = getSessionDocsContentRoot();
      const structure = await readDocumentStructureWithOverlay(docPath, sessionDocsContentRoot);

      broadcastAgentReading(req, docPath, flattenStructureToHeadingPaths(structure), onWsEvent);

      const response: ReadDocStructureResponse = { doc_path: docPath, structure };
      res.json(response);
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  router.get("/documents/:docPath(*)/sections", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const overlay = new OverlayContentLayer(getSessionDocsContentRoot(), getContentRoot());
      const sectionList = await overlay.getSectionList(docPath);

      // Build headingPaths and sectionFileByKey from the section list
      const headingPaths: string[][] = sectionList.map(s => s.headingPath);
      const sectionFileByKey = new Map<string, string>(
        sectionList.map(s => [SectionRef.headingKey(s.headingPath), s.sectionFile]),
      );

      // ── Batch pre-fetch: all I/O happens here, loop below is pure compute ──
      const liveSession = lookupDocSession(docPath);
      const sectionsOverlayRoot = getSessionDocsContentRoot();
      const sectionsOverlay = new OverlayContentLayer(sectionsOverlayRoot, getContentRoot());
      const bulkContent = prependHeadings(sectionList, await sectionsOverlay.readAllSections(docPath));

      // Overlay live content from Y.Doc where available
      if (liveSession) {
        for (const [key, live] of liveSession.fragments.readAllLiveContent()) {
          bulkContent.set(key, live);
        }
      }

      // 2. Involvement metadata via shared helper
      const involvementMeta = await buildSectionInvolvementMeta(docPath, headingPaths, bulkContent);

      // Build sections response
      const sections: GetDocumentSectionsResponse["sections"] = [];
      for (const headingPath of headingPaths) {
        const headingKey = SectionRef.headingKey(headingPath);
        const content = bulkContent.get(headingKey) ?? "";
        const meta = involvementMeta.get(headingKey);
        if (!meta) continue;

        sections.push({
          heading: headingPath[headingPath.length - 1] ?? "",
          heading_path: headingPath,
          depth: headingPath.length,
          content,
          humanInvolvement_score: meta.humanInvolvement_score,
          crdt_session_active: meta.crdt_session_active,
          section_length_warning: meta.section_length_warning,
          word_count: meta.word_count,
          section_file: sectionFileByKey.get(headingKey) ?? "",
          last_editor: meta.last_editor,
        });
      }

      broadcastAgentReading(req, docPath, headingPaths, onWsEvent);

      const response: GetDocumentSectionsResponse = { doc_path: docPath, sections };
      res.json(response);
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

  router.get("/documents/:docPath(*)/changes-since", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const afterHead = req.query.after_head as string | undefined;
      const result = await readChangesSince(docPath, afterHead);
      res.json(result);
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // ─── Document version history & restore ─────────────────
  // MUST be registered BEFORE the catch-all GET /documents/:docPath(*) below,
  // otherwise Express matches the catch-all first.

  router.get("/documents/:docPath(*)/history", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const dataRoot = getDataRoot();
      const entries = await gitLogRecent(dataRoot, { limit, offset, docPath });
      res.json({ doc_path: docPath, versions: entries });
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:docPath(*)/history/:sha/preview", async (req, res, next) => {
    try {
      const { docPath, sha } = req.params;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;
      if (!isValidSha(sha)) {
        sendApiError(res, 400, new Error(`Invalid SHA format: "${sha}"`));
        return;
      }

      const { assembleDocumentAtCommit } = await import("../../storage/git-repo.js");
      const dataRoot = getDataRoot();

      const { content, missingSections } = await assembleDocumentAtCommit(dataRoot, sha, docPath);
      if (missingSections.length > 0) {
        res.json({ doc_path: docPath, sha, content, corrupt: true, missingSections });
      } else {
        res.json({ doc_path: docPath, sha, content, corrupt: false, missingSections: [] });
      }
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  router.post("/documents/:docPath(*)/restore", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const { sha } = req.body as { sha?: string };
      if (!sha || !isValidSha(sha)) {
        sendApiError(res, 400, new Error(`Invalid or missing SHA in restore request for "${docPath}". Body: ${JSON.stringify(req.body)}`));
        return;
      }

      // Inherit Writer-Type from the target commit so blame attribution reflects
      // the original author, not who clicked the restore button.
      const { getCommitWriterType } = await import("../../storage/git-repo.js");
      const targetWriterType = await getCommitWriterType(getDataRoot(), sha);
      const restoreWriter = targetWriterType ? { ...writer, type: targetWriterType as typeof writer.type } : writer;

      // Pre-commit any in-progress session before restore replaces canonical content.
      const preCommitResult = await preemptiveFlushAndCommit(docPath);

      const { createRestoreProposal } = await import("../../storage/restore-service.js");
      const { proposal } = await createRestoreProposal(docPath, sha, restoreWriter);

      // Human explicitly requested this restore — commit directly, skip CRDT injection
      // (restore changes the entire skeleton; injectAfterCommit would corrupt the Y.Doc).
      const committedSha = await commitProposalToCanonical(proposal.id, {}, undefined, { skipCrdtInjection: true, restoreTargetSha: sha });

      // Unconditionally clean session overlay so stale skeleton files never shadow restored canonical content.
      const { cleanupSessionFiles } = await import("../../storage/session-store.js");
      await cleanupSessionFiles(docPath);

      // Invalidate live session and notify connected clients.
      await invalidateSessionForRestore(
        docPath,
        committedSha.slice(0, 7),
        writer.displayName,
        preCommitResult,
      );
      res.json({ committed_sha: committedSha });
    } catch (error) {
      next(error);
    }
  });

  // ─── Document Diagnostics (MUST be before catch-all) ─────
  router.get("/documents/:docPath(*)/diagnostics", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const accessResult = await requireDocReadPermission(req, res, docPath);
      if (!accessResult) return;

      const contentRoot = getContentRoot();
      const overlayContentRoot = getSessionDocsContentRoot();
      const { getSessionFragmentsRoot } = await import("../../storage/data-root.js");
      const fragmentsRoot = getSessionFragmentsRoot();
      const { assessSkeleton, assessSectionContent } = await import("../../storage/recovery-layers.js");
      const { resolveSkeletonPath, DocumentSkeleton } = await import("../../storage/document-skeleton.js");
      const { normalizeDocPath } = await import("../../storage/path-utils.js");
      const { fragmentKeyFromSectionFile } = await import("../../crdt/ydoc-fragments.js");

      const normalizedDocPath = normalizeDocPath(docPath);
      const canonicalSkeletonPath = resolveSkeletonPath(docPath, contentRoot);
      const canonicalSectionsDir = canonicalSkeletonPath + ".sections";
      const overlaySkeletonPath = resolveSkeletonPath(docPath, overlayContentRoot);
      const overlaySectionsDir = overlaySkeletonPath + ".sections";
      const fragmentDir = path.resolve(fragmentsRoot, ...normalizedDocPath.split("/"));

      // ── Health checks ──
      type HealthCheck = { name: string; pass: boolean; detail?: string };
      const checks: HealthCheck[] = [];

      let skeletonAssessment: Awaited<ReturnType<typeof assessSkeleton>> | null = null;
      try {
        skeletonAssessment = await assessSkeleton(canonicalSkeletonPath, canonicalSectionsDir);
        checks.push({
          name: "skeleton-parse",
          pass: skeletonAssessment.parsedCleanly,
          detail: skeletonAssessment.parsedCleanly
            ? `${skeletonAssessment.entries.length} entries`
            : skeletonAssessment.parseError?.message,
        });
      } catch (e) {
        checks.push({ name: "skeleton-parse", pass: false, detail: (e as Error).message });
      }

      try {
        const unreferenced = skeletonAssessment?.unreferencedFiles ?? [];
        checks.push({
          name: "no-unreferenced-files",
          pass: unreferenced.length === 0,
          detail: unreferenced.length > 0 ? unreferenced.join(", ") : undefined,
        });
      } catch (e) {
        checks.push({ name: "no-unreferenced-files", pass: false, detail: (e as Error).message });
      }

      try {
        const stale: string[] = [];
        const entries = skeletonAssessment?.entries ?? [];
        for (const entry of entries) {
          const subDir = path.join(canonicalSectionsDir, entry.sectionFile + ".sections");
          let subDirExists = false;
          try { await readdir(subDir); subDirExists = true; } catch { /* no dir */ }
          if (subDirExists) {
            const bodyPath = path.join(canonicalSectionsDir, entry.sectionFile);
            try {
              const content = await readFile(bodyPath, "utf8");
              if (!/\{\{section:\s*[^|}]+?\s*(?:\|[^}]*)?\}\}/.test(content)) {
                stale.push(entry.sectionFile);
              }
            } catch { /* can't read body */ }
          }
        }
        checks.push({
          name: "no-stale-sections-dirs",
          pass: stale.length === 0,
          detail: stale.length > 0 ? stale.join(", ") : undefined,
        });
      } catch (e) {
        checks.push({ name: "no-stale-sections-dirs", pass: false, detail: (e as Error).message });
      }

      try {
        const missing: string[] = [];
        for (const entry of skeletonAssessment?.entries ?? []) {
          try {
            await readFile(path.join(canonicalSectionsDir, entry.sectionFile), "utf8");
          } catch {
            missing.push(entry.sectionFile);
          }
        }
        checks.push({
          name: "all-sections-readable",
          pass: missing.length === 0,
          detail: missing.length > 0 ? missing.join(", ") : undefined,
        });
      } catch (e) {
        checks.push({ name: "all-sections-readable", pass: false, detail: (e as Error).message });
      }

      try {
        const unparseable: string[] = [];
        for (const entry of skeletonAssessment?.entries ?? []) {
          const result = await assessSectionContent(
            path.join(canonicalSectionsDir, entry.sectionFile),
            "canonical",
          );
          if (!result.parseable) unparseable.push(entry.sectionFile);
        }
        checks.push({
          name: "all-sections-parseable",
          pass: unparseable.length === 0,
          detail: unparseable.length > 0 ? unparseable.join(", ") : undefined,
        });
      } catch (e) {
        checks.push({ name: "all-sections-parseable", pass: false, detail: (e as Error).message });
      }

      let overlaySkeletonExists = false;
      try {
        try { await readFile(overlaySkeletonPath, "utf8"); overlaySkeletonExists = true; } catch { /* missing */ }
        checks.push({ name: "overlay-skeleton-exists", pass: overlaySkeletonExists });
      } catch (e) {
        checks.push({ name: "overlay-skeleton-exists", pass: false, detail: (e as Error).message });
      }

      let hasLiveCrdtSession = false;
      try {
        const session = lookupDocSession(docPath);
        hasLiveCrdtSession = !!session;
        checks.push({
          name: "live-crdt-session",
          pass: hasLiveCrdtSession,
          detail: session ? "active session" : undefined,
        });
      } catch (e) {
        checks.push({ name: "live-crdt-session", pass: false, detail: (e as Error).message });
      }

      checks.push({
        name: "overlay-skeleton-orphaned",
        pass: !(overlaySkeletonExists && !hasLiveCrdtSession),
        detail: overlaySkeletonExists && !hasLiveCrdtSession
          ? "Overlay skeleton exists but no active CRDT session — stale file will shadow canonical content"
          : undefined,
      });

      try {
        if (overlaySkeletonExists) {
          const [overlayContent, canonicalContent] = await Promise.all([
            readFile(overlaySkeletonPath, "utf8").catch(() => null),
            readFile(canonicalSkeletonPath, "utf8").catch(() => null),
          ]);
          if (overlayContent !== null && canonicalContent !== null) {
            const match = overlayContent === canonicalContent;
            const overlayAssessment = await assessSkeleton(overlaySkeletonPath, overlaySectionsDir);
            checks.push({
              name: "overlay-canonical-skeleton-match",
              pass: match,
              detail: match
                ? undefined
                : `overlay: ${overlayAssessment.entries.length} entries, canonical: ${skeletonAssessment?.entries.length ?? 0} entries`,
            });
          }
        }
      } catch (e) {
        checks.push({ name: "overlay-canonical-skeleton-match", pass: false, detail: (e as Error).message });
      }

      try {
        const overlayLayer = new OverlayContentLayer(overlayContentRoot, contentRoot);
        await overlayLayer.readAllSections(docPath);
        checks.push({ name: "overlay-read-path", pass: true });
      } catch (e) {
        checks.push({ name: "overlay-read-path", pass: false, detail: (e as Error).message });
      }

      // ── Section layer table ──
      type LayerStatus = { exists: boolean; byteLength: number | null; contentPreview: string | null; error: string | null };
      type SectionLayerInfo = {
        headingKey: string;
        headingPath: string[];
        sectionFile: string;
        canonical: LayerStatus;
        overlay: LayerStatus;
        fragment: LayerStatus;
        crdt: LayerStatus;
        winner: string;
        error?: string;
      };
      const sections: SectionLayerInfo[] = [];

      try {
        const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
        const sectionEntries: Array<{ heading: string; level: number; sectionFile: string; headingPath: string[]; absolutePath: string }> = [];
        skeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
          sectionEntries.push({ heading, level, sectionFile, headingPath: [...headingPath], absolutePath });
        });

        const session = lookupDocSession(docPath);

        for (const entry of sectionEntries) {
          try {
            const headingKey = entry.headingPath.join(">>");
            const isBfh = entry.level === 0 && entry.heading === "";
            const fragKey = fragmentKeyFromSectionFile(entry.sectionFile, isBfh);

            const readLayer = async (filePath: string): Promise<LayerStatus> => {
              try {
                const content = await readFile(filePath, "utf8");
                return { exists: true, byteLength: Buffer.byteLength(content, "utf8"), contentPreview: content.slice(0, 200), error: null };
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                  return { exists: false, byteLength: null, contentPreview: null, error: null };
                }
                return { exists: false, byteLength: null, contentPreview: null, error: (e as Error).message };
              }
            };

            const canonical = await readLayer(entry.absolutePath);
            const overlay = await readLayer(path.join(overlayContentRoot, path.relative(contentRoot, entry.absolutePath)));
            const fragment = await readLayer(path.join(fragmentDir, entry.sectionFile));

            let crdt: LayerStatus = { exists: false, byteLength: null, contentPreview: null, error: null };
            if (session) {
              try {
                const md = session.fragments.readLiveFragment(fragKey);
                if (md != null) {
                  crdt = { exists: true, byteLength: Buffer.byteLength(md, "utf8"), contentPreview: md.slice(0, 200), error: null };
                }
              } catch (e) {
                crdt = { exists: false, byteLength: null, contentPreview: null, error: (e as Error).message };
              }
            }

            // Winner: CRDT > overlay > canonical (matching resolution order)
            let winner = "none";
            if (canonical.exists) winner = "canonical";
            if (overlay.exists) winner = "overlay";
            if (crdt.exists) winner = "crdt";

            sections.push({ headingKey, headingPath: entry.headingPath, sectionFile: entry.sectionFile, canonical, overlay, fragment, crdt, winner });
          } catch (e) {
            sections.push({
              headingKey: entry.headingPath.join(">>"),
              headingPath: entry.headingPath,
              sectionFile: entry.sectionFile,
              canonical: { exists: false, byteLength: null, contentPreview: null, error: null },
              overlay: { exists: false, byteLength: null, contentPreview: null, error: null },
              fragment: { exists: false, byteLength: null, contentPreview: null, error: null },
              crdt: { exists: false, byteLength: null, contentPreview: null, error: null },
              winner: "error",
              error: (e as Error).message,
            });
          }
        }
      } catch (e) {
        // Skeleton couldn't be loaded — sections array stays empty, add a check
        checks.push({ name: "section-layer-collection", pass: false, detail: (e as Error).message });
      }

      res.json({ doc_path: docPath, checks, sections });
    } catch (error) {
      next(error);
    }
  });

  // ─── Git Blame (MUST be before catch-all) ────────────────
  router.get("/documents/:docPath(*)/blame/:sectionFile", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const access = await requireDocReadPermission(req, res, docPath);
      if (!access) return;

      const sectionFile = req.params.sectionFile;

      // Resolve sectionFile → absolute disk path via ContentLayer (handles sub-skeleton nesting)
      const contentRoot = getContentRoot();
      const { absolutePath: sectionFilePath, level, headingPath } = await new ContentLayer(contentRoot).resolveSectionFileId(docPath, sectionFile);

      const { computeSectionBlame } = await import("../../storage/section-blame.js");
      const lines = await computeSectionBlame(sectionFilePath);

      // The sections API prepends "## Heading\n\n" to headed sections, so blame
      // line numbers must be shifted to match the content the client sees.
      const isHeaded = level > 0 && headingPath.length > 0;
      if (isHeaded && lines.length > 0) {
        const headingOffset = 2; // heading line + blank line
        // Use the first blame entry's type for the heading lines
        const headingType = lines[0].type;
        for (const entry of lines) entry.line += headingOffset;
        lines.unshift(
          { line: 1, type: headingType },
          { line: 2, type: headingType },
        );
      }

      const response: import("../../types/shared.js").BlameResponse = { lines };
      res.json(response);
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // ─── Rename Document ─────────────────────────────────────

  router.post("/documents/:docPath(*)/rename", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const { new_path: newPath } = req.body as { new_path?: string };
      if (!newPath || typeof newPath !== "string") {
        sendApiError(res, 400, "Missing required field: new_path");
        return;
      }

      // Check for active CRDT sessions
      const docSession = lookupDocSession(docPath);
      if (docSession && countEditorSockets(docSession) > 0) {
        sendApiError(res, 409, "Cannot rename document with active editing session.");
        return;
      }

      const canonicalRoot = getContentRoot();
      const { id: proposalId, contentRoot: proposalContentRoot } = await createTransientProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        `Rename document: ${docPath} -> ${newPath}`,
      );
      const overlayLayer = new OverlayContentLayer(proposalContentRoot, canonicalRoot);
      const headingPaths = await overlayLayer.tombstoneDocument(docPath);
      const subtree = await new ContentLayer(canonicalRoot).readAllSubtreeEntries(docPath);
      // Create the destination document (skeleton). For live-empty docs this is the
      // only operation; for docs with sections, writeSection auto-creates but we need
      // the skeleton to exist even if there are zero sections.
      await overlayLayer.createDocument(newPath);
      for (const entry of subtree) {
        await overlayLayer.writeSection(new SectionRef(newPath, entry.headingPath), entry.bodyContent);
      }
      await updateProposalSections(proposalId, [
        ...headingPaths.map((hp) => ({ doc_path: docPath, heading_path: hp })),
        ...headingPaths.map((hp) => ({ doc_path: newPath, heading_path: hp })),
      ]);
      const { sections, committedHead } = await evaluateAndMaybeCommitDocumentProposal(proposalId);
      if (!committedHead) {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: proposalId,
          status: "draft",
          outcome: "blocked",
          blocked_sections: sections.filter((s) => s.blocked),
        });
        return;
      }

      // Broadcast doc:renamed to all connected clients, plus catalog:changed for tree refresh
      if (onWsEvent) {
        onWsEvent({
          type: "doc:renamed",
          old_path: docPath,
          new_path: newPath,
          committed_head: committedHead,
        });
        onWsEvent({ type: "catalog:changed" });
      }

      res.status(200).json({ old_path: docPath, new_path: newPath, committed_head: committedHead });
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // ─── Sections ─────────────────────────────────────────

  router.get("/sections", async (req, res, next) => {
    try {
      const docPath = req.query.doc_path as string;
      const headingPathRaw = req.query.heading_path as string;

      if (!docPath || !headingPathRaw) {
        sendApiError(res, 400, "doc_path and heading_path query params are required.");
        return;
      }

      const headingPath = headingPathRaw.split("/").map((s) => s.trim()).filter(Boolean);
      const content = await readSectionWithHeading(docPath, headingPath);

      broadcastAgentReading(req, docPath, [headingPath], onWsEvent);

      const headSha = await getHeadSha(getDataRoot());
      const response: ReadSectionResponse = {
        doc_path: docPath,
        heading_path: headingPath,
        content,
        head_sha: headSha,
      };
      res.json(response);
    } catch (error) {
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

  // ─── Section Mutations ──────────────────────────────────

  // Helper: parse heading path from URL param (colon-separated)
  function parseHeadingPathParam(raw: string): string[] {
    return raw.split(":").map((s) => decodeURIComponent(s.trim())).filter(Boolean);
  }

  async function evaluateAndMaybeCommitTransientProposal(proposalId: string): Promise<{
    evaluation: Awaited<ReturnType<typeof evaluateProposalHumanInvolvement>>["evaluation"];
    sections: Awaited<ReturnType<typeof evaluateProposalHumanInvolvement>>["sections"];
    committedHead?: string;
  }> {
    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);
    if (!evaluation.all_sections_accepted) {
      return { evaluation, sections };
    }

    const scores: SectionScoreSnapshot = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }

    const committedHead = await commitProposalToCanonical(proposalId, scores);
    return { evaluation, sections, committedHead };
  }

  // POST /api/documents/:docPath/sections — Create a new section
  router.post("/documents/:docPath(*)/sections", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;

      // Prevent structural changes during active CRDT editing
      const activeSession = lookupDocSession(docPath);
      if (activeSession) {
        sendApiError(res, 409, "Cannot modify document structure while an active editing session exists.");
        return;
      }

      const { heading, content } = req.body ?? {};

      if (!heading || typeof heading !== "string") {
        sendApiError(res, 400, "heading (string) is required.");
        return;
      }

      const contentRoot = getContentRoot();
      const { id: proposalId, contentRoot: proposalContentRoot } = await createTransientProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        `Create section "${heading}" in ${docPath}`,
      );
      const overlayLayer = new OverlayContentLayer(proposalContentRoot, contentRoot);

      // Determine the heading level from context
      // Default: level 2 (##) for top-level sections
      const level = req.body.level ?? 2;

      await overlayLayer.createSection(docPath, [], heading, level, content ?? "");
      await updateProposalSections(proposalId, [{ doc_path: docPath, heading_path: [heading] }]);
      const { evaluation, sections, committedHead } = await evaluateAndMaybeCommitTransientProposal(proposalId);
      if (!committedHead) {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: proposalId,
          status: "draft",
          outcome: "blocked",
          blocked_sections: sections.filter((s) => s.blocked),
        });
        return;
      }

      // Broadcast structure change
      if (onWsEvent) {
        onWsEvent({
          type: "doc:structure-changed",
          doc_path: docPath,
        } as any);
      }

      res.status(201).json({
        doc_path: docPath,
        heading_path: [heading],
        created: true,
        committed_head: committedHead,
        evaluation,
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // DELETE /api/documents/:docPath/sections/:headingPath — Delete a section
  router.delete("/documents/:docPath(*)/sections/:headingPath", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;

      const activeSession = lookupDocSession(docPath);
      if (activeSession) {
        sendApiError(res, 409, "Cannot modify document structure while an active editing session exists.");
        return;
      }

      const headingPath = parseHeadingPathParam(req.params.headingPath);

      if (headingPath.length === 0) {
        sendApiError(res, 400, "Cannot delete the before-first-heading section. Use document delete to remove the entire document.");
        return;
      }

      const contentRoot = getContentRoot();
      const { id: proposalId, contentRoot: proposalContentRoot } = await createTransientProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        `Delete section "${headingPath.join(" > ")}" from ${docPath}`,
      );
      const overlayLayer = new OverlayContentLayer(proposalContentRoot, contentRoot);

      await overlayLayer.deleteSection(docPath, headingPath);
      await updateProposalSections(proposalId, [{ doc_path: docPath, heading_path: headingPath }]);
      const { evaluation, sections, committedHead } = await evaluateAndMaybeCommitTransientProposal(proposalId);
      if (!committedHead) {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: proposalId,
          status: "draft",
          outcome: "blocked",
          blocked_sections: sections.filter((s) => s.blocked),
        });
        return;
      }

      if (onWsEvent) {
        onWsEvent({
          type: "doc:structure-changed",
          doc_path: docPath,
        } as any);
      }

      res.status(200).json({
        doc_path: docPath,
        heading_path: headingPath,
        deleted: true,
        committed_head: committedHead,
        evaluation,
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
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

      const activeSession = lookupDocSession(docPath);
      if (activeSession) {
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

      const contentRoot = getContentRoot();
      const { id: proposalId, contentRoot: proposalContentRoot } = await createTransientProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        `Move section "${headingPath.join(" > ")}" in ${docPath}`,
      );
      const overlayLayer = new OverlayContentLayer(proposalContentRoot, contentRoot);

      // Determine target level
      const { level: resolvedLevel } = await new ContentLayer(contentRoot).resolveSectionPathWithLevel(docPath, headingPath);
      const targetLevel = new_parent_path.length === 0
        ? resolvedLevel
        : new_parent_path.length + 1;

      await overlayLayer.moveSection(docPath, headingPath, new_parent_path, targetLevel);
      await updateProposalSections(proposalId, [{ doc_path: docPath, heading_path: headingPath }]);
      const { evaluation, sections, committedHead } = await evaluateAndMaybeCommitTransientProposal(proposalId);
      if (!committedHead) {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: proposalId,
          status: "draft",
          outcome: "blocked",
          blocked_sections: sections.filter((s) => s.blocked),
        });
        return;
      }

      if (onWsEvent) {
        onWsEvent({
          type: "doc:structure-changed",
          doc_path: docPath,
        } as any);
      }

      res.status(200).json({
        doc_path: docPath,
        heading_path: headingPath,
        new_parent_path,
        moved: true,
        committed_head: committedHead,
        evaluation,
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

      const activeSession = lookupDocSession(docPath);
      if (activeSession) {
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

      const contentRoot = getContentRoot();
      const { id: proposalId, contentRoot: proposalContentRoot } = await createTransientProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        `Rename section "${headingPath.join(" > ")}" to "${new_heading}" in ${docPath}`,
      );
      const overlayLayer = new OverlayContentLayer(proposalContentRoot, contentRoot);

      await overlayLayer.renameSection(docPath, headingPath, new_heading);
      const newHeadingPath = [...headingPath.slice(0, -1), new_heading];
      await updateProposalSections(proposalId, [{ doc_path: docPath, heading_path: newHeadingPath }]);
      const { evaluation, sections, committedHead } = await evaluateAndMaybeCommitTransientProposal(proposalId);
      if (!committedHead) {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: proposalId,
          status: "draft",
          outcome: "blocked",
          blocked_sections: sections.filter((s) => s.blocked),
        });
        return;
      }

      if (onWsEvent) {
        onWsEvent({
          type: "doc:structure-changed",
          doc_path: docPath,
        } as any);
      }

      res.status(200).json({
        doc_path: docPath,
        old_heading_path: headingPath,
        new_heading_path: newHeadingPath,
        renamed: true,
        committed_head: committedHead,
        evaluation,
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
        sendApiError(res, 404, error);
        return;
      }
      next(error);
    }
  });

  // ─── Heatmap ──────────────────────────────────────────

  router.get("/heatmap", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const config = getAdminConfig();
      const sections: HeatmapEntry[] = [];

      // Enumerate all documents and their sections
      const humanProposalLockIndex = await SectionPresence.prefetchHumanProposalLocks();
      const tree = await readDocumentsTree("");
      for (const entry of flattenTree(tree)) {
        if (entry.type !== "file") continue;
        const docPath = entry.path;

        try {
          const structure = await readDocumentStructure(docPath);
          const headingPaths = flattenStructureToHeadingPaths(structure);

          // Batch pre-fetch per document
          const [dirtyFileSet, gitCommitInfo, canonicalPaths] = await Promise.all([
            SectionPresence.prefetchDirtyFiles(docPath),
            readDocSectionCommitInfo(docPath),
            resolveAllSectionPaths(getContentRoot(), docPath),
          ]);

          const commitByHeading = new Map<string, SectionCommitInfo>();
          for (const [headingKey, resolved] of canonicalPaths) {
            const relFromDataRoot = path.relative(getDataRoot(), resolved.absolutePath);
            const info = gitCommitInfo.get(relFromDataRoot);
            if (info) commitByHeading.set(headingKey, info);
          }

          for (const headingPath of headingPaths) {
            const headingKey = SectionRef.headingKey(headingPath);
            const verdict = SectionGuard.evaluateWithPrefetch(
              { doc_path: docPath, heading_path: headingPath },
              dirtyFileSet, commitByHeading, humanProposalLockIndex,
            );
            const commitInfo = commitByHeading.get(headingKey);

            sections.push({
              doc_path: docPath,
              heading_path: headingPath,
              humanInvolvement_score: verdict.humanInvolvement_score,
              crdt_session_active: SectionPresence.checkLiveSessionOnly(
                new SectionRef(docPath, headingPath),
              ),
              last_human_commit_sha: commitInfo?.sha ?? null,
              last_commit_author: commitInfo?.authorName ?? null,
              last_commit_timestamp: commitInfo ? new Date(commitInfo.timestampMs).toISOString() : null,
            });
          }
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
      }

      const preset = HUMAN_INVOLVEMENT_PRESETS[config.humanInvolvement_preset];
      const response: GetHeatmapResponse = {
        preset: config.humanInvolvement_preset,
        humanInvolvement_midpoint_seconds: preset.midpoint_seconds,
        humanInvolvement_steepness: preset.steepness,
        sections,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // ─── Proposals ────────────────────────────────────────

  // POST /api/proposals — Submit proposal (v3: immediate evaluation)
  router.post("/proposals", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const body = req.body as CreateProposalRequest;

      if (!body.intent) {
        sendApiError(res, 400, "intent is required.");
        return;
      }

      // Check write permission for all target documents
      const targetDocPaths = new Set(
        (body.sections ?? []).map((s) => s.doc_path).filter(Boolean),
      );
      for (const docPath of targetDocPaths) {
        const allowed = await checkDocPermission(writer, docPath, "write");
        if (!allowed) {
          sendApiError(res, 403, `You do not have permission to write to document "${docPath}".`);
          return;
        }
      }

      // Human reservations can start with empty sections.
      // Agent proposals may also have zero sections for document-level operations (create/delete).
      if (writer.type === "agent") {
        if (!Array.isArray(body.sections)) {
          sendApiError(res, 400, "sections[] is required for agent proposals.");
          return;
        }
        for (const section of body.sections) {
          if (!section.doc_path || !Array.isArray(section.heading_path) || typeof section.content !== "string") {
            sendApiError(res, 400, "Each section must have doc_path, heading_path, and content.");
            return;
          }
        }
      }

      // Check for existing pending proposal (single-pending-per-writer invariant)
      const existing = await findDraftProposalByWriter(writer.id);
      if (existing) {
        const replaceFlag = req.query.replace === "true";
        if (replaceFlag) {
          await transitionToWithdrawn(existing.id, "auto-withdrawn by replace flag");
        } else {
          res.status(409).json({
            error: "Writer already has a pending proposal.",
            existing_proposal_id: existing.id,
          });
          return;
        }
      }

      const sections = (body.sections ?? []).map((s) => ({
        doc_path: s.doc_path,
        heading_path: s.heading_path,
        justification: s.justification,
      }));

      // Capture content for writing to proposal content dir after creation
      const sectionContents = (body.sections ?? []).map((s) => ({
        doc_path: s.doc_path,
        heading_path: s.heading_path,
        content: s.content,
      }));

      // Human reservation contention checks
      if (writer.type === "human") {
        // Block overlapping human reservation sections
        const pendingProposals = await listProposals("draft");
        for (const pending of pendingProposals) {
          if (pending.writer.type !== "human") continue;
          for (const existingSection of pending.sections) {
            for (const requestedSection of sections) {
              if (
                existingSection.doc_path === requestedSection.doc_path &&
                SectionRef.headingPathsEqual(existingSection.heading_path, requestedSection.heading_path)
              ) {
                res.status(409).json({
                  error: `Section ${requestedSection.heading_path.join(" > ")} is already reserved by writer ${pending.writer.displayName} (proposal ${pending.id}).`,
                });
                return;
              }
            }
          }
        }

        // Block reservation on sections with active CRDT sessions
        for (const section of sections) {
          if (SectionPresence.checkLiveSessionOnly(new SectionRef(section.doc_path, section.heading_path))) {
            res.status(409).json({
              error: `Section ${section.heading_path.join(" > ")} has an active editing session.`,
            });
            return;
          }
        }
      }

      // Create proposal
      const { id: proposalId, contentRoot: propContentRoot } = await createProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        body.intent,
        sections,
      );

      // Write section content to proposal's content directory
      if (sectionContents.length > 0) {
        const overlayLayer = new OverlayContentLayer(propContentRoot, getContentRoot());
        for (const sc of sectionContents) {
          await overlayLayer.writeSection(new SectionRef(sc.doc_path, sc.heading_path), sc.content);
        }
      }

      // Human reservations skip human-involvement evaluation — go straight to pending
      if (writer.type === "human") {
        const response: CreateProposalResponse = {
          proposal_id: proposalId,
          status: "draft",
          outcome: "accepted",
          evaluation: {
            all_sections_accepted: true,
            aggregate_impact: 0,
            aggregate_threshold: 0,
            blocked_sections: [],
            passed_sections: [],
          },
          sections: [],
        };
        // Broadcast proposal:created for human reservations
        if (onWsEvent && sections.length > 0) {
          onWsEvent({
            type: "proposal:draft",
            proposal_id: proposalId,
            doc_path: sections[0].doc_path,
            heading_paths: sections.map((s) => s.heading_path),
            writer_id: writer.id,
            writer_display_name: writer.displayName,
            intent: body.intent,
          });
        }

        res.status(201).json(response);
        return;
      }

      // Agent proposals: evaluate human involvement (informational — must commit explicitly)
      const { evaluation, sections: evalSections } = await evaluateProposalHumanInvolvement(proposalId);

      if (onWsEvent && evalSections.length > 0) {
        onWsEvent({
          type: "proposal:draft",
          proposal_id: proposalId,
          doc_path: evalSections[0].doc_path,
          heading_paths: evalSections.map((s) => s.heading_path),
          writer_id: writer.id,
          writer_display_name: writer.displayName,
          intent: body.intent,
        });
      }

      const response: CreateProposalResponse = {
        proposal_id: proposalId,
        status: "draft",
        outcome: evaluation.all_sections_accepted ? "accepted" : "blocked",
        evaluation,
        sections: evalSections,
      };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/proposals — List proposals
  router.get("/proposals", async (req, res, next) => {
    try {
      const statusFilter = req.query.status as string | undefined;
      const validStatuses = ["draft", "committing", "committed", "withdrawn"];

      if (statusFilter && !validStatuses.includes(statusFilter)) {
        sendApiError(res, 400, `Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
        return;
      }

      const proposals = await listProposals(statusFilter as any);
      const response: ListProposalsResponse = { proposals };
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

      const statusFilter = req.query.status as string | undefined;
      const validStatuses = ["draft", "committing", "committed", "withdrawn"];

      if (statusFilter && !validStatuses.includes(statusFilter)) {
        sendApiError(res, 400, `Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
        return;
      }

      const allProposals = await listProposals(statusFilter as any);
      const myProposals = allProposals.filter((p) => p.writer.id === writer.id);
      const response: ListProposalsResponse = { proposals: myProposals };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/proposals/:id — Read proposal (with live involvement re-evaluation)
  router.get("/proposals/:id", async (req, res, next) => {
    try {
      const { proposal, sectionContent } = await readProposalWithContent(req.params.id);

      // Merge section content into each section object
      const sectionsWithContent = proposal.sections.map(s => ({
        ...s,
        content: sectionContent.get(SectionRef.fromTarget(s).globalKey) ?? null,
      }));

      // Enrich pending/committing proposals with live human-involvement evaluation
      let dto: ProposalDTO;
      if (proposal.status === "committed" || proposal.status === "withdrawn") {
        dto = { ...proposal, sections: sectionsWithContent };
      } else {
        const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal.id);
        // Merge content into the re-evaluated sections too
        const enrichedSections = sections.map(s => ({
          ...s,
          content: sectionContent.get(SectionRef.fromTarget(s).globalKey) ?? null,
        }));
        dto = { ...proposal, humanInvolvement_evaluation: evaluation, sections: enrichedSections };
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

  // PUT /api/proposals/:id — Modify blocked proposal sections
  router.put("/proposals/:id", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const proposal = await readProposal(req.params.id);
      if (proposal.writer.id !== writer.id) {
        sendApiError(res, 403, "You can only modify your own proposals.");
        return;
      }
      if (proposal.status !== "draft") {
        sendApiError(res, 409, `Cannot modify proposal in ${proposal.status} state.`);
        return;
      }

      const body = req.body as UpdateProposalRequest;
      if (!Array.isArray(body.sections)) {
        sendApiError(res, 400, "sections[] is required.");
        return;
      }

      // Human reservation: check newly-added sections for contention
      if (proposal.writer.type === "human") {
        const existingSectionKeys = new Set(
          proposal.sections.map((s) => new SectionRef(s.doc_path, s.heading_path).globalKey),
        );
        const newSections = body.sections.filter(
          (s) => !existingSectionKeys.has(new SectionRef(s.doc_path, s.heading_path).globalKey),
        );

        if (newSections.length > 0) {
          // Check overlapping human_reservations
          const pendingProposals = await listProposals("draft");
          for (const pending of pendingProposals) {
            if (pending.writer.type !== "human" || pending.id === proposal.id) continue;
            for (const existingSection of pending.sections) {
              for (const newSection of newSections) {
                if (
                  existingSection.doc_path === newSection.doc_path &&
                  SectionRef.headingPathsEqual(existingSection.heading_path, newSection.heading_path)
                ) {
                  res.status(409).json({
                    error: `Section ${newSection.heading_path.join(" > ")} is already reserved by writer ${pending.writer.displayName} (proposal ${pending.id}).`,
                  });
                  return;
                }
              }
            }
          }

          // Check active CRDT sessions on new sections
          for (const section of newSections) {
            if (SectionPresence.checkLiveSessionOnly(new SectionRef(section.doc_path, section.heading_path))) {
              res.status(409).json({
                error: `Section ${section.heading_path.join(" > ")} has an active editing session.`,
              });
              return;
            }
          }
        }
      }

      const { proposal: updated, contentRoot: updContentRoot } = await updateProposalSections(
        proposal.id,
        body.sections.map((s) => ({
          doc_path: s.doc_path,
          heading_path: s.heading_path,
          justification: s.justification,
        })),
        body.intent,
      );

      // Write updated section content to proposal's content directory
      {
        const overlayLayer = new OverlayContentLayer(updContentRoot, getContentRoot());
        for (const s of body.sections) {
          await overlayLayer.writeSection(new SectionRef(s.doc_path, s.heading_path), s.content);
        }
      }

      // Broadcast proposal:draft with updated sections
      if (onWsEvent && updated.sections.length > 0) {
        onWsEvent({
          type: "proposal:draft",
          proposal_id: updated.id,
          doc_path: updated.sections[0].doc_path,
          heading_paths: updated.sections.map((s: { heading_path: string[] }) => s.heading_path),
          writer_id: writer.id,
          writer_display_name: writer.displayName,
          intent: updated.intent,
        });
      }

      // Human reservations skip involvement re-evaluation
      if (proposal.writer.type === "human") {
        res.json({
          proposal: updated,
          sections: [],
        });
        return;
      }

      // Re-evaluate human-involvement for agent proposals
      const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal.id);

      res.json({
        proposal: { ...updated, humanInvolvement_evaluation: evaluation },
        sections,
      });
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

  // POST /api/proposals/:id/commit — Commit a pending proposal
  router.post("/proposals/:id/commit", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const proposal = await readProposal(req.params.id);
      if (proposal.writer.id !== writer.id) {
        sendApiError(res, 403, "You can only commit your own proposals.");
        return;
      }
      if (proposal.status !== "draft") {
        sendApiError(res, 409, `Cannot commit proposal in ${proposal.status} state.`);
        return;
      }

      // Check write permission for all target documents
      const commitDocPaths = new Set(proposal.sections.map((s) => s.doc_path));
      for (const docPath of commitDocPaths) {
        const allowed = await checkDocPermission(writer, docPath, "write");
        if (!allowed) {
          sendApiError(res, 403, `You do not have permission to write to document "${docPath}".`);
          return;
        }
      }

      // Human reservations always commit (no human-involvement evaluation)
      if (proposal.writer.type === "human") {
        const scores: SectionScoreSnapshot = {};
        for (const s of proposal.sections) {
          scores[SectionRef.fromTarget(s).globalKey] = 0;
        }

        const committedHead = await commitProposalToCanonical(proposal.id, scores);

        if (onWsEvent) {
          onWsEvent({
            type: "content:committed",
            doc_path: proposal.sections[0]?.doc_path ?? "",
            sections: proposal.sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
            commit_sha: committedHead,
            writer_id: writer.id,
            writer_display_name: writer.displayName,
            writer_type: writer.type,
            contributor_ids: [writer.id],
            seconds_ago: 0,
          });
        }

        const response: CommitProposalResponse = {
          proposal_id: proposal.id,
          status: "committed",
          outcome: "accepted",
          committed_head: committedHead,
          evaluation: {
            all_sections_accepted: true,
            aggregate_impact: 0,
            aggregate_threshold: 0,
            blocked_sections: [],
            passed_sections: [],
          },
          sections: [],
        };
        res.json(response);
        return;
      }

      // Agent proposals: evaluate human-involvement
      const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal.id);

      if (evaluation.all_sections_accepted) {
        const scores: SectionScoreSnapshot = {};
        for (const s of sections) {
          scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
        }

        const committedHead = await commitProposalToCanonical(proposal.id, scores);

        if (onWsEvent) {
          onWsEvent({
            type: "content:committed",
            doc_path: sections[0]?.doc_path ?? "",
            sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
            commit_sha: committedHead,
            writer_id: writer.id,
            writer_display_name: writer.displayName,
            writer_type: writer.type,
            contributor_ids: [writer.id],
            seconds_ago: 0,
          });
        }

        const response: CommitProposalResponse = {
          proposal_id: proposal.id,
          status: "committed",
          outcome: "accepted",
          committed_head: committedHead,
          evaluation,
          sections,
        };
        res.json(response);
      } else {
        const response: CommitProposalResponse = {
          proposal_id: proposal.id,
          status: "draft",
          outcome: "blocked",
          evaluation,
          sections,
        };
        res.json(response);
      }
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

      const proposal = await readProposal(req.params.id);
      if (proposal.writer.id !== writer.id) {
        sendApiError(res, 403, "You can only withdraw your own proposals.");
        return;
      }

      const reason = req.body?.reason as string | undefined;
      const withdrawn = await transitionToWithdrawn(proposal.id, reason);

      // Broadcast proposal:withdrawn
      if (onWsEvent && proposal.sections.length > 0) {
        onWsEvent({
          type: "proposal:withdrawn",
          proposal_id: proposal.id,
          doc_path: proposal.sections[0].doc_path,
          heading_paths: proposal.sections.map((s: { heading_path: string[] }) => s.heading_path),
        });
      }

      const response: WithdrawProposalResponse = {
        proposal_id: withdrawn.id,
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

  // ─── Dirty State / Mirror ─────────────────────────────

  // GET /api/writers/:id/dirty — Writer dirty state
  router.get("/writers/:id/dirty", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const writerId = req.params.id;
      const writerSessions = getSessionsForWriter(writerId);
      const docMap = new Map<string, Array<{ heading_path: string[]; base_head: string; change_magnitude: number }>>();

      for (const session of writerSessions) {
        const dirtyFragments = session.perUserDirty.get(writerId);
        if (!dirtyFragments || dirtyFragments.size === 0) continue;

        if (!docMap.has(session.docPath)) {
          docMap.set(session.docPath, []);
        }

        for (const fragmentKey of dirtyFragments) {
          // Fragment keys are file-ID-based (e.g. "section::sec_abc123def").
          // Use the skeleton to resolve back to the canonical heading path.
          const prefix = "section::";
          let headingPath: string[] = [];
          if (fragmentKey.startsWith(prefix)) {
            const fileId = fragmentKey.slice(prefix.length);
            if (fileId === "__beforeFirstHeading__") {
              headingPath = [];
            } else {
              try {
                const entry = session.fragments.skeleton.expectByFileId(fileId);
                headingPath = entry.headingPath;
              } catch {
                // Fragment references a section no longer in skeleton (e.g. deleted)
                // — skip this dirty entry
                continue;
              }
            }
          }
          docMap.get(session.docPath)!.push({
            heading_path: headingPath,
            base_head: session.baseHead,
            change_magnitude: 0,
          });
        }
      }

      // Fall back to disk if no in-memory sessions found for this writer.
      // sessions/authors/{writerId}.json persists dirty state across restarts.
      if (writerSessions.length === 0) {
        const authorFile = path.join(getSessionAuthorsRoot(), `${writerId}.json`);
        try {
          const raw = await readFile(authorFile, "utf8");
          const data = JSON.parse(raw) as { writerId: string; dirtySections: Array<{ docPath: string; headingPath: string[] }> };
          for (const entry of data.dirtySections) {
            if (!docMap.has(entry.docPath)) {
              docMap.set(entry.docPath, []);
            }
            docMap.get(entry.docPath)!.push({
              heading_path: entry.headingPath,
              base_head: "",
              change_magnitude: 0,
            });
          }
        } catch {
          // No author file on disk — writer has no dirty state
        }
      }

      const response: WriterDirtyState = {
        writer_id: writerId,
        documents: [...docMap.entries()].map(([doc_path, dirty_sections]) => ({
          doc_path,
          dirty_sections,
        })),
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/publish — Manual publish
  router.post("/publish", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      if (writer.type !== "human") {
        sendApiError(res, 403, "Only humans can publish.");
        return;
      }

      const body = req.body as PublishRequest;
      if (body?.doc_path) {
        const allowed = await checkDocPermission(writer, body.doc_path, "write");
        if (!allowed) {
          sendApiError(res, 403, `You do not have permission to write to document "${body.doc_path}".`);
          return;
        }
      }
      const result = await commitDirtySections(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        body?.doc_path,
        body?.heading_paths,
      );

      if (!result.committed) {
        sendApiError(res, 404, "No dirty sections to publish.");
        return;
      }

      const response: PublishResponse = {
        committed_head: result.commitSha!,
        sections_published: result.sectionsPublished,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // ─── Activity ─────────────────────────────────────────

  router.get("/activity", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 500);
      const days = Math.max(Number(req.query.days ?? 30), 1);
      const items = await readActivity(limit, days);
      const response: GetActivityResponse = { items };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // ─── Admin ────────────────────────────────────────────

  router.get("/admin/config", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const config = getAdminConfig();
      const preset = HUMAN_INVOLVEMENT_PRESETS[config.humanInvolvement_preset];
      res.json({
        ...config,
        preset_description: preset.description,
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/config", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const body = req.body;
      const updated = updateAdminConfig(body);
      const preset = HUMAN_INVOLVEMENT_PRESETS[updated.humanInvolvement_preset];
      res.json({
        ...updated,
        preset_description: preset.description,
      });
    } catch (error) {
      if (error instanceof AdminConfigValidationError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // ─── Imports (unified staging-based pipeline) ───────────

  router.post("/imports", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      if (writer.type !== "human") {
        sendApiError(res, 403, "Only human writers can create imports.");
        return;
      }
      const { importId, stagingPath } = await createStagingFolder();
      res.status(201).json({ import_id: importId, staging_path: stagingPath });
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

      const stagingPath = path.join(getImportStagingRoot(), importId);

      // Verify staging folder exists
      try {
        await stat(stagingPath);
      } catch {
        sendApiError(res, 404, `Import ${importId} not found.`);
        return;
      }

      const files = parseMultipartUploadFiles(await readRequestBody(req), boundary);
      if (files.length === 0) {
        sendApiError(res, 400, "At least one uploaded Markdown file is required.");
        return;
      }

      let uploaded = 0;
      for (const f of files) {
        if (!f.name.toLowerCase().endsWith(".md")) {
          sendApiError(res, 400, `Only .md files are accepted. Got: ${f.name}`);
          return;
        }
        const relativePath = f.name.replace(/\\/g, "/").replace(/^\/+/, "");
        const pathSegments = relativePath.split("/");
        if (
          relativePath.length === 0 ||
          pathSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
        ) {
          sendApiError(res, 400, `Invalid file path: ${f.name}`);
          return;
        }
        const filePath = path.resolve(stagingPath, ...pathSegments);
        // Prevent path traversal
        if (filePath !== stagingPath && !filePath.startsWith(stagingPath + path.sep)) {
          sendApiError(res, 400, `Invalid file path: ${f.name}`);
          return;
        }
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, f.content, "utf8");
        uploaded++;
      }

      res.status(200).json({ uploaded });
    } catch (error) {
      next(error);
    }
  });

  router.get("/imports", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const folders = await listStagingFolders();
      res.json(
        folders.map((f) => ({
          import_id: f.importId,
          staging_path: f.stagingPath,
          created_at: f.createdAt,
        })),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/imports/:id", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      const importId = req.params.id;
      const stagingPath = path.join(getImportStagingRoot(), importId);

      try {
        await stat(stagingPath);
      } catch {
        sendApiError(res, 404, `Import ${importId} not found.`);
        return;
      }

      const files = await scanStagingFolder(importId);
      res.json({
        import_id: importId,
        staging_path: stagingPath,
        files: files.map((f) => ({
          path: f.relativePath,
          is_markdown: f.isMarkdown,
          section_count: f.sectionCount,
          is_internal_artifact: f.isInternalArtifact,
          rejection_reason: f.rejectionReason,
        })),
      });
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

      // Read files from staging
      const stagingFiles = await readStagingFiles(importId);
      if (stagingFiles.length === 0) {
        sendApiError(res, 400, "Staging folder is empty or contains no .md files.");
        return;
      }

      // Run through the shared import pipeline
      const { id: importProposalId } = await importFilesToProposal(
        stagingFiles,
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        description.trim(),
      );

      // Human imports commit directly — human involvement is always 0.
      const freshProposal = await readProposal(importProposalId);
      const scores: SectionScoreSnapshot = {};
      for (const s of freshProposal.sections) {
        scores[SectionRef.fromTarget(s).globalKey] = 0;
      }

      const importDiagnostics: string[] = [];
      const committedHead = await commitProposalToCanonical(importProposalId, scores, importDiagnostics);
      await deleteStagingFolder(importId);

      if (onWsEvent && freshProposal.sections.length > 0) {
        onWsEvent({
          type: "content:committed",
          doc_path: freshProposal.sections[0].doc_path,
          sections: freshProposal.sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
          commit_sha: committedHead,
          writer_id: writer.id,
          writer_display_name: writer.displayName,
          writer_type: writer.type,
          contributor_ids: [writer.id],
          seconds_ago: 0,
        });
      }

      res.status(201).json({
        proposal_id: importProposalId,
        status: "committed",
        outcome: "accepted",
        committed_head: committedHead,
        evaluation: {
          all_sections_accepted: true,
          aggregate_impact: 0,
          aggregate_threshold: 0,
          blocked_sections: [],
          passed_sections: [],
        },
        sections: freshProposal.sections.map((s) => ({
          ...s,
          humanInvolvement_score: 0,
          blocked: false,
        })),
        diagnostics: importDiagnostics,
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/imports/:id", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;

      await deleteStagingFolder(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ─── Export ────────────────────────────────────────────

  router.get("/export", async (req, res, next) => {
    try {
      const browsePath = typeof req.query.path === "string" ? req.query.path : "/";
      const tree = await readDocumentsTree(browsePath, true);

      // Flatten tree to collect all file paths
      const filePaths: string[] = [];
      const walk = (nodes: import("../../types/shared.js").DocumentTreeEntry[]) => {
        for (const node of nodes) {
          if (node.type === "file") {
            filePaths.push(node.path);
          } else if (node.children) {
            walk(node.children);
          }
        }
      };
      walk(tree);

      const { ZipFile } = await import("yazl");
      const zipFile = new ZipFile();

      const exportErrors: string[] = [];
      for (const docPath of filePaths) {
        try {
          const assembled = await readAssembledDocument(docPath);
          // Strip leading "/" for clean zip paths
          const zipPath = docPath.replace(/^\/+/, "");
          zipFile.addBuffer(Buffer.from(assembled, "utf8"), zipPath);
        } catch (assemblyError) {
          const msg = assemblyError instanceof Error
            ? assemblyError.stack ?? assemblyError.message
            : String(assemblyError);
          exportErrors.push(`${docPath}: ${msg}`);
        }
      }

      if (exportErrors.length > 0) {
        zipFile.addBuffer(
          Buffer.from(exportErrors.join("\n\n"), "utf8"),
          "export-errors.txt",
        );
      }

      zipFile.end();

      const folderName = browsePath === "/" ? "all" : browsePath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\//g, "-") || "all";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `export-${folderName}-${timestamp}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      zipFile.outputStream.pipe(res);
    } catch (error) {
      if (error instanceof DocumentsTreePathNotFoundError) {
        res.status(404).json({ message: `Path not found: ${req.query.path}` });
        return;
      }
      next(error);
    }
  });

  // ─── Admin ─────────────────────────────────────────────

  router.get("/admin/snapshot-health", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const health = await getSnapshotHealth();
      const response: GetAdminSnapshotHealthResponse = health;
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/snapshot-history", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const history = await getSnapshotHistory();
      const response: GetAdminSnapshotHistoryResponse = history;
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/snapshot-now", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      await snapshotAllDocs();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ─── Git history ──────────────────────────────────────

  router.get("/git/log", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const docPath = (req.query.doc_path as string) || undefined;
      const dataRoot = getDataRoot();
      const entries = await gitLogRecent(dataRoot, { limit, offset, docPath });
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
      const dataRoot = getDataRoot();
      const result = await gitDiffForCommit(dataRoot, sha);
      res.json({ sha, ...result });
    } catch (error) {
      next(error);
    }
  });

  // ─── Session state inspector ──────────────────────────

  router.get("/admin/session-state", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      res.json(await getSessionState());
    } catch (error) {
      next(error);
    }
  });

  // ─── Setup / connection info (public) ────────────────

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
    });
  });

  // ─── Pre-authenticated agent management ────────────────

  router.get("/admin/agents", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { entries, errors } = await readAgentKeysAndErrors();
      res.json({
        agents: entries.map((e) => ({ agent_id: e.agentId, display_name: e.displayName })),
        errors,
      });
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
      const id = (typeof agent_id === "string" && agent_id.trim())
        ? agent_id.trim()
        : `agent-${crypto.randomUUID()}`;
      const withSecret = generate_secret !== false; // default true
      const plainSecret = await addAgentKey(id, display_name.trim(), withSecret);
      res.status(201).json({
        agent_id: id,
        display_name: display_name.trim(),
        secret: plainSecret,
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/agents/:agentId", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const removed = await removeAgentKey(req.params.agentId);
      if (!removed) {
        sendApiError(res, 404, "Agent not found.");
        return;
      }
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // ─── Agent activity summary ─────────────────────────────

  router.get("/agents/summary", async (_req, res, next) => {
    try {
      const { agentEventLog } = await import("../../mcp/agent-event-log.js");
      const registeredAgents = (await readAgentKeysSkipErrors()).map(e => ({ id: e.agentId, displayName: e.displayName }));

      // Collect all proposals with their status
      const allStatuses = ["draft", "committed", "withdrawn"] as const;
      const allProposals: Array<any> = [];
      for (const status of allStatuses) {
        const proposals = await listProposals(status);
        for (const p of proposals) {
          allProposals.push({ ...p, status });
        }
      }

      const agents = agentEventLog.buildFullSummary(registeredAgents, allProposals);
      const config = getAdminConfig();
      const preset = HUMAN_INVOLVEMENT_PRESETS[config.humanInvolvement_preset];
      res.json({
        agents,
        posture: {
          preset: config.humanInvolvement_preset,
          description: preset.description ?? config.humanInvolvement_preset,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // ─── Admin ACL/RBAC management ─────────────────────────

  router.get("/admin/acl", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const snapshot = await getAclSnapshot();
      res.json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/acl/defaults", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { read, write } = req.body as { read?: string; write?: string };
      await updateDefaults({ read, write });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/acl/doc/:docPath(*)", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const docPath = req.params.docPath;
      const { read, write } = req.body as { read?: string; write?: string };
      await setDocAcl(docPath, { read, write });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/acl/doc/:docPath(*)", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const docPath = req.params.docPath;
      await removeDocAcl(docPath);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/roles/:userId", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const userId = req.params.userId;
      const { roles } = req.body as { roles: string[] };
      if (!Array.isArray(roles)) {
        sendApiError(res, 400, "roles must be a string array.");
        return;
      }
      await setUserRoles(userId, roles);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/roles/:userId", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const userId = req.params.userId;
      await removeUserRoles(userId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/custom-roles", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { name } = req.body as { name: string };
      if (!name || typeof name !== "string") {
        sendApiError(res, 400, "name is required.");
        return;
      }
      await addCustomRole(name);
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
      const name = req.params.name;
      await deleteCustomRole(name);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof Error && (error.message.includes("magic role") || error.message.includes("does not exist"))) {
        sendApiError(res, 400, error.message);
        return;
      }
      next(error);
    }
  });

  // ─── Agent MCP activity log ─────────────────────────────

  router.get("/admin/agent-activity", async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const { readFile } = await import("node:fs/promises");
      const { getMonitoringRoot } = await import("../../storage/data-root.js");
      const logPath = (await import("node:path")).join(getMonitoringRoot(), "agent-mcp-activity.jsonl");
      let raw: string;
      try {
        raw = await readFile(logPath, "utf-8");
      } catch {
        res.json({ sessions: [] });
        return;
      }
      const sessions = raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      res.json({ sessions });
    } catch (error) {
      next(error);
    }
  });

  // ─── Document catch-all routes ─────────────────────────
  // Registered LAST so they never shadow more-specific /documents/ routes.
  // This is in a separate function to make it structurally impossible to
  // accidentally add a specific route after the catch-all wildcards.
  registerDocumentCatchAllRoutes(router, onWsEvent);

  // ─── Error handler ────────────────────────────────────

  router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    sendApiError(res, 500, error.stack || error.message);
  });

  return router;
}


// ─── Document catch-all routes ──────────────────────────
//
// These wildcard routes (GET/PUT/PATCH/DELETE /documents/:docPath(*))
// match ANY path under /documents/. They MUST be registered after all
// specific /documents/ routes, otherwise they shadow them.
//
// Isolated in a separate function so that adding a new specific route
// inside createApiRouter() can never accidentally end up after these.

async function evaluateAndMaybeCommitDocumentProposal(proposalId: string): Promise<{
  evaluation: Awaited<ReturnType<typeof evaluateProposalHumanInvolvement>>["evaluation"];
  sections: Awaited<ReturnType<typeof evaluateProposalHumanInvolvement>>["sections"];
  committedHead?: string;
}> {
  const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);
  if (!evaluation.all_sections_accepted) {
    return { evaluation, sections };
  }

  const scores: SectionScoreSnapshot = {};
  for (const s of sections) {
    scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
  }

  const committedHead = await commitProposalToCanonical(proposalId, scores);
  return { evaluation, sections, committedHead };
}

function registerDocumentCatchAllRoutes(
  router: express.Router,
  onWsEvent: ((event: WsServerEvent) => void) | undefined,
): void {
  // ─── Read Document (assembled) ────────────────────────
  router.get("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const accessResult = await requireDocReadPermission(req, res, docPath);
      if (!accessResult) return;
      const assembled = await readAssembledDocument(docPath);

      // Compute per-section metadata
      const structure = await readDocumentStructure(docPath);
      const headingPaths = flattenStructureToHeadingPaths(structure);

      const docOverlayRoot = getSessionDocsContentRoot();
      const docOverlay = new OverlayContentLayer(docOverlayRoot, getContentRoot());
      const bulkContent = await docOverlay.readAllSections(docPath);
      const involvementMeta = await buildSectionInvolvementMeta(docPath, headingPaths, bulkContent);

      const sectionsMeta: SectionMeta[] = [];
      for (const headingPath of headingPaths) {
        const headingKey = SectionRef.headingKey(headingPath);
        const meta = involvementMeta.get(headingKey);
        if (!meta) continue;

        sectionsMeta.push({
          heading_path: headingPath,
          humanInvolvement_score: meta.humanInvolvement_score,
          crdt_session_active: meta.crdt_session_active,
          section_length_warning: meta.section_length_warning,
          word_count: meta.word_count,
        });
      }

      broadcastAgentReading(req, docPath, sectionsMeta.map((s) => s.heading_path), onWsEvent);

      const headSha = await getHeadSha(getDataRoot());
      const response: GetDocumentResponse = {
        doc_path: docPath,
        content: assembled,
        head_sha: headSha,
        sections_meta: sectionsMeta,
      };
      res.json(response);
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

  // ─── Create Document ────────────────────────────────────
  router.put("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const contentRoot = getContentRoot();
      const resolvedPath = resolveDocPathUnderContent(contentRoot, docPath);

      try {
        await access(resolvedPath);
        sendApiError(res, 409, "Document already exists.");
        return;
      } catch {
        // File does not exist — proceed
      }

      const { id: proposalId, contentRoot: proposalContentRoot } = await createTransientProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        `Create document: ${docPath}`,
      );
      const overlayLayer = new OverlayContentLayer(proposalContentRoot, contentRoot);
      await overlayLayer.createDocument(docPath);
      await updateProposalSections(proposalId, []);
      const { sections, committedHead } = await evaluateAndMaybeCommitDocumentProposal(proposalId);
      if (!committedHead) {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: proposalId,
          status: "draft",
          outcome: "blocked",
          blocked_sections: sections.filter((s) => s.blocked),
        });
        return;
      }

      if (onWsEvent) {
        onWsEvent({ type: "catalog:changed" });
      }
      res.status(201).json({ doc_path: docPath, committed_head: committedHead });
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  // ─── Patch Document (unified diff) ──────────────────────
  router.patch("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const diffText = typeof req.body === "string" ? req.body : req.body?.diff;

      if (!diffText || typeof diffText !== "string") {
        sendApiError(res, 400, "Request body must be a unified diff (text/x-diff or text/plain, or JSON with 'diff' field).");
        return;
      }

      let currentContent: string;
      try {
        currentContent = await readAssembledDocument(docPath);
      } catch (error) {
        if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
          sendApiError(res, 404, error);
          return;
        }
        throw error;
      }

      const { applyUnifiedDiff, DiffParseError, DiffApplyError } = await import("../../storage/diff-parser.js");
      let patchedContent: string;
      try {
        patchedContent = applyUnifiedDiff(currentContent, diffText);
      } catch (error) {
        if (error instanceof DiffParseError || error instanceof DiffApplyError) {
          sendApiError(res, 400, error);
          return;
        }
        throw error;
      }

      if (patchedContent === currentContent) {
        res.status(200).json({ doc_path: docPath, no_changes: true });
        return;
      }

      const intent = `Patch document: ${docPath}`;
      const existing = await findDraftProposalByWriter(writer.id);
      if (existing) {
        await transitionToWithdrawn(existing.id, "auto-withdrawn by PATCH");
      }

      const { id: patchProposalId, contentRoot: patchContentRoot } = await createTransientProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        intent,
      );
      const proposalContentLayer = new OverlayContentLayer(patchContentRoot, getContentRoot());
      const patchTargets = await proposalContentLayer.importMarkdownDocument(docPath, patchedContent);
      await updateProposalSections(patchProposalId, patchTargets);

      const { evaluation, sections } = await evaluateProposalHumanInvolvement(patchProposalId);

      if (evaluation.all_sections_accepted) {
        const scores: SectionScoreSnapshot = {};
        for (const s of sections) {
          scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
        }

        const committedHead = await commitProposalToCanonical(patchProposalId, scores);

        if (onWsEvent) {
          onWsEvent({
            type: "content:committed",
            doc_path: docPath,
            sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
            commit_sha: committedHead,
            writer_id: writer.id,
            writer_display_name: writer.displayName,
            writer_type: writer.type,
            contributor_ids: [writer.id],
            seconds_ago: 0,
          });
        }

        res.status(200).json({
          doc_path: docPath,
          committed_head: committedHead,
          status: "committed",
        });
      } else {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: patchProposalId,
          status: "draft",
          outcome: "blocked",
          blocked_sections: sections.filter((s) => s.blocked),
        });
      }
    } catch (error) {
      next(error);
    }
  });

  // ─── Delete Document ────────────────────────────────────
  router.delete("/documents/:docPath(*)", async (req, res, next) => {
    try {
      const docPath = req.params.docPath;
      const writer = await requireDocWritePermission(req, res, docPath);
      if (!writer) return;
      const contentRoot = getContentRoot();
      const resolvedPath = resolveDocPathUnderContent(contentRoot, docPath);

      try {
        await access(resolvedPath);
      } catch {
        sendApiError(res, 404, `Document not found: ${docPath}`);
        return;
      }

      const docSession = lookupDocSession(docPath);
      if (docSession) {
        sendApiError(res, 409, "Cannot delete document with active editing session.");
        return;
      }

      const sessionDocsContentRoot = getSessionDocsContentRoot();
      const sessionDocPath = resolveDocPathUnderContent(sessionDocsContentRoot, docPath);
      let hasDirtySessionFiles = false;
      try { await access(sessionDocPath); hasDirtySessionFiles = true; } catch { /* not found */ }
      if (!hasDirtySessionFiles) {
        try { await access(sessionDocPath + SECTIONS_DIR_SUFFIX); hasDirtySessionFiles = true; } catch { /* not found */ }
      }
      if (hasDirtySessionFiles) {
        sendApiError(res, 409, "Cannot delete document: uncommitted session files exist.");
        return;
      }

      const canonicalRoot = getContentRoot();
      const { id: proposalId, contentRoot: proposalContentRoot } = await createTransientProposal(
        { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
        `Delete document: ${docPath}`,
      );
      const headingPaths = await new OverlayContentLayer(proposalContentRoot, canonicalRoot).tombstoneDocument(docPath);
      await updateProposalSections(
        proposalId,
        headingPaths.map((hp) => ({ doc_path: docPath, heading_path: hp })),
      );
      const { sections, committedHead } = await evaluateAndMaybeCommitDocumentProposal(proposalId);
      if (!committedHead) {
        res.status(409).json({
          doc_path: docPath,
          proposal_id: proposalId,
          status: "draft",
          outcome: "blocked",
          blocked_sections: sections.filter((s) => s.blocked),
        });
        return;
      }

      if (onWsEvent) {
        onWsEvent({ type: "catalog:changed" });
      }
      res.status(200).json({ doc_path: docPath, deleted: true, committed_head: committedHead });
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });
}

// ─── Structure Helpers ──────────────────────────────────

function flattenTree(
  entries: Array<{ name: string; path: string; type: "file" | "directory"; children?: any[] }>,
): Array<{ name: string; path: string; type: "file" | "directory" }> {
  const result: Array<{ name: string; path: string; type: "file" | "directory" }> = [];
  for (const entry of entries) {
    result.push({ name: entry.name, path: entry.path, type: entry.type });
    if (entry.children?.length) {
      result.push(...flattenTree(entry.children));
    }
  }
  return result;
}