import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type { AgentAuthPolicy } from "../types/shared.js";
import { copyTextToClipboard } from "../utils/copy-text";
import skillTemplate from "../agentskills/skill.md?raw";
import cursorRuleTemplate from "../agentskills/cursor-rule.md?raw";
import chatgptPluginFormScreenshot from "../assets/chatgpt-new-plugin-form.png";

type Tab = "claude-code" | "cursor" | "chatgpt" | "claude-ai" | "openclaw" | "other";

const TABS: { id: Tab; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude-ai", label: "Claude.ai (web)" },
  { id: "openclaw", label: "OpenClaw" },
  { id: "other", label: "Other" },
];

const CHATGPT_DEVELOPER_MODE_DOCS = "https://platform.openai.com/docs/guides/developer-mode";
const CHATGPT_APPS_HELP = "https://help.openai.com/en/articles/11487775-connectors-in-chatgpt";
const CHATGPT_MCP_APPS_HELP = "https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt";

interface SetupInfo {
  defaultServerName: string;
  internalPort: number;
  mcpUrl: string;
  agent_auth_policy: AgentAuthPolicy;
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

type CodeSegment = { kind: "context" | "insert"; text: string };

/**
 * Format a single mcpServers entry as it should appear inside an existing
 * `"mcpServers": { ... }` object (4-space key indent), prefixed with a comma
 * so it can be pasted after the previous entry.
 */
function formatMcpServerInsert(serverName: string, serverConfig: Record<string, unknown>): string {
  const wrapped = JSON.stringify({ [serverName]: serverConfig }, null, 2);
  const inner = wrapped
    .split("\n")
    .slice(1, -1)
    .map((line) => `  ${line}`)
    .join("\n");
  return `,\n${inner}`;
}

/** Example config with muted existing lines + highlighted insert; Copy takes only the insert. */
function AnnotatedConfigBlock({
  label,
  segments,
  copyText,
  copyButtonLabel = "Copy new entry",
}: {
  label?: string;
  segments: CodeSegment[];
  copyText: string;
  copyButtonLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const didCopy = await copyTextToClipboard(copyText);
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
            fontSize: "0.85rem",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            paddingRight: "7.5rem",
            lineHeight: 1.45,
          }}
        >
          {segments.map((seg, i) => (
            <span
              key={i}
              style={{
                color: seg.kind === "insert" ? "#86efac" : "#6b7280",
                background: seg.kind === "insert" ? "rgba(34, 197, 94, 0.12)" : undefined,
              }}
            >
              {seg.text}
            </span>
          ))}
        </pre>
        <button
          type="button"
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
            whiteSpace: "nowrap",
          }}
        >
          {copied ? "Copied" : copyButtonLabel}
        </button>
      </div>
      <p style={{ margin: "0.35rem 0 0", fontSize: "0.75rem", color: "#888", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <span><span style={{ color: "#6b7280" }}>■</span> already in your file (example)</span>
        <span><span style={{ color: "#16a34a" }}>■</span> add this — Copy new entry</span>
      </p>
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

function StepSection({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        marginBottom: "1.75rem",
        border: "1px solid var(--color-footer-border)",
        borderRadius: 10,
        background: "#fff",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: "0.85rem 1.1rem",
          borderBottom: "1px solid var(--color-footer-border)",
          background: "#fafafa",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: "var(--color-accent)",
            color: "#fff",
            fontSize: "0.85rem",
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {step}
        </span>
        <h2 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>{title}</h2>
      </header>
      <div style={{ padding: "1.1rem 1.1rem 1.25rem" }}>{children}</div>
    </section>
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
  const required = policy === "confidential";
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!registered && required) inputRef.current?.focus();
  }, [registered, required]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    setFormError(null);
    try {
      const created = await apiClient.addAgentKey(trimmed);
      onRegistered({
        agentId: created.agent_id,
        secret: created.secret,
        displayName: created.display_name,
      });
      setName("");
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const hint = policy === "confidential"
    ? "Required — agents need both client ID and secret."
    : "Optional — skip for anonymous access, or name an agent for audit trails.";

  return (
    <div>
      {registered ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 500, fontSize: "0.9rem", whiteSpace: "nowrap" }}>Agent identity</span>
          <span style={{ fontSize: "0.9rem", color: "#333" }}>
            <strong>{registered.displayName}</strong>
          </span>
          <button
            type="button"
            onClick={onClear}
            style={{
              padding: "0.2rem 0.55rem",
              fontSize: "0.78rem",
              background: "transparent",
              border: "1px solid var(--color-footer-border)",
              borderRadius: 6,
              cursor: "pointer",
              color: "var(--color-text-secondary)",
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", flexWrap: "wrap" }}>
            <label htmlFor="setup-agent-identity" style={{ margin: 0, fontWeight: 500, fontSize: "0.9rem", whiteSpace: "nowrap" }}>
              Agent identity
            </label>
            <span style={{ fontSize: "0.75rem", color: required ? "#92400e" : "#9ca3af" }}>
              {required ? "Required" : "Optional"}
            </span>
            <input
              id="setup-agent-identity"
              ref={inputRef}
              type="text"
              placeholder="Display name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-field"
              style={{ flex: "1 1 140px", minWidth: 120, maxWidth: 220 }}
            />
            <button
              type="submit"
              disabled={adding || !name.trim()}
              style={{
                padding: "0.4rem 0.85rem",
                border: "none",
                borderRadius: 6,
                fontSize: "0.85rem",
                cursor: adding || !name.trim() ? "not-allowed" : "pointer",
                opacity: adding || !name.trim() ? 0.5 : 1,
                background: "var(--color-accent)",
                color: "white",
                whiteSpace: "nowrap",
              }}
            >
              {adding ? "Creating..." : "Create"}
            </button>
          </div>
          <p style={{ margin: 0, fontSize: "0.8rem", color: "#888" }}>{hint}</p>

          {formError && <p className="text-error" style={{ margin: 0, fontSize: "0.85rem" }}>{formError}</p>}
        </form>
      )}
    </div>
  );
}

function NeedsRegistrationNotice() {
  return (
    <p
      style={{
        color: "#92400e",
        background: "#fffbeb",
        border: "1px solid #fde68a",
        borderRadius: 6,
        padding: "0.75rem 1rem",
        fontSize: "0.9rem",
        margin: 0,
      }}
    >
      This server requires a registered agent identity. Create one in <strong>Step 1 · Your config</strong> above, then return here.
    </p>
  );
}

/** Copy fields for agents that cannot embed credentials in a CLI/config snippet. */
function ManualCredentialFields({
  mcpEndpoint,
  clientId,
  clientSecret,
  needsClientSecret,
  showMcpUrl,
}: {
  mcpEndpoint: string;
  clientId: string | null;
  clientSecret: string | null;
  needsClientSecret: boolean;
  showMcpUrl: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
      {showMcpUrl && <CredCopyRow label="MCP URL" value={mcpEndpoint} />}
      {clientId ? (
        <CredCopyRow label="Client ID" value={clientId} />
      ) : (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
          Client ID: not required on open servers. Register an identity in Step 1 if you want a named agent.
        </p>
      )}
      {clientSecret ? (
        <CredCopyRow label="Client secret" value={clientSecret} emphasize />
      ) : needsClientSecret ? (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#b45309" }}>
          Client secret: register an agent in Step 1 (required for this server). The secret is shown once here after you create it.
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
          Client secret: not needed for this server&apos;s auth policy.
        </p>
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
  const [cursorConfigMode, setCursorConfigMode] = useState<"empty" | "existing">("empty");
  const [openclawConfigMode, setOpenclawConfigMode] = useState<"empty" | "existing">("empty");

  const mcpEndpoint = connectionOrigin === "container" && info
    ? `http://localhost:${info.internalPort}/mcp`
    : (info?.mcpUrl ?? `${window.location.origin}/mcp`);

  const clientId = registered?.agentId ?? preAuthClientId;
  const clientSecret = registered?.secret ?? null;
  const registrationRequired = policy === "confidential";
  const awaitingRegistration = registrationRequired && !clientId;

  const load = useCallback(async () => {
    try {
      const data = await apiClient.getSetupInfo();
      setInfo(data);
      setServerName(data.defaultServerName);
      setPolicy(data.agent_auth_policy);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const nameError = useMemo(() => validateServerName(serverName), [serverName]);

  const tabStyle = (t: Tab): CSSProperties => ({
    padding: "0.5rem 1rem",
    border: "none",
    borderBottom: tab === t ? "2px solid var(--color-accent)" : "2px solid transparent",
    background: "none",
    cursor: "pointer",
    fontWeight: tab === t ? 600 : 400,
    fontSize: "0.9rem",
    color: tab === t ? "var(--color-accent)" : "var(--color-text-secondary)",
    whiteSpace: "nowrap",
  });

  const needsClientSecret = policy === "confidential";

  const claudeConnectCmd = clientId
    ? (needsClientSecret
        ? `claude mcp add --transport http --client-id ${clientId} --client-secret ${serverName} ${mcpEndpoint}`
        : `claude mcp add --transport http --client-id ${clientId} ${serverName} ${mcpEndpoint}`)
    : `claude mcp add --transport http ${serverName} ${mcpEndpoint}`;

  const mcpJsonServerConfig: Record<string, unknown> = {
    url: mcpEndpoint,
    ...(clientId
      ? {
          auth: {
            CLIENT_ID: clientId,
            ...(needsClientSecret
              ? { CLIENT_SECRET: clientSecret ?? "<your-secret>" }
              : {}),
          },
        }
      : {}),
  };

  const mcpJsonConfigEmpty = JSON.stringify(
    { mcpServers: { [serverName]: mcpJsonServerConfig } },
    null,
    2,
  );
  const mcpJsonConfigInsert = formatMcpServerInsert(serverName, mcpJsonServerConfig);
  const mcpJsonExistingSegments: CodeSegment[] = [
    {
      kind: "context",
      text: `{\n  "mcpServers": {\n    "some-other-server": {\n      "url": "https://example.com/mcp"\n    }`,
    },
    { kind: "insert", text: mcpJsonConfigInsert },
    { kind: "context", text: `\n  }\n}` },
  ];

  const renderedSkill = info ? renderTemplate(skillTemplate, serverName, info.toolKeys) : "";
  const renderedCursorRule = info ? renderTemplate(cursorRuleTemplate, serverName, info.toolKeys) : "";

  const renderAccess = (): ReactNode => {
    if (awaitingRegistration) {
      return <NeedsRegistrationNotice />;
    }

    if (tab === "other") {
      return (
        <div>
          <p style={{ margin: "0 0 0.85rem", color: "#555", fontSize: "0.9rem" }}>
            For any MCP client without a guided tab above: copy these values into that client&apos;s
            connector / OAuth settings. There is no terminal command here because we do not know which agent you are using.
          </p>
          <ManualCredentialFields
            mcpEndpoint={mcpEndpoint}
            clientId={clientId}
            clientSecret={clientSecret}
            needsClientSecret={needsClientSecret}
            showMcpUrl
          />
        </div>
      );
    }

    if (tab === "claude-code") {
      return (
        <div>
          <p style={{ margin: "0 0 0.8rem", color: "#333" }}>
            Run this command in your terminal
            {clientId ? " (client ID from Step 1 is already included)" : ""}:
          </p>
          <CopyBlock content={claudeConnectCmd} />
          {clientId && needsClientSecret && (
            <div style={{ marginBottom: "0.75rem" }}>
              <p style={{ margin: "0 0 0.5rem", color: "#b45309", fontSize: "0.85rem" }}>
                Claude Code will prompt for the client secret after you run the command
                {clientSecret ? " — paste this when asked" : ""}:
              </p>
              {clientSecret ? (
                <CredCopyRow label="Client secret" value={clientSecret} emphasize />
              ) : (
                <p style={{ margin: 0, fontSize: "0.85rem", color: "#b45309" }}>
                  No secret is available yet. Re-register in Step 1 with a secret, or use an identity that has one.
                </p>
              )}
            </div>
          )}
          <p style={{ margin: "1rem 0 0.5rem", color: "#555", fontSize: "0.9rem" }}>
            A browser window will open for authorization. Click &quot;Allow&quot; to connect.
            {policy === "approve" ? " On this server, the browser will also ask a signed-in human to approve the agent's first connection." : ""}
          </p>
          <h3 style={{ fontSize: "0.95rem", margin: "1.5rem 0 0.5rem" }}>To remove later:</h3>
          <CopyBlock content={`claude mcp remove ${serverName}`} />
        </div>
      );
    }

    if (tab === "cursor") {
      return (
        <div>
          <p style={{ margin: "0 0 0.8rem", color: "#555", fontSize: "0.9rem" }}>
            Edit <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in your project)
            {clientId ? " — identity from Step 1 is already embedded" : ""}.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setCursorConfigMode("empty")}
              style={{
                padding: "0.35rem 0.75rem",
                fontSize: "0.82rem",
                borderRadius: 6,
                border: cursorConfigMode === "empty" ? "1.5px solid var(--color-accent)" : "1px solid var(--color-footer-border)",
                background: cursorConfigMode === "empty" ? "#eff6ff" : "#fff",
                color: cursorConfigMode === "empty" ? "var(--color-accent)" : "#555",
                cursor: "pointer",
                fontWeight: cursorConfigMode === "empty" ? 600 : 400,
              }}
            >
              File was empty / new
            </button>
            <button
              type="button"
              onClick={() => setCursorConfigMode("existing")}
              style={{
                padding: "0.35rem 0.75rem",
                fontSize: "0.82rem",
                borderRadius: 6,
                border: cursorConfigMode === "existing" ? "1.5px solid var(--color-accent)" : "1px solid var(--color-footer-border)",
                background: cursorConfigMode === "existing" ? "#eff6ff" : "#fff",
                color: cursorConfigMode === "existing" ? "var(--color-accent)" : "#555",
                cursor: "pointer",
                fontWeight: cursorConfigMode === "existing" ? 600 : 400,
              }}
            >
              File already had content
            </button>
          </div>
          {cursorConfigMode === "empty" ? (
            <>
              <p style={{ margin: "0 0 0.5rem", color: "#555", fontSize: "0.9rem" }}>
                Create the file with this full JSON:
              </p>
              <CopyBlock content={mcpJsonConfigEmpty} />
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 0.5rem", color: "#555", fontSize: "0.9rem" }}>
                Your file already has other servers. Add the green block inside <code>mcpServers</code>
                (after the last existing entry). Copy places the leading comma for you.
              </p>
              <AnnotatedConfigBlock
                segments={mcpJsonExistingSegments}
                copyText={mcpJsonConfigInsert}
              />
            </>
          )}
          <p style={{ margin: "0.5rem 0", color: "#555", fontSize: "0.9rem" }}>
            Or: Cursor Settings &gt; Tools &amp; MCP &gt; Add New MCP Server
          </p>
          <ul style={{ color: "#555", fontSize: "0.9rem", margin: "0.3rem 0 0" }}>
            <li>Name: <code>{serverName}</code></li>
            <li>Type: HTTP</li>
            <li>URL: <code>{mcpEndpoint}</code></li>
          </ul>
          <h3 style={{ fontSize: "0.95rem", margin: "1.5rem 0 0.5rem" }}>To remove later:</h3>
          <p style={{ color: "#555", fontSize: "0.9rem", margin: 0 }}>
            Delete the <code>&quot;{serverName}&quot;</code> entry from your <code>mcp.json</code> file.
          </p>
        </div>
      );
    }

    if (tab === "chatgpt") {
      return (
        <div>
          <p style={{ margin: "0 0 1rem", color: "#555", fontSize: "0.9rem" }}>
            ChatGPT does not pick up a remote MCP server from a config file. You enable Developer mode
            in the web UI, then fill in a plugin form by hand.
          </p>

          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>Before you install: enable MCP servers</h3>
          <p style={{ margin: "0 0 0.6rem", color: "#555", fontSize: "0.9rem" }}>
            As of the current ChatGPT UI, adding your own MCP server is:
          </p>
          <ol style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 1rem", paddingLeft: "1.25rem", lineHeight: 1.55 }}>
            <li style={{ marginBottom: "0.55rem" }}>
              <strong>Use ChatGPT on the web.</strong> Custom MCP / developer-mode apps are configured
              through the web interface. (
              <a href={CHATGPT_DEVELOPER_MODE_DOCS} target="_blank" rel="noreferrer">
                ChatGPT Developer mode
              </a>
              )
            </li>
            <li style={{ marginBottom: "0.55rem" }}>
              <strong>Turn on Developer mode.</strong> Go to{" "}
              <strong>Profile → Settings → Security and login → Developer mode</strong>.
              The current developer documentation lists that location. (
              <a href={CHATGPT_DEVELOPER_MODE_DOCS} target="_blank" rel="noreferrer">
                ChatGPT Developer mode
              </a>
              )
            </li>
            <li style={{ marginBottom: "0.55rem" }}>
              <strong>Open the Plugins directory.</strong> Open <strong>Plugins</strong> in ChatGPT.
              OpenAI moved app discovery / setup into Plugins on{" "}
              <strong>July 9, 2026</strong>. (
              <a href={CHATGPT_APPS_HELP} target="_blank" rel="noreferrer">
                Apps in ChatGPT
              </a>
              )
            </li>
            <li>
              <strong>Click the <code>+</code> button in Plugins.</strong> With Developer mode on, that
              plus button creates a developer-mode app backed by your remote MCP server. (
              <a href={CHATGPT_DEVELOPER_MODE_DOCS} target="_blank" rel="noreferrer">
                ChatGPT Developer mode
              </a>
              )
            </li>
          </ol>
          <p style={{ margin: "0 0 0.6rem", color: "#555", fontSize: "0.9rem" }}>
            You should then get a setup form for the remote MCP endpoint, authentication
            (OAuth, No Authentication, or Mixed Authentication), and MCP transport (SSE or streaming HTTP).
          </p>
          <p style={{ margin: "0 0 0.6rem", color: "#555", fontSize: "0.9rem" }}>
            After creation it should appear under <strong>Drafts</strong>, where you can manage or refresh
            the tools the MCP server exposes. (
            <a href={CHATGPT_DEVELOPER_MODE_DOCS} target="_blank" rel="noreferrer">
              ChatGPT Developer mode
            </a>
            )
          </p>
          <p style={{ margin: "0 0 0.6rem", color: "#555", fontSize: "0.9rem" }}>
            In an actual conversation, click the <strong>+ / tools menu → Developer mode</strong>, then
            select your developer-mode app. (
            <a href={CHATGPT_DEVELOPER_MODE_DOCS} target="_blank" rel="noreferrer">
              ChatGPT Developer mode
            </a>
            )
          </p>
          <p style={{ margin: "0 0 0.6rem", color: "#555", fontSize: "0.9rem" }}>
            Some older or overlapping OpenAI help pages still describe{" "}
            <strong>Settings → Apps → Create</strong> or{" "}
            <strong>Workspace Settings → Apps → Create</strong>, especially for Business / Enterprise
            workspace administration. (
            <a href={CHATGPT_MCP_APPS_HELP} target="_blank" rel="noreferrer">
              Developer mode and MCP apps in ChatGPT
            </a>
            ) For an individual developer-mode MCP setup, the newer developer documentation points to{" "}
            <strong>Plugins → <code>+</code></strong>.
          </p>
          <p style={{ margin: "0 0 1.25rem", color: "#555", fontSize: "0.9rem" }}>
            If you do not see the <code>+</code> button in Plugins even with Developer mode on, check
            whether you are on Plus, Pro, Business, or Enterprise — OpenAI currently gates this UI by plan.
          </p>

          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>Install: add the MCP server</h3>
          <p style={{ margin: "0 0 0.75rem", color: "#555", fontSize: "0.9rem" }}>
            Fill ChatGPT&apos;s New Plugin form by hand. Use the values below and match the screenshot.
          </p>

          <div
            style={{
              margin: "0 0 1rem",
              padding: "0.7rem 0.85rem",
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 6,
              fontSize: "0.85rem",
              color: "#92400e",
              lineHeight: 1.5,
            }}
          >
            <p style={{ margin: "0 0 0.45rem", fontWeight: 600 }}>Two things the form will not do for you:</p>
            <ol style={{ margin: 0, paddingLeft: "1.2rem" }}>
              <li style={{ marginBottom: "0.35rem" }}>
                Open <strong>Advanced OAuth settings</strong> and switch{" "}
                <strong>Registration method</strong> to <strong>User-Defined OAuth Client</strong>.
                It does not default to this.
              </li>
              <li>
                Tick <strong>I understand and want to continue</strong> at the bottom, or Create stays disabled.
              </li>
            </ol>
          </div>

          <ul style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 1rem", paddingLeft: "1.25rem", lineHeight: 1.55 }}>
            <li>Name: <code>{serverName}</code></li>
            <li>Connection: <strong>Server URL</strong> (leave the Named toggle off)</li>
            <li>Server URL: the MCP URL below</li>
            <li>Authentication: <strong>OAuth</strong></li>
            <li>MCP transport: <strong>streaming HTTP</strong> (not SSE)</li>
            <li>OAuth Client ID / secret: the values below</li>
            <li>
              Token endpoint auth method:{" "}
              {needsClientSecret ? (
                <><strong>client_secret_post</strong> (this server requires the client secret)</>
              ) : (
                <><strong>none</strong></>
              )}
            </li>
            <li>Scopes: leave empty</li>
          </ul>

          {!clientId && (
            <p
              style={{
                margin: "0 0 0.75rem",
                padding: "0.55rem 0.75rem",
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 6,
                fontSize: "0.85rem",
                color: "#92400e",
              }}
            >
              ChatGPT&apos;s User-Defined OAuth Client field expects a Client ID. Create an agent identity
              in Step 1, then paste it here.
            </p>
          )}

          <div style={{ marginBottom: "0.85rem" }}>
            <ManualCredentialFields
              mcpEndpoint={mcpEndpoint}
              clientId={clientId}
              clientSecret={clientSecret}
              needsClientSecret={needsClientSecret}
              showMcpUrl
            />
          </div>

          <figure style={{ margin: "0 0 0.85rem" }}>
            <img
              src={chatgptPluginFormScreenshot}
              alt="ChatGPT New Plugin form: Server URL, OAuth, User-Defined OAuth Client, and the risk-consent checkbox"
              style={{
                display: "block",
                width: "100%",
                maxWidth: 720,
                height: "auto",
                border: "1px solid var(--color-footer-border)",
                borderRadius: 8,
              }}
            />
            <figcaption style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "#888" }}>
              ChatGPT New Plugin form. Advanced OAuth is on the right; the consent checkbox is at the bottom left.
            </figcaption>
          </figure>

          <p style={{ margin: 0, color: "#888", fontSize: "0.8rem" }}>
            ChatGPT reaches this server from OpenAI&apos;s cloud — the MCP URL must be publicly reachable
            (not <code>localhost</code> unless you use a tunnel). The orange &quot;OIDC is unavailable&quot;
            notice is expected and can be ignored.
          </p>
        </div>
      );
    }

    if (tab === "claude-ai") {
      return (
        <div>
          <p style={{ margin: "0 0 1rem", color: "#555", fontSize: "0.9rem" }}>
            Claude.ai connects in two phases. This step covers the MCP connector (Phase 1).
            Phase 2 — uploading a custom skill — is in Step 3 below.
          </p>

          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>Phase 1: Add a custom connector</h3>
          <ol style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 1rem", paddingLeft: "1.25rem", lineHeight: 1.55 }}>
            <li>Log in to <a href="https://claude.ai" target="_blank" rel="noreferrer">claude.ai</a></li>
            <li>Open <strong>Customize</strong> (or your profile) → <strong>Connectors</strong></li>
            <li>Click <strong>Add custom connector</strong> (Team/Enterprise owners: Organization settings → Connectors)</li>
            <li>Paste the values below. For Client ID / secret, open <strong>Advanced settings</strong> in the connector dialog.</li>
            <li>Click <strong>Add</strong>, then <strong>Connect</strong> to authorize.</li>
          </ol>

          <div style={{ marginBottom: "0.75rem" }}>
            <ManualCredentialFields
              mcpEndpoint={mcpEndpoint}
              clientId={clientId}
              clientSecret={clientSecret}
              needsClientSecret={needsClientSecret}
              showMcpUrl
            />
          </div>
          <p style={{ margin: 0, color: "#888", fontSize: "0.8rem" }}>
            Custom connectors reach this server from Anthropic&apos;s cloud — the MCP URL must be publicly reachable (not <code>localhost</code> unless you use a tunnel).
          </p>
        </div>
      );
    }

    // openclaw — credentials are embedded in the JSON snippet; do not repeat them as copy rows
    return (
      <div>
        <p style={{ margin: "0 0 1rem", color: "#555", fontSize: "0.9rem" }}>
          OpenClaw uses <a href="https://github.com/openclaw/mcporter" target="_blank" rel="noreferrer">McPorter</a> as its MCP client.
          Configure McPorter, then authenticate the new server
          {clientId ? " (identity from Step 1 is already embedded in the JSON below)" : ""}.
        </p>

        <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>1. Install McPorter (if needed)</h3>
        <CopyBlock content="npm install -g mcporter" />

        <h3 style={{ fontSize: "0.95rem", margin: "1.25rem 0 0.5rem" }}>2. Edit <code>~/.mcporter/mcporter.json</code></h3>
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setOpenclawConfigMode("empty")}
            style={{
              padding: "0.35rem 0.75rem",
              fontSize: "0.82rem",
              borderRadius: 6,
              border: openclawConfigMode === "empty" ? "1.5px solid var(--color-accent)" : "1px solid var(--color-footer-border)",
              background: openclawConfigMode === "empty" ? "#eff6ff" : "#fff",
              color: openclawConfigMode === "empty" ? "var(--color-accent)" : "#555",
              cursor: "pointer",
              fontWeight: openclawConfigMode === "empty" ? 600 : 400,
            }}
          >
            File was empty / new
          </button>
          <button
            type="button"
            onClick={() => setOpenclawConfigMode("existing")}
            style={{
              padding: "0.35rem 0.75rem",
              fontSize: "0.82rem",
              borderRadius: 6,
              border: openclawConfigMode === "existing" ? "1.5px solid var(--color-accent)" : "1px solid var(--color-footer-border)",
              background: openclawConfigMode === "existing" ? "#eff6ff" : "#fff",
              color: openclawConfigMode === "existing" ? "var(--color-accent)" : "#555",
              cursor: "pointer",
              fontWeight: openclawConfigMode === "existing" ? 600 : 400,
            }}
          >
            File already had content
          </button>
        </div>
        {openclawConfigMode === "empty" ? (
          <>
            <p style={{ margin: "0 0 0.5rem", color: "#555", fontSize: "0.9rem" }}>
              Create the file with this full JSON:
            </p>
            <CopyBlock content={mcpJsonConfigEmpty} />
          </>
        ) : (
          <>
            <p style={{ margin: "0 0 0.5rem", color: "#555", fontSize: "0.9rem" }}>
              Your file already has other servers. Add the green block inside <code>mcpServers</code>
              (after the last existing entry). Copy places the leading comma for you.
            </p>
            <AnnotatedConfigBlock
              segments={mcpJsonExistingSegments}
              copyText={mcpJsonConfigInsert}
            />
          </>
        )}

        <h3 style={{ fontSize: "0.95rem", margin: "1.25rem 0 0.5rem" }}>3. Authenticate the server</h3>
        <p style={{ margin: "0 0 0.5rem", color: "#555", fontSize: "0.9rem" }}>
          Run McPorter against the home config so OAuth / connection setup runs for the new server:
        </p>
        <CopyBlock content={`mcporter --config ~/.mcporter/mcporter.json list`} />
        <p style={{ margin: 0, color: "#888", fontSize: "0.8rem" }}>
          If McPorter prompts for authorization, complete it in the browser. Ensure the <code>mcporter</code> binary is on PATH for the OpenClaw gateway host.
        </p>
      </div>
    );
  };

  const renderSkill = (): ReactNode => {
    if (tab === "other") {
      return (
        <p style={{ margin: 0, color: "#555", fontSize: "0.9rem" }}>
          Skill / rule files are agent-specific. Pick Claude Code, Cursor, ChatGPT, Claude.ai, or OpenClaw above to see the matching install steps.
          For a custom agent, use the <code>SKILL.md</code> content from the Claude Code tab as a starting point.
        </p>
      );
    }

    if (awaitingRegistration) {
      return (
        <p style={{ margin: 0, color: "#888", fontSize: "0.9rem" }}>
          Finish agent registration in Step 1, then return here for skill install.
        </p>
      );
    }

    if (tab === "claude-code") {
      return (
        <div>
          <p style={{ margin: "0 0 0.75rem", color: "#555", fontSize: "0.9rem" }}>
            Install the Knowledge Store skill so Claude Code knows how to use this server&apos;s tools.
          </p>
          <CopyBlock content={`mkdir -p ~/.claude/skills/${serverName}`} />
          <p style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 0.5rem" }}>
            Save this file as:
          </p>
          <CopyBlock content={`~/.claude/skills/${serverName}/SKILL.md`} />
          <CopyBlock label="SKILL.md" content={renderedSkill} maxHeight={420} />
        </div>
      );
    }

    if (tab === "cursor") {
      return (
        <div>
          <p style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 0.5rem" }}>
            Save this file as <code>.cursor/rules/{serverName}.mdc</code> in your project
            so Cursor&apos;s AI knows how to use the Knowledge Store tools:
          </p>
          <CopyBlock label={`${serverName}.mdc`} content={renderedCursorRule} maxHeight={420} />
          <h3 style={{ fontSize: "0.95rem", margin: "1.25rem 0 0.5rem" }}>To remove later:</h3>
          <p style={{ color: "#555", fontSize: "0.9rem", margin: 0 }}>
            Remove <code>.cursor/rules/{serverName}.mdc</code>.
          </p>
        </div>
      );
    }

    if (tab === "chatgpt") {
      return (
        <div>
          <p style={{ margin: "0 0 0.75rem", color: "#555", fontSize: "0.9rem" }}>
            ChatGPT does not install a local skill or rule file. After the plugin exists under Drafts,
            open a conversation, click <strong>+ / tools menu → Developer mode</strong>, and select
            the app. The MCP tools from this server are then available in that chat.
          </p>
          <p style={{ margin: "0 0 0.75rem", color: "#555", fontSize: "0.9rem" }}>
            Optional: keep the skill text below as a reference for how this server expects agents to work.
          </p>
          <CopyBlock label="SKILL.md (reference)" content={renderedSkill} maxHeight={420} />
        </div>
      );
    }

    if (tab === "claude-ai") {
      return (
        <div>
          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>Phase 2: Upload a custom skill</h3>
          <p style={{ margin: "0 0 0.75rem", color: "#555", fontSize: "0.9rem" }}>
            Claude.ai expects a ZIP whose root is a folder containing <code>skill.md</code>
            (see{" "}
            <a
              href="https://support.claude.com/en/articles/12512198-how-to-create-custom-skills"
              target="_blank"
              rel="noreferrer"
            >
              How to create custom skills
            </a>
            ). Download is not wired up yet — for now, copy the file below and package it locally as{" "}
            <code>{serverName}/skill.md</code> inside a ZIP named <code>{serverName}.zip</code>.
          </p>
          <ol style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 1rem", paddingLeft: "1.25rem", lineHeight: 1.55 }}>
            <li>Create a folder named <code>{serverName}</code></li>
            <li>Save the content below as <code>{serverName}/skill.md</code></li>
            <li>ZIP that folder (folder at ZIP root, not loose files)</li>
            <li>In Claude.ai: <strong>Customize → Skills → Add</strong>, then upload the ZIP</li>
          </ol>
          <p style={{ margin: "0 0 0.75rem", padding: "0.55rem 0.75rem", background: "#f3f4f6", borderRadius: 6, fontSize: "0.85rem", color: "#4b5563" }}>
            Next: one-click ZIP download in the required package format.
          </p>
          <CopyBlock label="skill.md" content={renderedSkill} maxHeight={420} />
        </div>
      );
    }

    // openclaw
    return (
      <div>
        <p style={{ margin: "0 0 0.75rem", color: "#555", fontSize: "0.9rem" }}>
          OpenClaw does not use Claude&apos;s skill upload flow. After McPorter can reach this server,
          point your agent at the Knowledge Store by name (<code>{serverName}</code>) in prompts.
          Optional: keep a local copy of the skill text as reference for your OpenClaw workspace.
        </p>
        <CopyBlock label="SKILL.md (reference)" content={renderedSkill} maxHeight={420} />
      </div>
    );
  };

  return (
    <>
      <SharedPageHeader title="Connect an Agent" backTo="/" />

      <section className="min-h-0 flex-1 overflow-auto" style={{ maxWidth: 1100, margin: "0 auto", padding: "1rem 1.5rem 2.5rem" }}>
        {error && <p className="text-error" style={{ marginBottom: "1rem" }}>{error}</p>}

        {!info ? (
          <p style={{ color: "#888" }}>Loading setup info...</p>
        ) : (
          <>
            <p style={{ color: "#555", marginBottom: "0.35rem" }}>
              Connect your AI agent to this Knowledge Store in three steps.
            </p>
            <p style={{ color: "#888", fontSize: "0.88rem", margin: "0 0 1.5rem" }}>
              Step 1 is shared. Steps 2 and 3 change with the agent you select.
            </p>

            <StepSection step={1} title="Your config">
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.85rem 2.5rem",
                  alignItems: "flex-start",
                }}
              >
                <div style={{ flex: "1 1 260px", minWidth: 0, maxWidth: 420 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", flexWrap: "wrap" }}>
                    <label htmlFor="setup-server-name" style={{ margin: 0, fontWeight: 500, fontSize: "0.9rem", whiteSpace: "nowrap" }}>
                      Server name
                    </label>
                    <input
                      id="setup-server-name"
                      type="text"
                      value={serverName}
                      onChange={(e) => setServerName(e.target.value)}
                      className="input-field"
                      style={{
                        flex: "1 1 140px",
                        minWidth: 120,
                        maxWidth: 220,
                        border: nameError ? `1.5px solid var(--color-status-red)` : undefined,
                      }}
                    />
                    {!nameError && (
                      <span style={{ color: "#bbb", fontSize: "0.72rem" }}>
                        {serverName.length}/{MAX_SERVER_NAME}
                      </span>
                    )}
                  </div>
                  {nameError ? (
                    <p className="text-error" style={{ margin: "0.3rem 0 0", fontSize: "0.8rem" }}>{nameError}</p>
                  ) : (
                    <p style={{ color: "#888", fontSize: "0.8rem", margin: "0.3rem 0 0", lineHeight: 1.4 }}>
                      What you call Civigent in prompts, e.g.{" "}
                      <em>&quot;use the docs in <code>{serverName || "…"}</code>&quot;</em>
                    </p>
                  )}
                </div>

                <div style={{ flex: "1 1 280px", minWidth: 0, maxWidth: 480 }}>
                  <AgentRegistrationSection
                    policy={policy}
                    registered={registered}
                    onRegistered={setRegistered}
                    onClear={() => setRegistered(null)}
                  />
                </div>
              </div>

              <details
                style={{
                  marginTop: "0.85rem",
                  border: "1px solid var(--color-footer-border)",
                  borderRadius: 8,
                  background: "#f3f4f6",
                  overflow: "hidden",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: "0.82rem",
                    color: "#4b5563",
                    userSelect: "none",
                    listStyle: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    padding: "0.55rem 0.75rem",
                    fontWeight: 500,
                  }}
                >
                  <span aria-hidden="true" style={{ fontSize: "0.7rem", color: "#6b7280", width: "0.9rem" }}>▸</span>
                  <span>Advanced · agent location</span>
                  <span style={{ fontWeight: 400, color: "#9ca3af", fontSize: "0.78rem" }}>
                    ({connectionOrigin === "external" ? "this machine or remote" : "inside app container"})
                  </span>
                </summary>
                <div
                  style={{
                    padding: "0.15rem 0.75rem 0.75rem",
                    borderTop: "1px solid var(--color-footer-border)",
                    background: "#fafafa",
                  }}
                >
                  <select
                    value={connectionOrigin}
                    onChange={(e) => setConnectionOrigin(e.target.value as "external" | "container")}
                    className="input-field"
                    style={{
                      width: "100%",
                      maxWidth: 280,
                      marginTop: "0.55rem",
                      fontSize: "0.82rem",
                      color: "#6b7280",
                      background: "#fff",
                    }}
                  >
                    <option value="external">This machine or remote</option>
                    <option value="container">Inside app container</option>
                  </select>
                  <p style={{ color: "#9ca3af", fontSize: "0.75rem", margin: "0.35rem 0 0" }}>
                    Only change this if the agent runs inside this app&apos;s Docker container.
                  </p>
                </div>
              </details>
            </StepSection>

            <div style={{ marginBottom: "1.25rem" }}>
              <p style={{ margin: "0 0 0.45rem", fontWeight: 500, fontSize: "0.9rem" }}>
                Choose your agent
              </p>
              <div
                style={{
                  borderBottom: "1px solid var(--color-footer-border)",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.15rem",
                }}
              >
                {TABS.map(({ id, label }) => (
                  <button key={id} type="button" style={tabStyle(id)} onClick={() => setTab(id)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <StepSection step={2} title="Agent access">
              {renderAccess()}
            </StepSection>

            <StepSection step={3} title="Agent skill">
              {renderSkill()}
            </StepSection>
          </>
        )}
      </section>
    </>
  );
}
