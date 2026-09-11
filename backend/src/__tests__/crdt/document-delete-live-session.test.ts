/**
 * Workspace document delete while a DocSession exists uses that session's
 * inprogress proposal, commits the tombstone, tears the session down, and
 * closes sockets with 4026 (spec 05 §Document delete).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
  lookupDocSession,
} from "../../crdt/ydoc-lifecycle.js";
import {
  registerFakeEditorSocketForTest,
  registerFakeObserverSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { deleteDocument } from "../../api/application/documents.js";
import { canonicalDocumentExists } from "../../storage/document-reader.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { DocPath } from "../../types/shared.js";
import { WS_CLOSE_DOCUMENT_REPLACED } from "../../ws/crdt-ws-frames.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const WS_CLOSE_DOCUMENT_DELETED = 4026;

describe("document delete with a live DocSession (spec 05 §Document delete)", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => {});
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("commits the same inprogress proposal, removes canonical, and closes sockets with 4026", async () => {
    const docPath = DocPath.parse(SAMPLE_DOC_PATH);
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(docPath, WRITER.id, baseHead, WRITER, "sock-1");

    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("unpublished live overview" as SectionBody, 2, "Overview"),
    );
    const proposalId = await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

    let editorClose = 0;
    let observerClose = 0;
    disposers.push(
      registerFakeEditorSocketForTest(docPath, "editor-1", undefined, (code) => { editorClose = code; }).dispose,
    );
    disposers.push(
      registerFakeObserverSocketForTest(docPath, "observer-1", (code) => { observerClose = code; }).dispose,
    );

    const result = await deleteDocument(docPath, WRITER);
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(result.proposalId).toBe(proposalId);

    const committed = await readProposal(proposalId);
    expect(committed.status).toBe("committed");

    expect(await canonicalDocumentExists(docPath)).toBe(false);
    expect(lookupDocSession(docPath)).toBeUndefined();

    expect(editorClose).toBe(WS_CLOSE_DOCUMENT_DELETED);
    expect(observerClose).toBe(WS_CLOSE_DOCUMENT_DELETED);
    expect(editorClose).not.toBe(WS_CLOSE_DOCUMENT_REPLACED);
  });
});
