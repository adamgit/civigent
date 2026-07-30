import { encodeDocPath } from "../utils/path-encoding.js";
import type {
  AclSnapshot,
  AdminConfig,
  AgentAuthPolicy,
  AuthUser,
  BlameResponse,
  SetAclDefaultsRequest,
  SetDocumentAclRequest,
  SetUserRolesRequest,
  CreateCustomRoleRequest,
  CommitProposalResponse,
  CreateDocumentResponse,
  CreateProposalRequest,
  CreateProposalResponse,
  GetActivityResponse,
  GetAdminGitBackupStatusResponse,
  GetAdminGitRestoreStatusResponse,
  GetAdminRuntimeMemoryResponse,
  GetAdminSnapshotHealthResponse,
  GetAdminSnapshotHistoryResponse,
  RunAdminContentIntegrityScanResponse,
  RunAdminGitBackupResponse,
  RunAdminGitRestoreResponse,
  VerifyAdminGitBackupResponse,
  GetAgentsFullSummaryResponse,
  GetDocumentResponse,
  GetDocumentSectionsResponse,
  GetProposalSectionsResponse,
  GetDocumentsTreeResponse,
  GetHeatmapResponse,
  ListDegradedProposalsResponse,
  ListProposalsResponse,
  AnyProposal,
  AuthMethod,
  ProposalId,
  ProposalStatus,
  ReadDocStructureResponse,
  ReadProposalResponse,
  SessionInfoResponse,
  UpdateProposalManifestRequest,
  ReplaceProposalSectionsRequest,
  WriteProposalDocumentSectionsRequest,
  AcquireLocksResponse,
  WithdrawProposalResponse,
} from "../types/shared.js";

export type ImportResponse = CreateProposalResponse;

export interface AgentMcpActionEntry {
  method: string;
  ts: string;
  metadata: Record<string, unknown>;
}

export interface AgentMcpSessionRecord {
  session_id: string;
  agent_id: string;
  agent_display_name: string;
  started_at: string;
  ended_at: string;
  action_count: number;
  actions: AgentMcpActionEntry[];
}

export interface ImportStagingInfo {
  import_id: string;
  staging_path: string;
}

export interface ImportStagingFile {
  path: string;
  is_markdown: boolean;
  section_count: number;
  is_internal_artifact: boolean;
  rejection_reason: string | null;
}

export interface ImportDetailResponse {
  import_id: string;
  staging_path: string;
  files: ImportStagingFile[];
}

export interface DocHistoryVersion {
  sha: string;
  author_name: string;
  author_email: string;
  writer_type?: string;
  timestamp_iso: string;
  message: string;
  changed_files: string[];
}

export interface DocHistoryResponse {
  doc_path: string;
  versions: DocHistoryVersion[];
}

export interface DocHistoryPreviewResponse {
  doc_path: string;
  sha: string;
  content: string;
  corrupt?: boolean;
  missingSections?: string[];
}

// Restore now publishes-or-aborts the live DocSession, then commits the target
// version to canonical (spec 04 §5 / plan §C/§F). It is not gated by an FSM lock
// conflict or an agent-write-policy result, so there are no per-section
// `blocked_sections` in the response — the backend returns the committed SHA
// only (backend restore handler: `res.json({ committed_sha })`).
export interface DocRestoreResponse {
  committed_sha?: string;
}

export interface DiagLayerStatus {
  exists: boolean;
  byteLength: number | null;
  contentPreview: string | null;
  error: string | null;
}

/**
 * Winner of the per-section layer comparison. The durable layers are canonical
 * and live CRDT; the backend winner is one of these.
 */
export type DiagSectionWinner = "canonical" | "proposal" | "crdt" | "none" | "error";

