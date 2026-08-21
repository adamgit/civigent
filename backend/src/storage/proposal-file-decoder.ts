/** Decodes an on-disk proposal `meta.json` into a typed domain object. */
import {
  DocPath,
  expectJsonObject,
  ProposalAdoptionId,
  sectionsToTargets,
  TERMINAL_PROPOSAL_STATUSES,
  type JsonObject,
  type JsonValue,
} from "../types/shared.js";
import type {
  ActiveProposal,
  ActiveProposalStatus,
  AnyProposal,
  DeletedSectionFileRef,
  HumanInvolvementCommittedProposalMetadata,
  InProgressProposal,
  ProposalFileBase,
  ProposalFileIdentityFields,
  ProposalId,
  ProposalSectionClaim,
  ProposalStatus,
  ProposalTargetRef,
  StoredHistoryDeletedSectionFileRef,
  StoredHistoryProposalFileBase,
  StoredHistoryProposalSection,
  StoredHistoryProposalTargetRef,
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

function requireDocPath(obj: JsonObject, key: string, label: string): DocPath {
  return DocPath.parse(requireString(obj, key, label));
}

function decodeProposalSection(value: JsonValue, label: string): ProposalSectionClaim {
  const obj = expectJsonObject(value, label);
  const section: ProposalSectionClaim = {
    doc_path: requireDocPath(obj, "doc_path", label),
    heading_path: requireStringArray(obj["heading_path"], `${label}.heading_path`),
  };
  const justification = optionalString(obj, "justification", label);
  if (justification !== undefined) section.justification = justification;
  return section;
}

function decodeProposalSections(value: JsonValue, label: string): ProposalSectionClaim[] {
  if (!isJsonArray(value)) {
    throw new Error(`${label} must be an array, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => decodeProposalSection(element, `${label}[${index}]`));
}

function decodeDeletedSectionFileRef(value: JsonValue, label: string): DeletedSectionFileRef {
  const obj = expectJsonObject(value, label);
  return {
    doc_path: requireDocPath(obj, "doc_path", label),
    section_file: requireString(obj, "section_file", label),
  };
}

function decodeStoredHistoryProposalSection(value: JsonValue, label: string): StoredHistoryProposalSection {
  const obj = expectJsonObject(value, label);
  const section: StoredHistoryProposalSection = {
    stored_doc_path: requireString(obj, "doc_path", label),
    heading_path: requireStringArray(obj["heading_path"], `${label}.heading_path`),
  };
  const justification = optionalString(obj, "justification", label);
  if (justification !== undefined) section.justification = justification;
  return section;
}

function decodeStoredHistoryProposalSections(value: JsonValue, label: string): StoredHistoryProposalSection[] {
  if (!isJsonArray(value)) {
    throw new Error(`${label} must be an array, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => decodeStoredHistoryProposalSection(element, `${label}[${index}]`));
}

function decodeStoredHistoryProposalTargetRef(value: JsonValue, label: string): StoredHistoryProposalTargetRef {
  const obj = expectJsonObject(value, label);
  const kind = obj["kind"];
  if (kind === "section") {
    return {
      kind: "section",
      stored_doc_path: requireString(obj, "doc_path", label),
      heading_path: requireStringArray(obj["heading_path"], `${label}.heading_path`),
    };
  }
  if (kind === "document") {
    return {
      kind: "document",
      stored_doc_path: requireString(obj, "doc_path", label),
    };
  }
  throw new Error(`${label}.kind must be "section" or "document", got ${JSON.stringify(kind)}`);
}

function decodeStoredHistoryProposalTargets(value: JsonValue, label: string): StoredHistoryProposalTargetRef[] {
  if (!isJsonArray(value)) {
    throw new Error(`${label} must be an array, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => decodeStoredHistoryProposalTargetRef(element, `${label}[${index}]`));
}

function decodeStoredHistoryDeletedSectionFiles(obj: JsonObject, label: string): StoredHistoryDeletedSectionFileRef[] {
  if (!("deleted_section_files" in obj)) return [];
  const value = obj["deleted_section_files"];
  if (!isJsonArray(value)) {
    throw new Error(`${label}.deleted_section_files must be an array, got ${JSON.stringify(value)}`);
  }
  return value.map((element, index) => {
    const entry = expectJsonObject(element, `${label}.deleted_section_files[${index}]`);
    return {
      stored_doc_path: requireString(entry, "doc_path", `${label}.deleted_section_files[${index}]`),
      section_file: requireString(entry, "section_file", `${label}.deleted_section_files[${index}]`),
    };
  });
}

function sectionsToStoredHistoryTargets(
  sections: StoredHistoryProposalSection[],
): StoredHistoryProposalTargetRef[] {
  return sections.map((section) => ({
    kind: "section",
    stored_doc_path: section.stored_doc_path,
    heading_path: [...section.heading_path],
  }));
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
      doc_path: requireDocPath(obj, "doc_path", label),
      heading_path: requireStringArray(obj["heading_path"], `${label}.heading_path`),
    };
  }
  if (kind === "document") {
    return {
      kind: "document",
      doc_path: requireDocPath(obj, "doc_path", label),
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

function decodeProposalFileIdentityFields(obj: JsonObject, label: string): ProposalFileIdentityFields {
  const identity: ProposalFileIdentityFields = {
    id: requireString(obj, "id", label),
    writer: decodeWriterIdentity(obj["writer"], `${label}.writer`),
    intent: requireString(obj, "intent", label),
    created_at: requireString(obj, "created_at", label),
  };
  const proposalAdoptionId = optionalString(obj, "proposalAdoptionId", label)
    ?? optionalString(obj, "docSessionId", label);
  if (proposalAdoptionId !== undefined) {
    identity.proposalAdoptionId = ProposalAdoptionId.fromStoredValue(proposalAdoptionId);
  }
  // A legacy `agent_session_id` field (removed task 708 — MCP session identity is
  // transport state, never proposal persistence) is deliberately NOT decoded:
  // old files still read fine and the field is dropped at this boundary.
  return identity;
}

function decodeProposalFileBase(obj: JsonObject, label: string, status: ProposalStatus): ProposalFileBase {
  const sections = decodeProposalSections(obj["sections"], `${label}.sections`);
  const missingTargets = !("targets" in obj);
  const base: ProposalFileBase = {
    ...decodeProposalFileIdentityFields(obj, label),
    sections,
    targets: missingTargets
      ? sectionsToTargets(sections)
      : decodeProposalTargets(obj["targets"], `${label}.targets`),
    deleted_section_files: decodeDeletedSectionFiles(obj, label),
  };
  if (missingTargets && !TERMINAL_PROPOSAL_STATUSES.has(status)) {
    base.degraded = ["missing-targets"];
  }
  return base;
}

function decodeStoredHistoryProposalFileBase(obj: JsonObject, label: string, status: ProposalStatus): StoredHistoryProposalFileBase {
  const sections = decodeStoredHistoryProposalSections(obj["sections"], `${label}.sections`);
  const missingTargets = !("targets" in obj);
  const base: StoredHistoryProposalFileBase = {
    ...decodeProposalFileIdentityFields(obj, label),
    sections,
    targets: missingTargets
      ? sectionsToStoredHistoryTargets(sections)
      : decodeStoredHistoryProposalTargets(obj["targets"], `${label}.targets`),
    deleted_section_files: decodeStoredHistoryDeletedSectionFiles(obj, label),
  };
  if (status === "committed" && base.sections.length === 0 && base.targets.length === 0) {
    base.degraded = ["empty-committed"];
  }
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

  switch (status) {
    case "draft":
    case "pending":
    case "committing":
      // committing carries the previous proposal's metadata moved by directory
      // rename; landed-commit recovery metadata (committed_head) is read locally
      // by the recovery path, never folded into the normal domain object.
      return { ...decodeProposalFileBase(obj, label, status), status };
    case "inprogress":
      return { ...decodeProposalFileBase(obj, label, status), status };
    case "committed":
      return {
        ...decodeStoredHistoryProposalFileBase(obj, label, status),
        committed_head: requireString(obj, "committed_head", label),
        humanInvolvement_at_commit: decodeHumanInvolvementCommittedMetadata(
          obj["humanInvolvement_at_commit"],
          `${label}.humanInvolvement_at_commit`,
        ),
        status,
      };
    case "withdrawn": {
      const base = decodeStoredHistoryProposalFileBase(obj, label, status);
      const reason = optionalString(obj, "withdrawal_reason", label);
      return reason !== undefined
        ? { ...base, status, withdrawal_reason: reason }
        : { ...base, status };
    }
  }
}

export function decodeActiveProposal(value: JsonValue, status: ActiveProposalStatus): ActiveProposal {
  const label = "proposal meta.json";
  const obj = expectJsonObject(value, label);
  const base = decodeProposalFileBase(obj, label, status);
  return status === "inprogress" ? { ...base, status } : { ...base, status };
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

function collectRawDocPathsFromClaimArray(
  value: JsonValue | undefined,
  out: string[],
): boolean {
  if (value === undefined) return true;
  if (!isJsonArray(value)) return false;
  for (const element of value) {
    try {
      const obj = expectJsonObject(element, "proposal claim entry");
      const docPath = obj["doc_path"];
      if (typeof docPath === "string") out.push(docPath);
    } catch {
      return false;
    }
  }
  return true;
}

export function rawClaimedDocPathsFromProposalJson(value: JsonValue): string[] | null {
  let obj: JsonObject;
  try {
    obj = expectJsonObject(value, "proposal meta.json");
  } catch {
    return null;
  }
  const out: string[] = [];
  if (!collectRawDocPathsFromClaimArray(obj["sections"], out)) return null;
  if (!collectRawDocPathsFromClaimArray(obj["targets"], out)) return null;
  if (!collectRawDocPathsFromClaimArray(obj["deleted_section_files"], out)) return null;
  return out;
}

function rawDocPathClaimsAnyOf(raw: string, docPaths: readonly DocPath[]): boolean {
  for (const docPath of docPaths) {
    if (raw === docPath) return true;
    if (DocPath.coerce(raw) === docPath) return true;
  }
  return false;
}

export function proposalJsonClaimsAnyDoc(
  value: JsonValue,
  docPaths: readonly DocPath[],
): boolean | null {
  const rawPaths = rawClaimedDocPathsFromProposalJson(value);
  if (rawPaths === null) return null;
  return rawPaths.some((raw) => rawDocPathClaimsAnyOf(raw, docPaths));
}

export function proposalJsonWriterId(value: JsonValue): string | null {
  try {
    const obj = expectJsonObject(value, "proposal meta.json");
    const writer = expectJsonObject(obj["writer"], "proposal meta.json.writer");
    const id = writer["id"];
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

export function proposalJsonAdoptionId(value: JsonValue): string | null {
  try {
    const obj = expectJsonObject(value, "proposal meta.json");
    const adoptionId = obj["proposalAdoptionId"] ?? obj["docSessionId"];
    return typeof adoptionId === "string" ? adoptionId : null;
  } catch {
    return null;
  }
}

export function proposalJsonIdOrNull(value: JsonValue): string | null {
  try {
    const obj = expectJsonObject(value, "proposal meta.json");
    const id = obj["id"];
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}
