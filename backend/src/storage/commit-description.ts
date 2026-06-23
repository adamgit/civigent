/**
 * Commit-description synthesis (spec 10 §15 "Commit-description synthesis").
 *
 * When an automatic publish succeeds, the audit-log description is synthesized
 * AT PUBLISH TIME from the proposal's FINAL changed section-set (and any inferred
 * narrative) — never guessed from early raw activity.
 *
 * A preferred narrative (e.g. an LLM-backed classifier producing one of the spec
 * "description families") is optional. When no confident narrative is available
 * (the provider returns null), the fallback is still HONEST and CONSERVATIVE:
 * it names the touched sections and the kind of structural operations observed,
 * derived purely from the changed set. Description failure must never justify
 * exposing uncommitted state or rewriting history later — so this function always
 * returns a usable, truthful string and never throws on the no-narrative path.
 */

/** The structural-operation kinds the conservative fallback can name. */
export type StructuralOpKind = "split" | "merge" | "rename" | "level-change" | "move";

export interface CommitDescriptionInput {
  /**
   * The proposal's FINAL changed section-set (heading paths; `[]` is the
   * before-first-heading / document preamble). This is the authoritative input —
   * the description is derived from it, not from early activity.
   */
  changedSections: ReadonlyArray<{ headingPath: readonly string[] }>;
  /** Structural operations observed during the session (optional). */
  structuralOps?: ReadonlyArray<StructuralOpKind>;
  /**
   * Optional preferred-narrative synthesizer (a spec "description family"
   * classifier). Returns a confident narrative string, or `null` when no
   * confident narrative is available (synthesis "fails"). When it returns null,
   * the conservative fallback is used. Its own internal failures are its own
   * responsibility — it must return null rather than throwing for "no narrative".
   */
  preferredNarrative?: () => string | null;
}

/** Human-readable label for one changed section. */
function sectionLabel(headingPath: readonly string[]): string {
  if (headingPath.length === 0) return "the document preamble";
  return headingPath.join(" › ");
}

/** Dedupe preserving first-seen order. */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

const OP_NOUNS: Record<StructuralOpKind, string> = {
  split: "section splits",
  merge: "section merges",
  rename: "heading renames",
  "level-change": "heading level changes",
  move: "section moves",
};

/** Humanize a set of structural ops into a comma/and-joined noun phrase. */
function humanizeOps(ops: readonly StructuralOpKind[]): string {
  const nouns = dedupe(ops.map((op) => OP_NOUNS[op]));
  if (nouns.length === 0) return "";
  if (nouns.length === 1) return nouns[0]!;
  if (nouns.length === 2) return `${nouns[0]} and ${nouns[1]}`;
  return `${nouns.slice(0, -1).join(", ")}, and ${nouns[nouns.length - 1]}`;
}

/** Join section labels into a readable phrase. */
function joinSections(labels: readonly string[]): string {
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * Synthesize the commit/audit-log description. Returns the preferred narrative
 * when one is available; otherwise an honest, conservative description derived
 * from the final changed section-set and observed structural operations.
 */
export function synthesizeCommitDescription(input: CommitDescriptionInput): string {
  if (input.preferredNarrative) {
    const narrative = input.preferredNarrative();
    if (narrative !== null && narrative.trim().length > 0) {
      return narrative.trim();
    }
  }

  const ops = input.structuralOps ?? [];
  const sections = input.changedSections;

  if (sections.length === 0) {
    return ops.length > 0
      ? `Document-level change including ${humanizeOps(ops)}`
      : "Document-level change with no section content edits";
  }

  const labels = dedupe(sections.map((s) => sectionLabel(s.headingPath)));
  const subtree = labels.length === 1 ? labels[0]! : `${labels.length} sections (${joinSections(labels)})`;

  if (ops.length > 0) {
    return `Reorganize ${subtree}, including ${humanizeOps(ops)}`;
  }
  return `Update ${subtree}`;
}
