/**
 * Type-level regression guard for `MilkdownEditor`'s mutually-exclusive props.
 * Never imported/executed — validated by `tsc --noEmit` (the frontend tsconfig
 * type-checks all source files). A LIVE editor must not accept a cold `markdown`
 * seed and REQUIRES a `LiveEditorBinding` (no empty-mount path); a COLD editor
 * must provide a markdown seed and can never bind live authority.
 */

import type { MilkdownEditorProps } from "./MilkdownEditor";
import type { LiveEditorBinding } from "../services/live-section-replica";

declare const binding: LiveEditorBinding;

function __assertMilkdownPropsMutualExclusion(): void {
  const accept = (_p: MilkdownEditorProps): void => {};

  // @ts-expect-error a live editor is never seeded with cold markdown (the bug)
  accept({ expectsCrdt: true, binding, markdown: "stale seed" });

  // @ts-expect-error a live editor REQUIRES a binding — no empty-mount path
  accept({ expectsCrdt: true, fragmentKey: "section::x" });

  // @ts-expect-error a cold editor must provide a markdown seed
  accept({ expectsCrdt: false, fragmentKey: "section::x" });

  // Valid live editor (binding, no markdown) — compiles.
  accept({ expectsCrdt: true, binding });

  // Valid cold editor (markdown seed, no live authority) — compiles.
  accept({ markdown: "seed" });
}

void __assertMilkdownPropsMutualExclusion;
