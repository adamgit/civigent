/**
 * collectSectionLayers — union-source section-row universe tests.
 *
 * Validates the four observation sources (canonical skeleton, overlay-only
 * skeleton, raw fragment sidecars, live CRDT session) are merged by
 * fragmentKey, that synthetic "__fragment_only__::" rows appear when a
 * fragment has no skeleton backing, that canonical/overlay/fragment/crdt
 * columns reflect file-level reads at each layer, and that the
 * overlay-vs-canonical structure divergence check fires correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  getContentRoot,
  getSessionSectionsContentRoot,
  getSessionFragmentsRoot,
} from "../../storage/data-root.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";
import {
  acquireDocSession,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import {
  buildDocumentDiagnostics,
} from "../../diagnostics/document-diagnostics/build-document-diagnostics.js";
import type { WriterIdentity } from "../../types/shared.js";

const DOC_PATH = "ops/strategy.md";

const writer: WriterIdentity = {
  id: "human-test-user",
  type: "human",
  displayName: "Diag Test Writer",
  email: "diag@test.local",
};

async function writeSkeletonAt(
  root: string,
  docPath: string,
  body: string,
): Promise<string> {
  const skeletonPath = resolveSkeletonPath(docPath, root);
  await mkdir(path.dirname(skeletonPath), { recursive: true });
  await writeFile(skeletonPath, body, "utf8");
  return skeletonPath;
}

async function writeSectionAt(
  root: string,
  docPath: string,
  sectionFile: string,
  body: string,
): Promise<string> {
  const skeletonPath = resolveSkeletonPath(docPath, root);
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(sectionsDir, { recursive: true });
  const full = path.join(sectionsDir, sectionFile);
  await writeFile(full, body, "utf8");
  return full;
}

async function writeRawFragment(
  docPath: string,
  fileName: string,
  body: string,
): Promise<void> {
  const dir = path.join(getSessionFragmentsRoot(), docPath);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), body, "utf8");
}

async function commitContent(dataRoot: string, message: string): Promise<void> {
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", message,
      "--allow-empty",
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

describe("collectSectionLayers: union-source section-row universe", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("(i) section exists only in overlay — row appears with overlay column populated, canonical absent", async () => {
    const canonicalRoot = getContentRoot();
    const overlayRoot = getSessionSectionsContentRoot();

    // Canonical has a different section
    await writeSkeletonAt(canonicalRoot, DOC_PATH, ["## Alpha", "{{section: sec_alpha.md}}"].join("\n"));
    await writeSectionAt(canonicalRoot, DOC_PATH, "sec_alpha.md", "alpha body");

    // Overlay adds a new section Beta (no canonical counterpart)
    await writeSkeletonAt(
      overlayRoot,
      DOC_PATH,
      ["## Alpha", "{{section: sec_alpha.md}}", "## Beta", "{{section: sec_beta.md}}"].join("\n"),
    );
    await writeSectionAt(overlayRoot, DOC_PATH, "sec_alpha.md", "alpha body overlay");
    await writeSectionAt(overlayRoot, DOC_PATH, "sec_beta.md", "beta body overlay");

    await commitContent(ctx.rootDir, "seed");

    const diag = await buildDocumentDiagnostics(DOC_PATH);
    const betaRow = diag.sections.find((s) => s.sectionFile === "sec_beta.md");
    expect(betaRow).toBeDefined();
    expect(betaRow!.canonical.exists).toBe(false);
    expect(betaRow!.overlay.exists).toBe(true);
    expect(betaRow!.winner).toBe("overlay");
    expect(betaRow!.headingPath).toEqual(["Beta"]);
  });

  it("(ii) section exists only as raw fragment sidecar — synthetic __fragment_only__ row with fragment column populated", async () => {
    const canonicalRoot = getContentRoot();
    await writeSkeletonAt(canonicalRoot, DOC_PATH, ["## Alpha", "{{section: sec_alpha.md}}"].join("\n"));
    await writeSectionAt(canonicalRoot, DOC_PATH, "sec_alpha.md", "alpha body");

    // Orphan raw fragment with no skeleton entry
    await writeRawFragment(DOC_PATH, "sec_orphan.md", "orphan body from crash");

    await commitContent(ctx.rootDir, "seed");

    const diag = await buildDocumentDiagnostics(DOC_PATH);
    const orphanRow = diag.sections.find(
      (s) => s.headingKey.startsWith("__fragment_only__::"),
    );
    expect(orphanRow).toBeDefined();
    expect(orphanRow!.fragment.exists).toBe(true);
    expect(orphanRow!.canonical.exists).toBe(false);
    expect(orphanRow!.overlay.exists).toBe(false);
    expect(orphanRow!.crdt.exists).toBe(false);
    expect(orphanRow!.winner).toBe("fragment");
    expect(orphanRow!.sectionFile).toBe("sec_orphan.md");
    expect(orphanRow!.headingPath).toEqual([]);
  });

  it("(iv) all four layers present — merged row with every column populated", async () => {
    const canonicalRoot = getContentRoot();
    const overlayRoot = getSessionSectionsContentRoot();

    await writeSkeletonAt(canonicalRoot, DOC_PATH, ["## Alpha", "{{section: sec_alpha.md}}"].join("\n"));
    await writeSectionAt(canonicalRoot, DOC_PATH, "sec_alpha.md", "alpha canonical");
    await commitContent(ctx.rootDir, "seed canonical");

    await writeSkeletonAt(overlayRoot, DOC_PATH, ["## Alpha", "{{section: sec_alpha.md}}"].join("\n"));
    await writeSectionAt(overlayRoot, DOC_PATH, "sec_alpha.md", "alpha overlay");

    // Raw fragment sidecar exists — fragmentKey matches sec_alpha.md
    await writeRawFragment(DOC_PATH, "sec_alpha.md", "## Alpha\n\nalpha raw fragment");

    // Live CRDT session with mutated content
    const baseHead = await getHeadSha(ctx.rootDir);
    const session = await acquireDocSession(DOC_PATH, writer.id, baseHead, writer, "sock-diag");
    let alphaKey: string | null = null;
    for (const [key, hp] of session.headingPathByFragmentKey) {
      if (hp.length === 1 && hp[0] === "Alpha") {
        alphaKey = key;
      }
    }
    expect(alphaKey).not.toBeNull();
    session.liveFragments.replaceFragmentString(
      alphaKey!,
      fragmentFromRemark("## Alpha\n\nalpha live crdt content"),
      undefined,
    );

    const diag = await buildDocumentDiagnostics(DOC_PATH);
    const alphaRow = diag.sections.find((s) => s.sectionFile === "sec_alpha.md");
    expect(alphaRow).toBeDefined();
    expect(alphaRow!.canonical.exists).toBe(true);
    expect(alphaRow!.overlay.exists).toBe(true);
    expect(alphaRow!.fragment.exists).toBe(true);
    expect(alphaRow!.crdt.exists).toBe(true);
    expect(alphaRow!.winner).toBe("crdt");
  });

  it("(v) divergence health check fails with meaningful detail when overlay and canonical structures differ", async () => {
    const canonicalRoot = getContentRoot();
    const overlayRoot = getSessionSectionsContentRoot();

    await writeSkeletonAt(canonicalRoot, DOC_PATH, ["## Alpha", "{{section: sec_alpha.md}}"].join("\n"));
    await writeSectionAt(canonicalRoot, DOC_PATH, "sec_alpha.md", "alpha body");

    await writeSkeletonAt(
      overlayRoot,
      DOC_PATH,
      ["## Alpha", "{{section: sec_alpha.md}}", "## Beta", "{{section: sec_beta.md}}"].join("\n"),
    );
    await writeSectionAt(overlayRoot, DOC_PATH, "sec_alpha.md", "alpha overlay");
    await writeSectionAt(overlayRoot, DOC_PATH, "sec_beta.md", "beta overlay");

    await commitContent(ctx.rootDir, "seed");

    const diag = await buildDocumentDiagnostics(DOC_PATH);
    const divergence = diag.checks.find(
      (c) => c.name === "overlay-vs-canonical structure divergence",
    );
    expect(divergence).toBeDefined();
    expect(divergence!.pass).toBe(false);
    expect(divergence!.detail).toContain("Beta");
  });

  it("divergence check passes when canonical and overlay structures agree (and when no overlay exists)", async () => {
    const canonicalRoot = getContentRoot();

    await writeSkeletonAt(canonicalRoot, DOC_PATH, ["## Alpha", "{{section: sec_alpha.md}}"].join("\n"));
    await writeSectionAt(canonicalRoot, DOC_PATH, "sec_alpha.md", "alpha body");
    await commitContent(ctx.rootDir, "seed");

    const diag = await buildDocumentDiagnostics(DOC_PATH);
    const divergence = diag.checks.find(
      (c) => c.name === "overlay-vs-canonical structure divergence",
    );
    expect(divergence).toBeDefined();
    expect(divergence!.pass).toBe(true);
  });
});
