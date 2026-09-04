/**
 * DocumentPaperHeader — in-flow title block at the top of the document paper.
 *
 * Pair with {@link DocumentPaperStickyHeader}: this is the full header (serif
 * title + copy + rename/delete on one row; folder breadcrumbs + activity on
 * the next). The sticky sibling is the compact bar that pins when this block
 * scrolls out of view.
 */

import type { JSX, Ref } from "react";
import type { DocumentActivityEvent } from "../types/shared.js";
import type { DocumentPresenceModel } from "../presence/document-presence-model";
import { CopyPathButton } from "./CopyPathButton";
import { DocumentPresenceActivity } from "./DocumentPresenceActivity";
import { FolderPathBreadcrumb, folderPathOfDoc } from "./FolderPathBreadcrumb";

export interface DocumentPaperHeaderProps {
  title: string;
  docPath: string | null;
  presenceModel: DocumentPresenceModel;
  currentUserId: string | null;
  documentActivity: DocumentActivityEvent | null;
  renaming: boolean;
  renameValue: string;
  renameError: string | null;
  pathCopied: boolean;
  onRenameValueChange: (value: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: () => void | Promise<void>;
  onCopyPath: () => void | Promise<void>;
  onExportMarkdown: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onShare?: () => void;
  /** Observed to pin the sticky header when this block fully leaves the scrollport. */
  rootRef?: Ref<HTMLDivElement>;
  /** Narrow: path + title live in the sticky chrome; this block keeps presence
   *  (and the rename form when that action is used). */
  layoutMode?: "wide" | "narrow";
}

export function DocumentPaperHeader({
  title,
  docPath,
  presenceModel,
  currentUserId,
  documentActivity,
  renaming,
  renameValue,
  renameError,
  pathCopied,
  onRenameValueChange,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onCopyPath,
  onExportMarkdown,
  onDelete,
  onShare,
  rootRef,
  layoutMode = "wide",
}: DocumentPaperHeaderProps): JSX.Element {
  const narrow = layoutMode === "narrow";
  return (
    <div ref={rootRef} className="doc-paper-header" data-testid="doc-paper-header">
      {renaming || !narrow ? (
      <div className="flex items-start justify-between gap-4 mb-1">
        {renaming ? (
          <form
            className="flex items-center gap-1.5 flex-1 min-w-0"
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmitRename();
            }}
          >
            <input
              className="flex-1 text-xs border border-border-default rounded px-1.5 py-0.5 bg-canvas-bg text-text-primary"
              value={renameValue}
              onChange={(e) => onRenameValueChange(e.target.value)}
              autoFocus
            />
            <button type="submit" className="text-xs text-accent-primary hover:underline shrink-0">Save</button>
            <button
              type="button"
              className="text-xs text-text-muted hover:underline shrink-0"
              onClick={onCancelRename}
            >
              Cancel
            </button>
            {renameError ? <span className="text-xs text-red-600 shrink-0">{renameError}</span> : null}
          </form>
        ) : (
          <>
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <h1 className="font-[family-name:var(--font-body)] text-[32px] font-bold text-text-primary leading-tight tracking-tight min-w-0">
                {title}
              </h1>
              {docPath ? (
                <CopyPathButton
                  path={docPath}
                  label={title}
                  copied={pathCopied}
                  onCopied={() => {
                    void onCopyPath();
                  }}
                />
              ) : null}
            </div>
            <div className="flex items-center gap-2 shrink-0 pt-2">
              <button
                type="button"
                className="text-xs text-accent-primary hover:underline"
                onClick={onStartRename}
              >
                Rename
              </button>
              |
              <button
                type="button"
                className="text-xs text-accent-primary hover:underline"
                onClick={() => { void onExportMarkdown(); }}
              >
                Export
              </button>
              {onShare ? (
                <>
                |
                <button
                  type="button"
                  className="text-xs text-accent-primary hover:underline"
                  onClick={onShare}
                >
                  Share
                </button>
                </>
              ) : null}
              |
              <button
                type="button"
                className="text-xs text-red-600 hover:underline"
                onClick={() => { void onDelete(); }}
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
      ) : null}

      <div
        className={
          narrow
            ? "doc-paper-header__meta text-xs text-text-muted mb-3"
            : "doc-paper-header__meta text-xs text-text-muted mb-7 pb-5 border-b border-[#eae7e2]"
        }
      >
        <div className="doc-paper-header__meta-row">
          {narrow || !docPath ? null : (
          <span className="flex min-w-0 items-center overflow-x-auto overflow-y-hidden">
            <FolderPathBreadcrumb folderPath={folderPathOfDoc(docPath)} size="subtitle" />
          </span>
          )}
          <DocumentPresenceActivity
            model={presenceModel}
            currentUserId={currentUserId}
            activity={documentActivity}
          />
        </div>
      </div>
    </div>
  );
}
