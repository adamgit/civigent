import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROUTES_DIR = path.join(__dirname, "..", "..", "api", "routes");

// Route modules that are HTTP-only and must NOT reach into the lower layers.
// Exemptions:
//  - middleware.ts / auth.ts may import auth/* (they are the auth-aware seam).
//  - oauth.ts is a separate self-contained router (not part of the /api god-file
//    split) and legitimately imports auth/*.
const EXEMPT = new Set(["middleware.ts", "auth.ts", "oauth.ts"]);

const BANNED_PREFIXES = [
  "../../storage/",
  "../../crdt/",
  "../../domain/",
  "../../mcp/",
  "../../diagnostics/",
];

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRe = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;
  const dynRe = /import\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) specifiers.push(m[1]);
  while ((m = dynRe.exec(source)) !== null) specifiers.push(m[1]);
  return specifiers;
}

describe("route import discipline", () => {
  it("no HTTP-only route module imports storage/crdt/domain/mcp/diagnostics", async () => {
    const files = (await readdir(ROUTES_DIR)).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts" && !EXEMPT.has(f),
    );
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(ROUTES_DIR, file), "utf8");
      for (const spec of extractImportSpecifiers(source)) {
        if (BANNED_PREFIXES.some((p) => spec.startsWith(p))) {
          violations.push(`${file} imports "${spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("index.ts is assembly-only: imports only express, route modules, and middleware", async () => {
    const source = await readFile(path.join(ROUTES_DIR, "index.ts"), "utf8");
    const specs = extractImportSpecifiers(source);
    for (const spec of specs) {
      const allowed =
        spec === "express" ||
        spec === "../../types/shared.js" ||
        spec === "./middleware.js" ||
        (spec.startsWith("./") && spec.endsWith(".js"));
      expect(allowed, `index.ts must not import "${spec}"`).toBe(true);
    }
    // No banned layer imports.
    for (const spec of specs) {
      expect(BANNED_PREFIXES.some((p) => spec.startsWith(p))).toBe(false);
    }
  });
});
