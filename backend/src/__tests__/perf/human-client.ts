import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { markdownToProseMirrorNode, jsonToMarkdown } from "@ks/milkdown-serializer";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from "y-protocols/awareness";
import {
  MSG_SYNC_STEP_2,
  MSG_YJS_UPDATE,
  MSG_AWARENESS,
  MSG_UPDATE_ACK,
  MSG_MODE_TRANSITION_REQUEST,
  MSG_MODE_TRANSITION_RESULT,
  MSG_DOC_PUBLISH_PAUSE_START,
  MSG_DOC_PUBLISH_READY,
  MSG_DOC_PUBLISH_PAUSE_END,
  MSG_LIVE_SECTIONS_BOOTSTRAP,
  MSG_LIVE_SECTIONS_UPDATE,
  decodeLiveSectionsBootstrap,
  decodeLiveSectionsUpdate,
} from "../../ws/crdt-ws-frames.js";
import type { ModeTransitionResult, WireLiveSectionsState } from "../../types/shared.js";
import { DOC_PATH, HUMAN_TXN_COUNT, fixtureSectionHeadings, pad2, type HumanEditKind } from "./constants.js";
import { HARNESS_DEADLINE_MS } from "./progress.js";
import {
  bodyMarker,
  followPromoted,
  mixIsSplit,
  splitBody,
  splitHeading,
  transactionGapMs,
} from "./prng.js";
import type { SocketCloseRecord } from "./transcript.js";

export interface PauseClock {
  lastSendAt: number;
  rssAtLastSend: number;
  pauseStartAt: number | null;
  allReadyAt: number | null;
  pauseEndAt: number | null;
  readyCount: number;
  pauseEndCount: number;
  readonly humanCount: number;
  pauseEndWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

function fragmentMarkdown(doc: Y.Doc, fragmentKey: string): string {
  return jsonToMarkdown(yDocToProsemirrorJSON(doc, fragmentKey) as Record<string, unknown>);
}

function headingPathEquals(path: readonly string[], heading: string): boolean {
  return path.length === 1 && path[0] === heading;
}

export class HarnessCrdtClient {
  readonly doc = new Y.Doc();
  readonly clientIndex: number;
  readonly clientInstanceId = randomUUID();
  readonly sendTimes: number[] = [];
  readonly ackMs: number[] = [];
  editorReadyMs: number | null = null;
  bootstrapMs: number | null = null;
  closed: SocketCloseRecord | null = null;
  closedDuringFlood = false;

  private readonly ws: WebSocket;
  private readonly awareness: Awareness;
  private readonly sendAwareness: boolean;
  private readonly connectStartedAt: number;
  private readonly pauseClock: PauseClock;
  private readonly startingKey: string;
  private readonly onUnexpected: (message: string) => void;

  private targetKey: string;
  private liveState: WireLiveSectionsState | null = null;
  private modeResult: ModeTransitionResult | null = null;
  private synced = false;
  private publishPaused = false;
  private publishReadySent = false;
  private ackWatermark = 0;
  private sentCount = 0;
  private floodActive = false;
  private closeIntended = false;

