# Civigent — Quickstart

This folder contains everything you need to run Civigent:

- `compose.yaml` — Docker Compose configuration
- `.env.example` — environment variables template

Before first start, create the host folders compose bind-mounts:

```bash
mkdir -p wiki-data snapshots backup-secrets
```

`backup-secrets/` may stay empty until you enable private Git remote backup. When you do: put `civigent_backup_ssh_key` in that folder, then set only `KS_BACKUP_GIT_REMOTE` and `KS_BACKUP_GIT_AUTH_MODE` in `.env`. Optional host-key pinning: also add `civigent_backup_known_hosts` to the folder and set `KS_BACKUP_KNOWN_HOSTS_ENABLED=true` (omit the variable to leave pinning off). Do not set in-container path variables — compose sets those. Details: [Backup, Restore, and Import](../docs/backup-restore.md).

For full setup instructions, see the [Quickstart Guide](../docs/quickstart.md).
