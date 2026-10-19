export function seedMod32(seed: number): number {
  return (seed % 0x100000000) >>> 0;
}

export function mulberry32(a: number): () => number {
  let s = a >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fisherYates<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

export async function runWave(seed: number, tasks: Array<() => Promise<void>>): Promise<void> {
  const shuffled = fisherYates([...tasks], mulberry32(seedMod32(seed)));
  await Promise.all(shuffled.map((task) => task()));
}

function keyedUnit(seed: number, clientIndex: number, txnIndex: number, purpose: number): number {
  let h = seedMod32(seed);
  h = Math.imul(h ^ (clientIndex + 1), 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (txnIndex + 1), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (purpose + 1), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return mulberry32(h)();
}

export function mixIsSplit(seed: number, clientIndex: number, txnIndex: number): boolean {
  return keyedUnit(seed, clientIndex, txnIndex, 1) >= 0.5;
}

export function followPromoted(seed: number, clientIndex: number, txnIndex: number): boolean {
  return keyedUnit(seed, clientIndex, txnIndex, 2) >= 0.5;
}

export function bodyMarker(seed: number, clientIndex: number, txnIndex: number): string {
  return `m${seed}-c${clientIndex}-t${txnIndex}`;
}

export function splitHeading(seed: number, clientIndex: number, txnIndex: number): string {
  return `H${seed}-c${clientIndex}-t${txnIndex}`;
}

export function splitBody(seed: number, clientIndex: number, txnIndex: number): string {
  return `b${seed}-c${clientIndex}-t${txnIndex}`;
}

export const TXN_GAP_MIN_MS = 100;
export const TXN_GAP_MAX_MS = 2_000;

/** Pause after a non-split edit. Inclusive, and a fresh draw for every client and transaction. */
export function transactionGapMs(seed: number, clientIndex: number, txnIndex: number): number {
  const unit = keyedUnit(seed, clientIndex, txnIndex, 3);
  const span = TXN_GAP_MAX_MS - TXN_GAP_MIN_MS + 1;
  return TXN_GAP_MIN_MS + Math.floor(unit * span);
}
