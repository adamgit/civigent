/**
 * Duplicate-sibling-heading guard for the direct skeleton-retitle primitives
 * (`renameHeading`, `retitleSubSkeletonParentInPlace`, `retitleSectionInPlace`).
 *
 * A rename that would produce two same-parent siblings with the same heading
 * text at the same level is rejected before persistence — the section keeps its
 * original heading, and a `DuplicateSiblingHeadingError` surfaces to the
 * caller. Non-colliding renames (unique heading, no matching sibling) are still
 * accepted, so the guard does not regress the ordinary path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createProposal } from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { DuplicateSiblingHeadingError } from "../../storage/content-layer.js";

const writer = {
  id: "dup-rename-guard",
  type: "human" as const,
  displayName: "Dup Rename Guard",
  email: "dup@test.local",
};

let ctx: TempDataRootContext;

beforeEach(async () => {
  ctx = await createTempDataRoot();
});
afterEach(async () => {
  await ctx.cleanup();
});

async function newEditor(): Promise<ProposalEditor> {
  const { id } = await createProposal(writer, "dup guard proposal");
  return ProposalEditor.open(id, "draft");
}

describe("rename_section duplicate-sibling-heading guard", () => {
  it("rejects a top-level rename that collides with a same-parent sibling", async () => {
    const editor = await newEditor();
    await editor.createSection("guard.md", ["Overview"], "Overview", "overview body");
    await editor.createSection("guard.md", ["Timeline"], "Timeline", "timeline body");

    await expect(
      editor.renameSection("guard.md", ["Overview"], "Timeline"),
    ).rejects.toBeInstanceOf(DuplicateSiblingHeadingError);

    const paths = await editor.listHeadingPaths("guard.md");
    expect(paths).toContainEqual(["Overview"]);
    expect(paths).toContainEqual(["Timeline"]);
  });

  it("treats case-insensitively-equal siblings as collisions", async () => {
    const editor = await newEditor();
    await editor.createSection("guard.md", ["Overview"], "Overview", "");
    await editor.createSection("guard.md", ["Timeline"], "Timeline", "");

    await expect(
      editor.renameSection("guard.md", ["Overview"], "TIMELINE"),
    ).rejects.toBeInstanceOf(DuplicateSiblingHeadingError);

    const paths = await editor.listHeadingPaths("guard.md");
    expect(paths).toContainEqual(["Overview"]);
    expect(paths).toContainEqual(["Timeline"]);
  });

  it("rejects a nested-child rename that collides with a same-parent sibling", async () => {
    const editor = await newEditor();
    await editor.createSection("guard.md", ["Parent", "Alpha"], "Alpha", "alpha");
    await editor.createSection("guard.md", ["Parent", "Beta"], "Beta", "beta");

    await expect(
      editor.renameSection("guard.md", ["Parent", "Alpha"], "Beta"),
    ).rejects.toBeInstanceOf(DuplicateSiblingHeadingError);

    const paths = await editor.listHeadingPaths("guard.md");
    expect(paths).toContainEqual(["Parent", "Alpha"]);
    expect(paths).toContainEqual(["Parent", "Beta"]);
  });

  it("does not treat cousin sections in different subtrees as a collision", async () => {
    const editor = await newEditor();
    await editor.createSection("guard.md", ["ParentOne", "Alpha"], "Alpha", "");
    await editor.createSection("guard.md", ["ParentTwo", "Alpha"], "Alpha", "");
    // Renaming an unrelated sibling under ParentOne to "Beta" must succeed
    // (Beta only appears as a cousin under ParentTwo, not as a sibling).
    await editor.createSection("guard.md", ["ParentOne", "Gamma"], "Gamma", "");
    await editor.createSection("guard.md", ["ParentTwo", "Beta"], "Beta", "");

    await editor.renameSection("guard.md", ["ParentOne", "Gamma"], "Beta");

    const paths = await editor.listHeadingPaths("guard.md");
    expect(paths).toContainEqual(["ParentOne", "Beta"]);
    expect(paths).toContainEqual(["ParentTwo", "Beta"]);
    expect(paths).not.toContainEqual(["ParentOne", "Gamma"]);
  });

  it("allows a rename to a fresh heading with no sibling conflict", async () => {
    const editor = await newEditor();
    await editor.createSection("guard.md", ["Alpha"], "Alpha", "alpha body");
    await editor.createSection("guard.md", ["Beta"], "Beta", "beta body");

    await editor.renameSection("guard.md", ["Alpha"], "Alpha Renamed");

    const paths = await editor.listHeadingPaths("guard.md");
    expect(paths).toContainEqual(["Alpha Renamed"]);
    expect(paths).toContainEqual(["Beta"]);
    expect(paths).not.toContainEqual(["Alpha"]);
  });

  it("allows a no-op rename to the target's own current heading", async () => {
    const editor = await newEditor();
    await editor.createSection("guard.md", ["Overview"], "Overview", "body");
    await editor.createSection("guard.md", ["Timeline"], "Timeline", "");

    // Renaming a section to its own heading is a no-op and must not
    // self-collide.
    await editor.renameSection("guard.md", ["Overview"], "Overview");

    const paths = await editor.listHeadingPaths("guard.md");
    expect(paths).toContainEqual(["Overview"]);
    expect(paths).toContainEqual(["Timeline"]);
  });

  it("rejects renaming a sub-skeleton parent to a duplicate sibling heading", async () => {
    const editor = await newEditor();
    // Parent1 becomes a sub-skeleton parent by having a child.
    await editor.createSection("guard.md", ["Parent1", "Child"], "Child", "child body");
    await editor.createSection("guard.md", ["Parent2"], "Parent2", "p2");

    await expect(
      editor.renameSection("guard.md", ["Parent1"], "Parent2"),
    ).rejects.toBeInstanceOf(DuplicateSiblingHeadingError);

    const paths = await editor.listHeadingPaths("guard.md");
    expect(paths).toContainEqual(["Parent1"]);
    expect(paths).toContainEqual(["Parent1", "Child"]);
    expect(paths).toContainEqual(["Parent2"]);
  });

  it("rejects a CRDT-style retitleSection into a duplicate sibling heading", async () => {
    const editor = await newEditor();
    await editor.createSection("guard.md", ["Overview"], "Overview", "");
    await editor.createSection("guard.md", ["Timeline"], "Timeline", "");

    // retitleSection covers the CRDT quiescence reflection path
    // (`reflectHeadingEditIntoProposal → editor.retitleSection`). The guard
    // must also fire there so the same primitive can never persist a
    // duplicate.
    await expect(
      editor.retitleSection("guard.md", ["Overview"], "Timeline", 1, ""),
    ).rejects.toBeInstanceOf(DuplicateSiblingHeadingError);

    const paths = await editor.listHeadingPaths("guard.md");
    expect(paths).toContainEqual(["Overview"]);
    expect(paths).toContainEqual(["Timeline"]);
  });

  it("allows a retitleSection level-change when heading text does not collide", async () => {
    const editor = await newEditor();
    await editor.createSection("guard.md", ["Overview"], "Overview", "");
    await editor.createSection("guard.md", ["Timeline"], "Timeline", "");

    await editor.retitleSection("guard.md", ["Overview"], "Overview Renamed", 2, "renamed body");

    const paths = await editor.listHeadingPaths("guard.md");
    expect(paths).toContainEqual(["Overview Renamed"]);
    expect(paths).toContainEqual(["Timeline"]);
    expect(paths).not.toContainEqual(["Overview"]);
  });
});
