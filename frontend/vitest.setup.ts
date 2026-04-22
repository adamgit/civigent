import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";

const REACT_ROUTER_START_TRANSITION_WARNING =
  "React Router Future Flag Warning: React Router will begin wrapping state updates in `React.startTransition` in v7.";

const originalConsoleWarn = console.warn;

beforeAll(() => {
  console.warn = (...args: Parameters<typeof console.warn>) => {
    const [firstArg] = args;
    if (
      typeof firstArg === "string" &&
      firstArg.includes(REACT_ROUTER_START_TRANSITION_WARNING)
    ) {
      return;
    }

    originalConsoleWarn(...args);
  };
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  console.warn = originalConsoleWarn;
});
