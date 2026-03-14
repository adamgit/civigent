# Agent Scripts

Simple standalone scripts that demonstrate agent interaction with the Knowledge Store.

## Prerequisites

1. Backend running at `http://localhost:3000` (or set `KS_BASE_URL`)
2. Node.js 18+ (uses native `fetch`)

## Scripts

### `create-strategy.mjs`
Creates a new marketing strategy document with multiple sections via MCP tools.

```bash
node scripts/agents/create-strategy.mjs
```

### `add-campaigns.mjs`
Reads the existing strategy document, then proposes campaign ideas and budget allocation. Run after `create-strategy.mjs`.

```bash
node scripts/agents/add-campaigns.mjs
```

### `review-proposals.mjs`
Lists all proposals, recent activity, document tree, and coordination heatmap. Useful for monitoring what agents have done.

```bash
node scripts/agents/review-proposals.mjs
```

## Running all three in sequence

```bash
KS_BASE_URL=http://localhost:3000 \
  node scripts/agents/create-strategy.mjs && \
  node scripts/agents/add-campaigns.mjs && \
  node scripts/agents/review-proposals.mjs
```

## Shared library

`lib.mjs` provides:
- `registerAgent(displayName)` — registers a transient agent, returns `{ accessToken, identity }`
- `api(token)` — REST client with `get/post/put/delete` methods
- `mcpClient(token)` — MCP JSON-RPC client with `initialize/listTools/callTool/close`
