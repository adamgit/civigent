---
name: %%name%%
description: Research and contribute to the Knowledge Store wiki using MCP tools
---

You have access to a Knowledge Store via MCP tools (prefixed `mcp__%%name%%__`).

The system operates at **section-level granularity**. Sections are identified by a `heading_path` — an array of heading strings like `["Chapter 1", "Section A"]`. An empty array `[]` means the before-first-heading section (content before the first heading).

## Reading & Research

1. **Find documents:** `list_docs` returns all documents in the store.
2. **Understand structure:** `read_doc_structure` shows a document's section tree (headings and nesting).
3. **Read content:** `read_section` reads a specific section by `doc_path` and `heading_path`. Use `read_doc` for an entire document.

## Making Changes (Proposal Workflow)

All changes go through a proposal. A proposal groups one or more section writes into an atomic unit that is evaluated against human-involvement scores before committing.

### Quick write (2 calls):

1. `create_proposal` — provide `intent` (string) and `sections` (array of `{doc_path, heading_path, content, justification?}`). Content is written immediately into the proposal.
2. `commit_proposal` — evaluates human-involvement and either commits (returns `committed_head`) or returns `blocked` with a list of contested sections and their scores.

### Incremental write (3+ calls):

1. `create_proposal` — create the proposal (can include initial content or not).
2. `write_section` — add or update section content within your proposal. Repeat as needed.
3. `commit_proposal` — same as above.

Use `cancel_proposal` to withdraw a proposal you no longer need.

### One draft per writer

Each agent (writer) can have only **one draft proposal at a time**. If you already have a draft proposal and call `create_proposal`, it will fail unless you pass `replace: true`. When `replace` is set, the existing draft is automatically withdrawn before the new proposal is created. Use this when you want to start fresh without manually cancelling the old proposal.

### Auto-creation of documents and sections

You do not need to pre-create documents or sections before writing to them. If you specify a `doc_path` that does not exist, the document is created automatically. Likewise, if a `heading_path` refers to a section that does not yet exist, it is created on the fly. This means agents can write to entirely new documents and sections in a single proposal without any prior setup.

### Proposal sizing for large batch writes

When writing many sections at once, prefer splitting work across multiple smaller proposals rather than packing everything into one. Large proposals that touch many sections increase the chance of contention (overlapping with human edits) and make review harder. A good rule of thumb: keep each proposal focused on a single logical change or a coherent group of related sections. If you need to update an entire document, consider one proposal per top-level section or logical chapter.

### When `commit_proposal` is blocked

Some sections may have high human-involvement scores (a human is actively editing). The proposal stays pending. You can wait for the contention to resolve, modify the proposal via `write_section`, or cancel it.

## Checking Proposals

- `my_proposals` — list your own proposals and their status.
- `list_proposals` — list all proposals. Check before creating new ones to avoid conflicts.
- `read_proposal` — read full details of a specific proposal.

## Structural Changes

These modify the document tree itself (headings, not body content). **All require an active proposal** — pass `proposal_id` to each call, then `commit_proposal` when done.

- `create_section`, `delete_section`, `move_section`, `rename_section`
- `delete_document`, `rename_document`

## Best Practices

- Always read current content before writing changes.
- Write clear intent descriptions in `create_proposal`.
- Check `list_proposals` before creating new ones to avoid conflicts.
- If a commit is blocked (human editing), wait and retry later — do not force.

## Troubleshooting

If the `mcp__%%name%%__` tools are not available, the MCP server likely needs authentication. Tell the user to run `/mcp` in their Claude Code terminal, select the "%%name%%" server, and choose "Authenticate". The server uses OAuth — a browser window will open briefly and auto-approve. After that, tools will be available immediately.
