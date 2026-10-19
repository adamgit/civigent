import { HUMAN_TXN_COUNT, pad2 } from "./constants.js";

export const HEARTBEAT_MS = 500;
export const STALL_MS = 2_000;
export const HARNESS_DEADLINE_MS = 5_000;
/** Every client parked, lane idle, longer than a human gap or a quiescence pass. */
const PARKED_STALL_MS = 4_000;

export interface ClientSnap {
  index: number;
  joined: boolean;
  sent: number;
  acked: number;
  waitingHeading: string | null;
  pausing: boolean;
}

export interface WatchSnapshot {
  phase: string;
  laneCommandCount: number;
  laneInFlight: number;
  agentsDone: number;
  pauseStart: boolean;
  pauseReady: number;
  pauseEnd: number;
  clients: ClientSnap[];
}

export function harnessLog(line: string): void {
  process.stderr.write(`[20x20] ${line}\n`);
}

export function formatClientDump(clients: readonly ClientSnap[]): string {
  if (clients.length === 0) return "(no human clients yet)";
  return clients
    .map((c) => {
      const id = `h${pad2(c.index)}`;
      const wait = c.waitingHeading ?? (c.pausing ? "gap" : "-");
      return `${id} joined=${c.joined} sent=${c.sent}/${HUMAN_TXN_COUNT} acked=${c.acked} waiting=${wait}`;
    })
    .join("\n");
}

function everyClientParked(snap: WatchSnapshot): boolean {
  return snap.clients.length > 0 && snap.clients.every((c) => c.pausing || c.waitingHeading !== null);
}

export function formatHeartbeat(snap: WatchSnapshot, elapsedMs: number, stalledForMs: number): string {
  const joined = snap.clients.filter((c) => c.joined).length;
  const sent = snap.clients.reduce((n, c) => n + c.sent, 0);
  const acked = snap.clients.reduce((n, c) => n + c.acked, 0);
  const waiting = snap.clients
    .filter((c) => c.waitingHeading !== null)
    .map((c) => `h${pad2(c.index)}:${c.waitingHeading}`)
    .join(",");
  const gaps = snap.clients.filter((c) => c.pausing).length;
  const stall = stalledForMs >= HEARTBEAT_MS ? ` stall=${(stalledForMs / 1000).toFixed(1)}s` : "";
  const waitPart = waiting.length > 0 ? ` waiting=${waiting}` : "";
  const gapPart = gaps > 0 ? ` gaps=${gaps}` : "";
  return (
    `t=${(elapsedMs / 1000).toFixed(1)}s phase=${snap.phase} joined=${joined}/${snap.clients.length || 0}` +
    ` sent=${sent} acked=${acked} lane=${snap.laneCommandCount} inflight=${snap.laneInFlight}` +
    ` agents=${snap.agentsDone} pause=${snap.pauseStart ? 1 : 0}/${snap.pauseReady}/${snap.pauseEnd}` +
    `${gapPart}${waitPart}${stall}`
  );
}

function fingerprint(snap: WatchSnapshot): string {
  return JSON.stringify({
    phase: snap.phase,
    lane: snap.laneCommandCount,
    agents: snap.agentsDone,
    pause: [snap.pauseStart, snap.pauseReady, snap.pauseEnd],
    clients: snap.clients.map((c) => [c.joined, c.sent, c.acked, c.waitingHeading, c.pausing]),
  });
}

function hungMessage(kind: string, detail: string, snap: WatchSnapshot): string {
  const waiting = snap.clients.filter((c) => c.waitingHeading !== null);
  const splitHint =
    waiting.length > 0
      ? " A split wait unblocks only after the 2s quiescence pass emits a topology row; that pass does not run while any fragment still has activity. Isolate with kind=body then kind=split."
      : "";
  return `${kind}: ${detail} (phase=${snap.phase}).${splitHint}\n${formatClientDump(snap.clients)}`;
}

export class HarnessWatch {
  phase = "start";
  readonly dead: Promise<never>;
  private rejectDead: ((err: Error) => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastFp = "";
  private lastChangeAt = Date.now();
  private parkedSince: number | null = null;
  private stopped = false;

  constructor(
    private readonly opts: {
      startedAt: number;
      stallMs: number;
      heartbeatMs: number;
      take: () => Omit<WatchSnapshot, "phase">;
      onAbort?: (message: string) => void;
    },
  ) {
    this.dead = new Promise((_, reject) => {
      this.rejectDead = reject;
    });
    void this.dead.catch(() => {});
  }

  start(): void {
    this.lastFp = fingerprint(this.snap());
    this.lastChangeAt = Date.now();
    this.heartbeatTimer = setInterval(() => this.tick(), this.opts.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  setPhase(phase: string): void {
    this.phase = phase;
    harnessLog(phase);
  }

  snap(): WatchSnapshot {
    return { phase: this.phase, ...this.opts.take() };
  }

  private tick(): void {
    if (this.stopped) return;
    const snap = this.snap();
    const now = Date.now();
    const fp = fingerprint(snap);
    const parked = everyClientParked(snap);
    if (snap.laneInFlight > 0 || fp !== this.lastFp || parked) {
      this.lastFp = fp;
      this.lastChangeAt = now;
    }
    if (parked && snap.laneInFlight === 0) {
      if (this.parkedSince === null) this.parkedSince = now;
    } else {
      this.parkedSince = null;
    }
    const stalledFor = now - this.lastChangeAt;
    harnessLog(formatHeartbeat(snap, now - this.opts.startedAt, stalledFor));
    if (
      this.phase !== "plant" &&
      this.parkedSince !== null &&
      now - this.parkedSince >= PARKED_STALL_MS
    ) {
      this.fail(hungMessage("stall", `every client parked for ${PARKED_STALL_MS}ms`, snap));
      return;
    }
    if (this.phase !== "plant" && snap.laneInFlight === 0 && !parked && stalledFor >= this.opts.stallMs) {
      this.fail(hungMessage("stall", `no progress for ${this.opts.stallMs}ms`, snap));
    }
  }

  private fail(message: string): void {
    if (this.stopped) return;
    harnessLog(message);
    this.stop();
    this.opts.onAbort?.(message);
    this.rejectDead?.(new Error(message));
  }
}

export async function watchOr<T>(watch: HarnessWatch, work: Promise<T>): Promise<T> {
  return Promise.race([work, watch.dead]);
}
