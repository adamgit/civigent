# Should "human" and "agent" become roles?

Short answer: No. The costs massively outweigh the aesthetic appeal of a pure RBAC model.

The spec has 46 distinct human/agent behavioral differences across the codebase. The code has 31 places checking writer.type. The docs frame human/agent as an immutable identity property, not a role.

These distinctions fall into categories:

## 1. Things that COULD work as roles (few, simple)
Admin access exclusion (if agent → 403)
OAuth consent approval (if agent → 403)
Agent event logging (if agent → log)
UI color coding (if agent → purple)
These are simple gates — "does this actor have the human role?" would work identically.

## 2. Things that fundamentally CANNOT work as roles (many, deep)
The human-involvement scoring system — the core governance mechanism. It measures time since last human activity per section. This requires knowing, at commit/evaluation time, whether the actor who last touched the section was a human. If "human" is a role someone holds, what happens when:

An admin revokes the "human" role from a user mid-session?
A user holds both "human" and "agent" roles?
A commit was made by a "human" who later lost the role — is the protection window still valid?
The scoring function humanInvolvement(t) is defined as decay from the last human edit. This is an ontological statement about the nature of the actor, not a permission check.

The proposal workflow bifurcation — humans live-edit via CRDT and optionally use proposals for reservations. Agents MUST use proposals for ALL writes. This isn't "agents lack the direct-edit permission" — it's that the entire interaction model, data flow, and state management differ:

Humans: keystroke → Y.Doc fragment → session file → auto-commit → canonical
Agents: API call → proposal → evaluation → commit → canonical
These are two completely different write pipelines. Making them role-gated would mean every write path needs a role check and branch, rather than the clean architectural separation that exists now.

Asymmetric economics — the spec's core design principle. "Human work is expensive and irreplaceable. Agent work is cheap and regenerable." This asymmetry is baked into:

Protection windows (protect human work from agents, not vice versa)
Agent-to-agent conflict resolution ("last committed wins" — no protection)
Justification bonuses (only agents need to justify overwriting)
The entire governance preset system (YOLO through Conservative)

## 3. Hidden costs of the role-based approach

Every writer.type check becomes a role lookup. Currently writer.type === "human" is O(1) — a string comparison on an immutable property set at auth time. As a role, it becomes a cache lookup into roles.json. 31 call sites, many in hot paths (proposal creation, evaluation, CRDT sync).

The type system loses its safety. WriterType = "human" | "agent" is exhaustive — the compiler ensures every branch is handled. roles.includes("human") is a runtime boolean. You lose the compiler's help in ensuring you've handled both cases.

Confusing semantics. What does it mean to "grant" the human role to an agent? Or revoke the human role from a human? The concept doesn't make sense — a human IS a human, an agent IS an agent. These aren't capabilities; they're descriptions of what kind of thing the actor is. Making them roles implies they're mutable, which creates semantic confusion for operators and documentation.

Documentation and mental model. The docs say "Civigent has two kinds of users." Reframing to "Civigent has users who may hold the human role" is confusing and doesn't match how operators think about the system. The spec's "asymmetric actor economics" principle requires a permanent identity distinction, not a revocable role.

Governance integrity. If "human" is a role, an admin could accidentally (or intentionally) grant "human" to an agent. That agent's writes would bypass ALL governance: no proposal requirement, no human-involvement evaluation, direct CRDT access. The entire protection model collapses. The current design makes this structurally impossible.

## 4. What you'd actually gain

Almost nothing. The only code simplification would be replacing writer.type === "agent" with writer.roles.includes("agent") — which is longer, slower, and less safe. The RBAC system for document permissions works perfectly well alongside the identity type system. They serve different purposes:

WriterType: What kind of actor are you? (immutable, set at auth, determines interaction model)
Roles: What are you allowed to access? (mutable, admin-managed, determines document permissions)