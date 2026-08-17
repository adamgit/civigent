/**
 * High-value contracts for BUG1 display authority + BUG2 real delete.
 *
 * Expected today: these FAIL (red). They encode the fixed end-state, not the
 * current crash/repro characterization in consecutive-h1-demotion-bug-repro.
 *
 *   F3 — live workspace `content` must equal the live fragment (no prepend invent)
 *   F6 — after quiescence merge, a write to the removed key must not fatal the gate
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
import { readWorkspaceSectionList } from "../../api/application/sections.js";
import { systemDocRead } from "../../auth/authorized-read.js";
import { systemAuthority } from "../../auth/system-authority.js";
import { DocPath } from "../../types/shared.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const DOC = "/test/todo/authority-contracts.md";
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
    ].join("\n"),
    "utf8",
  );
  for (const name of ["/sec_alpha.md", "/sec_beta.md", "/sec_gamma.md"]) {
    await writeFile(join(sectionsDir, name), "", "utf8");
  }
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "authority contract repro doc",
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

function demoteHeading(session: DocSession, key: string, formerHeadingText: string): void {
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

describe("live display authority + real delete contracts (expect RED today)", () => {
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

  it("F3: after demote, live workspace section content equals the live fragment (no prepend invent)", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(DOC, "editor-sock").dispose);

    const layout = await resolveLiveSectionLayout(DOC, null);
    const beta = layout.find((e) => e.heading === "Beta")!;
    expect(beta).toBeDefined();

    demoteHeading(session, beta.fragmentKey, "Beta");
    session.fragmentLastActivity.set(beta.fragmentKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [beta.fragmentKey] });

    const live = session.liveFragments.readFragmentString(beta.fragmentKey) as string;
    expect(live).not.toMatch(/^#\s/m);

    const { response } = await readWorkspaceSectionList(
      systemDocRead(systemAuthority("test read"), DocPath.parse(DOC)),
    );
    const workspaceSection = response.sections.find((s) => s.fragment_key === beta.fragmentKey);
    expect(workspaceSection).toBeDefined();

    // Fixed contract: while a DocSession is live, workspace `content` is the fragment.
    // Today prependHeadings re-attaches the skeleton H1 → this assertion fails.
    expect(workspaceSection!.content).toBe(live);
  });

  it("F6: after quiescence merge, a client write to the removed section must not fatal the acceptance gate", async () => {
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

    const ghost = buildClientUpdate(session, beta.fragmentKey, "Beta still typing" as FragmentContent);

    // Fixed contract: real delete → this flow must not hit the hard gate fatal.
    // Today the leftover writable slot still reaches `/no section identity/` → fails.
    await expect(
      session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, ghost)),
    ).resolves.toBeUndefined();
  });
});
