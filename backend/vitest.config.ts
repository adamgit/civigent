import { configDefaults, defineConfig } from "vitest/config";

// The legacy sessions/ sidecar, flush, finalization, session-end commit,
// post-commit injection, acceptLiveFragments, and session-file crash-recovery
// suites asserted removed architecture and have been physically deleted (Areas
// B/C/D/E). The crash-recovery suite under src/__tests__/recovery/ now runs
// against the narrowed proposal-FSM + git-integrity contract (Area E) — no
// blanket exclusion remains.
const removedLegacyArchitectureSuites: string[] = [];

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...removedLegacyArchitectureSuites],
    env: {
      // Tests run in single_user mode by default (no auth enforcement).
      // Individual tests can override by setting process.env.KS_AUTH_MODE.
      KS_AUTH_MODE: "single_user",
      // Snapshots require a writable host bind mount (/tmp/snapshots) and are
      // off by default in tests. Tests that exercise the snapshot pipeline must
      // opt in explicitly AND point at their own writable temp dir.
      KS_SNAPSHOT_ENABLED: "false",
    },
  },
});
