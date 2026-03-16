# Agent Management

How to connect AI agents to Civigent and manage their access.

---

## Overview

Civigent supports AI agents (Claude Code, Cursor, and other MCP-compatible tools) as first-class collaborators. Agents connect via the **MCP (Model Context Protocol)** standard using OAuth 2.1 for authentication.

There are two tiers of agent authentication:

| Tier | Name | Identity | Revocation | Best for |
|------|------|----------|------------|----------|
| **1** | Anonymous | New UUID each session | Global only (change salt) | Evaluation, quickstart, network-gated |
| **2** | Pre-authenticated | Stable UUID across sessions | Per-agent (delete key) | Production, compliance, daily-use agents |

---

## Connecting an agent (quick method)

1. Start the server (c.f.[Quickstart Guide](quickstart.md))
2. Open the site in your browser, and use the link from the main page, or navigate to "/setup"
3. The setup page shows copy-paste instructions for your MCP client
4. Follow the instructions for your specific client (Claude Code, Cursor, etc.)

The setup page detects your server's configuration and generates the correct connection details.

---

## How agent authentication works

All agents authenticate via OAuth 2.1 with PKCE. The flow is:

```
1. Agent calls POST /oauth/register (Dynamic Client Registration)
   → receives a client_id

2. Agent opens your browser to GET /oauth/authorize
   → you approve the connection (or it auto-approves in single-user mode)
   → browser redirects back with an authorization code

3. Agent exchanges the code for tokens via POST /oauth/token
   → receives access_token + refresh_token

4. Agent makes MCP requests with Authorization: Bearer <access_token>
```

This happens automatically — the MCP client handles all steps. You just see a brief browser window during step 2.

### Single-user mode

In single-user mode, step 2 auto-approves instantly. The browser opens and closes in about 3 seconds. No login required.

### Multi-user mode

In multi-user mode, you must be logged in (via OIDC) to approve an agent connection. If you're not logged in, you'll be redirected to your OIDC provider first, then back to the approval page.

The consent page asks: *"Allow [agent name] to connect to this Civigent instance?"*

---

## Anonymous agents (Basic, Legacy)

This is for simple AI Agents. Most commercial agents do NOT need this - but 3rd party agents may rquire this.

Anonymous agents self-register without pre-existing credentials. They're the default for quickstart and evaluation.

### How it works

- Agent calls `POST /oauth/register` with just a name
- Server issues a **signed stateless `client_id`** (no server-side storage)
- The `client_id` contains the agent's UUID, name, and a month stamp
- Tokens expire monthly with a 1-month grace period

### Properties

- **Zero setup**: Any MCP client can connect immediately
- **No persistent state**: The server stores nothing for anonymous agents
- **Monthly rotation**: Anonymous registrations auto-expire, forcing re-registration
- **Global revocation**: Change `KS_AGENT_ANON_SALT` to invalidate all anonymous agents instantly
- **No individual revocation**: You cannot revoke a single anonymous agent without revoking all of them

### OPTIONAL: Disabling anonymous agents

```env
KS_AGENT_ANONYMOUS=false
```

When disabled, the DCR endpoint rejects anonymous registrations. Only pre-authenticated agents can connect.

---

## Pre-authorized agents (Standard, most AI Agents)

Commercial AI Agents (Claude Code, Cursor, etc) have in-built full support for authenticating, and can connect to the server automatically. 

They have to be pre-authorized by an admin.

The main benefit of pre-authorized agents is that they have long-term persistence, and a single agent will appear consistently in the audit log across sessions, linking all their proposals, commits, and history.

### Creating a pre-authenticated agent

**Via the admin pages**

Inside the app the Admin pages let you see all pre-authorized agents, revoke them, or add new ones.

### How pre-auth agents authenticate

The agent presents its secret during the OAuth DCR step:

```json
POST /oauth/register
{
  "client_name": "daily-metrics-updater",
  "client_secret": "sk_a1b2c3d4e5f6g7h8",
  ...
}
```

The server looks up the secret against the keys file (hashed comparison). If matched, returns the agent's stable ID as the `client_id`. The rest of the OAuth flow proceeds normally.

### Revoking a pre-authenticated agent

Delete the agent's line from `data/auth/agents.keys`. The next time the agent tries to authenticate, it will fail.

Existing access tokens remain valid until they expire (30 minutes). For immediate revocation, rotate `KS_AUTH_SECRET` — but this invalidates **all** tokens for all users.

