/**
 * Type-level regression guard for `MilkdownEditor`'s mutually-exclusive props.
 * Never imported/executed — validated by `tsc --noEmit` (the frontend tsconfig
 * type-checks all source files). A LIVE editor must not accept a cold `markdown`
 * seed, and a COLD editor must provide one.
 */

import type { MilkdownEditorProps } from "./MilkdownEditor";

function __assertMilkdownPropsMutualExclusion(): void {
  const accept = (_p: MilkdownEditorProps): void => {};

  // @ts-expect-error a live editor is never seeded with cold markdown (the bug)
  accept({ expectsCrdt: true, store: null, fragmentKey: "section::x", markdown: "stale seed" });

  // @ts-expect-error a cold editor must provide a markdown seed
  accept({ expectsCrdt: false, fragmentKey: "section::x" });

  // Valid live editor (no markdown) — compiles.
  accept({ expectsCrdt: true, store: null, fragmentKey: "section::x" });

  // Valid cold editor (markdown seed, no live authority) — compiles.
  accept({ markdown: "seed" });
}

void __assertMilkdownPropsMutualExclusion;
