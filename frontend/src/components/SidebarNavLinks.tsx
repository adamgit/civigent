import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

const linkClass =
  "flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all";

function NavLink({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link to={to} className={linkClass}>
      <span className="text-xs w-4 text-center opacity-50">{icon}</span>
      {children}
    </Link>
  );
}

const ADMIN_LINKS: Array<{ to: string; icon: ReactNode; label: string }> = [
  { to: "/proposals", icon: <>&#128203;</>, label: "Proposals" },
  { to: "/coordination", icon: <>&#128301;</>, label: "Coordination" },
  { to: "/admin/agents-auth", icon: <>&#128273;</>, label: "Agent Keys" },
  { to: "/agent-simulator", icon: <>&#129302;</>, label: "Agent Sim" },
  { to: "/imports", icon: <>&#128229;</>, label: "Imports" },
  { to: "/admin/agent-mcp-logs", icon: <>&#128202;</>, label: "Agent Monitoring" },
  { to: "/admin/snapshots", icon: <>&#128247;</>, label: "Snapshots" },
  { to: "/admin/git-backup", icon: <>&#128190;</>, label: "Git Backup" },
  { to: "/admin/runtime-memory", icon: <>&#128200;</>, label: "Runtime Memory" },
];

function SidebarSearch() {
  const [open, setOpen] = useState(false);
  const [syntax, setSyntax] = useState<"literal" | "regexp">("literal");
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${linkClass} w-full text-left bg-transparent border-none cursor-pointer font-[family-name:var(--font-ui)]`}
      >
        <span className="text-xs w-4 text-center opacity-50" aria-hidden="true">
          &#128269;
        </span>
        Search
      </button>
    );
  }

  return (
    <div ref={rootRef} className="px-1.5 py-1">
      <form
        action="/search-text"
        method="GET"
        className="flex items-center gap-1"
      >
        <input type="hidden" name="root" value="/" />
        <input type="hidden" name="case_sensitive" value="false" />
        <input type="hidden" name="max_results" value="20" />
        <input type="hidden" name="context_bytes" value="100" />
        <input type="hidden" name="syntax" value={syntax} />

        <input
          ref={inputRef}
          type="text"
          name="pattern"
          required
          placeholder="Search…"
          className="min-w-0 flex-1 text-xs font-[family-name:var(--font-ui)] bg-white/60 border border-sidebar-border rounded px-1.5 py-1 outline-none focus:border-accent-border text-sidebar-text"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />

        <button
          type="button"
          title={syntax === "literal" ? "Plain text (click for regexp)" : "Regexp (click for plain text)"}
          aria-label={syntax === "literal" ? "Search mode: plain text" : "Search mode: regexp"}
          onClick={() => setSyntax((s) => (s === "literal" ? "regexp" : "literal"))}
          className={`shrink-0 w-[22px] h-[22px] rounded text-[10px] font-mono leading-none flex items-center justify-center border cursor-pointer transition-colors ${
            syntax === "regexp"
              ? "bg-accent-light text-accent-text border-accent-border"
              : "bg-white/60 text-sidebar-text border-sidebar-border hover:bg-white/80"
          }`}
        >
          {syntax === "literal" ? "Aa" : ".*"}
        </button>

        <button
          type="submit"
          title="Search"
          aria-label="Search"
          className="shrink-0 w-[22px] h-[22px] rounded flex items-center justify-center bg-accent text-white border-none cursor-pointer text-[12px] leading-none"
        >
          &#128269;
        </button>
      </form>
    </div>
  );
}

function AdminFlyout() {
  return (
    <div className="relative group/admin">
      <Link to="/admin" className={linkClass}>
        <span className="text-xs w-4 text-center opacity-50">&#9881;</span> Admin
        <span className="ml-auto text-[10px] opacity-40 group-hover/admin:opacity-70" aria-hidden="true">
          &#9656;
        </span>
      </Link>
      <div
        className="pointer-events-none invisible opacity-0 group-hover/admin:pointer-events-auto group-hover/admin:visible group-hover/admin:opacity-100 absolute left-full bottom-0 z-50 pl-1 transition-opacity"
        role="menu"
        aria-label="Admin links"
      >
        <div className="min-w-[168px] rounded border border-sidebar-border bg-sidebar-bg py-1 shadow-md">
          {ADMIN_LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              role="menuitem"
              className={linkClass}
            >
              <span className="text-xs w-4 text-center opacity-50">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export type SidebarNavLinksVariant = "primary" | "footer";

interface SidebarNavLinksProps {
  variant: SidebarNavLinksVariant;
}

/**
 * Movable sidebar link groups. `primary` sits under the Civigent header;
 * `footer` sits at the bottom of the nav (above the version line).
 */
export function SidebarNavLinks({ variant }: SidebarNavLinksProps) {
  if (variant === "primary") {
    return (
      <nav className="px-2 pt-1 pb-2 flex flex-col gap-px border-b border-sidebar-border" aria-label="Primary">
        <SidebarSearch />
        <NavLink to="/agents-activity" icon={<>&#129302;</>}>
          Agents
        </NavLink>
      </nav>
    );
  }

  return (
    <nav className="px-2 pt-2.5 pb-3.5 border-t border-sidebar-border flex flex-col gap-px overflow-visible" aria-label="Footer">
      <NavLink to="/history" icon={<>&#128336;</>}>
        Audit Log
      </NavLink>
      <AdminFlyout />
      <NavLink to="/help" icon={<>&#10067;</>}>
        Help & FAQ
      </NavLink>
    </nav>
  );
}
