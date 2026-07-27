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

Use `KS_SNAPSHOT_ROOT` to control where snapshots are written inside the runtime environment. By default, snapshots live in a sibling `snapshots/` directory next to `KS_DATA_ROOT`, not inside the data root itself.

If you expose snapshots via a host bind mount, manually create the host snapshots folder first and ensure it is writable by the container process. The Snapshots admin page reports when the configured snapshot root is not writable.

For deployment guidance, see [Snapshots](deployment.md#snapshots-optional) in the Deployment Guide.

---

## Git remote backup

Civigent can push canonical published content history and durable auth/RBAC state to a private Git remote as a whole-instance backup. Restore only runs on a virgin target — this is a one-directional export/import, not a two-way sync. The admin page at `/admin/git-backup` runs and monitors it.

Proposal directories and companion deployment secrets (`KS_AUTH_SECRET`, `KS_AGENT_ANON_SALT`, OIDC config) are deliberately excluded from the backup contract.

Operator `.env` only sets `KS_BACKUP_GIT_REMOTE`, `KS_BACKUP_GIT_AUTH_MODE`, and optionally `KS_BACKUP_KNOWN_HOSTS_ENABLED`. Put the SSH key (and, when pinning is enabled, the `known_hosts` file) under `./backup-secrets/`; `compose.yaml` mounts that folder and sets the in-container paths. Full wiring: [Backup, Restore, and Import](backup-restore.md).

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
| `KS_AUTH_MODE` | Auth mode: `single_user`, `oidc`, or `hybrid` (required) | (none — required) |
| `KS_USER_NAME` | Human display name (single-user mode) | `Local User` |
| `KS_USER_EMAIL` | Human email (single-user mode) | `local-user@ks.local` |
| `KS_USER_ID` | Human ID override (single-user mode) | (auto-generated) |
| `KS_AGENT_AUTH_POLICY` | Agent auth policy: `open` (anonymous allowed), `register` (pre-registered client_id required), `verify` (pre-registered + client_secret required) | `open` (localhost) / `register` (public hostname) |
| `KS_AGENT_ANON_SALT` | Salt for signing anonymous agent tokens (change to revoke all) | (auto-generated) |
| `KS_DATA_ROOT` | Override the root data directory | (built-in default) |
| `KS_SNAPSHOT_ROOT` | Override the snapshots directory | sibling `snapshots/` directory next to `KS_DATA_ROOT` |
| `KS_SNAPSHOT_ENABLED` | Enable assembled document snapshots | `true` |
| `KS_GOVERNANCE_MODE` | Governance feature mode (`available` or `forced`) | `available` |
| `KS_FATAL_ERRORS_MODE` | What to do after a process-level fatal invariant failure: `report` keeps the process alive and surfaces the error to connected clients (accepts continued availability with the risk of further corruption); `crash` exits so an orchestrator/supervisor can restart. Invalid values fail at startup. | `report` |
| `KS_INVOLVEMENT_PRESET` | Human involvement preset (`yolo`, `aggressive`, `eager`, `conservative`) | `eager` |
| `KS_IMPORT_ROOT` | Path inside the container where the import volume is mounted | `/import` |

### Git remote backup (optional)

Wiring and `backup-secrets/` layout: [Backup, Restore, and Import — Private Git remote backup](backup-restore.md#private-git-remote-backup-optional).

**Operator `.env` (set these):**

| Variable | Purpose | Default |
|----------|---------|---------|
| `KS_BACKUP_GIT_REMOTE` | SSH URL of the private backup repository. When unset, the feature is off. | (unset — feature disabled) |
| `KS_BACKUP_GIT_AUTH_MODE` | `ssh-key` or `ssh-agent`. Required when `KS_BACKUP_GIT_REMOTE` is set. | (unset — required with the remote) |
| `KS_BACKUP_KNOWN_HOSTS_ENABLED` | Opt into host-key pinning: any non-empty value (conventionally `true`) makes compose set the fixed `KS_BACKUP_KNOWN_HOSTS_PATH`; also place `./backup-secrets/civigent_backup_known_hosts`. To disable, omit the variable — do not set `false` (compose `:+` treats it as enabled). | (unset — pinning off) |

**Host files for `ssh-key` mode** (conventional paths; not env vars):

| Host path | Role |
|-----------|------|
| `./backup-secrets/civigent_backup_ssh_key` | Dedicated deploy private key |
| `./backup-secrets/civigent_backup_known_hosts` | Pinned forge host keys, required only with `KS_BACKUP_KNOWN_HOSTS_ENABLED` |

**Set by `compose.yaml` (do not put in `.env`):**

| Variable | Value set by compose |
|----------|----------------------|
| `KS_BACKUP_SSH_KEY_PATH` | `/run/secrets/civigent_backup/civigent_backup_ssh_key` (always set) |
| `KS_BACKUP_KNOWN_HOSTS_PATH` | `/run/secrets/civigent_backup/civigent_backup_known_hosts` only when `KS_BACKUP_KNOWN_HOSTS_ENABLED` is set; otherwise unset |
| `SSH_AUTH_SOCK` | `/run/civigent/ssh_auth_sock` when the host has `SSH_AUTH_SOCK`; otherwise unset |

---

## What's next

- [Backup, Restore, and Import](backup-restore.md) — first-time markdown import, private Git remote backup, restore onto a virgin target
- [Agent Management](agent-management.md) — manage agent identities and access control
- [Architecture Overview](architecture.md) — understand how the system works internally
