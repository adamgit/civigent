/**
 * Claim-review 04 enforcement: unexpected read failures must remain visible.
 * Behavioural tests own the distinction between a valid claimed-but-absent
 * deletion and corruption; this file only guards narrow source-level
 * catch-and-swallow regressions that are independent of proposal semantics.
 *
 * EXEMPT by contract (tolerant readers — do NOT touch): `skeleton-assessment.ts`
 * (diagnostic, never throws) and `crash-recovery.ts` (fails loud via process.exit).
 * The ban is on coercing a *failure*; ENOENT on a genuinely-optional dir is allowed
 * (those sites use explicit ENOENT guards, not the patterns banned here).
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..");

// The read-path modules whose fail-loud behaviour this test pins.
const GUARDED_FILES = [
  "storage/proposal-repository.ts",
  "domain/agent-write-policy.ts",   // safeSecondsSinceLastHumanActivity narrowed catch
];

describe("Claim-review 04: read paths do not catch-and-swallow", () => {
  it("the scoring path narrows its catch to not-yet-canonical errors (skeleton-integrity now throws)", async () => {
    const source = await readFile(path.join(SRC, "domain/agent-write-policy.ts"), "utf8");
    const fn = source.slice(source.indexOf("safeSecondsSinceLastHumanActivity"));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    // Skeleton-integrity must NOT be coerced to null/0 here any more.
    expect(body).not.toContain("Skeleton integrity error");
    expect(body).toContain("DocumentNotFoundError");
  });

  it("no guarded read-path module contains a bare empty `catch {}` swallow", async () => {
    const offenders: string[] = [];
    for (const rel of GUARDED_FILES) {
      const source = await readFile(path.join(SRC, rel), "utf8");
      // Empty catch blocks `catch {}` or `catch (e) {}` — a silent swallow.
      if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
