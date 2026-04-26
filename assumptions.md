# Assumptions

- `AcceptResult` is an overlay acceptance receipt only. It should not carry live Y.Doc rewrite instructions, client remap payloads, or a replacement session section index.
- Dirty-status UI should react to coarse invalidation events (`writer:dirty-state-changed`, `session:status-changed`) and then refetch authoritative state, rather than relying on per-section websocket payloads derived from live-session mappings.
- A live fragment only has a user-facing section identity when the authoritative overlay/canonical skeleton can resolve it. If a structurally dirty live fragment is ahead of that authoritative view, it is not surfaced as a named dirty section until settle assigns that authoritative identity.
- Writer-scoped dirty section attribution is captured from the server-authoritative focused heading path at the moment a fragment is marked dirty. If no focus is available, dirty persistence falls back to a doc-level placeholder instead of reconstructing section identity from fragment keys later.
