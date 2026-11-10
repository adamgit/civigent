import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  normalizeQuiescedStructureForTest,
  processArbitratedClientUpdate,
  requestDocSessionPublish,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { resolvePersistedSectionLayout } from "../../crdt/live-section-layout.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readAssembledDocument } from "../../storage/document-reader.js";
import { systemDocRead } from "../../auth/authorized-read.js";
import { systemAuthority } from "../../auth/system-authority.js";
import { docPathToContentRelativeFsPath } from "../../storage/path-utils.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { DocPath } from "../../types/shared.js";

const DOC_PATH = "/ops/parent-split.md";
const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

async function createDocumentWithParentSection(dataRoot: string): Promise<void> {
  const skeletonPath = join(dataRoot, "content", docPathToContentRelativeFsPath(DocPath.parse(DOC_PATH)));
  const sectionsDir = `${skeletonPath}.sections`;
  const overviewSectionsDir = join(sectionsDir, "overview.md.sections");
  await mkdir(dirname(skeletonPath), { recursive: true });
  await mkdir(overviewSectionsDir, { recursive: true });

  await writeFile(skeletonPath, [
    "## Overview",
    "{{section: overview.md}}",
    "",
    "## Timeline",
    "{{section: timeline.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(sectionsDir, "overview.md"), [
    "{{section: --section-body--overview.md}}",
    "",
    "### Child",
    "{{section: child.md}}",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(overviewSectionsDir, "--section-body--overview.md"), "overview body\n", "utf8");
  await writeFile(join(overviewSectionsDir, "child.md"), "child body\n", "utf8");
  await writeFile(join(sectionsDir, "timeline.md"), "timeline body\n", "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    ["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "add parent-split doc", "--allow-empty"],
    dataRoot,
  );
}

async function applyClientFragmentEdit(
  session: DocSession,
  fragmentKey: string,
  content: FragmentContent,
): Promise<void> {
  const clientDoc = new Y.Doc();
  Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(session.ydoc));
  const clientStore = new LiveFragmentStringsStore(clientDoc, session.liveFragments.getFragmentKeys(), DOC_PATH);
  clientStore.replaceFragmentString(fragmentKey, content);
  const update = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(session.ydoc));
  clientDoc.destroy();
  await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));
}

function normalizeMarkdown(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

describe("typing a same-level heading at the end of a parent section's body", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createDocumentWithParentSection(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("places the new heading directly after the body and moves the existing child under it", async () => {
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(DOC_PATH, WRITER.id, baseHead, WRITER, "sock-parent-split");

    const initialLayout = await resolvePersistedSectionLayout(DOC_PATH, session.generator.getCurrentProposalId());
    const overview = initialLayout.find((entry) => entry.heading === "Overview");
    expect(overview).toBeDefined();

    await applyClientFragmentEdit(
      session,
      overview!.fragmentKey,
      "## Overview\n\noverview body\n\n## New\n\nnew body" as FragmentContent,
    );
    await session.enqueue(() => normalizeQuiescedStructureForTest(session));

    const settledLayout = await resolvePersistedSectionLayout(DOC_PATH, session.generator.getCurrentProposalId());
    expect(settledLayout.map((entry) => entry.headingPath)).toEqual([
      ["Overview"],
      ["New"],
      ["New", "Child"],
      ["Timeline"],
    ]);

    const outcome = await requestDocSessionPublish(DOC_PATH);
    await session.enqueue(() => undefined);
    expect(outcome).toMatchObject({ outcome: "committed" });

    const assembled = await readAssembledDocument(
      systemDocRead(systemAuthority("test read"), DocPath.parse(DOC_PATH)),
    );
    expect(normalizeMarkdown(assembled)).toBe(normalizeMarkdown([
      "## Overview",
      "overview body",
      "## New",
      "new body",
      "### Child",
      "child body",
      "## Timeline",
      "timeline body",
    ].join("\n\n")));
  });
});
