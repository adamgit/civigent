import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SectionNavigator } from "../../components/SectionNavigator";
import type { DocStructureNode } from "../../types/shared";

const noop = () => {};

const sampleStructure: DocStructureNode[] = [
  {
    heading: "Introduction",
    level: 2,
    children: [
      { heading: "Background", level: 3, children: [] },
    ],
  },
  { heading: "Conclusion", level: 2, children: [] },
];

describe("SectionNavigator", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders heading tree from structure prop", () => {
    render(
      <SectionNavigator
        structure={sampleStructure}
        selectedPath={null}
        onSelectSection={noop}
        onCreateSection={noop}
        onDeleteSection={noop}
        onRenameSection={noop}
      />,
    );

    expect(screen.getByText("Introduction")).toBeDefined();
    expect(screen.getByText("Background")).toBeDefined();
    expect(screen.getByText("Conclusion")).toBeDefined();
  });

  it("click heading calls onSelectSection with correct path", () => {
    const onSelectSection = vi.fn();
    render(
      <SectionNavigator
        structure={sampleStructure}
        selectedPath={null}
        onSelectSection={onSelectSection}
        onCreateSection={noop}
        onDeleteSection={noop}
        onRenameSection={noop}
      />,
    );

    fireEvent.click(screen.getByText("Background"));
    expect(onSelectSection).toHaveBeenCalledWith(["Introduction", "Background"]);
  });

  it("add button calls onCreateSection with parent path", () => {
    const onCreateSection = vi.fn();
    vi.stubGlobal("prompt", vi.fn(() => "New Section"));

    render(
      <SectionNavigator
        structure={sampleStructure}
        selectedPath={null}
        onSelectSection={noop}
        onCreateSection={onCreateSection}
        onDeleteSection={noop}
        onRenameSection={noop}
      />,
    );

    // Click the "+" button on "Introduction"
    const addButtons = screen.getAllByTitle("Add child section");
    fireEvent.click(addButtons[0]);

    expect(onCreateSection).toHaveBeenCalledWith(["Introduction"], "New Section");
  });

  it("rename button calls onRenameSection with new heading", () => {
    const onRenameSection = vi.fn();
    vi.stubGlobal("prompt", vi.fn(() => "Updated Title"));

    render(
      <SectionNavigator
        structure={sampleStructure}
        selectedPath={null}
        onSelectSection={noop}
        onCreateSection={noop}
        onDeleteSection={noop}
        onRenameSection={onRenameSection}
      />,
    );

    const renameButtons = screen.getAllByTitle("Rename");
    fireEvent.click(renameButtons[0]);

    expect(onRenameSection).toHaveBeenCalledWith(["Introduction"], "Updated Title");
  });

  it("delete button calls onDeleteSection with path", () => {
    const onDeleteSection = vi.fn();
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(
      <SectionNavigator
        structure={sampleStructure}
        selectedPath={null}
        onSelectSection={noop}
        onCreateSection={noop}
        onDeleteSection={onDeleteSection}
        onRenameSection={noop}
      />,
    );

    const deleteButtons = screen.getAllByTitle("Delete");
    fireEvent.click(deleteButtons[0]);

    expect(onDeleteSection).toHaveBeenCalledWith(["Introduction"]);
  });

  it("selected section highlighted", () => {
    const { container } = render(
      <SectionNavigator
        structure={sampleStructure}
        selectedPath={["Conclusion"]}
        onSelectSection={noop}
        onCreateSection={noop}
        onDeleteSection={noop}
        onRenameSection={noop}
      />,
    );

    // The selected section should have fontWeight 600
    const conclusionSpan = screen.getByText("Conclusion");
    expect(conclusionSpan.style.fontWeight).toBe("600");
  });

  it("disabled prop prevents interactions", () => {
    const onSelectSection = vi.fn();
    render(
      <SectionNavigator
        structure={sampleStructure}
        selectedPath={null}
        onSelectSection={onSelectSection}
        onCreateSection={noop}
        onDeleteSection={noop}
        onRenameSection={noop}
        disabled={true}
      />,
    );

    // Click should not trigger callback when disabled
    fireEvent.click(screen.getByText("Introduction"));
    expect(onSelectSection).not.toHaveBeenCalled();

    // Action buttons should not be visible when disabled
    expect(screen.queryByTitle("Add child section")).toBeNull();
    expect(screen.queryByTitle("Rename")).toBeNull();
    expect(screen.queryByTitle("Delete")).toBeNull();
  });

  it("empty structure shows placeholder", () => {
    render(
      <SectionNavigator
        structure={[]}
        selectedPath={null}
        onSelectSection={noop}
        onCreateSection={noop}
        onDeleteSection={noop}
        onRenameSection={noop}
      />,
    );

    expect(screen.getByText(/No headings yet/)).toBeDefined();
  });

  it("'+ Add section' button at root level calls onCreateSection with null parent", () => {
    const onCreateSection = vi.fn();
    vi.stubGlobal("prompt", vi.fn(() => "Root Section"));

    render(
      <SectionNavigator
        structure={sampleStructure}
        selectedPath={null}
        onSelectSection={noop}
        onCreateSection={onCreateSection}
        onDeleteSection={noop}
        onRenameSection={noop}
      />,
    );

    fireEvent.click(screen.getByText("+ Add section"));
    expect(onCreateSection).toHaveBeenCalledWith(null, "Root Section");
  });
});
