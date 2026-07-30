# Authentication

How Civigent authenticates humans and AI agents.

---

## Overview

Civigent has two distinct authentication systems — one for **humans** and one for **agents** — because they connect in fundamentally different ways:

| Actor | Auth method | Identity source |
|-------|-------------|-----------------|
| Human | Browser login (OIDC) or bypass (single-user) | OIDC provider or configured name |
| Agent | OAuth 2.1 with PKCE | Anonymous self-registration or pre-registered key |

Both systems produce JWTs that the server validates on every request. Humans carry their token in a cookie; agents carry theirs as a `Bearer` token in the `Authorization` header.

---

## Human authentication

### Single-user mode

In single-user mode, human authentication is bypassed entirely. A fixed identity (configured by env vars) is used for all human actions.

```env
KS_AUTH_MODE=single_user
KS_USER_NAME=Alice
KS_USER_EMAIL=alice@example.com
```

Agents still go through full OAuth even in single-user mode — they just get auto-approved at the consent step.

### Multi-user mode

In multi-user mode, humans log in via an external OIDC provider (Google, Keycloak, Auth0, Okta, etc.). Civigent acts as an OIDC relying party.

```env
KS_OIDC_ISSUER=https://auth.company.com/realms/main
KS_OIDC_CLIENT_ID=civigent
KS_OIDC_CLIENT_SECRET=<your-oidc-secret>
```

Any provider with a standard OIDC discovery document works: Google Workspace, Microsoft Entra ID, Keycloak, Authentik, Okta, Auth0, and others. See [SSO Setup](sso-setup.md) for step-by-step instructions per provider.

Each human gets a deterministic UUID derived from their OIDC subject identifier. The same person always gets the same UUID regardless of which machine they use.

### Human session tokens

After login, Civigent issues its own short-lived JWT pair:

| Token | Lifetime | Purpose |
|-------|----------|---------|
| Access token | 30 minutes | Authenticates API requests |
| Refresh token | 30 days | Exchanges for a new access token silently |

Tokens are stored in browser cookies (httpOnly, sameSite). Refresh happens automatically — users are never interrupted with a re-login during normal use.

---

## Agent authentication

All agents authenticate via **OAuth 2.1 with PKCE** (RFC 6749 / draft-ietf-oauth-v2-1). This is the same standard used by Claude Code, Cursor, and other MCP-compatible tools, so they handle the entire OAuth flow automatically.

### The OAuth flow

```
1. Agent calls POST /oauth/register  (Dynamic Client Registration — optional, see below)
   → receives a client_id

2. Agent opens a browser to GET /oauth/authorize
   → you approve the connection (auto-approves in single-user mode)
   → browser redirects back with a short-lived authorization code

3. Agent exchanges the code at POST /oauth/token
   → sends client_id + code + PKCE code_verifier (+ client_secret if policy requires it)
   → receives access_token + refresh_token

4. Agent makes MCP requests with Authorization: Bearer <access_token>
```

Steps 1–3 happen automatically. In single-user mode, the browser window opens and closes in about 3 seconds with no interaction required.

---

## Agent authentication policy

The `KS_AGENT_AUTH_POLICY` env var controls how strictly agents must prove their identity. The default depends on the deployment:

The legal values are exactly `open`, `approve`, and `confidential`. Any other value — including the removed `register` and `verify` — refuses server startup with a FATAL error.

| Policy | Default when | What it means |
|--------|-------------|---------------|
| `open` | `KS_EXTERNAL_HOSTNAME` is `localhost` | Any agent can self-register. Anonymous identities are allowed. |
| `approve` | Set explicitly | Anonymous registration is allowed, but a signed-in human must approve each agent's first connection in the browser (`/approve-agent-access`). |
| `confidential` | `KS_EXTERNAL_HOSTNAME` is a non-localhost hostname | Admin-created identity required AND the agent must prove possession of its `client_secret` at the token endpoint. |

```env
KS_AGENT_AUTH_POLICY=open          # anyone can connect
KS_AGENT_AUTH_POLICY=approve       # self-register + one-time human Approve in the browser
KS_AGENT_AUTH_POLICY=confidential  # admin-created identity + must present secret
```

### When to use each policy

**`open`** — Personal use, localhost, network-gated environments. Anyone who can reach the server can connect an agent. Zero admin overhead.

**`approve`** — Team servers where a human wants to admit each agent once. Agents self-register anonymously, then the connection's browser window asks a signed-in human to Approve before the first token is issued. The agent name shown on the consent page is self-asserted by the agent, not verified — this level gates *admission*, not *which software* is connecting. `approve` is incompatible with `KS_AUTH_MODE=single_user` (the server refuses to start with that combination, because in single-user mode a credential-less request already resolves to the built-in local human and the consent gate would approve itself).

**`confidential`** — Internet-exposed instances, headless/CI agents, and high-security environments. Each agent identity is explicitly created by an admin and must present its `client_secret` at the token endpoint. Prevents an agent from connecting even if someone knows its ID. `agents.keys` rows created without a secret (`none`) cannot connect until their secret is rotated.

---

## Anonymous agents (`open` and `approve` policies)

When policy is `open` or `approve`, agents can self-register without any pre-existing credentials:

