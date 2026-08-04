/**
 * `search_text` / `searchReadableText` (spec 07 §Discovery search).
 *
 * Covers the public search contract: literal + regexp syntax, canonical root /
 * folder / document scope, default case-insensitivity, the result shape (byte
 * offset + context), the four hit KINDS (`body` plus the `heading` / `filename` /
 * `path_segment` locators — heading text in the skeleton IS matched), and
 * permission filtering of matches.
 *
 * Requires ripgrep on PATH (the binary present in this environment). Not a
 * semantic-search or arbitrary-filesystem-grep test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { invalidateCache, setDocAcl } from "../../auth/acl.js";
import { searchReadableText } from "../../storage/discovery.js";
import type { AuthenticatedWriter } from "../../auth/context.js";

/**
 * The discovery search shells out to `rg` on PATH (the production runtime image
 * ships ripgrep there). In some dev shells ripgrep is only available under the
 * editor server, surfaced as a shell alias rather than a PATH binary the spawned
 * process can see. Probe for a spawnable `rg`; if absent, locate a bundled
 * `@vscode/ripgrep` binary and prepend it to PATH. Returns whether `rg` is now
 * spawnable; when false the suite is skipped (search needs a real ripgrep —
 * mirrors `discovery.test.ts` omitting these cases).
 */
