/**
 * SectionNavigator — tree view of document sections for rich editing mode.
 *
 * Renders the heading structure as a navigable tree. Each node can be
 * selected (to open it in the editor), renamed, or deleted. New sections
 * can be added at root level or under any parent.
 */

import type { DocStructureNode } from "../types/shared.js";

export interface SectionNavigatorProps {
  structure: DocStructureNode[];
  selectedPath: string[] | null;
  onSelectSection: (headingPath: string[]) => void;
  onCreateSection: (parentPath: string[] | null, heading: string) => void;
  onDeleteSection: (headingPath: string[]) => void;
  onRenameSection: (headingPath: string[], newHeading: string) => void;
  disabled?: boolean;
}

function pathsEqual(a: string[] | null, b: string[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === b[i]);
}

function SectionNode({
  node,
  headingPath,
  selectedPath,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  disabled,
}: {
  node: DocStructureNode;
  headingPath: string[];
  selectedPath: string[] | null;
  onSelect: (path: string[]) => void;
  onCreate: (parentPath: string[] | null, heading: string) => void;
  onDelete: (path: string[]) => void;
  onRename: (path: string[], newHeading: string) => void;
  disabled?: boolean;
}) {
  const isSelected = pathsEqual(selectedPath, headingPath);
  const hasChildren = node.children && node.children.length > 0;

  const handleAdd = () => {
    if (disabled) return;
    const heading = prompt("New section heading:");
    if (heading && heading.trim()) {
      onCreate(headingPath, heading.trim());
    }
  };

  const handleRename = () => {
    if (disabled) return;
    const newHeading = prompt("Rename section:", node.heading);
    if (newHeading && newHeading.trim() && newHeading.trim() !== node.heading) {
      onRename(headingPath, newHeading.trim());
    }
  };

  const handleDelete = () => {
    if (disabled) return;
    if (confirm(`Delete section "${node.heading}"? This will be applied at commit time.`)) {
      onDelete(headingPath);
    }
  };

  return (
    <li style={{ listStyle: "none", margin: "0.15rem 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.3rem",
          padding: "0.2rem 0.4rem",
          borderRadius: "4px",
          background: isSelected ? "rgba(100, 130, 200, 0.2)" : "transparent",
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <span
          onClick={() => !disabled && onSelect(headingPath)}
          style={{
            flex: 1,
            fontWeight: isSelected ? 600 : 400,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {node.heading}
        </span>
        {!disabled && (
          <span style={{ display: "flex", gap: "0.2rem", fontSize: "0.75rem" }}>
            <button
              type="button"
              onClick={handleAdd}
              title="Add child section"
              style={{ padding: "0 0.3rem", fontSize: "0.75rem" }}
            >
              +
            </button>
            <button
              type="button"
              onClick={handleRename}
              title="Rename"
              style={{ padding: "0 0.3rem", fontSize: "0.75rem" }}
            >
              ab
            </button>
            <button
              type="button"
              onClick={handleDelete}
              title="Delete"
              style={{ padding: "0 0.3rem", fontSize: "0.75rem" }}
            >
              x
            </button>
          </span>
        )}
      </div>
      {hasChildren && (
        <ul style={{ margin: 0, paddingLeft: "1rem" }}>
          {node.children.map((child: DocStructureNode) => {
            const childPath = [...headingPath, child.heading];
            return (
              <SectionNode
                key={childPath.join("/")}
                node={child}
                headingPath={childPath}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onCreate={onCreate}
                onDelete={onDelete}
                onRename={onRename}
                disabled={disabled}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function SectionNavigator({
  structure,
  selectedPath,
  onSelectSection,
  onCreateSection,
  onDeleteSection,
  onRenameSection,
  disabled = false,
}: SectionNavigatorProps) {
  const handleAddRoot = () => {
    if (disabled) return;
    const heading = prompt("New section heading:");
    if (heading && heading.trim()) {
      onCreateSection(null, heading.trim());
    }
  };

  return (
    <div
      style={{
        border: "1px solid #99a",
        borderRadius: "6px",
        padding: "0.5rem",
        marginBottom: "0.5rem",
        background: "rgba(230, 235, 255, 0.1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.3rem",
        }}
      >
        <strong style={{ fontSize: "0.85rem" }}>Sections</strong>
        {!disabled && (
          <button
            type="button"
            onClick={handleAddRoot}
            style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem" }}
          >
            + Add section
          </button>
        )}
      </div>
      {structure.length === 0 ? (
        <p style={{ margin: "0.3rem 0", fontSize: "0.85rem", opacity: 0.6 }}>
          No headings yet. Add one to begin organizing.
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0 }}>
          {structure.map((node) => {
            const rootPath = [node.heading];
            return (
              <SectionNode
                key={rootPath.join("/")}
                node={node}
                headingPath={rootPath}
                selectedPath={selectedPath}
                onSelect={onSelectSection}
                onCreate={onCreateSection}
                onDelete={onDeleteSection}
                onRename={onRenameSection}
                disabled={disabled}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
