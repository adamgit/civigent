import { encodeDocPath } from "../utils/path-encoding.js";
import type {
  AdminConfig,
  AuthUser,
  BlameResponse,
  ChangesSinceResponse,
  CommitProposalResponse,
  CreateDocumentResponse,
  CreateProposalRequest,
  CreateProposalResponse,
  GetActivityResponse,
  GetAdminSnapshotHealthResponse,
  GetAdminSnapshotHistoryResponse,
  GetAgentsFullSummaryResponse,
  GetDocumentResponse,
  GetDocumentSectionsResponse,
  GetDocumentsTreeResponse,
  GetHeatmapResponse,
  ListProposalsResponse,
  AuthMethod,
  ProposalId,
  ProposalStatus,
  PublishRequest,
  PublishResponse,
  ReadDocStructureResponse,
  ReadProposalResponse,
  ReadSectionResponse,
  SessionInfoResponse,
  UpdateProposalRequest,
  AcquireLocksResponse,
  WithdrawProposalResponse,
  WriterDirtyState,
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
}

export interface DocRestoreResponse {
  committed_sha?: string;
  proposal_id?: string;
  blocked_sections?: Array<{
    doc_path: string;
    heading_path: string[];
    humanInvolvement_score: number;
    blocked: boolean;
  }>;
}

export interface DiagLayerStatus {
  exists: boolean;
  byteLength: number | null;
  contentPreview: string | null;
  error: string | null;
}

export interface DiagSectionLayerInfo {
  headingKey: string;
  headingPath: string[];
  sectionFile: string;
  isSubSkeleton: boolean;
  canonical: DiagLayerStatus;
  overlay: DiagLayerStatus;
  fragment: DiagLayerStatus;
  crdt: DiagLayerStatus;
  winner: string;
  gitHistoryExists?: boolean | null;
  error?: string;
}

export interface DiagHealthCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface DocDiagnosticsResponse {
  doc_path: string;
  checks: DiagHealthCheck[];
  sections: DiagSectionLayerInfo[];
}

interface GetDocumentsTreeOptions {
  path?: string;
  recursive?: boolean;
}

const WRITER_ID_STORAGE_KEY = "ks_writer_id";
let singleUserBootstrapInFlight: Promise<boolean> | null = null;
let unauthorizedHandler: (() => void) | null = null;
let systemStartingHandler: (() => void) | null = null;

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
  access_token: string;
  refresh_token: string;
}

export interface AclSnapshot {
  defaults: { read: string; write: string };
  acl: Record<string, { read?: string; write?: string }>;
  roles: Record<string, string[]>;
  customRoles: string[];
}

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

