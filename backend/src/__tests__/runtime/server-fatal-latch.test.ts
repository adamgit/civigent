import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  dataRoot: "",
  ensureV3Directories: vi.fn(async () => undefined),
  ensureGitRepoReady: vi.fn(async () => undefined),
  detectAndRecoverCrash: vi.fn(async () => ({
    recovered: false,
    pendingDiscarded: 0,
    committingFinalized: [],
    committingRerun: [],
  })),
  bootstrapContentSeedFromDirectoryIfNeeded: vi.fn(async () => undefined),
  setSystemReady: vi.fn(),
}));

vi.mock("node:http", () => ({
  createServer: vi.fn(() => ({
    on: vi.fn(),
    listen: vi.fn(),
    address: vi.fn(() => ({ port: 3000 })),
  })),
}));

vi.mock("../../app.js", () => ({
  createApp: vi.fn(() => vi.fn()),
}));

vi.mock("../../ws/hub.js", () => ({
  createWsHub: vi.fn(() => ({
    broadcast: vi.fn(),
    broadcastActivityToSocketsWithDocOpen: vi.fn(),
    sendPrivate: vi.fn(),
    handleUpgrade: vi.fn(),
  })),
}));

vi.mock("../../ws/crdt-sync.js", () => ({
  createCrdtWsServer: vi.fn(() => ({ handleUpgrade: vi.fn(async () => undefined) })),
  setCrdtEventHandler: vi.fn(),
  setCrdtPrivateEventHandler: vi.fn(),
}));

vi.mock("../../ws/crdt-ws-coordinator.js", () => ({
  setDocumentActivityChangedHandler: vi.fn(),
}));

vi.mock("../../ws/document-activity.js", () => ({
  broadcastDocumentActivitySnapshot: vi.fn(async () => undefined),
  recordAgentDocumentRead: vi.fn(),
  setDocumentActivityBroadcaster: vi.fn(),
}));

vi.mock("../../storage/data-root.js", () => ({
  assertDataRootExists: vi.fn(async () => undefined),
  getDataRoot: vi.fn(() => state.dataRoot),
  getFatalStatePath: vi.fn(() => path.join(state.dataRoot, "fatal.json")),
  getImportRoot: vi.fn(() => "/import"),
  ensureV3Directories: state.ensureV3Directories,
}));

vi.mock("../../storage/git-repo.js", () => ({
  ensureGitRepoReady: state.ensureGitRepoReady,
}));

vi.mock("../../storage/crash-recovery.js", () => ({
  detectAndRecoverCrash: state.detectAndRecoverCrash,
}));

vi.mock("../../storage/bootstrap-content-seed.js", () => ({
  bootstrapContentSeedFromDirectoryIfNeeded: state.bootstrapContentSeedFromDirectoryIfNeeded,
}));

vi.mock("../../auth/oauth-config.js", () => ({
  validateOAuthConfig: vi.fn(),
  getMCPPublicURL: vi.fn(() => "http://localhost:3000"),
  getOidcPublicUrl: vi.fn(() => "http://localhost:3000"),
  isMCPPublicURLFromHeadersEnabled: vi.fn(() => false),
}));

vi.mock("../../auth/service.js", () => ({
  maybeGenerateBootstrapCode: vi.fn(async () => undefined),
}));

vi.mock("../../startup-state.js", () => ({
  isSystemReady: vi.fn(() => false),
  setSystemReady: state.setSystemReady,
  setSystemNotReady: vi.fn(),
  setSystemFatal: vi.fn(),
  getSystemState: vi.fn(() => ({ state: "starting" })),
}));

vi.mock("../../runtime/system-state.js", () => ({
  isDevSupervised: false,
  WORKER_HEARTBEAT_INTERVAL_MS: 5_000,
}));

vi.mock("../../runtime/memory-stats.js", () => ({
  startRuntimeMemorySampler: vi.fn(),
}));

vi.mock("../../runtime/fatal-errors-mode.js", () => ({
  getFatalErrorsMode: vi.fn(() => "crash"),
}));

vi.mock("../../runtime/fatal-handler.js", () => ({
  handleProcessFatal: vi.fn(),
  installProcessFatalHandlers: vi.fn(),
  setFatalReportDeliveryHandler: vi.fn(),
}));

vi.mock("../../ws/proposal-section-availability.js", () => ({
  buildProposalSectionAvailabilityEventsForDoc: vi.fn(async () => []),
}));

describe("server startup with a durable fatal latch", () => {
  let root: string | null = null;
  const previousDataRoot = process.env.KS_DATA_ROOT;

  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    if (previousDataRoot === undefined) delete process.env.KS_DATA_ROOT;
    else process.env.KS_DATA_ROOT = previousDataRoot;
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("does not run recovery or bootstrap mutations when fatal.json exists", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ks-server-fatal-latch-"));
    state.dataRoot = root;
    process.env.KS_DATA_ROOT = root;
    await writeFile(
      path.join(root, "fatal.json"),
      JSON.stringify({
        message: "latched invariant failure",
        stack: "Error: latched invariant failure",
        cause: null,
        origin: "uncaughtException",
        timestamp: "2026-08-19T00:00:00.000Z",
        operator_action: "Resolve the underlying failure, delete `fatal.json` from the Civigent data directory, then restart Civigent.",
      }),
      "utf8",
    );

    await import("../../server.js");

    expect(state.ensureV3Directories).not.toHaveBeenCalled();
    expect(state.ensureGitRepoReady).not.toHaveBeenCalled();
    expect(state.detectAndRecoverCrash).not.toHaveBeenCalled();
    expect(state.bootstrapContentSeedFromDirectoryIfNeeded).not.toHaveBeenCalled();
    expect(state.setSystemReady).not.toHaveBeenCalled();
  });
});
