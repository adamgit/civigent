# Agent User Stories — Design Planning Reference

Concrete interaction scenarios for the three canonical AI agent personas, grounded in the actual MCP tool surface (tier-3 collaboration tools, proposal lifecycle, human-involvement evaluation).

All tests exercise only the MCP JSON-RPC transport (`POST /mcp/tier3`) — no direct REST API calls.

---

## ArchBot (orchestration layer, multi-section, cross-doc)

### US-1: Cross-reference cascade

> Architecture doc `/platform/auth-service.md` renames its "Token Refresh" section. ArchBot detects that `/runbooks/incident-response.md § Token Expiry` and `/onboarding/setup.md § Auth Setup` both reference the old name. It creates a single proposal touching 3 sections across 2 documents with per-section justifications citing the rename commit.

Exercises: multi-section proposal creation, per-section justifications reducing soft-block scores, aggregate impact.

### US-3: Stale-proposal auto-withdrawal

> ArchBot has a draft proposal targeting `§ API Versioning`. Before it commits, canonical advances under that section (another commit lands). ArchBot re-reads the section, sees it changed, cancels the stale draft, and submits a fresh proposal.

Exercises: cancel + re-propose pattern, idempotent agent behavior.

### US-4: Hard-blocked section — drop and re-commit

> ArchBot's proposal touches `§ Overview` (no human activity) and `§ Timeline` (human has dirty session overlay). At commit time, `§ Overview` passes and `§ Timeline` is hard-blocked. ArchBot removes the blocked section from the proposal via `write_section` (keeping only the passing section), then re-commits successfully. The blocked content is not lost — ArchBot can re-propose it later.

Exercises: partial block at commit, `write_section` to reshape draft, re-commit after dropping blocked sections.

---

## ContentPilot (stateless skill pack, `replace=true`)

### US-5: Terminology sweep with `replace=true`

> ContentPilot scans all sections of a doc, finds sections needing updates. It creates a proposal with replacements. Because it always uses `replace=true`, any previous draft it left behind is auto-withdrawn before the new one is created.

Exercises: `replace=true` auto-withdraw of stale drafts, multi-section same-doc proposal, single-pending-per-writer invariant.

### US-6: No justification — soft block

> ContentPilot proposes an update to a section a human edited recently (HI score above threshold). Because the skill pack never sends per-section justifications, the score is not reduced. The commit is blocked. ContentPilot cancels and moves on.

Exercises: soft-block without justifications, cancel after blocked commit, fire-and-forget pattern.

### US-7: New section auto-creation

> ContentPilot submits a proposal with a heading_path that doesn't exist yet. The system auto-creates the section via `ensureHeadingPath()`. No human involvement score exists for the new section, so it passes immediately.

Exercises: auto-creation of new headings, skeleton mutation via proposal, zero-HI-score fast path.

---

## Amir's Copilot (human-directed, one section at a time)

### US-9: Forgotten draft — single-pending conflict

> Amir's agent created a draft 20 minutes ago, forgot about it. A new `create_proposal` without `replace=true` gets a conflict error surfacing the existing draft ID.

Exercises: single-pending-per-writer invariant error, conflict surfacing for human-directed agents.

---

## Cross-persona stories

### US-11: ArchBot and Amir race on the same section

> ArchBot submits a proposal touching `§ Overview`. Meanwhile a dirty session file appears for `§ Overview` (simulating a human editing). ArchBot tries to commit — `§ Overview` is now hard-blocked. ArchBot must cancel and wait.

---

## Test Plans (MCP-only, currently available features)

All tests live in `backend/src/__tests__/mcp/` alongside the existing `structural-proposals.test.ts`. They reuse the same helpers:
- `createTestServer()` for Express app + isolated data root
- `createSampleDocument()` / `createSampleDocument2()` for canonical content
- `authFor(id, "agent")` for tier-3 agent identity
- `callMcpTool(name, args, token)` helper (JSON-RPC over `/mcp/tier3`)
- `initMcpSession(token)` for MCP session setup

