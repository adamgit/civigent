# Configuration Reference

How to tune Civigent's behavior for your team. For deployment setup, environment variables, and auth configuration see the [Deployment Guide](deployment.md).

---

## Human-involvement presets

The human-involvement score controls how long human edits are "protected" from agent overwrites. The score decays over time following a sigmoid curve:

```
score(t) = 1 / (1 + (t / midpoint) ^ steepness)
```

Where `t` is seconds since the last human activity on a section.

### Available presets

| Preset | Agents blocked for |  Best for |
|--------|------------------|----------|
| **yolo** | ~30 seconds | Solo use, demos. Almost no protection. |
| **aggressive** | ~5 minutes  | Fast-paced teams with quick agent turnaround |
| **eager** (default) | ~2 hours  | Mixed human/agent teams. Balanced protection. |
| **conservative** | ~8 hours  | Regulated industries. Full workday protection. |

Each section in each markdown document is tracked individually. In YOLO mode AI agents are able to edit everythign almost immediately. In Conservative mode AI Agents can only edit sections 1 working day after the last human finished editing them.

### Justification bonus

When an agent includes a per-section justification in its proposal, the involvement score is reduced by **0.1**. This means a section with score 0.55 (normally blocked) becomes 0.45 (accepted) with justification.

The practical impact varies by preset:

| Preset | Wait time reduced by justification |
|--------|------------------------------------|
| YOLO | ~20 seconds |
| Aggressive | ~3 minutes |
| Eager | ~75 minutes (significant) |
| Conservative | ~5 hours (major unlock) |

i.e. in YOLO mode, a well-behaved AI Agent (that is crafting detailed 'why I am overwriting this section/document' messages) is able to edit anything barely 10 seconds (30s default, minus the 20s reduction) after the last human finished editing it - practically instant as far as the humans are concerned.

### Aggregate impact threshold

Experimental: this may be removed or tuned or re-designed in a future release.

Even when every individual section passes (score < 0.5), a proposal can be blocked if the **sum of all section scores** exceeds **2.5**. This prevents agents from making many moderate-impact changes in a single proposal, and encourages AI Agents to make a larger number of smaller, more focussed, edits.

Example: 6 sections each with score 0.45 = aggregate 2.7 > 2.5 → proposal blocked.

### Changing the preset

Use the Admin page in the web UI.

The preset takes effect immediately for all future evaluations. Existing pending proposals are re-evaluated on their next commit attempt.

Or use the admin API:

```
PUT /api/admin/config
Content-Type: application/json

{
  "humanInvolvement_preset": "conservative"
}
```

---

## Hard blocks

Regardless of the preset, certain conditions always result in a score of 1.0 (hard block):

| Condition | Block reason |
|-----------|-------------|
| Human has the section open in their editor | `live_session` |
| Human has unsaved changes for the section | `dirty_session_files` |
| Section is reserved by a human proposal | `human_proposal` |

---

## Admin page

The Admin page (`/admin` in the web UI) provides:

- **Preset selector**: Change the human-involvement preset
- **Current configuration**: View active midpoint and steepness values
- **System health**: Snapshot status and other diagnostics

### Admin API endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/config` | GET | Read current admin configuration |
| `/api/admin/config` | PUT | Update configuration (preset, snapshot settings) |

---

## Snapshot configuration

Snapshots are pre-assembled markdown documents written to disk. They're useful for:
- External tools that need to read complete documents
- Integration with other systems
- Quick file-based access to current content

Snapshots are enabled via `KS_SNAPSHOT_ENABLED=true` (default: `true`). They are regenerated when content changes and are a derived cache — never part of the source of truth.

For instructions on exposing snapshots to the host filesystem, see [Snapshots](deployment.md#snapshots-optional) in the Deployment Guide.

---

## Environment variable reference

### Required for production (non-single-user mode)

| Variable | Purpose | Example |
|----------|---------|---------|
| `KS_OIDC_PUBLIC_URL` | URL where the server is reachable by users and agents | `https://wiki.company.com` |
| `KS_AUTH_SECRET` | JWT signing secret (generate with `openssl rand -hex 32`) | `a1b2c3...` |

### Optional

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Port the server listens on inside the container (not the host-facing port) | `3000` |
| `KS_EXTERNAL_PORT` | The external host port users connect on. Required — set automatically by the compose files. Used to construct the public URL. | (none — required) |
| `KS_EXTERNAL_HOSTNAME` | The external hostname or IP users connect on. Set to your domain for non-localhost deployments. Combined with `KS_EXTERNAL_PORT` to derive the public URL. | `localhost` |
| `KS_AUTH_MODE` | Set to `single_user` for personal use | (multi-user) |
| `KS_USER_NAME` | Human display name (single-user mode) | `Local User` |
| `KS_USER_EMAIL` | Human email (single-user mode) | `local-user@ks.local` |
| `KS_USER_ID` | Human ID override (single-user mode) | (auto-generated) |
| `KS_AGENT_AUTH_POLICY` | Agent auth policy: `open` (anonymous allowed), `register` (pre-registered client_id required), `verify` (pre-registered + client_secret required) | `open` (localhost) / `register` (public hostname) |
| `KS_AGENT_ANON_SALT` | Salt for signing anonymous agent tokens (change to revoke all) | (auto-generated) |
| `KS_AUTH_CREDENTIALS_USERNAME` | Username for credentials auth mode (also `KS_ADMIN_EMAIL`) | (none) |
| `KS_AUTH_CREDENTIALS_PASSWORD` | Password for credentials auth mode (also `KS_ADMIN_PASSWORD`) | (none) |
| `KS_AUTH_ACCESS_TTL_SECONDS` | Access token lifetime in seconds | `1800` |
| `KS_AUTH_REFRESH_TTL_SECONDS` | Refresh token lifetime in seconds | `2592000` |
| `KS_DATA_ROOT` | Override the root data directory | (built-in default) |
| `KS_SNAPSHOT_ROOT` | Override the snapshots directory | `<data_root>/snapshots` |
| `KS_SNAPSHOT_ENABLED` | Enable assembled document snapshots | `true` |
| `KS_GOVERNANCE_MODE` | Governance feature mode (`available` or `forced`) | `available` |
| `KS_INVOLVEMENT_PRESET` | Human involvement preset (`yolo`, `aggressive`, `eager`, `conservative`) | `eager` |
| `KS_IMPORT_ROOT` | Path inside the container where the import volume is mounted | `/import` |

---

## What's next

- [Agent Management](agent-management.md) — manage agent identities and access control
- [Architecture Overview](architecture.md) — understand how the system works internally
