export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new Error(`percentile(${p}) of empty array`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function summarizeMs(values: readonly number[]): { p50Ms: number; p95Ms: number; maxMs: number } {
  return {
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: values.reduce((m, v) => (v > m ? v : m), values[0]),
  };
}

/** Yjs v1 encoding of an empty diff: no structs, no deletes. */
export function isEmptyYUpdate(update: Uint8Array): boolean {
  return update.byteLength === 0 || (update.byteLength === 2 && update[0] === 0 && update[1] === 0);
}
