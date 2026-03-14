interface DocumentSearchFieldProps {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}

export function DocumentSearchField({ placeholder = "Search...", value, onChange }: DocumentSearchFieldProps) {
  return (
    <div style={{ position: "relative" }}>
      <span
        style={{
          position: "absolute",
          left: 10,
          top: "50%",
          transform: "translateY(-50%)",
          color: "#b8b2a8",
          fontSize: 13,
          pointerEvents: "none",
        }}
      >
        &#128270;
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          fontSize: 13,
          padding: "8px 12px 8px 32px",
          border: "1px solid #eae7e2",
          borderRadius: 7,
          background: "white",
          width: "100%",
          outline: "none",
        }}
        onFocus={(e) => {
          (e.target as HTMLInputElement).style.borderColor = "#a8d5dc";
        }}
        onBlur={(e) => {
          (e.target as HTMLInputElement).style.borderColor = "#eae7e2";
        }}
      />
    </div>
  );
}
