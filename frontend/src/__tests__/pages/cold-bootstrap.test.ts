/**
 * Task 325 — page-local cold bootstrap derivation.
 *
 * Verifies that the content-bearing REST section list is split into body-free
 * seeds + LOCK-ONLY workspace signals (locks are the only per-section signal
 * the `/sections` DTO carries — live pending is the replica's), that the
 * `SectionId` brand is the sole minting boundary,
 * and that the ready-gate paint selector serves seeds while cold and delegates to
 * the live reader once ready (with no seed fallback after ready).
 */

import { describe, it, expect } from "vitest";
import {
  deriveWorkspaceBootstrap,
  deriveWorkspaceSectionLockSignals,
  seedMarkdownFor,
  lockSignalFor,
  resolvePaintMarkdown,
} from "../../pages/cold-bootstrap";
import { SectionId } from "../../types/live-sections";
import type { DocumentSection } from "../../pages/document-page-utils";

function section(partial: {
  heading: string;
  heading_path: string[];
  fragment_key: string;
  content?: string;
  locked?: boolean;
}): DocumentSection {
  return {
    heading: partial.heading,
    heading_path: partial.heading_path,
    depth: partial.heading_path.length,
    content: partial.content ?? "",
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 0,
    fragment_key: partial.fragment_key,
    section_file: `${partial.fragment_key.replace(/^section::/, "")}.md`,
    ...(partial.locked !== undefined ? { locked: partial.locked } : {}),
  };
}

const intro = section({
  heading: "Intro",
  heading_path: ["Intro"],
  fragment_key: "section::intro",
  content: "# Intro\n\nhello",
});
const details = section({
  heading: "Details",
  heading_path: ["Intro", "Details"],
  fragment_key: "section::details",
  content: "## Details\n\nbody",
  locked: true,
});

describe("deriveWorkspaceBootstrap", () => {
  it("maps each REST row to a body-free ref + cold markdown, preserving order", () => {
    const boot = deriveWorkspaceBootstrap([intro, details]);
    expect(boot).toHaveLength(2);
    expect(SectionId.text(boot[0].ref.id)).toBe("section::intro");
    expect(boot[0].ref.headingPath).toEqual(["Intro"]);
    expect(boot[0].markdown).toBe("# Intro\n\nhello");
    // Order preserved.
    expect(SectionId.text(boot[1].ref.id)).toBe("section::details");
    expect(boot[1].ref.headingPath).toEqual(["Intro", "Details"]);
  });

  it("copies heading_path (does not alias the REST row array)", () => {
    const boot = deriveWorkspaceBootstrap([intro]);
    expect(boot[0].ref.headingPath).not.toBe(intro.heading_path);
    expect(boot[0].ref.headingPath).toEqual(intro.heading_path);
  });

  it("carries no body on the ref itself (body is only the seed markdown)", () => {
    const boot = deriveWorkspaceBootstrap([intro]);
    expect(boot[0].ref).not.toHaveProperty("content");
    expect(boot[0].ref).not.toHaveProperty("markdown");
  });
});

describe("deriveWorkspaceSectionLockSignals", () => {
  it("derives one lock signal per section from the REST `locked` flag", () => {
    const signals = deriveWorkspaceSectionLockSignals([intro, details]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toEqual({ id: SectionId.brand("section::intro"), locked: false });
    expect(signals[1]).toEqual({ id: SectionId.brand("section::details"), locked: true });
  });

  it("treats an absent `locked` field as unlocked (never undefined)", () => {
    const [sig] = deriveWorkspaceSectionLockSignals([intro]);
    expect(sig.locked).toBe(false);
  });

  it("is lock-only: the signal shape carries exactly {id, locked} (no pending field exists)", () => {
    const signals = deriveWorkspaceSectionLockSignals([intro, details]);
    for (const sig of signals) expect(Object.keys(sig).sort()).toEqual(["id", "locked"]);
  });
});

describe("seedMarkdownFor / lockSignalFor lookups", () => {
  it("finds by opaque SectionId equality", () => {
    const boot = deriveWorkspaceBootstrap([intro, details]);
    const signals = deriveWorkspaceSectionLockSignals([intro, details]);
    expect(seedMarkdownFor(boot, SectionId.brand("section::details"))).toBe("## Details\n\nbody");
    expect(lockSignalFor(signals, SectionId.brand("section::details"))?.locked).toBe(true);
  });

  it("returns undefined for an unknown id", () => {
    const boot = deriveWorkspaceBootstrap([intro]);
    expect(seedMarkdownFor(boot, SectionId.brand("section::missing"))).toBeUndefined();
    expect(lockSignalFor(deriveWorkspaceSectionLockSignals([intro]), SectionId.brand("section::missing")))
      .toBeUndefined();
  });
});

describe("resolvePaintMarkdown — ready gate", () => {
  const boot = deriveWorkspaceBootstrap([intro]);
  const id = SectionId.brand("section::intro");

  it("paints the cold seed while not ready and never calls the live reader", () => {
    let liveReads = 0;
    const out = resolvePaintMarkdown({
      hasAuthoritativeBootstrap: false,
      id,
      bootstrap: boot,
      readLiveMarkdown: () => {
        liveReads += 1;
        return "LIVE";
      },
    });
    expect(out).toBe("# Intro\n\nhello");
    expect(liveReads).toBe(0);
  });

  it("delegates to the live reader once ready — no seed fallback", () => {
    const out = resolvePaintMarkdown({
      hasAuthoritativeBootstrap: true,
      id,
      bootstrap: boot,
      readLiveMarkdown: () => "LIVE BODY",
    });
    expect(out).toBe("LIVE BODY");
  });

  it("cold paint of an unknown id is empty string, not a crash", () => {
    const out = resolvePaintMarkdown({
      hasAuthoritativeBootstrap: false,
      id: SectionId.brand("section::unknown"),
      bootstrap: boot,
      readLiveMarkdown: () => "LIVE",
    });
    expect(out).toBe("");
  });
});
