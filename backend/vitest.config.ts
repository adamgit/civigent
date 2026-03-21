import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: {
      // Tests run in single_user mode by default (no auth enforcement).
      // Individual tests can override by setting process.env.KS_AUTH_MODE.
      KS_AUTH_MODE: "single_user",
    },
  },
});
