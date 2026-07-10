# Backup, Restore, and Import

How to get content into a Civigent instance, get it back out for safe-keeping, and clone a whole instance onto a new machine.

Three flows live here:

- **First-time import** from an existing directory of markdown files
- **Private Git remote backup** — push canonical content history + auth/RBAC state to a private Git remote
- **Restore** — clone a backed-up instance onto a virgin target

This is a one-directional export/import model. Two-way sync between two live instances is deliberately not supported — see [Sync between two live instances](#sync-between-two-live-instances) at the bottom.

For the environment-variable reference table, see [Configuration Reference — Environment variable reference](configuration.md#environment-variable-reference).

---

## First-time import from markdown files

Set `IMPORT_CONTENT_FROM` in your `.env` file to point at a directory of markdown files. This is a compose-level variable — it controls the host path that gets mounted into the container at `/import`. The server itself reads from that mount.

```env
IMPORT_CONTENT_FROM=/path/to/your/markdown
```

The import runs **once** on first startup when the content directory is empty. After that, it's skipped automatically (idempotent).

### Import behavior

- Each `.md` file becomes a document
- An atomic staging pattern ensures partial imports don't corrupt data

### Import rules

- **Case-insensitive duplicate detection**: Two headings at the same level with the same name (even different capitalization) cause the file to fail
- **`.importignore` support**: Place a `.importignore` file in the source directory to exclude files/folders (gitignore-style patterns: `*.obsidian/`, `node_modules/`, `.git/`)
- **Read-only mount**: The import source is mounted read-only (`/import:ro`) — your original files are never modified

### Import summary

The server logs a summary after import:
```
Import complete: 150 imported, 0 failed, 0 skipped
```

If files fail (e.g., duplicate headings), the summary includes error details per file.

---

## Private Git remote backup (optional)

Civigent can push canonical published content history and durable auth/RBAC state to a private Git remote. The admin page at `/admin/git-backup` runs and monitors the backup. Restore only runs on a virgin target — this is a whole-instance clone, not a two-way sync.

### What the backup covers

- Canonical content Git history (the existing `data/.git` object graph, pushed exactly as-is — no rewrite, no rebase, no extra audit commit)
- Durable auth/RBAC state (`data/auth/defaults.json`, `roles.json`, `acl.json`, `custom-roles.json`, `agents.keys`), pushed as a single orphan Git commit against a fresh throwaway index

### What the backup does NOT cover

- **Proposals** (draft, pending, inprogress, committing, committed, withdrawn) — deliberately excluded, per spec
- **Companion deployment secrets** — `KS_AUTH_SECRET`, `KS_AGENT_ANON_SALT`, and OIDC configuration live outside the data root and must be copied separately (see [Companion secrets](#companion-secrets-to-copy-separately-when-migrating))
- **Snapshot cache** (`./snapshots/`) — derived, regenerated on demand

### Set up SSH-key credentials (recommended)

The default documented path for quickstart and Docker deployments.

1. In your quickstart working folder (next to `wiki-data/` and `snapshots/`), create a `backup-secrets/` folder to hold the credentials, and drop a deploy key or machine-user SSH key into it:

    ```bash
    mkdir -p backup-secrets
    cp ~/.ssh/id_ed25519 backup-secrets/
    ```

    Grant this key access to your private backup repository (deploy key on GitHub, machine-user on GitLab, etc.).

2. Pin the remote host key so strict host-key checking still applies:

    ```bash
    ssh-keyscan github.com > backup-secrets/known_hosts
    ```

    Replace `github.com` with your forge host if different. The `known_hosts` file is optional — the admin page shows a warning when it is absent, but backup availability itself is governed by the remote reachability check.

3. In your `.env` file, add:

    ```env
    KS_BACKUP_GIT_REMOTE=git@github.com:your-org/civigent-data-backup.git
    KS_BACKUP_GIT_AUTH_MODE=ssh-key
    KS_BACKUP_SSH_KEY_PATH=/run/secrets/civigent_backup_ssh_key
    KS_BACKUP_KNOWN_HOSTS_PATH=/run/secrets/civigent_backup_known_hosts
    ```

4. In your `quickstart/compose.yaml`, add these two lines to the existing `volumes:` list under `services.backend`:

    ```yaml
          - ./backup-secrets/id_ed25519:/run/secrets/civigent_backup_ssh_key:ro
          - ./backup-secrets/known_hosts:/run/secrets/civigent_backup_known_hosts:ro
    ```

    Do not overwrite the existing volume lines — add these alongside `./wiki-data:/app/data` and the snapshot mount.

5. Restart the container:

    ```bash
    docker compose down && docker compose up -d
    ```

### Set up ssh-agent credentials (alternative)

For deployments that already manage Git credentials through `ssh-agent`. Convenient on Linux servers; can be more fragile on Docker Desktop for macOS/Windows.

1. In your `.env` file, add:

    ```env
    KS_BACKUP_GIT_REMOTE=git@github.com:your-org/civigent-data-backup.git
    KS_BACKUP_GIT_AUTH_MODE=ssh-agent
    ```

    `SSH_AUTH_SOCK` is already an environment variable in your host shell (managed by OpenSSH) — do not overwrite it in `.env`. It is passed through unchanged by the compose file.

2. In your `quickstart/compose.yaml`, add this line to `services.backend.volumes` to expose the host agent socket to the container:

    ```yaml
          - ${SSH_AUTH_SOCK}:${SSH_AUTH_SOCK}
    ```

3. Restart the container:

    ```bash
    docker compose down && docker compose up -d
    ```

Strict host-key checking still applies in ssh-agent mode. A mounted `known_hosts` is recommended — follow step 2 of the SSH-key section above and add `KS_BACKUP_KNOWN_HOSTS_PATH` + the `backup-secrets/known_hosts` volume line the same way.

### Running a backup

Open `/admin/git-backup` in the web UI. The page shows:

- backup feature state (configured / not configured)
- credential reachability (SSH key or agent socket)
- `known_hosts` warning, if any
- remote reachability
- atomic-push support
- local content + auth SHAs, remote content + auth SHAs
- last successful backup for this running process (in-memory only; resets on restart)

When feature state is `configured` and the reachability + atomic-push checks are green, click **Run quiet-state backup**. The backup runs under a process-wide lockdown: every live editor is disconnected for the duration and readiness returns automatically after the push completes.

If active proposals exist, the page shows the completeness warning:

> Live proposals in progress or pending — this export will not include unpublished proposal work.

Backup still runs. Confirm the warning to proceed.

### Verifying a backup

Click **Verify remote backup** on the same page. Verify reads the remote refs and compares them to local, showing content-ref and auth-ref match state.

---

## Restore onto a virgin target

Restore is a one-directional import: the target `data/` must be virgin. Restore refuses to run when any of these hold:

- the local Git repo has one or more content commits
- `content/` contains any files
- `auth/` contains any durable file (`defaults.json`, `roles.json`, `acl.json`, `custom-roles.json`, `agents.keys`)

Wipe the target `data/` before restoring; the admin page shows a red-state message with the specific reason when the target is not virgin.

### Companion secrets to copy separately when migrating

The backup does not include:

- `KS_AUTH_SECRET` (JWT signing secret)
- `KS_AGENT_ANON_SALT` (anonymous-agent token salt)
- OIDC configuration (`KS_OIDC_*` env vars)

If you copy these environment values to the target machine alongside the backup, existing sessions and pre-authenticated agent keys continue to validate. If you skip them, the imported auth state still loads, but every human and agent is forced to log out and re-authenticate on the new machine. This is usually a non-issue — agents will not connect to a new remote URL without re-auth anyway, so a fresh instance almost always requires re-authentication regardless.

### Running a restore

1. On the target machine, wipe any existing data root:

    ```bash
    rm -rf wiki-data && mkdir wiki-data
    ```

2. Configure the same backup env vars and volume mounts on the target as on the source (`.env` file + `quickstart/compose.yaml` additions from the setup steps above).

3. Start the container:

    ```bash
    docker compose up -d
    ```

4. Open `/admin/git-backup`. The `Restore target state` section shows a green state (`Target directory is virgin — restore may proceed`) when eligible.

5. Click **Restore from remote backup** and confirm the browser dialog. Restore runs under lockdown; readiness returns when both the content commit and the auth-tree checkout have completed.

After restore, `HEAD` on the target points at the same content commit as the source, and `data/auth/` matches the last backup snapshot. Proposal directories are left empty by design.

---

## Sync between two live instances

Not supported. This tool is a whole-instance backup/clone, not a two-way sync. Restore refuses to run on a non-virgin target so it cannot be accidentally misused as a sync mechanism.

If two people run separate Civigent instances and both want to end up with the same content, the intended flow is:

1. One instance is designated as the source.
2. The other target instance wipes its `data/` and runs a restore from the source's backup.

Content divergence between two live instances is not reconciled by this tool.

---

## What's next

- [Deployment Guide](deployment.md) — reverse proxy, Docker details, startup validation
- [Configuration Reference](configuration.md) — full env-var reference table, admin API, snapshots
