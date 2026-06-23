// ─── Branded types ──────────────────────────────────────────────────
//
// SectionBody: body-only content (no heading line), no guaranteed trailing \n.
// FragmentContent: heading+body content (or body-only for BFH), no guaranteed trailing \n.
// Both are plain strings at runtime; the brands exist only at compile time to
// prevent accidental mixing of "body" and "fragment" strings.

declare const __sectionBody: unique symbol;
declare const __fragmentContent: unique symbol;
declare const __sectionBodyWithSubsections: unique symbol;

/** Body-only markdown (heading stripped). In-memory representation. */
export type SectionBody = string & { readonly [__sectionBody]: true };

/** Full fragment markdown (heading + body, or body-only for BFH). In-memory representation. */
export type FragmentContent = string & { readonly [__fragmentContent]: true };

/**
 * Parser-driven section write INPUT: markdown that may be a plain body OR may
 * contain embedded headings/subsections (which the parser-driven upsert path
 * expands into real sections). Deliberately distinct from {@link SectionBody}
 * (embedded headings are legal here) and from plain `string` (so future editors
 * do not mistake it for already-classified body-only content).
 */
export type SectionBodyWithPotentialSubsections = string & { readonly [__sectionBodyWithSubsections]: true };

// ─── Brand boundary (the ONLY place that mints or unwraps the brands) ──
//
// `mintSectionBody` / `mintFragmentContent` are the sole minting assertions in
// the codebase: string → brand. The reverse (brand → string) needs no assertion
// because a branded string is a structural subtype of `string`; `sectionBodyText`
// / `fragmentContentText` name that widening so call sites read intentionally.
// Keeping every brand assertion in these four functions makes the boundary
// auditable in one place — consumers use the named boundary/conversion functions
// below, never a raw `as SectionBody` / `as FragmentContent` / `as string`.

function mintSectionBody(raw: string): SectionBody {
  return raw as SectionBody;
}

function mintFragmentContent(raw: string): FragmentContent {
  return raw as FragmentContent;
}

function mintSectionWriteInput(raw: string): SectionBodyWithPotentialSubsections {
  return raw as SectionBodyWithPotentialSubsections;
}

/**
 * External/API boundary: raw request/tool markdown entering the parser-driven
 * section write path (`writeSection`/`createSection`/`upsertSection`). The
 * content is NOT trimmed/normalized here — the parser owns structural expansion.
 */
export function sectionWriteInputFromExternal(raw: string): SectionBodyWithPotentialSubsections {
  return mintSectionWriteInput(raw);
}

/**
 * Body-only content that must nonetheless go through the parser-driven section
 * write path (e.g. CRDT materialization supplying an already-classified body).
 * A `SectionBody` is runtime-identical markdown, so this is a pure brand crossing.
 */
export function sectionWriteInputFromBody(body: SectionBody): SectionBodyWithPotentialSubsections {
  return mintSectionWriteInput(sectionBodyText(body));
}

/** Widen a SectionBody to its underlying string (no assertion — brand is a subtype). */
function sectionBodyText(body: SectionBody): string {
  return body;
}

/** Widen a FragmentContent to its underlying string (no assertion — brand is a subtype). */
function fragmentContentText(fragment: FragmentContent): string {
  return fragment;
}

function trimTrailing(raw: string): string {
  return raw.replace(/\n+$/, "");
}

// ─── Boundary functions ─────────────────────────────────────────────
//
// Each boundary function marks the crossing point where a raw string enters
// the typed domain. The trim/normalization inside each function documents
// exactly what contract that crossing enforces.

/** Disk body file → SectionBody. Strips the POSIX trailing \n that writeBodyFile adds. */
export function bodyFromDisk(raw: string): SectionBody {
  return mintSectionBody(trimTrailing(raw));
}

/** SectionBody → disk format. Ensures exactly one trailing \n (POSIX text file). */
export function bodyToDisk(body: SectionBody): string {
  const trimmed = trimTrailing(sectionBodyText(body));
  return trimmed ? trimmed + "\n" : "\n";
}

/** Git blob content → SectionBody. Git blobs include trailing \n; strip it. */
export function bodyFromGit(raw: string): SectionBody {
  return mintSectionBody(trimTrailing(raw));
}

