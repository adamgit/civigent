// ─── JSON Boundary Helpers ─────────────────────────────────────────

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | JsonObject;

/**
 * Parse JSON into the only shapes JSON can produce. SyntaxError is intentionally
 * allowed to propagate with its original message and stack.
 */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function expectJsonObject(value: JsonValue, label = "value"): JsonObject {
  if (typeof value !== "object" || value === null || isJsonArray(value)) {
    throw new Error(`${label} must be a JSON object, got ${JSON.stringify(value)}`);
  }
  return value;
}

// ─── Writer Identity ───────────────────────────────────────────────

/**
 * Authoritative writer identity enum emitted by backend APIs/events.
 * Frontends must treat any non-enum runtime value as UNKNOWN when consuming
 * untyped payloads (e.g. legacy/history endpoints) and surface the raw value.
 */
export type WriterType = "human" | "agent";
export type AttributionWriterType = WriterType | "unknown";

export interface WriterIdentity {
  id: string;
  type: WriterType;
  displayName: string;
  email?: string;
}

// ─── Section References ────────────────────────────────────────────

export type DocPath = string;
export type HeadingPath = string[];
export type ProposalId = string;

/**
 * SectionTarget — discriminated union for targeting a section.
 * Used in MCP tool inputs and API boundaries.
 */
export type SectionTarget =
  | { kind: "before_first_heading" }
  | { kind: "heading_path"; heading_path: string[] };

/** Convert SectionTarget to heading path for internal resolution. */
export function sectionTargetToHeadingPath(target: SectionTarget): string[] {
  return target.kind === "before_first_heading" ? [] : target.heading_path;
}

/** Convert heading path to SectionTarget for wire format parsing. */
export function headingPathToSectionTarget(hp: string[]): SectionTarget {
  return hp.length === 0
    ? { kind: "before_first_heading" }
    : { kind: "heading_path", heading_path: hp };
}

// ─── CRDT Remote Session Model ──────────────────────────────────────

/** Applied server role for a connected CRDT participant. */
export type ClientRole = "observer" | "editor";

/** Per-tab runtime identity for a CRDT participant. Never use writerId for this. */
export type ClientInstanceId = string;

/** Desired runtime mode requested by a tab-local controller. */
export type RequestedMode = "none" | "observer" | "editor";

/** Attachment state of a participant relative to a live DocSession. */
export type AttachmentState = "detached" | "waiting_for_session" | "attached_to_session";

/** Explicit identity of one live backend DocSession. */
export type DocSessionId = string;

/**
 * Explicit focus target for the one section currently edited by this tab.
 * Part of the LIVE, server-authoritative CRDT mode-transition surface
 * (`RemoteParticipant` / `ModeTransitionRequest` / `DocumentSessionControllerState`),
 * which the CRDT coordinator patches per participant. Kept (MW-13); this is NOT
 * the removed JSON focus/pulse client-message surface.
 */
export type EditorFocusTarget = SectionTarget;

/** Server-authoritative runtime state for one connected CRDT participant/tab. */
export interface RemoteParticipant {
  clientInstanceId: ClientInstanceId;
  writerId: string;
  docPath: DocPath;
  clientRole: ClientRole;
  requestedMode: RequestedMode;
  attachmentState: AttachmentState;
  docSessionId: DocSessionId | null;
  editorFocusTarget: EditorFocusTarget | null;
}

/** Frontend request to transition this tab into a new CRDT mode. */
export interface ModeTransitionRequest {
  requestId: string;
  clientInstanceId: ClientInstanceId;
  docPath: DocPath;
  requestedMode: RequestedMode;
  editorFocusTarget: EditorFocusTarget | null;
}

/** Successful server application of a mode transition request. */
export interface ModeTransitionResultSuccess {
  kind: "success";
  requestId: string;
  clientInstanceId: ClientInstanceId;
  requestedMode: RequestedMode;
  attachmentState: AttachmentState;
  docSessionId: DocSessionId | null;
  clientRole: ClientRole | null;
}

/** Rejected (impossible or stale) server result for a transition request. */
export interface ModeTransitionResultRejected {
  kind: "rejected";
  requestId: string;
  clientInstanceId: ClientInstanceId;
  requestedMode: RequestedMode;
  attachmentState: AttachmentState;
  docSessionId: DocSessionId | null;
  clientRole: ClientRole | null;
  reason: string;
}

export type ModeTransitionResult = ModeTransitionResultSuccess | ModeTransitionResultRejected;

/** Single source of truth for one tab's CRDT controller runtime state. */
export interface DocumentSessionControllerState {
  clientInstanceId: ClientInstanceId;
  requestedMode: RequestedMode;
  clientRole: ClientRole | null;
  attachmentState: AttachmentState;
  docSessionId: DocSessionId | null;
  editorFocusTarget: EditorFocusTarget | null;
  pendingTransition: ModeTransitionRequest | null;
}

// ─── Live Section Wire State (DocSession CRDT live-section channel) ──
//
// The JSON, body-free live-section control state carried alongside Yjs updates
// on the ordered DocSession CRDT socket (the live-section-replica redesign).
// This is the authoritative live section interpretation — topology/existence,
// editability, pending-writer state, and the publish-pause *mirror* — and it
// REPLACES the unordered application-WebSocket `doc:structure-changed` /
// `section:blocked|unblocked|gone` as the live-correctness mechanism.
//
// Body text is NEVER represented here; live bodies exist only in the Yjs update
// that rides the same frame. The binary frame envelope (opcodes + length-prefix
// + trailing `yjs_update`) lives in the CRDT codec (`crdt-ws-frames.ts` on the
// backend, mirrored in the frontend provider); these are only the JSON shapes it
// carries, kept here so both ends agree on one contract.

/** Body-free live topology reference: opaque `fragment_key` + heading path only. */
export interface WireLiveSectionRef {
  /** Opaque backend-owned CRDT fragment identity; branded to `SectionId` on the client. */
  fragment_key: string;
  heading_path: readonly string[];
}

/** A live pending-writer session against one section (drives "wants to modify" UI). */
export interface WirePendingSection {
  fragment_key: string;
  writer_id: string;
  writer_display_name: string;
}

/**
 * Complete, small, idempotent snapshot of non-body live section state. Sent in a
 * bootstrap frame and re-sent in full (never as an unreplayable delta) whenever
 * topology / editability / pending / pause-mirror changes.
 */
export interface WireLiveSectionsState {
  /** Ordered, body-free section topology (identity + heading path). */
  topology: readonly WireLiveSectionRef[];
  /**
   * The single editable-set representation: fragment keys currently blocked
   * (locked / removed / globally paused). Unifies the old declared-`locked` vs
   * emitted-`blocked` drift and is seeded in the bootstrap so a lock predating
   * connection can never be missed.
   */
  blocked_section_ids: readonly string[];
  /** Live pending-writer sessions. */
  pending_sections: readonly WirePendingSection[];
  /**
   * Join-time / UI mirror ONLY. Deliberately NOT a boolean: a boolean invites
   * "if true, freeze editors", but freezing is owned solely by the pause opcode
   * handshake (`0x10`/`0x11`/`0x12`). This field is a passive snapshot for joiners
   * / UI — its type reads as a description of state, never a command:
   *   - `"not_in_pause"`               — no DocSession publish pause was active.
   *   - `"pause_active_editors_frozen"` — a pause was active when captured (editors
   *     are frozen by the opcode machine; this mirror only reflects that for a
   *     late joiner's UI / `isEditable()`, it does not itself freeze anything).
   */
  publish_pause_join_mirror: PublishPauseJoinMirror;
}

/**
 * Passive join/UI mirror of DocSession publish-pause state. Non-boolean by design
 * so it cannot be mistaken for a freeze command — the freeze/ready/end opcode
 * handshake stays the sole authority for the pause machine (spec 10).
 */
export type PublishPauseJoinMirror = "not_in_pause" | "pause_active_editors_frozen";

// ── Live section wire-state parsers (fail-loud JSON trust boundary) ──
// Colocated companion parsers so a frame decoder can validate the JSON portion
// of a bootstrap/update frame with field-specific prose (no `as`, no coercion).

function wireStringArray(value: JsonValue, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => {
    if (typeof element !== "string") {
      throw new Error(`${label}[${index}] must be a string, got ${JSON.stringify(element)}`);
    }
    return element;
  });
}

export const WireLiveSectionRef = {
  parse(value: JsonValue, label = "live section ref"): WireLiveSectionRef {
    const obj = expectJsonObject(value, label);
    const fragment_key = obj["fragment_key"];
    if (typeof fragment_key !== "string") {
      throw new Error(`${label}.fragment_key must be a string, got ${JSON.stringify(fragment_key)}`);
    }
    return { fragment_key, heading_path: wireStringArray(obj["heading_path"], `${label}.heading_path`) };
  },
};

