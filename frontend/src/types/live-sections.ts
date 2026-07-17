// ─── Live section replica types (frontend live-document design) ────────────
//
// These types split what today's single `DocumentSection` (= the content-bearing
// REST section DTO) conflates:
//
//   - a body-free LIVE topology reference (`LiveSectionRef`) — identity + heading
//     path only, the shape the ordered CRDT live-section channel carries;
//   - a content-bearing COLD seed (`WorkspaceSectionSeed`) — a `ref` plus the
//     markdown painted before the live replica is `ready`;
//   - page-local workspace lock signals (`WorkspaceSectionLockSignal`) — the
//     proposal-FSM lock state shown for no-session / pre-ready UI. Locks are the
//     ONLY REST-derived per-section signal: the `/sections` DTO carries no
//     pending-writer data; live pending is `LiveSectionReplica.isPending()`.
//
// The REST section DTO (`GetDocumentSectionsResponse`) stays content-bearing and
// unchanged for cold bootstrap and direct REST consumers (Heatmap,
// governance-data, coordination). This module adds the separable live/cold types;
// it does not remove or alter the REST shape and introduces no runtime behavior.
//
// `SectionId` is the branded, opaque form of the backend-owned `fragment_key`.
// App code NEVER derives it from a filename and NEVER strips or adds the
// `section::` prefix — the bytes are opaque. The single minting boundary is
// `SectionId.brand`, called once where a `fragment_key` crosses into the app.

import { BEFORE_FIRST_HEADING_KEY } from "../pages/document-page-utils";

/**
 * The branded form of the opaque backend-owned `fragment_key`. For persisted
 * sections the key is backed by stable section-file identity, but the frontend
 * never interprets its bytes (no filename derivation, no `section::` strip/add).
 */
export type SectionId = string & { readonly __sectionId: unique symbol };

export const SectionId = {
  /**
   * Widen a `SectionId` back to its underlying wire string (no assertion — the
   * brand is a subtype of `string`). Use only at a wire/serialization boundary.
   */
  text(id: SectionId): string {
    return id;
  },
  /**
   * The sole minting boundary: brand a raw `fragment_key` (as received on the
   * CRDT live-section wire) into a `SectionId`. Call once at the intake boundary;
   * never scatter `as SectionId` casts through app code.
   */
  brand(fragmentKey: string): SectionId {
    return fragmentKey as SectionId;
  },
  /** Structural equality of two ids (they are opaque strings). */
  equals(a: SectionId, b: SectionId): boolean {
    return a === b;
  },
};

/**
 * The reserved synthetic before-first-heading `SectionId` — the branded form of
 * `section::__beforeFirstHeading__`. Synthetic BFH is a bootstrap mount target on
 * an empty document, not a durable section, and is the one exception to the
 * section-file rule: it has no section file, so its id is this reserved constant,
 * never minted per-instance and never re-keyed into the heading it spawns.
 */
export const BEFORE_FIRST_HEADING_SECTION_ID: SectionId = SectionId.brand(
  BEFORE_FIRST_HEADING_KEY,
);

/**
 * Body-free live topology reference: identity + heading path only. This is the
 * shape carried on the ordered CRDT live-section channel and held by
 * `LiveSectionReplica`. `depth` and heading label are DERIVED from `headingPath`
 * at use sites — never stored here, and body content NEVER lives on a ref.
 */
export interface LiveSectionRef {
  readonly id: SectionId;
  readonly headingPath: readonly string[];
}

/**
 * A content-bearing cold seed for a single section: a body-free `ref` plus the
 * markdown to paint before the live replica is `ready`. Seeds are page-local
 * bootstrap state only — never stored on the replica or on a `LiveSectionRef`,
 * and discarded once the replica becomes `ready` (live fragment bodies win).
 */
export interface WorkspaceSectionSeed {
  readonly ref: LiveSectionRef;
  readonly markdown: string;
}

/**
 * The cold bootstrap: an ordered list of section seeds loaded from workspace REST
 * for pre-ready / no-session paint. Held ONLY in page-local bootstrap state.
 * There is deliberately no `ColdDocumentBootstrap` wrapper object — cold loading
 * produces this list of seeds and nothing more.
 */
export type WorkspaceBootstrap = readonly WorkspaceSectionSeed[];

/**
 * The synthetic before-first-heading bootstrap SEED for an empty document. It is
 * a mount target, not a durable section: its id is the reserved constant (never
 * per-instance, never derived from a section file), heading path is empty, and it
 * carries no cold body. When the first heading is typed, root-split creates a new
 * headed `SectionId` and this BFH dissolves (`section:gone`) — the reserved
 * constant is NEVER re-keyed into the heading it spawns (the mis-key corruption
 * spec 05 bans); typed content survives via the Y.Doc fragment materialize.
 * Preamble-only input keeps the same reserved constant as the real BFH section
 * (stable identity, no remount).
 */
export function syntheticBeforeFirstHeadingSeed(): WorkspaceSectionSeed {
  return {
    ref: { id: BEFORE_FIRST_HEADING_SECTION_ID, headingPath: [] },
    markdown: "",
  };
}

/**
 * A page-local LOCK signal for one section, sourced from the workspace REST
 * `/sections` list (`locked?`). Shown for no-session or pre-ready human UI
 * (badges / gates). Locks are the only per-section signal that REST shape
 * carries — there is deliberately NO pending field here (live pending is
 * `LiveSectionReplica.isPending()`; the app-WS `section:pending` hint covers
 * the cold case). It is NOT live authority: never written onto a
 * `LiveSectionRef` or the replica, and superseded by the replica's
 * `blocked_section_ids` once it becomes `ready`.
 */
export interface WorkspaceSectionLockSignal {
  readonly id: SectionId;
  /** A proposal FSM lock currently locks this section (human "locked"). */
  readonly locked: boolean;
}