- Agent calls `POST /oauth/register` with just a name
- Server issues a **signed stateless `client_id`** (nothing is stored server-side)
- The `client_id` encodes the agent's UUID, name, and a month stamp
- Tokens expire monthly — the agent re-registers automatically

**Properties:**
- Zero setup — any MCP client connects immediately
- Identity is not persistent across monthly rotations (history is not linked across months)
- Global revocation: change `KS_AGENT_ANON_SALT` to invalidate all anonymous agents at once
- No individual revocation

Under `approve`, the flow is the same except the browser window that opens during authorization asks a signed-in human to Approve the agent before the code is issued.

Anonymous agents are disabled automatically when policy is `confidential`.

---

## Pre-registered agents

Pre-registered agents have a stable identity — the same UUID appears in the audit log across all sessions, linking all proposals, commits, and history. They work under every policy and are mandatory under `confidential`.

### Creating a pre-registered agent

Use the **Agents page** in the web app (the `+` card) or the Admin pages. The system generates a `client_id` and a `client_secret` (shown once at creation).

### Connecting with a registered identity

Provide the `client_id` to your MCP client so it skips Dynamic Client Registration and uses the stable ID directly:

**Claude Code:**
```bash
claude mcp add --transport http --client-id <client_id> my-agent https://your-server/mcp
```

With a secret (required for `confidential` policy):
```bash
claude mcp add --transport http --client-id <client_id> --client-secret my-agent https://your-server/mcp
```

Claude Code will prompt for the client secret after you run the command.

**Cursor** — add to `~/.cursor/mcp.json` or `.cursor/mcp.json` in your project:
```json
{
  "mcpServers": {
    "my-agent": {
      "url": "https://your-server/mcp",
      "auth": {
        "CLIENT_ID": "<client_id>"
      }
    }
  }
}
```

For `confidential` policy (also include the secret):
```json
{
  "mcpServers": {
    "my-agent": {
      "url": "https://your-server/mcp",
      "auth": {
        "CLIENT_ID": "<client_id>",
        "CLIENT_SECRET": "<secret>"
      }
    }
  }
}
```

Both Claude Code and Cursor open a browser for the consent step, then are fully connected.

### How the secret is used

When a `client_secret` is configured, it is sent as a POST body parameter during the token exchange (`POST /oauth/token`). This is standard `client_secret_post` authentication per RFC 6749.

The secret is **not** validated at the registration endpoint — it is only checked at the token endpoint. This is the correct OAuth 2.1 enforcement point.

### Revoking a pre-registered agent

Use the Agents page in the web app, or delete the agent's line from `data/auth/agents.keys` directly.

Existing access tokens remain valid until they expire (30 minutes). For immediate revocation of all tokens for all users, rotate `KS_AUTH_SECRET` — but this is a last resort as it logs out everyone.

---

## Token lifetime

| Token | Default |
|-------|---------|
| Access token | 30 minutes |
| Refresh token | 30 days |

Both humans and agents use the same token lifetime settings. Agents refresh automatically via `refresh_token` grant.

---

## Env var reference

| Variable | Purpose | Default |
|----------|---------|---------|
| `KS_AUTH_MODE` | Auth mode: `single_user`, `oidc`, or `hybrid` (required) | (none — required) |
| `KS_AUTH_SECRET` | JWT signing secret — required in multi-user mode | (insecure dev default) |
| `KS_OIDC_ISSUER` | OIDC provider URL for human login | (none — required in multi-user) |
| `KS_OIDC_CLIENT_ID` | OIDC client ID | (none) |
| `KS_OIDC_CLIENT_SECRET` | OIDC client secret | (none) |
| `KS_AGENT_AUTH_POLICY` | Agent auth policy: `open`, `approve`, or `confidential` | `open` (localhost) / `confidential` (public) |
| `KS_AGENT_ANON_SALT` | HMAC key for anonymous agent tokens — change to revoke all | (auto-generated, logged) |

---

## Migration from the removed `register` / `verify` policies

The old `register` and `verify` policy values were removed in favor of the `open` / `approve` / `confidential` ladder. These are hard breaks — nothing is migrated automatically:

- **`KS_AGENT_AUTH_POLICY=register` or `=verify` refuses startup.** Edit your env to one of the three legal values. If your public-hostname server left the var unset and relied on the old `register` default, the effective default is now `confidential` — set the value explicitly if you want something else.
- **The id-only "allowlisted `client_id`, no secret" behavior (`register`) is gone with no replacement.** Choose `confidential` (admin-created identity + secret), `open`, or `approve`.
- **`agents.keys` rows with a `none` secret cannot connect under `confidential`.** Rotate their secret from the Agents/Admin pages, or delete and recreate them (every create now generates a secret). `agents.keys` is never rewritten automatically.
- **MCP client configs holding only a client id** need the client secret added for `confidential`. If the plaintext secret is lost, rotate it first and copy the new value.

---

## What's next

- [SSO Setup](sso-setup.md) — step-by-step OIDC configuration for Google, Entra ID, Keycloak, and others
- [Agent Management](agent-management.md) — connecting agents, MCP tiers, and agent workflow
- [Deployment Guide](deployment.md) — full env var reference and deployment scenarios
- [Configuration Reference](configuration.md) — human-involvement presets and admin settings
