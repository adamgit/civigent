import { useEffect, useRef, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { AgentCard } from "../components/agents/AgentCard.js";
import { AgentCardExpanded } from "../components/agents/AgentCardExpanded.js";
import type { AgentCardViewModel } from "../components/agents/types.js";
import { avatarHueFromId } from "../components/agents/utils.js";
import { apiClient } from "../services/api-client";
import type { AdminConfig, AgentAuthPolicy, GetAgentsFullSummaryResponse } from "../types/shared.js";
import "./agents-page.css";

function buildViewModels(response: GetAgentsFullSummaryResponse): AgentCardViewModel[] {
  return response.agents.map((agent) => {
    const hue = avatarHueFromId(agent.agent_id);
    const letter = (agent.display_name.trim()[0] ?? "?").toUpperCase();
    return {
      id: agent.agent_id,
      displayName: agent.display_name,
      avatarLetter: letter,
      avatarHue: hue,
      connectionStatus: agent.connection_status,
      lastSeenAt: agent.last_seen_at,
      currentActivityHtml: "",
      activeDocuments: [],
      mcpToolUsage: agent.mcp_tool_usage,
      pendingProposals: agent.draft_proposals,
      recentProposals: agent.recent_proposals,
      stats: agent.stats,
    };
  });
}

// ─── Policy badge ───────────────────────────────────────────────

const POLICY_BADGE: Record<AgentAuthPolicy, { label: string; color: string; bg: string; title: string }> = {
  open:     { label: "open",     color: "#7f1d1d", bg: "#fee2e2", title: "Any agent can self-register. Anonymous identities are allowed." },
  register: { label: "register", color: "#92400e", bg: "#fef3c7", title: "Only pre-registered agents can connect. Presenting the registered client_id is sufficient." },
  verify:   { label: "verify",   color: "#166534", bg: "#dcfce7", title: "Pre-registration required AND the agent must prove possession of its client_secret at the token endpoint." },
};

function PolicyBadge({ policy }: { policy: AgentAuthPolicy }) {
  const { label, color, bg, title } = POLICY_BADGE[policy];
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "0.15rem 0.55rem",
        borderRadius: "999px",
        fontSize: "0.75rem",
        fontWeight: 600,
        color,
        background: bg,
        verticalAlign: "middle",
        cursor: "default",
        letterSpacing: "0.02em",
      }}
    >
      {label}
    </span>
  );
}

// ─── Credential copy row ────────────────────────────────────────