export const WirePendingSection = {
  parse(value: JsonValue, label = "pending section"): WirePendingSection {
    const obj = expectJsonObject(value, label);
    const req = (key: string): string => {
      const v = obj[key];
      if (typeof v !== "string") {
        throw new Error(`${label}.${key} must be a string, got ${JSON.stringify(v)}`);
      }
      return v;
    };
    return {
      fragment_key: req("fragment_key"),
      writer_id: req("writer_id"),
      writer_display_name: req("writer_display_name"),
    };
  },
};

export const WireLiveSectionsState = {
  parse(value: JsonValue, label = "live sections state"): WireLiveSectionsState {
    const obj = expectJsonObject(value, label);
    const topologyRaw = obj["topology"];
    if (!Array.isArray(topologyRaw)) {
      throw new Error(`${label}.topology must be an array, got ${JSON.stringify(topologyRaw)}`);
    }
    const pendingRaw = obj["pending_sections"];
    if (!Array.isArray(pendingRaw)) {
      throw new Error(`${label}.pending_sections must be an array, got ${JSON.stringify(pendingRaw)}`);
    }
    const pauseMirror = obj["publish_pause_join_mirror"];
    if (pauseMirror !== "not_in_pause" && pauseMirror !== "pause_active_editors_frozen") {
      throw new Error(
        `${label}.publish_pause_join_mirror must be "not_in_pause" | "pause_active_editors_frozen", got ${JSON.stringify(pauseMirror)}`,
      );
    }
    return {
      topology: topologyRaw.map((el, i) => WireLiveSectionRef.parse(el, `${label}.topology[${i}]`)),
      blocked_section_ids: wireStringArray(obj["blocked_section_ids"], `${label}.blocked_section_ids`),
      pending_sections: pendingRaw.map((el, i) => WirePendingSection.parse(el, `${label}.pending_sections[${i}]`)),
      publish_pause_join_mirror: pauseMirror,
    };
  },
};

export interface SectionTargetRef {
  doc_path: string;
  heading_path: string[];
}

/**
 * ProposalTargetRef — the authoritative lock/audit/policy claim a proposal makes
 * (spec 12 §Data Shapes). A discriminated union of:
 *
 *  - a SECTION target: a specific section within a document (the semantic content
 *    unit; carries a `heading_path`).
 *  - a DOCUMENT target: a claim on a document's path / existence / structural
 *    identity (document create/delete/rename). NOT a semantic whole-document
 *    content unit — a live-empty document still has a document target so the FSM
 *    lock + audit/manifest can name the contested operation.
 *
 * Conflict semantics (owned by the FSM lock index, spec 12 §Proposed Abstractions):
 * section↔same-section, document↔same-document-path, document↔every-section-under
 * -that-path, section↔document-for-its-path. Document rename claims old + new paths.
 */
export interface ProposalSectionTargetRef {
  kind: "section";
  doc_path: string;
  heading_path: string[];
}

export interface DocumentTargetRef {
  kind: "document";
  doc_path: string;
}

export type ProposalTargetRef = ProposalSectionTargetRef | DocumentTargetRef;

// ─── Proposal target helpers (normalization, keying, display, equality) ──
// Do NOT route document targets through SectionRef.fromTarget — document targets
// need their own key form (spec 12 §"Add target helper functions").

/** Wrap a section ref as a tagged section target. */
export function asSectionTarget(ref: SectionTargetRef): ProposalSectionTargetRef {
  return { kind: "section", doc_path: ref.doc_path, heading_path: [...ref.heading_path] };
}

/** Build a document target for a document path. */
export function documentTargetRef(docPath: string): DocumentTargetRef {
  return { kind: "document", doc_path: docPath };
}

/** Map a section view (`ProposalSection` / `SectionTargetRef`) list to section targets. */
export function sectionsToTargets(sections: SectionTargetRef[]): ProposalSectionTargetRef[] {
  return sections.map(asSectionTarget);
}

/** The section subset of a target list, as plain `SectionTargetRef`s (drops `kind`). */
export function sectionTargetsOf(targets: ProposalTargetRef[]): SectionTargetRef[] {
  return targets
    .filter((t): t is ProposalSectionTargetRef => t.kind === "section")
    .map((t) => ({ doc_path: t.doc_path, heading_path: [...t.heading_path] }));
}

/** A plain section ref for a section target, or null for a document target. */
export function targetToSectionRef(target: ProposalTargetRef): SectionTargetRef | null {
  return target.kind === "section"
    ? { doc_path: target.doc_path, heading_path: [...target.heading_path] }
    : null;
}

/**
 * Stable key for a proposal target. Document and section targets live in
 * separate key namespaces so a document key never collides with a section key.
 */
export function proposalTargetKey(target: ProposalTargetRef): string {
  return target.kind === "document"
    ? "doc::" + target.doc_path
    : sectionGlobalKey(target.doc_path, target.heading_path);
}

/** Human-readable label for a proposal target (display/prose). */
export function proposalTargetLabel(target: ProposalTargetRef): string {
  if (target.kind === "document") return `${target.doc_path} (whole document)`;
  const heading = target.heading_path.length > 0
    ? target.heading_path.join(" > ")
    : "(document intro)";
  return `${target.doc_path} :: ${heading}`;
}

/** Structural equality of two proposal targets. */
export function proposalTargetsEqual(a: ProposalTargetRef, b: ProposalTargetRef): boolean {
  return proposalTargetKey(a) === proposalTargetKey(b);
}

// ─── Section Key Functions ─────────────────────────────────────────
// Single source of truth for key separator format. Zero dependencies.

/** Join a heading path into a single string key. e.g. ["A", "B"] → "A>>B" */
export function sectionHeadingKey(headingPath: string[]): string {
  return headingPath.join(">>");
}

/** Build a globally unique section key. e.g. ("doc.md", ["A"]) → "doc.md::A" */
export function sectionGlobalKey(docPath: string, headingPath: string[]): string {
  return docPath + "::" + sectionHeadingKey(headingPath);
}

// ─── Section Score Snapshot ────────────────────────────────────────

/**
 * Keyed by section key → score at the time of commit. Retained ONLY as the
 * human-involvement-policy committed-metadata representation (aligns with
 * `CommittedProposalFile.humanInvolvement_at_commit`); not a generic app type.
 */
export type SectionScoreSnapshot = Record<string, number>;

// ─── Human-Involvement Presets ───────────────────────────────────

export type HumanInvolvementPresetName = "yolo" | "aggressive" | "eager" | "conservative";

export interface HumanInvolvementPreset {
  name: HumanInvolvementPresetName;
  midpoint_seconds: number;
  steepness: number;
  description: string;
}

export const HUMAN_INVOLVEMENT_PRESETS: Record<HumanInvolvementPresetName, HumanInvolvementPreset> = {
  yolo: {
    name: "yolo",
    midpoint_seconds: 30,
    steepness: 3.0,
    description:
      "Almost no protection. Agents can write within 30 seconds of human activity. Only use for solo work or demos.",
  },
  aggressive: {
    name: "aggressive",
    midpoint_seconds: 300,
    steepness: 2.0,
    description:
      "Agents back off for about 5 minutes after human activity. Good for fast-paced teams comfortable with agent autonomy.",
  },
  eager: {
    name: "eager",
    midpoint_seconds: 7200,
    steepness: 1.2,
    description:
      "Agents wait about 2 hours after human activity. Balanced setting for most teams.",
  },
  conservative: {
    name: "conservative",
    midpoint_seconds: 28800,
    steepness: 0.9,
    description:
      "Agents wait about 8 hours after human activity. Maximum protection for sensitive documents.",
  },
};

// ─── Admin Configuration ───────────────────────────────────────────

export type GovernanceMode = "available" | "forced";

export type AgentAuthPolicy = "open" | "register" | "verify";

export interface AdminConfig {
  humanInvolvement_preset: HumanInvolvementPresetName;
  humanInvolvement_midpoint_seconds: number;
  humanInvolvement_steepness: number;
  snapshot_enabled: boolean;
  governance_mode: GovernanceMode;
  agent_auth_policy: AgentAuthPolicy;
}

// ─── ACL / RBAC Datatypes ──────────────────────────────────────────
//
// The auth model is role-based: a document requires a role for each action, and a
// connection holds a set of effective roles. These datatypes give that model a
// shared, validated vocabulary instead of loose `string` / `{ read?, write? }`
// shapes. Each type ships a companion object exposing `.parse(...)` (and, where
// useful, a `.of(...)` constructor) so the type and its trust boundary share one
// discoverable name. Parsers consume `JsonValue` and fail loud with field-specific
// prose; they never coerce. Brand minting for `RoleName` is confined to this
// section's parser/constructor — there is no scattered `as RoleName` elsewhere.

/** A document permission action. */
export type AclAction = "read" | "write";

