# Quickstart

Get Civigent running on your machine in under 1 minute. No programming experience required.

## Options

1. Super-quickstart: use the pre-built docker image, everything is done for you
2. Build docker container yourself: takes a few more minutes, have to wait for everything to build



---

# Superquick

## Pre-requisites

- **Docker** installed and running. For Windows you need to install Docker Desktop, or work inside WSL and install docker for Linux. For Mac you need to install Docker Desktop, or docker+colima (or similar) via homebrew
- A terminal (Terminal on Mac, PowerShell on Windows, any terminal on Linux)

---

## Step 1: Get the quickstart files

You need two small files: `compose.yaml` and `.env.example`. These files are in the `quickstart/` folder of this repository.

Download these files to wherever you want to run Civigent:

* https://raw.githubusercontent.com/adamgit/civigent/main/quickstart/.env.example
* https://raw.githubusercontent.com/adamgit/civigent/main/quickstart/compose.yaml

Create a sub-folder to hold your Civigent data:

* e.g. Windows ```bash md my-wiki```
* e.g. Mac/Linux ```bash mkdir my-wiki```

Before first start, manually create the two host folders that `compose.yaml` bind-mounts into the container:

```bash
mkdir -p wiki-data snapshots
```

On plain Docker/Linux bind mounts, both `wiki-data/` and `snapshots/` must already exist and must be writable by the container process. If the Snapshots page shows a permission error or you see `EACCES`, fix the host-folder ownership/permissions before retrying.


## Step 2: Configure your personal account

Take the example config pre-provided, and rename it so that Civigent will use it:

Windows:
```bash
copy .env.example .env
```

Mac/Linux:
```bash
cp .env.example .env
```

Edit the new file in a text editor and uncommment / set the following:

```env
KS_AUTH_MODE=single_user
KS_USER_NAME=Your Name
KS_USER_EMAIL=you@example.com
```

* "KS_AUTH_MODE" = tells it to disable login/passwords for humans (great for quickstart, but in production you want to disable it and have login + multiple human users)
* "KS_USER_NAME", "KS_USER_EMAIL" = every change you make is saved to the audit-log, these values will be written in as the 'author' of each change

**OPTIONAL:** Change the default port (from 8080)

For quickstart, the default port for Civigent is 8080. You can change this by editing the first line of the .env file you created. Everything uses that, no other change needed.

```env
PORT=8080
```

## Step 3: Start the server

Use DockerDesktop, or: open your terminal, navigate to the folder you created, and run:

```bash
# NOTE: to get latest version, you may need to update - see step 5 below
docker compose up
```

Wait until you see a message like `Civigent running at http://localhost:8080`.

## Step 4: Open the app

Go to **http://localhost:8080** (or whatever port you chose) in your browser. You're done.

## Step 5: Stopping and restarting

**Stop:** Press `Ctrl+C` in the terminal, or run `docker compose down`.

**Restart:** Run `docker compose up` again. All your data is saved in the `wiki-data/` folder.

**Update:** Run `docker compose pull` then `docker compose up` to get the latest version.

**Back up your data:** Copy the `wiki-data/` folder. It contains everything durable — your content, edit history, and proposals. The separate `snapshots/` folder is a derived cache and should not be backed up.

For an offsite backup that pushes canonical content history and auth/RBAC state to a private Git remote (and can restore onto a new machine), see the [Backup, Restore, and Import](backup-restore.md) guide.

---

## Importing existing content

If you already have markdown files you want to use, set `IMPORT_CONTENT_FROM` in your `.env` file to point at the folder containing your markdown:

```env
IMPORT_CONTENT_FROM=/path/to/your/markdown/folder
```

Then restart with `docker compose down && docker compose up`.

Content is imported **once** on first startup. After that, the import is skipped automatically (your edits in the app are safe).

### Import rules

- Each `.md` file becomes a document
- If two headings at the same level have the same name (even different capitalization), the import will fail for that file

For the full import behavior, `.importignore` support, and the private Git remote backup + restore flow, see [Backup, Restore, and Import](backup-restore.md).

---

## Connecting an AI agent

Civigent is designed for humans and AI agents to collaborate. To connect an agent (like Claude Code or Cursor):

1. Open **http://localhost:8080/setup** (or replace the 8080 based on the port you chose in config) in your browser
2. Follow the copy-paste instructions shown on that page
3. The agent will briefly open your browser for authorization, then connect automatically

In single-user mode (the default for quickstart), authorization is instant — no login needed.

Each agent gets its own identity. You'll see its name in the edit history, proposals, and coordination views.

---

## Snapshots

Snapshots are enabled by default in quickstart. Civigent writes complete assembled `.md` files to the host folder `./snapshots/`.

The `snapshots/` folder is a read-only derived cache for external tools. Do not edit it, and do not include it in backups.

Because quickstart uses host bind mounts, you must manually create both `wiki-data/` and `snapshots/` on the host before first start, and both folders must be writable by the container process.

To disable snapshots entirely, edit `.env`:

```env
KS_SNAPSHOT_ENABLED=false
```

If you need a different in-container snapshot path, set `KS_SNAPSHOT_ROOT` and update the snapshots bind mount in `compose.yaml` to match.

---

## Folder structure

```
my-wiki/
├── compose.yaml
├── .env
├── snapshots/              ← assembled markdown cache (derived, do not back up)
└── wiki-data/              ← your knowledge store (back this up)
    ├── content/            ← documents (skeletons + sections)
    ├── proposals/          ← work audit trail (auto-managed)
    ├── drafts/             ← in-progress work (auto-managed, ephemeral)
    └── .git/               ← version history
```

---

## What's next

- [Concepts Guide](concepts.md) — understand how sections, proposals, and human/agent collaboration work
- [Editing Guide](editing-guide.md) — detailed guide to the editing experience
- [Configuration Reference](configuration.md) — customize involvement presets, enable snapshots, and more
- [Agent Management](agent-management.md) — set up persistent agent identities and manage access
