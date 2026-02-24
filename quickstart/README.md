# Knowledge Store — Quick Start

## Prerequisites

- Docker and Docker Compose

## Setup

```bash
mkdir my-wiki && cd my-wiki
curl -sO https://raw.githubusercontent.com/yourorg/knowledge-store/main/quickstart/compose.yaml
curl -sO https://raw.githubusercontent.com/yourorg/knowledge-store/main/quickstart/.env.example
cp .env.example .env
docker compose up -d
```

The wiki is now running at `http://localhost:8080`.

Your data lives in `wiki-data/`. This directory is the single source of truth — back it up and/or put it under version control.

## Optional: Import existing markdown content

To import existing markdown files on first startup, add this to `.env`:

```
IMPORT_CONTENT_FROM=/path/to/your/markdown
```

Then start normally:

```bash
docker compose up -d
```

On first startup (when `wiki-data/content` is empty), the system will automatically import all `.md` files from that path.

## Optional: Host-visible snapshot folder

To browse rendered documents from your host (e.g. mount in Obsidian), edit `.env`:

```
SNAPSHOT_DIR=./snapshot
```

Restart with `docker compose up -d`. The `snapshot/` folder contains complete `.md` files assembled from the knowledge store. It is a read-only cache — do not edit these files.

## Optional: Force single-user mode

For quick trials/testing without external auth provider setup, enable single-user mode in `.env`:

```
KS_AUTH_MODE=single_user
KS_USER_NAME=Local User
KS_USER_EMAIL=local-user@ks.local
```

Then restart:

```bash
docker compose up -d
```

This is opt-in only. Default quickstart remains provider-based auth mode.

## Folder structure

```
my-wiki/
├── compose.yaml
├── .env
└── wiki-data/              ← your knowledge store (back this up)
    ├── content/            ← documents (skeletons + sections)
    ├── proposals/          ← work audit trail (auto-managed)
    ├── drafts/             ← in-progress work (auto-managed, ephemeral)
    └── .git/               ← version history
```

## Stopping and updating

```bash
docker compose down          # stop
docker compose pull          # update images
docker compose up -d         # restart
```