export interface DiagSectionLayerInfo {
  /** Physical identity — one row per unique section body file. */
  fragmentKey: string;
  /** Heading key (`headingPath.join(">>")`) — data, not identity. */
  headingKey: string;
  /** Heading path — data, not identity. Multiple rows can share it. */
  headingPath: string[];
  /** Canonical section-file name (empty when CRDT-only). */
  sectionFile: string;
  isSubSkeleton: boolean;
  canonical: DiagLayerStatus;
  /** Effective inprogress-proposal body — durable saved state that survives
   *  refresh. Absent when no inprogress proposal covers this section. */
  proposal: DiagLayerStatus;
  crdt: DiagLayerStatus;
  winner: DiagSectionWinner;
  gitHistoryExists?: boolean | null;
  error?: string;
}

export interface DiagHealthCheck {
  category: string;
  name: string;
  pass: boolean;
  detail?: string;
}

export interface DiagSummary {
  top_level_entries: number | null;
  recursive_structural_entries: number | null;
  recursive_content_sections: number | null;
  recursive_subskeleton_parents: number | null;
  recursive_max_depth: number | null;
  physical_section_count: number | null;
  logical_section_count: number | null;
  api_section_count: number | null;
}

export interface DiagRestoreProvenance {
  current_head_sha: string | null;
  last_restore_commit_sha: string | null;
  last_restore_target_sha: string | null;
  target_top_level_entries: number | null;
  target_recursive_content_sections: number | null;
  recursive_content_match: boolean | null;
  current_only_heading_keys: string[];
  target_only_heading_keys: string[];
}

export type DiagBackendStateKind = "live" | "proposal" | "canonical";
export interface DiagBackendState {
  kind: DiagBackendStateKind;
  message: string;
  details: string[];
}

export interface DocDiagnosticsResponse {
  doc_path: string;
  checks: DiagHealthCheck[];
  sections: DiagSectionLayerInfo[];
  summary: DiagSummary;
  /** Backend-reported invalid/error signals aggregated for this document, or
   *  an empty array when nothing is degraded. */
  backend_states: DiagBackendState[];
  restore_provenance: DiagRestoreProvenance;
}

export interface SearchTextMatch {
  doc_path: string;
  heading_path: string[];
  match_context: string;
  match_offset_bytes: number;
}

export interface DiscoveryFailure {
  doc_path: string;
  heading_path?: string[];
  error: string;
}

export interface SearchTextResponse {
  matches: SearchTextMatch[];
  timings: {
    total_ms: number;
    scope_and_acl_ms: number;
    ripgrep_ms: number;
    match_mapping_ms: number;
    context_read_ms: number;
  };
  /** Per-row read failures (claim-review 04) — surfaced as markers, never dropped. */
  failures?: DiscoveryFailure[];
}

/**
 * User-facing result of a force-publish request — the JSON projection of the
 * backend `PublishAttemptOutcome` (`ws/crdt-ws-coordinator.ts`). `noop` means
 * there was no live in-flight proposal to publish; `aborted`/`failed` are
 * legitimate (non-error) results the UI surfaces, not HTTP failures.
 */
export interface ForcePublishOutcome {
  outcome: "committed" | "noop" | "aborted" | "failed";
  message?: string;
  commitSha?: string;
}

interface GetDocumentsTreeOptions {
  path?: string;
  recursive?: boolean;
}

const WRITER_ID_STORAGE_KEY = "ks_writer_id";
let singleUserBootstrapInFlight: Promise<boolean> | null = null;
let unauthorizedHandler: (() => void) | null = null;
let systemStartingHandler: (() => void) | null = null;

function broadcastAuthEvent(event: "login" | "logout" | "session_refreshed"): void {
  try { new BroadcastChannel("ks_auth_sync").postMessage(event); } catch { /* unsupported env */ }
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function setSystemStartingHandler(handler: (() => void) | null): void {
  systemStartingHandler = handler;
}

export class SystemStartingError extends Error {
  public readonly retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = "SystemStartingError";
    this.retryAfter = retryAfter;
  }
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();

    // Detect 503 system_starting — throw specific error for startup gate
    if (response.status === 503) {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        if (parsed.error === "system_starting") {
          const retryAfter = Number(response.headers.get("Retry-After")) || 5;
          throw new SystemStartingError(
            parsed.message ?? "The system is starting up.",
            retryAfter,
          );
        }
      } catch (e) {
        if (e instanceof SystemStartingError) throw e;
      }
    }

    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (typeof parsed.message === "string") {
        detail = parsed.message;
      }
    } catch {
      // Non-JSON body — strip HTML tags and trim to something readable.
      const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (plain.length > 0) {
        detail = plain.length > 200 ? plain.slice(0, 200) + "…" : plain;
      }
    }
    const prefix = `${response.status} ${response.statusText} — ${response.url}`;
    throw new Error(detail ? `${prefix}: ${detail}` : prefix);
  }
  return (await response.json()) as T;
}

