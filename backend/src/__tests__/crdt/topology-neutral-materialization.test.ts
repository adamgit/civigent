/**
 * Regression suite for the topology-neutral materialization invariant
 * (priority-0 bug: inserting a heading inside a section body corrupts the doc).
 *
 * The invariant being established:
 *   - Per-edit (keystroke-rate) materialization writes each touched live section
 *     body VERBATIM into the `inprogress` proposal. It performs NO parsing and
 *     creates NO topology — embedded heading syntax stays literal body text.
 *   - Structural promotion of a settled embedded heading into a real section
 *     happens exactly ONCE, at quiescence normalization, reflected into the
 *     proposal first and then into the live Y.Doc.
 *
 * Per the todolist these tests are written FIRST and are EXPECTED TO FAIL on
 * today's code until the materialization + quiescence-split items land.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { armQuiescenceTimer } from "../../ws/crdt-ws-coordinator.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody, FragmentContent } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { gitExec } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readSection } from "../../storage/section-reader.js";
import { ProposalReader } from "../../storage/proposal-reader.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const BFH_DOC_PATH = "/ops/bfh-only.md";

async function drainLane(session: DocSession): Promise<void> {
  await session.enqueue(() => undefined);
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await drainLane(session);
}

/** Create a BFH-only document (no headed sections) with the given preamble body. */
async function createBfhOnlyDoc(dataRoot: string, body: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, BFH_DOC_PATH.replace(/^\//, ""));
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });
  await writeFile(skeletonPath, ["{{section: --before-first-heading--bfhonly.md}}", ""].join("\n"), "utf8");
  await writeFile(join(sectionsDir, "--before-first-heading--bfhonly.md"), body + "\n", "utf8");
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    ["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "add bfh-only doc", "--allow-empty", "--trailer", "Writer-Type: agent"],
    dataRoot,
  );
}