/** remark/milkdown serializer output → SectionBody. jsonToMarkdown output may have trailing \n. */
export function bodyFromRemark(raw: string): SectionBody {
  return mintSectionBody(trimTrailing(raw));
}

/** CommonMark parser (markdown-sections.ts) output → SectionBody. Parser already trims. */
export function bodyFromParser(raw: string): SectionBody {
  return mintSectionBody(trimTrailing(raw));
}

/** Recovery/diagnostic assembly output → SectionBody. */
export function bodyFromRecoveryAssembly(raw: string): SectionBody {
  return mintSectionBody(trimTrailing(raw));
}

/** remark/milkdown serializer output → FragmentContent. */
export function fragmentFromRemark(raw: string): FragmentContent {
  return mintFragmentContent(trimTrailing(raw));
}

/** Disk fragment file → FragmentContent. */
export function fragmentFromDisk(raw: string): FragmentContent {
  return mintFragmentContent(trimTrailing(raw));
}

/** FragmentContent → disk format. Ensures trailing \n. */
export function fragmentToDisk(fragment: FragmentContent): string {
  const trimmed = trimTrailing(fragmentContentText(fragment));
  return trimmed ? trimmed + "\n" : "\n";
}

/** CommonMark parser output → FragmentContent (heading + body). */
export function fragmentFromParser(raw: string): FragmentContent {
  return mintFragmentContent(trimTrailing(raw));
}

/** External/API content entering the branded domain → FragmentContent. */
export function fragmentFromExternalContent(raw: string): FragmentContent {
  return mintFragmentContent(trimTrailing(raw));
}

// ─── BFH identity + empty helpers ──────────────────────────────────
//
// BFH (before-first-heading) sections have no heading line, so their body
// and fragment representations are identical. `fragmentFromBodyHolder` names
// that conversion instead of scattering `as unknown as` casts through the
// codebase.

/** Empty section body (typed constant). */
export const EMPTY_BODY: SectionBody = mintSectionBody("");

/** Empty fragment content (typed constant). */
export const EMPTY_FRAGMENT: FragmentContent = mintFragmentContent("");

/**
 * Body-holder (BFH) identity: a section with no heading line has a fragment
 * representation that is runtime-identical to its body, so a `SectionBody`
 * crosses to `FragmentContent` unchanged. This is the one named conversion for
 * that crossing.
 */
export function fragmentFromBodyHolder(body: SectionBody): FragmentContent {
  return mintFragmentContent(sectionBodyText(body));
}

/** Strip leading newlines from a SectionBody without breaking the brand. */
export function stripLeadingNewlines(body: SectionBody): SectionBody {
  return mintSectionBody(sectionBodyText(body).replace(/^\n+/, ""));
}

// ─── CRDT structural-normalization boundaries ──────────────────────
//
// Markdown assembled inside CRDT structural normalization (root splits, heading
// relocations/deletions, orphan merges) crosses into the branded domain through
// these helpers. They own the trim/normalization (strip false parser-added
// trailing newlines — identical to the previous inline `raw.replace(/\n+$/, "")`)
// and the unavoidable brand minting, so consumers never inline `as SectionBody`
// / `as FragmentContent` / `as string` for these flows.

/** Markdown assembled during CRDT structural normalization → SectionBody. */
export function bodyFromStructuralAssembly(raw: string): SectionBody {
  return mintSectionBody(trimTrailing(raw));
}

/** Markdown assembled during CRDT structural normalization → FragmentContent. */
export function fragmentFromStructuralAssembly(raw: string): FragmentContent {
  return mintFragmentContent(trimTrailing(raw));
}

/**
 * Append an orphaned section body onto a predecessor fragment during a
 * heading-deletion merge (the orphan's heading was removed; its body folds into
 * the section before it). Empty orphan → the predecessor fragment is returned
 * unchanged; empty predecessor → the body becomes the fragment (body-holder
 * identity); otherwise the predecessor body is joined to the orphan with a blank
 * line, scrubbing the predecessor's trailing newlines. Replaces inline
 * `… as FragmentContent` assembly in the CRDT mergers.
 */
export function appendBodyToFragment(fragment: FragmentContent, body: SectionBody): FragmentContent {
  if (sectionBodyText(body).length === 0) return fragment;
  if (fragmentContentText(fragment).trim().length === 0) return fragmentFromBodyHolder(body);
  return fragmentFromStructuralAssembly(
    `${fragmentContentText(fragment).replace(/\n+$/, "")}\n\n${sectionBodyText(body)}`,
  );
}

