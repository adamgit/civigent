import { defineConfig } from "vitest/config";

/** Vitest workers do not keep `--` on `process.argv`. Capture it here in the CLI process. */
function argvAfterDashDash(argv: readonly string[]): string[] {
  const sep = argv.indexOf("--");
  return sep === -1 ? [] : argv.slice(sep + 1);
}

export default defineConfig({
  test: {
    include: ["src/__tests__/perf/**/*.test.ts"],
    fileParallelism: false,
    // Hang cap. Each client has its own 5s timer inside the harness.
    testTimeout: 10 * 60 * 1000,
    env: {
      KS_AUTH_MODE: "single_user",
      KS_SNAPSHOT_ENABLED: "false",
      CIVIGENT_20X20_ARGV: JSON.stringify(argvAfterDashDash(process.argv)),
    },
  },
});
