import { configDefaults, defineConfig } from "vitest/config";

const removedLegacyArchitectureSuites = [
  // Iteration 3.5 routes live CRDT edits through proposal content trees.
  // The legacy sessions/ sidecar, flush, finalization, session-end commit,
  // post-commit injection, and acceptLiveFragments structural-contract suites
  // assert removed architecture rather than current intended behavior.
  "src/__tests__/sessions/**/*.test.ts",
  "src/__tests__/recovery/**/*.test.ts",
  "src/__tests__/crdt/acquire-empty-doc-session.test.ts",
  "src/__tests__/crdt/apply-accept-result.test.ts",
  "src/__tests__/crdt/begin-finalization.test.ts",
  "src/__tests__/crdt/flush-single-normalization-path.test.ts",
  "src/__tests__/crdt/heading-deletion-merge-target.test.ts",
  "src/__tests__/crdt/heading-deletion-parent-collapse.test.ts",
  "src/__tests__/crdt/heading-deletion-parser-edge-matrix.test.ts",
  "src/__tests__/crdt/heading-path-index-ownership.test.ts",
  "src/__tests__/crdt/normalization-boundary-matrix.test.ts",
  "src/__tests__/crdt/normalization-invariants.test.ts",
  "src/__tests__/crdt/normalize-heading-deletion-merge.test.ts",
  "src/__tests__/crdt/origin-suppression-dirty-tracking.test.ts",
  "src/__tests__/crdt/post-commit-injection-invariants.test.ts",
  "src/__tests__/crdt/predecessor-convergence-chain.test.ts",
  "src/__tests__/crdt/sub-skeleton-duplicate-bug.test.ts",
  "src/__tests__/crdt/targeted-normalization-sequential-matrix.test.ts",
  "src/__tests__/diagnostics/collect-section-layers.test.ts",
  "src/__tests__/storage/accept-live-fragments-*.test.ts",
  "src/__tests__/storage/child-section-commit-crash.test.ts",
  "src/__tests__/storage/list-persisted-fragments.test.ts",
  "src/__tests__/storage/multi-key-accept-atomicity.test.ts",
  "src/__tests__/storage/raw-fragment-recovery-buffer.test.ts",
  "src/__tests__/storage/restore-teardown.test.ts",
];

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
