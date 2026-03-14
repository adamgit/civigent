import { useState } from "react";
import { Link } from "react-router-dom";
import { userFeatures, architectureFeatures } from "./features-content";

type Tab = "user" | "architecture";

export function FeaturesPage() {
  const [activeTab, setActiveTab] = useState<Tab>("user");
  const features = activeTab === "user" ? userFeatures : architectureFeatures;

  return (
    <div className="flex-1 overflow-auto canvas-scroll" style={{ fontFamily: "var(--font-ui)" }}>
      <div style={{ maxWidth: 740, margin: "0 auto", padding: "2.5rem 1.5rem 3rem" }}>

        <div style={{ marginBottom: "1.5rem" }}>
          <Link to="/" style={{ fontSize: 12, color: "var(--color-accent)", textDecoration: "none" }}>
            &larr; Home
          </Link>
        </div>

        <div style={{ marginBottom: "1.75rem" }}>
          <p style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 6 }}>
            Civigent
          </p>
          <h1 style={{ fontFamily: "var(--font-body)", fontSize: 28, fontWeight: 500, lineHeight: 1.2, marginBottom: 4 }}>
            Features
          </h1>
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)" }}>
            Everything this installation supports.
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: "1.5rem" }}>
          <button
            onClick={() => setActiveTab("user")}
            style={{
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: 500,
              fontFamily: "var(--font-ui)",
              border: "1px solid var(--color-footer-border)",
              borderRadius: 8,
              background: activeTab === "user" ? "var(--color-sidebar-bg)" : "transparent",
              color: activeTab === "user" ? "var(--color-text-primary)" : "var(--color-text-muted)",
              cursor: "pointer",
            }}
          >
            User features
          </button>
          <button
            onClick={() => setActiveTab("architecture")}
            style={{
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: 500,
              fontFamily: "var(--font-ui)",
              border: "1px solid var(--color-footer-border)",
              borderRadius: 8,
              background: activeTab === "architecture" ? "var(--color-sidebar-bg)" : "transparent",
              color: activeTab === "architecture" ? "var(--color-text-primary)" : "var(--color-text-muted)",
              cursor: "pointer",
            }}
          >
            Architecture
          </button>
        </div>

        {/* Feature list */}
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {features.map((feature, i) => (
            <li
              key={i}
              style={{
                padding: "8px 0",
                borderBottom: "1px solid var(--color-footer-border)",
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--color-text-primary)",
                display: "flex",
                gap: 10,
                alignItems: "baseline",
              }}
            >
              <span style={{ color: "var(--color-text-faint)", flexShrink: 0 }}>&bull;</span>
              <span>{feature}</span>
            </li>
          ))}
        </ul>

        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: "1.5rem" }}>
          {features.length} features listed
        </p>
      </div>
    </div>
  );
}
