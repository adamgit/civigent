import { describe, it, expect, beforeAll } from "vitest";
import { resolveDocPathUnderContent, InvalidDocPathError } from "../../storage/path-utils.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";

describe("path-utils", () => {
  let contentRoot: string;

  beforeAll(async () => {
    contentRoot = await mkdtemp(join(tmpdir(), "ks-path-utils-"));
  });

  it("resolveDocPathUnderContent returns absolute path for valid doc path", () => {
    const result = resolveDocPathUnderContent(contentRoot, "folder/doc.md");
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve(contentRoot, "folder", "doc.md"));
    expect(result.startsWith(path.resolve(contentRoot))).toBe(true);
  });

  it("path traversal attempts (../) are rejected with InvalidDocPathError", () => {
    expect(() =>
      resolveDocPathUnderContent(contentRoot, "../etc/passwd.md"),
    ).toThrow(InvalidDocPathError);

    expect(() =>
      resolveDocPathUnderContent(contentRoot, "folder/../../escape.md"),
    ).toThrow(InvalidDocPathError);
  });

  it("paths must end with .md", () => {
    expect(() =>
      resolveDocPathUnderContent(contentRoot, "doc.txt"),
    ).toThrow(InvalidDocPathError);
  });
});
