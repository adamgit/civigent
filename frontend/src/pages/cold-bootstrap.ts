import {
  SectionId,
  type WorkspaceBootstrap,
  type WorkspaceSectionLockSignal,
  type RenderSectionRef,
} from "../types/live-sections";
import { getSectionFragmentKey, type WorkspaceSectionDto } from "./document-page-utils";

export function deriveWorkspaceBootstrap(
  sections: readonly WorkspaceSectionDto[],
): WorkspaceBootstrap {
  return sections.map((s) => ({
    ref: {
      id: SectionId.brand(getSectionFragmentKey(s)),
      headingPath: [...s.heading_path],
      headingLevel: s.heading_level,
    },
    markdown: s.content,
  }));
}

export function deriveWorkspaceSectionLockSignals(
  sections: readonly WorkspaceSectionDto[],
): WorkspaceSectionLockSignal[] {
  return sections.map((s) => ({
    id: SectionId.brand(getSectionFragmentKey(s)),
    locked: !!s.locked,
  }));
}

export function seedMarkdownFor(
  bootstrap: WorkspaceBootstrap,
  id: SectionId,
): string | undefined {
  return bootstrap.find((seed) => SectionId.equals(seed.ref.id, id))?.markdown;
}

export function lockSignalFor(
  signals: readonly WorkspaceSectionLockSignal[],
  id: SectionId,
): WorkspaceSectionLockSignal | undefined {
  return signals.find((sig) => SectionId.equals(sig.id, id));
}

export function dtoToRenderRef(section: WorkspaceSectionDto): RenderSectionRef {
  return {
    id: SectionId.brand(getSectionFragmentKey(section)),
    headingPath: [...section.heading_path],
    headingLevel: section.heading_level,
  };
}
