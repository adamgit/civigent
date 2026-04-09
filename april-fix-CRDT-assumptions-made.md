# April CRDT assumptions made

This file records implementation assumptions that were not explicitly specified in `TRANSIENT WORKING DOCS/april-fix-CRDT-editing-v2.md`.

## Assumptions

1. `DocumentResourceModel` should become the read/rename/delete resource owner for page composition roots, while keeping existing API client methods unchanged.
2. `section_file` remains in `GET /documents/:docPath/sections` for metadata, but frontend CRDT identity must use backend-owned `fragment_key`.
3. The crash fix for `updateActivity` should prioritize restoring server stability immediately, even while deeper refactor work is still in progress.
4. Existing and user-modified files that were already dirty before this work were treated as in-progress context and were not reverted or reformatted globally.

## Superseding user directive

- User explicitly required: **no backwards compatibility under any circumstances**.
- Any earlier transitional-compatibility assumptions are superseded and should be treated as invalid going forward.

