import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getFatalErrorsMode, resetFatalErrorsModeForTests } from "../../runtime/fatal-errors-mode.js";

describe("KS_FATAL_ERRORS_MODE", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.KS_FATAL_ERRORS_MODE;
    resetFatalErrorsModeForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.KS_FATAL_ERRORS_MODE;
    else process.env.KS_FATAL_ERRORS_MODE = savedEnv;
    resetFatalErrorsModeForTests();
  });

  it("defaults to report when unset", () => {
    delete process.env.KS_FATAL_ERRORS_MODE;
    expect(getFatalErrorsMode()).toBe("report");
  });

  it("defaults to report when empty", () => {
    process.env.KS_FATAL_ERRORS_MODE = "";
    expect(getFatalErrorsMode()).toBe("report");
  });

  it("defaults to report when whitespace-only", () => {
    process.env.KS_FATAL_ERRORS_MODE = "   ";
    expect(getFatalErrorsMode()).toBe("report");
  });

  it("accepts report", () => {
    process.env.KS_FATAL_ERRORS_MODE = "report";
    expect(getFatalErrorsMode()).toBe("report");
  });

  it("accepts crash", () => {
    process.env.KS_FATAL_ERRORS_MODE = "crash";
    expect(getFatalErrorsMode()).toBe("crash");
  });

  it("accepts uppercase (case-insensitive)", () => {
    process.env.KS_FATAL_ERRORS_MODE = "CRASH";
    expect(getFatalErrorsMode()).toBe("crash");
  });

  it("throws a FATAL: error on unknown value", () => {
    process.env.KS_FATAL_ERRORS_MODE = "banana";
    expect(() => getFatalErrorsMode()).toThrow(/FATAL: KS_FATAL_ERRORS_MODE="banana"/);
  });

  it("caches the parsed value across calls", () => {
    process.env.KS_FATAL_ERRORS_MODE = "crash";
    expect(getFatalErrorsMode()).toBe("crash");
    process.env.KS_FATAL_ERRORS_MODE = "report";
    expect(getFatalErrorsMode()).toBe("crash");
  });
});