async function tryRefreshAccessToken(): Promise<boolean> {
  const response = await fetch("/api/auth/token/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: "{}",
    credentials: "include",
  });
  if (!response.ok) {
    return false;
  }
  const payload = (await response.json()) as RefreshTokenResponse;
  if (!payload.access_token || !payload.refresh_token) {
    return false;
  }
  return true;
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

  async addAgentKey(displayName: string, options?: { agentId?: string; generateSecret?: boolean }): Promise<{ agent_id: string; display_name: string; secret: string | null }> {
    return requestJson("/api/admin/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        display_name: displayName,
        ...(options?.agentId ? { agent_id: options.agentId } : {}),
        ...(options?.generateSecret === false ? { generate_secret: false } : {}),
      }),
    });
  },

  async deleteAgentKey(agentId: string): Promise<{ success: boolean }> {
    return requestJson(`/api/admin/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    });
  },

  async getSetupInfo(): Promise<{
    defaultServerName: string;
    internalPort: number;
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
    }
    return response;
  },

  async refreshAuthSession(): Promise<RefreshTokenResponse> {
    const response = await requestJson<RefreshTokenResponse>(
      "/api/auth/token/refresh",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      },
      false,
    );
    return response;
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
  },

  async getActivity(limit = 20, days = 7): Promise<GetActivityResponse> {
    return requestJson<GetActivityResponse>(`/api/activity?limit=${limit}&days=${days}`);
  },

  async createDocument(docPath: string): Promise<CreateDocumentResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<CreateDocumentResponse>(`/api/documents/${encoded}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  },

  async deleteDocument(docPath: string): Promise<void> {
    const encoded = encodeDocPath(docPath);
    await requestJson<void>(`/api/documents/${encoded}`, {
      method: "DELETE",
    });
  },

  async renameDocument(docPath: string, newPath: string): Promise<{ old_path: string; new_path: string; committed_head: string }> {
    const encoded = encodeDocPath(docPath);
    return requestJson<{ old_path: string; new_path: string; committed_head: string }>(`/api/documents/${encoded}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_path: newPath }),
    });
  },

  async getDocument(docPath: string): Promise<GetDocumentResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<GetDocumentResponse>(`/api/documents/${encoded}`);
  },

  async getDocumentsTree(options?: GetDocumentsTreeOptions): Promise<GetDocumentsTreeResponse> {
    const params = new URLSearchParams();
    if (options?.path != null) {
      params.set("path", options.path);
    }
    if (options?.recursive != null) {
      params.set("recursive", String(options.recursive));
    }
    const query = params.toString();
    const url = query.length > 0 ? `/api/documents/tree?${query}` : "/api/documents/tree";
    return requestJson<GetDocumentsTreeResponse>(url);
  },

  async getDocumentStructure(docPath: string): Promise<ReadDocStructureResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<ReadDocStructureResponse>(`/api/documents/${encoded}/structure`);
  },

  async getDocumentSections(docPath: string): Promise<GetDocumentSectionsResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<GetDocumentSectionsResponse>(`/api/documents/${encoded}/sections`);
  },

  async getChangesSince(docPath: string, afterHead?: string): Promise<ChangesSinceResponse> {
    const encoded = encodeDocPath(docPath);
    const params = afterHead ? `?after_head=${encodeURIComponent(afterHead)}` : "";
    return requestJson<ChangesSinceResponse>(`/api/documents/${encoded}/changes-since${params}`);
  },

  async readSection(docPath: string, headingPath: string[]): Promise<ReadSectionResponse> {
    const params = new URLSearchParams();
    params.set("doc_path", docPath);
    params.set("heading_path", headingPath.join("/"));
    return requestJson<ReadSectionResponse>(`/api/sections?${params.toString()}`);
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

  async updateProposal(id: ProposalId, body: UpdateProposalRequest): Promise<ReadProposalResponse> {
    return requestJson<ReadProposalResponse>(`/api/proposals/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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

  // --- Writer dirty state ---

  async getWriterDirtyState(writerId: string): Promise<WriterDirtyState> {
    return requestJson<WriterDirtyState>(`/api/writers/${encodeURIComponent(writerId)}/dirty`);
  },

  // --- Session state ---

  async getSessionState(): Promise<any> {
    return requestJson<any>("/api/admin/session-state");
  },

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
    return requestJson<DocHistoryResponse>(`/api/documents/${encoded}/history${qs ? `?${qs}` : ""}`);
  },

  async getDocHistoryPreview(docPath: string, sha: string): Promise<DocHistoryPreviewResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<DocHistoryPreviewResponse>(`/api/documents/${encoded}/history/${encodeURIComponent(sha)}/preview`);
  },

  async restoreDoc(docPath: string, sha: string): Promise<DocRestoreResponse> {
    const encoded = encodeDocPath(docPath);
    return requestJson<DocRestoreResponse>(`/api/documents/${encoded}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
  },

  async overwriteDoc(docPath: string, markdown: string): Promise<{ committed_sha: string }> {
    const encoded = encodeDocPath(docPath);
    return requestJson<{ committed_sha: string }>(`/api/documents/${encoded}/overwrite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown }),
    });
  },

  // --- Publish ---

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

  async publish(body?: PublishRequest): Promise<PublishResponse> {
    return requestJson<PublishResponse>("/api/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  },

  // --- Agents ---

  async getAgentsSummary(): Promise<GetAgentsFullSummaryResponse> {
    return requestJson<GetAgentsFullSummaryResponse>("/api/agents/summary");
  },

  async getBlame(docPath: string, sectionFile: string): Promise<BlameResponse> {
    return requestJson<BlameResponse>(
      `/api/documents/${encodeDocPath(docPath)}/blame/${encodeURIComponent(sectionFile)}`,
    );
  },

  // --- ACL / RBAC ---

  async getAcl(): Promise<AclSnapshot> {
    return requestJson<AclSnapshot>("/api/admin/acl");
  },

  async updateAclDefaults(defaults: { read?: string; write?: string }): Promise<void> {
    await requestJson("/api/admin/acl/defaults", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(defaults),
    });
  },

  async setDocAcl(docPath: string, perms: { read?: string; write?: string }): Promise<void> {
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

  async setUserRoles(userId: string, roles: string[]): Promise<void> {
    await requestJson(`/api/admin/roles/${encodeURIComponent(userId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles }),
    });
  },

  async removeUserRoles(userId: string): Promise<void> {
    await requestJson(`/api/admin/roles/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
  },

  async createCustomRole(name: string): Promise<void> {
    await requestJson("/api/admin/custom-roles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
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
    return requestJson<DocDiagnosticsResponse>(`/api/documents/${encoded}/diagnostics`);
  },
};
