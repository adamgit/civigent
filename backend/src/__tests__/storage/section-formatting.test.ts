import { describe, it, expect } from "vitest";
import {
  buildFragmentContent,
  assembleFragments,
  bodyFromDisk,
  type SectionBody,
  type FragmentContent,
} from "../../storage/section-formatting.js";

// Helper: create a SectionBody from a raw string (simulates bodyFromDisk)
const body = (s: string) => bodyFromDisk(s + "\n");

describe("buildFragmentContent", () => {
  it("headed fragment: heading + non-empty body", () => {
    const result = buildFragmentContent(body("Some body text"), 2, "Overview");
    expect(result).toBe("## Overview\n\nSome body text");
  });

  it("headed fragment: heading + multi-line body", () => {
    const result = buildFragmentContent(body("Line 1\nLine 2\nLine 3"), 3, "Details");
    expect(result).toBe("### Details\n\nLine 1\nLine 2\nLine 3");
  });

  it("headed fragment: heading + empty body", () => {
    const result = buildFragmentContent(body(""), 2, "Empty Section");
    expect(result).toBe("## Empty Section");
  });

  it("BFH fragment (level=0, heading=''): returns body as-is", () => {
    const b = body("Preamble content");
    const result = buildFragmentContent(b, 0, "");
    expect(result).toBe("Preamble content");
  });

  it("BFH fragment: empty body returns empty string", () => {
    const result = buildFragmentContent(body(""), 0, "");
    expect(result).toBe("");
  });

  it("level 1 heading", () => {
    const result = buildFragmentContent(body("Top-level body"), 1, "Title");
    expect(result).toBe("# Title\n\nTop-level body");
  });
});

describe("assembleFragments", () => {
  it("single headed fragment", () => {
    const frag = buildFragmentContent(body("Body text"), 2, "Section");
    const result = assembleFragments(frag);
    expect(result).toBe("## Section\n\nBody text");
  });

  it("single BFH fragment", () => {
    const frag = buildFragmentContent(body("Just preamble"), 0, "");
    const result = assembleFragments(frag);
    expect(result).toBe("Just preamble");
  });

  // The join separator between fragments is "\n\n" — a blank line.
  // This produces correct CommonMark: ATX headings should be preceded by a blank line
  // for unambiguous parsing. The previous prependHeading approach achieved this
  // between headed sections (trailing \n per fragment + \n join = \n\n) but left
  // BFH→headed with only \n. Using \n\n uniformly is correct markdown.
  it("BFH followed by headed fragment — blank line between them", () => {
    const bfh = buildFragmentContent(body("Preamble"), 0, "");
    const headed = buildFragmentContent(body("Content"), 2, "First Section");
    const result = assembleFragments(bfh, headed);
    expect(result).toBe("Preamble\n\n## First Section\n\nContent");
  });

  it("multiple headed fragments in sequence — blank line between each", () => {
    const frag1 = buildFragmentContent(body("Body A"), 2, "Section A");
    const frag2 = buildFragmentContent(body("Body B"), 2, "Section B");
    const frag3 = buildFragmentContent(body("Body C"), 3, "Sub Section");
    const result = assembleFragments(frag1, frag2, frag3);
    expect(result).toBe(
      "## Section A\n\nBody A\n\n" +
      "## Section B\n\nBody B\n\n" +
      "### Sub Section\n\nBody C"
    );
  });

  it("headed fragment with empty body", () => {
    const frag = buildFragmentContent(body(""), 2, "Empty");
    const result = assembleFragments(frag);
    expect(result).toBe("## Empty");
  });

  it("empty BFH fragment is filtered out", () => {
    const bfh = buildFragmentContent(body(""), 0, "");
    const headed = buildFragmentContent(body("Content"), 2, "Title");
    const result = assembleFragments(bfh, headed);
    // Empty BFH is falsy (""), so filter(Boolean) removes it
    expect(result).toBe("## Title\n\nContent");
  });

  it("no fragments produces empty string", () => {
    expect(assembleFragments()).toBe("");
  });

  it("full document: BFH + multiple headed sections", () => {
    const bfh = buildFragmentContent(body("Document preamble"), 0, "");
    const s1 = buildFragmentContent(body("Intro text"), 1, "Introduction");
    const s2 = buildFragmentContent(body("Method details"), 2, "Methods");
    const s3 = buildFragmentContent(body("Result data"), 2, "Results");
    const result = assembleFragments(bfh, s1, s2, s3);
    expect(result).toBe(
      "Document preamble\n\n" +
      "# Introduction\n\nIntro text\n\n" +
      "## Methods\n\nMethod details\n\n" +
      "## Results\n\nResult data"
    );
  });
});
