import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import type { SectionAltJumpRequest } from "../components/SectionAltJump";

export interface EditorSessionCommands {
  forcePublish: (() => void) | null;
  jumpSection: ((request: SectionAltJumpRequest) => void) | null;
}

const DEFAULT_COMMANDS: EditorSessionCommands = { forcePublish: null, jumpSection: null };

const EditorSessionCommandsContext = createContext<EditorSessionCommands>(DEFAULT_COMMANDS);

export function EditorSessionCommandsProvider({
  value,
  children,
}: {
  value: EditorSessionCommands;
  children: ReactNode;
}) {
  return (
    <EditorSessionCommandsContext.Provider value={value}>
      {children}
    </EditorSessionCommandsContext.Provider>
  );
}

export function useEditorSessionCommands(): EditorSessionCommands {
  return useContext(EditorSessionCommandsContext);
}

export function useEditorSessionCommandsValue({
  boundProposalId,
  forcePublishing,
  publishPaused,
  forcePublish,
  jumpSection,
}: {
  boundProposalId: string | null;
  forcePublishing: boolean;
  publishPaused: boolean;
  forcePublish: () => void;
  jumpSection: (request: SectionAltJumpRequest) => void;
}): EditorSessionCommands {
  const exposed = !!boundProposalId && !forcePublishing && !publishPaused;
  return useMemo(
    () => ({ forcePublish: exposed ? forcePublish : null, jumpSection }),
    [exposed, forcePublish, jumpSection],
  );
}
