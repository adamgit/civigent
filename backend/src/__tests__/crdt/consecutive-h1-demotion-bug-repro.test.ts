/**
 * Minimal repro of the consecutive-H1 demotion bug report:
 *   demote heading → move to next section → (BUG1?) previous looks like H1 again
 *   → demote further → quiescence merge → later write to removed key (BUG2 crash)
 *
 * These tests ask the shared live document what actually happened — no UI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import * as Y from "yjs";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec, getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  processArbitratedClientUpdate,
  registerFakeEditorSocketForTest,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const DOC = "/test/todo/Sunday-repro.md";
const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

async function createConsecutiveH1Doc(dataRoot: string): Promise<void> {
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
      "# Delta",
      "{{section: sec_delta.md}}",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const name of ["/sec_alpha.md", "/sec_beta.md", "/sec_gamma.md", "/sec_delta.md"]) {
    await writeFile(join(sectionsDir, name), "", "utf8");
  }
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "consecutive h1 repro doc",
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

function demoteHeading(session: DocSession, key: string, formerHeadingText: string): void {
  // Milkdown DowngradeHeading shape: former heading text as body, no heading node.
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(formerHeadingText));
  session.ydoc.transact(() =>
    updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }),
  );
}

function buildClientUpdate(
  session: DocSession,
  fragmentKey: string,
  content: FragmentContent,
): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(
    temp,
    session.liveFragments.getFragmentKeys(),
    DOC,
  );
  tempStore.replaceFragmentString(fragmentKey, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
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

describe("consecutive H1 demotion bug report repro", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createConsecutiveH1Doc(ctx.rootDir);
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

  it("BUG1 probe: after demote + edit next section, shared doc does NOT restore the H1 by itself", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const beta = layout.find((e) => e.heading === "Beta")!;
    const gamma = layout.find((e) => e.heading === "Gamma")!;
    expect(beta).toBeDefined();
    expect(gamma).toBeDefined();

    // Step: backspace at start of Beta H1 → body.
    demoteHeading(session, beta.fragmentKey, "Beta");
    session.fragmentLastActivity.set(beta.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [beta.fragmentKey] });

    const afterDemote = session.liveFragments.readFragmentString(beta.fragmentKey) as string;
    expect(afterDemote).not.toMatch(/^#\s/m);
    expect(afterDemote).toContain("Beta");

    // Step: move down to next row / next section and type there (only activity elsewhere).
    demoteHeading(session, gamma.fragmentKey, "Gamma");
    session.fragmentLastActivity.set(gamma.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [gamma.fragmentKey] });

    // If snapback were a silent shared-doc restore of Beta's heading, it shows here.
    const afterMoveOn = session.liveFragments.readFragmentString(beta.fragmentKey) as string;
    expect(afterMoveOn).not.toMatch(/^#\s/m);
    expect(afterMoveOn).toContain("Beta");
  });

  it("BUG2 fixed: after quiescence merge, a late client write to the removed section is dropped, not fatal", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const beta = layout.find((e) => e.heading === "Beta")!;

    demoteHeading(session, beta.fragmentKey, "Beta");
    session.fragmentLastActivity.set(beta.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [beta.fragmentKey] });
    await fireQuiescence(session);

    const post = await resolveLiveSectionLayout(DOC, session.generator.getCurrentProposalId());
    expect(post.some((e) => e.heading === "Beta")).toBe(false);
    expect(session.liveFragments.getFragmentKeys()).not.toContain(beta.fragmentKey);

    // Ghost write: still-bound client echoes into the leftover share key. It is an
    // expected delete-under-you (the section was already merged away), so the gate
    // reverts + forces off instead of the corruption fatal — no throw.
    const ghost = buildClientUpdate(session, beta.fragmentKey, "Beta still typing" as FragmentContent);

    await expect(
      session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, ghost)),
    ).resolves.toBeUndefined();

    // The ghost content was dropped and the key stays unregistered (delete stands).
    expect(session.liveFragments.getFragmentKeys()).not.toContain(beta.fragmentKey);
    const postGhost = await resolveLiveSectionLayout(DOC, session.generator.getCurrentProposalId());
    expect(postGhost.some((e) => e.heading === "Beta")).toBe(false);
  });
});
