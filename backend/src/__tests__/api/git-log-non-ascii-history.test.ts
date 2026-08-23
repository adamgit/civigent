import { afterEach, describe, expect, it } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument } from "../helpers/sample-content.js";
import { getReadableGitLog } from "../../api/application/git.js";
import type { AuthenticatedWriter } from "../../auth/context.js";

const NON_ASCII_DOC_PATH = "/ops/стратегия.md";

const READER: AuthenticatedWriter = {
  id: "human-1",
  type: "human",
  displayName: "Reader",
};

let activeContext: TempDataRootContext | null = null;

afterEach(async () => {
  if (activeContext) {
    await activeContext.cleanup();
    activeContext = null;
  }
});

describe("repo-wide git history for documents whose names are not ASCII", () => {
  it("keeps a commit that touches only a non-ASCII-named document", async () => {
    activeContext = await createTempDataRoot();
    await createSampleDocument(activeContext.rootDir, NON_ASCII_DOC_PATH);

    const entries = await getReadableGitLog(READER, { limit: 30, offset: 0 });

    // The readable-log filter maps each commit's changed files back to document
    // paths and drops commits with no readable document. A commit whose paths do
    // not map disappears from history entirely — silently, for every user.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.changed_files.some((file) => file.includes("стратегия.md"))).toBe(true);
  });
});
