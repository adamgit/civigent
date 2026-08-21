interface HomeWidePagerProps {
  page: number;
  pageSize: number;
  total: number;
  setPage: (page: number) => void;
  label: string;
}

export function HomeWidePager({ page, pageSize, total, setPage, label }: HomeWidePagerProps) {
  if (total <= pageSize) return null;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="home-recent__pager" aria-label={label}>
      <button
        type="button"
        className="home-recent__pager-btn"
        disabled={page <= 0}
        onClick={() => setPage(page - 1)}
      >
        Previous
      </button>
      <span className="home-recent__pager-status">
        {start}{"\u2013"}{end} of {total}
      </span>
      <button
        type="button"
        className="home-recent__pager-btn"
        disabled={page >= pageCount - 1}
        onClick={() => setPage(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
