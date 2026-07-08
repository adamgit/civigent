---
name: %%name%%
description: Research and contribute to the Knowledge Store wiki using MCP tools
---

You have access to a Knowledge Store via MCP tools (prefixed `mcp__%%name%%__`).

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

Read the content before the first heading from the published/live wiki:
```
{{tool:readPublishedSection}}(doc_path: "/my-doc.md", heading_path: [])
```

Read a section as it currently appears inside a proposal:
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

All changes go through a proposal. A proposal groups one or more section writes into an atomic unit. When you publish, the proposal must pass two gates before its changes land in the published/live system: the proposal-lock check (no other proposal currently holds an exclusive claim on your target sections) and the agent write-policy check (agents are permitted to write the targeted sections right now).

### Quick write (2 calls):

1. `{{tool:createProposal}}` — provide `intent` (string) and `sections` (array of `{doc_path, heading_path, content, justification?}`). Note: `heading_path` inside `sections` is also a JSON array of strings. Content is written immediately into the proposal.
2. `{{tool:publishProposal}}` — runs the publish gates and either publishes (returns `committed_head`) or reports that the proposal cannot be published yet, with a per-target indication of which sections are currently unavailable and a human-readable explanation of why.

Example — create a proposal that writes to two sections:
```
{{tool:createProposal}}(
  intent: "Add ship weapons catalog",
  sections: [
    { doc_path: "/ships.md", heading_path: ["Weapons", "Cannons"], content: "..." },
    { doc_path: "/ships.md", heading_path: ["Weapons", "Missiles"], content: "..." }
  ]
)
```

### Incremental write (3+ calls):

1. `{{tool:createProposal}}` — create the proposal (can include initial content or not).
2. `{{tool:writeProposalSection}}` — add or update section content within your proposal. Repeat as needed.
3. `{{tool:readProposalSection}}` or `{{tool:readProposal}}` — inspect the proposal content you just wrote.
4. `{{tool:publishProposal}}` — same as above.

Use `{{tool:withdrawProposal}}` to withdraw a proposal you no longer need.

### One draft per writer

Each agent (writer) can have only **one draft proposal at a time**. If you already have a draft proposal and call `{{tool:createProposal}}`, it will fail unless you pass `replace: true`. When `replace` is set, the existing draft is automatically withdrawn before the new proposal is created. Use this when you want to start fresh without manually cancelling the old proposal.

### Auto-creation of documents and sections

You do not need to pre-create documents or sections before writing to them. If you specify a `doc_path` that does not exist, the document is created automatically. Likewise, if a `heading_path` refers to a section that does not yet exist, it is created on the fly. This means agents can write to entirely new documents and sections in a single proposal without any prior setup.

### Proposal sizing for large batch writes

When writing many sections at once, prefer splitting work across multiple smaller proposals rather than packing everything into one. Large proposals that touch many sections increase the chance of contention (overlapping with human edits) and make review harder. A good rule of thumb: keep each proposal focused on a single logical change or a coherent group of related sections. If you need to update an entire document, consider one proposal per top-level section or logical chapter.

### When `{{tool:publishProposal}}` cannot publish

A publish can be held back for two reasons. A target section may be claimed by another proposal that currently holds an exclusive lock (for example a human is working through their own proposal on that section), or the agent write-policy in force may not permit agents to write a targeted section right now. In both cases the proposal stays draft and the response explains, per target, which sections are unavailable. The right response is one of: wait and retry once the contention clears, narrow the proposal with `{{tool:writeProposalSection}}` so it no longer touches the unavailable sections, or withdraw it. Do not force a publish — treat the explanation as guidance, not an error.

## Checking Proposals

- `{{tool:myProposals}}` — list your own proposals and their status.
- `{{tool:listProposals}}` — list all proposals. Check before creating new ones to avoid conflicts.
- `{{tool:readProposal}}` — read full details of a specific proposal.

## Structural Changes

These modify the document tree itself (headings, not body content). **All require an active proposal** — pass `proposal_id` to each call, then `{{tool:publishProposal}}` when done.

- `{{tool:createSection}}`, `{{tool:deleteSection}}`, `{{tool:moveSection}}`, `{{tool:renameSection}}`
- `{{tool:deleteDocument}}`, `{{tool:renameDocument}}`

## Best Practices

- Always read current live content before writing changes.
- After writing to a proposal, verify proposal content with `{{tool:readProposalSection}}` or `{{tool:readProposal}}`. Do not use `{{tool:readPublishedSection}}` for that — it reads the published/live system and will not show your proposal-only edits.
- Write clear intent descriptions in `{{tool:createProposal}}`.
- Check `{{tool:listProposals}}` before creating new ones to avoid conflicts.
- If a publish cannot proceed (a target is locked by another proposal, or agent write-policy disallows it), wait and retry later, narrow your scope, or withdraw — do not force.

## Troubleshooting

If the `mcp__%%name%%__` tools are not available, the MCP server likely needs authentication. Tell the user to run `/mcp` in their Claude Code terminal, select the "%%name%%" server, and choose "Authenticate". The server uses OAuth — a browser window will open briefly and auto-approve. After that, tools will be available immediately.