export const AclAction = {
  values: ["read", "write"] as const,
  parse(value: JsonValue, label = "action"): AclAction {
    if (value === "read" || value === "write") return value;
    throw new Error(`${label} must be "read" or "write", got ${JSON.stringify(value)}`);
  },
};

/**
 * The three auto-granted "magic" roles. They are auto-granted based on connection
 * state but are otherwise ordinary roles for the permission check.
 */
export type BuiltinRoleName = "public" | "authenticated" | "admin";

export const BuiltinRoleName = {
  values: ["public", "authenticated", "admin"] as const,
  is(value: string): value is BuiltinRoleName {
    return value === "public" || value === "authenticated" || value === "admin";
  },
  parse(value: JsonValue, label = "builtin role"): BuiltinRoleName {
    if (typeof value === "string" && BuiltinRoleName.is(value)) return value;
    throw new Error(
      `${label} must be one of ${BuiltinRoleName.values.join(", ")}, got ${JSON.stringify(value)}`,
    );
  },
};

declare const __roleName: unique symbol;

/**
 * A role name. Branded so auth-domain functions accept/return validated role
 * names rather than arbitrary strings. A role name is a non-empty, trimmed string;
 * construct it only through `RoleName.of` / `RoleName.parse` (the sole minting
 * boundary for the brand).
 */
export type RoleName = string & { readonly [__roleName]: true };

export const RoleName = {
  /** Widen a `RoleName` back to its underlying string (no assertion — the brand is a subtype). */
  text(name: RoleName): string {
    return name;
  },
  /** Construct a `RoleName` from a trusted in-process string, validating non-emptiness. */
  of(value: string, label = "role name"): RoleName {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }
    return trimmed as RoleName;
  },
  /** Parse a `RoleName` from an untrusted JSON value. */
  parse(value: JsonValue, label = "role name"): RoleName {
    if (typeof value !== "string") {
      throw new Error(`${label} must be a string, got ${JSON.stringify(value)}`);
    }
    return RoleName.of(value, label);
  },
  /** Parse a JSON array of role names. */
  parseArray(value: JsonValue, label = "roles"): RoleName[] {
    if (!Array.isArray(value)) {
      throw new Error(`${label} must be an array of strings, got ${JSON.stringify(value)}`);
    }
    return value.map((element, index) => RoleName.parse(element, `${label}[${index}]`));
  },
};

/**
 * The required roles for the read and write actions on a document (or the system
 * defaults). Either action may be absent, meaning "inherit / unchanged".
 */
export interface AclPermissionSet {
  read?: RoleName;
  write?: RoleName;
}

export const AclPermissionSet = {
  parse(value: JsonValue, label = "permissions"): AclPermissionSet {
    const obj = expectJsonObject(value, label);
    const out: AclPermissionSet = {};
    if (obj.read !== undefined && obj.read !== null) {
      out.read = RoleName.parse(obj.read, `${label}.read`);
    }
    if (obj.write !== undefined && obj.write !== null) {
      out.write = RoleName.parse(obj.write, `${label}.write`);
    }
    return out;
  },
};

// ── ACL / RBAC API contracts ───────────────────────────────────────
//
// Request-contract companions return a `RequestParseResult` rather than throwing,
// so a route boundary can map an invalid body to `400` prose
// (`if (!parsed.ok) { sendApiError(res, 400, parsed.message); return; }`) while
// letting genuine domain/storage failures propagate fail-loud. The primitive
// parsers above (`RoleName.parse`, `AclPermissionSet.parse`, …) throw; the request
// parsers convert those throws into a result message.

/** Result of parsing an untrusted request body into a typed API contract. */
export type RequestParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * Run a throwing primitive parser and convert its failure into a request-parse
 * result message. Validation throws become `{ ok: false, message }` (→ 400);
 * the caller never sees the raw exception.
 */
