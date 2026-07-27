/**
 * document-presence-identity — small pure helpers for turning a display name into
 * the visual atoms a {@link PresenceBadge} needs (initials + a stable fallback
 * fill color). Used by the P8 hook when translating raw page signals into
 * `BadgeIdentity` records. Kept separate from the pure core so the core stays a
 * mechanical reducer with no presentation concerns.
 */

/** Palette mirrored from the collab-cursor colors so a person's badge and cursor tend to agree. */
const FILL_PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#4f46e5",
  "#be123c",
];

/**
 * 1–2 char initials from a display name: first letters of the first two
 * whitespace-separated words, else the first two characters, uppercased.
 */
export function deriveInitials(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/** Deterministic fill color from a seed string (same hash idiom as the cursor colors). */
export function deriveFillColor(seed: string | null | undefined): string {
  const s = seed ?? "";
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return FILL_PALETTE[Math.abs(hash) % FILL_PALETTE.length];
}
