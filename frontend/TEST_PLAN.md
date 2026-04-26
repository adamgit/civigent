# Frontend Test Plan

> Aligned to iteration3.3.md spec. Replaces all existing tests except performance tests.

STATUS: PARTIALLY IMPLEMENTED, UNDER REVIEW

## Guiding Principles

- Tests validate user-visible behavior, not internal component structure
- Use React Testing Library (render, screen, userEvent) — test what users see and do
- Mock API calls via `apiClient` — never hit real backend
- Mock WebSocket events via fake ws-client — test real-time UI updates
- No snapshot tests — assert on content, structure, and interactions
- Colocate tests with subsystem: pages, components, services

---

## 1. Routing (`routing/`)

### `route-resolution.test.tsx`
- `/` renders DashboardPage
- `/docs` renders DocsBrowserPage
- `/docs/path/to/doc.md` renders DocumentPage with correct docPath
- `/proposals` renders ProposalsPage
- `/proposals/:id` renders ProposalDetailPage with correct ID
- `/admin` renders AdminPage
- `/coordination` renders CoordinationPage
- `/agent-simulator` renders AgentSimulatorPage
- `/login` renders LoginPage
- `/recent-docs` renders RecentDocsPage

### `docs-route-resolver.test.tsx`
- DocsRouteResolver with no splat path renders DocsBrowserPage
- DocsRouteResolver with splat path renders DocumentPage with decoded docPath
- Encoded path segments are properly decoded

---

## 2. App Layout (`layout/`)

### `app-layout-render.test.tsx`
- Renders sidebar with navigation links (Docs, Proposals, Admin, etc.)
- Renders document tree in sidebar (loads from apiClient.getDocumentsTree)
- Shows loading state while tree loads
- Shows error state if tree load fails
- Renders child route via Outlet

### `app-layout-doc-creation.test.tsx`
- "Create new document" form submits to apiClient.createDocument
- Shows error for invalid doc path
- Refreshes tree after successful creation
- New doc path appears in tree after creation

### `app-layout-websocket.test.tsx`
- Connects WebSocket on mount
- content:committed event refreshes document tree (debounced 180ms)
- content:committed from agent shows toast notification
- Agent toast includes writer name and document path
- dirty:changed event updates dirty section tracking
- beforeunload warning fires when dirty sections exist
- beforeunload warning does not fire when no dirty sections

### `app-layout-badges.test.tsx`
- Agent commit on a doc the user has visited sets badge on that doc
- Badge clears when user navigates to the badged document
- No badge for commits by the current user

---

## 3. Dashboard Page (`pages/dashboard/`)

### `dashboard-activity.test.tsx`
- Fetches activity on mount via apiClient.getActivity
- Renders activity items with writer name, document path, timestamp
- Groups activity into "Edits to your docs" and "All other activity"
- Activity items link to source document
- Activity items link to source proposal when available
- Shows "No activity" message when activity list is empty

### `dashboard-filters.test.tsx`
- Days and limit settings control apiClient.getActivity params
- Settings persist to localStorage
- "Show more" button loads additional items

### `dashboard-realtime.test.tsx`
- content:committed WebSocket event appends new activity item
- New activity from agents shows in "Edits to your docs" when applicable

---

## 4. Document Browser Page (`pages/docs-browser/`)

### `docs-browser.test.tsx`
- Renders document tree from outlet context
- Search input filters tree entries
- Force-expands all directories during active search
- Clicking a document navigates to /docs/{path}
- Clicking a document calls rememberRecentDoc

---

## 5. Document Page (`pages/document/`)

### `document-page-load.test.tsx`
- Fetches document structure on mount (lightweight load)
- Fetches full sections content
- Renders section headings and content
- Shows loading skeleton while sections load
- Shows 404 message for non-existent document
- Displays word count and section length warnings

### `document-page-sections.test.tsx`
- Each section shows heading_path as rendered heading
- Sections with active CRDT sessions show editing indicator
- Sections render markdown content

### `document-page-editing.test.tsx`
- Clicking a section enters edit mode (focused section)
- Edit mode creates CrdtProvider connected to /ws/crdt/{docPath}
- MilkdownEditor receives crdtProvider and fragmentKey
- Only focused section + neighbors have mounted editors
- Arrow up at position 0 moves focus to previous section
- Arrow down at last position moves focus to next section
- Leaving edit mode destroys CrdtProvider

### `document-page-persistence.test.tsx`
- Local Y.Doc update marks focused section as dirty
- SESSION_FLUSHED message transitions listed sections to flushed state
- content:committed event transitions sections to clean state
- New edits after flush transition section back to dirty

### `document-page-presence.test.tsx`
- presence:editing event shows other user's name on affected section
- presence:done event removes presence indicator
- agent:reading event shows agent indicator on affected sections
- Agent reading indicator expires after 5 seconds

