/**
 * Canary: live-renaming a parent must claim the re-keyed child and grandchild.
 *
 * A heading rename changes every descendant's heading-path prefix. Overlay
 * ownership treats that as moved-at-the-new-address. The live reflection
 * (`reflectHeadingEditIntoProposal`) currently unions only the renamed node,
 * so `unclaimedOwnedHeadings` lists the descendants and publish refuses —
 * the production force-publish crash after renaming "Percona actions".
 *
 * This must go through CRDT ingress + settle, not `mutateProposalContent`
 * `rename_section` (that path already claims the subtree and would stay green).
 * The grandchild exists so a "direct children only" claim fix still fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  normalizeQuiescedStructureForTest,
  processArbitratedClientUpdate,
  requestDocSessionPublish,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { publishProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { unclaimedOwnedHeadings } from "../../storage/proposal-overlay-ownership.js";
import { readSection } from "../../storage/section-reader.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const DOC = "/canary/parent-rename.md";

function buildClientUpdate(session: DocSession, key: string, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), DOC);
  tempStore.replaceFragmentString(key, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

async function seedNestedCanonical(): Promise<void> {
  const { id } = await createTransientProposal(WRITER, "seed parent > child > grandchild");
  await mutateProposalContent(id, {
    kind: "write_section",
    docPath: DOC,
    headingPath: ["Parent"],
    heading: "Parent",
    content: "parent intro body",
  });
  await mutateProposalContent(id, {
    kind: "write_section",
    docPath: DOC,
    headingPath: ["Parent", "Child"],
    heading: "Child",
    content: "child body",
  });
  await mutateProposalContent(id, {
    kind: "write_section",
    docPath: DOC,
    headingPath: ["Parent", "Child", "Grandchild"],
    heading: "Grandchild",
    content: "grandchild body",
  });
  await publishProposalToCanonicalDetailed(id, {});
}

describe("live parent rename claims re-keyed descendants", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await seedNestedCanonical();
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    setCrdtEventHandler(() => undefined);
    resetCoordinatorPublishStateForTest();
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("renaming a parent with a child and grandchild leaves no unclaimed overlay ownership and publishes", async () => {
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(DOC, WRITER.id, baseHead, WRITER, "sock-1");

    const layout = await resolveLiveSectionLayout(DOC, null);
    const parent = layout.find(
      (e) => SectionRef.headingKey(e.headingPath) === SectionRef.headingKey(["Parent"]),
    );
    expect(parent).toBeDefined();
    expect(layout.some((e) => SectionRef.headingKey(e.headingPath) === SectionRef.headingKey(["Parent", "Child"]))).toBe(true);
    expect(
      layout.some(
        (e) => SectionRef.headingKey(e.headingPath) === SectionRef.headingKey(["Parent", "Child", "Grandchild"]),
      ),
    ).toBe(true);

    const renamed = [
      `${"#".repeat(parent!.headingLevel)} Renamed`,
      "",
      "parent intro body",
      "",
    ].join("\n") as FragmentContent;

    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, buildClientUpdate(session, parent!.fragmentKey, renamed)),
    );

    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).toBeTruthy();

    await session.enqueue(() => normalizeQuiescedStructureForTest(session));

    const unclaimed = await unclaimedOwnedHeadings(proposalId!, "inprogress");
    expect(unclaimed.map((a) => a.headingPath)).toEqual([]);

    const outcome = await requestDocSessionPublish(DOC);
    expect(outcome.outcome).toBe("committed");

    expect(await readSection(DOC, ["Renamed"])).toContain("parent intro body");
    expect(await readSection(DOC, ["Renamed", "Child"])).toContain("child body");
    expect(await readSection(DOC, ["Renamed", "Child", "Grandchild"])).toContain("grandchild body");
  });
});
