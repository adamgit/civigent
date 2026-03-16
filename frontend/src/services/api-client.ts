import type {
  AdminConfig,
  AuthUser,
  ChangesSinceResponse,
  CommitProposalResponse,
  CreateDocumentResponse,
  CreateProposalRequest,
  CreateProposalResponse,
  GetActivityResponse,
  GetAdminSnapshotHealthResponse,
  GetDocumentResponse,
  GetDocumentSectionsResponse,
  GetDocumentsTreeResponse,
  GetHeatmapResponse,
  ListProposalsResponse,
  LoginProvider,
  ProposalId,
  ProposalStatus,
  PublishRequest,
  PublishResponse,
  ReadDocStructureResponse,
  ReadProposalResponse,
  ReadSectionResponse,
  SessionInfoResponse,
  UpdateProposalRequest,
  WithdrawProposalResponse,
  WriterDirtyState,
} from "../types/shared.js";

export interface ImportResponse extends CreateProposalResponse {
  created_documents: string[];
}

interface GetDocumentsTreeOptions {
  path?: string;
  recursive?: boolean;
}

const WRITER_ID_STORAGE_KEY = "ks_writer_id";
let singleUserBootstrapInFlight: Promise<boolean> | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    let message: string | undefined;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (typeof parsed.message === "string") {
        message = parsed.message;
      }
    } catch {
      // Keep plain text fallback when payload is non-JSON.
    }
    throw new Error((message ?? text) || `Request failed: ${response.status}`);
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

  const buildHeaders = () => new Headers(init?.headers);
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

  return parseJsonOrThrow<T>(response);
}

interface AuthMethodsResponse {
  methods: LoginProvider[];
}

interface HealthStatusResponse {
  ok: boolean;
}

interface AuthTokenResponse {
  token: string;
  access_token: string;
  refresh_token: string;
  identity: AuthUser;
}

interface CredentialsLoginInput {
  username?: string;
  email?: string;
  password: string;
  name?: string;
}

interface OidcLoginInput {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  username?: string;
}

interface RefreshTokenResponse {
  access_token: string;
  refresh_token: string;
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
  async getHealth(): Promise<HealthStatusResponse> {
    return requestJson<HealthStatusResponse>("/api/health", undefined, false);
  },

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

  async updateAdminConfig(nextConfig: Partial<AdminConfig>): Promise<AdminConfig> {
    return requestJson<AdminConfig>("/api/admin/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(nextConfig),
    });
  },

  async listAgentKeys(): Promise<{ agent_id: string; display_name: string }[]> {
    return requestJson("/api/admin/agents");
  },

  async addAgentKey(displayName: string, agentId?: string): Promise<{ agent_id: string; display_name: string; secret: string }> {
    return requestJson("/api/admin/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: displayName, ...(agentId ? { agent_id: agentId } : {}) }),
    });
  },

  async deleteAgentKey(agentId: string): Promise<{ success: boolean }> {
    return requestJson(`/api/admin/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    });
  },

  async getSetupInfo(): Promise<{
    defaultServerName: string;
  }> {
    return requestJson("/api/setup", undefined, false);
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

  async loginCredentials(input: CredentialsLoginInput): Promise<AuthTokenResponse> {
    const response = await requestJson<AuthTokenResponse>(
      "/api/auth/login",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "credentials",
          username: input.username,
          email: input.email,
          password: input.password,
          name: input.name,
        }),
      },
      false,
    );
    if (response.identity?.id) {
      setWriterId(response.identity.id);
    }
    return response;
  },

  async loginOidc(input: OidcLoginInput): Promise<AuthTokenResponse> {
    const response = await requestJson<AuthTokenResponse>(
      "/api/auth/login",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "oidc",
          issuer: input.issuer,
          subject: input.subject,
          email: input.email,
          name: input.name,
          username: input.username,
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
    const encoded = encodeURIComponent(docPath);
    return requestJson<CreateDocumentResponse>(`/api/documents/${encoded}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  },

  async renameDocument(docPath: string, newPath: string): Promise<{ old_path: string; new_path: string; committed_head: string }> {
    const encoded = encodeURIComponent(docPath);
    return requestJson<{ old_path: string; new_path: string; committed_head: string }>(`/api/documents/${encoded}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_path: newPath }),
    });
  },

  async getDocument(docPath: string): Promise<GetDocumentResponse> {
    const encoded = encodeURIComponent(docPath);
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
    const encoded = encodeURIComponent(docPath);
    return requestJson<ReadDocStructureResponse>(`/api/documents/${encoded}/structure`);
  },

  async getDocumentSections(docPath: string): Promise<GetDocumentSectionsResponse> {
    const encoded = encodeURIComponent(docPath);
    return requestJson<GetDocumentSectionsResponse>(`/api/documents/${encoded}/sections`);
  },

  async getChangesSince(docPath: string, afterHead?: string): Promise<ChangesSinceResponse> {
    const encoded = encodeURIComponent(docPath);
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

  async publish(body?: PublishRequest): Promise<PublishResponse> {
    return requestJson<PublishResponse>("/api/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  },
};
