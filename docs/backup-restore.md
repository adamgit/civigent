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

Civigent can push canonical published content history and durable auth/RBAC state to a private Git remote. The admin page at `/admin/git-backup` runs and monitors the backup on one half of the page, and shows operator setup/use instructions on the other. Restore only runs on a virgin target — this is a whole-instance clone, not a two-way sync.

### What the backup covers

- Canonical content Git history (the existing `data/.git` object graph, pushed exactly as-is — no rewrite, no rebase, no extra audit commit)
- Durable auth/RBAC state (`data/auth/defaults.json`, `roles.json`, `acl.json`, `custom-roles.json`, `agents.keys`), pushed on `refs/heads/auth/main`: each run builds a commit against a fresh throwaway index and parents it on the previous `auth/main` tip (first backup has no parent; later backups are normal fast-forwards). Restore still only checks out the tip — the chain exists so repeated backups can push without force

### What the backup does NOT cover

- **Proposals** (draft, pending, inprogress, committing, committed, withdrawn) — deliberately excluded, per spec
- **Companion deployment secrets** — `KS_AUTH_SECRET`, `KS_AGENT_ANON_SALT`, and OIDC configuration live outside the data root and must be copied separately (see [Companion secrets](#companion-secrets-to-copy-separately-when-migrating))
- **Snapshot cache** (`./snapshots/`) — derived, regenerated on demand

### How credentials are wired (compose owns the paths)

`compose.yaml` already:

- mounts `./backup-secrets` → `/run/secrets/civigent_backup`
- mounts `${SSH_AUTH_SOCK:-/dev/null}` → `/run/civigent/ssh_auth_sock`
- sets the in-container paths the app reads (do **not** put these in `.env`):
  - `KS_BACKUP_SSH_KEY_PATH=/run/secrets/civigent_backup/civigent_backup_ssh_key` (always set)
  - `KS_BACKUP_KNOWN_HOSTS_PATH=/run/secrets/civigent_backup/civigent_backup_known_hosts` — set **only** when you opt into host-key pinning with `KS_BACKUP_KNOWN_HOSTS_ENABLED` (non-empty, conventionally `true`) in `.env`; otherwise the path stays unset and no known_hosts file is claimed
  - `SSH_AUTH_SOCK=/run/civigent/ssh_auth_sock` only when the host has `SSH_AUTH_SOCK`

Operator `.env` only sets the remote URL, the auth mode, and (optionally) `KS_BACKUP_KNOWN_HOSTS_ENABLED=true`. To disable pinning, **omit** `KS_BACKUP_KNOWN_HOSTS_ENABLED` — do not set it to `false`; compose `:+` substitution treats any non-empty value as enabled.

### Set up SSH-key credentials (recommended)

1. In your deploy working folder (next to `wiki-data/` and `snapshots/`), create a dedicated deploy key. Do **not** copy a personal laptop key out of `~/.ssh/`:

    ```bash
    mkdir -p backup-secrets
    ssh-keygen -t ed25519 -f backup-secrets/civigent_backup_ssh_key -N "" -C "civigent-backup"
    ```

    Add the public half (`backup-secrets/civigent_backup_ssh_key.pub`) to your private backup repository as a deploy key / machine-user SSH key with write access.

2. Optionally pin the forge's SSH host key so the container can verify who it is talking to. To enable pinning, set `KS_BACKUP_KNOWN_HOSTS_ENABLED=true` in `.env` and write the forge's **published** host keys into `backup-secrets/civigent_backup_known_hosts` (OpenSSH `known_hosts` format, one line per key). Prefer the forge's own documentation for those keys; if you use `ssh-keyscan`, verify the fingerprints against that documentation before trusting the file.

    Pinning is off by default — with `KS_BACKUP_KNOWN_HOSTS_ENABLED` omitted, the admin page shows an advisory warning, but backup availability itself is governed by the remote reachability check. To turn pinning off later, remove the variable from `.env` (do not set it to `false`).

3. In your `.env` file, set only:

    ```env
    KS_BACKUP_GIT_REMOTE=git@<forge-host>:<owner>/<repo>.git
    KS_BACKUP_GIT_AUTH_MODE=ssh-key
    # optional, only with the pinning file from step 2 in place:
    # KS_BACKUP_KNOWN_HOSTS_ENABLED=true
    ```

    Do not set `KS_BACKUP_SSH_KEY_PATH`, `KS_BACKUP_KNOWN_HOSTS_PATH`, or `SSH_AUTH_SOCK` in `.env`. The admin page at `/admin/git-backup` builds these two lines from a remote URL you type in.

4. Restart the container:

    ```bash
    docker compose down && docker compose up -d
    ```

### Set up ssh-agent credentials (alternative)

For deployments that already manage Git credentials through `ssh-agent`. Convenient on Linux servers; can be more fragile on Docker Desktop for macOS/Windows.

1. In your `.env` file, set only:

    ```env
    KS_BACKUP_GIT_REMOTE=git@<forge-host>:<owner>/<repo>.git
    KS_BACKUP_GIT_AUTH_MODE=ssh-agent
    ```

2. Ensure the host has `SSH_AUTH_SOCK` set in the environment when you run `docker compose` (OpenSSH sets this). Do not put `SSH_AUTH_SOCK` in `.env`.

3. Restart the container:

    ```bash
    docker compose down && docker compose up -d
    ```

Host-key pinning works the same way in ssh-agent mode and is recommended: set `KS_BACKUP_KNOWN_HOSTS_ENABLED=true` and place `backup-secrets/civigent_backup_known_hosts` — same as step 2 of the SSH-key section. Compose points the app at the file only when that flag is set.

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

If active proposals exist, the page shows the completeness warning and **blocks** backup until every outstanding proposal is committed or withdrawn. There is no acknowledgement override — unpublished proposal work is never part of this export.

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

2. On the target, set the same two `.env` lines (`KS_BACKUP_GIT_REMOTE`, `KS_BACKUP_GIT_AUTH_MODE`) and copy the same `./backup-secrets/` files (setup steps above). Credential paths and volume mounts are already in `compose.yaml`.

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
