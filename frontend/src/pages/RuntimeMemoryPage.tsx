import { useCallback, useEffect, useRef, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type {
  GetAdminRuntimeMemoryResponse,
  RuntimeMemoryProcess,
  RuntimeMemorySample,
} from "../types/shared.js";

const POLL_INTERVAL_MS = 5000;

const CONTAINER_MEMORY_COLOR = {
  dark: "#4b5563",
};

const CIVIGENT_RSS_COLOR = {
  light: "#34d399",
  dark: "#047857",
};

const JS_HEAP_COLOR = {
  light: "#60a5fa",
  dark: "#1d4ed8",
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const MiB = 1024 * 1024;
  const GiB = 1024 * MiB;
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(2)} GiB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function formatUptime(startedAt: string): string {
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return "—";
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const hours = Math.floor(elapsedSec / 3600);
  const minutes = Math.floor((elapsedSec % 3600) / 60);
  const seconds = elapsedSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

type MeasureKey = "container_memory_bytes" | "process_rss_bytes" | "heap_used_bytes";

interface MeasureDef {
  key: MeasureKey;
  title: string;
  explanation: string;
  barColor: string;
}

const MEASURES: MeasureDef[] = [
  {
    key: "container_memory_bytes",
    title: "Container memory",
    explanation:
      "Best Docker/EC2 sizing proxy because it reflects the memory the container is currently using.",
    barColor: CONTAINER_MEMORY_COLOR.dark,
  },
  {
    key: "process_rss_bytes",
    title: "Civigent backend",
    explanation:
      "Main Node process resident memory, including heap and native allocations.",
    barColor: CIVIGENT_RSS_COLOR.light,
  },
  {
    key: "heap_used_bytes",
    title: "JavaScript heap used",
    explanation:
      "Live JavaScript object heap; sustained growth here can indicate retained app data.",
    barColor: JS_HEAP_COLOR.light,
  },
];

function KVRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border last:border-0">
      <span className="text-[12px] font-medium text-text-muted w-56 shrink-0">{label}</span>
      <span className="text-[13px] text-text-primary">{children}</span>
    </div>
  );
}

function MeasureChart({
  measure,
  samples,
  highWater,
}: {
  measure: MeasureDef;
  samples: RuntimeMemorySample[];
  highWater: number | null;
}) {
  const values: (number | null)[] = samples.map((s) => s[measure.key]);
  const numericValues = values.filter((v): v is number => v !== null);

  if (measure.key === "container_memory_bytes" && numericValues.length === 0) {
    return (
      <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white mb-4">
        <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
          <div className="text-[13px] font-semibold text-text-primary">{measure.title}</div>
          <div className="text-[11px] text-text-muted">{measure.explanation}</div>
        </div>
        <div className="px-4 py-4 text-[12px] italic text-text-muted">
          Unavailable outside container/cgroup environment.
        </div>
      </div>
    );
  }

  const latestValue = numericValues.length > 0 ? numericValues[numericValues.length - 1] : null;
  const sampleMax = numericValues.length > 0 ? Math.max(...numericValues) : 0;
  const scaleMax = Math.max(sampleMax, highWater ?? 0, 1);
  const highWaterPct = highWater !== null ? (highWater / scaleMax) * 100 : null;

  return (
    <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white mb-4">
      <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
        <div className="text-[13px] font-semibold text-text-primary">{measure.title}</div>
        <div className="text-[11px] text-text-muted">{measure.explanation}</div>
      </div>
      <div className="px-4 py-3">
        <div className="flex items-baseline justify-between text-[12px] mb-2">
          <span className="text-text-muted">
            Latest: <span className="text-text-primary font-medium">{formatBytes(latestValue)}</span>
          </span>
          <span className="text-text-muted">
            Peak: <span className="text-text-primary font-medium">{formatBytes(highWater)}</span>
          </span>
        </div>
        <div
          className="relative bg-[#f7f5f1] border border-[#eae7e2] rounded"
          style={{ height: 80 }}
        >
          <div
            className="absolute inset-0 flex items-end"
            style={{ paddingLeft: 2, paddingRight: 2, gap: 1 }}
          >
            {values.map((value, i) => {
              if (value === null) {
                return (
                  <div
                    key={i}
                    className="flex-1"
                    style={{ height: "0%", background: "transparent" }}
                    title="Unavailable"
                  />
                );
              }
              const pct = (value / scaleMax) * 100;
              return (
                <div
                  key={i}
                  className="flex-1 rounded-t-sm"
                  style={{ height: `${pct}%`, minHeight: 1, backgroundColor: measure.barColor }}
                  title={`${formatBytes(value)} @ ${new Date(samples[i].timestamp_ms).toLocaleTimeString()}`}
                />
              );
            })}
          </div>
          {highWaterPct !== null && (
            <div
              className="absolute left-0 right-0 border-t border-dashed border-amber-500 pointer-events-none"
              style={{ bottom: `${highWaterPct}%` }}
              title={`Peak: ${formatBytes(highWater)}`}
            />
          )}
        </div>
        <div className="flex items-center justify-between text-[10px] text-text-muted mt-1">
          <span>0</span>
          <span>Scale max: {formatBytes(scaleMax)}</span>
        </div>
      </div>
    </div>
  );
}

