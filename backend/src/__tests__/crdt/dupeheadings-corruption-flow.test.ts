/**
 * Contracts for the /test/2026/july/dupeheadings.md corruption shape.
 *
 * Proven so far (see A1): same-level consecutive headings through quiescence
 * stay sibling LEAVES — they do NOT create `--section-body--` sub-skeletons.
 *
 * The dump's shape (sec_heading_1 sub-skeleton + --section-body-- child,
 * body-holder also keyed as BFH) therefore requires either:
 *   - a NESTED structural write (child under heading 1), or
 *   - diagnostics/layout identity collapse around a legitimate body-holder.
 *
 * These tests pin both halves and the quiescence-unguarded hole.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { armQuiescenceTimer } from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { gitExec, getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { fragmentKeyFromSectionFile, BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { isBodyHolderShape, isDocumentBeforeFirstHeading } from "../../storage/section-shape.js";
import { validateLiveEditForDuplicateSiblingHeadings } from "../../crdt/live-edit-structural-validation.js";
import { classifyStructuralChange } from "../../crdt/structural-change.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import type { LiveSectionLayoutEntry } from "../../crdt/live-section-layout.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const H1_DOC = "/test/2026/july/h1-split.md";

async function openSession(docPath = SAMPLE_DOC_PATH): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(docPath, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: DocSession): Promise<void> {
  await session.enqueue(() => undefined);
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await drainLane(session);
}

async function createH1LeafDoc(dataRoot: string): Promise<string> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, H1_DOC.replace(/^\//, ""));
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });
  await writeFile(
    skeletonPath,
    "# heading 1\n{{section: sec_heading_1.md}}\n",
    "utf8",
  );
  await writeFile(join(sectionsDir, "sec_heading_1.md"), "\n", "utf8");
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "h1 leaf fixture",
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
  return "section::sec_heading_1";
}

function uniqueHeadingPaths(layout: LiveSectionLayoutEntry[]): boolean {
  const keys = layout.map((e) => JSON.stringify(e.headingPath));
  return new Set(keys).size === keys.length;
}

describe("dupeheadings corruption flow", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  // ── A: consecutive same-level headings stay leaves ─────────────────────

  it("A1: same-level ## siblings via quiescence — no body-holder fragment key, unique paths", async () => {
    await createSampleDocument(ctx.rootDir);
    vi.useFakeTimers();
    const session = await openSession();

    const dirty =
      "## Overview\n\n\n## heading 2\n\n\n## heading 3\n" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, dirty);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const layout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    expect(layout.map((e) => e.heading)).toEqual(
      expect.arrayContaining(["Overview", "heading 2", "heading 3"]),
    );
    expect(uniqueHeadingPaths(layout)).toBe(true);

    const overview = layout.find((e) => e.heading === "Overview")!;
    // Sibling split keeps the survivor leaf identity — NOT a --section-body-- key.
    expect(overview.fragmentKey).not.toMatch(/--section-body--/);
    expect(overview.fragmentKey).not.toBe(BEFORE_FIRST_HEADING_KEY);
  });

  it("A1b: same-level # H1 siblings via quiescence — still leaves (matches user keystrokes)", async () => {
    const heading1Key = await createH1LeafDoc(ctx.rootDir);
    vi.useFakeTimers();
    const session = await openSession(H1_DOC);

    const dirty =
      "# heading 1\n\n\n# heading 2\n\n\n# heading 3\n" as FragmentContent;
    session.liveFragments.replaceFragmentString(heading1Key, dirty);
    session.fragmentLastActivity.set(heading1Key, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const layout = await resolveLiveSectionLayout(H1_DOC, session.generator.getCurrentProposalId());
    const h1Rows = layout.filter((e) => e.heading === "heading 1");
    expect(h1Rows).toHaveLength(1);
    expect(uniqueHeadingPaths(layout)).toBe(true);
    expect(layout.map((e) => e.heading)).toEqual(
      expect.arrayContaining(["heading 1", "heading 2", "heading 3"]),
    );
    // THE dump's smoking gun must NOT appear on the happy path:
    expect(h1Rows[0].fragmentKey).not.toMatch(/--section-body--/);
    expect(layout.some((e) => e.fragmentKey === BEFORE_FIRST_HEADING_KEY)).toBe(false);
  });

  // ── B: nested split creates body-holder; identity discipline required ───

  it("B1: nested child under Overview — live layout folds to exactly one Overview identity", async () => {
    await createSampleDocument(ctx.rootDir);
    vi.useFakeTimers();
    const session = await openSession();

    const dirty =
      "## Overview\n\nbase overview body\n\n### New Sub\n\nbrand new sub body" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, dirty);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    const layout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    const overviewRows = layout.filter(
      (e) => e.headingPath.length === 1 && e.headingPath[0] === "Overview",
    );
    expect(overviewRows).toHaveLength(1);
    expect(uniqueHeadingPaths(layout)).toBe(true);
    expect(layout.some((e) => e.heading === "New Sub")).toBe(true);
    // Visible Overview must never be the document BFH key.
    expect(overviewRows[0].fragmentKey).not.toBe(BEFORE_FIRST_HEADING_KEY);
  });

  it("B2: raw isBodyHolderShape mis-keys nested body-holder as document BFH (diagnostics hole)", () => {
    // FlatEntry shape for a nested body-holder under Overview — same shape
    // listCanonicalEntries / collect-section-layers see after leaf→sub-skeleton.
    const nestedBodyHolderShape = {
      heading: "",
      level: 0,
      headingPath: ["Overview"] as string[],
      sectionFile: "--section-body--c2cqo0.md", // matches dupeheadings dump naming
    };

    expect(isBodyHolderShape(nestedBodyHolderShape)).toBe(true);
    expect(isDocumentBeforeFirstHeading(nestedBodyHolderShape)).toBe(false);

    const diagKey = fragmentKeyFromSectionFile(
      nestedBodyHolderShape.sectionFile,
      isBodyHolderShape(nestedBodyHolderShape), // collect-section-layers.ts today
    );
    const correctKey = fragmentKeyFromSectionFile(
      nestedBodyHolderShape.sectionFile,
      isDocumentBeforeFirstHeading(nestedBodyHolderShape), // live-section-layout.ts today
    );

    // Dump: section::__beforeFirstHeading__ bound to --section-body--c2cqo0.md
    expect(diagKey).toBe(BEFORE_FIRST_HEADING_KEY);
    expect(correctKey).toBe("section::--section-body--c2cqo0");
    // Elegant fix: diagnostics must use isDocumentBeforeFirstHeading → keys agree.
    expect(diagKey).not.toBe(correctKey);
  });

  // ── C: quiescence unguarded vs ingress ─────────────────────────────────

  it("C1: ingress rejects self-duplicated sibling heading in one fragment", async () => {
    await createSampleDocument(ctx.rootDir);
    const session = await openSession();
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, null);

    const duplicated =
      "## Overview\n\nbody\n\n## Overview\n\nagain" as FragmentContent;
    const change = classifyStructuralChange(duplicated, {
      headingPath: ["Overview"],
      heading: "Overview",
      level: 2,
    });
    expect(change.kind).toBe("section-split");

    const result = validateLiveEditForDuplicateSiblingHeadings({
      layout,
      touchedFragmentKeys: [OVERVIEW_KEY],
      readPostUpdateMarkdown: (fk) => (fk === OVERVIEW_KEY ? duplicated : ""),
    });
    expect(result.rejectionGroups.length).toBeGreaterThan(0);
    expect(
      result.rejectionGroups.some((g) => g.reasonCode === "duplicate-sibling-heading"),
    ).toBe(true);
  });

  it("C2: quiescence on ingress-rejected self-dupe must not yield duplicate heading paths", async () => {
    await createSampleDocument(ctx.rootDir);
    vi.useFakeTimers();
    const session = await openSession();

    // Bypass ingress (models attach/ySync writing a doubled fragment).
    const duplicated =
      "## Overview\n\nbody\n\n## Overview\n\nagain" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, duplicated);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();

    let threw: unknown = null;
    try {
      await fireQuiescence(session);
    } catch (err) {
      threw = err;
    }

    const layout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    const overviewRows = layout.filter(
      (e) => e.headingPath.length === 1 && e.headingPath[0] === "Overview",
    );

    // Contract: hard-fail OR single Overview identity — never two.
    if (!threw) {
      expect(uniqueHeadingPaths(layout)).toBe(true);
      expect(overviewRows.length).toBe(1);
    }
  });
});