function asRequestParseResult<T>(build: () => T): RequestParseResult<T> {
  try {
    return { ok: true, value: build() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Full snapshot of the ACL/RBAC state returned by `GET /admin/acl`. `defaults`
 * always resolves both actions; per-document `acl` entries and role assignments
 * are partial maps.
 */
export interface AclSnapshot {
  defaults: { read: RoleName; write: RoleName };
  acl: Record<string, AclPermissionSet>;
  roles: Record<string, RoleName[]>;
  customRoles: RoleName[];
}

/** Body of `PUT /admin/acl/defaults` — update the system default read/write roles. */
export interface SetAclDefaultsRequest {
  read?: RoleName;
  write?: RoleName;
}

export const SetAclDefaultsRequest = {
  parse(value: JsonValue, label = "set ACL defaults request"): RequestParseResult<SetAclDefaultsRequest> {
    return asRequestParseResult(() => AclPermissionSet.parse(value, label));
  },
};

/** Body of `PUT /admin/acl/doc/:docPath` — set the required roles for one document. */
export interface SetDocumentAclRequest {
  read?: RoleName;
  write?: RoleName;
}

export const SetDocumentAclRequest = {
  parse(value: JsonValue, label = "set document ACL request"): RequestParseResult<SetDocumentAclRequest> {
    return asRequestParseResult(() => AclPermissionSet.parse(value, label));
  },
};

/** Body of `PUT /admin/roles/:userId` — replace a user's assigned roles. */
export interface SetUserRolesRequest {
  roles: RoleName[];
}

export const SetUserRolesRequest = {
  parse(value: JsonValue, label = "set user roles request"): RequestParseResult<SetUserRolesRequest> {
    return asRequestParseResult(() => {
      const obj = expectJsonObject(value, label);
      return { roles: RoleName.parseArray(obj.roles, `${label}.roles`) };
    });
  },
};

/** Body of `POST /admin/custom-roles` — create a new custom role. */
export interface CreateCustomRoleRequest {
  name: RoleName;
}

export const CreateCustomRoleRequest = {
  parse(value: JsonValue, label = "create custom role request"): RequestParseResult<CreateCustomRoleRequest> {
    return asRequestParseResult(() => {
      const obj = expectJsonObject(value, label);
      return { name: RoleName.parse(obj.name, `${label}.name`) };
    });
  },
};

// ─── Proposal Model (v4 — layered storage / domain / DTO) ─────────

export type ProposalStatus = "draft" | "pending" | "inprogress" | "committing" | "committed" | "withdrawn";

/**
 * A detected defect on a proposal that was read leniently (so admin UI can load
 * and surface the problem) but must NOT be allowed to transition until repaired.
 * Absent/empty on healthy proposals. The set is open for new detectors to extend.
 *
 *   "missing-targets" — an older on-disk proposal predates the `targets` field
 *     and carried only `sections`; `targets` was backfilled from `sections` on
 *     read, which is lossy in the dangerous direction (a document-level claim
 *     cannot be expressed as section claims), so the proposal is quarantined
 *     until an admin autofix re-derives and persists `targets`.
 *   "empty-committed" — a TERMINAL committed proposal that omits `targets` AND has
 *     empty `sections`, so the lenient backfill derives ZERO targets: an empty
 *     committed proposal that claimed and changed nothing. This is corruption
 *     (an empty-publish no-op made permanent), not a benign legacy shape, and is
 *     NOT autofixable (there is nothing to re-derive from empty sections). The
 *     marker exists purely so such a proposal cannot read as healthy in the log.
 */
export type ProposalDefect = "missing-targets" | "empty-committed";

// ── Storage layer (what is stored in meta.json on disk) ────────────

/** Base fields present in every proposal meta.json file regardless of lifecycle state. */
export interface ProposalFileBase {
  id: ProposalId;
  writer: WriterIdentity;
  intent: string;
  /**
   * Section content/evaluation view (with per-section `justification`). This is
   * the semantic content unit set; it is NOT the authoritative lock/audit claim
   * set — that is {@link ProposalFileBase.targets} (spec 12 §Data Shapes).
   */
  sections: ProposalSection[];
  /**
   * Authoritative lock/audit/policy claim set (spec 12 §Data Shapes). Includes
   * section targets (mirroring `sections`) AND document targets for document
   * create/delete/rename, so a live-empty document operation still claims a
   * target. Derived/maintained only by the manifest-owning storage boundary.
   * Defensively backfilled from `sections` when an older on-disk proposal lacks it.
   */
  targets: ProposalTargetRef[];
  /**
   * Non-empty when this proposal was read leniently despite a detected defect
   * (see {@link ProposalDefect}). Absent on healthy proposals. A degraded
   * proposal is quarantined: it may be read and surfaced to admins, but the
   * storage/lock layer refuses to let it acquire locks or commit until an admin
   * autofix clears the marker. Never written by normal creation paths.
   */
  degraded?: ProposalDefect[];
  /**
   * Canonical section-file ids this proposal has deleted (identity-based delete
   * detection). Grow-only; absent on older on-disk proposals (decodes to `[]`).
   * The manifest merge keys delete-vs-inherit on this id set, NOT on a heading
   * path claim, so deletes survive ancestor restructuring without re-pathing.
   * `sections`/`targets` still carry the deleted path for lock/audit.
   */
  deleted_section_files?: DeletedSectionFileRef[];
  created_at: string;
  /**
   * Owning DocSession identity for CRDT-materialized live-edit proposals
   * (Area B). Present only on proposals created lazily by a DocSession's
   * live-edit materialization; absent for human draft→inprogress and agent
   * proposals. Used to enforce one-active-`inprogress`-proposal-per-DocSession
   * (Invariant 7) and to look the proposal up by session identity. NOTE: the
   * derived `status` is still never stored.
   */
  docSessionId?: DocSessionId;
}

/** Committed proposal meta.json — adds terminal commit fields (both required). */
export interface CommittedProposalFile extends ProposalFileBase {
  committed_head: string;
  /**
   * Policy-specific committed metadata for the human-involvement compatibility
   * policy. Preserved as-is (spec 12 §Data Shapes `HumanInvolvementCommittedProposalMetadata`);
   * do NOT generalise into a generic `commitRecord`. See {@link HumanInvolvementCommittedProposalMetadata}.
   */
  humanInvolvement_at_commit: Record<string, number>;
}

/**
 * Spec-12-aligned naming alias for the human-involvement compatibility policy's
 * committed metadata. Identical shape to `CommittedProposalFile.humanInvolvement_at_commit`.
 * A posture/delegation committed-metadata type is intentionally NOT added yet
 * (spec defers a generic audit format).
 */
export type HumanInvolvementCommittedProposalMetadata = Record<string, number>;

/**
 * In-progress proposal meta.json. Adds no fields beyond {@link ProposalFileBase}:
 * `targets` is the single authoritative lock/audit/policy claim set, so no separate
 * `locked_targets`/`locked_at` mirror is stored (spec 12 — the directory status is
 * the `inprogress` claim, and `targets` is what is claimed).
 */
export type InProgressProposalFile = ProposalFileBase;

/** Withdrawn proposal meta.json — adds optional withdrawal reason. */
export interface WithdrawnProposalFile extends ProposalFileBase {
  withdrawal_reason?: string;
}

/** Union of all proposal file variants for untyped disk reads. */
export type AnyProposalFile = ProposalFileBase | InProgressProposalFile | CommittedProposalFile | WithdrawnProposalFile;

// ── Domain layer (file + status, runtime representation) ──────────

/** Draft, pending, or committing proposal (no terminal fields). */
export interface DraftProposal extends ProposalFileBase {
  status: "draft" | "pending" | "committing";
}

/** In-progress proposal — locks acquired, human can edit before committing. */
export interface InProgressProposal extends InProgressProposalFile {
  status: "inprogress";
}

/** Committed proposal with required terminal fields. */
export interface CommittedProposalDomain extends CommittedProposalFile {
  status: "committed";
}

/** Withdrawn proposal with optional reason. */
export interface WithdrawnProposalDomain extends WithdrawnProposalFile {
  status: "withdrawn";
}

/** Discriminated union of all proposal domain states. */
export type AnyProposal = DraftProposal | InProgressProposal | CommittedProposalDomain | WithdrawnProposalDomain;

// ── DTO layer (enriched for API responses) ────────────────────────

/**
 * Draft proposal DTO — adds agent-write-policy + proposal-lock evaluation
 * computed at read time. `sections` reverts to plain {@link ProposalSection}[]
 * (per-section policy summaries are surfaced via the write-policy targets, not
 * baked into the section type). Lock conflicts are surfaced separately from
 * `agentWritePolicy` per spec 12 §Event/API Surfaces.
 */
export interface DraftProposalDTO extends DraftProposal {
  agentWritePolicy?: HumanInvolvementPolicyResult;
  lockEvaluation?: ProposalLockResult;
}

/** In-progress proposal DTO — adds agent-write-policy + proposal-lock evaluation computed at read time. */
export interface InProgressProposalDTO extends InProgressProposal {
  agentWritePolicy?: HumanInvolvementPolicyResult;
  lockEvaluation?: ProposalLockResult;
}

/** Union of all proposal DTO variants for API responses. */
export type ProposalDTO = DraftProposalDTO | InProgressProposalDTO | CommittedProposalDomain | WithdrawnProposalDomain;


// ── Proposal sub-types ────────────────────────────────────────────

export interface ProposalSection {
  doc_path: string;
  heading_path: string[];
  justification?: string;
}

/**
 * A canonical section-file id this proposal has DELETED, recorded by stable id
 * rather than by heading path (identity-based delete detection). The manifest
 * merge drops a canonical section whose `sectionFile` id is in this set, so a
 * delete survives any ancestor rename/move without re-pathing — paths move, ids
 * do not. The `sections`/`targets` claim still keeps the deleted section's path
 * (for lock/audit); this set is the SOLE delete signal the merge reads.
 */
export interface DeletedSectionFileRef {
  doc_path: string;
  section_file: string;
}

// ─── Agent Write Policy (spec 12 §Data Shapes) ─────────────────────
//
// The agent-write-policy result is the app/frontend-readable contract that
// replaces the old generic `humanInvolvement_evaluation` / `EvaluatedSection`
// vocabulary. The core carries only `canWrite` (machine-branchable) plus a
// mandatory prose `message` (Area M: never return a bare reason code as the
// explanation) and a typed `details` payload that varies per concrete policy.
//
// Common app code MUST branch on `canWrite` only. It must NOT assume `details`
// contains a score, reason enum, posture, delay, delegation, or threshold —
// those live inside concrete per-policy detail types below.

/** One per-target entry of an agent-write-policy result. */
export interface AgentWritePolicyTarget<TTargetDetails> {
  target: ProposalTargetRef;
  canWrite: boolean;
  /** Prose explanation for this target's decision (Area M). */
  message: string;
  details: TTargetDetails;
}

/** Generic agent-write-policy result. `TPolicyDetails`/`TTargetDetails` are typed by the active policy. */
export interface AgentWritePolicyResult<TPolicyDetails, TTargetDetails> {
  canWrite: boolean;
  /** Prose explanation for the overall decision (Area M). */
  message: string;
  targets: AgentWritePolicyTarget<TTargetDetails>[];
  details: TPolicyDetails;
}

/**
 * Human-involvement-compatibility policy detail reason (spec 12 §Data Shapes).
 *
 * Reframed from the old `EvaluatedSectionBlockedReason` soft-block union: the
 * dirty-session / live-focus reasons (`active_live_edit`,
 * `uncommitted_live_edits`) are dropped because all edits now flow through
 * proposals (Area F). This is a human-involvement-policy DETAIL enum, not a
 * generic app code — never surface it as the human-facing explanation (Area M).
 */
export type HumanInvolvementBlockedReason = "human_proposal_lock" | "aggregate_impact";

/** Policy-level details for the human-involvement compatibility policy. */
export interface HumanInvolvementPolicyDetails {
  aggregateImpact: number;
  aggregateThreshold: number;
}

/** Per-target details for the human-involvement compatibility policy. */
export interface HumanInvolvementTargetDetails {
  score: number;
  blockedReason: HumanInvolvementBlockedReason | null;
  justification: string | null;
}

/** Convenience alias: an agent-write-policy result for the human-involvement compatibility policy. */
export type HumanInvolvementPolicyResult = AgentWritePolicyResult<
  HumanInvolvementPolicyDetails,
  HumanInvolvementTargetDetails
>;

// ─── Posture / Delegation Policy (spec 12, forward-compat) ─────────
// Defined concretely and separately from the human-involvement details — no
// shared vocabulary across policies.

export type DocumentPosture = "open" | "guarded" | "human_only";

/** Policy-level details for the posture/delegation policy (no shared fields). */
export type PostureDelegationPolicyDetails = Record<string, never>;

/** Per-target details for the posture/delegation policy. */
export interface PostureDelegationTargetDetails {
  posture: DocumentPosture;
  delegatedByUserId: string | null;
}

// ─── Proposal FSM Lock Results (spec 12 §Data Shapes) ──────────────
// Kept under lock/conflict naming, deliberately separate from agent write
// policy. Definitions only; the FSM transition behaviour is Area F.

export interface ProposalLockCheck {
  proposalId: ProposalId;
  targets: ProposalTargetRef[];
}

export interface ProposalLockConflict {
  target: ProposalTargetRef;
  blockingProposalId: ProposalId;
  blockingProposalStatus: ProposalStatus;
  blockingWriter: WriterIdentity;
  /** Required action-oriented prose explanation for this conflict (Area M owns wording). */
  message: string;
}

export interface ProposalLockResult {
  acquired: boolean;
  conflicts: ProposalLockConflict[];
  /** Required top-level prose explanation; empty/success-phrased when acquired (Area M owns wording). */
  message: string;
}

// ─── Section-level Agent-Write-Policy Summary (spec 12 §Event/API) ──
//
// Replaces the hardcoded `humanInvolvement_score: number` generic field on the
// read-API section shapes. The generic part is `canWrite`; a human-involvement
// compatibility policy may still render a `score` inside its own `humanInvolvement`
// details. The builder behaviour is Area L.

export interface SectionAgentWritePolicySummary {
  /** Whether agents can currently write to this section under the active policy. */
  canWrite: boolean;
  /**
   * Backend-authored prose explanation of the current write-policy state for
   * this section. The single source of truth for the human-readable line shown
   * in the governance gutter / heatmap — clients render this verbatim rather
   * than synthesizing it from `canWrite` (spec 12 §"render the policy's prose
   * messages — never bare reason codes or enums").
   */
  message: string;
  /** Human-involvement compatibility policy details (present when that policy is active). */
  humanInvolvement?: { score: number };
}

// ─── Section State / Activity ──────────────────────────────────────

export interface SectionState {
  doc_path: string;
  heading_path: string[];
  last_human_commit_sha: string | null;
  last_editor_id: string | null;
  last_editor_type: AttributionWriterType | null;
  last_editor_display_name: string | null;
  crdt_session_active: boolean;
  crdt_holder_count: number;
  diverged: boolean;
  base_head: string | null;
  agentWritePolicy: SectionAgentWritePolicySummary;
}

// ─── Heatmap ───────────────────────────────────────────────────────

export interface HeatmapEntry {
  doc_path: string;
  heading_path: string[];
  agentWritePolicy: SectionAgentWritePolicySummary;
  crdt_session_active: boolean;
  last_human_commit_sha: string | null;

  last_commit_author: string | null;
  last_commit_timestamp: string | null;
}

export interface GetHeatmapResponse {
  preset: HumanInvolvementPresetName;
  humanInvolvement_midpoint_seconds: number;
  humanInvolvement_steepness: number;
  sections: HeatmapEntry[];
}

export interface AllSessionStatusesResponse {
  live_session_count: number;
  outstanding_doc_count: number;
  oldest_outstanding_change_at: string | null;
  last_commit_at: string | null;
}

// ─── Document Types ────────────────────────────────────────────────

export interface DocumentTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: DocumentTreeEntry[];
}

export interface DocStructureNode {
  heading: string;
  level: number;
  children: DocStructureNode[];
}

export interface SectionMeta {
  heading_path: string[];
  agentWritePolicy: SectionAgentWritePolicySummary;
  crdt_session_active: boolean;
  section_length_warning: boolean;
  word_count: number;
}

export interface GetDocumentResponse {
  doc_path: string;
  content: string;
  head_sha: string;
  sections_meta?: SectionMeta[];
}

export interface GetDocumentSectionsResponse {
  doc_path: string;
  sections: Array<{
    heading: string;
    heading_path: string[];
    depth: number;
    content: string;
    agentWritePolicy: SectionAgentWritePolicySummary;
    crdt_session_active: boolean;
    section_length_warning: boolean;
    word_count: number;
    /** Opaque backend-owned CRDT fragment identity. */
    fragment_key: string;
    /** Section filename (e.g. "sec_abc123def.md"). Useful for UI metadata. */
    section_file: string;
    last_editor?: { id: string; name: string; timestampMs: number; type: AttributionWriterType; seconds_ago: number };
    /** True when a proposal FSM lock currently locks this section (lock/conflict naming, spec 12 §Event/API). */
    locked?: boolean;
  }>;
}

export interface GetDocumentsTreeResponse {
  tree: DocumentTreeEntry[];
}

export interface ReadDocStructureResponse {
  doc_path: string;
  structure: DocStructureNode[];
}

// ─── Section Read/Write ────────────────────────────────────────────

export interface ReadSectionResponse {
  doc_path: string;
  heading_path: string[];
  content: string;
  head_sha: string;
}

// ─── Proposal API ──────────────────────────────────────────────────

/** Evaluation outcome: did all sections pass, or were some blocked? */
export type ProposalOutcome = "accepted" | "blocked";

export interface CreateProposalRequest {
  intent: string;
  sections: Array<{
    doc_path: string;
    heading_path: string[];
    content: string;
    justification?: string;
  }>;
}

export interface CreateProposalResponse {
  proposal_id: ProposalId;
  status: ProposalStatus;
  /** Machine-readable branching field only — NOT the human-facing explanation (Area M). */
  outcome: ProposalOutcome;
  agentWritePolicy: HumanInvolvementPolicyResult;
  lockEvaluation?: ProposalLockResult;
}

/**
 * Body of `PUT /api/proposals/:id` — the narrowed proposal manifest update:
 * intent + the target section scope (the lock claim) ONLY. Section CONTENT is no
 * longer carried here; staged content is written through the dedicated
 * `PUT /api/proposals/:id/sections` (bulk) and
 * `PUT /api/proposals/:id/documents/:docPath/sections` (per-document) routes.
 */
export interface UpdateProposalManifestRequest {
  intent?: string;
  targets: Array<{
    doc_path: string;
    heading_path: string[];
    justification?: string;
  }>;
}

/**
 * Body of `PUT /api/proposals/:id/sections` — bulk staged-content replace across
 * any number of target documents. Each entry carries explicit `doc_path` and the
 * full markdown `content` to stage into the proposal content tree.
 */
export interface ReplaceProposalSectionsRequest {
  sections: Array<{
    doc_path: string;
    heading_path: string[];
    content: string;
  }>;
}

/**
 * Body of `PUT /api/proposals/:id/documents/:docPath/sections` — per-document
 * staged-content write. The document is identified by the URL path; each entry
 * carries the in-document `heading_path` and the full markdown `content`.
 */
export interface WriteProposalDocumentSectionsRequest {
  sections: Array<{
    heading_path: string[];
    content: string;
  }>;
}

/**
 * Response of `GET /api/proposals/:id/sections` — a bulk read of the effective
 * proposal-scoped section list + content for every document the proposal targets.
 */
export interface GetProposalSectionsResponse {
  proposal_id: ProposalId;
  documents: GetDocumentSectionsResponse[];
}

// ── Proposal request parsing (companion parsers) ───────────────────
//
// `CreateProposalRequest.parse` / `UpdateProposalManifestRequest.parse` /
// `ReplaceProposalSectionsRequest.parse` / `WriteProposalDocumentSectionsRequest.parse`
// validate an untrusted request body and return a `RequestParseResult` for the route's
// `if (!parsed.ok) { sendApiError(res, 400, parsed.message); return; }` boundary.
// They validate shape only (record-ness, field types) — they are NOT a DTO
// boundary and do not apply human/agent policy (the use cases still do that).

type ProposalSectionInput = {
  doc_path: string;
  heading_path: string[];
  content: string;
  justification?: string;
};

function jsonRequireString(obj: JsonObject, key: string, label: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`${label}.${key} must be a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function jsonOptionalString(obj: JsonObject, key: string, label: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label}.${key} must be a string when present, got ${JSON.stringify(value)}`);
  }
  return value;
}

