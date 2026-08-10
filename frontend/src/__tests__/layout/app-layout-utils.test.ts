import { describe, it, expect } from "vitest";
import { formatBuildDate } from "../../app/app-layout-utils";

describe("formatBuildDate", () => {
  it("formats a valid ISO date", () => {
    const result = formatBuildDate("2025-03-15T14:30:00Z");
    expect(result.shortLabel).toBe("15/Mar 14:30");
    expect(result.longLabel).toBe("15 Mar 25 - 14:30");
  });

  it("returns raw string for invalid date", () => {
    const result = formatBuildDate("not-a-date");
    expect(result.shortLabel).toBe("not-a-date");
    expect(result.longLabel).toBe("not-a-date");
  });

  it("pads single-digit day and hour", () => {
    const result = formatBuildDate("2025-01-05T03:07:00Z");
    expect(result.shortLabel).toBe("05/Jan 03:07");
    expect(result.longLabel).toBe("05 Jan 25 - 03:07");
  });
});
