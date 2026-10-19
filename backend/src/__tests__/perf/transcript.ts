import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunIdentity } from "./constants.js";

export interface EventLoopDelayNs {
  min: number;
  max: number;
  mean: number;
  stddev: number;
  p50: number;
  p95: number;
  p99: number;
  count: number;
  exceeds: number;
}

export interface UpdateAckSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface ConnectSummary {
  editorReadyP50Ms: number;
  editorReadyP95Ms: number;
  editorReadyMaxMs: number;
  bootstrapP50Ms: number;
  bootstrapP95Ms: number;
  bootstrapMaxMs: number;
}

export interface PublishPauseSummary {
  lastSendToPauseStartMs: number;
  pauseStartToAllAcksMs: number;
  allAcksToPauseEndMs: number;
}

export interface AgentPublishRecord {
  agentIndex: number;
  publishMs: number;
  outcome: string;
}

export interface RssRecord {
  start: number;
  floodPeak: number;
  afterDrain: number;
}

export interface SocketCloseRecord {
  clientIndex: number;
  code: number;
  reason: string;
}

export interface HttpErrorRecord {
  agentIndex: number;
  status: number;
  rpcId: string;
}

export interface ConnectMsByClient {
  editorReadyMs: number;
  bootstrapMs: number;
}

export interface RunRecord {
  ok: boolean;
  identity: RunIdentity;
  elapsedMs: number;
  eventLoopDelayNs: EventLoopDelayNs;
  updateAck: UpdateAckSummary | null;
  connect: ConnectSummary | null;
  publishPause: PublishPauseSummary | null;
  agents: AgentPublishRecord[];
  laneIdleMs: number | null;
  laneCommandCount: number | null;
  gitMutexIdleMs: number;
  rss: RssRecord;
  socketCloses: SocketCloseRecord[];
  gitErrors: string[];
  httpErrors: HttpErrorRecord[];
  unhandledRejections: string[];
  updateAckMsByClient?: number[][];
  connectMsByClient?: ConnectMsByClient[];
}

function workspaceRootFromThisFile(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../../../");
}

export function transcriptPath(identity: RunIdentity): string {
  const filename = `${identity.scenario}__s${identity.seed}__${identity.bfh}__${identity.kind}.json`;
  return join(workspaceRootFromThisFile(), "TRANSIENT WORKING DOCS", "concurrency-20x20", filename);
}

export async function writeTranscript(record: RunRecord): Promise<string> {
  const path = transcriptPath(record.identity);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

export function blankEventLoop(): EventLoopDelayNs {
  return { min: 0, max: 0, mean: 0, stddev: 0, p50: 0, p95: 0, p99: 0, count: 0, exceeds: 0 };
}
