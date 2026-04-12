/**
 * Group A7: Crash Recovery Invariant Tests
 *
 * Pre-refactor invariant tests for detectAndRecoverCrash.
 * These simulate crash debris on disk and verify the recovery pipeline
 * discovers, recovers, commits, and cleans up correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { detectAndRecoverCrash } from "../../storage/crash-recovery.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { ContentLayer } from "../../storage/content-layer.js";

/** Disk-normalized version of SAMPLE_DOC_PATH (no leading slash). */
const NORMALIZED_DOC = SAMPLE_DOC_PATH.replace(/^\/+/, "");

describe("A7: Crash Recovery Invariants", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ── Helpers ─────────────────────────────────────────────────

  /** Create raw fragment files simulating a crash mid-flush. */
  async function plantRawFragments(content: Record<string, string>): Promise<string> {
    const fragmentDir = join(ctx.rootDir, "sessions", "fragments", NORMALIZED_DOC);
    await mkdir(fragmentDir, { recursive: true });
    for (const [file, body] of Object.entries(content)) {
      await writeFile(join(fragmentDir, file), body, "utf8");
    }
    return fragmentDir;
  }

  /** Create session overlay files simulating a crash after flush but before commit. */
  async function plantOverlayFiles(
    sectionContent: Record<string, string>,
    skeletonContent?: string,
  ): Promise<string> {
    const sessionContentDir = join(ctx.rootDir, "sessions", "sections", "content");
    const parts = NORMALIZED_DOC.split("/");
    const docDir = join(sessionContentDir, ...parts.slice(0, -1));
    const skeletonPath = join(sessionContentDir, ...parts);
    const sectionsDir = `${skeletonPath}.sections`;
    await mkdir(sectionsDir, { recursive: true });

    for (const [file, body] of Object.entries(sectionContent)) {
      await writeFile(join(sectionsDir, file), body, "utf8");
    }

    if (skeletonContent) {
      await writeFile(skeletonPath, skeletonContent, "utf8");
    }

    return sectionsDir;
  }

  // ── A7.1 ──────────────────────────────────────────────────────────

  it("A7.1: detectAndRecoverCrash discovers documents with raw fragment files and recovers them", async () => {
    const uniqueMarker = `A7.1 raw fragment recovery ${Date.now()}`;

    // Plant raw fragments (simulates crash during flush)
    await plantRawFragments({
      "overview.md": `${uniqueMarker}\n`,
    });

    const result = await detectAndRecoverCrash(ctx.rootDir);
    expect(result.recovered).toBe(true);
    expect(result.sessionFilesRecovered).toBeGreaterThan(0);

    // Recovered content should be in canonical
    const canonical = new ContentLayer(ctx.contentDir);
    const sections = await canonical.readAllSections(SAMPLE_DOC_PATH);
    expect(String(sections.get("Overview") ?? "")).toContain(uniqueMarker);
  });

  // ── A7.2 ──────────────────────────────────────────────────────────

  it("A7.2: detectAndRecoverCrash discovers documents with session overlay files and recovers them", async () => {
    const uniqueMarker = `A7.2 overlay recovery ${Date.now()}`;

    // Plant overlay files (simulates crash after flush, before commit)
    await plantOverlayFiles({
      "overview.md": `${uniqueMarker}\n`,
    });

    const result = await detectAndRecoverCrash(ctx.rootDir);
    expect(result.recovered).toBe(true);
    expect(result.sessionFilesRecovered).toBeGreaterThan(0);

    // Recovered content should be in canonical
    const canonical = new ContentLayer(ctx.contentDir);
    const sections = await canonical.readAllSections(SAMPLE_DOC_PATH);
    expect(String(sections.get("Overview") ?? "")).toContain(uniqueMarker);
  });

  // ── A7.3 ──────────────────────────────────────────────────────────

  it("A7.3: recovery preference order: raw fragment > overlay > canonical (freshest wins)", async () => {
    const fragmentMarker = `FRAGMENT_LAYER_${Date.now()}`;
    const overlayMarker = `OVERLAY_LAYER_${Date.now()}`;

    // Plant both raw fragment AND overlay for the same section
    // Fragment should win (it's the freshest layer)
    await plantRawFragments({
      "overview.md": `${fragmentMarker}\n`,
    });
    await plantOverlayFiles({
      "overview.md": `${overlayMarker}\n`,
    });

    const result = await detectAndRecoverCrash(ctx.rootDir);
    expect(result.recovered).toBe(true);

    // Fragment should be preferred over overlay
    const canonical = new ContentLayer(ctx.contentDir);
    const sections = await canonical.readAllSections(SAMPLE_DOC_PATH);
    const overviewContent = String(sections.get("Overview") ?? "");
    expect(overviewContent).toContain(fragmentMarker);
    expect(overviewContent).not.toContain(overlayMarker);
  });

  // ── A7.4 ──────────────────────────────────────────────────────────

  it("A7.4: recovery commits recovered content to canonical and cleans up all session files", async () => {
    const headBefore = await getHeadSha(ctx.rootDir);

    // Plant overlay files
    const sectionsDir = await plantOverlayFiles({
      "overview.md": "A7.4 recovered content.\n",
    });

    const result = await detectAndRecoverCrash(ctx.rootDir);
    expect(result.recovered).toBe(true);

    // Git HEAD should have advanced (a commit was made)
    const headAfter = await getHeadSha(ctx.rootDir);
    expect(headAfter).not.toBe(headBefore);

    // Session files should be cleaned up
    let overlayFiles: string[] = [];
    try {
      overlayFiles = await readdir(sectionsDir);
    } catch { /* directory deleted */ }
    expect(overlayFiles.length).toBe(0);
  });

  // ── A7.5 ──────────────────────────────────────────────────────────

  it("A7.5: recovery is tolerant — corrupt files are skipped, not fatal", async () => {
    // Plant a mix of valid and corrupt overlay files
    await plantOverlayFiles({
      "overview.md": "Valid content for recovery.\n",
    });

    // Also plant a corrupt raw fragment (binary garbage)
    const fragmentDir = join(ctx.rootDir, "sessions", "fragments", NORMALIZED_DOC);
    await mkdir(fragmentDir, { recursive: true });
    const garbage = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x00]);
    await writeFile(join(fragmentDir, "timeline.md"), garbage);

    // Recovery should not throw
    const result = await detectAndRecoverCrash(ctx.rootDir);

    // Should still recover what it can
    expect(result.recovered).toBe(true);
    expect(result.sessionFilesRecovered).toBeGreaterThan(0);
  });

  // ── A7.6 ──────────────────────────────────────────────────────────

  it("A7.6: proposal cleanup during recovery is unaffected by session recovery", async () => {
    // Create a stuck committing proposal
    const committingDir = join(ctx.rootDir, "proposals", "committing");
    const proposalId = "stuck-proposal-a76";
    const proposalSubDir = join(committingDir, proposalId);
    await mkdir(proposalSubDir, { recursive: true });
    await writeFile(
      join(proposalSubDir, "meta.json"),
      JSON.stringify({
        id: proposalId,
        writer: { id: "test", type: "human", displayName: "Test" },
        intent: "test",
        sections: [],
        created_at: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );

    // Also plant session files
    await plantOverlayFiles({
      "overview.md": "A7.6 session content.\n",
    });

    const result = await detectAndRecoverCrash(ctx.rootDir);

    // Both proposal recovery and session recovery should work
    expect(result.recovered).toBe(true);

    // Stuck proposal should be moved to draft
    const draftDir = join(ctx.rootDir, "proposals", "draft");
    const draftEntries = await readdir(draftDir).catch(() => []);
    expect(draftEntries).toContain(proposalId);

    // committing should be empty
    const afterCommitting = await readdir(committingDir).catch(() => []);
    expect(afterCommitting).not.toContain(proposalId);
  });
});
