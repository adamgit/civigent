# Testing Guide

How tests are organized, what infrastructure is available, and how to write new tests.

---

## Overview

Civigent uses **Vitest** for both backend and frontend tests. Tests run per-package (not from the workspace root):

```bash
# Run backend tests
cd backend && npm test

# Run frontend tests
cd frontend && npm test

# Run all tests (from root)
npm test
```

The root `npm test` runs backend tests first, then frontend tests, sequentially.

---

## Backend tests

### Location

All tests live under `backend/src/__tests__/`, organized by feature area:

```
backend/src/__tests__/
├── helpers/              ← Shared test utilities
│   ├── auth.ts           ← Auth token generation for tests
│   ├── temp-data-root.ts ← Temporary filesystem setup
│   ├── test-server.ts    ← Test server factory
│   └── sample-content.ts ← Test data fixtures
│
├── auth/                 ← Authentication flow tests
├── documents-read/       ← Document reading (GET endpoints)
├── documents-write/      ← Document creation
├── proposals/            ← Proposal lifecycle (create, read, list, commit, cancel, modify)
├── sections/             ← Section reading
├── crdt/                 ← CRDT unit tests (Y.Doc lifecycle, fragments)
├── storage/              ← Storage layer tests (skeleton, reader, commit pipeline)
├── domain/               ← Domain logic (involvement scoring, presets)
├── admin/                ← Admin configuration
├── sessions/             ← Session store and auto-commit
├── recovery/             ← Crash recovery
├── publish/              ← Manual publishing
├── import/               ← Content import
├── heatmap/              ← Heatmap endpoint
├── mirror/               ← Writer dirty state
├── documents-tree/       ← Document tree navigation
└── perf/                 ← Performance tests
```

### Test infrastructure

Every backend test uses `createTestServer()` from `helpers/test-server.ts`. This provides:

- A temporary data directory with an initialized git repository
- An Express app instance configured for testing (no real port binding)
- Auth token generation for human and agent writers
- WebSocket event capture

**Basic test pattern:**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer } from "../helpers/test-server.js";

describe("My feature", () => {
  let ctx: Awaited<ReturnType<typeof createTestServer>>;

  beforeAll(async () => {
    ctx = await createTestServer();
    // ctx.app — Express app
    // ctx.dataRoot — temporary data directory
    // ctx.humanToken — pre-generated human auth token
    // ctx.agentToken — pre-generated agent auth token
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("should do something", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/my-doc")
      .set("Authorization", `Bearer ${ctx.agentToken}`)
      .expect(200);

    expect(res.body.content).toContain("expected text");
  });
});
```

### Sample content

`helpers/sample-content.ts` provides functions to create sample documents with known structure:

```typescript
import { createSampleDocument } from "../helpers/sample-content.js";

// Creates a document with skeleton + sections in the temp data root
await createSampleDocument(ctx.dataRoot, "my-doc", {
  sections: [
    { heading: "Introduction", content: "Some intro text" },
    { heading: "Details", content: "Detail text" },
  ],
});
```

### Testing proposals

Proposal tests follow the full lifecycle:

```typescript
// Create
const createRes = await request(ctx.app)
  .post("/api/proposals")
  .set("Authorization", `Bearer ${ctx.agentToken}`)
  .send({ intent: "Update pricing", sections: [...] });

// Modify
await request(ctx.app)
  .put(`/api/proposals/${createRes.body.proposal_id}`)
  .set("Authorization", `Bearer ${ctx.agentToken}`)
  .send({ sections: [...] });

// Commit
const commitRes = await request(ctx.app)
  .post(`/api/proposals/${createRes.body.proposal_id}/commit`)
  .set("Authorization", `Bearer ${ctx.agentToken}`);
```

### No running server required

Tests use `supertest` to make requests directly against the Express app instance. No port allocation, no Docker networking, no running server process.

However, the test infrastructure does create real temporary filesystems with git repositories — tests are closer to integration tests than pure unit tests.

---

## Frontend tests

### Location

All tests live under `frontend/src/__tests__/`, organized similarly:

```
frontend/src/__tests__/
├── helpers/                  ← Shared test utilities
│   ├── fetch-mocks.ts        ← Mock helpers for fetch API
│   ├── mock-websocket.ts     ← Mock helpers for WebSocket
│   ├── render-with-router.tsx ← Renders components with React Router context
│   └── sample-data.ts        ← Test data fixtures
│
├── pages/                    ← Page component tests
├── components/               ← Component tests
├── services/                 ← Service layer tests (API client, WS client)
├── routing/                  ← Route resolution tests
└── (root)                    ← Integration and smoke tests
```

### Test environment

Frontend tests run in **happy-dom** (lightweight DOM implementation, faster than jsdom). Configured in `frontend/vitest.config.ts`:

```typescript
import { mergeConfig } from "vite";
import viteConfig from "./vite.config";

export default mergeConfig(viteConfig, {
  test: {
    environment: "happy-dom",
  },
});
```

### Mocking patterns

**Fetch mocking:**

```typescript
import { installFetchMock } from "../helpers/fetch-mocks.js";

const fetchMock = installFetchMock();

fetchMock.mockResponseOnce(JSON.stringify({
  doc_path: "my-doc",
  content: "# Hello",
}));
```

**WebSocket mocking:**

```typescript
import { MockWebSocket } from "../helpers/mock-websocket.js";

MockWebSocket.install();
// Tests can now create WebSocket instances that are captured by the mock
```

**Router wrapping:**

```typescript
import { renderWithRouter } from "../helpers/render-with-router.js";

const { container } = renderWithRouter(<MyComponent />, {
  route: "/docs/my-doc",
});
```

### Page tests

Page tests verify that components render correctly with mocked data:

```typescript
describe("DocumentPage", () => {
  it("renders document sections", async () => {
    const fetchMock = installFetchMock();
    fetchMock.mockResponseOnce(JSON.stringify(sampleDocData));

    const { findByText } = renderWithRouter(<DocumentPage />);
    expect(await findByText("Introduction")).toBeTruthy();
  });
});
```

---

## Testing philosophy

### No snapshots

The project does not use snapshot tests. Tests explicitly assert expected behavior rather than recording and comparing output.

### No coverage thresholds

No minimum coverage requirements. Tests are written alongside code as features are implemented. Quality over quantity.

### No E2E tests (yet)

End-to-end tests (browser automation, real server) are planned but not yet implemented. Current tests cover API contracts and component rendering.

### Test what matters

- **Backend**: API contracts, proposal lifecycle, involvement scoring, storage operations, crash recovery
- **Frontend**: Page rendering, routing, service layer interactions, component behavior

---

## Running specific tests

```bash
# Run a specific test file
cd backend && npx vitest run src/__tests__/proposals/proposal-create.test.ts

# Run tests matching a pattern
cd backend && npx vitest run --grep "proposal"

# Watch mode
cd backend && npx vitest --watch
```

---

## What's next

- [Architecture Overview](architecture.md) — understand what you're testing
- [Error Handling](error-handling.md) — error philosophy that affects test expectations
- [Architecture Overview](architecture.md) — system internals and storage layers
