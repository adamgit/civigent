# Key Concepts

This guide explains the ideas behind Civigent. Read this before diving into the editing or admin guides.

---

## Documents and sections

A **document** is a markdown file. Each heading (`#`, `##`, `###`, etc.) is the start of a "section".

Sections are the fundamental unit of everything in the system:
- **Editing** happens one section at a time
- **Conflict detection** is per-section
- **Locking** is per-section
- **Agent proposals** target specific sections

This means two people (or a person and an AI agent) can edit *different sections* of the same document at the same time without interfering with each other.

### Standard markdown with ONE exception

Within a document it is impossible for two headings at the same level to have the same name - if you attempt to do this the second one will be rejected/blocked.

This is the only divergence from standard Markdown and was a compromise we had to make to keep the rest of the system simple to implement and maintain. We are actively considering backend changes that will let us remove this restriction in future.


### Nested structure

Headings nest naturally. A `##` under a `#` is a child section. On disk, this is represented as a folder hierarchy — but you never need to think about that. The app shows it as a single document.

---

## Humans and agents

Civigent has two kinds of users:

- **Humans** edit content live in the browser using a rich text editor
- **Agents** (AI tools like Claude Code or Cursor) edit content through an API

The system treats these differently because **human work is expensive and agent work is cheap**. An agent can regenerate its work in seconds; a human's careful edits might represent hours of thought.

This asymmetry is intentional and shapes everything:

---

## Audit log

Every change is stored in a git-backed private log. The system tries to heuristically guess which human edits should be bundled together in a single log-entry (e.g. if you close the window that's interpreted as 'finishing' a set of edits to the document). A catch-all checks if you've made a large number of changes over time without triggering any of the heuristics and automatically forces a 'checkpoint' entry to be stored to the log.

Human authors can optionally 'publish changes' at any moment to force an audit-log entry with their current/recent changes.

### Publishing

Only humans can do this, and it takes all their in-flight edits that haven't been moved to the audit log, and saves them as a single entry.

### Bypassing the auto-commit heuristics

Humans can create a Proposal if they want to bypass the heuristics - e.g. if they want precise control over what gets bundled into the commit/audit-log.

---

## Proposals

A **proposal** is a bundle of changes to one or more sections across one or more documents, that then are stored in a single entry in the audit log.

### Agent proposals

Agents **must** submit proposals to change content. They cannot edit directly. The system evaluates each proposed section change against a "human-involvement" score — a measure of how recently a human was working on that section.

- If no human was recently editing → the proposal is **accepted** and can be committed
- If a human was recently editing → the proposal is **blocked** until the human's activity ages out

Agents can include a **justification** for each section change, which gives a small bonus toward acceptance.

### Human proposals

By default, humans don't need Proposals - they just edit and move on. But humans can optionally create proposals to collate all their changes into a single auditable edit, with finer-grained control than the auto-commit/publishing system (proposals bypass the automated/fallback 'commit to audit log after maximum time period'), or to pre-emptively reserve parts of documents they plan on changing.

1. Click "Create Proposal" to enter proposal mode
2. Edit sections as normal — they're automatically reserved for you
3. Other users (human or agent) see those sections as locked
4. When done, click "Publish" to commit all changes at once
5. Or click "Cancel" to discard everything

### Proposal lifecycle

Every proposal goes through these states:

```
Created → Pending → Committed (done)
                  → Withdrawn (cancelled)
```

- **Pending**: The proposal exists and can be modified. May be blocked (some sections contested) or unblocked (all sections pass)
- **Committed**: Changes have been written to the permanent version history. Done.
- **Withdrawn**: The proposal was cancelled. No changes were made.

A user can have at most **one pending proposal** at a time (this may be relaxed in future, currently it's an experimental rule)

---

## Human-involvement scoring

This is the system's way of protecting human work from being overwritten by agents.

Every section has a **human-involvement score** between 0 and 1:
- **1.0** = a human is actively editing this section right now (hard block)
- **0.5** = threshold — above this, agent proposals are blocked
- **0.0** = no recent human activity (agents can write freely)

The score decays over time following a sigmoid curve. How fast it decays depends on the admin preset:

| Preset | Protection window | Best for |
|--------|-------------------|----------|
| **YOLO** | ~30 seconds | Solo use, demos |
| **Aggressive** | ~5 minutes | Fast-paced teams |
| **Eager** (default) | ~2 hours | Mixed human/agent teams |
| **Conservative** | ~8 hours | Regulated industries |

In future we plan to make this extensible so that you can exert finer-grained control over human actions that influence how 'involved'/engaged your human authors are with the texts - and how happy they are for Agents to overwrite/modify their work.

### Hard blocks vs soft blocks

There is no difference between them at all. But AI Assisted code editors (Claude Code, Cursor) get confused and keep injecting 'hard block/soft block' language into code and docs they author, so for clarity this is what they mean:

- **Hard block** (score = 1.0): A human has the section open in their editor, or has unsaved changes. No agent can touch it.
- **Soft block** (0.5 < score < 1.0): The human finished editing recently. The score will decay below 0.5 over time.

### Aggregate impact

Even if every individual section passes, a proposal can still be blocked if it touches too many sections with moderate involvement scores. This prevents "death by a thousand cuts" — many small changes that collectively represent a major overwrite of recent human edits.

This is experimental, and will be tuned (or removed, or extended) in a future release.

---

## Audit log

Every change is tracked in git. You can browse the full history in the Audit log page. Each commit shows:
- Who made the change (human name or agent identity)
- When it was made
- What sections were affected
- The exact diff of what changed

The data directory is a standard git repository. You can also use regular git tools to inspect history.

It is NOT connected to any other git repositories and CANNOT be used to publish to e.g. a GitHub repo. It is part of the system internals and is private. However: there is nothing stopping you from connecting it and synching to a downstream repo - but behaviour of the core system is undefined once you make the git repo non-private / multi-system.

### Storing your data in git

Git itself allows nested git-in-git as a core feature - there's nothing wrong with putting your entire data folder into your own git repo (in fact: this is recommended). The internal private git repo will simply be ignored by your outer one (or you can optionally configure git to store it as well, in order to store the git history / audit log into your main repo).

---

## Real-time collaboration

Multiple users can view and edit the same document simultaneously:
- You see other users' cursors and selections in real time
- Colored presence indicators show who's editing which section
- Changes sync instantly via WebSocket

The system uses CRDT (Conflict-free Replicated Data Types) technology to merge concurrent edits without conflicts within a section.

### Unusual use of CRDT

Note that most/all other CRDT-based systems and wikis/knowledgebases/document-stores use CRDT exclusively for storing and sharing text - but Civigent does NOT. Civigent uses CRDT as one small part of a bigger (and simpler!) datamodel (CRDT is complex and necessary to capture all the nuances of human/human co-editing and collaborative working, but is over complicated for the actual data) . 

Here CRDT only provides the connection between human users and the backend, the backend itself uses the private markdown-based document store and audit-log, and AI Agents bypass CRDT entirely.

---

## What's next

- [Editing Guide](editing-guide.md) — detailed walkthrough of the editing experience
- [Configuration Reference](configuration.md) — customize the system for your team
- [Deployment Guide](deployment.md) — set up a production instance
