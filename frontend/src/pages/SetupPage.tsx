import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type { AgentAuthPolicy } from "../types/shared.js";
import { copyTextToClipboard } from "../utils/copy-text";
import skillTemplate from "../agentskills/skill.md?raw";
import cursorRuleTemplate from "../agentskills/cursor-rule.md?raw";

type Tab = "claude-code" | "cursor";

interface SetupInfo {
  defaultServerName: string;
  internalPort: number;
  mcpUrl: string;
  /** Stable tool key → current wire name, for `{{tool:key}}` token substitution. */
  toolKeys: Record<string, string>;
}

interface RegisteredIdentity {
  agentId: string;
  secret: string | null;
  displayName: string;
}

/**
 * Render a served agent-skill template: substitute `%%name%%` (server name) and
 * `{{tool:key}}` tokens (current wire tool names). The `.md` files carry stable
 * keys only; the wire name lives solely in the tool registry and arrives here via
 * `/api/setup`. An unknown key is left as its literal token so a template/registry
 * mismatch is visible rather than silently swallowed.
 */
function renderTemplate(
  template: string,
  serverName: string,
  toolKeys: Record<string, string>,
): string {
  return template
    .replaceAll("%%name%%", serverName)
    .replace(/\{\{tool:([a-zA-Z0-9]+)\}\}/g, (match, key: string) => toolKeys[key] ?? match);
}

/** mcp__<name>__<tool>  —  longest tool is write_proposal_section (22 chars) */
const MCP_PREFIX_OVERHEAD = 5 + 2; // "mcp__" + "__"
const LONGEST_TOOL_NAME = 22; // write_proposal_section
const CURSOR_COMBINED_LIMIT = 60;
const MAX_SERVER_NAME = CURSOR_COMBINED_LIMIT - MCP_PREFIX_OVERHEAD - LONGEST_TOOL_NAME; // 35

function validateServerName(name: string): string | null {
  if (!name.trim()) return "Name cannot be empty";
  if (!/^[a-zA-Z0-9][-a-zA-Z0-9]*$/.test(name))
    return "Must start with a letter or digit and contain only letters, digits, and hyphens";
  if (name.length > MAX_SERVER_NAME)
    return `Name too long for Cursor (max ${MAX_SERVER_NAME} chars). Cursor requires the combined server + tool name to be under ${CURSOR_COMBINED_LIMIT} characters, and our longest tool name (write_proposal_section) uses ${LONGEST_TOOL_NAME}.`;
  return null;
}

