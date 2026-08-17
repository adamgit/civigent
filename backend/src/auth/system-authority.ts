/**
 * system-authority.ts — the single explicit ACL bypass.
 *
 * `SystemAuthority` is a compile-time branded value provable only through
 * `systemAuthority(reason)`. No-user callers (bootstrap content seed,
 * crash-recovery republish, snapshot regeneration, diagnostics, CRDT settle
 * internals) mint here and nowhere else, so every bypass is a named,
 * greppable, review-visible decision instead of an absence. It is a plain
 * in-memory value like every other brand: nothing secret, never serialized,
 * never stored, never on the wire.
 */

declare const __systemAuthority: unique symbol;

export type SystemAuthority = {
  readonly kind: "system-authority";
  readonly reason: string;
  readonly [__systemAuthority]: true;
};

export function systemAuthority(reason: string): SystemAuthority {
  if (reason.trim().length === 0) {
    throw new Error("SystemAuthority requires a non-empty reason.");
  }
  return { kind: "system-authority", reason } as SystemAuthority;
}

export function isSystemAuthority(value: unknown): value is SystemAuthority {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "system-authority"
  );
}