### Faking actors and time

We only fake external systems and actors:
- **Human git commits** — `git commit` with `--trailer Writer-Type: human` and `--date` to control HI score decay
- **Dirty session files** — write a file to `sessions/docs/{docPath}.sections/{sectionFile}` to simulate an active human editor (hard block)
- **Agent identity** — `authFor("archbot-1", "agent")`, `authFor("contentpilot", "agent")`, etc.
- **HI preset** — default "eager" (midpoint=7200s, steepness=1.2). At threshold=0.5: score=0.5 at exactly 2 hours since last human edit

### Math reference (eager preset)

```
score(t) = 1 / (1 + (t / 7200)^1.2)
threshold = 0.5
justification reduction = 0.1

t = 1h (3600s)  → score ≈ 0.61 → blocked (but 0.51 with justification → still blocked)
t = 1.5h (5400s) → score ≈ 0.53 → blocked (but 0.43 with justification → PASSES)
t = 2h (7200s)  → score = 0.50 → blocked (but 0.40 with justification → passes)
t = 4h (14400s) → score ≈ 0.37 → passes without justification
t = 0 (dirty file) → score = 1.0 → hard block (justification irrelevant)
no human activity → score = 0.0 → passes
```

---

### US-1 test: multi-doc proposal with justifications

**File:** `backend/src/__tests__/mcp/agent-multi-doc-justification.test.ts`

**Setup:**
1. `createTestServer()`, create two sample docs (`SAMPLE_DOC_PATH`, `SAMPLE_DOC_PATH_2`)
2. Make a human commit on both docs ~1.5 hours ago (`git commit --date` with `Writer-Type: human` trailer) so HI score ≈ 0.53 (above 0.5 threshold, but below 0.5 + 0.1)
3. `initMcpSession()` with archbot agent token

**Steps:**

1. **read_doc_structure** on both docs — verify sections are visible
   - `callMcpTool("read_doc_structure", { path: SAMPLE_DOC_PATH })`
   - `callMcpTool("read_doc_structure", { path: SAMPLE_DOC_PATH_2 })`
   - Assert: both return structure with expected headings

2. **create_proposal WITHOUT justifications — expect blocked**
   - `callMcpTool("create_proposal", { intent: "Cross-ref update", sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "..." }, { doc_path: SAMPLE_DOC_PATH_2, heading_path: ["Principles"], content: "..." }] })`
   - Parse JSON result → assert `outcome === "blocked"`
   - Assert: both sections appear in `evaluation.blocked_sections` with scores ≈ 0.53

3. **cancel_proposal** — clean up blocked draft
   - `callMcpTool("cancel_proposal", { proposal_id: <id from step 2> })`
   - Assert: `status === "withdrawn"`

4. **create_proposal WITH justifications — expect accepted**
   - Same sections but each has `justification: "Cross-ref triggered by auth-service rename"`
   - Parse JSON result → assert `outcome === "accepted"`
   - Assert: both sections in `evaluation.passed_sections` with scores ≈ 0.43 (reduced by 0.1)

5. **commit_proposal — expect committed**
   - `callMcpTool("commit_proposal", { proposal_id: <id from step 4> })`
   - Assert: `status === "committed"`, `committed_head` is truthy

6. **read_section — verify canonical updated**
   - `callMcpTool("read_section", { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] })`
   - Assert: content matches what was proposed
   - Repeat for second doc

---

### US-4 test: hard block — drop blocked section, re-commit

**File:** `backend/src/__tests__/mcp/agent-hard-block-drop-recommit.test.ts`

**Setup:**
1. `createTestServer()`, `createSampleDocument()` (has `§ Overview` and `§ Timeline`)
2. Write a dirty session file at `sessions/docs/ops/strategy.md.sections/timeline.md` to hard-block `§ Timeline`
3. `initMcpSession()` with archbot agent token

