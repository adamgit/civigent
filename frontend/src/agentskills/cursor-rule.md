---
description: How to use the Knowledge Store MCP tools for reading, writing, and managing wiki documents
globs:
alwaysApply: true
---

# Knowledge Store — MCP Tool Usage Guide

You have access to a Knowledge Store via MCP tools (prefixed `mcp__%%name%%__`).
These tools let you read, write, and manage structured wiki documents.

The system operates at **section-level granularity**. Sections are identified by a `heading_path` parameter which is a **JSON array of strings** representing the path through nested headings. An empty array `[]` means the before-first-heading section (content before the first heading).

**Critical:** `heading_path` must be passed as a real JSON array, never as a string. Correct: `["Chapter 1", "Section A"]`. Wrong: `"[\"Chapter 1\", \"Section A\"]"`.

### Examples

Read a top-level section called "Overview":
```
read_live_section(doc_path: "/my-doc.md", heading_path: ["Overview"])
```

Read a nested section "Weapons" inside "Ship Building":
```
read_live_section(doc_path: "/my-doc.md", heading_path: ["Ship Building", "Weapons"])
```

Read a section from a proposal:
```
read_proposal_section(proposal_id: "<proposal-id>", doc_path: "/my-doc.md", heading_path: ["Overview"])
```

## Reading & Research

1. **Find documents:** `list_documents` returns readable documents in the live wiki.
2. **Inspect section inventory:** `list_sections` returns section headings and `body_size_bytes` without body text.
3. **Search before reading:** `search_text` supports `syntax: "literal" | "regexp"` for exact phrases and patterns.
4. **Understand structure:** `read_doc_structure` shows a document's section tree (headings and nesting).
5. **Read live content:** `read_live_section` reads a specific section by `doc_path` and `heading_path` (JSON array of strings). Use `read_doc` for an entire document.
6. **Read proposal content:** `read_proposal_section` reads a specific section from a proposal. `read_proposal` reads the whole proposal and its section content.

## Making Changes (Proposal Workflow)

**All changes require a proposal.** A proposal groups one or more section writes into an atomic unit that is evaluated against human-involvement scores before committing.

### Quick write (2 calls):

1. `create_proposal` — provide `intent` (string) and `sections` (array of `{doc_path, heading_path, content, justification?}`). Content is written immediately into the proposal.
2. `publish_proposal` — evaluates human-involvement and either publishes (returns `committed_head`) or returns `blocked` with a list of contested sections and their scores.

### Incremental write (3+ calls):

1. `create_proposal` — create the proposal (can include initial content or not).
2. `write_proposal_section` — add or update section content within your proposal. Repeat as needed.
3. `read_proposal_section` or `read_proposal` — inspect the proposal content you just wrote.
4. `publish_proposal` — same as above.

Use `withdraw_proposal` to withdraw a proposal you no longer need.

### When `publish_proposal` is blocked

Some sections may have high human-involvement scores (a human is actively editing). The proposal stays draft. You can wait for the contention to resolve, modify the proposal via `write_proposal_section`, or withdraw it.

## Checking Proposals

- `my_proposals` — list your own proposals and their status.
- `list_proposals` — list all proposals. Check before creating new ones to avoid conflicts.
- `read_proposal` — read full details of a specific proposal.

## Structural Changes

These modify the document tree itself (headings, not body content). **All require an active proposal** — pass `proposal_id` to each call, then `publish_proposal` when done.

- `create_section`, `delete_section`, `move_section`, `rename_section`
- `delete_document`, `rename_document`

## Important Behaviours

- **Always read before writing** — use `read_live_section` or `read_doc_structure` first.
- **Verify proposal content with proposal reads** — after writing to a proposal, use `read_proposal_section` or `read_proposal`. Do not use `read_live_section` for draft verification.
- **Human-involvement guards** — some sections may be blocked because a human is editing them. This is expected, not an error. Wait and retry later.
- **Clear intent** — write descriptive intent in `create_proposal` so reviewers understand your purpose.