// ─── Conversion / combining functions ───────────────────────────────

import { isBodyHolderShape } from "./section-shape.js";

/**
 * Build a full fragment (heading + body) from a body and heading info.
 * Body-holder-shape inputs (level=0, heading="") return the body as-is —
 * the heading line is suppressed because the caller is asking for an
 * anonymous content fragment.
 */
export function buildFragmentContent(body: SectionBody, level: number, heading: string): FragmentContent {
  if (isBodyHolderShape({ level, heading })) return fragmentFromBodyHolder(body);
  const headingLine = `${"#".repeat(level)} ${heading}`;
  const bodyStr = sectionBodyText(body);
  return mintFragmentContent(bodyStr.trim() ? `${headingLine}\n\n${bodyStr}` : headingLine);
}

/**
 * Strip the heading line from a fragment, returning just the body.
 * If no heading line matches the expected level, returns the full content as body.
 */
export function stripHeadingFromFragment(markdown: FragmentContent, level: number): SectionBody {
  const headingPrefix = "#".repeat(level) + " ";
  const lines = fragmentContentText(markdown).split("\n");
  if (lines.length > 0 && lines[0].startsWith(headingPrefix)) {
    let startIdx = 1;
    while (startIdx < lines.length && lines[startIdx].trim() === "") {
      startIdx++;
    }
    return mintSectionBody(trimTrailing(lines.slice(startIdx).join("\n")));
  }
  return mintSectionBody(trimTrailing(fragmentContentText(markdown)));
}

/**
 * Strip the leading ATX heading line (any level 1–6) and the blank lines that
 * follow it from a fragment, returning the remaining body. Unlike
 * {@link stripHeadingFromFragment} this does not require the heading level — it
 * is used where a live fragment may carry a wrong-level heading that must be
 * removed before the body is re-derived. This is the approved boundary for that
 * crossing (it mints the `SectionBody`).
 */
export function bodyFromFragmentStrippingLeadingHeading(fragment: FragmentContent): SectionBody {
  const lines = fragmentContentText(fragment).split("\n");
  if (lines.length > 0 && /^#{1,6}\s/.test(lines[0])) {
    let start = 1;
    while (start < lines.length && lines[start].trim() === "") start += 1;
    return mintSectionBody(trimTrailing(lines.slice(start).join("\n")));
  }
  return mintSectionBody(trimTrailing(fragmentContentText(fragment)));
}

/**
 * Merge an orphaned fragment's body into an existing fragment.
 * Used during orphan collection when a raw fragment needs to be folded
 * into the canonical content.
 */
export function mergeOrphanIntoFragment(orphanBody: SectionBody, level: number, heading: string): FragmentContent {
  return buildFragmentContent(orphanBody, level, heading);
}

/**
 * Join fragments into final assembled document text.
 * This is the single place that decides how fragments compose.
 * Returns plain string — the assembled document is an output boundary.
 *
 * Uses "\n\n" separator: each fragment is a self-contained block (heading + body
 * or body-only for BFH), and CommonMark requires a blank line before ATX headings
 * for clean rendering. The previous prependHeading approach achieved this indirectly
 * (trailing \n per fragment + \n join = \n\n between headed sections) but left
 * BFH→headed with only \n. Using \n\n uniformly is correct markdown.
 */
export function assembleFragments(...fragments: FragmentContent[]): string {
  return fragments.filter(Boolean).join("\n\n");
}

/** Join multiple section bodies with double-newline separator. */
export function joinBodies(...bodies: SectionBody[]): SectionBody {
  return mintSectionBody(
    bodies
      .map((b) => trimTrailing(sectionBodyText(b)))
      .filter(Boolean)
      .join("\n\n"),
  );
}

/** Append content to a body with double-newline separator. */
export function appendToBody(base: SectionBody, addition: SectionBody): SectionBody {
  const baseStr = trimTrailing(sectionBodyText(base));
  const addStr = trimTrailing(sectionBodyText(addition));
  if (!baseStr) return mintSectionBody(addStr);
  if (!addStr) return mintSectionBody(baseStr);
  return mintSectionBody(baseStr + "\n\n" + addStr);
}

