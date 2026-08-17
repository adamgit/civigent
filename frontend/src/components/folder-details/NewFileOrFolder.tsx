import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface NewFileOrFolderSubmit {
  name: string;
  content: string;
  isFolder: boolean;
}

export interface NewFileOrFolderProps {
  busy?: boolean;
  error?: string | null;
  onSubmit: (value: NewFileOrFolderSubmit) => void | Promise<void>;
  /** Narrow pane: name field only. Wide pane: file-or-folder expander. */
  variant?: "full" | "compact";
  /**
   * Called when the picker or drop receives a .zip or more than one file.
   * Bulk intake is a redirect (the Imports page owns uploads) — the files are
   * never passed and the create form is not filled.
   */
  onBulkIntake?: () => void;
}

type CreateKind = "file" | "folder";

function stripTrailingSlashes(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function asFolderName(raw: string): string {
  const base = stripTrailingSlashes(raw);
  return base.length > 0 ? `${base}/` : "/";
}

function CompactNewFile({
  busy = false,
  error = null,
  onSubmit,
}: Omit<NewFileOrFolderProps, "variant">) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const reset = () => {
    setOpen(false);
    setName("");
  };

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) {
      return;
    }
    const trimmed = stripTrailingSlashes(name).trim();
    if (!trimmed) {
      return;
    }
    try {
      await onSubmit({ name: trimmed, content: "", isFolder: false });
      reset();
    } catch {
      // Parent surfaces `error`; keep the field open for correction.
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="w-full rounded-xl border-none bg-text-primary py-3.5 font-ui text-[15px] font-semibold text-white"
        onClick={() => setOpen(true)}
      >
        New document
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="font-ui"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          reset();
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="file-name.md"
        disabled={busy}
        aria-label="New document name"
        enterKeyHint="go"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-xl border border-folder-card-border bg-canvas-bg px-3 py-3 font-body text-[16px] text-text-primary outline-none placeholder:text-text-faint focus:border-accent"
      />
      <button
        type="button"
        className="mt-2 border-none bg-transparent p-0 font-ui text-[12px] text-text-faint hover:text-text-muted"
        disabled={busy}
        onClick={reset}
      >
        cancel
      </button>
      {error ? <p className="mt-2 text-xs text-status-red">{error}</p> : null}
    </form>
  );
}