export function resolveWriterId(): string {
  let writerId = "human-ui";
  try {
    const fromStorage = localStorage.getItem(WRITER_ID_STORAGE_KEY);
    if (fromStorage && fromStorage.trim().length > 0) {
      writerId = fromStorage.trim();
    }
  } catch {
    // Ignore localStorage access issues in constrained environments.
  }
  return writerId;
}

export function setWriterId(writerId: string): void {
  const normalized = writerId.trim();
  if (!normalized) {
    return;
  }
  try {
    localStorage.setItem(WRITER_ID_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage write failures in constrained environments.
  }
}

export function clearWriterId(): void {
  try {
    localStorage.removeItem(WRITER_ID_STORAGE_KEY);
  } catch {
    // Ignore storage write failures in constrained environments.
  }
}

async function requestJson<T>(url: string, init?: RequestInit, includeAuth = true): Promise<T> {
  if (includeAuth) {
    await tryBootstrapSingleUserSession();
  }

  const buildHeaders = () => {
    const h = new Headers(init?.headers);
    h.set("X-Requested-With", "fetch");
    return h;
  };
  let response = await fetch(url, {
    ...init,
    headers: buildHeaders(),
    credentials: "include",
  });

  if (includeAuth && response.status === 401 && url !== "/api/auth/token/refresh") {
    const refreshed = await tryRefreshAccessToken();
    if (refreshed) {
      response = await fetch(url, {
        ...init,
        headers: buildHeaders(),
        credentials: "include",
      });
    }
  }

  if (includeAuth && response.status === 401) {
    unauthorizedHandler?.();
  }

  try {
    return await parseJsonOrThrow<T>(response);
  } catch (error) {
    if (error instanceof SystemStartingError && systemStartingHandler) {
      systemStartingHandler();
      // Don't re-throw — handler set systemStarting=true which unmounts callers.
      // Return a never-settling promise so callers silently stop processing.
      // The pending promise becomes unreachable once the caller unmounts and will be GC'd.
      return new Promise<T>(() => {});
    }
    throw error;
  }
}

interface AuthMethodsResponse {
  methods: AuthMethod[];
  bootstrap_available?: boolean;
}

interface AuthTokenResponse {
  token: string;
  access_token: string;
  refresh_token: string;
  identity: AuthUser;
}

interface RefreshTokenResponse {
  authenticated: boolean;
}

export type { AclSnapshot } from "../types/shared.js";

async function tryBootstrapSingleUserSession(): Promise<boolean> {
  if (singleUserBootstrapInFlight) {
    return singleUserBootstrapInFlight;
  }
  singleUserBootstrapInFlight = (async () => {
    try {
      const sessionResponse = await fetch("/api/auth/session", {
        credentials: "include",
      });
      if (!sessionResponse.ok) {
        return false;
      }
      const session = (await sessionResponse.json()) as SessionInfoResponse;
      if (session.authenticated && session.user?.id) {
        setWriterId(session.user.id);
        return true;
      }
      const providers = Array.isArray(session.login_providers) ? session.login_providers : [];
      if (!providers.includes("single_user")) {
        return false;
      }
      const loginResponse = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "single_user" }),
        credentials: "include",
      });
      if (!loginResponse.ok) {
        return false;
      }
      const loginPayload = (await loginResponse.json()) as AuthTokenResponse;
      if (!loginPayload.identity?.id) {
        return false;
      }
      setWriterId(loginPayload.identity.id);
      return true;
    } catch {
      return false;
    } finally {
      singleUserBootstrapInFlight = null;
    }
  })();
  return singleUserBootstrapInFlight;
}

