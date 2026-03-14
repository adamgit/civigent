# Editing Guide

A detailed walkthrough of the Civigent editing experience.

---

## Opening a document

Navigate to a document using the sidebar tree or the document browser. Click any document to view it.

Documents display as a series of sections, each starting with a heading. Initially, all sections show as **read-only previews**.

## Editing blocks AI Agents

Core feature of Civigent: while you are editing a section no AI Agent can overwrite your changes; they are forced to wait until you've finished (and even then, depending on your YOLO/Aggressive/Conservative contention admin setting, they may be locked out for anywhere from seconds to hours)

## Entering edit mode

Click on any section to start editing. The editor loads for that section and its immediate neighbors (the section above and below). This keeps performance smooth even for documents with hundreds of sections.

As you arrow-key or click into other sections, editors mount and unmount dynamically. The transition is seamless — you can navigate through an entire document using arrow keys just like a normal text editor.

### Keyboard navigation

- **Arrow Up** at the top of a section moves focus to the section above
- **Arrow Down** at the bottom of a section moves focus to the section below
- Editors for neighboring sections are pre-mounted for instant transitions

## The Milkdown editor

Each section uses a Milkdown rich-text editor with full markdown support:

- Standard formatting: **bold**, *italic*, ~~strikethrough~~, `code`
- Headings, lists (ordered and unordered), blockquotes
- Code blocks with syntax highlighting
- Tables, horizontal rules, links, images
- Keyboard shortcuts for common formatting operations

The editor works with markdown under the hood — what you type is stored as standard markdown files.

---

## Save status indicators

### Per-section dots

Each section heading shows a small colored dot indicating its save status:

| Indicator | Meaning | What to do |
|-----------|---------|------------|
| No dot | Section is clean (no unsaved changes) | Nothing |
| Blue dot | You have unsaved local changes | Wait ~1-2 seconds for auto-save |
| Amber dot | Changes are being written to server's disk | Wait a moment |
| Green dot | Changes are saved on the server | You're good — changes survive a crash |

### Page-level banner

- **Yellow banner**: Connection is being re-established (brief interruption)
- **Red banner**: Connection lost — changes are temporarily stored locally in the browser, but are not being saved to server; editing is either disabled or strongly discouraged

### Top-right summary

Shows the aggregate status across all sections: how many are dirty, pending, or flushed.

---

## Automatic session management

### Idle timeout

If you haven't interacted with the editor for **60 seconds**, your editing session ends automatically:
- Your cursor disappears for other users
- Your changes are committed to version history
- Section locks are released

This prevents "camping" — where someone leaves a section open and blocks agents indefinitely.

### Tab close / navigation

When you close the tab or navigate away, your changes are saved and committed automatically. The Mirror panel (described below) shows what will be committed.

---

## The Mirror panel

The Mirror panel is a floating panel that shows all your **unpublished changes** across all documents.

### What it shows

For each document you've edited:
- Document name
- List of dirty sections (truncated to 3, expandable)
- A "Publish" button

### Actions

- **Publish** (per document): Creates an audit-log entry for all your changes for that document immediately
- **Publish All**: Creates an audit log including all your changes across all documents
- If you don't manually publish, changes auto-commit to the audit log based on heuritics, e.g. when you close the window

---

## Human proposals (pre-emptive edit locks)

When you need to perform a large set of changes as a single Audit-log entry, or that need to be stored together (e.g. changing the meaning of a concept and updating all docs to use the new concept - so it's an "all or nothing" change), you create a Proposal.

### Creating a proposal

1. Click **"Create Proposal"** in the document view
2. Enter a brief description of what you're working on (this appears in the audit trail)
3. You enter **proposal mode**

### Working in proposal mode

- Sections are added to your proposal automatically as you edit them
- Reserved sections show a **lock badge** to other users: "Reserved by [your name]"
- Other users cannot edit your reserved sections, giving you control of exactly what does into your edit
- You can edit sections across multiple documents — they're all part of the same proposal

### What changes in proposal mode

- The editor disconnects from real-time sync (your edits are private until you publish)
- A floating proposal panel shows your description, reserved sections, and action buttons
- Changes save to the proposal file, not to the shared editing session, before being committed to the audit log

### Publishing or cancelling

Note: all changes are autosaved continuously, independent of publishing.

- **Publish**: Moves all changes to the audit log. Locks are released. Other users see the updates immediately.
- **Cancel**: Discards all changes. Locks are released. The document reverts to its state before you started.

For quick edits (fixing a typo, adding a sentence), normal editing is simpler — just click, edit, and move on.

---

## Seeing other users

### Human presence

- Colored dots and name badges show which sections other humans are viewing
- Live cursors show exactly where others are typing
- These are cosmetic indicators — they don't affect locking or agent behavior

### Agent activity

- **"Agent reading"** indicator: a time-decaying signal showing an agent recently read a section (fades after a few seconds)
- **"Agent wants to modify"** notice: an agent is planning some work that involves changing this section
- **"Modified by [agent name]"** attribution: shows when an agent saved changes to the audit log, with the intent

---

## Copy/Paste uses full markdown syntax

Select text that spans multiple sections and press **Ctrl+C** (or Cmd+C on Mac). The clipboard receives clean, properly formatted markdown with the correct headings — not raw editor content.

Similarly: pasting any markdown text into the doc when editing will be auto-converted to correct headings, bullet points, etc.

---

## Deleting sections

When you delete a section heading in the editor:
1. An amber placeholder with struck-through text appears
2. The deletion is confirmed after the next save cycle (takes at most a few seconds)
3. The placeholder disappears once the server confirms

... this is to make it completely transparent that your deletion has been confirmed.

---

## Crash recovery

If the server crashes or restarts unexpectedly:
- Changes saved within the last ~2 seconds are preserved (the raw fragment files on disk)
- On restart, the server automatically recovers these changes and commits them to the audit log
- You may see a "crash recovery" entry in the version history

The data loss window is approximately 2 seconds — the time between automatic save cycles.

---

## What's next

- [Concepts Guide](concepts.md) — understand proposals, involvement scoring, and actor asymmetry
- [Configuration Reference](configuration.md) — customize presets and behavior
- [Agent Management](agent-management.md) — connect and manage AI agents
