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

Read a top-level section called "Overview" from the published/live wiki:
```
{{tool:readPublishedSection}}(doc_path: "/my-doc.md", heading_path: ["Overview"])
```

Read a nested section "Weapons" inside "Ship Building" from the published/live wiki:
```
{{tool:readPublishedSection}}(doc_path: "/my-doc.md", heading_path: ["Ship Building", "Weapons"])
```

Read a section from a proposal:
```
{{tool:readProposalSection}}(proposal_id: "<proposal-id>", doc_path: "/my-doc.md", heading_path: ["Overview"])
```

## Reading & Research

1. **Find documents:** `{{tool:listDocuments}}` returns readable documents in the live wiki.
2. **Inspect section inventory:** `{{tool:listSections}}` returns section headings and `body_size_bytes` without body text.
3. **Search before reading:** `{{tool:searchText}}` supports `syntax: "literal" | "regexp"` for exact phrases and patterns.
4. **Understand structure:** `{{tool:readDocStructure}}` shows a document's section tree (headings and nesting).
5. **Read published content:** `{{tool:readPublishedSection}}` reads a specific section by `doc_path` and `heading_path` (JSON array of strings) from the published/live (canonical) system. It will NOT show proposal-only edits. Use `{{tool:readDoc}}` for an entire document.
6. **Read proposal content:** `{{tool:readProposalSection}}` reads a specific section from a proposal. `{{tool:readProposal}}` reads the whole proposal and its section content.

## Making Changes (Proposal Workflow)

**All changes require a proposal.** A proposal groups one or more section writes into an atomic unit. At publish time the proposal must pass two gates: the proposal-lock check (no other proposal holds an exclusive claim on your target sections) and the agent write-policy check (agents are permitted to write the targeted sections right now).

### Quick write (2 calls):

1. `{{tool:createProposal}}` — provide `intent` (string) and `sections` (non-empty array of `{doc_path, heading_path, content, justification?}`). Content is written immediately into the proposal. Keep this call small when possible — very large tool-call JSON is a common client-side failure mode.
2. `{{tool:publishProposal}}` — runs the publish gates and either publishes (returns `committed_head`) or reports that the proposal cannot be published yet, with a per-target indication of which sections are unavailable and a human-readable explanation of why.

### Incremental write (preferred for large content):

1. `{{tool:createProposal}}` — create a draft with `intent` and at least one section (a small first section is fine).
2. `{{tool:writeProposalSection}}` — add or update section content within that same draft. Repeat as needed. Prefer this over packing a huge body into `create_proposal`.
3. `{{tool:readProposalSection}}` or `{{tool:readProposal}}` — inspect the proposal content you just wrote.
4. `{{tool:publishProposal}}` — same as above.

Use `{{tool:withdrawProposal}}` to withdraw a proposal you no longer need.

### Drafts and `replace` (dangerous footgun)

Prefer **one live draft** and extend it with `{{tool:writeProposalSection}}`. Do **not** set `replace: true` to update section content — that is what `write_proposal_section` is for.

`replace: true` on `{{tool:createProposal}}` permanently withdraws an existing draft, then creates a **new** proposal with a **new** `proposal_id`. After a successful replace:

- Discard the old proposal ID immediately.
- Use **only** the new `proposal_id` from the create response for every later write/publish.
- Writing to the withdrawn ID fails with a terminal-state error; that is not a server outage. Call `{{tool:myProposals}}` with `status: "draft"` to recover the active draft ID if you lost track.

### When `{{tool:publishProposal}}` cannot publish

A publish can be held back when a target section is claimed by another proposal holding an exclusive lock (for example a human working through their own proposal on that section), or when the agent write-policy in force does not permit agents to write a targeted section right now. The proposal stays draft and the response explains, per target, which sections are unavailable. Respond by waiting and retrying once the contention clears, narrowing the proposal via `{{tool:writeProposalSection}}` so it no longer touches the unavailable sections, or withdrawing it.

## Checking Proposals

- `{{tool:myProposals}}` — list your own proposals and their status.
- `{{tool:listProposals}}` — list all proposals. Check before creating new ones to avoid conflicts.
- `{{tool:readProposal}}` — read full details of a specific proposal.

## Structural Changes

These modify the document tree itself (headings, not body content). **All require an active proposal** — pass `proposal_id` to each call, then `{{tool:publishProposal}}` when done.

- `{{tool:createSection}}`, `{{tool:deleteSection}}`, `{{tool:moveSection}}`, `{{tool:renameSection}}`
- `{{tool:deleteDocument}}`, `{{tool:renameDocument}}`

## Important Behaviours

- **Always read before writing** — use `{{tool:readPublishedSection}}` or `{{tool:readDocStructure}}` first.
- **Verify proposal content with proposal reads** — after writing to a proposal, use `{{tool:readProposalSection}}` or `{{tool:readProposal}}`. Do not use `{{tool:readPublishedSection}}` for draft verification; it reads the published/live system and will not show your proposal-only edits.
- **Publish gates** — a target section may be unavailable because another proposal holds an exclusive lock on it, or because agent write-policy does not currently permit agents to write it. This is expected, not an error. Wait and retry later, narrow your scope, or withdraw.
- **Clear intent** — write descriptive intent in `{{tool:createProposal}}` so reviewers understand your purpose.