function CopyBlock({
  label,
  content,
  maxHeight,
}: {
  label?: string;
  content: string;
  maxHeight?: number;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const didCopy = await copyTextToClipboard(content);
    if (!didCopy) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ marginBottom: "1rem" }}>
      {label && <p style={{ margin: "0 0 0.3rem", fontWeight: 500, fontSize: "0.9rem" }}>{label}</p>}
      <div className="code-block-dark" style={{ position: "relative", padding: "0.8rem 1rem" }}>
        <pre
          style={{
            margin: 0,
            color: "#d4d4d4",
            fontSize: "0.85rem",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            paddingRight: "3rem",
            maxHeight: maxHeight ?? undefined,
            overflow: maxHeight ? "auto" : undefined,
          }}
        >
          {content}
        </pre>
        <button
          onClick={handleCopy}
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            background: copied ? "#4caf50" : "#555",
            color: "white",
            border: "none",
            borderRadius: 4,
            padding: "0.2rem 0.5rem",
            fontSize: "0.75rem",
            cursor: "pointer",
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function CredCopyRow({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const didCopy = await copyTextToClipboard(value);
    if (!didCopy) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "7rem 1fr auto",
        alignItems: "center",
        gap: "0.5rem",
        background: emphasize ? "#fef9ec" : "#f9fafb",
        border: `1px solid ${emphasize ? "#fde68a" : "var(--color-footer-border)"}`,
        borderRadius: "0.375rem",
        padding: "0.4rem 0.6rem",
      }}
    >
      <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>{label}</span>
      <code style={{ fontSize: "0.78rem", wordBreak: "break-all", color: "var(--color-text-primary)" }}>{value}</code>
      <button
        type="button"
        onClick={handleCopy}
        style={{
          padding: "0.2rem 0.5rem",
          fontSize: "0.75rem",
          background: "var(--color-footer-border)",
          border: "none",
          borderRadius: "0.25rem",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function AgentRegistrationSection({
  policy,
  registered,
  onRegistered,
  onClear,
}: {
  policy: AgentAuthPolicy;
  registered: RegisteredIdentity | null;
  onRegistered: (identity: RegisteredIdentity) => void;
  onClear: () => void;
}) {
  const required = policy !== "open";
  const [name, setName] = useState("");
  const [alsoGenerateSecret, setAlsoGenerateSecret] = useState(false);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!registered) inputRef.current?.focus();
  }, [registered]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    setFormError(null);
    try {
      const generateSecret = policy === "verify" || alsoGenerateSecret;
      const created = await apiClient.addAgentKey(trimmed, { generateSecret });
      onRegistered({
        agentId: created.agent_id,
        secret: created.secret,
        displayName: created.display_name,
      });
      setName("");
      setAlsoGenerateSecret(false);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const title = policy === "open"
    ? "Optional: Register agent identity"
    : "Register agent identity";

  const hint = policy === "open"
    ? "Your agents can connect anonymously — register only if you want a stable, auditable identity. Connection commands below update when you register."
    : policy === "register"
      ? "Required for this server. Agents must be pre-registered to connect. No secret needed unless using headless/CI mode."
      : "Required for this server. Agents must present a client_secret at the token endpoint. Both credentials are required.";

  return (
    <div
      style={{
        marginBottom: "1.75rem",
        padding: "1rem 1.1rem",
        borderRadius: 8,
        border: required
          ? "1.5px solid #f59e0b"
          : "1px dashed var(--color-footer-border)",
        background: required ? "#fffbeb" : "#fafafa",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.45rem", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>
          {title}
        </h2>
        <span
          style={{
            display: "inline-block",
            padding: "0.12rem 0.5rem",
            borderRadius: 999,
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.02em",
            color: required ? "#92400e" : "#4b5563",
            background: required ? "#fde68a" : "#e5e7eb",
          }}
        >
          {required ? "Required" : "Optional"}
        </span>
      </div>
      <p style={{ margin: "0 0 0.9rem", fontSize: "0.88rem", color: "#666" }}>{hint}</p>

      {registered ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#333" }}>
            Registered <strong>{registered.displayName}</strong>
            {registered.secret
              ? <> — secret is shown <strong>once only</strong>; copy it now.</>
              : ". Connection commands below use this identity."}
          </p>
          <CredCopyRow label="Client ID" value={registered.agentId} />
          {registered.secret && (
            <CredCopyRow label="Client secret" value={registered.secret} emphasize />
          )}
          <div>
            <button
              type="button"
              onClick={onClear}
              style={{
                marginTop: "0.25rem",
                padding: "0.35rem 0.75rem",
                fontSize: "0.85rem",
                background: "transparent",
                border: "1px solid var(--color-footer-border)",
                borderRadius: 6,
                cursor: "pointer",
                color: "var(--color-text-secondary)",
              }}
            >
              Register a different agent
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
          <input
            ref={inputRef}
            type="text"
            placeholder="Agent display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-field"
            style={{ width: "100%", maxWidth: 420 }}
          />

          {policy === "register" && (
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.88rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={alsoGenerateSecret}
                onChange={(e) => setAlsoGenerateSecret(e.target.checked)}
              />
              <span>Also generate a client secret (for CI / headless agents)</span>
            </label>
          )}

          {formError && <p className="text-error" style={{ margin: 0 }}>{formError}</p>}

          <div>
            <button
              type="submit"
              disabled={adding || !name.trim()}
              style={{
                padding: "0.45rem 1rem",
                border: "none",
                borderRadius: 6,
                fontSize: "0.9rem",
                cursor: adding || !name.trim() ? "not-allowed" : "pointer",
                opacity: adding || !name.trim() ? 0.5 : 1,
                background: "var(--color-accent)",
                color: "white",
              }}
            >
              {adding ? "Creating..." : "Create agent"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function SetupPage() {
  const [searchParams] = useSearchParams();
  const preAuthClientId = searchParams.get("client-id") ?? null;

  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [policy, setPolicy] = useState<AgentAuthPolicy>("open");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("claude-code");
  const [serverName, setServerName] = useState("");
  const [connectionOrigin, setConnectionOrigin] = useState<"external" | "container">("external");
  const [registered, setRegistered] = useState<RegisteredIdentity | null>(null);

  const mcpEndpoint = connectionOrigin === "container" && info
    ? `http://localhost:${info.internalPort}/mcp`
    : (info?.mcpUrl ?? `${window.location.origin}/mcp`);

  const clientId = registered?.agentId ?? preAuthClientId;
  const clientSecret = registered?.secret ?? null;
  const registrationRequired = policy !== "open";
  const awaitingRegistration = registrationRequired && !clientId;

  const load = useCallback(async () => {
    try {
      const [data, adminCfg] = await Promise.all([apiClient.getSetupInfo(), apiClient.getAdminConfig()]);
      setInfo(data);
      setServerName(data.defaultServerName);
      setPolicy(adminCfg.agent_auth_policy);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const nameError = useMemo(() => validateServerName(serverName), [serverName]);

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: "0.5rem 1.2rem",
    border: "none",
    borderBottom: tab === t ? "2px solid var(--color-accent)" : "2px solid transparent",
    background: "none",
    cursor: "pointer",
    fontWeight: tab === t ? 600 : 400,
    fontSize: "0.95rem",
    color: tab === t ? "var(--color-accent)" : "var(--color-text-secondary)",
  });

  const needsClientSecret = policy === "verify";

  const claudeConnectCmd = clientId
    ? (needsClientSecret
        ? `claude mcp add --transport http --client-id ${clientId} --client-secret ${serverName} ${mcpEndpoint}`
        : `claude mcp add --transport http --client-id ${clientId} ${serverName} ${mcpEndpoint}`)
    : `claude mcp add --transport http ${serverName} ${mcpEndpoint}`;

  const cursorConfig = JSON.stringify(
    clientId
      ? {
          mcpServers: {
            [serverName]: {
              url: mcpEndpoint,
              auth: {
                CLIENT_ID: clientId,
                ...(needsClientSecret
                  ? { CLIENT_SECRET: clientSecret ?? "<your-secret>" }
                  : {}),
              },
            },
          },
        }
      : { mcpServers: { [serverName]: { url: mcpEndpoint } } },
    null,
    2,
  );

  return (
    <>
      <SharedPageHeader title="Connect an Agent" backTo="/" />

      <section style={{ maxWidth: 1100, margin: "0 auto", padding: "1rem 1.5rem 2.5rem" }}>
        {error && <p className="text-error" style={{ marginBottom: "1rem" }}>{error}</p>}

        {!info ? (
          <p style={{ color: "#888" }}>Loading setup info...</p>
        ) : (
          <>
            <p style={{ color: "#555", marginBottom: "1.25rem" }}>
              Connect your AI agent to this Knowledge Store. Both Claude Code and Cursor
              handle OAuth automatically — just provide the URL.
            </p>

            <AgentRegistrationSection
              policy={policy}
              registered={registered}
              onRegistered={setRegistered}
              onClear={() => setRegistered(null)}
            />

            {awaitingRegistration ? (
              <p style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "0.75rem 1rem", fontSize: "0.9rem" }}>
                Register an agent identity above to unlock the connection commands for this server.
              </p>
            ) : (
              <>
                {/* Server name input */}
                <div style={{ marginBottom: "1.5rem" }}>
                  <label style={{ display: "block", fontWeight: 500, fontSize: "0.9rem", marginBottom: "0.3rem" }}>
                    Server name
                  </label>
                  <p style={{ color: "#888", fontSize: "0.8rem", margin: "0 0 0.4rem" }}>
                    Identifies this connection in your agent config. Change it if you connect to multiple Knowledge Store instances.
                  </p>
                  <input
                    type="text"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    className="input-field"
                    style={{ width: "100%", maxWidth: 350, border: nameError ? `1.5px solid var(--color-status-red)` : undefined }}
                  />
                  {nameError && (
                    <p className="text-error" style={{ margin: "0.3rem 0 0" }}>{nameError}</p>
                  )}
                  <p style={{ color: "#aaa", fontSize: "0.75rem", margin: "0.3rem 0 0" }}>
                    {serverName.length}/{MAX_SERVER_NAME} characters
                  </p>
                </div>

                {/* Connection origin selector */}
                <div style={{ marginBottom: "1.5rem" }}>
                  <label style={{ display: "block", fontWeight: 500, fontSize: "0.9rem", marginBottom: "0.3rem" }}>
                    Where does the agent run?
                  </label>
                  <select
                    value={connectionOrigin}
                    onChange={(e) => setConnectionOrigin(e.target.value as "external" | "container")}
                    className="input-field"
                    style={{ width: "100%", maxWidth: 350 }}
                  >
                    <option value="external">This machine or remote</option>
                    <option value="container">Inside app container</option>
                  </select>
                  <p style={{ color: "#888", fontSize: "0.78rem", margin: "0.3rem 0 0" }}>
                    {connectionOrigin === "external"
                      ? "Agent runs on your computer, CI, or another server"
                      : "Agent is installed inside this application's Docker container"}
                  </p>
                </div>

                {clientId && (
                  <p style={{ margin: "0 0 1rem", fontSize: "0.85rem", color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "0.55rem 0.75rem" }}>
                    Connection commands below use client ID <code>{clientId}</code>
                    {registered ? ` (${registered.displayName})` : ""}.
                  </p>
                )}

                <div style={{ borderBottom: "1px solid var(--color-footer-border)", marginBottom: "1.5rem" }}>
                  <button style={tabStyle("claude-code")} onClick={() => setTab("claude-code")}>
                    Claude Code
                  </button>
                  <button style={tabStyle("cursor")} onClick={() => setTab("cursor")}>
                    Cursor
                  </button>
                </div>

                {tab === "claude-code" && (
                  <div>
                    <p style={{ margin: "0 0 0.8rem", color: "#333" }}>
                      Run this command in your terminal:
                    </p>
                    <CopyBlock content={claudeConnectCmd} />
                    {clientId && needsClientSecret && (
                      <p style={{ margin: "0 0 0.5rem", color: "#b45309", fontSize: "0.85rem" }}>
                        Claude Code will prompt for the client secret after you run the command.
                      </p>
                    )}

                    <p style={{ margin: "1rem 0 0.5rem", color: "#555", fontSize: "0.9rem" }}>
                      A browser window will open for authorization. Click "Allow" to connect.
                    </p>

                    <h3 style={{ fontSize: "0.95rem", margin: "1.5rem 0 0.5rem" }}>To remove later:</h3>
                    <CopyBlock content={`claude mcp remove ${serverName}`} />

                    <h3 style={{ fontSize: "0.95rem", margin: "2rem 0 0.5rem" }}>Optional: Install the Knowledge Store skill</h3>
                    <CopyBlock content={`mkdir -p ~/.claude/skills/${serverName}`} />
                    <p style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 0.5rem" }}>
                      Save this file as:
                    </p>
                    <CopyBlock content={`~/.claude/skills/${serverName}/SKILL.md`} />
                    <p style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 0.5rem" }}>
                      File:
                    </p>
                    <CopyBlock label="SKILL.md" content={renderTemplate(skillTemplate, serverName, info.toolKeys)} maxHeight={420} />
                  </div>
                )}

                {tab === "cursor" && (
                  <div>
                    <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>Step 1: Add the MCP Server</h3>
                    <p style={{ margin: "0 0 0.8rem", color: "#555", fontSize: "0.9rem" }}>
                      Add this to your <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in your project):
                    </p>
                    <CopyBlock content={cursorConfig} />

                    <p style={{ margin: "0.5rem 0", color: "#555", fontSize: "0.9rem" }}>
                      Or: Cursor Settings &gt; Tools &amp; MCP &gt; Add New MCP Server
                    </p>
                    <ul style={{ color: "#555", fontSize: "0.9rem", margin: "0.3rem 0 0" }}>
                      <li>Name: <code>{serverName}</code></li>
                      <li>Type: HTTP</li>
                      <li>URL: <code>{mcpEndpoint}</code></li>
                    </ul>

                    <h3 style={{ fontSize: "0.95rem", margin: "2rem 0 0.5rem" }}>Step 2: Install the Cursor Rule</h3>
                    <p style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 0.5rem" }}>
                      Save this file as <code>.cursor/rules/{serverName}.mdc</code> in your project
                      so Cursor's AI knows how to use the Knowledge Store tools:
                    </p>
                    <CopyBlock label={`${serverName}.mdc`} content={renderTemplate(cursorRuleTemplate, serverName, info.toolKeys)} maxHeight={420} />

                    <h3 style={{ fontSize: "0.95rem", margin: "1.5rem 0 0.5rem" }}>To remove later:</h3>
                    <p style={{ color: "#555", fontSize: "0.9rem" }}>
                      Delete the <code>"{serverName}"</code> entry from your <code>mcp.json</code> file
                      and remove <code>.cursor/rules/{serverName}.mdc</code>.
                    </p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
