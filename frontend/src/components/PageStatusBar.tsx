interface PageStatusBarProps {
  items: string[];
}

export function PageStatusBar({ items }: PageStatusBarProps) {
  return (
    <div className="h-[26px] min-h-[26px] bg-footer-bg border-t border-footer-border font-mono text-[10.5px] text-footer-text flex items-center px-3.5 gap-1">
      {items.map((item, i) => (
        <span key={i}>
          {i > 0 && <span className="mx-1.5 text-text-faint">&middot;</span>}
          {item}
        </span>
      ))}
    </div>
  );
}
