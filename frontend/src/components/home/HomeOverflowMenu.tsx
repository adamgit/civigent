import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

interface HomeOverflowMenuProps {
  onCreateDocument: () => void;
}

export function HomeOverflowMenu({ onCreateDocument }: HomeOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="home-overflow" ref={rootRef}>
      <button
        type="button"
        className="home-overflow__btn"
        aria-label="More"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((prev) => !prev)}
      >
        {"\u22ef"}
      </button>
      {open ? (
        <div className="home-overflow__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="home-overflow__item"
            onClick={() => {
              setOpen(false);
              onCreateDocument();
            }}
          >
            Create document
          </button>
          <Link to="/skills" role="menuitem" className="home-overflow__item" onClick={() => setOpen(false)}>
            Skills
          </Link>
          <Link to="/features" role="menuitem" className="home-overflow__item" onClick={() => setOpen(false)}>
            Features
          </Link>
          <Link to="/help" role="menuitem" className="home-overflow__item" onClick={() => setOpen(false)}>
            Help
          </Link>
          <Link to="/history" role="menuitem" className="home-overflow__item" onClick={() => setOpen(false)}>
            Audit log
          </Link>
          <a
            href="https://github.com/adamgit/civigent"
            role="menuitem"
            className="home-overflow__item"
            onClick={() => setOpen(false)}
          >
            GitHub
          </a>
        </div>
      ) : null}
    </div>
  );
}