describe("topology-neutral materialization (priority-0 heading-in-body bug)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("(item 10) per-edit materialize of a headed section is verbatim — embedded heading creates no section", async () => {
    await createSampleDocument(ctx.rootDir);
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");

    // Author types an embedded sub-heading into the Overview fragment.
    const dirty = "## Overview\n\nbase overview body\n\n### Sub\n\nsub body text" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, dirty);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());

    const proposalId = await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });
    const reader = ProposalReader.open(proposalId, "inprogress");

    // NO `Sub` section was created on the keystroke materialize.
    const headingPaths = await reader.listHeadingPaths(SAMPLE_DOC_PATH);
    const headed = headingPaths.filter((p) => p.length > 0);
    expect(headed).toEqual([["Overview"], ["Timeline"]]);

    // Overview body holds the literal `### Sub` text verbatim.
    const overviewBody = await reader.readSection(SAMPLE_DOC_PATH, ["Overview"]);
    expect(overviewBody).toContain("### Sub");
    expect(overviewBody).toContain("base overview body");
    expect(overviewBody).toContain("sub body text");
  });

  it("(item 11) BFH embedded heading is promoted EXACTLY once at quiescence", async () => {
    await createBfhOnlyDoc(ctx.rootDir, "adding texxt");
    vi.useFakeTimers();
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(BFH_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");

    session.liveFragments.replaceFragmentString(
      BEFORE_FIRST_HEADING_KEY,
      "adding texxt\n\n## h3 added" as FragmentContent,
    );
    session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [BEFORE_FIRST_HEADING_KEY] });

    // Quiescence normalizes the settled embedded heading and (no live editor
    // sockets attached) autonomously publishes the settled frontier to canonical.
    await fireQuiescence(session);

    // Exactly one headed section `h3 added`, no partial/duplicate headings.
    const layout = await resolveLiveSectionLayout(BFH_DOC_PATH, null);
    expect(layout.map((e) => e.heading).filter(Boolean)).toEqual(["h3 added"]);

    // BFH body is exactly the preamble — no embedded heading text remaining.
    const bfhBody = await readSection(BFH_DOC_PATH, []);
    expect(bfhBody).toBe("adding texxt");
    expect(bfhBody).not.toContain("##");
    const h3Body = await readSection(BFH_DOC_PATH, ["h3 added"]);
    expect(h3Body).not.toContain("##");
  });

  it("(item 12) end-to-end: BFH heading survives publish + reseed with no literal-heading artifacts", async () => {
    await createBfhOnlyDoc(ctx.rootDir, "adding texxt");
    vi.useFakeTimers();
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(BFH_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");

    session.liveFragments.replaceFragmentString(
      BEFORE_FIRST_HEADING_KEY,
      "adding texxt\n\n## h3 added" as FragmentContent,
    );
    session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [BEFORE_FIRST_HEADING_KEY] });

    // Quiescence normalizes + autonomously publishes to canonical (no editors).
    await fireQuiescence(session);
    expect(session.generator.hasCurrentProposal()).toBe(false); // published

    // Canonical now holds exactly one heading and the preamble as BFH body.
    const canonicalLayout = await resolveLiveSectionLayout(BFH_DOC_PATH, null);
    const canonicalHeadings = canonicalLayout.map((e) => e.heading).filter(Boolean);
    expect(canonicalHeadings).toEqual(["h3 added"]);

    const canonicalBfh = await readSection(BFH_DOC_PATH, []);
    expect(canonicalBfh).toBe("adding texxt");
    expect(canonicalBfh).not.toContain("## ");
    expect(await readSection(BFH_DOC_PATH, ["h3 added"])).not.toContain("## ");

    // Reseed: destroy + re-acquire; the live Y.Doc reflects the published doc.
    destroyAllSessions();
    vi.useRealTimers();
    const reseedHead = await getHeadSha(getDataRoot());
    const session2 = await acquireDocSession(BFH_DOC_PATH, WRITER.id, reseedHead, WRITER, "sock-2");
    const layout2 = await resolveLiveSectionLayout(BFH_DOC_PATH, session2.generator.getCurrentProposalId());
    expect(layout2.map((e) => e.heading).filter(Boolean)).toEqual(["h3 added"]);
    for (const entry of layout2) {
      const live = session2.liveFragments.readFragmentString(entry.fragmentKey) as string;
      if (entry.headingPath.length === 0) {
        expect(live).toBe("adding texxt");
      }
      // No section's live fragment carries duplicate/partial heading lines.
      const headingLines = live.split("\n").filter((l) => /^#{1,6}\s/.test(l));
      expect(headingLines.length).toBeLessThanOrEqual(1);
    }
  });

  it("(item 13) incremental per-character typing produces no intermediate sections", async () => {
    await createBfhOnlyDoc(ctx.rootDir, "adding texxt");
    vi.useFakeTimers();
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(BFH_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");

    // Simulate per-keystroke assembly of `## h3 added` in the BFH fragment,
    // materializing after each update with the quiescence timer kept un-fired.
    const steps = [
      "adding texxt\n\n#",
      "adding texxt\n\n##",
      "adding texxt\n\n## h",
      "adding texxt\n\n## h3",
      "adding texxt\n\n## h3 a",
      "adding texxt\n\n## h3 added",
    ];
    for (const step of steps) {
      session.liveFragments.replaceFragmentString(BEFORE_FIRST_HEADING_KEY, step as FragmentContent);
      session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());
      await session.generator.materializeEdit({ touchedFragmentKeys: [BEFORE_FIRST_HEADING_KEY] });
    }

    // Normalization fires only once, at the end, then autonomously publishes.
    await fireQuiescence(session);

    const canonicalLayout = await resolveLiveSectionLayout(BFH_DOC_PATH, null);
    const headings = canonicalLayout.map((e) => e.heading).filter(Boolean);

    // Exactly one heading; zero partial-heading artifacts from intermediate keystrokes.
    expect(headings).toEqual(["h3 added"]);
    expect(await readSection(BFH_DOC_PATH, [])).toBe("adding texxt");
  });
});
