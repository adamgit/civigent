import {
  SectionId,
  syntheticBeforeFirstHeadingSeed,
  type WorkspaceBootstrap,
  type WorkspaceSectionLockSignal,
  type LiveSectionRef,
} from "../types/live-sections";
import { getSectionFragmentKey, type DocumentSection } from "./document-page-utils";

export function deriveWorkspaceBootstrap(
  sections: readonly DocumentSection[],
): WorkspaceBootstrap {
  return sections.map((s) => ({
    ref: {
      id: SectionId.brand(getSectionFragmentKey(s)),
      headingPath: [...s.heading_path],
    },
    markdown: s.content,
  }));
}

export function deriveWorkspaceSectionLockSignals(
  sections: readonly DocumentSection[],
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

export function resolvePaintMarkdown(params: {
  hasAuthoritativeBootstrap: boolean;
  id: SectionId;
  bootstrap: WorkspaceBootstrap;
  readLiveMarkdown: (id: SectionId) => string;
}): string {
  if (params.hasAuthoritativeBootstrap) return params.readLiveMarkdown(params.id);
  return seedMarkdownFor(params.bootstrap, params.id) ?? "";
}

export function syntheticBeforeFirstHeadingRow(): DocumentSection {
  const seed = syntheticBeforeFirstHeadingSeed();
  return {
    heading: "",
    heading_path: [...seed.ref.headingPath],
    depth: 0,
    content: seed.markdown,
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 0,
    fragment_key: SectionId.text(seed.ref.id),
    section_file: "",
  };
}

export function topologyToRenderSections(
  topology: readonly LiveSectionRef[],
  bootstrap: WorkspaceBootstrap,
  prevByKey: Map<string, DocumentSection>,
): DocumentSection[] {
  return topology.map((ref) => {
    const key = SectionId.text(ref.id);
    const prev = prevByKey.get(key);
    const headingPath = [...ref.headingPath];
    return {
      heading: headingPath[headingPath.length - 1] ?? "",
      heading_path: headingPath,
      depth: headingPath.length,
      content: seedMarkdownFor(bootstrap, ref.id) ?? prev?.content ?? "",
      agentWritePolicy: prev?.agentWritePolicy ?? {
        canWrite: true,
        message: "Agents can currently write to this section.",
      },
      crdt_session_active: true,
      section_length_warning: prev?.section_length_warning ?? false,
      word_count: prev?.word_count ?? 0,
      fragment_key: key,
      section_file: prev?.section_file ?? "",
      ...(prev?.locked !== undefined ? { locked: prev.locked } : {}),
      ...(prev?.last_editor ? { last_editor: prev.last_editor } : {}),
    };
  });
}
