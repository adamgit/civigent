import { describe, it, expect } from "vitest";
import { computeBrowserTabTitle } from "../../app/browser-tab-title";

describe("computeBrowserTabTitle", () => {
  it("titles a folder page with the leaf segment (the original tab-title regression)", () => {
    expect(computeBrowserTabTitle("/docs/test/2026/july2", "Civigent")).toBe("./july2/ << Civigent");
  });

  it("titles a document with edit-state prefixes", () => {
    expect(
      computeBrowserTabTitle("/docs/ops/strategy.md", "Civigent", {
        hasInFlightEdits: true,
        hasUnpublishedChanges: true,
      }),
    ).toBe("! * strategy << Civigent");
  });

  it("titles the docs root as a folder", () => {
    expect(computeBrowserTabTitle("/docs", "Civigent")).toBe("./ << Civigent");
  });
});
