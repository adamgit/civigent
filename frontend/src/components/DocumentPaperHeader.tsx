/**
 * DocumentPaperHeader — in-flow title block at the top of the document paper.
 *
 * Pair with {@link DocumentPaperStickyHeader}: this is the full header (serif
 * title + rename/delete on one row; path + activity on the next). The sticky
 * sibling is the compact bar that pins when this block scrolls out of view.
 */

import type { Ref } from "react";
import type { DocumentActivityEvent } from "../types/shared.js";
import type { DocumentPresenceModel } from "../presence/document-presence-model";
import { DocumentPresenceActivity } from "./DocumentPresenceActivity";

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
  deleteError: string | null;
  onRenameValueChange: (value: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: () => void | Promise<void>;
  onCopyPath: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  /** Observed to pin the sticky header when this block fully leaves the scrollport. */
  rootRef?: Ref<HTMLDivElement>;
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
  deleteError,
  onRenameValueChange,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onCopyPath,
  onDelete,
  rootRef,
}: DocumentPaperHeaderProps): JSX.Element {
  return (
    <div ref={rootRef} className="doc-paper-header" data-testid="doc-paper-header">
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
            <h1 className="font-[family-name:var(--font-body)] text-[32px] font-bold text-text-primary leading-tight tracking-tight min-w-0 flex-1">
              {title}
            </h1>
            <div className="flex items-center gap-2 shrink-0 pt-2">
              <button
                type="button"
                className="text-xs text-accent-primary hover:underline"
                onClick={onStartRename}
              >
                Rename
              </button>
              <button
                type="button"
                className="text-xs text-red-600 hover:underline"
                onClick={() => { void onDelete(); }}
              >
                Delete
              </button>
              {deleteError ? <span className="text-xs text-red-600">{deleteError}</span> : null}
            </div>
          </>
        )}
      </div>

      <div className="doc-paper-header__meta text-xs text-text-muted mb-7 pb-5 border-b border-[#eae7e2]">
        <div className="doc-paper-header__meta-row">
          <span className="inline-flex items-center gap-1 min-w-0">
            <span className="truncate">{docPath ?? ""}</span>
            {docPath ? (
              <button
                type="button"
                className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-text-primary hover:bg-[rgba(0,0,0,0.04)]"
                title={pathCopied ? "Copied" : "Copy path"}
                aria-label={pathCopied ? "Path copied" : "Copy document path"}
                onClick={() => { void onCopyPath(); }}
              >
                {pathCopied ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="5.5" y="5.5" width="8" height="8" rx="1.25" stroke="currentColor" strokeWidth="1.25" />
                    <path d="M10.5 5.5V4.25C10.5 3.56 9.94 3 9.25 3H4.25C3.56 3 3 3.56 3 4.25V9.25C3 9.94 3.56 10.5 4.25 10.5H5.5" stroke="currentColor" strokeWidth="1.25" />
                  </svg>
                )}
              </button>
            ) : null}
          </span>
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
