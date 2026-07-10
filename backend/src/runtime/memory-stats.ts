/**
 * In-memory runtime memory monitor. Samples the live process every
 * `SAMPLE_INTERVAL_MS`, keeps a circular buffer of the latest `MAX_SAMPLES`
 * samples, and retains process-lifetime high-water marks so peaks survive
 * even after old samples roll out of the window. Nothing is persisted to
 * disk; the exposed data is intended for the admin runtime-memory page and
 * lightweight EC2 sizing.
 */

import { readFileSync } from "node:fs";
import type {
  GetAdminRuntimeMemoryResponse,
  RuntimeMemoryHighWaterMark,
  RuntimeMemoryProcess,
  RuntimeMemorySample,
} from "../types/shared.js";

export const SAMPLE_INTERVAL_MS = 5000;
export const MAX_SAMPLES = 100;

const CGROUP_MEMORY_CURRENT_PATH = "/sys/fs/cgroup/memory.current";
const CGROUP_PROCS_PATH = "/sys/fs/cgroup/cgroup.procs";

const buffer: (RuntimeMemorySample | null)[] = new Array(MAX_SAMPLES).fill(null);
let bufferHead = 0;
let bufferSize = 0;

const highWaterMark: RuntimeMemoryHighWaterMark = {
  container_memory_bytes: null,
  process_rss_bytes: 0,
  heap_used_bytes: 0,
};

let startedAtMs: number | null = null;
let intervalHandle: NodeJS.Timeout | null = null;

function readContainerMemoryBytes(): number | null {
  try {
    const raw = readFileSync(CGROUP_MEMORY_CURRENT_PATH, "utf8").trim();
    if (raw.length === 0) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  } catch {
    return null;
  }
}

function readCgroupProcessIds(): number[] {
  try {
    const raw = readFileSync(CGROUP_PROCS_PATH, "utf8");
    const seen = new Set<number>();
    for (const line of raw.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) seen.add(pid);
    }
    return [...seen];
  } catch {
    return [];
  }
}

function readProcessArgs(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .map((part) => part.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getProcessDisplayName(name: string, args: string[]): string {
  const joinedArgs = args.join(" ");
  const lowerName = name.toLowerCase();
  const lowerArgs = joinedArgs.toLowerCase();
  const isNodeRelated =
    lowerName === "node" ||
    lowerName.startsWith("tsserver") ||
    lowerName === "mainthread" ||
    lowerName === "npm run dev" ||
    lowerName === "npm" ||
    lowerName === "nodemon" ||
    lowerName === "esbuild" ||
    lowerArgs.includes("/node") ||
    lowerArgs.includes("node_modules") ||
    lowerArgs.includes("typescript/lib");

  if (!isNodeRelated) return name;

  if (lowerArgs.includes("dist/backend/src/server.js") || lowerArgs.includes("backend/src/server.ts")) {
    return "Civigent backend";
  }
  if (lowerArgs.includes("src/dev-supervisor.ts")) return "Dev supervisor";
  if (lowerArgs.includes("frontend/node_modules/.bin/vite") || lowerArgs.includes(" vite")) {
    return "Vite frontend";
  }
  if (lowerArgs.includes("nodemon")) return "nodemon";
  if (lowerArgs.includes("tsserver") || lowerArgs.includes("typescript/lib")) return "TypeScript server";
  if (lowerArgs.includes("esbuild")) return "esbuild";
  if (lowerArgs.includes(".cursor-server")) return "Cursor server";
  if (lowerName === "npm run dev" || lowerName === "npm" || lowerArgs.includes("npm run")) return "npm wrappers";

  return "Other";
}

function readProcessMemory(pid: number): RuntimeMemoryProcess | null {
  try {
    const raw = readFileSync(`/proc/${pid}/status`, "utf8");
    const nameMatch = /^Name:\s*(.+)$/m.exec(raw);
    const rssMatch = /^VmRSS:\s*(\d+)\s+kB$/m.exec(raw);
    if (!rssMatch) return null;
    const name = nameMatch?.[1]?.trim() || String(pid);
    const displayName = getProcessDisplayName(name, readProcessArgs(pid));

    return {
      pid,
      name,
      display_name: displayName,
      expected_in_production: displayName === "Civigent backend",
      rss_bytes: Number(rssMatch[1]) * 1024,
    };
  } catch {
    return null;
  }
}

function readCgroupProcesses(): RuntimeMemoryProcess[] {
  return readCgroupProcessIds()
    .map(readProcessMemory)
    .filter((process): process is RuntimeMemoryProcess => process !== null)
    .sort((a, b) => b.rss_bytes - a.rss_bytes);
}

function takeSample(): RuntimeMemorySample {
  const usage = process.memoryUsage();
  return {
    timestamp_ms: Date.now(),
    container_memory_bytes: readContainerMemoryBytes(),
    process_rss_bytes: usage.rss,
    heap_used_bytes: usage.heapUsed,
  };
}

function updateHighWaterMark(sample: RuntimeMemorySample): void {
  if (sample.container_memory_bytes !== null) {
    const prev = highWaterMark.container_memory_bytes;
    if (prev === null || sample.container_memory_bytes > prev) {
      highWaterMark.container_memory_bytes = sample.container_memory_bytes;
    }
  }
  if (sample.process_rss_bytes > highWaterMark.process_rss_bytes) {
    highWaterMark.process_rss_bytes = sample.process_rss_bytes;
  }
  if (sample.heap_used_bytes > highWaterMark.heap_used_bytes) {
    highWaterMark.heap_used_bytes = sample.heap_used_bytes;
  }
}

function recordSample(): void {
  const sample = takeSample();
  updateHighWaterMark(sample);
  buffer[bufferHead] = sample;
  bufferHead = (bufferHead + 1) % MAX_SAMPLES;
  if (bufferSize < MAX_SAMPLES) bufferSize += 1;
}

/**
 * Start the memory sampler. Idempotent: subsequent calls are no-ops so
 * accidental double-starts do not create duplicate intervals. Records an
 * initial sample immediately so the very first read has data.
 */
export function startRuntimeMemorySampler(): void {
  if (intervalHandle !== null) return;
  startedAtMs = Date.now();
  recordSample();
  intervalHandle = setInterval(recordSample, SAMPLE_INTERVAL_MS);
  intervalHandle.unref();
}

function samplesInChronologicalOrder(): RuntimeMemorySample[] {
  const out: RuntimeMemorySample[] = [];
  if (bufferSize === 0) return out;
  const start = bufferSize < MAX_SAMPLES ? 0 : bufferHead;
  for (let i = 0; i < bufferSize; i++) {
    const sample = buffer[(start + i) % MAX_SAMPLES];
    if (sample !== null) out.push(sample);
  }
  return out;
}

export function getRuntimeMemoryStats(): GetAdminRuntimeMemoryResponse {
  const samples = samplesInChronologicalOrder();
  const current = samples.length > 0 ? samples[samples.length - 1] : null;
  return {
    started_at: startedAtMs !== null ? new Date(startedAtMs).toISOString() : new Date().toISOString(),
    sample_interval_ms: SAMPLE_INTERVAL_MS,
    sample_capacity: MAX_SAMPLES,
    current,
    high_water_mark: { ...highWaterMark },
    cgroup_processes: readCgroupProcesses(),
    samples,
  };
}
