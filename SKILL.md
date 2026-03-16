# Knowledge Store MCP Skill

Connect to the Knowledge Store via MCP (Model Context Protocol) to read, write, and manage documents collaboratively.

## Endpoint

```
/mcp/tier3
```

Tier 3 provides the full proposal-based collaboration workflow. Use this endpoint when connecting as an AI agent (Claude, Cursor, etc.).

## Available Tiers

| Tier | Endpoint | Tools | Use case |
|------|----------|-------|----------|
| 1 | `/mcp/tier1` | read_file, write_file, write_files, list_directory, delete_file, move_file | Simple file operations |
| 2 | `/mcp/tier2` | Tier 1 + plan_changes | File operations with intent declaration |
| 3 | `/mcp/tier3` | Proposal workflow + structural tools | Full collaboration with human-involvement checks |
| auto | `/mcp` | Auto-detect by User-Agent | Claude/Cursor -> tier 3, others -> tier 1 |

## Tier 3 Tools

### Proposal workflow

All writes in tier 3 go through the proposal system. Create a proposal, write sections, then commit.

- **create_proposal** - Start a new proposal with intent description and target sections
- **write_section** - Write content to a section within a proposal
- **commit_proposal** - Submit proposal for evaluation; auto-commits if no human contention
- **cancel_proposal** - Withdraw a pending proposal
- **list_proposals** - List proposals by status
- **my_proposals** - List your own proposals
- **read_proposal** - Read proposal details and evaluation status

### Reading

- **list_docs** - List all documents
- **read_doc** - Read full assembled document content
- **read_doc_structure** - Read document heading hierarchy
- **read_section** - Read a single section by heading path

### Structural changes (within proposals)

- **create_section** - Add a new section under a parent heading path
- **delete_section** - Remove a section and its descendants
- **move_section** - Move a section to a new parent
- **rename_section** - Rename a section heading
- **delete_document** - Delete an entire document (tombstone pattern)
- **rename_document** - Move a document to a new path (tombstone + copy)

## Proposal workflow

1. `create_proposal` with intent and target sections
2. `write_section` for each section you want to change
3. `commit_proposal` to submit
   - If all sections pass human-involvement checks: auto-committed
   - If contested by human editors: proposal stays pending for human review
