/**
 * Human-readable admin guidance for proposal defects shown on the Proposals
 * triage banner. Codes remain the source of truth; this is operator copy only.
 */

export interface ProposalDefectGuidance {
  /** What the situation means. */
  explanation: string;
  /** What an admin should do next (rendered in italics). */
  suggestedFix: string;
}

const EMPTY_COMMITTED: ProposalDefectGuidance = {
  explanation:
    "This proposal is marked committed but claims nothing — its sections and targets " +
    "are both empty. That usually means a publish completed without recording what " +
    "changed (for example an older create-document path that finished as a no-op). " +
    "It is kept only as a corrupt audit marker so it cannot look like a healthy commit.",
  suggestedFix:
    "No autofix is available. Leave it quarantined if you want the audit trail, or " +
    "delete the on-disk directory shown on the left (under the data root) if you do " +
    "not need the record. Separately check whether the intended document (from the " +
    "intent) actually exists in the wiki — this marker does not create or remove it.",
};

const MISSING_TARGETS: ProposalDefectGuidance = {
  explanation:
    "This is a legacy proposal written before the authoritative targets field existed. " +
    "Targets were reconstructed from sections on read, which can miss document-level " +
    "claims, so the proposal is quarantined until targets are re-derived and saved.",
  suggestedFix:
    "Use Autofix missing-targets on this card. That re-derives targets from the " +
    "current sections and clears the quarantine so lock/commit can proceed.",
};

const UNDECODEABLE_INVALID_DOC_PATH: ProposalDefectGuidance = {
  explanation:
    "The proposal meta.json could not be decoded because at least one document path " +
    "is unlawful (paths must be rooted, end in .md, and must not traverse or use " +
    "empty segments). Until the meta is readable, the proposal cannot be opened or " +
    "acted on through normal APIs.",
  suggestedFix:
    "Open meta.json inside the on-disk directory shown on the left. Fix or remove " +
    "the bad doc_path values, or delete that directory if it is disposable. After a " +
    "valid meta exists, reload Proposals — it should appear as a normal or degraded row.",
};

const UNDECODEABLE_GENERIC: ProposalDefectGuidance = {
  explanation:
    "The proposal meta.json failed strict decode, so the server reported it as " +
    "undecodable instead of crashing the proposals list. Identity and claims from " +
    "this file are not trusted until the meta can be read cleanly.",
  suggestedFix:
    "Open meta.json in the on-disk directory shown on the left and compare the " +
    "defect message with the file contents. Repair the JSON shape, or remove that " +
    "directory if the proposal is disposable junk from an older build.",
};

const UNKNOWN_DEFECT: ProposalDefectGuidance = {
  explanation:
    "This proposal carries a degraded marker the UI does not have a dedicated " +
    "explanation for yet. It was read leniently so admins can see it, but normal " +
    "lock/commit transitions remain blocked while the marker is present.",
  suggestedFix:
    "Open the proposal detail page for the raw defect code, check server logs, and " +
    "repair or remove the on-disk meta if you recognise the failure mode.",
};

/** Guidance for a decoded proposal’s degraded defect codes (first match wins). */
export function guidanceForDegradedDefects(defects: readonly string[]): ProposalDefectGuidance {
  if (defects.includes("empty-committed")) return EMPTY_COMMITTED;
  if (defects.includes("missing-targets")) return MISSING_TARGETS;
  return UNKNOWN_DEFECT;
}

/** Guidance for an undecodable proposal, keyed off the server defect message. */
export function guidanceForUndecodableDefect(defect: string): ProposalDefectGuidance {
  if (/invalid document path/i.test(defect)) return UNDECODEABLE_INVALID_DOC_PATH;
  return {
    ...UNDECODEABLE_GENERIC,
    explanation: `${UNDECODEABLE_GENERIC.explanation} Decoder said: ${defect}`,
  };
}
