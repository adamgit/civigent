import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FatalReport } from "../../runtime/system-state.js";
import {
  handleProcessFatal,
  resetFatalHandlerForTests,
  setFatalReportDeliveryHandler,
} from "../../runtime/fatal-handler.js";
import { resetFatalErrorsModeForTests } from "../../runtime/fatal-errors-mode.js";

describe("handleProcessFatal", () => {
  let savedEnv: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedEnv = process.env.KS_FATAL_ERRORS_MODE;
    resetFatalErrorsModeForTests();
    setFatalReportDeliveryHandler(() => { /* reset delivery */ });
    // Prevent the test process from actually exiting.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as never);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => { /* silence */ });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.KS_FATAL_ERRORS_MODE;
    else process.env.KS_FATAL_ERRORS_MODE = savedEnv;
    resetFatalErrorsModeForTests();
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("crash mode: calls process.exit(1) and does not invoke delivery handler", () => {
    process.env.KS_FATAL_ERRORS_MODE = "crash";
    const delivery = vi.fn();
    setFatalReportDeliveryHandler(delivery);

    handleProcessFatal(new Error("boom"), "uncaughtException");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(delivery).not.toHaveBeenCalled();
  });

  it("crash mode: persists the fatal report so a fresh process can recover it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ks-fatal-latch-"));
    const previousDataRoot = process.env.KS_DATA_ROOT;
    process.env.KS_DATA_ROOT = root;
    process.env.KS_FATAL_ERRORS_MODE = "crash";
    resetFatalErrorsModeForTests();

    try {
      handleProcessFatal(new Error("durable fatal"), "uncaughtException");
      resetFatalHandlerForTests();

      const persisted = JSON.parse(
        await readFile(path.join(root, "fatal.json"), "utf8"),
      ) as FatalReport & { operator_action?: string };

      expect(persisted.message).toBe("durable fatal");
      expect(persisted.stack).toContain("durable fatal");
      expect(persisted.origin).toBe("uncaughtException");
      expect(persisted.operator_action).toContain("delete `fatal.json`");
      expect(persisted.operator_action).toContain("restart Civigent");
    } finally {
      if (previousDataRoot === undefined) delete process.env.KS_DATA_ROOT;
      else process.env.KS_DATA_ROOT = previousDataRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("report mode: does NOT exit and invokes the delivery handler with a FatalReport", () => {
    process.env.KS_FATAL_ERRORS_MODE = "report";
    const delivery = vi.fn<(r: FatalReport) => void>();
    setFatalReportDeliveryHandler(delivery);

    const err = new Error("kaboom");
    handleProcessFatal(err, "uncaughtException");

    expect(exitSpy).not.toHaveBeenCalled();
    expect(delivery).toHaveBeenCalledTimes(1);
    const report = delivery.mock.calls[0]![0];
    expect(report.message).toBe("kaboom");
    expect(report.origin).toBe("uncaughtException");
    expect(report.stack).toContain("kaboom");
    expect(typeof report.timestamp).toBe("string");
  });

  it("report mode with no delivery handler: does not exit; logs and continues", () => {
    process.env.KS_FATAL_ERRORS_MODE = "report";
    setFatalReportDeliveryHandler(undefined as unknown as (r: FatalReport) => void);
    // The setter above intentionally passes an invalid handler to simulate
    // "handler never registered" — we assert the runtime tolerates that by
    // resetting via the module's internal null default. Instead, use a
    // fresh module state via resetFatalErrorsModeForTests + no setter call.
    // (The setter's contract is to always store a callable, so we exercise the
    // "no delivery" branch by only relying on early-startup semantics; here we
    // just confirm the process still doesn't exit.)
    handleProcessFatal(new Error("early"), "uncaughtException");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("defaults to report when KS_FATAL_ERRORS_MODE is unset", () => {
    delete process.env.KS_FATAL_ERRORS_MODE;
    const delivery = vi.fn<(r: FatalReport) => void>();
    setFatalReportDeliveryHandler(delivery);

    handleProcessFatal(new Error("default-path"), "unhandledRejection");

    expect(exitSpy).not.toHaveBeenCalled();
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery.mock.calls[0]![0].origin).toBe("unhandledRejection");
  });

  it("non-Error input is wrapped into an Error", () => {
    process.env.KS_FATAL_ERRORS_MODE = "report";
    const delivery = vi.fn<(r: FatalReport) => void>();
    setFatalReportDeliveryHandler(delivery);

    handleProcessFatal("string-fatal", "uncaughtException");

    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery.mock.calls[0]![0].message).toBe("string-fatal");
  });
});
