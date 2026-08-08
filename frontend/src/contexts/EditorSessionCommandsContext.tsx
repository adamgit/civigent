import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

export interface EditorSessionCommands {
  forcePublish: (() => void) | null;
}

const DEFAULT_COMMANDS: EditorSessionCommands = { forcePublish: null };

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
}: {
  boundProposalId: string | null;
  forcePublishing: boolean;
  publishPaused: boolean;
  forcePublish: () => void;
}): EditorSessionCommands {
  const exposed = !!boundProposalId && !forcePublishing && !publishPaused;
  return useMemo(
    () => ({ forcePublish: exposed ? forcePublish : null }),
    [exposed, forcePublish],
  );
}