function ensureRipgrepSpawnable(): boolean {
  const spawnable = (): boolean => {
    try {
      execFileSync("rg", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (spawnable()) return true;
  for (const root of ["/vscode", "/root", process.env.HOME ?? "/home"]) {
    try {
      const found = execFileSync(
        "find",
        [root, "-type", "f", "-path", "*@vscode/ripgrep/bin/rg", "-print", "-quit"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (found) {
        process.env.PATH = `${dirname(found)}:${process.env.PATH ?? ""}`;
        if (spawnable()) return true;
      }
    } catch {
      // root not present / find unsupported — try the next candidate.
    }
  }
  return false;
}

const RG_AVAILABLE = ensureRipgrepSpawnable();

const DOC_A = "/multi/doc-a.md";
const DOC_B = "/single/doc-b.md";
const READER: AuthenticatedWriter = { id: "search-reader", type: "human", displayName: "Reader" };

// Body of Overview — "QUICKBROWN" begins at byte offset 4 ("The ").
const OVERVIEW_BODY = "The QUICKBROWN fox jumps over it.\n";

let ctx: TempDataRootContext;

async function writeDoc(
  docPath: string,
  sections: Array<{ heading: string; file: string; body: string }>,
): Promise<void> {
  const skeleton = join(ctx.contentDir, docPath.replace(/^\//, ""));
  const sectionsDir = `${skeleton}.sections`;
  await mkdir(sectionsDir, { recursive: true });
  const lines: string[] = [];
  for (const s of sections) {
    lines.push(`## ${s.heading}`, `{{section: ${s.file}}}`, "");
    await writeFile(join(sectionsDir, s.file), s.body, "utf8");
  }
  await writeFile(skeleton, lines.join("\n"), "utf8");
}

describe.skipIf(!RG_AVAILABLE)("search_text / searchReadableText (spec 07)", () => {
  beforeAll(async () => {
    ctx = await createTempDataRoot();
    invalidateCache();
    await writeDoc(DOC_A, [
      { heading: "Overview", file: "overview.md", body: OVERVIEW_BODY },
      { heading: "Timeline", file: "timeline.md", body: "A Zebra walked the timeline.\n" },
    ]);
    await writeDoc(DOC_B, [
      // The token "HeadingOnlyToken" appears ONLY as a heading (in the skeleton),
      // never in a section body.
      { heading: "HeadingOnlyToken", file: "summary.md", body: "Plain summary body.\n" },
    ]);
    const authDir = join(ctx.rootDir, "auth");
    await mkdir(authDir, { recursive: true });
    await writeFile(join(authDir, "defaults.json"), JSON.stringify({ read: "public", write: "authenticated" }), "utf8");
    await gitExec(["add", "."], ctx.rootDir);
    await gitExec(["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "docs"], ctx.rootDir);
    invalidateCache();
  });

  afterAll(async () => {
    invalidateCache();
    await ctx.cleanup();
  });

  it("literal search returns the match with doc/section, byte offset, and context", async () => {
    const res = await searchReadableText(null, { pattern: "QUICKBROWN", syntax: "literal", root: "/" });
    expect(res.matches.length).toBe(1);
    const m = res.matches[0]!;
    expect(m.kind).toBe("body");
    expect(m.doc_path).toBe(DOC_A);
    expect(m.heading_path).toEqual(["Overview"]);
    expect(m.match_context).toContain("QUICKBROWN");
    // Byte offset is into the section BODY ("The " = 4 bytes precede the token).
    expect(m.match_offset_bytes).toBe(OVERVIEW_BODY.indexOf("QUICKBROWN"));
    // Result shape carries timings.
    expect(typeof res.timings.total_ms).toBe("number");
  });

  it("is case-insensitive by default", async () => {
    const res = await searchReadableText(null, { pattern: "quickbrown", syntax: "literal", root: "/" });
    expect(res.matches.map((m) => m.heading_path)).toContainEqual(["Overview"]);
  });

  it("supports regexp syntax", async () => {
    const res = await searchReadableText(null, { pattern: "Z[a-z]+ra", syntax: "regexp", root: "/" });
    expect(res.matches.length).toBe(1);
    expect(res.matches[0]!.heading_path).toEqual(["Timeline"]);
    expect(res.matches[0]!.match_context).toContain("Zebra");
  });

  it("matches a heading-only token as a `heading` hit", async () => {
    const headingOnly = await searchReadableText(null, { pattern: "HeadingOnlyToken", syntax: "literal", root: "/" });
    expect(headingOnly.matches).toHaveLength(1);
    const hit = headingOnly.matches[0]!;
    expect(hit.kind).toBe("heading");
    expect(hit.doc_path).toBe(DOC_B);
    expect(hit.heading_path).toEqual(["HeadingOnlyToken"]);
    // Non-body kinds carry the matched text itself as context, with the offset
    // measured inside it.
    expect(hit.match_context).toBe("HeadingOnlyToken");
    expect(hit.match_offset_bytes).toBe(0);

    // ...and a token in DOC_B's body is still found as a `body` hit.
    const inBody = await searchReadableText(null, { pattern: "Plain summary", syntax: "literal", root: "/" });
    expect(inBody.matches.map((m) => m.doc_path)).toContain(DOC_B);
    expect(inBody.matches.map((m) => m.kind)).toContain("body");
  });

  it("honors canonical scope: a folder root restricts which docs are searched", async () => {
    const inMulti = await searchReadableText(null, { pattern: "QUICKBROWN", syntax: "literal", root: "/multi" });
    expect(inMulti.matches).toHaveLength(1);
    const inSingle = await searchReadableText(null, { pattern: "QUICKBROWN", syntax: "literal", root: "/single" });
    expect(inSingle.matches).toHaveLength(0);
  });

  it("respects context_bytes in the returned match_context", async () => {
    const narrow = await searchReadableText(null, { pattern: "QUICKBROWN", syntax: "literal", root: "/", context_bytes: 0 });
    const wide = await searchReadableText(null, { pattern: "QUICKBROWN", syntax: "literal", root: "/", context_bytes: 100 });
    expect(narrow.matches[0]!.match_context.length).toBeLessThan(wide.matches[0]!.match_context.length);
  });

  it("filters matches in unreadable documents (permission filtering)", async () => {
    await setDocAcl(DOC_A, { read: "authenticated" });
    invalidateCache();

    const anon = await searchReadableText(null, { pattern: "QUICKBROWN", syntax: "literal", root: "/" });
    expect(anon.matches).toHaveLength(0);

    const authed = await searchReadableText(READER, { pattern: "QUICKBROWN", syntax: "literal", root: "/" });
    expect(authed.matches).toHaveLength(1);
    expect(authed.matches[0]!.doc_path).toBe(DOC_A);
  });
});
