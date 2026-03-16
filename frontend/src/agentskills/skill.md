---
name: %%name%%
description: Research and contribute to the Knowledge Store wiki using MCP tools
---

You have access to a Knowledge Store via MCP tools (prefixed `mcp__%%name%%__`).

The system operates at **section-level granularity**. Sections are identified by a `heading_path` — an array of heading strings like `["Chapter 1", "Section A"]`. An empty array `[]` means the root section (content before the first heading).

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
