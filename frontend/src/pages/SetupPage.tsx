import { useCallback, useEffect, useMemo, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";

type Tab = "claude-code" | "cursor";

interface SetupInfo {
  publicUrl: string;
  mcpEndpoint: string;
  defaultServerName: string;
}

/** mcp__<name>__<tool>  —  longest tool is read_doc_structure (18 chars) */
const MCP_PREFIX_OVERHEAD = 5 + 2; // "mcp__" + "__"
const LONGEST_TOOL_NAME = 18; // read_doc_structure
const CURSOR_COMBINED_LIMIT = 60;
const MAX_SERVER_NAME = CURSOR_COMBINED_LIMIT - MCP_PREFIX_OVERHEAD - LONGEST_TOOL_NAME; // 35

function validateServerName(name: string): string | null {
  if (!name.trim()) return "Name cannot be empty";
  if (!/^[a-zA-Z0-9][-a-zA-Z0-9]*$/.test(name))
    return "Must start with a letter or digit and contain only letters, digits, and hyphens";
  if (name.length > MAX_SERVER_NAME)
    return `Name too long for Cursor (max ${MAX_SERVER_NAME} chars). Cursor requires the combined server + tool name to be under ${CURSOR_COMBINED_LIMIT} characters, and our longest tool name (read_doc_structure) uses ${LONGEST_TOOL_NAME}.`;
  return null;
}

function CopyBlock({ label, content }: { label?: string; content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ marginBottom: "1rem" }}>
      {label && <p style={{ margin: "0 0 0.3rem", fontWeight: 500, fontSize: "0.9rem" }}>{label}</p>}
      <div style={{ position: "relative", background: "#1e1e1e", borderRadius: 6, padding: "0.8rem 1rem" }}>
        <pre style={{ margin: 0, color: "#d4d4d4", fontSize: "0.85rem", whiteSpace: "pre-wrap", wordBreak: "break-all", paddingRight: "3rem" }}>
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

export function SetupPage() {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("claude-code");
  const [serverName, setServerName] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await apiClient.getSetupInfo();
      setInfo(data);
      setServerName(data.defaultServerName);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const nameError = useMemo(() => validateServerName(serverName), [serverName]);

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: "0.5rem 1.2rem",
    border: "none",
    borderBottom: tab === t ? "2px solid #2d7a8a" : "2px solid transparent",
    background: "none",
    cursor: "pointer",
    fontWeight: tab === t ? 600 : 400,
    fontSize: "0.95rem",
    color: tab === t ? "#2d7a8a" : "#666",
  });

  return (
    <>
      <SharedPageHeader title="Connect an Agent" backTo="/" />

      <section style={{ maxWidth: 700, margin: "0 auto", padding: "1rem" }}>
        {error && (
          <div style={{ background: "#ffeaea", color: "#a00", padding: "0.5rem 1rem", borderRadius: 4, marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        {!info ? (
          <p style={{ color: "#888" }}>Loading setup info...</p>
        ) : (
          <>
            <p style={{ color: "#555", marginBottom: "1.5rem" }}>
              Connect your AI agent to this Knowledge Store. Both Claude Code and Cursor
              handle OAuth automatically — just provide the URL.
            </p>

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
                style={{
                  width: "100%",
                  maxWidth: 350,
                  padding: "0.4rem 0.6rem",
                  fontSize: "0.9rem",
                  border: nameError ? "1.5px solid #d32f2f" : "1px solid #ccc",
                  borderRadius: 4,
                  fontFamily: "monospace",
                  boxSizing: "border-box",
                }}
              />
              {nameError && (
                <p style={{ color: "#d32f2f", fontSize: "0.8rem", margin: "0.3rem 0 0" }}>
                  {nameError}
                </p>
              )}
              <p style={{ color: "#aaa", fontSize: "0.75rem", margin: "0.3rem 0 0" }}>
                {serverName.length}/{MAX_SERVER_NAME} characters
              </p>
            </div>

            <div style={{ borderBottom: "1px solid #ddd", marginBottom: "1.5rem" }}>
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
                <CopyBlock content={`claude mcp add --transport http ${serverName} ${info.mcpEndpoint}`} />

                <p style={{ margin: "1rem 0 0.5rem", color: "#555", fontSize: "0.9rem" }}>
                  A browser window will open for authorization. Click "Allow" to connect.
                </p>

                <h3 style={{ fontSize: "0.95rem", margin: "1.5rem 0 0.5rem" }}>To remove later:</h3>
                <CopyBlock content={`claude mcp remove ${serverName}`} />

                <h3 style={{ fontSize: "0.95rem", margin: "2rem 0 0.5rem" }}>Optional: Install the Knowledge Store skill</h3>
                <p style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 0.5rem" }}>
                  Save this file as <code>.claude/skills/{serverName}/SKILL.md</code> in your project
                  to get guided workflows for research, proposals, and document editing:
                </p>
                <CopyBlock label="SKILL.md" content={buildSkillContent(serverName)} />
              </div>
            )}

            {tab === "cursor" && (
              <div>
                <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>Step 1: Add the MCP Server</h3>
                <p style={{ margin: "0 0 0.8rem", color: "#555", fontSize: "0.9rem" }}>
                  Add this to your <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in your project):
                </p>
                <CopyBlock content={JSON.stringify({ mcpServers: { [serverName]: { url: info.mcpEndpoint } } }, null, 2)} />

                <p style={{ margin: "0.5rem 0", color: "#555", fontSize: "0.9rem" }}>
                  Or: Cursor Settings &gt; Tools &amp; MCP &gt; Add New MCP Server
                </p>
                <ul style={{ color: "#555", fontSize: "0.9rem", margin: "0.3rem 0 0" }}>
                  <li>Name: <code>{serverName}</code></li>
                  <li>Type: HTTP</li>
                  <li>URL: <code>{info.mcpEndpoint}</code></li>
                </ul>

                <h3 style={{ fontSize: "0.95rem", margin: "2rem 0 0.5rem" }}>Step 2: Install the Cursor Rule</h3>
                <p style={{ color: "#555", fontSize: "0.9rem", margin: "0 0 0.5rem" }}>
                  Save this file as <code>.cursor/rules/{serverName}.mdc</code> in your project
                  so Cursor's AI knows how to use the Knowledge Store tools:
                </p>
                <CopyBlock label={`${serverName}.mdc`} content={buildCursorRuleContent(serverName)} />

                <h3 style={{ fontSize: "0.95rem", margin: "1.5rem 0 0.5rem" }}>To remove later:</h3>
                <p style={{ color: "#555", fontSize: "0.9rem" }}>
                  Delete the <code>"{serverName}"</code> entry from your <code>mcp.json</code> file
                  and remove <code>.cursor/rules/{serverName}.mdc</code>.
                </p>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

function buildSkillContent(name: string): string {
  return `---
name: ${name}
description: Research and contribute to the Knowledge Store wiki using MCP tools
---

You have access to a Knowledge Store via MCP tools (prefixed \`mcp__${name}__\`).

## Reading & Research

1. **Find documents:** \`list_docs\` returns all documents in the store.
2. **Understand structure:** \`read_doc_structure\` shows a document's section tree.
3. **Read content:** \`read_section\` reads a specific section. Use \`read_doc\` for an entire document.

## Making Changes (Proposal Workflow)

1. \`create_proposal\` — start a proposal with doc_path, heading_path, and intent.
2. \`write_section\` — update section content within your proposal.
3. \`commit_proposal\` — submit for human review.
4. \`cancel_proposal\` — withdraw if needed.

## Checking Proposals

- \`my_proposals\` / \`list_proposals\` / \`read_proposal\`

## Structural Changes

- \`create_section\`, \`delete_section\`, \`move_section\`, \`rename_section\`
- \`delete_document\`, \`rename_document\`

## Best Practices

- Always read current content before writing changes.
- Write clear intent descriptions in create_proposal.
- Check list_proposals before creating new ones to avoid conflicts.
- If a write is blocked (human editing), wait and retry later.
`;
}

function buildCursorRuleContent(name: string): string {
  return `---
description: How to use the Knowledge Store MCP tools for reading, writing, and managing wiki documents
globs:
alwaysApply: true
---

# Knowledge Store — MCP Tool Usage Guide

You have access to a Knowledge Store via MCP tools (prefixed \`mcp__${name}__\`).
These tools let you read, write, and manage structured wiki documents.

## Reading & Research

1. **Find documents:** \`list_docs\` returns all documents in the store.
2. **Understand structure:** \`read_doc_structure\` shows a document's section tree (headings, nesting, word counts).
3. **Read content:** \`read_section\` reads a specific section by document path and heading path. Use \`read_doc\` for an entire document.

## Making Changes (Proposal Workflow)

All content changes go through a proposal workflow so humans can review:

1. \`create_proposal\` — start a proposal with doc_path, heading_path, and intent describing what you plan to change.
2. \`write_section\` — update section content within your proposal. You can write to multiple sections.
3. \`commit_proposal\` — submit for human review.
4. \`cancel_proposal\` — withdraw if needed.

**Never try to write content without an active proposal.** The system enforces this.

## Checking Proposals

- \`my_proposals\` — list your own proposals and their status.
- \`list_proposals\` — list all proposals (check before creating new ones to avoid conflicts).
- \`read_proposal\` — read details of a specific proposal.

## Structural Changes

These modify the document tree itself (not section content):

- \`create_section\`, \`delete_section\`, \`move_section\`, \`rename_section\`
- \`delete_document\`, \`rename_document\`

Structural changes are committed directly (no proposal needed) but are blocked when humans are actively editing affected sections.

## Important Behaviours

- **Always read before writing** — use \`read_section\` or \`read_doc_structure\` first.
- **Human-involvement guards** — some sections may be blocked because a human is editing them. This is expected, not an error. Wait and retry later.
- **Section-level granularity** — the system operates on sections (headings within documents), not whole files.
- **Clear intent** — write descriptive intent in \`create_proposal\` so reviewers understand your purpose.
`;
}
