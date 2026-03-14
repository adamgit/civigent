import { describe, it, expect } from "vitest";
import { stripMatchingHeading } from "../../storage/content-layer.js";

describe("stripMatchingHeading", () => {
  it("strips matching heading and blank lines after it", () => {
    const input = "## Overview\n\nThis is the body.";
    expect(stripMatchingHeading(input, 2, "Overview")).toBe("This is the body.");
  });

  it("strips matching heading with no body after it", () => {
    expect(stripMatchingHeading("## Overview", 2, "Overview")).toBe("");
  });

  it("strips matching heading with multiple blank lines", () => {
    const input = "## Overview\n\n\n\nBody text.";
    expect(stripMatchingHeading(input, 2, "Overview")).toBe("Body text.");
  });

  it("does not strip when heading level is wrong", () => {
    const input = "### Overview\n\nBody text.";
    expect(stripMatchingHeading(input, 2, "Overview")).toBe(input);
  });

  it("does not strip when heading text is wrong", () => {
    const input = "## Introduction\n\nBody text.";
    expect(stripMatchingHeading(input, 2, "Overview")).toBe(input);
  });

  it("passes through body-only content unchanged", () => {
    const input = "This is already body-only content.\n\nWith paragraphs.";
    expect(stripMatchingHeading(input, 2, "Overview")).toBe(input);
  });

  it("passes through root section content unchanged", () => {
    const input = "Root body content.";
    expect(stripMatchingHeading(input, 0, "")).toBe(input);
  });

  it("passes through empty content unchanged", () => {
    expect(stripMatchingHeading("", 2, "Overview")).toBe("");
  });

  it("handles level 1 headings", () => {
    const input = "# Title\n\nBody.";
    expect(stripMatchingHeading(input, 1, "Title")).toBe("Body.");
  });

  it("handles level 4 headings", () => {
    const input = "#### Deep Section\n\nNested body.";
    expect(stripMatchingHeading(input, 4, "Deep Section")).toBe("Nested body.");
  });

  it("does not strip partial heading matches", () => {
    // Heading has extra text
    const input = "## Overview Extra\n\nBody.";
    expect(stripMatchingHeading(input, 2, "Overview")).toBe(input);
  });
});
