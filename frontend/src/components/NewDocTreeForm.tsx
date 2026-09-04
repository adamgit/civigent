import { type CSSProperties, type FormEvent } from "react";

export interface NewDocTreeFormProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}

/** Full-path editor used for root-folder document creates. */
export function NewDocFullPathForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  error,
}: NewDocTreeFormProps) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1 mb-1.5">
      <div className="flex gap-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            onCancel();
          }}
          placeholder="path/to/my-doc"
          className="flex-1 min-w-0 text-xs font-[family-name:var(--font-ui)] bg-white/60 border border-sidebar-border rounded px-2 py-1 outline-none focus:border-accent-border"
          autoFocus
          disabled={busy}
        />
        <button
          type="submit"
          className="text-xs px-2 py-1 rounded bg-accent text-white border-none cursor-pointer"
          disabled={busy}
        >
          {busy ? "..." : "Go"}
        </button>
      </div>
      {error ? (
        <p className="text-[11px] text-status-red m-0 select-text">{error}</p>
      ) : null}
    </form>
  );
}

/** Filename-only editor shown as a tree entry inside a specific folder. */
export function NewDocFileNameForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  error,
  paddingLeft,
}: NewDocTreeFormProps & { paddingLeft: string }) {
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-1"
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="flex items-center gap-[7px] w-full min-w-0 px-1.5 py-[5px] rounded-[5px] text-[13px]"
        style={{ paddingLeft } satisfies CSSProperties}
      >
        <span className="text-[13px] opacity-45 w-4 shrink-0 text-center">&#128196;</span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            onCancel();
          }}
          placeholder="my-doc"
          className="flex-1 min-w-0 text-xs font-[family-name:var(--font-ui)] bg-white/60 border border-sidebar-border rounded px-2 py-1 outline-none focus:border-accent-border"
          autoFocus
          disabled={busy}
        />
        <button
          type="submit"
          className="text-xs px-2 py-1 rounded bg-accent text-white border-none cursor-pointer shrink-0"
          disabled={busy}
        >
          {busy ? "..." : "Go"}
        </button>
      </div>
      {error ? (
        <p
          className="text-[11px] text-status-red m-0 select-text px-1.5"
          style={{ paddingLeft } satisfies CSSProperties}
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