function jsonRequireStringArray(obj: JsonObject, key: string, label: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new Error(`${label}.${key} must be an array of strings, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => {
    if (typeof element !== "string") {
      throw new Error(`${label}.${key}[${index}] must be a string, got ${JSON.stringify(element)}`);
    }
    return element;
  });
}

function parseProposalSectionInput(value: JsonValue, label: string): ProposalSectionInput {
  const obj = expectJsonObject(value, label);
  const section: ProposalSectionInput = {
    doc_path: jsonRequireString(obj, "doc_path", label),
    heading_path: jsonRequireStringArray(obj, "heading_path", label),
    content: jsonRequireString(obj, "content", label),
  };
  const justification = jsonOptionalString(obj, "justification", label);
  if (justification !== undefined) section.justification = justification;
  return section;
}

function parseProposalSectionInputs(value: JsonValue, label: string): ProposalSectionInput[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => parseProposalSectionInput(element, `${label}[${index}]`));
}

export const CreateProposalRequest = {
  parse(value: JsonValue, label = "create proposal request"): RequestParseResult<CreateProposalRequest> {
    return asRequestParseResult(() => {
      const obj = expectJsonObject(value, label);
      return {
        intent: jsonRequireString(obj, "intent", label),
        sections: parseProposalSectionInputs(obj.sections, `${label}.sections`),
      };
    });
  },
};

type ProposalTargetInput = {
  doc_path: string;
  heading_path: string[];
  justification?: string;
};

function parseProposalTargetInput(value: JsonValue, label: string): ProposalTargetInput {
  const obj = expectJsonObject(value, label);
  const target: ProposalTargetInput = {
    doc_path: jsonRequireString(obj, "doc_path", label),
    heading_path: jsonRequireStringArray(obj, "heading_path", label),
  };
  const justification = jsonOptionalString(obj, "justification", label);
  if (justification !== undefined) target.justification = justification;
  return target;
}

function parseProposalTargetInputs(value: JsonValue, label: string): ProposalTargetInput[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => parseProposalTargetInput(element, `${label}[${index}]`));
}

export const UpdateProposalManifestRequest = {
  parse(value: JsonValue, label = "update proposal manifest request"): RequestParseResult<UpdateProposalManifestRequest> {
    return asRequestParseResult(() => {
      const obj = expectJsonObject(value, label);
      const request: UpdateProposalManifestRequest = {
        targets: parseProposalTargetInputs(obj.targets, `${label}.targets`),
      };
      const intent = jsonOptionalString(obj, "intent", label);
      if (intent !== undefined) request.intent = intent;
      return request;
    });
  },
};

type ProposalSectionContentInput = {
  doc_path: string;
  heading_path: string[];
  content: string;
};

function parseProposalSectionContentInput(value: JsonValue, label: string): ProposalSectionContentInput {
  const obj = expectJsonObject(value, label);
  return {
    doc_path: jsonRequireString(obj, "doc_path", label),
    heading_path: jsonRequireStringArray(obj, "heading_path", label),
    content: jsonRequireString(obj, "content", label),
  };
}

export const ReplaceProposalSectionsRequest = {
  parse(value: JsonValue, label = "replace proposal sections request"): RequestParseResult<ReplaceProposalSectionsRequest> {
    return asRequestParseResult(() => {
      const obj = expectJsonObject(value, label);
      const sectionsValue = obj.sections;
      if (!Array.isArray(sectionsValue)) {
        throw new Error(`${label}.sections must be an array, got ${JSON.stringify(sectionsValue)}`);
      }
      return {
        sections: sectionsValue.map((element, index) =>
          parseProposalSectionContentInput(element, `${label}.sections[${index}]`),
        ),
      };
    });
  },
};

export const WriteProposalDocumentSectionsRequest = {
  parse(value: JsonValue, label = "write proposal document sections request"): RequestParseResult<WriteProposalDocumentSectionsRequest> {
    return asRequestParseResult(() => {
      const obj = expectJsonObject(value, label);
      const sectionsValue = obj.sections;
      if (!Array.isArray(sectionsValue)) {
        throw new Error(`${label}.sections must be an array, got ${JSON.stringify(sectionsValue)}`);
      }
      return {
        sections: sectionsValue.map((element, index) => {
          const itemLabel = `${label}.sections[${index}]`;
          const itemObj = expectJsonObject(element, itemLabel);
          return {
            heading_path: jsonRequireStringArray(itemObj, "heading_path", itemLabel),
            content: jsonRequireString(itemObj, "content", itemLabel),
          };
        }),
      };
    });
  },
};

// ── Live cross-section move (control-plane REST, NOT CRDT) ─────────

/** Drop position relative to the target section. */
export type LiveMovePosition = "before" | "after";

/** Body of `POST /workspace/:docPath/live-move` — the refusable live drag-drop move. */
export interface LiveMoveSectionRequest {
  source_heading_path: string[];
  target_heading_path: string[];
  position: LiveMovePosition;
}

export const LiveMoveSectionRequest = {
  parse(value: JsonValue, label = "live move request"): RequestParseResult<LiveMoveSectionRequest> {
    return asRequestParseResult(() => {
      const obj = expectJsonObject(value, label);
      const position = obj.position;
      if (position !== "before" && position !== "after") {
        throw new Error(`${label}.position must be "before" or "after", got ${JSON.stringify(position)}`);
      }
      return {
        source_heading_path: jsonRequireStringArray(obj, "source_heading_path", label),
        target_heading_path: jsonRequireStringArray(obj, "target_heading_path", label),
        position,
      };
    });
  },
};

export interface CommitProposalAccepted {
  proposal_id: ProposalId;
  status: "committed";
  outcome: "accepted";
  committed_head: string;
  agentWritePolicy: HumanInvolvementPolicyResult;
}

export interface CommitProposalBlocked {
  proposal_id: ProposalId;
  status: "draft";
  outcome: "blocked";
  /** Required prose explanation for the block (Area M). */
  message: string;
  agentWritePolicy: HumanInvolvementPolicyResult;
}

export type CommitProposalResponse = CommitProposalAccepted | CommitProposalBlocked;

export interface WithdrawProposalResponse {
  proposal_id: ProposalId;
  status: "withdrawn";
}

export interface AcquireLocksSuccess {
  proposal_id: ProposalId;
  acquired: true;
  status: "inprogress";
}

export interface AcquireLocksFailure {
  proposal_id: ProposalId;
  acquired: false;
  /** Required prose explanation for the lock-acquisition failure (Area M). */
  message: string;
  /** Structured FSM lock conflicts that blocked acquisition (spec 12 §Data Shapes). */
  conflicts: ProposalLockConflict[];
}

export type AcquireLocksResponse = AcquireLocksSuccess | AcquireLocksFailure;

export interface ReadProposalResponse {
  proposal: ProposalDTO;
}

export interface ListProposalsResponse {
  proposals: AnyProposal[];
}

// ─── Activity ──────────────────────────────────────────────────────

export interface ActivityItem {
  id: string;
  timestamp: string;
  writer_id: string;
  writer_type: WriterType;
  writer_display_name: string;
  commit_sha: string;
  sections: SectionTargetRef[];
  intent?: string;
}

export interface GetActivityResponse {
  items: ActivityItem[];
}

// ─── Admin ─────────────────────────────────────────────────────────

export interface GetAdminSnapshotHealthResponse {
  snapshot_enabled: boolean;
  snapshots_exist: boolean;
  snapshot_stale: boolean;
  snapshot_root: string;
  snapshot_root_writable: boolean;
  snapshot_root_error?: string;
}

export interface ServerStartRecord {
  type: "server_start";
  timestamp: number;
}

export interface SnapshotRecord {
  type: "snapshot";
  timestamp: number;
  batch_doc_count: number;
  failed_doc_count: number;
  content_file_count: number;
  snapshot_file_count: number;
  error?: string;
}

export type SnapshotRunRecord = ServerStartRecord | SnapshotRecord;

export interface GetAdminSnapshotHistoryResponse {
  snapshot_enabled: boolean;
  current_content_file_count: number;
  current_snapshot_file_count: number;
  commits_since_last_snapshot: number | null;
  history: SnapshotRunRecord[];
}

// ─── Runtime Memory ────────────────────────────────────────────────
//
// In-memory-only runtime memory monitor for EC2 sizing. Values are bytes on the
// wire; the frontend owns MiB/GiB formatting. `container_memory_bytes` is
// sourced from `/sys/fs/cgroup/memory.current` and is `null` outside a cgroup
// environment (e.g. non-container dev). `process_rss_bytes` and
// `heap_used_bytes` come from `process.memoryUsage()`.

export interface RuntimeMemorySample {
  timestamp_ms: number;
  container_memory_bytes: number | null;
  process_rss_bytes: number;
  heap_used_bytes: number;
}

export interface RuntimeMemoryHighWaterMark {
  container_memory_bytes: number | null;
  process_rss_bytes: number;
  heap_used_bytes: number;
}

export interface RuntimeMemoryProcess {
  pid: number;
  name: string;
  display_name: string;
  expected_in_production: boolean;
  rss_bytes: number;
}

export interface GetAdminRuntimeMemoryResponse {
  started_at: string;
  sample_interval_ms: number;
  sample_capacity: number;
  current: RuntimeMemorySample | null;
  high_water_mark: RuntimeMemoryHighWaterMark;
  cgroup_processes: RuntimeMemoryProcess[];
  samples: RuntimeMemorySample[];
}

// ─── Git Backup ────────────────────────────────────────────────────
//
// Private Git remote backup and restore of durable whole-instance state.
// Backup includes canonical published content Git history and auth/RBAC
// state only; proposal directories are excluded from backup and restore.
//
// Wire types are shape-only: the backend derives status by shelling out to
// `git` from the data root (never accepting admin-supplied commands) and
// returns these structured payloads for the admin UI to render.

/** Which credential channel the backend uses to talk to the backup remote. */
export type GitBackupAuthMode = "ssh-key" | "ssh-agent";

/**
 * Overall availability of the Git backup feature. `not_configured` means
 * `KS_BACKUP_GIT_REMOTE` is absent (or the auth-mode env pair is invalid);
 * `configured` means the wiring is present — individual checks (SSH key
 * reachability, remote reachability, atomic-push support) still determine
 * whether the Run button lights up.
 */
export type GitBackupFeatureState = "not_configured" | "configured";

/**
 * Completeness state of a would-be backup at this instant. `quiet` means
 * there are no active proposals to drop; `warning` means active proposals
 * exist — backup can still run (under lockdown) but will not include the
 * unpublished proposal work.
 */
export type GitBackupQuietState = "quiet" | "warning";

/**
 * Status of one backup-readiness probe.
 *
 *   `pass`           — the probe ran and the check succeeded.
 *   `fail`           — the probe ran and the check failed; `message` explains
 *                      what the admin needs to change.
 *   `not_applicable` — the probe does not apply in the current configuration
 *                      (e.g. `ssh_agent_socket_reachable` while
 *                      `credential_mode` is `ssh-key`).
 *   `not_checked`    — the probe is deliberately skipped in this response
 *                      (e.g. atomic-push support is only proved at backup run
 *                      time because probing it would mutate a local ref).
 *
 * The discriminated union replaces an earlier `GitBackupStatusCheck | null`
 * shape where `null` overloaded "does not apply" and "was not checked" and
 * "the check has no message when passing".
 */
export type GitBackupStatusCheck =
  | { status: "pass" }
  | { status: "fail"; message: string }
  | { status: "not_applicable" }
  | { status: "not_checked" };

/**
 * In-memory record of the most recent successful backup this process ran.
 * Persisted only for the lifetime of the running backend (spec: no on-disk
 * record of backup history).
 */
export interface GitBackupLastSuccess {
  timestamp: string;
  local_content_sha: string;
  local_auth_sha: string;
  remote_url: string;
  remote_content_sha: string;
  remote_auth_sha: string;
}

/** Response of `GET /api/admin/git-backup/status`. */
export interface GetAdminGitBackupStatusResponse {
  feature_state: GitBackupFeatureState;
  remote_url: string | null;
  credential_mode: GitBackupAuthMode | null;
  /** `not_applicable` when `credential_mode` is not `ssh-key`. */
  ssh_key_reachable: GitBackupStatusCheck;
  /**
   * Presence-and-socket-type check on the configured `SSH_AUTH_SOCK` path;
   * `not_applicable` when `credential_mode` is not `ssh-agent`. This does
   * NOT prove SSH auth works — actual auth failures surface in
   * `remote_reachable`.
   */
  ssh_agent_socket_reachable: GitBackupStatusCheck;
  known_hosts_configured: boolean;
  known_hosts_warning: string | null;
  /** `not_checked` when the feature is not configured. */
  remote_reachable: GitBackupStatusCheck;
  /**
   * Always `not_checked` in this status payload: proving atomic-push works
   * requires building a temporary local `refs/heads/auth/main`, which is a
   * mutating side effect and must not happen just because the admin loaded
   * this page. `POST /api/admin/git-backup/run` builds a fresh auth snapshot
   * and does the real atomic push, and surfaces any refusal there as an
   * actionable 409.
   */
  atomic_push_supported: GitBackupStatusCheck;
  quiet_state: GitBackupQuietState;
  active_proposal_count: number;
  local_content_sha: string | null;
  local_auth_sha: string | null;
  remote_content_sha: string | null;
  remote_auth_sha: string | null;
  last_successful_backup: GitBackupLastSuccess | null;
}

/**
 * `POST /api/admin/git-backup/run` takes no request body: the backend
 * refuses backup whenever active proposals exist (no client-side override),
 * so there is nothing for the client to encode.
 */

/** Response of `POST /api/admin/git-backup/run`. */
export interface RunAdminGitBackupResponse {
  last_successful_backup: GitBackupLastSuccess;
}

/** Response of `POST /api/admin/git-backup/verify`. */
export interface VerifyAdminGitBackupResponse {
  content_ref_match: boolean;
  auth_ref_match: boolean;
  local_content_sha: string;
  local_auth_sha: string | null;
  remote_content_sha: string | null;
  remote_auth_sha: string | null;
  message: string;
}

/** Response of `GET /api/admin/git-backup/restore-status`. */
export interface GetAdminGitRestoreStatusResponse {
  feature_state: GitBackupFeatureState;
  remote_url: string | null;
  credential_mode: GitBackupAuthMode | null;
  /** `not_checked` when the feature is not configured. */
  remote_reachable: GitBackupStatusCheck;
  remote_content_sha: string | null;
  remote_auth_sha: string | null;
  target_virgin: boolean;
  target_virgin_message: string;
  content_commit_count: number;
  content_file_count: number;
  /**
   * Count of ALL files (recursive) under `data/auth/`. Any file at all blocks
   * restore — there is no whitelist of "durable" filenames — because we cannot
   * safely assume incidental files belong to the operator rather than to
   * mid-migration state.
   */
  auth_file_count: number;
}

/** Response of `POST /api/admin/git-backup/restore`. */
export interface RunAdminGitRestoreResponse {
  content_sha: string;
  auth_sha: string;
}

// ─── Create Document ───────────────────────────────────────────

export interface CreateDocumentResponse {
  doc_path: string;
}

// ─── Auth ──────────────────────────────────────────────────────────

export type LoginProvider = "single_user" | "credentials" | "oidc" | "hybrid";

export interface AuthMethod {
  type: "single_user" | "credentials" | "oidc";
  displayName: string;
  authUrl?: string; // only present for "oidc"
}

export interface AuthUser {
  id: string;
  type: WriterType;
  displayName: string;
  email?: string;
}

export interface SessionInfoResponse {
  authenticated: boolean;
  user?: AuthUser;
  login_providers?: LoginProvider[];
}

// ─── API Errors ────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  details?: unknown;
}

// ─── WebSocket Events ──────────────────────────────────────────────

export interface ContentCommittedEvent {
  type: "content:committed";
  doc_path: string;
  sections: SectionTargetRef[];
  commit_sha: string;
  writer_id: string;
  writer_display_name: string;
  writer_type: WriterType;
  /** All writer IDs who contributed edits during this session. Used by frontends
   *  to clear dirty/persistence state for all participants, not just the committer. */
  contributor_ids: string[];
  seconds_ago: number;
}

// NOTE: the legacy `dirty:changed` event (DirtyChangedEvent) has been retired.
// It had no server emitter and the frontend ignored it; its role — signalling a
// section has uncommitted edits — is now served, per-section and with editor
// identity, by `SectionPendingStateEvent` (`section:pending`/`section:settled`).

export interface WriterDirtyStateChangedEvent {
  type: "writer:dirty-state-changed";
  writer_id: string;
  doc_path: string;
}

export interface SessionStatusChangedEvent {
  type: "session:status-changed";
  doc_path: string;
}

export interface AgentReadingEvent {
  type: "agent:reading";
  actor_id: string;
  actor_display_name: string;
  doc_path: string;
  heading_paths: string[][];
}

export interface PresenceEditingEvent {
  type: "presence:editing";
  writer_id: string;
  writer_display_name: string;
  writer_type: WriterType;
  doc_path: string;
  heading_path: string[];
}

export interface PresenceDoneEvent {
  type: "presence:done";
  writer_id: string;
  writer_display_name: string;
  writer_type: WriterType;
  doc_path: string;
  heading_path: string[];
}

/**
 * Emitted whenever a document's LIVE section topology changes during an editing
 * session (split / merge / rename / level-change / relocate / reorder), carrying the
 * full authoritative section list in document order — the SAME shape and fields as
 * `GET /workspace/:docPath/sections` (`GetDocumentSectionsResponse.sections`). Every
 * field is server-authored; the browser adopts the list verbatim and NEVER
 * synthesizes section metadata. The frontend adopts it directly (no canonical
 * refetch — a live split is invisible to canonical until commit), preserving mounted
 * editors by `fragment_key`. Also emitted by the canonical REST structure routes
 * (delete / move / rename) when no session is live, where the list is canonical.
 */
export interface DocStructureChangedEvent {
  type: "doc:structure-changed";
  doc_path: string;
  sections: GetDocumentSectionsResponse["sections"];
}

export interface DocRenamedEvent {
  type: "doc:renamed";
  old_path: string;
  new_path: string;
  committed_head: string;
}

export interface ProposalDraftEvent {
  type: "proposal:draft";
  proposal_id: string;
  doc_path: string;
  heading_paths: string[][];
  writer_id: string;
  writer_display_name: string;
  intent: string;
}

export interface ProposalInProgressEvent {
  type: "proposal:inprogress";
  proposal_id: string;
  doc_path: string;
  heading_paths: string[][];
  writer_id: string;
  writer_display_name: string;
  intent: string;
}

export interface ProposalWithdrawnEvent {
  type: "proposal:withdrawn";
  proposal_id: string;
  doc_path: string;
  heading_paths: string[][];
}

export interface ProposalSectionAvailabilityEntry {
  doc_path: string;
  heading_path: string[];
  available: boolean;
  /**
   * Required action-oriented prose explanation when `available` is false (Area M:
   * never a bare enum code). Describes which proposal/writer holds the section and
   * what clears it. Omitted when the section is available.
   */
  message?: string;
  /** Structured FSM-lock conflict fields for branching/styling only (spec 12 §Event/API). */
  blocking_proposal_id?: string;
  blocking_proposal_status?: ProposalStatus;
  holder_writer_id?: string;
  holder_writer_display_name?: string;
}

export interface ProposalSectionAvailabilityEvent {
  type: "proposal:section-availability";
  proposal_id: string;
  proposal_status: ProposalStatus;
  sections: ProposalSectionAvailabilityEntry[];
}

export interface CatalogChangedEvent {
  type: "catalog:changed";
  added_doc_paths?: string[];
  removed_doc_paths?: string[];
  writer_type?: WriterType;
  writer_display_name?: string;
}

/**
 * Per-section CRDT block-state events (spec 05-ydoc-lifecycle §"Section
 * block-state events"). These ride the JSON application WebSocket and keep the
 * browser's mount Set in lockstep with server reality:
 *   section:blocked   — a proposal lock now owns the section → read-only
 *   section:unblocked — the section returns to editable
 *   section:gone      — the section's canonical identifier no longer resolves
 * `fragment_key` is the opaque backend-owned CRDT fragment identity.
 */
export interface SectionBlockStateEvent {
  type: "section:blocked" | "section:unblocked" | "section:gone";
  doc_path: string;
  fragment_key: string;
  heading_path?: string[];
}

/**
 * Per-section "uncommitted edits" events (Guarantee B). These ride the JSON
 * application WebSocket alongside the block-state events and tell viewers a
 * section has live edits in a DocSession's `inprogress` proposal that are NOT
 * yet committed to canonical:
 *   section:pending  — the section gained uncommitted edits (a human is editing
 *                      it; the proposal has not committed). Carries the editor
 *                      identity so the UI can say "edited by Alice — not saved".
 *   section:settled  — the section's uncommitted edits committed (or the
 *                      inprogress proposal was abandoned); clear the pending mark.
 *
 * This is DISTINCT from `section:blocked` (a *separate* proposal locked the
 * section read-only) and from `content:committed` (the canonical commit itself).
 * `fragment_key` is the opaque backend-owned CRDT fragment identity, matching the
 * block-state events so the browser keys both on the same per-section identity.
 */
export interface SectionPendingStateEvent {
  type: "section:pending" | "section:settled";
  doc_path: string;
  fragment_key: string;
  heading_path?: string[];
  /** The editor whose uncommitted edit made the section pending. Omitted for
   *  `section:settled`. */
  writer_id?: string;
  writer_display_name?: string;
}

/**
 * Reason code for an expected CRDT live-edit rejection. Every value MUST also
 * appear in the backend acceptance-gate rejection group's reason code so the
 * two shapes stay unified end-to-end.
 *   duplicate-sibling-heading   — the settled structural change would produce
 *                                 two same-parent siblings with matching
 *                                 heading text at the same level, breaking
 *                                 heading-path addressability.
 *   invalid-live-edit-structure — reserved for future ingress-time structural
 *                                 validators.
 */
export type SectionEditRejectedReasonCode =
  | "duplicate-sibling-heading"
  | "invalid-live-edit-structure";

/**
 * Origin-only per-section CRDT live-edit rejection event. Emitted ONLY to the
 * client instance whose edit was rejected — never broadcast to the whole
 * document subscription. Carries substantial user-facing explanation fields
 * (`title`, `message`, `what_happened`, `why_rejected`, `server_action`,
 * `guidance`) so the frontend can render an interruptive rejection modal
 * without inventing its own copy. `rejected_by` is fixed to `"server"` today —
 * only the acceptance gate rejects live edits — and is included so future
 * client-side or peer-side rejection sources can be distinguished without
 * versioning the union.
 *
 * See also: the acceptance gate's `LiveEditRejectionGroup` shape in
 * `backend/src/ws/crdt-ws-coordinator.ts` — the two must stay in lockstep.
 */
export interface SectionEditRejectedEvent {
  type: "section:edit-rejected";
  doc_path: string;
  rejected_by: "server";
  affected_fragments: Array<{
    fragment_key: string;
    heading_path?: string[];
    heading?: string;
  }>;
  reason_code: SectionEditRejectedReasonCode;
  title: string;
  message: string;
  what_happened: string;
  why_rejected: string;
  server_action: string;
  guidance: string;
}

/**
 * Structured report of a process-level fatal invariant failure. Produced by
 * the backend fatal handler and surfaced to clients under
 * `KS_FATAL_ERRORS_MODE=report`.
 *
 * Shared with dev-supervisor SSE (see `SystemState`) so both delivery paths
 * (dev SSE, prod WS) use one shape.
 */
export interface FatalReport {
  message: string;
  stack: string;
  cause: string | null;
  origin: "uncaughtException" | "unhandledRejection";
  /** ISO-8601. */
  timestamp: string;
}

/**
 * System-scoped app event emitted when the backend hits a fatal invariant
 * failure while `KS_FATAL_ERRORS_MODE=report`. Has no `doc_path`; the hub
 * fans it out to every open socket. Frontend consumers open the full-screen
 * fatal UI in response.
 */
export interface SystemFatalEvent {
  type: "system:fatal";
  report: FatalReport;
}

export type WsServerEvent =
  | ContentCommittedEvent
  | WriterDirtyStateChangedEvent
  | SessionStatusChangedEvent
  | AgentReadingEvent
  | PresenceEditingEvent
  | PresenceDoneEvent
  | DocStructureChangedEvent
  | DocRenamedEvent
  | ProposalDraftEvent
  | ProposalInProgressEvent
  | ProposalWithdrawnEvent
  | ProposalSectionAvailabilityEvent
  | SectionBlockStateEvent
  | SectionPendingStateEvent
  | SectionEditRejectedEvent
  | CatalogChangedEvent
  | SystemFatalEvent;

// ─── WebSocket Client Messages ─────────────────────────────────────
//
// The JSON application WebSocket only carries subscription intent. The former
// focus/pulse client-message surface (`focus_section`/`blur_section`/
// `session_departure`) had NO server consumer — the hub parser ignored them
// entirely (spec 06 §6) — so it was removed end-to-end (MW-13).
//
// NOTE: this is distinct from the LIVE CRDT mode-transition focus surface
// (`EditorFocusTarget` / `RemoteParticipant.editorFocusTarget` /
// `ModeTransitionRequest.editorFocusTarget` above), which IS server-authoritative
// (the CRDT coordinator patches `editorFocusTarget`) and is deliberately kept.

export interface WsSubscribeMessage {
  action: "subscribe";
  doc_path: string;
  /**
   * Stable per-tab client instance identity. When present, the hub routes
   * origin-only app events (e.g. `section:edit-rejected`) exclusively to the
   * matching `(doc_path, clientInstanceId)` tab, so semantic rejection
   * explanations never leak into other tabs of the same writer. Omit when a
   * connection has no per-tab identity (server-internal subscribers, tests).
   */
  clientInstanceId?: string;
}

export interface WsUnsubscribeMessage {
  action: "unsubscribe";
  doc_path: string;
}

/**
 * Hint that binds a client-instance identity to this connection without
 * subscribing to a specific document. Useful during the initial handshake so
 * private events can be routed even before the tab explicitly subscribes.
 */
export interface WsIdentifyMessage {
  action: "identify";
  clientInstanceId: string;
}

export type WsClientMessage =
  | WsSubscribeMessage
  | WsUnsubscribeMessage
  | WsIdentifyMessage;

// ─── Agent Activity View ─────────────────────────────────────────

export type AgentConnectionStatus = "active" | "idle" | "offline";

export interface AgentProposalSnapshot {
  readonly id: string;
  readonly intent: string;
  readonly status: ProposalStatus;
  readonly created_at: string;
  readonly doc_paths: readonly string[];
  readonly section_count: number;
}

export interface AgentActivitySummary {
  readonly agent_id: string;
  readonly display_name: string;
  readonly connection_status: AgentConnectionStatus;
  readonly last_seen_at: string | null;
  readonly mcp_tool_usage: Readonly<Record<string, number>>;
  readonly draft_proposals: readonly AgentProposalSnapshot[];
  readonly recent_proposals: readonly AgentProposalSnapshot[];
  readonly stats: {
    readonly proposals_committed: number;
    readonly proposals_blocked: number;
    readonly proposals_withdrawn: number;
    readonly total_tool_calls: number;
  };
}

export interface GetAgentsFullSummaryResponse {
  readonly agents: readonly AgentActivitySummary[];
  readonly posture: {
    readonly preset: HumanInvolvementPresetName;
    readonly description: string;
  };
}

// ─── Git Blame Attribution ────────────────────────────────────────

export interface BlameLineAttribution {
  line: number;
  type: AttributionWriterType | "mixed";
  author?: string;
}

export interface BlameResponse {
  lines: BlameLineAttribution[];
}

// ─── Document Replacement Notice ─────────────────────────────────

export interface DocumentReplacementNoticePayload {
  /** Simple reconnect notice shown after restore or overwrite replaced the document. */
  message: string;
}
