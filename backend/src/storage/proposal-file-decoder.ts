/** Decodes an on-disk proposal `meta.json` into a typed domain object. */
import {
  expectJsonObject,
  ProposalAdoptionId,
  sectionsToTargets,
  TERMINAL_PROPOSAL_STATUSES,
  type JsonObject,
  type JsonValue,
} from "../types/shared.js";
import type {
  AnyProposal,
  DeletedSectionFileRef,
  HumanInvolvementCommittedProposalMetadata,
  InProgressProposal,
  ProposalFileBase,
  ProposalId,
  ProposalSection,
  ProposalStatus,
  ProposalTargetRef,
  WriterIdentity,
  WriterType,
} from "../types/shared.js";

// ─── Scalar field helpers (no `as`/`unknown`/`any`) ───────────────────

function requireString(obj: JsonObject, key: string, label: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`${label}.${key} must be a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalString(obj: JsonObject, key: string, label: string): string | undefined {
  if (!(key in obj)) return undefined;
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label}.${key} must be a string when present, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Local array guard — `Array.isArray` does not narrow a `readonly JsonValue[]` union member. */
function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function requireArray(obj: JsonObject, key: string, label: string): readonly JsonValue[] {
  const value = obj[key];
  if (!isJsonArray(value)) {
    throw new Error(`${label}.${key} must be an array, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireStringArray(value: JsonValue, label: string): string[] {
  if (!isJsonArray(value)) {
    throw new Error(`${label} must be an array of strings, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => {
    if (typeof element !== "string") {
      throw new Error(`${label}[${index}] must be a string, got ${JSON.stringify(element)}`);
    }
    return element;
  });
}

// ─── Nested shape decoders ─────────────────────────────────────────────

function decodeWriterType(value: JsonValue, label: string): WriterType {
  if (value === "human" || value === "agent") return value;
  throw new Error(`${label} must be "human" or "agent", got ${JSON.stringify(value)}`);
}

function decodeWriterIdentity(value: JsonValue, label: string): WriterIdentity {
  const obj = expectJsonObject(value, label);
  const writer: WriterIdentity = {
    id: requireString(obj, "id", label),
    type: decodeWriterType(obj["type"], `${label}.type`),
    displayName: requireString(obj, "displayName", label),
  };
  const email = optionalString(obj, "email", label);
  if (email !== undefined) writer.email = email;
  return writer;
}

function decodeProposalSection(value: JsonValue, label: string): ProposalSection {
  const obj = expectJsonObject(value, label);
  const section: ProposalSection = {
    doc_path: requireString(obj, "doc_path", label),
    heading_path: requireStringArray(obj["heading_path"], `${label}.heading_path`),
  };
  const justification = optionalString(obj, "justification", label);
  if (justification !== undefined) section.justification = justification;
  return section;
}

function decodeProposalSections(value: JsonValue, label: string): ProposalSection[] {
  if (!isJsonArray(value)) {
    throw new Error(`${label} must be an array, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => decodeProposalSection(element, `${label}[${index}]`));
}

function decodeDeletedSectionFileRef(value: JsonValue, label: string): DeletedSectionFileRef {
  const obj = expectJsonObject(value, label);
  return {
    doc_path: requireString(obj, "doc_path", label),
    section_file: requireString(obj, "section_file", label),
  };
}

/**
 * Decode the optional `deleted_section_files` id set (identity-based delete
 * detection). Absent on proposals written before the field existed → `[]`. A
 * PRESENT-but-malformed value throws (same strictness posture as `targets`).
 */
function decodeDeletedSectionFiles(obj: JsonObject, label: string): DeletedSectionFileRef[] {
  if (!("deleted_section_files" in obj)) return [];
  const value = obj["deleted_section_files"];
  if (!isJsonArray(value)) {
    throw new Error(`${label}.deleted_section_files must be an array, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) =>
    decodeDeletedSectionFileRef(element, `${label}.deleted_section_files[${index}]`),
  );
}

function decodeProposalTargetRef(value: JsonValue, label: string): ProposalTargetRef {
  const obj = expectJsonObject(value, label);
  const kind = obj["kind"];
  if (kind === "section") {
    return {
      kind: "section",
      doc_path: requireString(obj, "doc_path", label),
      heading_path: requireStringArray(obj["heading_path"], `${label}.heading_path`),
    };
  }
  if (kind === "document") {
    return {
      kind: "document",
      doc_path: requireString(obj, "doc_path", label),
    };
  }
  throw new Error(`${label}.kind must be "section" or "document", got ${JSON.stringify(kind)}`);
}

function decodeProposalTargets(value: JsonValue, label: string): ProposalTargetRef[] {
  if (!isJsonArray(value)) {
    throw new Error(`${label} must be an array, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => decodeProposalTargetRef(element, `${label}[${index}]`));
}

function decodeHumanInvolvementCommittedMetadata(
  value: JsonValue,
  label: string,
): HumanInvolvementCommittedProposalMetadata {
  const obj = expectJsonObject(value, label);
  const out: Record<string, number> = {};
  for (const key of Object.keys(obj)) {
    const entry = obj[key];
    if (typeof entry !== "number") {
      throw new Error(`${label}.${key} must be a number, got ${JSON.stringify(entry)}`);
    }
    out[key] = entry;
  }
  return out;
}

// ─── Base + per-status decoders ────────────────────────────────────────

function decodeProposalFileBase(obj: JsonObject, label: string, status: ProposalStatus): ProposalFileBase {
  const sections = decodeProposalSections(obj["sections"], `${label}.sections`);
  const missingTargets = !("targets" in obj);
  const base: ProposalFileBase = {
    id: requireString(obj, "id", label),
    writer: decodeWriterIdentity(obj["writer"], `${label}.writer`),
    intent: requireString(obj, "intent", label),
    sections,
    targets: missingTargets
      ? sectionsToTargets(sections)
      : decodeProposalTargets(obj["targets"], `${label}.targets`),
    deleted_section_files: decodeDeletedSectionFiles(obj, label),
    created_at: requireString(obj, "created_at", label),
  };
  if (status === "committed" && base.sections.length === 0 && base.targets.length === 0) {
    base.degraded = ["empty-committed"];
  } else if (missingTargets && !TERMINAL_PROPOSAL_STATUSES.has(status)) {
    base.degraded = ["missing-targets"];
  }
  const proposalAdoptionId = optionalString(obj, "proposalAdoptionId", label)
    ?? optionalString(obj, "docSessionId", label);
  if (proposalAdoptionId !== undefined) {
    base.proposalAdoptionId = ProposalAdoptionId.fromStoredValue(proposalAdoptionId);
  }
  // A legacy `agent_session_id` field (removed task 708 — MCP session identity is
  // transport state, never proposal persistence) is deliberately NOT decoded:
  // old files still read fine and the field is dropped at this boundary.
  return base;
}

/**
 * Decode an on-disk proposal `meta.json` into its domain object for the given
 * directory-discovered `status`. The committed/withdrawn terminal fields are only
 * required (and only read) for those statuses.
 */
export function decodeProposal(value: JsonValue, status: ProposalStatus): AnyProposal {
  const label = "proposal meta.json";
  const obj = expectJsonObject(value, label);
  const base = decodeProposalFileBase(obj, label, status);

  switch (status) {
    case "draft":
    case "pending":
    case "committing":
      // committing carries the previous proposal's metadata moved by directory
      // rename; landed-commit recovery metadata (committed_head) is read locally
      // by the recovery path, never folded into the normal domain object.
      return { ...base, status };
    case "inprogress":
      return { ...base, status };
    case "committed":
      return {
        ...base,
        committed_head: requireString(obj, "committed_head", label),
        humanInvolvement_at_commit: decodeHumanInvolvementCommittedMetadata(
          obj["humanInvolvement_at_commit"],
          `${label}.humanInvolvement_at_commit`,
        ),
        status,
      };
    case "withdrawn": {
      const reason = optionalString(obj, "withdrawal_reason", label);
      return reason !== undefined
        ? { ...base, status, withdrawal_reason: reason }
        : { ...base, status };
    }
  }
}

/**
 * Decode a proposal `meta.json` whose directory status is (or is being moved to)
 * `inprogress`. `inprogress` and `committing` files share the base proposal shape,
 * so this is used both for reading an inprogress proposal and for projecting a
 * committing file back to `inprogress` on rollback. Returns a fresh, precisely
 * typed `InProgressProposal`.
 */
export function decodeInProgressProposal(value: JsonValue): InProgressProposal {
  const label = "proposal meta.json";
  const obj = expectJsonObject(value, label);
  return { ...decodeProposalFileBase(obj, label, "inprogress"), status: "inprogress" };
}

/**
 * Recovery-only: read a landed-commit `committed_head` from a raw `committing`
 * `meta.json` JSON value, or `null` if absent/blank. This is a local check for
 * `finalizeCommittingProposal`; it intentionally does NOT validate the rest of
 * the file and does NOT appear on the normal proposal domain type.
 */
export function readLandedCommittedHead(value: JsonValue): string | null {
  const obj = expectJsonObject(value, "committing meta.json");
  if (!("committed_head" in obj)) return null;
  const head = obj["committed_head"];
  return typeof head === "string" && head.length > 0 ? head : null;
}

/** Decode an `id` field from a raw proposal JSON value (recovery/lookup helper). */
export function decodeProposalId(value: JsonValue): ProposalId {
  const obj = expectJsonObject(value, "proposal meta.json");
  return requireString(obj, "id", "proposal meta.json");
}
