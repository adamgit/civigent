# Error Handling

Error handling philosophy and patterns for Civigent contributors.

---

## Core policy

Civigent follows strict error handling rules. These are non-negotiable.

### No error codes

  > Why?
  >
  > Because the system is AI-centric: errorcodes are useless to LLMs, which work better
  > when given full, natural language, descriptions of what has happened.
  >
  > All our users are either human (don't care about errorcodes) or AI Agents (CANNOT reliably
  > react to a specific errorcode, but CAN reliably reason about detailed freeform text messages)

We **never** use error codes in any circumstances, unless an external system forces us to send them. No internal methods use error codes.

e.g. One exception: OAuth endpoints use `error` and `error_description` fields because the OAuth 2.1 specification requires them.

### No hidden errors

There are **no** situations where it is acceptable to hide, catch, or log an error. If you catch an error, you **must** either:
- Re-throw it, or
- Redirect the **full** error message (with stack trace if provided)

Unless it was an "expected" error — but those are usually signs of bad code design and should be treated with suspicion.

### No sensitive data to leak

We do not store passwords or sensitive data, so there is **never** a case where error details contain sensitive information. Stack traces, error messages, and context should always be exposed fully.

It is a core design feature that Auth is entirely external to the system.

---

## HTTP status codes

The API uses standard HTTP status codes as the primary error signal:

| Status | Meaning | When used |
|--------|---------|-----------|
| 200 | Success | Reads, updates |
| 201 | Created | New resources (proposals, documents) |
| 400 | Bad Request | Invalid input, malformed requests |
| 401 | Unauthorized | Missing or invalid auth token |
| 403 | Forbidden | Valid auth but insufficient permissions |
| 404 | Not Found | Document, section, or proposal doesn't exist |
| 409 | Conflict | Proposal already pending, section locked, state transition invalid |

### Error response format

All error responses include a `message` field:

```json
{
  "message": "A pending proposal already exists for this writer",
  "details": {
    "existing_proposal_id": "prop_abc123"
  }
}
```

The `message` is the primary signal. It's a human-readable string that describes what went wrong. Agents and clients should read the message first.

**NOTE:** All AI Agents are fully capable of reading and interpreting detailed natural-language messages and deciding what actions to take. Prefer details and explanation over terseness.

The `details` field is optional and provides structured context (e.g., the ID of the conflicting proposal, which sections are blocked).

---

## Common error scenarios

### 409 Conflict — proposal contention

Returned when:
- Writer already has a pending proposal (includes existing proposal ID)
- Attempting to modify a non-pending proposal
- Attempting to commit while sections are blocked
- Section is locked by a human proposal

### 404 Not Found

Returned when:
- Document path doesn't resolve to an existing document
- Section heading path doesn't exist in the document skeleton
- Proposal ID not found in any state directory

### 400 Bad Request

Returned when:
- Required fields missing from request body
- Invalid section content format
- Malformed heading paths

---

## Patterns for contributors

### Throwing errors

Throw with descriptive messages. Include the context needed to debug:

```typescript
// Good
throw new Error(`Section "${headingPath.join(" > ")}" not found in document "${docPath}"`);

// Bad
throw new Error("Not found");
```

### Catching and re-throwing

If you must catch (e.g., to add context), re-throw with the original error:

```typescript
try {
  await commitToCanonical(proposal);
} catch (err) {
  // Add context, then re-throw
  throw new Error(`Failed to commit proposal ${proposal.id}: ${err}`);
}
```

### Route handlers

Route handlers in `api/routes/index.ts` use a helper to send error responses:

```typescript
function sendApiError(res: Response, status: number, message: string, details?: unknown) {
  const body: Record<string, unknown> = { message };
  if (details !== undefined) body.details = details;
  res.status(status).json(body);
}
```

### Expected vs unexpected errors

- **Expected errors** (invalid input, proposal conflicts, missing documents): Return appropriate HTTP status with descriptive message. These are business logic outcomes, not bugs.
- **Unexpected errors** (null references, file system failures, programming mistakes): Let them propagate. The global error handler catches them and returns 500. Fix the underlying bug.

---

## Involvement evaluation responses

When a proposal is blocked, the response includes per-section evaluation:

```json
{
  "proposal_id": "prop_abc123",
  "status": "pending",
  "outcome": "blocked",
  "evaluation": {
    "all_sections_accepted": false,
    "aggregate_impact": 2.7,
    "aggregate_threshold": 2.5,
    "blocked_sections": [
      {
        "doc_path": "my-doc",
        "heading_path": ["Introduction"],
        "blocked": true,
        "involvement_score": 0.85,
        "block_reason": "live_session"
      }
    ],
    "passed_sections": [...]
  }
}
```

This is not an "error" — it's a normal business outcome. The HTTP status is still 200 for the create response (the proposal was created successfully in pending state) or returned as part of a commit response.

---

## What's next

- [Architecture Overview](architecture.md) — understand the system internals
- [Testing Guide](testing.md) — how error scenarios are tested
- [Architecture Overview](architecture.md) — system internals and storage layers
