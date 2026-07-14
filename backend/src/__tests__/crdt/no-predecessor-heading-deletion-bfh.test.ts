/**
 * No-predecessor heading-deletion → before-first-heading (BFH) at quiescence.
 *
 * A demoted FIRST headed section (layout index 0, no predecessor) has no section
 * to merge into. At quiescence its orphan body must settle under the BFH preamble
 * (create/register BFH, delete the old headed identity), with empty-BFH dissolve
 * when the orphan is empty. A demotion WITH a predecessor must still merge into
 * that predecessor (the existing path is untouched).
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
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { BEFORE_FIRST_HEADING_KEY, getBackendSchema } from "../../crdt/ydoc-fragments.js";

const DOC = "/test/todo/no-predecessor-bfh.md";
const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

async function createDoc(dataRoot: string, bodies: Record<string, string>): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, DOC.replace(/^\//, ""));
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });

  await writeFile(
    skeletonPath,
    [
      "# Alpha",
      "{{section: sec_alpha.md}}",
      "",
      "# Beta",
      "{{section: sec_beta.md}}",
      "",
      "# Gamma",
      "{{section: sec_gamma.md}}",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const name of ["sec_alpha.md", "sec_beta.md", "sec_gamma.md"]) {
    await writeFile(join(sectionsDir, name), bodies[name] ?? "", "utf8");
  }
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "no-predecessor bfh doc",
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

/** Replace a fragment's whole content with `markdown` (models a Milkdown edit). */
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

describe("no-predecessor heading-deletion → BFH at quiescence", () => {
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

  it("demoting the first headed section moves its body under BFH and removes the headed identity", async () => {
    await createDoc(ctx.rootDir, { "sec_alpha.md": "Alpha body\n", "sec_beta.md": "Beta body\n" });
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const alpha = layout.find((e) => e.heading === "Alpha")!;
    expect(alpha).toBeDefined();
    expect(layout[0].fragmentKey).toBe(alpha.fragmentKey); // Alpha is first, no BFH above.

    // Demote Alpha: heading gone, body-only text remains in the fragment.
    setFragment(session, alpha.fragmentKey, "Alpha\n\nAlpha body");
    session.fragmentLastActivity.set(alpha.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [alpha.fragmentKey] });
    await fireQuiescence(session);

    const post = await resolveLiveSectionLayout(DOC, session.generator.getCurrentProposalId());
    // The headed "Alpha" identity is gone; a BFH preamble now leads the doc.
    expect(post.some((e) => e.heading === "Alpha")).toBe(false);
    expect(post[0].headingPath.length).toBe(0);
    expect(post.some((e) => e.heading === "Beta")).toBe(true);

    // Live set: Alpha's key unregistered, BFH registered.
    const keys = session.liveFragments.getFragmentKeys();
    expect(keys).not.toContain(alpha.fragmentKey);
    expect(keys).toContain(BEFORE_FIRST_HEADING_KEY);

    // BFH carries the orphan body.
    const bfh = session.liveFragments.readFragmentString(BEFORE_FIRST_HEADING_KEY) as string;
    expect(bfh).toContain("Alpha body");
    expect(bfh).not.toMatch(/^#\s/m);
  });

  it("still merges into the predecessor when one exists (Beta → Alpha)", async () => {
    await createDoc(ctx.rootDir, { "sec_alpha.md": "Alpha body\n", "sec_beta.md": "Beta body\n" });
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const alpha = layout.find((e) => e.heading === "Alpha")!;
    const beta = layout.find((e) => e.heading === "Beta")!;

    setFragment(session, beta.fragmentKey, "Beta\n\nBeta body");
    session.fragmentLastActivity.set(beta.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [beta.fragmentKey] });
    await fireQuiescence(session);

    const post = await resolveLiveSectionLayout(DOC, session.generator.getCurrentProposalId());
    // Beta merged into predecessor Alpha; no BFH was created.
    expect(post.some((e) => e.heading === "Beta")).toBe(false);
    expect(post.some((e) => e.heading === "Alpha")).toBe(true);
    expect(post.some((e) => e.headingPath.length === 0)).toBe(false);
    expect(session.liveFragments.getFragmentKeys()).not.toContain(beta.fragmentKey);
    expect(session.liveFragments.getFragmentKeys()).toContain(alpha.fragmentKey);

    // Alpha's fragment absorbed Beta's body.
    const alphaContent = session.liveFragments.readFragmentString(alpha.fragmentKey) as string;
    expect(alphaContent).toContain("Beta body");
  });
});
