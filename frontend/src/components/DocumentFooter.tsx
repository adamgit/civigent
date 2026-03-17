import { headingPathToLabel } from "../pages/document-page-utils";

interface DocumentFooterProps {
  docPath: string | null;
  isEditing: boolean;
  focusedHeadingPath: string[] | null;
  loadDurationMs: number | null;
}

export function DocumentFooter({ docPath, isEditing, focusedHeadingPath, loadDurationMs }: DocumentFooterProps) {
  return (
    <div className="h-[--spacing-footer-h] min-h-[--spacing-footer-h] bg-footer-bg border-t border-footer-border flex items-center px-3.5 gap-1 text-[10.5px] text-footer-text font-[family-name:var(--font-mono)]">
      <span>{docPath ?? "No document"}</span>
      <span className="mx-1.5 text-[#d0ccc4]">&middot;</span>
      <span>{isEditing && focusedHeadingPath ? `Editing: ${headingPathToLabel(focusedHeadingPath)}` : "Connected"}</span>
      {loadDurationMs !== null ? (
        <>
          <span className="mx-1.5 text-[#d0ccc4]">&middot;</span>
          <span>Page loaded in {(loadDurationMs / 1000).toFixed(1)}s</span>
        </>
      ) : null}
    </div>
  );
}