function FullNewFileOrFolder({
  busy = false,
  error = null,
  onSubmit,
  onBulkIntake,
}: Omit<NewFileOrFolderProps, "variant">) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [showContent, setShowContent] = useState(true);
  const [kind, setKind] = useState<CreateKind>("file");
  const [kindMenuOpen, setKindMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickFileInputRef = useRef<HTMLInputElement>(null);
  const kindMenuRef = useRef<HTMLDivElement>(null);
  /** Caret index to apply after a folder-name rewrite (always before the trailing `/`). */
  const pendingCaretRef = useRef<number | null>(null);

  const folderMode = kind === "folder";

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const caret = pendingCaretRef.current;
    if (!input || caret == null) {
      return;
    }
    input.setSelectionRange(caret, caret);
    pendingCaretRef.current = null;
  });

  useEffect(() => {
    if (!kindMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (kindMenuRef.current && !kindMenuRef.current.contains(event.target as Node)) {
        setKindMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [kindMenuOpen]);

  const reset = () => {
    setOpen(false);
    setName("");
    setContent("");
    setShowContent(true);
    setKind("file");
    setKindMenuOpen(false);
    pendingCaretRef.current = null;
  };

  const selectKind = (next: CreateKind) => {
    setKind(next);
    if (next === "folder") {
      setName((prev) => {
        const nextName = asFolderName(prev);
        pendingCaretRef.current = stripTrailingSlashes(nextName).length;
        return nextName;
      });
    } else {
      setName((prev) => stripTrailingSlashes(prev));
    }
    setKindMenuOpen(false);
    inputRef.current?.focus();
  };

  const handleNameChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    const selectionStart = event.target.selectionStart ?? value.length;

    if (kind === "folder") {
      // Deleting the trailing slash is the explicit exit from folder mode.
      if (name.endsWith("/") && !value.endsWith("/")) {
        setKind("file");
        setName(value);
        return;
      }
      const base = stripTrailingSlashes(value);
      const next = asFolderName(value);
      // Keep the caret in the editable prefix — never after the forced `/`.
      pendingCaretRef.current = Math.min(selectionStart, base.length);
      setName(next);
      return;
    }

    if (value.endsWith("/")) {
      setKind("folder");
      const base = stripTrailingSlashes(value);
      pendingCaretRef.current = base.length;
      setName(asFolderName(value));
      return;
    }

    setName(value);
  };

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) {
      return;
    }
    const trimmed = stripTrailingSlashes(name).trim();
    if (!trimmed) {
      return;
    }
    try {
      await onSubmit({
        name: folderMode ? `${trimmed}/` : name.trim(),
        content: folderMode ? "" : content,
        isFolder: folderMode,
      });
      reset();
    } catch {
      // Parent surfaces `error`; keep the form open for correction.
    }
  };

  const intakeLocalFiles = (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) {
      return;
    }
    if (files.length > 1 || files.some((file) => file.name.toLowerCase().endsWith(".zip"))) {
      onBulkIntake?.();
      return;
    }
    const file = files[0];
    if (!file.name.toLowerCase().endsWith(".md")) {
      return;
    }
    void file.text().then((text) => {
      setKind("file");
      setName(file.name);
      setContent(text);
      setShowContent(true);
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        className="mt-1 flex items-center gap-1.5 border-none bg-transparent py-2 font-ui text-[13px] text-text-muted transition-colors hover:text-folder-link"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">+</span>
        <span>New file or folder</span>
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-2 flex flex-col gap-2 font-ui"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (event.dataTransfer.files.length > 0) {
          intakeLocalFiles(event.dataTransfer.files);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (kindMenuOpen) {
            setKindMenuOpen(false);
            return;
          }
          if (!busy) {
            reset();
          }
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void handleSubmit();
        }
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div ref={kindMenuRef} className="relative shrink-0">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-folder-card-border bg-folder-card-bg px-2 py-1 text-[12px] font-medium text-text-secondary hover:border-folder-card-border-hover hover:bg-canvas-bg hover:text-text-primary"
              disabled={busy}
              aria-haspopup="listbox"
              aria-expanded={kindMenuOpen}
              onClick={() => setKindMenuOpen((prev) => !prev)}
            >
              <span>+ {kind}</span>
              <span aria-hidden="true" className="text-[9px] text-text-faint">
                ▾
              </span>
            </button>
            {kindMenuOpen ? (
              <div
                role="listbox"
                aria-label="Create as file or folder"
                className="absolute left-0 top-full z-10 mt-1 min-w-[7.5rem] rounded-md border border-folder-card-border bg-canvas-bg py-1 shadow-sm"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={kind === "file"}
                  className={`flex w-full border-none bg-transparent px-3 py-1.5 text-left text-[12px] ${
                    kind === "file" ? "bg-section-hover text-folder-link" : "text-text-secondary hover:bg-section-hover"
                  }`}
                  onClick={() => selectKind("file")}
                >
                  + file
                </button>
                <button
                  type="button"
                  role="option"
                  aria-selected={kind === "folder"}
                  className={`flex w-full border-none bg-transparent px-3 py-1.5 text-left text-[12px] ${
                    kind === "folder"
                      ? "bg-section-hover text-folder-link"
                      : "text-text-secondary hover:bg-section-hover"
                  }`}
                  onClick={() => selectKind("folder")}
                >
                  + folder
                </button>
              </div>
            ) : null}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={handleNameChange}
            placeholder={folderMode ? "folder-name/" : "file-name.md"}
            disabled={busy}
            aria-label="New file or folder name"
            className="min-w-0 flex-1 border-none bg-transparent p-0 font-body text-[14px] text-text-primary outline-none placeholder:text-text-faint"
          />
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-text-faint">
          {!folderMode ? (
            <>
              <input
                ref={pickFileInputRef}
                type="file"
                accept=".md,.zip"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) {
                    intakeLocalFiles(event.target.files);
                  }
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="border-none bg-transparent p-0 text-[11px] text-text-faint hover:text-text-muted"
                disabled={busy}
                onClick={() => pickFileInputRef.current?.click()}
                title="Fill name and content from a local .md file"
              >
                from local file
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 border-none bg-transparent p-0 text-[11px] text-text-faint hover:text-text-muted"
                disabled={busy}
                onClick={() => setShowContent((prev) => !prev)}
                aria-expanded={showContent}
              >
                add content
                <span aria-hidden="true" className="text-[9px]">
                  {showContent ? "▴" : "▾"}
                </span>
              </button>
            </>
          ) : null}
          <span>↵ create</span>
          <button
            type="button"
            className="border-none bg-transparent p-0 text-[11px] text-text-faint hover:text-text-muted"
            disabled={busy}
            onClick={reset}
          >
            esc cancel
          </button>
        </div>
      </div>

      {folderMode ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="btn-primary text-xs"
            disabled={busy || !stripTrailingSlashes(name).trim()}
          >
            {busy ? "Creating..." : "Create folder"}
          </button>
          <button
            type="button"
            className="border-none bg-transparent p-0 text-[12px] text-text-faint hover:text-text-muted"
            disabled={busy}
            onClick={reset}
          >
            cancel
          </button>
        </div>
      ) : showContent ? (
        <div className="rounded-lg border border-folder-card-border bg-folder-card-bg p-3">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={8}
            placeholder="Optional initial content for file..."
            disabled={busy}
            aria-label="Markdown content"
            className="w-full resize-y rounded border border-folder-content-border bg-canvas-bg px-3 py-2 font-mono text-xs text-text-primary outline-none placeholder:text-text-faint focus:border-accent"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn-primary text-xs" disabled={busy || !name.trim()}>
              {busy ? "Creating..." : "Create file"}
            </button>
            <button
              type="button"
              className="border-none bg-transparent p-0 text-[12px] text-text-faint hover:text-text-muted"
              disabled={busy}
              onClick={reset}
            >
              cancel
            </button>
            <span className="ml-auto text-[11px] text-text-faint">⌘↵ create</span>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary text-xs" disabled={busy || !name.trim()}>
            {busy ? "Creating..." : "Create file"}
          </button>
          <button
            type="button"
            className="border-none bg-transparent p-0 text-[12px] text-text-faint hover:text-text-muted"
            disabled={busy}
            onClick={reset}
          >
            cancel
          </button>
        </div>
      )}

      {error ? <p className="text-xs text-status-red">{error}</p> : null}
    </form>
  );
}

export function NewFileOrFolder({
  busy = false,
  error = null,
  onSubmit,
  variant = "full",
  onBulkIntake,
}: NewFileOrFolderProps) {
  if (variant === "compact") {
    return <CompactNewFile busy={busy} error={error} onSubmit={onSubmit} />;
  }
  return <FullNewFileOrFolder busy={busy} error={error} onSubmit={onSubmit} onBulkIntake={onBulkIntake} />;
}
