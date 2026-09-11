import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import {
  acquireDocSession,
  destroyAllSessions,
  lookupDocSession,
  type DocSession,
} from "../../crdt/ydoc-lifecycle.js";
import { resolvePersistedSectionLayout } from "../../crdt/live-section-layout.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { getDataRoot } from "../../storage/data-root.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { ProposalShadowContentLayer } from "../../storage/content-layer.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  requestDocSessionPublish,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { buildWireLiveSectionsState } from "../../crdt/live-sections-wire-state.js";
import { unclaimedOwnedHeadings } from "../../storage/proposal-overlay-ownership.js";
import { readSection } from "../../storage/section-reader.js";
import { documentTargetRef, DocPath } from "../../types/shared.js";
import {
  createTransientProposal,
  readProposal,
  unsafeReplaceProposalManifestForRecoveryOnly,
} from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { publishMergeToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import {
  createTempDataRoot,
  type TempDataRootContext,
} from "../helpers/temp-data-root.js";

const WRITER = {
  id: "user-alice",
  type: "human" as const,
  displayName: "Alice",
};
const DOC_PATH = "/ops/bfh-root-split.md";

async function createEmptyDocument(ctx: TempDataRootContext): Promise<void> {
  const layer = new ProposalShadowContentLayer(ctx.contentDir, ctx.contentDir);
  await layer.createDocument(DOC_PATH);
  await gitExec(["add", "content/"], ctx.rootDir);
  await gitExec(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.local",
      "commit",
      "-m",
      "add empty document",
      "--allow-empty",
      "--trailer",
      "Writer-Type: agent",
    ],
    ctx.rootDir,
  );
}