### `document-page-realtime.test.tsx`
- content:committed from another writer reloads sections (when not editing)
- doc:structure-changed event reloads document structure
- Recently changed sections highlighted after getChangesSince

### `document-page-proposal-mode.test.tsx`
- Entering proposal mode disconnects CrdtProvider WebSocket
- Exiting proposal mode (publish or cancel) reconnects CrdtProvider WebSocket
- In proposal mode, editors use standalone ProseMirror (no Y.js plugins)
- Editing a section in proposal mode auto-adds it to the proposal's section list
- Changes in proposal mode are debounced (~2s) and saved via PUT /api/proposals/:id
- Sections in the active proposal show colored border (blue)
- Sections locked by another human's proposal show "Reserved by [name]" badge and are read-only
- Sections not yet in proposal edit normally — touching them auto-adds them

### `proposal-panel.test.tsx`
- "Create Proposal" button visible when no active proposal
- Creating a proposal requires an intent/description field
- Active proposal panel shows list of documents with section names
- "Publish" button calls POST /api/proposals/:id/commit and exits proposal mode
- "Cancel" button calls POST /api/proposals/:id/cancel and exits proposal mode
- Panel polls for proposal state updates (5s interval)

---

## 6. Proposals Page (`pages/proposals/`)

### `proposals-list.test.tsx`
- Fetches proposals on mount via apiClient.listProposals
- Renders proposal cards with ID, intent, status, writer
- Status filter changes API call parameter
- Writer type filter (human/agent) filters displayed proposals
- Search input filters by proposal ID or intent text
- Clicking proposal navigates to /proposals/:id
- Shows empty state when no proposals match filter

---

## 7. Proposal Detail Page (`pages/proposal-detail/`)

### `proposal-detail-display.test.tsx`
- Fetches proposal on mount via apiClient.getProposal
- Shows proposal metadata: status, writer, intent, timestamps
- Shows committed_head when status is committed
- Lists all sections with doc_path and heading_path
- Each section shows involvement score (color-coded)
- Blocked sections show block reason
- Shows involvement evaluation summary

### `proposal-detail-actions.test.tsx`
- "Recommit" button calls apiClient.commitProposal (pending only)
- "Withdraw" button calls apiClient.withdrawProposal with reason (pending only)
- Action buttons hidden when proposal is committed or withdrawn
- Successful recommit updates displayed status to committed
- Failed recommit shows updated block reasons
- "Refresh" button re-fetches proposal data
- Shows 404 for non-existent proposal

---

## 8. Recent Docs Page (`pages/recent-docs/`)

### `recent-docs.test.tsx`
- Shows recently viewed docs from localStorage
- Shows docs from recent activity and proposals
- Filter input narrows displayed documents
- "Open by path" form navigates to specified doc
- Each doc has links to view mode
- Clicking doc calls rememberRecentDoc

---

## 9. Admin Page (`pages/admin/`)

### `admin-page.test.tsx`
- Shows backend health status from apiClient.getHealth
- Shows proposal counts (pending, committed, withdrawn)
- Shows current writer ID from session info
- Shows snapshot health status

### `admin-config.test.tsx`
- Loads involvement preset from apiClient.getAdminConfig
- Preset selector shows available presets
- Changing preset calls apiClient.updateAdminConfig
- Shows preset description and thresholds
- Local frontend settings (limit, days) saved to localStorage

---

## 10. Coordination Page (`pages/coordination/`)

### `coordination-heatmap.test.tsx`
- Fetches heatmap on mount via apiClient.getHeatmap
- Renders table grouped by document
- Each row shows heading_path, involvement score, CRDT active status
- Involvement score color-coded by value
- Blocked sections show block reason
- Auto-refreshes every 10 seconds
- Manual refresh button re-fetches heatmap

### `coordination-events.test.tsx`
- Live event log shows WebSocket events as they arrive
- content:committed, presence:editing, presence:done events rendered

---

## 11. Agent Simulator Page (`pages/agent-simulator/`)

### `agent-simulator.test.tsx`
- Step 0: Register agent calls /api/auth/agent/register
- Successful registration shows bearer token
- Step 1: Create proposal shows document tree picker
- Step 2: Begin proposal shows status/conflicts
- Step 3: Write section shows content textarea
- Step 4: Commit/cancel buttons call appropriate APIs
- Response JSON displayed for each step
- Terminal state (committed/withdrawn) shows final status

---

## 12. Login Page (`pages/login/`)

### `login-methods.test.tsx`
- Fetches auth methods on mount via apiClient.getAuthMethods
- Shows single-user login button when single_user method available
- Shows credentials form when credentials method available
- Shows OIDC form when oidc method available
- Only renders forms for available methods

