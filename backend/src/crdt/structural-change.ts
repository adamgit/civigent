/**
 * Structural-change classifier (WS-1) — the PURE parse-and-classify half of
 * structural normalization.
 *
 * Given a live fragment's CURRENT markdown (heading line + body, or body-only
 * for the before-first-heading/root section) and the AUTHORITATIVE section
 * identity that fragment is supposed to carry (heading text + level, resolved
 * from the proposal/canonical skeleton), this module decides WHAT structural
 * change the author's edits introduced. It NEVER mutates anything — it returns a
 * typed {@link StructuralChange} that the identity-preserving live appliers
 * (WS-2) and the proposal reflection (WS-3) consume.
 *
 * The case set and dispatch are ported verbatim from the old
 * `FragmentStore.normalizeStructure` dispatch + `isStructurallyClean`
 * (recoverable via `git show a866723:backend/src/crdt/fragment-store.ts`), but
 * the appliers that used to live alongside it (and clobbered Yjs struct identity
 * by clear+recreate) are deliberately NOT here — the new appliers mutate the
 * surviving Y.XmlFragment in place.
 *
 * REUSE FROM CRDT INGRESS VALIDATION: `classifyStructuralChange(...)` is also
 * the sole classifier for the CRDT live-edit acceptance gate's structural
 * validators (split / rename / level-change / heading-deletion / relocation
 * shapes). Ingress validators wrap this classifier with additional checks
 * (e.g. duplicate-sibling-heading rejection) but must not fork the classifier
 * itself, mutate Y.Doc or proposal state through it, or bleed
 * quiescence-normalization decisions into ingress rejection.
 */

import { parseDocumentMarkdown, type ParsedSection } from "../storage/markdown-sections.js";
import { headingsEqual } from "../storage/document-skeleton.js";
import { bodyFromStructuralAssembly, type FragmentContent, type SectionBody } from "../storage/section-formatting.js";

/** The authoritative identity a live fragment is supposed to carry. */
export interface AuthoritativeSectionIdentity {
  /** Heading path of this section; empty for the before-first-heading/root. */
  headingPath: readonly string[];
  /** Leaf heading text; "" for the before-first-heading/root. */
  heading: string;
  /** Heading level; 0 for the before-first-heading/root. */
  level: number;
}

/**
 * One resulting (sub)section the author embedded inside the fragment, carried so
 * an applier can seed a new live fragment / reflect a new proposal section.
 * `headingPath` is RELATIVE to the fragment's own section (as the parser emits
 * it), i.e. the same shape the proposal-side rewrite consumes.
 */
export interface SubsectionDescriptor {
  headingPath: string[];
  heading: string;
  level: number;
  body: SectionBody;
}

/**
 * The classified structural change. `clean` = no normalization needed. The
 * remaining variants each carry exactly the data their WS-2 applier + WS-3
 * proposal reflection need.
 */
export type StructuralChange =
  | { kind: "clean" }
  /**
   * The root / before-first-heading fragment now contains one or more real
   * headings the author typed. The surviving root keeps `rootBody` (the content
   * before the first heading); each entry in `sections` splits out into a new
   * fragment / proposal section.
   */
  | { kind: "root-split"; rootBody: SectionBody; sections: SubsectionDescriptor[] }
  /**
   * A non-root fragment now contains TWO OR MORE headings. The first heading is
   * the surviving section (kept fragment); the rest split out into new
   * fragments / proposal sections.
   */
  | { kind: "section-split"; sections: SubsectionDescriptor[] }
  /** The single heading's TEXT changed (same level) — rename in place. */
  | { kind: "heading-rename"; newHeading: string; level: number }
  /** The single heading's LEVEL changed (text may also differ) — re-level in place. */
  | { kind: "heading-level-change"; newHeading: string; newLevel: number }
  /**
   * The matching heading is present but orphan content appeared BEFORE it. The
   * applier moves the heading to the front and appends the orphan preamble onto
   * the body (no content lost). `combinedBody` is body-then-preamble.
   */
  | { kind: "heading-relocated"; heading: string; level: number; combinedBody: SectionBody }
  /**
   * The heading was deleted — the fragment now holds only orphan body with no
   * heading. The applier merges `orphanedBody` onto the preceding section and
   * removes this fragment.
   */
  | { kind: "heading-deletion"; orphanedBody: SectionBody };

function trimTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

function toDescriptor(section: ParsedSection): SubsectionDescriptor {
  return {
    headingPath: [...section.headingPath],
    heading: section.heading,
    level: section.level,
    body: bodyFromStructuralAssembly(section.body),
  };
}

