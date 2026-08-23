import type { ActivityItem } from "../../../types/shared.js";
import { isReadTool, isWriteTool } from "./mcp-kind.js";
import type { HomeMcpPulseAction, HomePulseHourBar } from "./types.js";

export const PULSE_HOUR_COUNT = 24;
export const PULSE_DAY_COUNT = 7;
export const PULSE_1H_SLOT_COUNT = 12;
export const PULSE_1H_SLOT_MS = 5 * 60 * 1000;
/** Widest pulse toggle (7 days); backend caps MCP pulse at 168 hours. */
export const PULSE_FETCH_HOURS = PULSE_DAY_COUNT * PULSE_HOUR_COUNT;

export const PULSE_RANGE_OPTIONS = [
  { id: "1h", label: "1h" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7 days" },
] as const;

export type PulseRangeId = (typeof PULSE_RANGE_OPTIONS)[number]["id"];

const HOUR_MS = 60 * 60 * 1000;

export function currentHourStartMs(nowMs: number): number {
  const date = new Date(nowMs);
  date.setMinutes(0, 0, 0);
  date.setMilliseconds(0);
  return date.getTime();
}

export function currentDayStartMs(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function pulseHourStarts(nowMs: number): number[] {
  const end = currentHourStartMs(nowMs);
  const starts: number[] = [];
  for (let i = PULSE_HOUR_COUNT - 1; i >= 0; i--) {
    starts.push(end - i * HOUR_MS);
  }
  return starts;
}

function nextDayStartMs(startMs: number): number {
  const date = new Date(startMs);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

function hourLabel(startMs: number): string {
  return String(new Date(startMs).getHours()).padStart(2, "0");
}

function clockLabel(startMs: number): string {
  const date = new Date(startMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(startMs: number): string {
  const date = new Date(startMs);
  const weekday = date.toLocaleDateString([], { weekday: "short" });
  return `${weekday} ${date.getDate()}`;
}

export function currentSlotStartMs(nowMs: number, slotMs: number): number {
  return Math.floor(nowMs / slotMs) * slotMs;
}

function countIntoBars(
  bars: HomePulseHourBar[],
  actions: readonly HomeMcpPulseAction[],
  activity: readonly ActivityItem[],
): void {
  for (const action of actions) {
    const ts = Date.parse(action.ts);
    if (Number.isNaN(ts)) continue;
    const bar = bars.find((row) => ts >= row.startMs && ts < row.endMs);
    if (!bar) continue;
    if (isReadTool(action.method)) bar.readCount += 1;
    else if (isWriteTool(action.method)) bar.writeCount += 1;
  }

  for (const item of activity) {
    if (item.writer_type !== "agent") continue;
    const ts = Date.parse(item.timestamp);
    if (Number.isNaN(ts)) continue;
    const bar = bars.find((row) => ts >= row.startMs && ts < row.endMs);
    if (!bar) continue;
    bar.writeCount += 1;
  }
}

export function buildPulse1hBars(
  actions: readonly HomeMcpPulseAction[],
  activity: readonly ActivityItem[],
  nowMs: number = Date.now(),
): HomePulseHourBar[] {
  const end = currentSlotStartMs(nowMs, PULSE_1H_SLOT_MS);
  const starts: number[] = [];
  for (let i = PULSE_1H_SLOT_COUNT - 1; i >= 0; i--) {
    starts.push(end - i * PULSE_1H_SLOT_MS);
  }
  const bars: HomePulseHourBar[] = starts.map((startMs, index) => ({
    index,
    startMs,
    endMs: startMs + PULSE_1H_SLOT_MS,
    readCount: 0,
    writeCount: 0,
    label: clockLabel(startMs),
  }));
  countIntoBars(bars, actions, activity);
  return bars;
}

export function buildPulseHourBars(
  actions: readonly HomeMcpPulseAction[],
  activity: readonly ActivityItem[],
  nowMs: number = Date.now(),
): HomePulseHourBar[] {
  const starts = pulseHourStarts(nowMs);
  const bars: HomePulseHourBar[] = starts.map((startMs, index) => ({
    index,
    startMs,
    endMs: startMs + HOUR_MS,
    readCount: 0,
    writeCount: 0,
    label: hourLabel(startMs),
  }));
  countIntoBars(bars, actions, activity);
  return bars;
}

export function buildPulseDayBars(
  actions: readonly HomeMcpPulseAction[],
  activity: readonly ActivityItem[],
  nowMs: number = Date.now(),
): HomePulseHourBar[] {
  const today = currentDayStartMs(nowMs);
  const starts: number[] = [];
  for (let i = PULSE_DAY_COUNT - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    starts.push(date.getTime());
  }
  const bars: HomePulseHourBar[] = starts.map((startMs, index) => ({
    index,
    startMs,
    endMs: nextDayStartMs(startMs),
    readCount: 0,
    writeCount: 0,
    label: dayLabel(startMs),
  }));
  countIntoBars(bars, actions, activity);
  return bars;
}
