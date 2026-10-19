import { createServer, type Server } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createApp } from "../../app.js";
import { setSystemReady } from "../../startup-state.js";
import { createCrdtWsServer } from "../../ws/crdt-sync.js";
import {
  requestDocSessionPublish,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { destroyAllSessions, lookupDocSession, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { stripHeadingFromFragment } from "../../storage/section-formatting.js";
import { readSection } from "../../storage/section-reader.js";
import { withExclusiveDataRepoIndex } from "../../storage/data-repo-index-mutex.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { authFor } from "../helpers/auth.js";
import { parseHarnessArgv } from "./argv.js";
import { runAgentPublish } from "./agent-http.js";
import {
  AGENT_COUNT,
  DOC_PATH,
  HUMAN_COUNT,
  HUMAN_TXN_COUNT,
  agentId,
  humanId,
  pad2,
  scenarioHasFlood,
  scenarioHasHumans,
  scenarioHasPause,
  scenarioSendsAwareness,
  startingFragmentKey,
  type ScenarioName,
} from "./constants.js";
import { plantConcurrencyDocument } from "./fixture.js";
import { HarnessCrdtClient, type PauseClock } from "./human-client.js";
import { isEmptyYUpdate, summarizeMs } from "./metrics.js";
import { runWave } from "./prng.js";
import { HEARTBEAT_MS, HarnessWatch, STALL_MS, harnessLog, watchOr } from "./progress.js";
import {
  blankEventLoop,
  writeTranscript,
  type AgentPublishRecord,
  type ConnectMsByClient,
  type EventLoopDelayNs,
  type HttpErrorRecord,
  type RunRecord,
} from "./transcript.js";

function histogramSnapshot(h: ReturnType<typeof monitorEventLoopDelay>): EventLoopDelayNs {
  return {
    min: Number(h.min),
    max: Number(h.max),
    mean: Number(h.mean),
    stddev: Number(h.stddev),
    p50: Number(h.percentile(50)),
    p95: Number(h.percentile(95)),
    p99: Number(h.percentile(99)),
    count: Number(h.count),
    exceeds: Number(h.exceeds),
  };
}

function startLaneWrap(counter: { n: number; inFlight: number }): () => void {
  let stopped = false;
  let wrapped = false;
  const tick = (): void => {
    if (stopped || wrapped) return;
    const session = lookupDocSession(DOC_PATH);
    if (!session) {
      setImmediate(tick);
      return;
    }
    const original = session.enqueue;
    session.enqueue = ((command: () => unknown) => {
      counter.n += 1;
      counter.inFlight += 1;
      const result = original(command);
      void Promise.resolve(result).finally(() => {
        counter.inFlight -= 1;
      });
      return result;
    }) as DocSession["enqueue"];
    wrapped = true;
  };
  tick();
  return () => {
    stopped = true;
  };
}

function newPauseClock(humanCount: number): PauseClock {
  return {
    lastSendAt: 0,
    rssAtLastSend: 0,
    pauseStartAt: null,
    allReadyAt: null,
    pauseEndAt: null,
    readyCount: 0,
    pauseEndCount: 0,
    humanCount,
    pauseEndWaiters: [],
  };
}

function docsAgree(session: DocSession, clients: HarnessCrdtClient[]): string | null {
  const serverSV = Y.encodeStateVector(session.ydoc);
  const parts: string[] = [];
  for (const client of clients) {
    const toClient = Y.encodeStateAsUpdate(session.ydoc, Y.encodeStateVector(client.doc));
    const toServer = Y.encodeStateAsUpdate(client.doc, serverSV);
    if (!isEmptyYUpdate(toClient) || !isEmptyYUpdate(toServer)) {
      parts.push(
        `h${pad2(client.clientIndex)} missingOnClient=${toClient.byteLength}B extraOnClient=${toServer.byteLength}B`,
      );
    }
  }
  if (parts.length === 0) return null;
  return `Y.Doc disagreement (${parts.length} of ${clients.length}): ${parts.join("; ")}`;
}

async function canonicalMatchesLive(session: DocSession): Promise<string | null> {
  const layout = await resolveLiveSectionLayout(session);
  for (const row of layout) {
    const canonical = await readSection(DOC_PATH, [...row.headingPath]);
    const live = stripHeadingFromFragment(
      session.liveFragments.readFragmentString(row.fragmentKey),
      row.headingLevel,
    );
    if (canonical !== live) {
      return `canonical/live body mismatch at ${JSON.stringify(row.headingPath)}`;
    }
  }
  return null;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 500);
    server.close((err) => {
      clearTimeout(timer);
      err ? reject(err) : resolve();
    });
  });
}

