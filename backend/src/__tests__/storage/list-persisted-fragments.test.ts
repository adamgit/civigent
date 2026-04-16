import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RawFragmentRecoveryBuffer } from "../../storage/raw-fragment-recovery-buffer.js";
import { getSessionFragmentsRoot } from "../../storage/data-root.js";
import { BEFORE_FIRST_HEADING_KEY, fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

const DOC_PATH = "folder/sample.md";

async function ensureFragmentDir(): Promise<string> {
  const dir = path.join(getSessionFragmentsRoot(), DOC_PATH);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("RawFragmentRecoveryBuffer.listPersistedFragments", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns [] when the fragment directory does not exist (no persisted state)", async () => {
    const buffer = new RawFragmentRecoveryBuffer(DOC_PATH);
    const result = await buffer.listPersistedFragments();
    expect(result).toEqual([]);
  });

  it("maps regular sec_*.md filenames to section:: fragment keys", async () => {
    const dir = await ensureFragmentDir();
    await writeFile(path.join(dir, "sec_abc123.md"), "body one", "utf8");
    await writeFile(path.join(dir, "sec_def456.md"), "body two", "utf8");

    const buffer = new RawFragmentRecoveryBuffer(DOC_PATH);
    const result = await buffer.listPersistedFragments();

    const byKey = new Map(result.map((r) => [r.fragmentKey, r.fileName]));
    expect(byKey.get(fragmentKeyFromSectionFile("sec_abc123.md", false))).toBe("sec_abc123.md");
    expect(byKey.get(fragmentKeyFromSectionFile("sec_def456.md", false))).toBe("sec_def456.md");
    expect(result).toHaveLength(2);
  });

  it("maps the BFH synthetic filename to BEFORE_FIRST_HEADING_KEY", async () => {
    const dir = await ensureFragmentDir();
    await writeFile(path.join(dir, "__beforeFirstHeading__.md"), "bfh body", "utf8");

    const buffer = new RawFragmentRecoveryBuffer(DOC_PATH);
    const result = await buffer.listPersistedFragments();

    expect(result).toHaveLength(1);
    expect(result[0].fragmentKey).toBe(BEFORE_FIRST_HEADING_KEY);
    expect(result[0].fileName).toBe("__beforeFirstHeading__.md");
  });

  it("ignores non-.md entries in the fragment dir", async () => {
    const dir = await ensureFragmentDir();
    await writeFile(path.join(dir, "sec_real.md"), "real", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "not a fragment", "utf8");
    await writeFile(path.join(dir, "README"), "not a fragment", "utf8");
    await mkdir(path.join(dir, "nested"), { recursive: true });

    const buffer = new RawFragmentRecoveryBuffer(DOC_PATH);
    const result = await buffer.listPersistedFragments();

    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("sec_real.md");
    expect(result[0].fragmentKey).toBe(fragmentKeyFromSectionFile("sec_real.md", false));
  });

  it("returns fileName that the caller can use to locate the file on disk", async () => {
    const dir = await ensureFragmentDir();
    await writeFile(path.join(dir, "sec_xyz.md"), "payload", "utf8");
    await writeFile(path.join(dir, "__beforeFirstHeading__.md"), "bfh payload", "utf8");

    const buffer = new RawFragmentRecoveryBuffer(DOC_PATH);
    const entries = await buffer.listPersistedFragments();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      const readBack = await buffer.readFragment(entry.fragmentKey);
      expect(readBack).not.toBeNull();
    }
  });
});
