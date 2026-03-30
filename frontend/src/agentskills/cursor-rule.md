---
description: How to use the Knowledge Store MCP tools for reading, writing, and managing wiki documents
globs:
alwaysApply: true
---

# Knowledge Store — MCP Tool Usage Guide

You have access to a Knowledge Store via MCP tools (prefixed `mcp__%%name%%__`).
These tools let you read, write, and manage structured wiki documents.

The system operates at **section-level granularity**. Sections are identified by a `heading_path` — an array of heading strings like `["Chapter 1", "Section A"]`. An empty array `[]` means the before-first-heading section (content before the first heading).

## Reading & Research

1. **Find documents:** `list_docs` returns all documents in the store.
2. **Understand structure:** `read_doc_structure` shows a document's section tree (headings and nesting).
3. **Read content:** `read_section` reads a specific section by `doc_path` and `heading_path`. Use `read_doc` for an entire document.

## Making Changes (Proposal Workflow)

**All changes require a proposal.** A proposal groups one or more section writes into an atomic unit that is evaluated against human-involvement scores before committing.

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

## Important Behaviours

- **Always read before writing** — use `read_section` or `read_doc_structure` first.
- **Human-involvement guards** — some sections may be blocked because a human is editing them. This is expected, not an error. Wait and retry later.
- **Clear intent** — write descriptive intent in `create_proposal` so reviewers understand your purpose.