describe("20x20 concurrency harness", () => {
  it("runs one scenario from process.argv after --", async () => {
    const identity = parseHarnessArgv();
    const failReasons: string[] = [];
    let aborted = false;
    const noteFail = (message: string): void => {
      if (!failReasons.includes(message)) failReasons.push(message);
    };
    const abortAll = (message: string): void => {
      if (aborted) return;
      aborted = true;
      noteFail(message);
      harnessLog(`abort: ${message}`);
      for (const w of pause.pauseEndWaiters.splice(0)) w.reject(new Error(message));
      for (const h of humans) h?.close();
    };
    const fail = (message: string): never => {
      abortAll(message);
      throw new Error(message);
    };

    const record: RunRecord = {
      ok: false,
      identity,
      elapsedMs: 0,
      eventLoopDelayNs: blankEventLoop(),
      updateAck: null,
      connect: null,
      publishPause: null,
      agents: [],
      laneIdleMs: null,
      laneCommandCount: null,
      gitMutexIdleMs: 0,
      rss: { start: 0, floodPeak: 0, afterDrain: 0 },
      socketCloses: [],
      gitErrors: [],
      httpErrors: [],
      unhandledRejections: [],
    };

    const onUnhandled = (reason: unknown): void => {
      record.unhandledRejections.push(reason instanceof Error ? reason.message : String(reason));
    };
    process.on("unhandledRejection", onUnhandled);

    let dataCtx: TempDataRootContext | undefined;
    let server: Server | undefined;
    const humans: Array<HarnessCrdtClient | undefined> = Array.from({ length: HUMAN_COUNT });
    const loop = monitorEventLoopDelay();
    const laneCounter = { n: 0, inFlight: 0 };
    let stopWrap: (() => void) | undefined;
    const runStartedAt = Date.now();
    const pause = newPauseClock(HUMAN_COUNT);
    const agentResults: Array<AgentPublishRecord | undefined> = [];
    let watch: HarnessWatch | undefined;
    harnessLog(`${identity.scenario} seed=${identity.seed} ${identity.bfh} ${identity.kind}`);

    try {
      watch = new HarnessWatch({
        startedAt: runStartedAt,
        stallMs: STALL_MS,
        heartbeatMs: HEARTBEAT_MS,
        onAbort: abortAll,
        take: () => ({
          laneCommandCount: laneCounter.n,
          laneInFlight: laneCounter.inFlight,
          agentsDone: agentResults.filter((row) => row !== undefined).length,
          pauseStart: pause.pauseStartAt !== null,
          pauseReady: pause.readyCount,
          pauseEnd: pause.pauseEndCount,
          clients: humans.filter((h): h is HarnessCrdtClient => h !== undefined).map((h) => h.snapshot()),
        }),
      });
      watch.start();
      watch.setPhase("plant");
      dataCtx = await watchOr(watch, createTempDataRoot());
      await watchOr(watch, plantConcurrencyDocument(dataCtx.rootDir, identity.bfh));
      setSystemReady();

      const app = createApp();
      const crdtWs = createCrdtWsServer();
      server = createServer(app);
      server.on("upgrade", (request, socket, head) => {
        const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
        if (pathname.startsWith("/ws/crdt/")) {
          crdtWs.handleUpgrade(request, socket, head);
        } else {
          socket.destroy();
        }
      });
      const port = await watchOr(
        watch,
        new Promise<number>((resolve) => {
          server!.listen(0, "127.0.0.1", () => {
            resolve((server!.address() as { port: number }).port);
          });
        }),
      );

      loop.enable();
      record.rss.start = process.memoryUsage().rss;
      harnessLog(`listening 127.0.0.1:${port}`);

      const scenario: ScenarioName = identity.scenario;
      const unexpected: string[] = [];
      const onUnexpected = (message: string): void => {
        unexpected.push(message);
        abortAll(message);
      };

      if (scenarioHasHumans(scenario)) {
        stopWrap = startLaneWrap(laneCounter);
      }

      const makeHuman = (index: number): HarnessCrdtClient =>
        new HarnessCrdtClient({
          port,
          token: authFor(humanId(index), "human"),
          clientIndex: index,
          startingKey: startingFragmentKey(scenario, index),
          sendAwareness: scenarioSendsAwareness(scenario),
          pauseClock: pause,
          onUnexpected,
          onAbort: abortAll,
        });

      const joinOnly = scenario === "join-storm" || scenario === "join-and-agents";
      const joinTask = (index: number) => async (): Promise<void> => {
        humans[index] = makeHuman(index);
        await humans[index]!.whenJoined();
        if (joinOnly) humans[index]!.stopDeadline();
      };

      const floodTask = (index: number) => async (): Promise<void> => {
        const client = humans[index];
        if (!client) throw new Error(`human ${index} missing before flood`);
        await client.flood(identity.seed, identity.kind);
      };

      const httpErrors: HttpErrorRecord[] = [];
      const agentTask = (index: number) => async (): Promise<void> => {
        const result = await runAgentPublish(port, authFor(agentId(index), "agent"), index, identity.seed);
        agentResults[index] = result.record;
        if (result.httpError) httpErrors.push(result.httpError);
        if (result.gitError) record.gitErrors.push(result.gitError);
        if (result.throwMessage) fail(`agent ${index}: ${result.throwMessage}`);
      };

      if (scenario === "agents-disjoint") {
        watch.setPhase("agents");
        await watchOr(
          watch,
          runWave(
            identity.seed,
            Array.from({ length: AGENT_COUNT }, (_, i) => agentTask(i)),
          ),
        );
        record.rss.floodPeak = process.memoryUsage().rss;
      } else if (scenario === "join-storm") {
        watch.setPhase("join");
        await watchOr(
          watch,
          runWave(
            identity.seed,
            Array.from({ length: HUMAN_COUNT }, (_, i) => joinTask(i)),
          ),
        );
        record.rss.floodPeak = process.memoryUsage().rss;
      } else if (scenario === "join-and-agents") {
        watch.setPhase("join+agents");
        await watchOr(
          watch,
          runWave(identity.seed, [
            ...Array.from({ length: HUMAN_COUNT }, (_, i) => joinTask(i)),
            ...Array.from({ length: AGENT_COUNT }, (_, i) => agentTask(i)),
          ]),
        );
        record.rss.floodPeak = process.memoryUsage().rss;
      } else if (scenario === "humans-and-agents") {
        watch.setPhase("join");
        await watchOr(
          watch,
          runWave(
            identity.seed,
            Array.from({ length: HUMAN_COUNT }, (_, i) => joinTask(i)),
          ),
        );
        watch.setPhase("flood+agents");
        await watchOr(
          watch,
          runWave(identity.seed, [
            ...Array.from({ length: HUMAN_COUNT }, (_, i) => floodTask(i)),
            ...Array.from({ length: AGENT_COUNT }, (_, i) => agentTask(i)),
          ]),
        );
        record.rss.floodPeak = pause.rssAtLastSend;
      } else {
        watch.setPhase("join");
        await watchOr(
          watch,
          runWave(
            identity.seed,
            Array.from({ length: HUMAN_COUNT }, (_, i) => joinTask(i)),
          ),
        );
        watch.setPhase("flood");
        await watchOr(
          watch,
          runWave(
            identity.seed,
            Array.from({ length: HUMAN_COUNT }, (_, i) => floodTask(i)),
          ),
        );
        record.rss.floodPeak = pause.rssAtLastSend;
      }

      const liveHumans = humans.filter((h): h is HarnessCrdtClient => h !== undefined);
      for (const msg of unexpected) fail(msg);
      for (const h of liveHumans) {
        if (h.closedDuringFlood) fail(`human ${h.clientIndex} socket closed during flood`);
      }

      if (scenarioHasPause(scenario)) {
        for (const h of liveHumans) h.stopDeadline();
        watch.setPhase("publish-pause");
        const pauseEnds = Promise.all(liveHumans.map((h) => h.whenPauseEnd()));
        const published = requestDocSessionPublish(DOC_PATH);
        await watchOr(watch, pauseEnds);
        const outcome = await watchOr(watch, published);
        if (outcome.outcome !== "committed") {
          fail(`publish outcome ${outcome.outcome}${outcome.message ? `: ${outcome.message}` : ""}`);
        }
        if (pause.pauseStartAt !== null && pause.allReadyAt !== null && pause.pauseEndAt !== null) {
          record.publishPause = {
            lastSendToPauseStartMs: pause.pauseStartAt - pause.lastSendAt,
            pauseStartToAllAcksMs: pause.allReadyAt - pause.pauseStartAt,
            allAcksToPauseEndMs: pause.pauseEndAt - pause.allReadyAt,
          };
        } else {
          fail("publish pause never reached pause-end");
        }
      }

      const session = lookupDocSession(DOC_PATH);
      if (scenario !== "agents-disjoint") {
        if (!session) fail("DocSession missing after run");
        else {
          watch.setPhase("drain");
          const tLane = Date.now();
          await watchOr(
            watch,
            session.enqueue(() => {
              void Y.encodeStateVector(session.ydoc);
            }),
          );
          record.laneIdleMs = Date.now() - tLane;
          record.laneCommandCount = laneCounter.n;
        }
      }

      const tMutex = Date.now();
      await watchOr(
        watch,
        withExclusiveDataRepoIndex(() => undefined),
      );
      record.gitMutexIdleMs = Date.now() - tMutex;
      record.rss.afterDrain = process.memoryUsage().rss;
      watch.stop();

      await new Promise<void>((resolve) => {
        setImmediate(() => resolve());
      });

      if (session && scenario !== "agents-disjoint") {
        watch.setPhase("ydoc-agree");
        const disagreement = docsAgree(session, liveHumans);
        if (disagreement) {
          harnessLog(disagreement);
          fail(disagreement);
        }
      }

      if (session && (scenarioHasPause(scenario) || scenario === "join-and-agents")) {
        watch.setPhase("canonical");
        const mismatch = await canonicalMatchesLive(session);
        if (mismatch) {
          harnessLog(mismatch);
          fail(mismatch);
        }
      }

      if (scenario === "join-storm") {
        watch.setPhase("canonical");
        const mismatch = session ? await canonicalMatchesLive(session) : "DocSession missing for join-storm canonical check";
        if (mismatch) {
          harnessLog(mismatch);
          fail(mismatch);
        }
      }

      if (liveHumans.length > 0) {
        const editorReady = liveHumans.map((h) => h.editorReadyMs);
        const bootstrap = liveHumans.map((h) => h.bootstrapMs);
        if (editorReady.some((v) => v === null) || bootstrap.some((v) => v === null)) {
          fail("missing connect timings");
        } else {
          const editorReadyMs = editorReady as number[];
          const bootstrapMs = bootstrap as number[];
          const editor = summarizeMs(editorReadyMs);
          const boot = summarizeMs(bootstrapMs);
          record.connect = {
            editorReadyP50Ms: editor.p50Ms,
            editorReadyP95Ms: editor.p95Ms,
            editorReadyMaxMs: editor.maxMs,
            bootstrapP50Ms: boot.p50Ms,
            bootstrapP95Ms: boot.p95Ms,
            bootstrapMaxMs: boot.maxMs,
          };
          record.connectMsByClient = liveHumans.map((h) => ({
            editorReadyMs: h.editorReadyMs!,
            bootstrapMs: h.bootstrapMs!,
          }));
        }
      }

      if (scenarioHasFlood(scenario)) {
        const allAckMs = liveHumans.flatMap((h) => h.ackMs);
        const sent = liveHumans.reduce((n, h) => n + h.sendTimes.length, 0);
        if (allAckMs.length < sent) fail(`update-ack count ${allAckMs.length} < sends ${sent}`);
        if (sent !== HUMAN_COUNT * HUMAN_TXN_COUNT) fail(`sent ${sent}, expected ${HUMAN_COUNT * HUMAN_TXN_COUNT}`);
        if (allAckMs.length > 0) {
          const stats = summarizeMs(allAckMs);
          record.updateAck = { count: allAckMs.length, ...stats };
        }
        record.updateAckMsByClient = liveHumans.map((h) => [...h.ackMs]);
      }

      record.agents = agentResults.filter((row): row is AgentPublishRecord => row !== undefined);
      record.httpErrors = httpErrors;
      if (httpErrors.length > 0) fail(`HTTP 5xx: ${JSON.stringify(httpErrors)}`);
      if (record.gitErrors.length > 0) fail(`git errors: ${record.gitErrors.join("; ")}`);
      if (record.unhandledRejections.length > 0) {
        fail(`unhandled rejections: ${record.unhandledRejections.join("; ")}`);
      }

      loop.disable();
    } catch (error) {
      abortAll(error instanceof Error ? error.message : String(error));
    } finally {
      watch?.stop();
      stopWrap?.();
      process.off("unhandledRejection", onUnhandled);
      try {
        loop.disable();
        record.eventLoopDelayNs = histogramSnapshot(loop);
      } catch {
        /* histogram unused */
      }
      for (const h of humans) h?.close();
      await new Promise<void>((resolve) => {
        setImmediate(() => resolve());
      });
      record.socketCloses = humans
        .filter((h): h is HarnessCrdtClient => h !== undefined && h.closed !== null)
        .map((h) => h.closed!);
      if (server) {
        try {
          await closeServer(server);
        } catch (error) {
          noteFail(`server.close: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      destroyAllSessions();
      resetCoordinatorPublishStateForTest();
      setCrdtEventHandler(() => {});
      if (dataCtx) await dataCtx.cleanup();
      record.elapsedMs = Date.now() - runStartedAt;
      record.ok = failReasons.length === 0;
      if (!record.ok) {
        record.updateAckMsByClient = record.updateAckMsByClient ?? humans
          .filter((h): h is HarnessCrdtClient => h !== undefined)
          .map((h) => [...h.ackMs]);
        record.connectMsByClient = record.connectMsByClient ?? humans
          .filter((h): h is HarnessCrdtClient => h !== undefined)
          .map((h) => ({
            editorReadyMs: h.editorReadyMs ?? -1,
            bootstrapMs: h.bootstrapMs ?? -1,
          } satisfies ConnectMsByClient));
      } else {
        delete record.updateAckMsByClient;
        delete record.connectMsByClient;
      }
      const transcript = await writeTranscript(record);
      harnessLog(`wrote ${transcript} ok=${record.ok}`);
      if (failReasons.length > 0) harnessLog(failReasons.join("\n"));
    }

    expect(record.ok, failReasons.join("\n")).toBe(true);
  });
});