### `login-flows.test.tsx`
- Single-user login calls apiClient.loginSingleUser and redirects
- Credentials login calls apiClient.loginCredentials with form values
- Successful login redirects to returnTo path or /
- Failed login shows error message
- Logout button calls apiClient.logout and clears session
- Shows current writer ID when authenticated

---

## 13. Components (`components/`)

### `documents-tree-nav.test.tsx`
- Renders file and directory entries
- Click directory toggles expansion
- Click file triggers onDocumentOpen callback
- Nested directories render recursively
- forceExpandAll prop expands all directories
- Badge shown on badged document paths
- Expanded state persists to localStorage via storageKey

### `milkdown-editor.test.tsx`
- Renders with initial markdown content
- onChange fires (debounced) when content changes
- readOnly mode prevents editing
- CRDT mode binds to Y.XmlFragment via provider
- onCursorExit("up") fires at start of document
- onCursorExit("down") fires at end of document
- Ref handle: getMarkdown returns current content
- Ref handle: focus("start") places cursor at start
- Ref handle: focus("end") places cursor at end

### `section-navigator.test.tsx`
- Renders heading tree from structure prop
- Click heading calls onSelectSection with correct path
- Add button calls onCreateSection with parent path
- Rename button calls onRenameSection with new heading
- Delete button calls onDeleteSection with path
- Selected section highlighted
- Disabled prop prevents interactions

---

## 14. Services (`services/`)

### `api-client.test.ts`
- Each method calls correct endpoint with correct HTTP method
- Request bodies match expected shapes
- Response parsing extracts correct data
- 401 response triggers unauthorized handler
- 401 response attempts token refresh (once)
- Successful token refresh retries original request
- credentials: "include" set on all fetch calls
- Writer ID stored/read from localStorage

### `api-client-auth.test.ts`
- loginCredentials sends username/password to /api/auth/login
- loginSingleUser calls /api/auth/login with default credentials
- registerAgent sends display_name to /api/auth/agent/register
- refreshAuthSession calls /api/auth/token/refresh
- logout calls /api/auth/logout
- getSessionInfo calls /api/auth/session

### `ws-client.test.ts`
- connect opens WebSocket to /ws
- disconnect closes WebSocket
- subscribe sends subscribe message for doc
- unsubscribe sends unsubscribe message for doc
- onEvent handler receives parsed server events
- focusDocument/blurDocument send correct messages
- focusSection sends docPath and headingPath
- sessionDeparture sends docPath
- Reconnects automatically on unexpected close

### `crdt-provider.test.ts`
- Constructor creates provider with Y.Doc and docPath
- connect opens WebSocket to /ws/crdt/{docPath}
- Initial sync: sends SYNC_STEP_1, processes SYNC_STEP_2 response
- YJS_UPDATE messages applied to Y.Doc
- Local Y.Doc changes sent as YJS_UPDATE to server
- AWARENESS messages relayed bidirectionally
- SESSION_OVERLAY_IMPORT_STARTED (0x06) triggers onSessionOverlayImportStarted callback
- SESSION_OVERLAY_IMPORTED (0x04) triggers onSessionOverlayImported with parsed keys
- SECTION_FOCUS (0x05) sent when focusSection called
- destroy cleans up WebSocket and Y.Doc observers
- Connection state transitions trigger onStateChange
- Idle timeout triggers onIdleTimeout callback

### `crdt-roundtrip.test.ts`
Verifies that the markdown → ProseMirror JSON → Y.Doc → ProseMirror JSON → markdown round-trip is lossless, ensuring no spurious Y.Doc updates are generated during initial sync (bug2 investigation).
Uses `@ks/milkdown-serializer` (markdownToJSON, jsonToMarkdown, getSchemaSpec) and `y-prosemirror` (prosemirrorJSONToYDoc, yDocToProsemirrorJSON) — the same pipeline as the backend's FragmentStore.fromDisk.
- Simple root-only content: "root" round-trips without change
- Heading + body: "## s1\n\nb1" round-trips without change
- Full document split into fragments: "root\n\n## s1\nb1" — root fragment ("root") and s1 fragment ("## s1\n\nb1") each round-trip without change
- Applying a server Y.Doc state to a fresh client Y.Doc produces identical ProseMirror JSON (no normalization diff)
- Empty content: "" round-trips without change
- Multiple paragraphs: "p1\n\np2\n\np3" round-trips without change
- Nested headings: "## h2\n\nbody\n\n### h3\n\nsub" round-trips without change
- Content with inline formatting: "some **bold** and *italic* text" round-trips without change
- Content with code block round-trips without change
- Content with bullet list round-trips without change
- Content with ordered list round-trips without change
- Content with blockquote round-trips without change
- Content with links and images round-trips without change
- Content with GFM table round-trips without change

