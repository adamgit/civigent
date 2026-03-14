interface TabDef {
  label: string;
  key: string;
  count?: number;
}

interface ActivityTabStripProps {
  tabs: TabDef[];
  activeKey: string;
  onTabChange: (key: string) => void;
}

export function ActivityTabStrip({ tabs, activeKey, onTabChange }: ActivityTabStripProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: 3,
        marginBottom: 20,
        borderBottom: "1px solid #eae7e2",
      }}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            style={{
              fontSize: "12.5px",
              fontWeight: 500,
              padding: "8px 14px",
              borderRadius: "6px 6px 0 0",
              background: active ? "white" : "none",
              color: active ? "#1d5a66" : "var(--color-text-muted)",
              borderBottom: active ? "2px solid #2d7a8a" : "2px solid transparent",
              marginBottom: -1,
              border: "none",
              borderBottomWidth: 2,
              borderBottomStyle: "solid",
              borderBottomColor: active ? "#2d7a8a" : "transparent",
              cursor: "pointer",
            }}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  background: active ? "#e8f4f6" : "#f7f5f1",
                  color: active ? "#1d5a66" : "var(--color-text-muted)",
                  padding: "1px 5px",
                  borderRadius: 8,
                  marginLeft: 4,
                }}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
