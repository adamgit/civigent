import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  normalizeQuiescedStructureForTest,
  processArbitratedClientUpdate,
  requestDocSessionPublish,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readAssembledDocument } from "../../storage/document-reader.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

function normalizeMarkdown(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

async function drainLane(session: DocSession): Promise<void> {
  await session.enqueue(() => undefined);
}

async function applyClientFragmentEdit(
  session: DocSession,
  fragmentKey: string,
  content: FragmentContent,
): Promise<void> {
  const clientDoc = new Y.Doc();
  Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(session.ydoc));
  const clientStore = new LiveFragmentStringsStore(
    clientDoc,
    session.liveFragments.getFragmentKeys(),
    SAMPLE_DOC_PATH,
  );
  clientStore.replaceFragmentString(fragmentKey, content);
  const update = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(session.ydoc));
  clientDoc.destroy();
  await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));
}

interface RoundtripCase {
  name: string;
  overviewFragment: string;
  expectedDocBlocks: string[];
}

const CASES: RoundtripCase[] = [
  {
    name: "control: clean body edit",
    overviewFragment: "## Overview\n\nrewritten overview body",
    expectedDocBlocks: [
      SAMPLE_SECTIONS.preamble,
      "## Overview",
      "rewritten overview body",
      "## Timeline",
      SAMPLE_SECTIONS.timeline,
    ],
  },
  {
    name: "insert-below: a new sibling section typed below the survivor",
    overviewFragment: "## Overview\n\nkept overview body\n\n## Added Below\n\nbelow body",
    expectedDocBlocks: [
      SAMPLE_SECTIONS.preamble,
      "## Overview",
      "kept overview body",
      "## Added Below",
      "below body",
      "## Timeline",
      SAMPLE_SECTIONS.timeline,
    ],
  },
  {
    name: "preamble-relocated: orphan text above the matching heading joins the body",
    overviewFragment: "stray intro\n\n## Overview\n\nkept overview body",
    expectedDocBlocks: [
      SAMPLE_SECTIONS.preamble,
      "## Overview",
      "kept overview body",
      "stray intro",
      "## Timeline",
      SAMPLE_SECTIONS.timeline,
    ],
  },
  {
    name: "insert-above: a new sibling section typed above the survivor",
    overviewFragment: "## Added Above\n\nabove body\n\n## Overview\n\nkept overview body",
    expectedDocBlocks: [
      SAMPLE_SECTIONS.preamble,
      "## Added Above",
      "above body",
      "## Overview",
      "kept overview body",
      "## Timeline",
      SAMPLE_SECTIONS.timeline,
    ],
  },
  {
    name: "insert-above-multiple: several new sections typed above the survivor",
    overviewFragment: "## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n\n## Overview\n\nkept overview body",
    expectedDocBlocks: [
      SAMPLE_SECTIONS.preamble,
      "## Alpha",
      "alpha body",
      "## Beta",
      "beta body",
      "## Overview",
      "kept overview body",
      "## Timeline",
      SAMPLE_SECTIONS.timeline,
    ],
  },
  {
    name: "rename-plus-add: the survivor is renamed while a new section is added",
    overviewFragment: "## Overview Renamed\n\nkept overview body\n\n## Extra Tail\n\ntail body",
    expectedDocBlocks: [
      SAMPLE_SECTIONS.preamble,
      "## Overview Renamed",
      "kept overview body",
      "## Extra Tail",
      "tail body",
      "## Timeline",
      SAMPLE_SECTIONS.timeline,
    ],
  },
];

describe("legal-edit publish round-trip: every accepted shape publishes and assembles to what the author saw", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const baseHead = await getHeadSha(getDataRoot());
      const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-rt");

      session.liveFragments.replaceFragmentString(OVERVIEW_KEY, c.overviewFragment as FragmentContent);
      session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
      await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

      const outcome = await requestDocSessionPublish(SAMPLE_DOC_PATH);
      await drainLane(session);
      expect(outcome).toMatchObject({ outcome: "committed" });

      const assembled = await readAssembledDocument(SAMPLE_DOC_PATH);
      expect(normalizeMarkdown(assembled)).toBe(normalizeMarkdown(c.expectedDocBlocks.join("\n\n")));
    });
  }

  it("repeated insert-above settles a proposal-only survivor and publishes A, B, Overview, Timeline", async () => {
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-repeat-above");

    await applyClientFragmentEdit(
      session,
      OVERVIEW_KEY,
      "## B\n\nB body\n\n## Overview\n\nkept overview body" as FragmentContent,
    );
    await session.enqueue(() => normalizeQuiescedStructureForTest(session));

    const layoutAfterB = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    const b = layoutAfterB.find((entry) => entry.heading === "B");
    expect(b).toBeDefined();

    await applyClientFragmentEdit(
      session,
      b!.fragmentKey,
      "## A\n\nA body\n\n## B\n\nB body" as FragmentContent,
    );
    await session.enqueue(() => normalizeQuiescedStructureForTest(session));

    const layoutAfterA = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    expect(
      layoutAfterA.filter((entry) => entry.heading.length > 0).map((entry) => entry.heading),
    ).toEqual(["A", "B", "Overview", "Timeline"]);

    const outcome = await requestDocSessionPublish(SAMPLE_DOC_PATH);
    await drainLane(session);
    expect(outcome).toMatchObject({ outcome: "committed" });

    const assembled = await readAssembledDocument(SAMPLE_DOC_PATH);
    expect(normalizeMarkdown(assembled)).toBe(
      normalizeMarkdown(
        [
          SAMPLE_SECTIONS.preamble,
          "## A",
          "A body",
          "## B",
          "B body",
          "## Overview",
          "kept overview body",
          "## Timeline",
          SAMPLE_SECTIONS.timeline,
        ].join("\n\n"),
      ),
    );
  });
});