  private readonly onAbort: (message: string) => void;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private gapReject: ((err: Error) => void) | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly readyResolvers: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly ackResolvers: Array<{ n: number; resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly headingResolvers: Array<{ heading: string; resolve: () => void; reject: (err: Error) => void }> =
    [];

  constructor(opts: {
    port: number;
    token: string;
    clientIndex: number;
    startingKey: string;
    sendAwareness: boolean;
    pauseClock: PauseClock;
    onUnexpected: (message: string) => void;
    onAbort: (message: string) => void;
  }) {
    this.clientIndex = opts.clientIndex;
    this.startingKey = opts.startingKey;
    this.targetKey = opts.startingKey;
    this.sendAwareness = opts.sendAwareness;
    this.pauseClock = opts.pauseClock;
    this.onUnexpected = opts.onUnexpected;
    this.onAbort = opts.onAbort;
    this.resetDeadline();
    this.awareness = new Awareness(this.doc);
    this.connectStartedAt = Date.now();
    const encoded = DOC_PATH.replace(/^\//, "");
    const url =
      `ws://127.0.0.1:${opts.port}/ws/crdt/${encoded}?clientInstanceId=${encodeURIComponent(this.clientInstanceId)}`;
    this.ws = new WebSocket(url, { headers: { Authorization: opts.token } });
    this.ws.binaryType = "arraybuffer";
    this.ws.on("open", () => {
      this.sendRaw(
        MSG_MODE_TRANSITION_REQUEST,
        new TextEncoder().encode(
          JSON.stringify({
            requestId: randomUUID(),
            clientInstanceId: this.clientInstanceId,
            docPath: DOC_PATH,
            requestedMode: "editor",
            editorFocusTarget: null,
            previous_doc_session_id: null,
          }),
        ),
      );
    });
    this.ws.on("message", (raw: ArrayBuffer | Buffer | Buffer[]) => {
      const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      this.handleMessage(new Uint8Array(buf));
    });
    this.ws.on("close", (code, reason) => {
      const reasonText = Buffer.isBuffer(reason) ? reason.toString() : String(reason ?? "");
      this.closed = { clientIndex: this.clientIndex, code, reason: reasonText };
      if (this.floodActive && !this.closeIntended) this.closedDuringFlood = true;
    });
    this.ws.on("error", (err) => {
      this.onUnexpected(`ws error h${this.clientIndex}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  whenJoined(): Promise<void> {
    this.throwIfStopped();
    if (this.isJoined()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.readyResolvers.push({ resolve, reject });
    });
  }

  whenAcks(n: number): Promise<void> {
    this.throwIfStopped();
    if (this.ackWatermark >= n) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ackResolvers.push({ n, resolve, reject });
    });
  }

  whenPauseEnd(): Promise<void> {
    this.throwIfStopped();
    if (this.pauseClock.pauseEndCount >= this.pauseClock.humanCount) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.pauseClock.pauseEndWaiters.push({ resolve, reject });
    });
  }

  snapshot(): {
    index: number;
    joined: boolean;
    sent: number;
    acked: number;
    waitingHeading: string | null;
    pausing: boolean;
  } {
    return {
      index: this.clientIndex,
      joined: this.isJoined(),
      sent: this.sentCount,
      acked: this.ackWatermark,
      waitingHeading: this.headingResolvers[0]?.heading ?? null,
      pausing: this.gapReject !== null,
    };
  }

  async flood(seed: number, kind: HumanEditKind): Promise<void> {
    this.floodActive = true;
    try {
      if (!this.liveState) throw new Error(`h${this.clientIndex}: no live-section bootstrap`);
      if (!this.liveState.topology.some((row) => row.fragment_key === this.startingKey)) {
        throw new Error(`h${this.clientIndex}: starting key ${this.startingKey} missing from topology`);
      }
      if (!this.doc.share.has(this.startingKey)) {
        throw new Error(`h${this.clientIndex}: starting key ${this.startingKey} missing from doc.share`);
      }
      const fixtureHeadings = fixtureSectionHeadings();
      for (let txnIndex = 0; txnIndex < HUMAN_TXN_COUNT; txnIndex += 1) {
        this.throwIfStopped();
        const split =
          kind === "split" ? true : kind === "body" ? false : mixIsSplit(seed, this.clientIndex, txnIndex);
        if (split) {
          const heading = splitHeading(seed, this.clientIndex, txnIndex);
          if (fixtureHeadings.has(heading)) {
            throw new Error(`h${this.clientIndex}: split heading collides with fixture ${heading}`);
          }
          if (this.liveState.topology.some((row) => row.heading_path.includes(heading))) {
            throw new Error(`h${this.clientIndex}: split heading already in topology ${heading}`);
          }
          this.applyAndSend(() => this.buildSplitMarkdown(heading, splitBody(seed, this.clientIndex, txnIndex)));
          await this.whenHeading(heading);
          if (followPromoted(seed, this.clientIndex, txnIndex)) {
            const row = this.liveState.topology.find((t) => headingPathEquals(t.heading_path, heading));
            if (!row) throw new Error(`h${this.clientIndex}: promoted heading ${heading} missing after wait`);
            if (!this.doc.share.has(row.fragment_key)) {
              throw new Error(`h${this.clientIndex}: promoted key ${row.fragment_key} missing from doc.share`);
            }
            this.targetKey = row.fragment_key;
          }
        } else {
          this.applyAndSend(() => this.buildBodyMarkdown(bodyMarker(seed, this.clientIndex, txnIndex)));
          if (txnIndex + 1 < HUMAN_TXN_COUNT) {
            await this.humanGap(transactionGapMs(seed, this.clientIndex, txnIndex));
          }
        }
      }
      await this.whenAcks(HUMAN_TXN_COUNT);
    } finally {
      this.floodActive = false;
      // Ack wait is over, or this flood has left the loop. Other clients may still be pausing.
      this.stopDeadline();
    }
  }

  close(): void {
    if (this.closeIntended) {
      this.rejectWaiters(new Error(`h${this.clientIndex}: aborted`));
      return;
    }
    this.closeIntended = true;
    this.clearDeadline();
    const err = new Error(`h${this.clientIndex}: aborted`);
    this.rejectGap(err);
    this.rejectWaiters(err);
    this.ws.removeAllListeners("message");
    this.ws.removeAllListeners("open");
    this.ws.removeAllListeners("error");
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
    this.doc.destroy();
  }

  private isJoined(): boolean {
    return this.modeResult?.kind === "success" && this.modeResult.clientRole === "editor" && this.synced;
  }

  private throwIfStopped(): void {
    if (this.closeIntended) throw new Error(`h${this.clientIndex}: aborted`);
  }

  /** Join-only runs, the publish pause, and a finished flood are not typing time. */
  stopDeadline(): void {
    this.clearDeadline();
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  /** Fresh 5s for this client. A gap or a split wait clears it first, so the wait is not part of the 5s. */
  private resetDeadline(): void {
    this.clearDeadline();
    if (this.closeIntended) return;
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      const message = `h${pad2(this.clientIndex)}: ${HARNESS_DEADLINE_MS}ms exceeded`;
      this.onAbort(message);
    }, HARNESS_DEADLINE_MS);
  }

  private rejectGap(err: Error): void {
    const reject = this.gapReject;
    this.gapReject = null;
    if (this.gapTimer !== null) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
    reject?.(err);
  }

  private humanGap(ms: number): Promise<void> {
    this.throwIfStopped();
    this.clearDeadline();
    return new Promise<void>((resolve, reject) => {
      this.gapReject = reject;
      this.gapTimer = setTimeout(() => {
        this.gapTimer = null;
        this.gapReject = null;
        resolve();
      }, ms);
    }).finally(() => {
      if (this.gapTimer !== null) {
        clearTimeout(this.gapTimer);
        this.gapTimer = null;
      }
      this.gapReject = null;
      this.resetDeadline();
    });
  }

  private rejectWaiters(err: Error): void {
    const ready = this.readyResolvers.splice(0);
    const acks = this.ackResolvers.splice(0);
    const headings = this.headingResolvers.splice(0);
    for (const w of ready) w.reject(err);
    for (const w of acks) w.reject(err);
    for (const w of headings) w.reject(err);
  }

  private maybeResolveJoined(): void {
    if (!this.isJoined()) return;
    const resolvers = this.readyResolvers.splice(0);
    for (const w of resolvers) w.resolve();
  }

  private whenHeading(heading: string): Promise<void> {
    this.throwIfStopped();
    if (this.liveState?.topology.some((row) => headingPathEquals(row.heading_path, heading))) {
      return Promise.resolve();
    }
    this.clearDeadline();
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      this.resetDeadline();
    };
    return new Promise((resolve, reject) => {
      this.headingResolvers.push({
        heading,
        resolve: () => {
          leave();
          resolve();
        },
        reject: (err) => {
          leave();
          reject(err);
        },
      });
    });
  }

  private targetRow(): { heading: string; headingLevel: number } {
    const row = this.liveState?.topology.find((t) => t.fragment_key === this.targetKey);
    if (!row || row.heading_path.length === 0) {
      throw new Error(`h${this.clientIndex}: no topology row for ${this.targetKey}`);
    }
    return { heading: row.heading_path[row.heading_path.length - 1], headingLevel: row.heading_level };
  }

  private buildBodyMarkdown(marker: string): string {
    const current = fragmentMarkdown(this.doc, this.targetKey);
    return current.length === 0 ? marker : `${current}\n${marker}`;
  }

  private buildSplitMarkdown(newHeading: string, newBody: string): string {
    const current = fragmentMarkdown(this.doc, this.targetKey);
    const { headingLevel } = this.targetRow();
    const hashes = "#".repeat(headingLevel);
    return `${current}\n\n${hashes} ${newHeading}\n\n${newBody}`;
  }

  private applyAndSend(buildMarkdown: () => string): void {
    this.throwIfStopped();
    if (this.publishPaused) return;
    const beforeSV = Y.encodeStateVector(this.doc);
    const frag = this.doc.getXmlFragment(this.targetKey);
    this.doc.transact(() => {
      updateYFragment(this.doc, frag, markdownToProseMirrorNode(buildMarkdown()), {
        mapping: new Map(),
        isOMark: new Map(),
      });
    });
    const update = Y.encodeStateAsUpdate(this.doc, beforeSV);
    const sentAt = Date.now();
    this.sendTimes.push(sentAt);
    this.sentCount += 1;
    if (sentAt >= this.pauseClock.lastSendAt) {
      this.pauseClock.lastSendAt = sentAt;
      this.pauseClock.rssAtLastSend = process.memoryUsage().rss;
    }
    if (this.sendAwareness) {
      this.awareness.setLocalStateField("seq", this.sentCount);
      const encoded = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
      this.sendRaw(MSG_AWARENESS, encoded);
    }
    this.sendRaw(MSG_YJS_UPDATE, update);
  }

  private handleMessage(data: Uint8Array): void {
    if (data.length === 0) return;
    const type = data[0];
    const payload = data.subarray(1);
    switch (type) {
      case MSG_SYNC_STEP_2: {
        Y.applyUpdate(this.doc, payload, this);
        break;
      }
      case MSG_UPDATE_ACK: {
        if (payload.length < 4) break;
        const count = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
        if (count > this.ackWatermark) {
          const now = Date.now();
          while (this.ackWatermark < count && this.ackWatermark < this.sendTimes.length) {
            this.ackMs.push(now - this.sendTimes[this.ackWatermark]);
            this.ackWatermark += 1;
          }
          if (this.ackWatermark < count) this.ackWatermark = count;
          const waiting = this.ackResolvers.filter((w) => this.ackWatermark >= w.n);
          this.ackResolvers.splice(0, this.ackResolvers.length, ...this.ackResolvers.filter((w) => this.ackWatermark < w.n));
          for (const w of waiting) w.resolve();
        }
        break;
      }
      case MSG_MODE_TRANSITION_RESULT: {
        this.modeResult = JSON.parse(new TextDecoder().decode(payload)) as ModeTransitionResult;
        if (this.editorReadyMs === null && this.modeResult.kind === "success") {
          this.editorReadyMs = Date.now() - this.connectStartedAt;
        }
        if (this.modeResult.kind === "rejected") {
          this.onUnexpected(`h${this.clientIndex}: editor mode rejected: ${this.modeResult.reason}`);
        }
        this.maybeResolveJoined();
        break;
      }
      case MSG_DOC_PUBLISH_PAUSE_START: {
        if (this.publishPaused) break;
        this.publishPaused = true;
        this.publishReadySent = false;
        if (this.pauseClock.pauseStartAt === null) this.pauseClock.pauseStartAt = Date.now();
        const send = (): void => {
          if (!this.publishPaused || this.publishReadySent) return;
          this.publishReadySent = true;
          this.sendRaw(MSG_DOC_PUBLISH_READY, new Uint8Array(0));
          this.pauseClock.readyCount += 1;
          if (this.pauseClock.readyCount === this.pauseClock.humanCount) {
            this.pauseClock.allReadyAt = Date.now();
          }
        };
        Promise.resolve().then(send);
        break;
      }
      case MSG_DOC_PUBLISH_PAUSE_END: {
        if (!this.publishPaused) break;
        this.publishPaused = false;
        this.publishReadySent = false;
        this.pauseClock.pauseEndCount += 1;
        if (this.pauseClock.pauseEndCount === 1) this.pauseClock.pauseEndAt = Date.now();
        if (this.pauseClock.pauseEndCount === this.pauseClock.humanCount) {
          const resolvers = this.pauseClock.pauseEndWaiters.splice(0);
          for (const w of resolvers) w.resolve();
        }
        break;
      }
      case MSG_LIVE_SECTIONS_BOOTSTRAP: {
        const frame = decodeLiveSectionsBootstrap(payload);
        Y.applyUpdate(this.doc, frame.yjs_update, this);
        this.adoptLiveState(frame.state);
        this.synced = true;
        if (this.bootstrapMs === null) this.bootstrapMs = Date.now() - this.connectStartedAt;
        this.maybeResolveJoined();
        break;
      }
      case MSG_LIVE_SECTIONS_UPDATE: {
        const frame = decodeLiveSectionsUpdate(payload);
        if (frame.yjs_update) Y.applyUpdate(this.doc, frame.yjs_update, this);
        if (frame.state) this.adoptLiveState(frame.state);
        break;
      }
      case MSG_AWARENESS: {
        applyAwarenessUpdate(this.awareness, payload, "remote");
        break;
      }
      default:
        this.onUnexpected(`h${this.clientIndex}: unexpected CRDT opcode 0x${type.toString(16)}`);
    }
  }

  private adoptLiveState(state: WireLiveSectionsState): void {
    this.liveState = state;
    const waiting = this.headingResolvers.filter((w) =>
      state.topology.some((row) => headingPathEquals(row.heading_path, w.heading)),
    );
    this.headingResolvers.splice(
      0,
      this.headingResolvers.length,
      ...this.headingResolvers.filter((w) => !state.topology.some((row) => headingPathEquals(row.heading_path, w.heading))),
    );
    for (const w of waiting) w.resolve();
  }

  private sendRaw(type: number, payload: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const msg = new Uint8Array(1 + payload.length);
    msg[0] = type;
    msg.set(payload, 1);
    this.ws.send(msg);
  }
}
