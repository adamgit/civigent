import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentUser } from "../../contexts/CurrentUserContext";
import { apiClient } from "../../services/api-client";
import type { GetRuntimeMemoryResponse, RuntimeMemoryRssSample } from "../../types/shared.js";

const POLL_INTERVAL_MS = 5000;
const WINDOW_MS = 100_000;
const FALLBACK_INTERVAL_MS = 5000;
const RSS_NUMBER = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 });

function formatRss(bytes: number | null): { amount: string; unit: string } {
  if (bytes === null) return { amount: "—", unit: "" };
  const MiB = 1024 * 1024;
  const GiB = 1024 * MiB;
  const unit = bytes >= GiB ? "GiB" : bytes >= MiB ? "MiB" : "KiB";
  const value = bytes / (unit === "GiB" ? GiB : unit === "MiB" ? MiB : 1024);
  return { amount: RSS_NUMBER.format(value), unit };
}

function formatBarLabel(bytes: number): string {
  const { amount, unit } = formatRss(bytes);
  return unit ? `${amount} ${unit}` : amount;
}

function barCountForInterval(sampleIntervalMs: number | undefined): number {
  const interval = sampleIntervalMs && sampleIntervalMs > 0 ? sampleIntervalMs : FALLBACK_INTERVAL_MS;
  return Math.max(1, Math.round(WINDOW_MS / interval));
}

function MemorySparkline({
  samples,
  sampleIntervalMs,
}: {
  samples: RuntimeMemoryRssSample[];
  sampleIntervalMs: number | undefined;
}) {
  const barCount = barCountForInterval(sampleIntervalMs);
  const recent = samples.slice(-barCount);
  const max = recent.reduce((peak, sample) => Math.max(peak, sample.process_rss_bytes), 0);
  const missing = barCount - recent.length;
  const bars: Array<{ key: string; heightPx: number | null; heightPct: number | null; title?: string }> = [];

  for (let i = 0; i < missing; i++) {
    bars.push({ key: `missing-${i}`, heightPx: 1, heightPct: null });
  }
  for (const sample of recent) {
    if (max <= 0 || sample.process_rss_bytes <= 0) {
      bars.push({
        key: String(sample.timestamp_ms),
        heightPx: 1,
        heightPct: null,
        title: `${formatBarLabel(sample.process_rss_bytes)} @ ${new Date(sample.timestamp_ms).toLocaleTimeString()}`,
      });
    } else {
      bars.push({
        key: String(sample.timestamp_ms),
        heightPx: null,
        heightPct: (sample.process_rss_bytes / max) * 100,
        title: `${formatBarLabel(sample.process_rss_bytes)} @ ${new Date(sample.timestamp_ms).toLocaleTimeString()}`,
      });
    }
  }

  return (
    <div className="home-memory-widget__sparkline" role="img" aria-label="Backend memory over the last 100 seconds">
      {bars.map((bar) => (
        <span
          key={bar.key}
          className="home-memory-widget__bar"
          style={bar.heightPx !== null ? { height: `${bar.heightPx}px` } : { height: `${bar.heightPct}%` }}
          title={bar.title}
        />
      ))}
    </div>
  );
}

function HomeMemoryWidgetBody({ compact }: { compact: boolean }) {
  const [data, setData] = useState<GetRuntimeMemoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await apiClient.getRuntimeMemory();
      if (!mountedRef.current) return;
      setData(response);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
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

  if (error) {
    return <span className="home-memory-widget__error">Memory unavailable</span>;
  }

  const { amount, unit } = formatRss(data?.current?.process_rss_bytes ?? null);
  const reading = unit ? `${amount} ${unit}` : amount;

  return (
    <>
      <span className="home-memory-widget__reading">
        {compact ? (
          <span className="home-memory-widget__amount">{reading}</span>
        ) : (
          <>
            <span className="home-memory-widget__amount">{amount}</span>
            {unit ? <span className="home-memory-widget__unit">{unit}</span> : null}
          </>
        )}
      </span>
      <MemorySparkline samples={data?.samples ?? []} sampleIntervalMs={data?.sample_interval_ms} />
    </>
  );
}

interface HomeMemoryWidgetProps {
  variant?: "card" | "inline";
}

export function HomeMemoryWidget({ variant = "card" }: HomeMemoryWidgetProps) {
  const currentUser = useCurrentUser();
  const compact = variant === "inline";
  const className = compact ? "home-memory-inline" : "home-card home-memory-widget";
  const body = <HomeMemoryWidgetBody compact={compact} />;
  if (currentUser?.is_admin) {
    return (
      <Link
        to="/admin/runtime-memory"
        className={className}
        aria-label="Backend memory. Open runtime memory admin page."
      >
        {body}
      </Link>
    );
  }
  return (
    <div className={className} aria-label="Backend memory">
      {body}
    </div>
  );
}