async function createBfhOnlyCanonical(ctx: TempDataRootContext, body: string): Promise<void> {
  const skeletonPath = join(ctx.contentDir, DOC_PATH.replace(/^\//, ""));
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(sectionsDir, { recursive: true });
  await writeFile(skeletonPath, ["{{section: --before-first-heading--bfhsplit.md}}", ""].join("\n"), "utf8");
  await writeFile(join(sectionsDir, "--before-first-heading--bfhsplit.md"), `${body}\n`, "utf8");
  await gitExec(["add", "content/"], ctx.rootDir);
  await gitExec(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.local",
      "commit",
      "-m",
      "add bfh-only document",
      "--allow-empty",
      "--trailer",
      "Writer-Type: agent",
    ],
    ctx.rootDir,
  );
}

async function openSession(socketId: string): Promise<DocSession> {
  return acquireDocSession(
    DOC_PATH,
    WRITER.id,
    await getHeadSha(getDataRoot()),
    WRITER,
    socketId,
  );
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(
    session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50,
  );
  await session.enqueue(() => undefined);
}

describe("BFH root-split lifecycle", () => {
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

  it.each([
    {
      caseName: "empty preamble dissolves",
      markdown: "## Heading\n\nHeading body.",
      expectedPaths: [["Heading"]] as string[][],
      expectedPreamble: null,
    },
    {
      caseName: "non-empty preamble remains",
      markdown: "Preamble text.\n\n## Heading\n\nHeading body.",
      expectedPaths: [[], ["Heading"]] as string[][],
      expectedPreamble: "Preamble text.",
    },
  ])(
    "$caseName through quiescence and reconstruction",
    async ({ markdown, expectedPaths, expectedPreamble }) => {
      await createEmptyDocument(ctx);
      vi.useFakeTimers();

      const session = await openSession("sock-1");
      disposers.push(
        registerFakeEditorSocketForTest(DOC_PATH, "editor-sock").dispose,
      );

      session.liveFragments.replaceFragmentString(
        BEFORE_FIRST_HEADING_KEY,
        markdown as FragmentContent,
      );
      session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());
      await session.generator.materializeEdit({
        touchedFragmentKeys: [BEFORE_FIRST_HEADING_KEY],
      });
      await fireQuiescence(session);

      const proposalId = session.generator.getCurrentProposalId();
      expect(proposalId).not.toBeNull();

      const reader = ProposalReader.open(proposalId!, "inprogress");
      expect(await reader.listHeadingPaths(DOC_PATH)).toEqual(expectedPaths);
      expect(
        await reader.readEffectiveSection(DOC_PATH, ["Heading"]),
      ).toBe("Heading body.");

      const layout = await resolvePersistedSectionLayout(DOC_PATH, proposalId);
      const promoted = layout.find(
        (entry) =>
          entry.headingPath.length === 1 &&
          entry.headingPath[0] === "Heading",
      );
      expect(promoted).toBeDefined();
      expect(promoted?.fragmentKey).not.toBe(BEFORE_FIRST_HEADING_KEY);
      expect(
        session.liveFragments.readFragmentString(promoted!.fragmentKey),
      ).toContain("Heading body.");

      const bfhPresent = layout.some(
        (entry) => entry.headingPath.length === 0,
      );
      expect(bfhPresent).toBe(expectedPreamble !== null);
      expect(
        session.liveFragments
          .getFragmentKeys()
          .includes(BEFORE_FIRST_HEADING_KEY),
      ).toBe(expectedPreamble !== null);
      if (expectedPreamble !== null) {
        expect(
          await reader.readEffectiveSection(DOC_PATH, []),
        ).toBe(expectedPreamble);
      }

      destroyAllSessions();
      const reopened = await openSession("sock-2");
      const reopenedProposalId = reopened.generator.getCurrentProposalId();
      expect(reopenedProposalId).toBe(proposalId);

      const reopenedReader = ProposalReader.open(
        reopenedProposalId!,
        "inprogress",
      );
      expect(await reopenedReader.listHeadingPaths(DOC_PATH)).toEqual(
        expectedPaths,
      );
      expect(
        await reopenedReader.readEffectiveSection(DOC_PATH, ["Heading"]),
      ).toBe("Heading body.");
      expect(
        reopened.liveFragments
          .getFragmentKeys()
          .includes(BEFORE_FIRST_HEADING_KEY),
      ).toBe(expectedPreamble !== null);
    },
  );

  // Dissolve records the canonical preamble file as deleted and unions only the
  // promoted heading. The claim set must still include `[]` (claimed-but-absent)
  // or publish refuses. Drive settle without a prior `[]` grow so this is that
  // pairing, not first-touch materialize.
  it("empty preamble dissolve leaves no unclaimed overlay ownership and publishes", async () => {
    await createBfhOnlyCanonical(ctx, "");
    vi.useFakeTimers();

    const session = await openSession("sock-1");
    const editor = registerFakeEditorSocketForTest(DOC_PATH, "editor-sock");
    disposers.push(editor.dispose);

    session.liveFragments.replaceFragmentString(
      BEFORE_FIRST_HEADING_KEY,
      "## Heading\n\nHeading body." as FragmentContent,
    );
    session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());
    await session.generator.ensureAuthoredProposalClaiming([
      { doc_path: DocPath.parse(DOC_PATH), heading_path: ["Heading"] },
    ]);
    await fireQuiescence(session);

    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).not.toBeNull();

    editor.dispose();

    const unclaimed = await unclaimedOwnedHeadings(proposalId!, "inprogress");
    expect(unclaimed.map((a) => a.headingPath)).toEqual([]);

    vi.useRealTimers();
    const outcome = await requestDocSessionPublish(DOC_PATH);
    expect(outcome.outcome).toBe("committed");
    expect(await readSection(DOC_PATH, ["Heading"])).toBe("Heading body.");
  });

  it("after force-publish of an empty-doc BFH paste, live layout and wire state still have the heading", async () => {
    await createEmptyDocument(ctx);
    vi.useFakeTimers();

    const session = await openSession("sock-1");
    const editor = registerFakeEditorSocketForTest(DOC_PATH, "editor-sock");
    disposers.push(editor.dispose);

    session.liveFragments.replaceFragmentString(
      BEFORE_FIRST_HEADING_KEY,
      "## Heading\n\nHeading body." as FragmentContent,
    );
    session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());
    await session.generator.materializeEdit({
      touchedFragmentKeys: [BEFORE_FIRST_HEADING_KEY],
    });
    await fireQuiescence(session);

    const liveProposalId = session.generator.getCurrentProposalId();
    expect(liveProposalId).not.toBeNull();
    const { id: extraId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "add extra section after the live proposal opened",
    );
    await mutateProposalContent(extraId, {
      kind: "write_section",
      docPath: DOC_PATH,
      headingPath: ["Extra"],
      heading: "Extra",
      content: "EXTRA COMMITTED AFTER THE LIVE PROPOSAL OPENED",
    });
    await publishMergeToCanonicalDetailed(extraId, {});
    const liveProposal = await readProposal(liveProposalId!);
    await unsafeReplaceProposalManifestForRecoveryOnly(
      liveProposalId!,
      liveProposal.sections,
      undefined,
      [documentTargetRef(DOC_PATH)],
    );

    editor.dispose();
    vi.useRealTimers();
    const outcome = await requestDocSessionPublish(DOC_PATH);
    expect(outcome.outcome).toBe("committed");
    expect(session.generator.getCurrentProposalId()).toBeNull();
    expect(await readSection(DOC_PATH, ["Heading"])).toBe("Heading body.");
    expect(await readSection(DOC_PATH, ["Extra"])).toBe(
      "EXTRA COMMITTED AFTER THE LIVE PROPOSAL OPENED",
    );

    const layout = await resolvePersistedSectionLayout(
      DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    expect(
      layout.some((entry) => entry.headingPath.length === 1 && entry.headingPath[0] === "Heading"),
    ).toBe(true);
    expect(
      layout.length === 1 && layout[0]!.headingPath.length === 0,
    ).toBe(false);

    const wire = await session.enqueue(() => buildWireLiveSectionsState(session));
    expect(
      wire.topology.some((ref) => ref.heading_path.length === 1 && ref.heading_path[0] === "Heading"),
    ).toBe(true);
    expect(
      wire.topology.length === 1 && wire.topology[0]!.heading_path.length === 0,
    ).toBe(false);
  });

  it("discards and reseeds when proposal-first root-split reflection cannot reach the live Y.Doc", async () => {
    await createEmptyDocument(ctx);
    vi.useFakeTimers();

    const session = await openSession("sock-1");
    disposers.push(
      registerFakeEditorSocketForTest(DOC_PATH, "editor-sock").dispose,
    );

    session.liveFragments.replaceFragmentString(
      BEFORE_FIRST_HEADING_KEY,
      "Preamble text.\n\n## Promoted\n\nPromoted body." as FragmentContent,
    );
    session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());
    await session.generator.materializeEdit({
      touchedFragmentKeys: [BEFORE_FIRST_HEADING_KEY],
    });

    let forcedMovements = 0;
    const forceAffectedFragmentMovement = (): void => {
      forcedMovements++;
      session.ydoc
        .getXmlFragment(BEFORE_FIRST_HEADING_KEY)
        .insert(
          session.ydoc.getXmlFragment(BEFORE_FIRST_HEADING_KEY).length,
          [new Y.XmlElement("paragraph")],
        );
    };
    session.ydoc.on("beforeTransaction", forceAffectedFragmentMovement);

    await fireQuiescence(session);

    session.ydoc.off("beforeTransaction", forceAffectedFragmentMovement);
    expect({
      forcedMovements,
      sessionState: session.state,
      sessionStillRegistered: lookupDocSession(DOC_PATH) !== undefined,
    }).toEqual({
      forcedMovements: 2,
      sessionState: "ended",
      sessionStillRegistered: false,
    });

    const reopened = await openSession("sock-2");
    const proposalId = reopened.generator.getCurrentProposalId();
    expect(proposalId).not.toBeNull();

    const reader = ProposalReader.open(proposalId!, "inprogress");
    const paths = await reader.listHeadingPaths(DOC_PATH);
    expect(
      paths.filter(
        (path) => path.length === 1 && path[0] === "Promoted",
      ),
    ).toHaveLength(1);
    expect(
      reopened.liveFragments.readFragmentString(BEFORE_FIRST_HEADING_KEY),
    ).not.toContain("## Promoted");
    expect(
      await reader.readEffectiveSection(DOC_PATH, ["Promoted"]),
    ).toBe("Promoted body.");
  });
});
