import { describe, it, expect } from "vitest";
import { sanitizeReturnTo } from "../../api/routes/index.js";

describe("sanitizeReturnTo — open redirect prevention", () => {
  it("preserves normal paths", () => {
    expect(sanitizeReturnTo("/documents/my-doc")).toBe("/documents/my-doc");
  });

  it("preserves query strings", () => {
    expect(sanitizeReturnTo("/documents?tab=governance")).toBe("/documents?tab=governance");
  });

  it("preserves hash fragments", () => {
    expect(sanitizeReturnTo("/documents#section-1")).toBe("/documents#section-1");
  });

  it("rejects backslash bypass (/\\evil.com)", () => {
    expect(sanitizeReturnTo("/\\evil.com")).toBe("/");
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(sanitizeReturnTo("//evil.com")).toBe("/");
  });

  it("rejects absolute URLs (https://evil.com)", () => {
    expect(sanitizeReturnTo("https://evil.com/path")).toBe("/");
  });

  it("strips control characters", () => {
    expect(sanitizeReturnTo("/docs\x00\x0d\x0a")).toBe("/docs");
  });

  it("returns / for empty string", () => {
    expect(sanitizeReturnTo("")).toBe("/");
  });

  it("returns / for non-string input", () => {
    expect(sanitizeReturnTo(null as unknown as string)).toBe("/");
    expect(sanitizeReturnTo(undefined as unknown as string)).toBe("/");
  });
});
