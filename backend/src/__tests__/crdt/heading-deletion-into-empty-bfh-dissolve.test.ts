/**
 * Empty-BFH lifecycle, heading-deletion arm: demoting a heading whose orphan
 * body is empty and whose predecessor is an ALREADY-empty BFH must dissolve
 * that BFH rather than leave it as empty split residue. Companion to the
 * root-split arm covered by `bfh-root-split-lifecycle.test.ts` and
 * `bfh-root-split-keeps-nonempty-preamble.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const DOC = "/test/todo/heading-into-empty-bfh.md";
const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

async function createDoc(dataRoot: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, DOC.replace(/^\//, ""));
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });
  await writeFile(
    skeletonPath,
    [
      "{{section: --before-first-heading--bfh.md}}",
      "",
      "# Alpha",
      "{{section: sec_alpha.md}}",
      "",
      "# Beta",
      "{{section: sec_beta.md}}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(sectionsDir, "--before-first-heading--bfh.md"), "", "utf8");
  await writeFile(join(sectionsDir, "/sec_alpha.md"), "Alpha body\n", "utf8");
  await writeFile(join(sectionsDir, "/sec_beta.md"), "Beta body\n", "utf8");
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "bfh + alpha + beta doc",
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

describe("heading-deletion settling into an already-empty BFH dissolves it", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length > 0) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    resetCoordinatorPublishStateForTest();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("dissolves the empty BFH instead of leaving it as empty split residue", async () => {
    await createDoc(ctx.rootDir);
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const alpha = layout.find((e) => e.heading === "Alpha")!;
    expect(alpha).toBeDefined();

    // Demote Alpha with an EMPTY orphan body: the heading is gone and there is
    // nothing to merge. Its predecessor (BFH) is already empty, so the merge
    // target settles empty too.
    setFragment(session, alpha.fragmentKey, "");
    session.fragmentLastActivity.set(alpha.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [alpha.fragmentKey] });
    await fireQuiescence(session);

    const post = await resolveLiveSectionLayout(DOC, session.generator.getCurrentProposalId());
    expect(post.some((e) => e.headingPath.length === 0)).toBe(false);
    expect(post.some((e) => e.heading === "Alpha")).toBe(false);
    expect(post.some((e) => e.heading === "Beta")).toBe(true);

    expect(session.liveFragments.getFragmentKeys()).not.toContain(BEFORE_FIRST_HEADING_KEY);
    expect(session.liveFragments.getFragmentKeys()).not.toContain(alpha.fragmentKey);
  });
});
