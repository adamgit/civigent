/**
 * Convert a server-provided seconds_ago value to a human-readable string.
 * Examples: "just now", "3 min ago", "2h ago", "4d ago"
 *
 * This is a FRESHNESS value, never a liveness claim: a small age must not read
 * as "editing now" (a static, recently-saved section is not being edited). The
 * live "Editing now" label is owned by the section-attribution FSM's
 * `liveEditing` state, driven by awareness presence, not by this age.
 */

export type CompactAgeUnit = "s" | "m" | "h" | "d" | "w" | "y";

export interface CompactAgeParts {
  value: number;
  unit: CompactAgeUnit;
}

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86400;
const WEEK_SECONDS = 604800;
const WEEKS_PER_YEAR = 52;

/**
 * Discrete crayons per unit — each stop is a different named colour, not a
 * walk through one hue. Days stay sky→navy (never purple). Weeks are a
 * different crayon each step (rose, fuchsia, violet, orange, gold, steel,
 * teal, olive, stone, taupe) so 6d cannot land on 4w or 7w.
 */
interface AgeTintStop {
  at: number;
  hex: string;
}

const UNIT_TINT_STOPS: Record<CompactAgeUnit, readonly AgeTintStop[]> = {
  s: [
    { at: 1, hex: "#0a7a38" },
    { at: 2, hex: "#12a044" },
    { at: 3, hex: "#28b84a" },
    { at: 5, hex: "#42a848" },
    { at: 10, hex: "#4a7d50" },
    { at: 20, hex: "#4e7052" },
    { at: 40, hex: "#546654" },
    { at: 59, hex: "#5a625a" },
  ],
  m: [
    { at: 1, hex: "#d4a80c" },
    { at: 2, hex: "#c8b010" },
    { at: 3, hex: "#b8b018" },
    { at: 5, hex: "#a8a81c" },
    { at: 10, hex: "#889428" },
    { at: 20, hex: "#6c7a30" },
    { at: 40, hex: "#5a6838" },
    { at: 59, hex: "#546040" },
  ],
  h: [
    { at: 1, hex: "#0c8a7e" },
    { at: 2, hex: "#0d8498" },
    { at: 3, hex: "#1478a4" },
    { at: 6, hex: "#1c6c9c" },
    { at: 12, hex: "#286090" },
    { at: 18, hex: "#325880" },
    { at: 23, hex: "#385070" },
  ],
  d: [
    { at: 1, hex: "#0891b2" },
    { at: 2, hex: "#0284c7" },
    { at: 3, hex: "#2563eb" },
    { at: 4, hex: "#1d4ed8" },
    { at: 5, hex: "#1e3a8a" },
    { at: 6, hex: "#172554" },
  ],
  w: [
    { at: 1, hex: "#db2777" },
    { at: 2, hex: "#a21caf" },
    { at: 3, hex: "#7c3aed" },
    { at: 4, hex: "#ea580c" },
    { at: 5, hex: "#ca8a04" },
    { at: 6, hex: "#0369a1" },
    { at: 7, hex: "#0f766e" },
    { at: 8, hex: "#3f6212" },
    { at: 9, hex: "#78716c" },
    { at: 10, hex: "#57534e" },
    { at: 20, hex: "#6b6560" },
    { at: 30, hex: "#7c7670" },
    { at: 52, hex: "#8a857e" },
  ],
  y: [
    { at: 1, hex: "#b05e1c" },
    { at: 2, hex: "#a05824" },
    { at: 5, hex: "#8a5c38" },
    { at: 10, hex: "#7a6450" },
    { at: 20, hex: "#6e6860" },
  ],
};

export function prettyAge(secondsAgo: number): string {
  if (secondsAgo < MINUTE_SECONDS) return "just now";
  if (secondsAgo < HOUR_SECONDS) return `${Math.floor(secondsAgo / MINUTE_SECONDS)} min ago`;
  if (secondsAgo < DAY_SECONDS) return `${Math.floor(secondsAgo / HOUR_SECONDS)}h ago`;
  return `${Math.floor(secondsAgo / DAY_SECONDS)}d ago`;
}

export function compactAgeParts(secondsAgo: number): CompactAgeParts {
  const seconds = Math.max(0, Math.floor(secondsAgo));
  if (seconds < MINUTE_SECONDS) {
    return { value: seconds, unit: "s" };
  }
  if (seconds < HOUR_SECONDS) {
    return { value: Math.floor(seconds / MINUTE_SECONDS), unit: "m" };
  }
  if (seconds < DAY_SECONDS) {
    return { value: Math.floor(seconds / HOUR_SECONDS), unit: "h" };
  }
  if (seconds < WEEK_SECONDS) {
    return { value: Math.floor(seconds / DAY_SECONDS), unit: "d" };
  }
  const weeks = Math.floor(seconds / WEEK_SECONDS);
  if (weeks <= WEEKS_PER_YEAR) {
    return { value: weeks, unit: "w" };
  }
  return { value: Math.max(1, Math.floor(weeks / WEEKS_PER_YEAR)), unit: "y" };
}

export function compactAge(secondsAgo: number): string {
  const { value, unit } = compactAgeParts(secondsAgo);
  return `${value}${unit} ago`;
}

function unitProgress(value: number, min: number, max: number): number {
  if (max <= min) {
    return 0;
  }
  const clamped = Math.min(max, Math.max(min, value));
  if (clamped <= min) {
    return 0;
  }
  return Math.log(clamped / min) / Math.log(max / min);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function parseHexRgb(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function tintFromStops(value: number, stops: readonly AgeTintStop[]): string {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) {
    return "rgb(90, 90, 90)";
  }
  if (value <= first.at) {
    const [r, g, b] = parseHexRgb(first.hex);
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (value >= last.at) {
    const [r, g, b] = parseHexRgb(last.hex);
    return `rgb(${r}, ${g}, ${b})`;
  }
  let index = 0;
  while (index < stops.length - 1 && value > (stops[index + 1]?.at ?? last.at)) {
    index += 1;
  }
  const from = stops[index] ?? first;
  const to = stops[index + 1] ?? last;
  const t = unitProgress(value, from.at, to.at);
  const [fr, fg, fb] = parseHexRgb(from.hex);
  const [tr, tg, tb] = parseHexRgb(to.hex);
  return `rgb(${Math.round(lerp(fr, tr, t))}, ${Math.round(lerp(fg, tg, t))}, ${Math.round(lerp(fb, tb, t))})`;
}

export function compactAgeTint(secondsAgo: number): string {
  const { value, unit } = compactAgeParts(secondsAgo);
  return tintFromStops(value, UNIT_TINT_STOPS[unit]);
}