export function liveFragmentLeadingHeadingMatchesIdentity(
  fragment: FragmentContent,
  identity: Pick<AuthoritativeSectionIdentity, "heading" | "level">,
): boolean {
  if (identity.level === 0) return true;
  const firstLine = fragment.split("\n")[0] ?? "";
  const prefix = `${"#".repeat(identity.level)} `;
  if (!firstLine.startsWith(prefix)) return false;
  return headingsEqual(firstLine.slice(prefix.length), identity.heading);
}

/**
 * Is the fragment already in its canonical structural form for `identity`?
 * Ported from `FragmentStore.isStructurallyClean` (`a866723:...:804`).
 *
 *  - Root/BFH: clean iff no real heading was typed inside it.
 *  - Non-root: clean iff EXACTLY one parsed section (no orphan preamble before
 *    the heading) whose heading text + level match the authoritative identity.
 */
export function isStructurallyClean(
  parsed: readonly ParsedSection[],
  identity: AuthoritativeSectionIdentity,
): boolean {
  const isRoot = identity.headingPath.length === 0;
  const realSections = parsed.filter((s) => s.headingPath.length > 0);
  if (isRoot) {
    return realSections.length === 0;
  }
  if (parsed.length !== 1 || realSections.length !== 1) return false;
  return headingsEqual(realSections[0].heading, identity.heading) && realSections[0].level === identity.level;
}

/**
 * Classify the structural change the author introduced into `fragmentMarkdown`
 * relative to `identity`. Pure: parses, compares, returns a typed change. The
 * dispatch order is the old `normalizeStructure` dispatch (`a866723:...:449`).
 */
export function classifyStructuralChange(
  fragmentMarkdown: FragmentContent,
  identity: AuthoritativeSectionIdentity,
): StructuralChange {
  const parsed = parseDocumentMarkdown(fragmentMarkdown);
  const realSections = parsed.filter((s) => s.headingPath.length > 0);
  const isRoot = identity.headingPath.length === 0;

  if (isStructurallyClean(parsed, identity)) {
    return { kind: "clean" };
  }

  // Root split: heading(s) typed inside the root / before-first-heading section.
  if (isRoot && realSections.length > 0) {
    const rootParsed = parsed.find((s) => s.headingPath.length === 0);
    const rootBody = bodyFromStructuralAssembly(rootParsed?.body ?? "");
    return { kind: "root-split", rootBody, sections: realSections.map(toDescriptor) };
  }

  if (!isRoot && realSections.length === 1) {
    const section = realSections[0];
    // Heading rename (same level, different text).
    if (!headingsEqual(section.heading, identity.heading) && section.level === identity.level) {
      return { kind: "heading-rename", newHeading: section.heading, level: section.level };
    }
    // Heading level change (may also include a rename).
    if (section.level !== identity.level) {
      return { kind: "heading-level-change", newHeading: section.heading, newLevel: section.level };
    }
    // Heading relocated: matching heading, but orphan content appeared before it.
    if (parsed.length > 1) {
      const preamble = trimTrailingNewlines(
        parsed
          .filter((s) => s.headingPath.length === 0)
          .map((s) => s.body)
          .join("\n"),
      );
      const body = trimTrailingNewlines(section.body);
      const combinedBody = bodyFromStructuralAssembly(
        body
          ? preamble
            ? `${body}\n\n${preamble}`
            : body
          : preamble,
      );
      return { kind: "heading-relocated", heading: section.heading, level: section.level, combinedBody };
    }
  }

  // Section split: a non-root fragment now contains two or more headings.
  if (!isRoot && realSections.length >= 2) {
    return { kind: "section-split", sections: realSections.map(toDescriptor) };
  }

  // Heading deletion: a non-root fragment now holds only orphan body, no heading.
  // Option A: a sub-skeleton parent's body-holder now carries the PARENT's headed
  // identity (heading=Parent/level=N — never the old `{heading:"",level:0,path>0}`
  // shape), so a clean body-holder takes the headed-section `clean` path above and
  // CANNOT reach this branch. This branch is therefore only ever a genuine heading
  // deletion (→ merge into the predecessor), as intended.
  if (!isRoot && realSections.length === 0) {
    const orphanedBody = bodyFromStructuralAssembly(
      parsed
        .filter((s) => s.headingPath.length === 0)
        .map((s) => s.body)
        .join("\n"),
    );
    return { kind: "heading-deletion", orphanedBody };
  }

  // Unrecognized pattern — treat as a no-op for safety (old dispatch fallback).
  return { kind: "clean" };
}