function CredRow({
  label, value, fieldKey, copiedField, onCopy,
}: {
  label: string;
  value: string;
  fieldKey: string;
  copiedField: string | null;
  onCopy: (value: string, key: string) => void;
}) {
  return (
    <div className="add-agent-dialog__cred-row">
      <span className="add-agent-dialog__cred-label">{label}</span>
      <code className="add-agent-dialog__cred-value">{value}</code>
      <button className="add-agent-dialog__copy-btn" onClick={() => onCopy(value, fieldKey)}>
        {copiedField === fieldKey ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// ─── Connection instructions ────────────────────────────────────

type InstructionTab = "claude-code" | "cursor" | "other";

function ConnectionInstructions({
  agentId, secret, policy, mcpUrl,
}: {
  agentId: string;
  secret: string | null;
  policy: AgentAuthPolicy;
  mcpUrl: string;
}) {
  const [tab, setTab] = useState<InstructionTab>("claude-code");
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyField = async (value: string, field: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const tabBtn = (t: InstructionTab, label: string) => (
    <button
      className={`add-agent-dialog__tab-btn${tab === t ? " add-agent-dialog__tab-btn--active" : ""}`}
      onClick={() => setTab(t)}
    >
      {label}
    </button>
  );

  const claudeCodeCmd = policy === "verify" && secret
    ? `claude mcp add --transport http --client-id ${agentId} --client-secret ${secret} my-agent ${mcpUrl}`
    : `claude mcp add --transport http --client-id ${agentId} my-agent ${mcpUrl}`;

  const cursorConfig = JSON.stringify(
    {
      mcpServers: {
        "my-agent": {
          url: mcpUrl,
          auth: {
            CLIENT_ID: agentId,
            ...(policy === "verify" && secret ? { CLIENT_SECRET: secret } : {}),
          },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="add-agent-dialog__instructions">
      <p className="add-agent-dialog__instructions-heading">Connection instructions</p>
      <div className="add-agent-dialog__tabs">
        {tabBtn("claude-code", "Claude Code")}
        {tabBtn("cursor", "Cursor")}
        {tabBtn("other", "Other")}
      </div>

      {tab === "claude-code" && (
        <div>
          <p className="add-agent-dialog__tab-hint">Run this in your terminal (replace <code>my-agent</code> with your preferred name):</p>
          <div className="add-agent-dialog__code-block">
            <code>{claudeCodeCmd}</code>
            <button className="add-agent-dialog__copy-btn" onClick={() => copyField(claudeCodeCmd, "claude-cmd")}>
              {copiedField === "claude-cmd" ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="add-agent-dialog__tab-hint">A browser window will open for the consent step, then the agent is connected.</p>
        </div>
      )}

      {tab === "cursor" && (
        <div>
          <p className="add-agent-dialog__tab-hint">Add to <code>~/.cursor/mcp.json</code> or <code>.cursor/mcp.json</code> in your project:</p>
          <div className="add-agent-dialog__code-block add-agent-dialog__code-block--pre">
            <pre>{cursorConfig}</pre>
            <button className="add-agent-dialog__copy-btn" onClick={() => copyField(cursorConfig, "cursor-cfg")}>
              {copiedField === "cursor-cfg" ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="add-agent-dialog__tab-hint">Cursor opens a browser for the consent step automatically.</p>
        </div>
      )}

      {tab === "other" && (
        <div className="add-agent-dialog__other-creds">
          <CredRow label="MCP server URL" value={mcpUrl} fieldKey="url" copiedField={copiedField} onCopy={copyField} />
          <CredRow label="Client ID" value={agentId} fieldKey="id" copiedField={copiedField} onCopy={copyField} />
          {secret && (
            <div className="add-agent-dialog__cred-row add-agent-dialog__cred-row--secret">
              <span className="add-agent-dialog__cred-label">Client secret</span>
              <code className="add-agent-dialog__cred-value">{secret}</code>
              <button className="add-agent-dialog__copy-btn" onClick={() => copyField(secret, "secret")}>
                {copiedField === "secret" ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          <div className="add-agent-dialog__cred-row">
            <span className="add-agent-dialog__cred-label">Token endpoint</span>
            <code className="add-agent-dialog__cred-value">{mcpUrl.replace("/mcp", "")}/oauth/token</code>
            <button className="add-agent-dialog__copy-btn" onClick={() => copyField(`${mcpUrl.replace("/mcp", "")}/oauth/token`, "token-ep")}>
              {copiedField === "token-ep" ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="add-agent-dialog__cred-row">
            <span className="add-agent-dialog__cred-label">Authorize endpoint</span>
            <code className="add-agent-dialog__cred-value">{mcpUrl.replace("/mcp", "")}/oauth/authorize</code>
            <button className="add-agent-dialog__copy-btn" onClick={() => copyField(`${mcpUrl.replace("/mcp", "")}/oauth/authorize`, "auth-ep")}>
              {copiedField === "auth-ep" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Add agent dialog ───────────────────────────────────────────

function AddAgentDialog({
  policy,
  mcpUrl,
  onDone,
}: {
  policy: AgentAuthPolicy;
  mcpUrl: string;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alsoGenerateSecret, setAlsoGenerateSecret] = useState(false);
  const [result, setResult] = useState<{ agentId: string; secret: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      const generateSecret = policy === "verify" || alsoGenerateSecret;
      const created = await apiClient.addAgentKey(trimmed, { generateSecret });
      setResult({ agentId: created.agent_id, secret: created.secret });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const dialogTitle = policy === "open"
    ? "Register agent identity"
    : "Authenticate new agent";

  const policyHint = policy === "open"
    ? "Your agents already connect anonymously — register for a stable, auditable identity."
    : policy === "register"
      ? "Agents must be pre-registered to connect. No secret needed unless using headless/CI mode."
      : "Agents must present a client_secret at the token endpoint. Both credentials are required.";

  return (
    <div className="add-agent-dialog-backdrop" onClick={onDone}>
      <div className="add-agent-dialog add-agent-dialog--wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="add-agent-dialog__title">{dialogTitle}</h2>

        {!result ? (
          <>
            <p className="add-agent-dialog__policy-hint">{policyHint}</p>
            <form onSubmit={handleSubmit} className="add-agent-dialog__form">
              <input
                ref={inputRef}
                type="text"
                placeholder="Agent display name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="add-agent-dialog__input"
              />

              {policy === "register" && (
                <label className="add-agent-dialog__toggle-row">
                  <input
                    type="checkbox"
                    checked={alsoGenerateSecret}
                    onChange={(e) => setAlsoGenerateSecret(e.target.checked)}
                  />
                  <span>Also generate a client secret (for CI / headless agents)</span>
                </label>
              )}

              {error && <p className="add-agent-dialog__error">{error}</p>}
              <div className="add-agent-dialog__actions">
                <button type="button" onClick={onDone} className="add-agent-dialog__btn add-agent-dialog__btn--cancel">
                  Cancel
                </button>
                <button type="submit" disabled={adding || !name.trim()} className="add-agent-dialog__btn add-agent-dialog__btn--submit">
                  {adding ? "Creating..." : "Create agent"}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="add-agent-dialog__secret">
            {result.secret && (
              <p className="add-agent-dialog__secret-intro">
                Agent created. The secret is shown <strong>once only</strong> — copy it now.
              </p>
            )}
            {!result.secret && (
              <p className="add-agent-dialog__secret-intro">
                Agent created. Connect using the instructions below.
              </p>
            )}

            <div className="add-agent-dialog__cred-rows">
              <div className="add-agent-dialog__cred-row">
                <span className="add-agent-dialog__cred-label">Client ID</span>
                <code className="add-agent-dialog__cred-value">{result.agentId}</code>
                <button
                  className="add-agent-dialog__copy-btn"
                  onClick={async () => { await navigator.clipboard.writeText(result.agentId); }}
                >
                  Copy
                </button>
              </div>
              {result.secret && (
                <div className="add-agent-dialog__cred-row add-agent-dialog__cred-row--secret">
                  <span className="add-agent-dialog__cred-label">Client secret</span>
                  <code className="add-agent-dialog__cred-value">{result.secret}</code>
                  <button
                    className="add-agent-dialog__copy-btn"
                    onClick={async () => { await navigator.clipboard.writeText(result.secret!); }}
                  >
                    Copy
                  </button>
                </div>
              )}
            </div>

            <ConnectionInstructions
              agentId={result.agentId}
              secret={result.secret}
              policy={policy}
              mcpUrl={mcpUrl}
            />

            <div className="add-agent-dialog__actions">
              <button onClick={onDone} className="add-agent-dialog__btn add-agent-dialog__btn--submit">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────

export function AgentsPage() {
  const [data, setData] = useState<GetAgentsFullSummaryResponse | null>(null);
  const [adminConfig, setAdminConfig] = useState<AdminConfig | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);

  const loadAgents = () => {
    setLoading(true);
    setError(null);
    Promise.all([apiClient.getAgentsSummary(), apiClient.getAdminConfig(), apiClient.getSetupInfo()])
      .then(([res, cfg, setup]) => {
        setData(res);
        setAdminConfig(cfg);
        setMcpUrl(setup.mcpUrl);
      })
      .catch((err) => { setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { setLoading(false); });
  };

  useEffect(() => { loadAgents(); }, []);

  const viewModels = data ? buildViewModels(data) : [];
  const policy: AgentAuthPolicy = adminConfig?.agent_auth_policy ?? "open";

  return (
    <section>
      <SharedPageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            <span>Agents</span>
            {adminConfig ? (
              <>
                <span className="text-xs font-medium text-text-muted">Agent auth policy:</span>
                <PolicyBadge policy={policy} />
              </>
            ) : null}
          </span>
        }
      />

      {loading ? (
        <p className="px-4 text-sm text-gray-500">Loading agents...</p>
      ) : null}

      {error ? (
        <p className="px-4 text-sm text-error">{error}</p>
      ) : null}

      {!loading && !error ? (
        <div className="agents-grid">
          {viewModels.flatMap((vm) => {
            const items = [
              <AgentCard
                key={vm.id}
                vm={vm}
                onClick={() => setExpandedId(expandedId === vm.id ? null : vm.id)}
              />,
            ];
            if (expandedId === vm.id) {
              items.push(
                <div key={`${vm.id}-expanded`} className="agents-card-expanded-row">
                  <AgentCardExpanded vm={vm} />
                </div>,
              );
            }
            return items;
          })}
          <button
            className="agents-card agents-card--add-new"
            onClick={() => setShowAddDialog(true)}
          >
            <span className="agents-card__add-icon">+</span>
            <span className="agents-card__add-label">
              {policy === "open" ? "Register agent identity" : "Authenticate new agent"}
            </span>
          </button>
        </div>
      ) : null}

      {showAddDialog ? (
        <AddAgentDialog
          policy={policy}
          mcpUrl={mcpUrl || `${window.location.origin}/mcp`}
          onDone={() => { setShowAddDialog(false); loadAgents(); }}
        />
      ) : null}
    </section>
  );
}
