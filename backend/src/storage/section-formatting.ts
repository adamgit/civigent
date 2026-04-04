// ─── Branded types ──────────────────────────────────────────────────
//
// SectionBody: body-only content (no heading line), no guaranteed trailing \n.
// FragmentContent: heading+body content (or body-only for BFH), no guaranteed trailing \n.
// Both are plain strings at runtime; the brands exist only at compile time to
// prevent accidental mixing of "body" and "fragment" strings.

declare const __sectionBody: unique symbol;
declare const __fragmentContent: unique symbol;

/** Body-only markdown (heading stripped). In-memory representation. */
export type SectionBody = string & { readonly [__sectionBody]: true };

/** Full fragment markdown (heading + body, or body-only for BFH). In-memory representation. */
export type FragmentContent = string & { readonly [__fragmentContent]: true };

// ─── Boundary functions ─────────────────────────────────────────────
//
// Each boundary function marks the crossing point where a raw string enters
// the typed domain. The trim/normalization inside each function documents
// exactly what contract that crossing enforces.

/** Disk body file → SectionBody. Strips the POSIX trailing \n that writeBodyFile adds. */
export function bodyFromDisk(raw: string): SectionBody {
  return raw.replace(/\n+$/, "") as SectionBody;
}

/** SectionBody → disk format. Ensures exactly one trailing \n (POSIX text file). */
export function bodyToDisk(body: SectionBody): string {
  const trimmed = (body as string).replace(/\n+$/, "");
  return trimmed ? trimmed + "\n" : "\n";
}

/** Git blob content → SectionBody. Git blobs include trailing \n; strip it. */
export function bodyFromGit(raw: string): SectionBody {
  return raw.replace(/\n+$/, "") as SectionBody;
}

/** remark/milkdown serializer output → SectionBody. jsonToMarkdown output may have trailing \n. */
export function bodyFromRemark(raw: string): SectionBody {
  return raw.replace(/\n+$/, "") as SectionBody;
}

/** CommonMark parser (markdown-sections.ts) output → SectionBody. Parser already trims. */
export function bodyFromParser(raw: string): SectionBody {
  return raw.replace(/\n+$/, "") as SectionBody;
}

/** Recovery assembly (recovery-layers.ts) output → SectionBody. */
export function bodyFromRecoveryAssembly(raw: string): SectionBody {
  return raw.replace(/\n+$/, "") as SectionBody;
}

/** Raw fragment file content used as a body during orphan collection → SectionBody. */
export function bodyFromOrphanFragment(raw: string): SectionBody {
  return raw.replace(/\n+$/, "") as SectionBody;
}

/** remark/milkdown serializer output → FragmentContent. */
export function fragmentFromRemark(raw: string): FragmentContent {
  return raw.replace(/\n+$/, "") as FragmentContent;
}

/** Disk fragment file → FragmentContent. */
export function fragmentFromDisk(raw: string): FragmentContent {
  return raw.replace(/\n+$/, "") as FragmentContent;
}

/** FragmentContent → disk format. Ensures trailing \n. */
export function fragmentToDisk(fragment: FragmentContent): string {
  const trimmed = (fragment as string).replace(/\n+$/, "");
  return trimmed ? trimmed + "\n" : "\n";
}

/** CommonMark parser output → FragmentContent (heading + body). */
export function fragmentFromParser(raw: string): FragmentContent {
  return raw.replace(/\n+$/, "") as FragmentContent;
}

/** External/API content entering the branded domain → FragmentContent. */
export function fragmentFromExternalContent(raw: string): FragmentContent {
  return raw.replace(/\n+$/, "") as FragmentContent;
}

// ─── BFH identity + empty helpers ──────────────────────────────────
//
// BFH (before-first-heading) sections have no heading line, so their body
// and fragment representations are identical. These helpers document that
// identity instead of scattering `as unknown as` casts through the codebase.

/** Empty section body (typed constant). */
export const EMPTY_BODY = "" as SectionBody;

/** Empty fragment content (typed constant). */
export const EMPTY_FRAGMENT = "" as FragmentContent;

/** BFH identity: body IS fragment when there's no heading. */
export function bodyAsFragment(body: SectionBody): FragmentContent {
  return body as unknown as FragmentContent;
}

/** BFH identity (reverse): fragment IS body when there's no heading. */
export function fragmentAsBody(fragment: FragmentContent): SectionBody {
  return fragment as unknown as SectionBody;
}

/** Strip leading newlines from a SectionBody without breaking the brand. */
export function stripLeadingNewlines(body: SectionBody): SectionBody {
  return (body as string).replace(/^\n+/, "") as SectionBody;
}

// ─── Conversion / combining functions ───────────────────────────────

/**
 * Build a full fragment (heading + body) from a body and heading info.
 * BFH sections (level=0, heading="") return the body as-is.
 */
export function buildFragmentContent(body: SectionBody, level: number, heading: string): FragmentContent {
  if (level === 0 && heading === "") return bodyAsFragment(body);
  const headingLine = `${"#".repeat(level)} ${heading}`;
  const bodyStr = body as string;
  return (bodyStr.trim() ? `${headingLine}\n\n${bodyStr}` : headingLine) as FragmentContent;
}

/**
 * Strip the heading line from a fragment, returning just the body.
 * If no heading line matches the expected level, returns the full content as body.
 */
export function stripHeadingFromFragment(markdown: FragmentContent, level: number): SectionBody {
  const headingPrefix = "#".repeat(level) + " ";
  const lines = (markdown as string).split("\n");
  if (lines.length > 0 && lines[0].startsWith(headingPrefix)) {
    let startIdx = 1;
    while (startIdx < lines.length && lines[startIdx].trim() === "") {
      startIdx++;
    }
    return lines.slice(startIdx).join("\n").replace(/\n+$/, "") as SectionBody;
  }
  return (markdown as string).replace(/\n+$/, "") as SectionBody;
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
  return bodies
    .map((b) => (b as string).replace(/\n+$/, ""))
    .filter(Boolean)
    .join("\n\n") as SectionBody;
}

/** Append content to a body with double-newline separator. */
export function appendToBody(base: SectionBody, addition: SectionBody): SectionBody {
  const baseStr = (base as string).replace(/\n+$/, "");
  const addStr = (addition as string).replace(/\n+$/, "");
  if (!baseStr) return addStr as SectionBody;
  if (!addStr) return baseStr as SectionBody;
  return (baseStr + "\n\n" + addStr) as SectionBody;
}