### Properties

- **Stable identity**: Same UUID across all sessions, linked git history
- **Human accountability**: Admin knows who requested each agent
- **Individual revocation**: Delete the line from the keys file
- **Survives salt rotation**: Uses the JWT secret, not the anonymous salt

---

## MCP tool tiers

Agents interact with Civigent through MCP tools organized in three tiers.

* Tier 1: for basic AI Agents and tools that want to work directly with markdown files on disk
* Tier 2: slight improvement on Tier1
* Tier 3: for advanced AI Agents (Claude Code, Cursor, etc) that can fully collaborate with human authors

### Tier 1: Filesystem-compatible (6 tools)

Drop-in tools that work like reading/writing files. Proposals are created automatically behind the scenes.

**NOTE:** Tier1 agents will have their edits rejected more often, because they are not participating in the human/agent negotiation process, and Civigent will default to rejecting any edit that conflicts. It is strongly recommended to use Tier3 instead / upgrade your Agent to Tier3, so that it can pro-actively collaborate, and more of its edits will be accepted.

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

### Tier 3: Full collaboration (17 tools)

Explicit proposal management with fine-grained control over the collaboration workflow.

| Tool | Purpose |
|------|---------|
| `list_docs` | List all documents |
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

**Note:** All tools (content and structural) operate within proposals and go through the same conflict detection and human-involvement evaluation. Every structural tool requires a `proposal_id` parameter, same as `write_section`. Document deletion uses an empty-skeleton tombstone in the proposal overlay; document rename uses tombstone at old path + full content copy at new path. All changes are committed via `commit_proposal`.

---

## Agent workflow (Tier 3)

The typical agent workflow is:

```
1. Read content:     read_doc / read_section / read_doc_structure
2. Create proposal:  create_proposal (with sections and optional justifications)
3. Check evaluation: The response shows which sections are blocked/accepted
4. Modify if needed: write_section (adjust blocked sections, add justifications)
5. Commit:           commit_proposal
6. If blocked:       Wait for human activity to age out, modify proposal, or withdraw
```

### Only one Proposal allowed at a time per Agent

Experimental: we may relax this requirement in future; currently it exists to encourage Agents to behave as good actors.

An agent can have at most **one pending proposal** at a time. Creating a new proposal while one is pending returns **409 Conflict** with the existing proposal's ID.

To auto-replace: use `create_proposal` with `replace: true` to automatically withdraw the existing proposal.

### Checking your proposals

```
my_proposals (status: "pending")   → your active proposal
my_proposals (status: "committed") → your completed proposals
```

---

## OAuth discovery endpoints

MCP clients use these endpoints to discover the authentication flow:

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/oauth-protected-resource` | Resource discovery (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | OAuth metadata (RFC 8414) |
| `POST /oauth/register` | Dynamic Client Registration (RFC 7591) |
| `GET /oauth/authorize` | Authorization (browser-based) |
| `POST /oauth/token` | Token exchange and refresh |

All URLs in the metadata documents are **absolute**, constructed from `KS_OIDC_PUBLIC_URL`.

---

## Troubleshooting

### "OAuth flow fails — browser shows error page"

The server's `KS_OIDC_PUBLIC_URL` is wrong or not set. The browser is trying to reach a URL that doesn't point to your server.

**Fix:** Set `KS_OIDC_PUBLIC_URL` to the URL where the server is actually reachable from your machine.

### "409 Conflict when creating a proposal"

The agent already has a pending proposal. Either:
- Commit or withdraw the existing proposal first
- Use `replace: true` in the create call to auto-withdraw

### "Agent's proposal is blocked"

A human recently edited one or more of the targeted sections. The agent can:
- Wait for the human-involvement score to decay below 0.5
- Add justifications to each blocked section (reduces score by 0.1)
- Modify the proposal to avoid blocked sections
- Withdraw and try a different approach

### "Agent connection lost after a month"

Anonymous agents' `client_id` tokens expire monthly. The MCP client should automatically re-register. If not, manually reconnect.

For agents that need stable long-term identity, use pre-authenticated agents (Tier 2).

---

## What's next

- [Configuration Reference](configuration.md) — tune involvement presets
- [Concepts Guide](concepts.md) — understand the collaboration model
- [Architecture Overview](architecture.md) — technical deep dive
