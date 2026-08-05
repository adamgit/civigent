import { BEFORE_FIRST_HEADING_KEY } from "../pages/document-page-utils";

export type SectionId = string & { readonly __sectionId: unique symbol };

export const SectionId = {
  text(id: SectionId): string {
    return id;
  },
  brand(fragmentKey: string): SectionId {
    return fragmentKey as SectionId;
  },
  equals(a: SectionId, b: SectionId): boolean {
    return a === b;
  },
};

export const BEFORE_FIRST_HEADING_SECTION_ID: SectionId = SectionId.brand(
  BEFORE_FIRST_HEADING_KEY,
);

export interface LiveSectionRef {
  readonly id: SectionId;
  readonly headingPath: readonly string[];
  /** ATX heading level (1–6); 0 for the before-first-heading section. */
  readonly level: number;
}

export type RenderSectionRef = LiveSectionRef;

export interface WorkspaceSectionSeed {
  readonly ref: LiveSectionRef;
  readonly markdown: string;
}

export type WorkspaceBootstrap = readonly WorkspaceSectionSeed[];

export function syntheticBeforeFirstHeadingSeed(): WorkspaceSectionSeed {
  return {
    ref: { id: BEFORE_FIRST_HEADING_SECTION_ID, headingPath: [], level: 0 },
    markdown: "",
  };
}

export interface WorkspaceSectionLockSignal {
  readonly id: SectionId;
  readonly locked: boolean;
}