let refreshInFlight: Promise<boolean> | null = null;

async function tryRefreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const response = await fetch("/api/auth/token/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        credentials: "include",
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as RefreshTokenResponse;
      if (payload.authenticated === true) {
        broadcastAuthEvent("session_refreshed");
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export const apiClient = {
  async getSessionInfo(): Promise<SessionInfoResponse> {
    return requestJson<SessionInfoResponse>("/api/auth/session");
  },

  async getAuthMethods(): Promise<AuthMethodsResponse> {
    return requestJson<AuthMethodsResponse>("/api/auth/methods", undefined, false);
  },

  async getAdminConfig(): Promise<AdminConfig> {
    return requestJson<AdminConfig>("/api/admin/config");
  },

  async getAdminSnapshotHealth(): Promise<GetAdminSnapshotHealthResponse> {
    return requestJson<GetAdminSnapshotHealthResponse>("/api/admin/snapshot-health");
  },

  async getAdminSnapshotHistory(): Promise<GetAdminSnapshotHistoryResponse> {
    return requestJson<GetAdminSnapshotHistoryResponse>("/api/admin/snapshot-history");
  },

  async snapshotNow(): Promise<void> {
    await requestJson<{ ok: boolean }>("/api/admin/snapshot-now", { method: "POST" });
  },

  async getAdminRuntimeMemory(): Promise<GetAdminRuntimeMemoryResponse> {
    return requestJson<GetAdminRuntimeMemoryResponse>("/api/admin/runtime-memory");
  },

  async runAdminContentIntegrityScan(): Promise<RunAdminContentIntegrityScanResponse> {
    return requestJson<RunAdminContentIntegrityScanResponse>("/api/admin/content-integrity-scan", {
      method: "POST",
    });
  },

  async getAdminGitBackupStatus(): Promise<GetAdminGitBackupStatusResponse> {
    return requestJson<GetAdminGitBackupStatusResponse>("/api/admin/git-backup/status");
  },

  async runAdminGitBackup(): Promise<RunAdminGitBackupResponse> {
    return requestJson<RunAdminGitBackupResponse>("/api/admin/git-backup/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  },

  async verifyAdminGitBackup(): Promise<VerifyAdminGitBackupResponse> {
    return requestJson<VerifyAdminGitBackupResponse>("/api/admin/git-backup/verify", {
      method: "POST",
    });
  },

  async getAdminGitRestoreStatus(): Promise<GetAdminGitRestoreStatusResponse> {
    return requestJson<GetAdminGitRestoreStatusResponse>("/api/admin/git-backup/restore-status");
  },

  async runAdminGitRestore(): Promise<RunAdminGitRestoreResponse> {
    return requestJson<RunAdminGitRestoreResponse>("/api/admin/git-backup/restore", {
      method: "POST",
    });
  },

  async updateAdminConfig(nextConfig: Partial<AdminConfig>): Promise<AdminConfig> {
    return requestJson<AdminConfig>("/api/admin/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(nextConfig),
    });
  },

  async listAgentKeys(): Promise<{ agents: { agent_id: string; display_name: string }[]; errors: string[] }> {
    return requestJson("/api/admin/agents");
  },

  async addAgentKey(displayName: string, options?: { agentId?: string }): Promise<{ agent_id: string; display_name: string; secret: string | null }> {
    return requestJson("/api/admin/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        display_name: displayName,
        ...(options?.agentId ? { agent_id: options.agentId } : {}),
      }),
    });
  },

  async deleteAgentKey(agentId: string): Promise<{ success: boolean }> {
    return requestJson(`/api/admin/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    });
  },

  async rotateAgentSecret(agentId: string): Promise<{ agent_id: string; display_name: string; secret: string }> {
    return requestJson(`/api/admin/agents/${encodeURIComponent(agentId)}/rotate-secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  },

  async getSetupInfo(): Promise<{
    defaultServerName: string;
    internalPort: number;
    mcpUrl: string;
    agent_auth_policy: AgentAuthPolicy;
    /** Stable tool key → current wire name, for `{{tool:key}}` token substitution. */
    toolKeys: Record<string, string>;
  }> {
    return requestJson("/api/setup", undefined, false);
  },

  async bootstrap(code: string): Promise<{ message?: string }> {
    return requestJson<{ message?: string }>(
      "/api/auth/bootstrap",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ code }),
      },
      false,
    );
  },

  async loginSingleUser(): Promise<AuthTokenResponse> {
    const response = await requestJson<AuthTokenResponse>(
      "/api/auth/login",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "single_user",
        }),
      },
      false,
    );
    if (response.identity?.id) {
      setWriterId(response.identity.id);
      broadcastAuthEvent("login");
    }
    return response;
  },

  async refreshAuthSession(): Promise<boolean> {
    return tryRefreshAccessToken();
  },

  async logout(): Promise<void> {
    await requestJson<{ ok: boolean }>(
      "/api/auth/logout",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      },
      false,
    );
    clearWriterId();
    broadcastAuthEvent("logout");
  },

  async getActivity(limit = 20, days = 7): Promise<GetActivityResponse> {
    return requestJson<GetActivityResponse>(`/api/activity?limit=${limit}&days=${days}`);
  },

  async createDocument(docPath: string): Promise<CreateDocumentResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<CreateDocumentResponse>(`/api/workspace/${encoded}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  },

  async deleteDocument(docPath: string): Promise<void> {
    const encoded = encodeDocPath(docPath);
    await requestJson<void>(`/api/workspace/${encoded}`, {
      method: "DELETE",
    });
  },

  async renameDocument(docPath: string, newPath: string): Promise<{ old_path: string; new_path: string; committed_head: string }> {
    const encoded = encodeDocPath(docPath);
    return requestJson<{ old_path: string; new_path: string; committed_head: string }>(`/api/workspace/${encoded}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_path: newPath }),
    });
  },

  // The agent-facing assembled committed read (canonical, read-only).
  async getDocument(docPath: string): Promise<GetDocumentResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<GetDocumentResponse>(`/api/canonical/${encoded}`);
  },

  /**
   * LIVE human drag-drop cross-section move (claim-review 03 / Option E). A
   * CONTROL-PLANE REST call — 200 is the precise success ack; 409 carries the
   * backend's prose refusal, returned VERBATIM (Area M — never a bare code) so the
   * caller can render it. DISTINCT from the agent proposal-structure move.
   */
  async liveMoveSection(
    docPath: string,
    req: { sourceHeadingPath: string[]; targetHeadingPath: string[]; position: "before" | "after" },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    await tryBootstrapSingleUserSession();
    const encoded = encodeDocPath(docPath);
    const response = await fetch(`/api/workspace/${encoded}/live-move`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Requested-With": "fetch" },
      credentials: "include",
      body: JSON.stringify({
        source_heading_path: req.sourceHeadingPath,
        target_heading_path: req.targetHeadingPath,
        position: req.position,
      }),
    });
    if (response.ok) return { ok: true };
    const text = await response.text();
    let message = `The section move was refused (${response.status}).`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (typeof parsed.message === "string" && parsed.message.trim().length > 0) message = parsed.message;
    } catch {
      // Non-JSON body — keep the default refusal message.
    }
    return { ok: false, message };
  },

  async getWorkspaceTree(options?: GetDocumentsTreeOptions): Promise<GetDocumentsTreeResponse> {
    const params = new URLSearchParams();
    if (options?.path != null) {
      params.set("path", options.path);
    }
    if (options?.recursive != null) {
      params.set("recursive", String(options.recursive));
    }
    const query = params.toString();
    const url = query.length > 0 ? `/api/workspace/tree?${query}` : "/api/workspace/tree";
    return requestJson<GetDocumentsTreeResponse>(url);
  },

  async probeSystemReady(): Promise<boolean> {
    const response = await fetch("/api/workspace/tree", {
      headers: { "X-Requested-With": "fetch" },
      credentials: "include",
    });
    return response.status !== 503;
  },

  // Working-copy structure read (in-progress proposal first, canonical fallback).
  async getWorkspaceDocumentStructure(docPath: string): Promise<ReadDocStructureResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<ReadDocStructureResponse>(`/api/workspace/${encoded}/structure`);
  },

  // Committed (canonical) structure read — the agent-facing surface.
  async getCanonicalDocumentStructure(docPath: string): Promise<ReadDocStructureResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<ReadDocStructureResponse>(`/api/canonical/${encoded}/structure`);
  },

  // Working-copy section list + content (in-progress proposal first, canonical
  // fallback). Takes no proposal parameter — proposal-scoped reads use the
  // dedicated proposal routes (`getProposalDocumentSections` / `getProposalSections`).
  async getWorkspaceDocumentSections(docPath: string): Promise<GetDocumentSectionsResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<GetDocumentSectionsResponse>(`/api/workspace/${encoded}/sections`);
  },

  // Committed (canonical) section list + content — the exact surface agents see
  // via REST. Read-only; no proposal/workspace/CRDT overlay.
  async getCanonicalDocumentSections(docPath: string): Promise<GetDocumentSectionsResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<GetDocumentSectionsResponse>(`/api/canonical/${encoded}/sections`);
  },

  // Effective proposal-scoped section list + content for a single document
  // (proposal-content-first with canonical fallback) via `ProposalReader`.
  async getProposalDocumentSections(
    proposalId: ProposalId,
    docPath: string,
  ): Promise<GetDocumentSectionsResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<GetDocumentSectionsResponse>(
      `/api/proposals/${encodeURIComponent(proposalId)}/documents/${encoded}/sections`,
    );
  },

  // Bulk read of the effective proposal-scoped sections for every document the
  // proposal targets.
  async getProposalSections(proposalId: ProposalId): Promise<GetProposalSectionsResponse> {
    return requestJson<GetProposalSectionsResponse>(
      `/api/proposals/${encodeURIComponent(proposalId)}/sections`,
    );
  },

  async searchText(options: {
    pattern: string;
    syntax: "literal" | "regexp";
    root: string;
    caseSensitive: boolean;
    maxResults: string;
    contextBytes: string;
    signal?: AbortSignal;
  }): Promise<SearchTextResponse> {
    const params = new URLSearchParams();
    params.set("pattern", options.pattern);
    params.set("syntax", options.syntax);
    params.set("root", options.root);
    params.set("case_sensitive", String(options.caseSensitive));
    params.set("max_results", options.maxResults);
    params.set("context_bytes", options.contextBytes);
    return requestJson<SearchTextResponse>(`/api/search?${params.toString()}`, {
      signal: options.signal,
    });
  },

  // --- Proposals (v3) ---

  async submitProposal(body: CreateProposalRequest, replace = false): Promise<CreateProposalResponse> {
    const query = replace ? "?replace=true" : "";
    return requestJson<CreateProposalResponse>(`/api/proposals${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  // Update the proposal MANIFEST (intent + target scope) ONLY. Staged section
  // content is written through `replaceProposalSections` / `writeProposalDocumentSections`.
  async updateProposalManifest(
    id: ProposalId,
    body: UpdateProposalManifestRequest,
  ): Promise<ReadProposalResponse> {
    return requestJson<ReadProposalResponse>(`/api/proposals/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  // Bulk staged-content replace across any number of target documents.
  async replaceProposalSections(
    id: ProposalId,
    body: ReplaceProposalSectionsRequest,
  ): Promise<ReadProposalResponse> {
    return requestJson<ReadProposalResponse>(`/api/proposals/${encodeURIComponent(id)}/sections`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  // Per-document staged-content write.
  async writeProposalDocumentSections(
    id: ProposalId,
    docPath: string,
    body: WriteProposalDocumentSectionsRequest,
  ): Promise<ReadProposalResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<ReadProposalResponse>(
      `/api/proposals/${encodeURIComponent(id)}/documents/${encoded}/sections`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  },

  async acquireLocks(id: ProposalId): Promise<AcquireLocksResponse> {
    return requestJson<AcquireLocksResponse>(`/api/proposals/${encodeURIComponent(id)}/acquire-locks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  },

  async commitProposal(id: ProposalId): Promise<CommitProposalResponse> {
    return requestJson<CommitProposalResponse>(`/api/proposals/${encodeURIComponent(id)}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  },

  async withdrawProposal(id: ProposalId, reason?: string): Promise<WithdrawProposalResponse> {
    return requestJson<WithdrawProposalResponse>(`/api/proposals/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  },

  async listProposals(status?: ProposalStatus): Promise<ListProposalsResponse> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return requestJson<ListProposalsResponse>(`/api/proposals${query}`);
  },

  /**
   * The degraded (quarantined) proposals only — server-side filtered to the
   * degradable statuses, so the home-page alert never decodes full history.
   */
  async listDegradedProposals(): Promise<ListDegradedProposalsResponse> {
    return requestJson<ListDegradedProposalsResponse>("/api/proposals/degraded");
  },

  /**
   * Admin-only: run a named defect detector's autofix on a degraded proposal,
   * returning the repaired proposal (its `degraded` marker cleared).
   */
  async autofixProposalDefect(id: ProposalId, detectorId: string): Promise<{ proposal: AnyProposal }> {
    return requestJson<{ proposal: AnyProposal }>(
      `/api/admin/proposals/${encodeURIComponent(id)}/autofix/${encodeURIComponent(detectorId)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
  },

  async listDraftProposals(): Promise<ListProposalsResponse> {
    return requestJson<ListProposalsResponse>("/api/proposals?status=draft");
  },

  async listMyProposals(status?: ProposalStatus): Promise<ListProposalsResponse> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return requestJson<ListProposalsResponse>(`/api/my-proposals${query}`);
  },

  async listMyDraftProposals(): Promise<ListProposalsResponse> {
    return requestJson<ListProposalsResponse>("/api/my-proposals?status=draft");
  },

  async getProposal(id: ProposalId): Promise<ReadProposalResponse> {
    return requestJson<ReadProposalResponse>(`/api/proposals/${encodeURIComponent(id)}`);
  },

  async cancelProposal(id: ProposalId, reason: string): Promise<WithdrawProposalResponse> {
    return requestJson<WithdrawProposalResponse>(`/api/proposals/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  },

  // --- Heatmap ---

  async getHeatmap(): Promise<GetHeatmapResponse> {
    return requestJson<GetHeatmapResponse>("/api/heatmap");
  },

  // Live durability lives in the `inprogress` proposal / DocSession; any future
  // ops summary needs a new backing query.

  // --- Git history ---

  async getGitLog(params?: { limit?: number; offset?: number; doc_path?: string }): Promise<any[]> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    if (params?.doc_path) searchParams.set("doc_path", params.doc_path);
    const qs = searchParams.toString();
    return requestJson<any[]>(`/api/git/log${qs ? `?${qs}` : ""}`);
  },

  async getGitDiff(sha: string): Promise<{ sha: string; diff_text: string; truncated: boolean }> {
    return requestJson<{ sha: string; diff_text: string; truncated: boolean }>(`/api/git/log/${encodeURIComponent(sha)}/diff`);
  },

  // --- Document version history ---

  async getDocHistory(docPath: string, opts?: { limit?: number; offset?: number }): Promise<DocHistoryResponse> {
    const encoded = encodeDocPath(docPath);
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return requestJson<DocHistoryResponse>(`/api/canonical/${encoded}/history${qs ? `?${qs}` : ""}`);
  },

  async getDocHistoryPreview(docPath: string, sha: string): Promise<DocHistoryPreviewResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<DocHistoryPreviewResponse>(`/api/canonical/${encoded}/history/${encodeURIComponent(sha)}/preview`);
  },

  async restoreDoc(docPath: string, sha: string): Promise<DocRestoreResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<DocRestoreResponse>(`/api/workspace/${encoded}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
  },

  // User-initiated force publish of a document's live in-flight edits. Returns
  // the publish outcome verbatim — a `noop`/`aborted`/`failed` outcome is a
  // normal 200 result the caller renders, not a thrown error.
  async forcePublishDocument(docPath: string): Promise<ForcePublishOutcome> {
    const encoded = encodeDocPath(docPath);
    return requestJson<ForcePublishOutcome>(`/api/workspace/${encoded}/force-publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  },

  async overwriteDoc(docPath: string, markdown: string): Promise<{ committed_sha: string }> {
    const encoded = encodeDocPath(docPath);
    return requestJson<{ committed_sha: string }>(`/api/workspace/${encoded}/overwrite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown }),
    });
  },

  // --- Import helpers ---

  async importFiles(
    targetFolder: string,
    files: { name: string; content: string }[],
  ): Promise<ImportResponse> {
    return requestJson<ImportResponse>("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_folder: targetFolder, files }),
    });
  },

  // --- Imports (staging-based pipeline) ---

  async getImports(): Promise<ImportStagingInfo[]> {
    return requestJson<ImportStagingInfo[]>("/api/imports");
  },

  async getImportDetail(id: string): Promise<ImportDetailResponse> {
    return requestJson<ImportDetailResponse>(`/api/imports/${encodeURIComponent(id)}`);
  },

  async createImport(): Promise<ImportStagingInfo> {
    return requestJson<ImportStagingInfo>("/api/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  },

  async uploadImportFiles(
    id: string,
    files: File[],
  ): Promise<{ uploaded: number }> {
    const formData = new FormData();
    for (const file of files) {
      const uploadPath = file.webkitRelativePath || file.name;
      formData.append("files", file, uploadPath);
    }
    return requestJson<{ uploaded: number }>(`/api/imports/${encodeURIComponent(id)}/upload`, {
      method: "POST",
      body: formData,
    });
  },

  async commitImport(id: string, description: string): Promise<ImportResponse> {
    return requestJson<ImportResponse>(`/api/imports/${encodeURIComponent(id)}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description }),
    });
  },

  async deleteImport(id: string): Promise<void> {
    await requestJson<void>(`/api/imports/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  // --- Agents ---

  async getAgentsSummary(): Promise<GetAgentsFullSummaryResponse> {
    return requestJson<GetAgentsFullSummaryResponse>("/api/agents/summary");
  },

  async getBlame(docPath: string, sectionFile: string): Promise<BlameResponse> {
    return requestJson<BlameResponse>(
      `/api/canonical/${encodeDocPath(docPath)}/blame/${encodeURIComponent(sectionFile)}`,
    );
  },

  // --- ACL / RBAC ---

  async getAcl(): Promise<AclSnapshot> {
    return requestJson<AclSnapshot>("/api/admin/acl");
  },

  async updateAclDefaults(defaults: SetAclDefaultsRequest): Promise<void> {
    await requestJson("/api/admin/acl/defaults", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(defaults),
    });
  },

  async setDocAcl(docPath: string, perms: SetDocumentAclRequest): Promise<void> {
    await requestJson(`/api/admin/acl/doc/${encodeDocPath(docPath)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(perms),
    });
  },

  async removeDocAcl(docPath: string): Promise<void> {
    await requestJson(`/api/admin/acl/doc/${encodeDocPath(docPath)}`, {
      method: "DELETE",
    });
  },

  async setUserRoles(userId: string, request: SetUserRolesRequest): Promise<void> {
    await requestJson(`/api/admin/roles/${encodeURIComponent(userId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  },

  async removeUserRoles(userId: string): Promise<void> {
    await requestJson(`/api/admin/roles/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
  },

  async createCustomRole(request: CreateCustomRoleRequest): Promise<void> {
    await requestJson("/api/admin/custom-roles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  },

  async deleteCustomRole(name: string): Promise<void> {
    await requestJson(`/api/admin/custom-roles/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  },

  async getAgentActivity(): Promise<{ sessions: AgentMcpSessionRecord[] }> {
    return requestJson<{ sessions: AgentMcpSessionRecord[] }>("/api/admin/agent-activity");
  },

  // --- Document diagnostics ---

  async getDocDiagnostics(docPath: string): Promise<DocDiagnosticsResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<DocDiagnosticsResponse>(`/api/workspace/${encoded}/diagnostics`);
  },
};
