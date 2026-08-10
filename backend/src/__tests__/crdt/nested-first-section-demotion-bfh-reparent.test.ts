/**
 * Nested first-section demotion → BFH + reparent children (option B).
 *
 * Demoting the first headed section that has descendants must NOT leave a
 * headed-identity-without-heading parenting those children. At quiescence:
 * orphan body under BFH (or dissolve), children top-level with stable ids,
 * demoted headed identity gone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec, getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  requestDocSessionPublish,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { BEFORE_FIRST_HEADING_KEY, getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { joinLiveRecipient } from "../helpers/live-recipient.js";
import { readSection } from "../../storage/section-reader.js";
import { readDocumentStructure, flattenStructureWithLevels } from "../../storage/heading-resolver.js";

const DOC = "/test/todo/nested-first-demotion.md";
const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

/**
 * Nested first H1 with a child:
 *   # Intro          (body in intro sub-skeleton root)
 *   ## Child
 *   ### Grandchild
 */
async function createNestedFirstDoc(dataRoot: string, introBody = "Intro body\n"): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, DOC.replace(/^\//, ""));
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  await writeFile(
    skeletonPath,
    ["# Intro", "{{section: intro.md}}", ""].join("\n"),
    "utf8",
  );

  const introSectionsDir = join(sectionsDir, "intro.md.sections");
  await mkdir(introSectionsDir, { recursive: true });
  await writeFile(
    join(sectionsDir, "intro.md"),
    [
      "{{section: _intro_root.md}}",
      "",
      "## Child",
      "{{section: child.md}}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(introSectionsDir, "_intro_root.md"), introBody, "utf8");

  const childSectionsDir = join(introSectionsDir, "child.md.sections");
  await mkdir(childSectionsDir, { recursive: true });
  await writeFile(
    join(introSectionsDir, "child.md"),
    [
      "{{section: _child_root.md}}",
      "",
      "### Grandchild",
      "{{section: grandchild.md}}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(childSectionsDir, "_child_root.md"), "Child body\n", "utf8");
  await writeFile(join(childSectionsDir, "grandchild.md"), "Grandchild body\n", "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "nested first demotion fixture",
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

function setFragment(session: DocSession, key: string, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(markdown));
  session.ydoc.transact(() =>
    updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }),
  );
}

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(DOC, WRITER.id, baseHead, WRITER, "sock-1");
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

describe("nested first-section demotion → BFH + reparent (option B)", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    resetCoordinatorPublishStateForTest();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("8: demoting nested first H1 settles body under BFH and reparents children with stable ids", async () => {
    await createNestedFirstDoc(ctx.rootDir);
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const intro = layout.find((e) => e.heading === "Intro")!;
    const child = layout.find((e) => e.heading === "Child")!;
    const grandchild = layout.find((e) => e.heading === "Grandchild")!;
    expect(intro).toBeDefined();
    expect(child).toBeDefined();
    expect(grandchild).toBeDefined();
    expect(layout[0].fragmentKey).toBe(intro.fragmentKey);
    expect(child.headingPath[0]).toBe("Intro");
    expect(grandchild.headingPath[0]).toBe("Intro");

    const childKeyBefore = child.fragmentKey;
    const grandchildKeyBefore = grandchild.fragmentKey;

    // Demote Intro: heading gone, orphan body remains in the fragment.
    setFragment(session, intro.fragmentKey, "Intro\n\nIntro body");
    session.fragmentLastActivity.set(intro.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [intro.fragmentKey] });
    await fireQuiescence(session);

    const post = await resolveLiveSectionLayout(DOC, session.generator.getCurrentProposalId());

    // Demoted headed identity gone — must not remain as a durable parent.
    expect(post.some((e) => e.heading === "Intro")).toBe(false);
    expect(post.some((e) => e.fragmentKey === intro.fragmentKey)).toBe(false);

    // Orphan body under BFH (non-empty → keep BFH).
    expect(post[0].headingPath.length).toBe(0);
    expect(session.liveFragments.getFragmentKeys()).toContain(BEFORE_FIRST_HEADING_KEY);
    const bfh = session.liveFragments.readFragmentString(BEFORE_FIRST_HEADING_KEY) as string;
    expect(bfh).toContain("Intro body");
    expect(bfh).not.toMatch(/^#\s/m);

    // Children reparented to top-level with STABLE identities.
    const postChild = post.find((e) => e.heading === "Child")!;
    const postGrand = post.find((e) => e.heading === "Grandchild")!;
    expect(postChild).toBeDefined();
    expect(postGrand).toBeDefined();
    expect(postChild.fragmentKey).toBe(childKeyBefore);
    expect(postGrand.fragmentKey).toBe(grandchildKeyBefore);
    expect(postChild.headingPath).toEqual(["Child"]);
    expect(postGrand.headingPath[0]).toBe("Child");
  });

  it("9: empty nested first H1 demotion dissolves BFH and hands topology to the first child", async () => {
    await createNestedFirstDoc(ctx.rootDir, "");
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const intro = layout.find((e) => e.heading === "Intro")!;
    const child = layout.find((e) => e.heading === "Child")!;
    const grandchild = layout.find((e) => e.heading === "Grandchild")!;
    const childKeyBefore = child.fragmentKey;
    const grandchildKeyBefore = grandchild.fragmentKey;

    // Delete the parent heading with no orphan body. The nested no-predecessor
    // path must not leave an empty BFH above the reparented children.
    setFragment(session, intro.fragmentKey, "");
    session.fragmentLastActivity.set(intro.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [intro.fragmentKey] });
    await fireQuiescence(session);

    const post = await resolveLiveSectionLayout(DOC, session.generator.getCurrentProposalId());

    expect(post.some((e) => e.heading === "Intro")).toBe(false);
    expect(post.some((e) => e.fragmentKey === intro.fragmentKey)).toBe(false);
    expect(post.some((e) => e.headingPath.length === 0)).toBe(false);
    expect(session.liveFragments.getFragmentKeys()).not.toContain(BEFORE_FIRST_HEADING_KEY);

    const postChild = post.find((e) => e.heading === "Child")!;
    const postGrand = post.find((e) => e.heading === "Grandchild")!;
    expect(post[0].fragmentKey).toBe(childKeyBefore);
    expect(postChild.fragmentKey).toBe(childKeyBefore);
    expect(postGrand.fragmentKey).toBe(grandchildKeyBefore);
    expect(postChild.headingPath).toEqual(["Child"]);
    expect(postGrand.headingPath[0]).toBe("Child");

    const proposalId = session.generator.getCurrentProposalId()!;
    const proposalHeadingPaths = await ProposalReader.open(proposalId, "inprogress").listHeadingPaths(DOC);
    expect(proposalHeadingPaths.some((p) => p.length === 0)).toBe(false);
    expect(proposalHeadingPaths).toContainEqual(["Child"]);
  });

  it("11: reparent PRESERVES authored child levels — live markdown, layout, and proposal (consistent with deleteHeadingKeepingChildren)", async () => {
    // Intended contract: descendants reparented by no-predecessor nested
    // demotion keep their AUTHORED heading levels while only their heading
    // PATHS change — the same "re-nests the children at their UNCHANGED
    // levels" rule as the predecessor path (`deleteHeadingKeepingChildren` /
    // parent-heading-deletion.test.ts). Live child fragments are untouched
    // (stable keys AND stable markdown); no re-levelling happens anywhere.
    await createNestedFirstDoc(ctx.rootDir);
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const intro = layout.find((e) => e.heading === "Intro")!;
    const child = layout.find((e) => e.heading === "Child")!;
    const grandchild = layout.find((e) => e.heading === "Grandchild")!;
    expect(child.headingLevel).toBe(2);
    expect(grandchild.headingLevel).toBe(3);
    const childMarkdownBefore = session.liveFragments.readFragmentString(child.fragmentKey) as string;
    const grandchildMarkdownBefore = session.liveFragments.readFragmentString(grandchild.fragmentKey) as string;
    expect(childMarkdownBefore).toMatch(/^## Child/m);
    expect(grandchildMarkdownBefore).toMatch(/^### Grandchild/m);

    setFragment(session, intro.fragmentKey, "Intro\n\nIntro body");
    session.fragmentLastActivity.set(intro.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [intro.fragmentKey] });
    await fireQuiescence(session);

    // Layout levels unchanged (## / ###) even though the paths shortened.
    const post = await resolveLiveSectionLayout(DOC, session.generator.getCurrentProposalId());
    const postChild = post.find((e) => e.heading === "Child")!;
    const postGrand = post.find((e) => e.heading === "Grandchild")!;
    expect(postChild.headingLevel).toBe(2);
    expect(postGrand.headingLevel).toBe(3);
    expect(postChild.headingPath).toEqual(["Child"]);
    expect(postGrand.headingPath).toEqual(["Child", "Grandchild"]);

    // Live child fragments untouched: same markdown, authored levels intact.
    expect(session.liveFragments.readFragmentString(child.fragmentKey)).toBe(childMarkdownBefore);
    expect(session.liveFragments.readFragmentString(grandchild.fragmentKey)).toBe(grandchildMarkdownBefore);

    // Persisted proposal: reparented entries keep their authored levels and
    // bodies at the NEW paths.
    const proposalId = session.generator.getCurrentProposalId()!;
    const reader = ProposalReader.open(proposalId, "inprogress");
    const list = await reader.getSectionList(DOC);
    const proposalChild = list.find((e) => e.heading === "Child")!;
    const proposalGrand = list.find((e) => e.heading === "Grandchild")!;
    expect(proposalChild.headingLevel).toBe(2);
    expect(proposalGrand.headingLevel).toBe(3);
    expect(proposalChild.headingPath).toEqual(["Child"]);
    expect(proposalGrand.headingPath).toEqual(["Child", "Grandchild"]);
    expect(await reader.readSection(DOC, ["Child"])).toContain("Child body");
    expect(await reader.readSection(DOC, ["Child", "Grandchild"])).toContain("Grandchild body");
  });

  it("12: publish after empty nested demotion reconstructs the settled outline (no Intro, no BFH, levels preserved)", async () => {
    await createNestedFirstDoc(ctx.rootDir, "");
    vi.useFakeTimers();
    // No editor socket: the explicit publish runs inline.
    const session = await openSession();

    const layout = await resolveLiveSectionLayout(DOC, null);
    const intro = layout.find((e) => e.heading === "Intro")!;

    setFragment(session, intro.fragmentKey, "");
    session.fragmentLastActivity.set(intro.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [intro.fragmentKey] });
    await fireQuiescence(session);
    expect(session.publishPause.isActive()).toBe(false);
    expect(session.generator.hasCurrentProposal()).toBe(true);

    const outcome = await requestDocSessionPublish(DOC);
    await session.enqueue(() => undefined);
    expect(outcome.outcome).toBe("committed");

    // The explicit publish committed the settled outline to canonical:
    // Intro and BFH are gone, children sit at top level at their AUTHORED
    // levels, bodies intact. Assert the VISIBLE outline (body-holder nodes are
    // a structural detail the flattener drops).
    const visible = flattenStructureWithLevels(await readDocumentStructure(DOC));
    expect(visible.map((s) => ({ heading: s.heading, headingLevel: s.headingLevel, headingPath: s.headingPath }))).toEqual([
      { heading: "Child", headingLevel: 2, headingPath: ["Child"] },
      { heading: "Grandchild", headingLevel: 3, headingPath: ["Child", "Grandchild"] },
    ]);
    expect(await readSection(DOC, ["Child"])).toContain("Child body");
    expect(await readSection(DOC, ["Child", "Grandchild"])).toContain("Grandchild body");
  });

  it("10: empty nested first H1 demotion drops BFH from the ordered live topology frame", async () => {
    await createNestedFirstDoc(ctx.rootDir, "");
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const intro = layout.find((e) => e.heading === "Intro")!;
    const child = layout.find((e) => e.heading === "Child")!;
    const live = await joinLiveRecipient(session);
    disposers.push(live.dispose);

    setFragment(session, intro.fragmentKey, "");
    session.fragmentLastActivity.set(intro.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [intro.fragmentKey] });
    await fireQuiescence(session);

    const structural = live.updates().filter((u) => u.state !== undefined);
    expect(structural.length).toBeGreaterThanOrEqual(1);
    expect(structural[structural.length - 1].yjs_update).toBeDefined();

    const finalTopology = live.latestState().topology;
    expect(finalTopology.map((t) => t.fragment_key)).not.toContain(intro.fragmentKey);
    expect(finalTopology.map((t) => t.fragment_key)).not.toContain(BEFORE_FIRST_HEADING_KEY);
    expect(finalTopology.some((t) => t.heading_path.length === 0)).toBe(false);
    expect(finalTopology[0].fragment_key).toBe(child.fragmentKey);
    expect(finalTopology[0].heading_path).toEqual(["Child"]);
  });
});
