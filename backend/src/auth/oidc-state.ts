/**
 * OIDC state store — in-memory, server-side only.
 *
 * Stores short-lived state/nonce pairs between the authorize redirect and the callback.
 * TTL = 10 minutes. Expired entries are evicted on each store call.
 */

import { randomBytes } from "node:crypto";

const OIDC_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface OidcStateEntry {
  nonce: string;
  returnTo: string;
  expiresAt: number;
}

const _store = new Map<string, OidcStateEntry>();

export function generateOidcState(): string {
  return randomBytes(32).toString("hex");
}

export function generateOidcNonce(): string {
  return randomBytes(32).toString("hex");
}

export function storeOidcState(state: string, nonce: string, returnTo: string): void {
  const now = Date.now();
  // Evict expired entries
  for (const [key, entry] of _store) {
    if (entry.expiresAt <= now) {
      _store.delete(key);
    }
  }
  _store.set(state, { nonce, returnTo, expiresAt: now + OIDC_STATE_TTL_MS });
}

export function retrieveAndClearOidcState(state: string): { nonce: string; returnTo: string } | null {
  const entry = _store.get(state);
  if (!entry) return null;
  _store.delete(state);
  if (entry.expiresAt <= Date.now()) return null;
  return { nonce: entry.nonce, returnTo: entry.returnTo };
}
