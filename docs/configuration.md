# Configuration Reference

How to tune Civigent's behavior for your team.

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

### Enabling snapshots

```env
SNAPSHOT_ENABLED=true
```

Snapshots are regenerated when content changes. They're a derived cache — never part of the source of truth.

### Exposing snapshots to the host

Mount a volume to the snapshot-endpoint when starting the container:

```yaml
volumes:
  - ./snapshots:/app/snapshot
environment:
  SNAPSHOT_ENABLED: "true"
```

---

## Auth mode configuration

### Single-user mode

```env
KS_AUTH_MODE=single_user
KS_USER_NAME=Alice
KS_USER_EMAIL=alice@example.com
```

Bypasses human authentication entirely. The configured identity is used for all human actions. Agents still authenticate via OAuth and get distinct identities.

### Multi-user mode (default)

Requires OIDC provider configuration:

```env
KS_OIDC_ISSUER=https://auth.company.com/realms/main
KS_OIDC_CLIENT_ID=civigent
KS_OIDC_CLIENT_SECRET=<secret>
```

Humans log in via the OIDC provider. Each human gets a deterministic UUID derived from their OIDC subject identifier.

---

## What's next

- [Agent Management](agent-management.md) — manage agent identities and access control
- [Deployment Guide](deployment.md) — full deployment instructions
- [Architecture Overview](architecture.md) — understand how the system works internally