**Steps:**

1. **create_proposal with two sections**
   - `callMcpTool("create_proposal", { intent: "Update two sections", sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "New overview" }, { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "New timeline" }] })`
   - Assert: `status === "draft"`
   - Assert: `evaluation.blocked_sections` contains Timeline with `humanInvolvement_score === 1.0`
   - Assert: `evaluation.passed_sections` contains Overview with score ≈ 0.0

2. **commit_proposal — expect blocked (cannot commit with any blocked section)**
   - `callMcpTool("commit_proposal", { proposal_id })`
   - Assert: `status === "draft"`, `outcome === "blocked"`

3. **Reshape draft: remove blocked section via cancel + re-create**
   - `callMcpTool("cancel_proposal", { proposal_id, reason: "dropping blocked section" })`
   - `callMcpTool("create_proposal", { intent: "Update overview only", sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "New overview" }] })`
   - Assert: new proposal, `outcome === "accepted"` (only unblocked section remains)

4. **commit_proposal — expect committed**
   - `callMcpTool("commit_proposal", { proposal_id: <new id> })`
   - Assert: `status === "committed"`

5. **read_section — verify only Overview changed**
   - `callMcpTool("read_section", { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] })`
   - Assert: content is "New overview"
   - `callMcpTool("read_section", { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] })`
   - Assert: content is still original ("Q1: Planning. Q2: Execution. Q3: Review.")

6. **Cleanup: remove dirty session file, verify unblocked**
   - Delete `sessions/docs/ops/strategy.md.sections/timeline.md`
   - `callMcpTool("create_proposal", { intent: "Now update timeline", replace: true, sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "New timeline" }] })`
   - Assert: `outcome === "accepted"` (no longer blocked)

---

### US-5 test: `replace=true` auto-withdraw + multi-section commit

**File:** `backend/src/__tests__/mcp/agent-replace-stale-draft.test.ts`

**Setup:**
1. `createTestServer()`, `createSampleDocument()` (agent-authored, so HI score = 0 for all sections)
2. `initMcpSession()` with contentpilot agent token

**Steps:**

1. **create_proposal — first draft**
   - `callMcpTool("create_proposal", { intent: "Terminology pass 1", sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Updated overview" }] })`
   - Assert: `status === "draft"`, `outcome === "accepted"`, capture `proposal_id` as P1

2. **create_proposal without replace — expect conflict**
   - `callMcpTool("create_proposal", { intent: "Terminology pass 2", sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "Updated timeline" }] })`
   - Assert: result contains `existing_proposal_id === P1` and `success === false`

3. **my_proposals — verify P1 still in draft**
   - `callMcpTool("my_proposals", { status: "draft" })`
   - Assert: exactly 1 proposal, id === P1

4. **create_proposal WITH replace=true — auto-withdraw + new draft**
   - `callMcpTool("create_proposal", { intent: "Full terminology sweep", replace: true, sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "customer overview" }, { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "customer timeline" }] })`
   - Assert: `status === "draft"`, `outcome === "accepted"`, capture `proposal_id` as P2, P2 !== P1

5. **read_proposal on P1 — verify withdrawn**
   - `callMcpTool("read_proposal", { proposal_id: P1 })`
   - Assert: proposal status === "withdrawn"

6. **commit_proposal P2 — expect committed**
   - `callMcpTool("commit_proposal", { proposal_id: P2 })`
   - Assert: `status === "committed"`

7. **read_section — verify both sections updated**
   - `callMcpTool("read_section", { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] })`
   - Assert: content is "customer overview"
   - `callMcpTool("read_section", { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] })`
   - Assert: content is "customer timeline"

8. **create_proposal with replace=true when no existing draft — still works**
   - `callMcpTool("create_proposal", { intent: "Idempotent replace", replace: true, sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "another update" }] })`
   - Assert: `status === "draft"` (no error, replace is idempotent)
