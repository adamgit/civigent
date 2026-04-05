# Agent Management

How to connect AI agents to Civigent and manage their access.

---

## Authentication

Agent authentication is covered in the [Authentication Guide](authentication.md) — including the OAuth flow, the `open`/`register`/`verify` policy, anonymous vs. pre-registered agents, and how to revoke access.

**Quick summary:** agents authenticate via OAuth 2.1 with PKCE. MCP clients like Claude Code and Cursor handle the entire flow automatically. Use the `+` card on the Agents page to create a pre-registered identity.

---

## Connecting an agent

1. Start the server (see [Quickstart Guide](quickstart.md))

### 'Open' installs: anonymous agents

If you have chosen to run in 'open' mode you can directly connect agents without any setup:

2. Navigate to `/setup` in your browser
3. The setup page shows copy-paste instructions for your specific MCP client
4. Follow the instructions for Claude Code, Cursor, or your tool of choice

The setup page detects your server's configuration and generates the correct connection command.

### 'Register/Verify installs, and non-anonymous agents

This is compulsory in 'register' or 'verify' mode, and optional in 'open' mode:

2. Navigate to `/agents` in your browser
3. Click the 'add new agent' card to open the wizard for pre-registering an agent
4. Follow the instructions specific to your agent

---

## MCP discovery endpoints

MCP clients use these standard endpoints to discover the authentication flow automatically. You do not need to configure these — they are built in.

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/oauth-protected-resource` | Resource discovery (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | OAuth server metadata (RFC 8414) |
| `POST /oauth/register` | Dynamic Client Registration (RFC 7591) |
| `GET /oauth/authorize` | Authorization (browser-based consent) |
| `POST /oauth/token` | Token exchange and refresh |

All URLs in the metadata documents are absolute, constructed from the server's public URL.

---

## MCP tool tiers

Agents interact with Civigent through MCP tools organized in three tiers.

* Tier 1: for basic AI Agents and tools that want to work directly with markdown files on disk
* Tier 2: slight improvement on Tier 1 — adds intent declaration
* Tier 3: for advanced AI Agents (Claude Code, Cursor, etc) that can fully collaborate with human authors

### Tier 1: Filesystem-compatible (6 tools)

Drop-in tools that work like reading/writing files. Proposals are created automatically behind the scenes.

**NOTE:** Tier 1 agents will have their edits rejected more often, because they are not participating in the human/agent negotiation process, and Civigent defaults to rejecting any edit that conflicts. It is strongly recommended to use Tier 3 instead — so the agent can proactively collaborate and more of its edits will be accepted.

| Tool | Purpose |
|------|---------|
| `read_file` | Read a file or section |
| `write_file` | Write a single file/section |
| `write_files` | Write multiple files/sections |
| `list_directory` | List documents and directories |
| `delete_file` | Delete a file/section |
| `move_file` | Move/rename a file |

### Tier 2: Intent-aware (Tier 1 + 1 tool)

Adds intent declaration before writes. The agent describes what it plans to do, and the system can evaluate the plan against current human activity.

| Tool | Purpose |
|------|---------|
| `plan_changes` | Declare intent before making changes |

### Tier 3: Full collaboration (19 tools)

Explicit proposal management with fine-grained control over the collaboration workflow.

| Tool | Purpose |
|------|---------|
| `list_documents` | List readable documents in canonical scope |
| `list_sections` | List readable sections and body sizes (no body text) |
| `search_text` | Search readable canonical section bodies (literal or regexp) |
| `read_doc` | Read a complete document |
| `read_doc_structure` | Read document heading structure |
| `read_section` | Read a specific section |
| `create_proposal` | Create a new proposal |
| `write_section` | Write a section within a proposal |
| `commit_proposal` | Commit a proposal to canonical |
| `cancel_proposal` | Withdraw a proposal |
| `list_proposals` | List proposals (filterable by status) |
| `my_proposals` | List the agent's own proposals |
| `read_proposal` | Read a proposal's details and content |
| `create_section` | Create a new section |
| `delete_section` | Delete a section |
| `move_section` | Move a section |
| `rename_section` | Rename a section heading |
| `rename_document` | Rename a document |
| `delete_document` | Delete a document |

**Note:** All tools operate within proposals and go through the same conflict detection and human-involvement evaluation. Every structural tool requires a `proposal_id` parameter, same as `write_section`. Document deletion uses a tombstone in the proposal overlay; document rename uses tombstone at old path + full content copy at new path. All changes are committed via `commit_proposal`.

---

## Agent workflow (Tier 3)

The typical agent workflow is:

```
1. Discover content: list_documents / list_sections / search_text / read_doc_structure
2. Read content:     read_doc / read_section
3. Create proposal:  create_proposal (with sections and optional justifications)
4. Check evaluation: The response shows which sections are blocked/accepted
5. Modify if needed: write_section (adjust blocked sections, add justifications)
6. Commit:           commit_proposal
7. If blocked:       Wait for human activity to age out, modify proposal, or withdraw
```

### Only one proposal allowed at a time per agent

An agent can have at most **one pending proposal** at a time. Creating a new proposal while one is pending returns **409 Conflict** with the existing proposal's ID.

To auto-replace: use `create_proposal` with `replace: true` to automatically withdraw the existing proposal.

### Checking your proposals

```
my_proposals (status: "pending")   → your active proposal
my_proposals (status: "committed") → your completed proposals
```

---

## Troubleshooting

### "409 Conflict when creating a proposal"

The agent already has a pending proposal. Either:
- Commit or withdraw the existing proposal first
- Use `replace: true` in the `create_proposal` call to auto-withdraw

### "Agent's proposal is blocked"

A human recently edited one or more of the targeted sections. The agent can:
- Wait for the human-involvement score to decay below 0.5
- Add justifications to each blocked section (reduces score by 0.1)
- Modify the proposal to avoid blocked sections
- Withdraw and try a different approach

### "Agent cannot connect"

If the server is running with `KS_AGENT_AUTH_POLICY=register` or `verify`, anonymous agents are disabled. The agent needs a pre-registered identity. See the [Authentication Guide](authentication.md) and create an agent identity from the Agents page.

### "Agent connection lost after a month"

Anonymous agents' tokens expire monthly. The MCP client should automatically re-register. If not, manually reconnect via `/setup`.

For agents that need stable long-term identity, create a pre-registered agent — see the [Authentication Guide](authentication.md).

---

## What's next

- [Authentication Guide](authentication.md) — OAuth flow, policies, and token management
- [Configuration Reference](configuration.md) — tune involvement presets
- [Concepts Guide](concepts.md) — understand the collaboration model
- [Architecture Overview](architecture.md) — technical deep dive
