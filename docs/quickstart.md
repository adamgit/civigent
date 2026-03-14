# Quickstart

Get Civigent running on your machine in under 5 minutes. No programming experience required.

---

## What you need

- **Docker** installed and running. This is included on most OS's already. For Windows you need to install Docker Desktop, or work inside WSL and install docker for Linux.
- A terminal (Terminal on Mac, PowerShell on Windows, any terminal on Linux)

That's it. Nothing else to install.

---

## Step 1: Get the quickstart files

You need two small files: `compose.yaml` and `.env.example`. Both are in the `quickstart/` folder of this repository.

**Option A — download the 'quickstart' folder** from the [GitHub repository](https://github.com/adamgit/civigent/tree/releases/quickstart) and copy it anywhere on your machine.

**Option B — curl** (Mac/Linux):

```bash
mkdir my-wiki && cd my-wiki
curl -sO https://raw.githubusercontent.com/adamgit/civigent/releases/quickstart/compose.yaml
curl -sO https://raw.githubusercontent.com/adamgit/civigent/releases/quickstart/.env.example
```

## Step 2: Configure your personal account

Then create your `.env`:

```bash
cp .env.example .env
```

Open `.env` in a text editor and set your name and email — these appear in the edit history:

```env
KS_AUTH_MODE=single_user
KS_USER_NAME=Your Name
KS_USER_EMAIL=you@example.com
```

## Step 3: Start the server

Use DockerDesktop, or: open your terminal, navigate to the folder you created, and run:

```bash
docker compose up
```

Wait until you see a message like `Server listening on port 3000`.

## Step 4: Open the app

Go to **http://localhost:8080** in your browser. You're done.

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

---

## Connecting an AI agent

Civigent is designed for humans and AI agents to collaborate. To connect an agent (like Claude Code or Cursor):

1. Open **http://localhost:8080/setup** in your browser
2. Follow the copy-paste instructions shown on that page
3. The agent will briefly open your browser for authorization, then connect automatically

In single-user mode (the default for quickstart), authorization is instant — no login needed.

Each agent gets its own identity. You'll see its name in the edit history, proposals, and coordination views.

---

## Host-visible snapshot folder

To browse rendered documents from your host (e.g. mount in Obsidian), edit `.env`:

```env
SNAPSHOT_DIR=./snapshot
```

Restart with `docker compose down && docker compose up`. The `snapshot/` folder contains complete `.md` files assembled from the knowledge store. It is a read-only cache — do not edit these files.

---

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

---

## Stopping and restarting

**Stop:** Press `Ctrl+C` in the terminal, or run `docker compose down`.

**Restart:** Run `docker compose up` again. All your data is saved in the `wiki-data/` folder.

**Update:** Run `docker compose pull` then `docker compose up` to get the latest version.

**Back up your data:** Copy the `wiki-data/` folder. It contains everything — your content, edit history, and proposals.

---

## What's next

- [Concepts Guide](concepts.md) — understand how sections, proposals, and human/agent collaboration work
- [Editing Guide](editing-guide.md) — detailed guide to the editing experience
- [Configuration Reference](configuration.md) — customize involvement presets, enable snapshots, and more
- [Agent Management](agent-management.md) — set up persistent agent identities and manage access
