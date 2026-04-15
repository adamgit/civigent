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

| Policy | Default when | What it means |
|--------|-------------|---------------|
| `open` | `KS_EXTERNAL_HOSTNAME` is `localhost` | Any agent can self-register. Anonymous identities are allowed. |
| `register` | `KS_EXTERNAL_HOSTNAME` is a non-localhost hostname | Only pre-registered agents can connect. Presenting the registered `client_id` is sufficient — no secret needed. |
| `verify` | Set explicitly | Pre-registration required AND the agent must prove possession of its `client_secret` at the token endpoint. |

```env
KS_AGENT_AUTH_POLICY=open    # anyone can connect
KS_AGENT_AUTH_POLICY=register  # must be pre-registered
KS_AGENT_AUTH_POLICY=verify    # pre-registered + must present secret
```

### When to use each policy

**`open`** — Personal use, localhost, network-gated environments. Anyone who can reach the server can connect an agent. Zero admin overhead.

**`register`** — Team servers and internet-exposed instances. Each agent identity is explicitly created by an admin. Prevents unknown agents connecting. Best for teams who want audit trails showing which named agent did what. No secret distribution needed — agents connect with `--client-id` only.

**`verify`** — Headless/CI agents and high-security environments. Agents must present a `client_secret` at the token endpoint in addition to their `client_id`. Prevents an agent from connecting even if someone knows its ID. Required for unattended agents that cannot do an interactive browser auth flow.

---

## Anonymous agents (`open` policy only)

When policy is `open`, agents can self-register without any pre-existing credentials:

- Agent calls `POST /oauth/register` with just a name
- Server issues a **signed stateless `client_id`** (nothing is stored server-side)
- The `client_id` encodes the agent's UUID, name, and a month stamp
- Tokens expire monthly — the agent re-registers automatically

**Properties:**
- Zero setup — any MCP client connects immediately
- Identity is not persistent across monthly rotations (history is not linked across months)
- Global revocation: change `KS_AGENT_ANON_SALT` to invalidate all anonymous agents at once
- No individual revocation

Anonymous agents are disabled automatically when policy is `register` or `verify`.

---

## Pre-registered agents (`register` and `verify` policies)

Pre-registered agents have a stable identity — the same UUID appears in the audit log across all sessions, linking all proposals, commits, and history.

### Creating a pre-registered agent

Use the **Agents page** in the web app (the `+` card) or the Admin pages. The system generates a `client_id` and optionally a `client_secret`.

### Connecting with a registered identity

Provide the `client_id` to your MCP client so it skips Dynamic Client Registration and uses the stable ID directly:

**Claude Code:**
```bash
claude mcp add --transport http --client-id <client_id> my-agent https://your-server/mcp
```

With a secret (required for `verify` policy):
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

For `verify` policy (also include the secret):
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
| `KS_AGENT_AUTH_POLICY` | Agent auth policy: `open`, `register`, or `verify` | `open` (localhost) / `register` (public) |
| `KS_AGENT_ANON_SALT` | HMAC key for anonymous agent tokens — change to revoke all | (auto-generated, logged) |

---

## What's next

- [SSO Setup](sso-setup.md) — step-by-step OIDC configuration for Google, Entra ID, Keycloak, and others
- [Agent Management](agent-management.md) — connecting agents, MCP tiers, and agent workflow
- [Deployment Guide](deployment.md) — full env var reference and deployment scenarios
- [Configuration Reference](configuration.md) — human-involvement presets and admin settings