### `recent-docs.test.ts`
- listRecentDocs returns docs from localStorage
- rememberRecentDoc adds doc to front of list
- rememberRecentDoc deduplicates (moves existing to front)
- List capped at 40 entries

### `document-visit-history.test.ts`
- getLastDocumentVisitAt returns stored timestamp
- markDocumentVisitedNow stores current timestamp

---

## 15. Observer CRDT (`observer-crdt/`)

### `observer-crdt-provider.test.ts`
- ObserverCrdtProvider connects to /ws/crdt-observe/<docPath>
- Applies incoming MSG_YJS_UPDATE to local Y.Doc
- Fires onChange callback (debounced) after Y.Doc update
- Never sends MSG_YJS_UPDATE, MSG_SECTION_FOCUS, MSG_ACTIVITY_PULSE
- destroy() closes WebSocket and removes Y.Doc listeners
- Reconnects on unexpected close (same backoff as CrdtProvider)
- On close code 4021 (session_ended): fires onSessionEnded, then reconnects

### `document-page-observer.test.tsx`
- View-mode sections update in real-time when observer receives Y.Doc changes
- Observer is destroyed when user enters edit mode
- Observer is re-created when user exits edit mode
- Session ended (4021 close) triggers REST fallback + observer reconnect
- Sections render via <ReactMarkdown> with observer-provided content

---

## File Organization

```
frontend/src/__tests__/
  routing/
    route-resolution.test.tsx
    docs-route-resolver.test.tsx
  layout/
    app-layout-render.test.tsx
    app-layout-doc-creation.test.tsx
    app-layout-websocket.test.tsx
    app-layout-badges.test.tsx
  pages/
    dashboard/
      dashboard-activity.test.tsx
      dashboard-filters.test.tsx
      dashboard-realtime.test.tsx
    docs-browser/
      docs-browser.test.tsx
    document/
      document-page-load.test.tsx
      document-page-sections.test.tsx
      document-page-editing.test.tsx
      document-page-persistence.test.tsx
      document-page-presence.test.tsx
      document-page-realtime.test.tsx
      document-page-proposal-mode.test.tsx
      document-page-observer.test.tsx
      proposal-panel.test.tsx
    proposals/
      proposals-list.test.tsx
    proposal-detail/
      proposal-detail-display.test.tsx
      proposal-detail-actions.test.tsx
    recent-docs/
      recent-docs.test.tsx
    admin/
      admin-page.test.tsx
      admin-config.test.tsx
    coordination/
      coordination-heatmap.test.tsx
      coordination-events.test.tsx
    agent-simulator/
      agent-simulator.test.tsx
    login/
      login-methods.test.tsx
      login-flows.test.tsx
  components/
    documents-tree-nav.test.tsx
    milkdown-editor.test.tsx
    section-navigator.test.tsx
  services/
    api-client.test.ts
    api-client-auth.test.ts
    ws-client.test.ts
    crdt-provider.test.ts
    observer-crdt-provider.test.ts
    recent-docs.test.ts
    document-visit-history.test.ts
  helpers/
    fetch-mocks.ts          (reuse: fetch API mocking)
    mock-websocket.ts       (reuse: WebSocket mocking)
    render-with-router.tsx  (reuse: render with React Router context)
    mock-api-client.ts      (new: full apiClient mock factory)
    mock-ws-client.ts       (new: KnowledgeStoreWsClient mock with event emission)
    mock-crdt-provider.ts   (new: CrdtProvider mock for editor tests)
    sample-data.ts          (new: fixture data for proposals, documents, activity)
```

## Test Helpers Needed

### `mock-api-client.ts`
Factory that creates a fully-mocked apiClient with:
- All methods as vi.fn() returning sensible defaults
- Override helpers for specific test scenarios
- Type-safe mock data builders

### `mock-ws-client.ts`
Mock KnowledgeStoreWsClient that:
- Records connect/disconnect/subscribe/unsubscribe calls
- Provides `emit(event)` for simulating server events
- Tracks focus/blur/departure calls for assertion

### `mock-crdt-provider.ts`
Mock CrdtProvider that:
- Exposes event callbacks (onSessionOverlayImportStarted, onSessionOverlayImported, etc.)
- Tracks focusSection calls
- Simulates connection state changes

### `sample-data.ts`
Fixture builders for:
- DocumentTreeEntry arrays (nested directories + files)
- Proposal objects (pending, committed, withdrawn)
- Activity items with various sources
- Section data with involvement scores
- Heatmap entries

### Existing helpers to keep
- `fetch-mocks.ts` — fetch API test utilities
- `mock-websocket.ts` — WebSocket mock
- `render-with-router.tsx` — component rendering with router context