function MemoryCompositionCard({ current }: { current: RuntimeMemorySample | null }) {
  if (!current) return null;

  const container = current.container_memory_bytes;
  const rss = current.process_rss_bytes;
  const heap = current.heap_used_bytes;
  const heapSegment = Math.min(heap, rss);
  const nativeSegment = Math.max(rss - heapSegment, 0);
  const outsideSegment = container !== null ? Math.max(container - rss, 0) : 0;
  const total = Math.max(container ?? 0, heapSegment + nativeSegment + outsideSegment, 1);
  const estimatedOutside = container !== null ? Math.max(container - rss, 0) : null;

  const segments = [
    { label: "JS heap", value: heapSegment, color: JS_HEAP_COLOR.light },
    { label: "Civigent outside heap", value: nativeSegment, color: CIVIGENT_RSS_COLOR.light },
    { label: "Estimated cgroup outside backend", value: outsideSegment, color: CONTAINER_MEMORY_COLOR.dark },
  ].filter((segment) => segment.value > 0);

  return (
    <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white mb-4">
      <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
        <div className="text-[13px] font-semibold text-text-primary">Memory composition</div>
        <div className="text-[11px] text-text-muted">
          JS heap is part of backend mem; backend mem is compared against the cgroup container total.
        </div>
      </div>
      <div className="px-4 py-3">
        <div className="h-10 flex overflow-hidden rounded border border-[#eae7e2] bg-[#f7f5f1]">
          {segments.map((segment) => {
            const pct = (segment.value / total) * 100;
            return (
              <div
                key={segment.label}
                className="h-full flex items-center justify-center text-[11px] font-medium text-white px-2 whitespace-nowrap overflow-hidden"
                style={{ width: `${pct}%`, backgroundColor: segment.color, minWidth: pct > 0 ? 2 : 0 }}
                title={`${segment.label}: ${formatBytes(segment.value)}`}
              >
                {pct >= 12 ? segment.label : ""}
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mt-3 text-[11px] text-text-muted">
          <div><span className="font-medium" style={{ color: CONTAINER_MEMORY_COLOR.dark }}>Container:</span> {formatBytes(container)}</div>
          <div><span className="font-medium" style={{ color: CIVIGENT_RSS_COLOR.dark }}>Civigent:</span> {formatBytes(rss)}</div>
          <div><span className="font-medium" style={{ color: JS_HEAP_COLOR.dark }}>JS heap:</span> {formatBytes(heap)}</div>
          <div><span className="font-medium" style={{ color: CONTAINER_MEMORY_COLOR.dark }}>Outside estimate:</span> {formatBytes(estimatedOutside)}</div>
        </div>
        <div className="text-[11px] text-text-muted mt-2">
          Outside estimate is container memory minus this backend process RSS; it can include dev tools, other
          processes, page cache, and kernel cgroup accounting.
        </div>
      </div>
    </div>
  );
}

interface MemoryBarItem {
  id: string;
  label: string;
  sublabel: string;
  value: number;
  title: string;
  expectedInProduction: boolean;
}

function MajorMemoryBarsCard({
  title,
  explanation,
  unavailable,
  emptyMessage,
  items,
}: {
  title: string;
  explanation: string;
  unavailable: boolean;
  emptyMessage: string;
  items: MemoryBarItem[];
}) {
  if (unavailable) {
    return (
      <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white h-full">
        <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
          <div className="text-[13px] font-semibold text-text-primary">{title}</div>
          <div className="text-[11px] text-text-muted">Unavailable outside container/cgroup environment.</div>
        </div>
      </div>
    );
  }

  const maxValue = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white h-full">
      <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
        <div className="text-[13px] font-semibold text-text-primary">{title}</div>
        <div className="text-[11px] text-text-muted">{explanation}</div>
      </div>
      <div className="px-4 py-3">
        {items.length === 0 ? (
          <div className="text-[12px] italic text-text-muted">{emptyMessage}</div>
        ) : (
          <div className="overflow-x-auto">
            <div className="flex items-end gap-2 h-28">
              {items.map((item) => {
                const heightPct = (item.value / maxValue) * 100;
                const barColor = item.expectedInProduction ? CIVIGENT_RSS_COLOR.light : "#d8dee6";
                const barBorderColor = item.expectedInProduction ? CIVIGENT_RSS_COLOR.dark : "#c8d0da";
                const labelColor = item.expectedInProduction ? CIVIGENT_RSS_COLOR.dark : "#3a3530";
                return (
                  <div
                    key={item.id}
                    className="relative h-full"
                    style={{ width: "15ch", minWidth: 0 }}
                    title={item.title}
                  >
                    <div
                      className="absolute bottom-0 left-0 right-0 border"
                      style={{ height: `${heightPct}%`, backgroundColor: barColor, borderColor: barBorderColor }}
                    />
                    <div className="relative z-10 px-1 pt-1">
                      <div className="text-[11px] font-medium truncate" style={{ color: labelColor }}>{item.label}</div>
                      <div className="text-[10px] text-text-muted truncate">{item.sublabel}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProcessBreakdownCard({
  processes,
  containerMemory,
}: {
  processes: RuntimeMemoryProcess[];
  containerMemory: number | null;
}) {
  const threshold = containerMemory !== null ? containerMemory * 0.02 : 0;
  const items = containerMemory === null ? [] : processes
    .filter((process) => process.rss_bytes > threshold)
    .map((process) => {
      const pct = (process.rss_bytes / containerMemory) * 100;
      return {
        id: String(process.pid),
        label: process.display_name,
        sublabel: formatBytes(process.rss_bytes),
        value: process.rss_bytes,
        title: `pid ${process.pid} (${process.name}): ${formatBytes(process.rss_bytes)} (${pct.toFixed(1)}% of cgroup memory)`,
        expectedInProduction: process.expected_in_production,
      };
    });

  return (
    <MajorMemoryBarsCard
      title="Major cgroup processes"
      explanation="Processes with RSS above 5% of current cgroup memory. Useful for spotting dev-mode overhead."
      unavailable={containerMemory === null}
      emptyMessage="No single process is above 5% of cgroup memory."
      items={items}
    />
  );
}

export function RuntimeMemoryPage() {
  const [data, setData] = useState<GetAdminRuntimeMemoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await apiClient.getAdminRuntimeMemory();
      if (!mountedRef.current) return;
      setData(response);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const handle = setInterval(() => { void load(); }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(handle);
    };
  }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SharedPageHeader title="Runtime Memory" backTo="/admin" />
      <div className="flex-1 min-h-0 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>

        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="text-xs px-3 py-1.5 bg-[#f7f5f1] border border-[#eae7e2] rounded hover:bg-[#eae7e2] text-[#3a3530] disabled:opacity-50"
          >
            Refresh
          </button>
          <span className="text-[11px] text-text-muted ml-2">
            Polls every {POLL_INTERVAL_MS / 1000}s
          </span>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-[12px] font-mono whitespace-pre-wrap">
            {error}
          </div>
        )}

        {loading && !data && (
          <p className="text-xs text-text-muted">Loading...</p>
        )}

        {data && (
          <>
            <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white mb-4">
              <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
                <div className="text-[13px] font-semibold text-text-primary">Summary</div>
                <div className="text-[11px] text-text-muted">In-memory only — resets when the server restarts</div>
              </div>
              <KVRow label="Server uptime">{formatUptime(data.started_at)}</KVRow>
              <KVRow label="Container memory">
                <span className="text-text-primary">{formatBytes(data.current?.container_memory_bytes ?? null)}</span>
                <span className="text-text-muted ml-2">peak {formatBytes(data.high_water_mark.container_memory_bytes)}</span>
              </KVRow>
              <KVRow label={<span style={{ color: CIVIGENT_RSS_COLOR.light }}>Civigent backend</span>}>
                <span className="font-medium" style={{ color: CIVIGENT_RSS_COLOR.dark }}>{formatBytes(data.current?.process_rss_bytes ?? null)}</span>
                <span className="text-text-muted ml-2">peak {formatBytes(data.high_water_mark.process_rss_bytes)}</span>
              </KVRow>
              <KVRow label={<span style={{ color: JS_HEAP_COLOR.light }}>JavaScript heap used</span>}>
                <span className="font-medium" style={{ color: JS_HEAP_COLOR.dark }}>{formatBytes(data.current?.heap_used_bytes ?? null)}</span>
                <span className="text-text-muted ml-2">peak {formatBytes(data.high_water_mark.heap_used_bytes)}</span>
              </KVRow>
            </div>

            <MemoryCompositionCard current={data.current} />

            <div className="mb-4">
              <ProcessBreakdownCard
                processes={data.cgroup_processes ?? []}
                containerMemory={data.current?.container_memory_bytes ?? null}
              />
            </div>

            {MEASURES.map((measure) => (
              <MeasureChart
                key={measure.key}
                measure={measure}
                samples={data.samples}
                highWater={data.high_water_mark[measure.key]}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
