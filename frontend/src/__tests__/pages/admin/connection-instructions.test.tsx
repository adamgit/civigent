import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConnectionInstructions } from "../../../pages/AgentsPage";

describe("ConnectionInstructions — connection name", () => {
  it("uses derived default (not 'my-agent') for both Claude Code command and Cursor JSON", () => {
    render(
      <ConnectionInstructions
        agentId="agent-xyz"
        secret={null}
        policy="register"
        mcpUrl="https://my.app.example.com/mcp"
      />,
    );

    const input = screen.getByLabelText(/connection name/i) as HTMLInputElement;
    expect(input.value).toBe("my.app.example.com");

    const claudeCmd = screen.getByText(
      /claude mcp add --transport http --client-id agent-xyz my\.app\.example\.com https:\/\/my\.app\.example\.com\/mcp/,
    );
    expect(claudeCmd).toBeDefined();
    expect(claudeCmd.textContent).not.toMatch(/my-agent/);

    fireEvent.click(screen.getByRole("button", { name: /^cursor$/i }));

    const cursorPre = screen.getByText(/mcpServers/i);
    expect(cursorPre.textContent).toContain('"my.app.example.com"');
    expect(cursorPre.textContent).not.toMatch(/"my-agent"/);
  });

  it("re-renders both templates when the user edits the connection name", () => {
    render(
      <ConnectionInstructions
        agentId="agent-xyz"
        secret={null}
        policy="register"
        mcpUrl="https://my.app.example.com/mcp"
      />,
    );

    const input = screen.getByLabelText(/connection name/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "prod-brain" } });
    });

    expect(
      screen.getByText(
        /claude mcp add --transport http --client-id agent-xyz prod-brain https:\/\/my\.app\.example\.com\/mcp/,
      ),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /^cursor$/i }));
    const cursorPre = screen.getByText(/mcpServers/i);
    expect(cursorPre.textContent).toContain('"prod-brain"');
  });

  it("falls back to the default when the input is cleared (empty string not used in commands)", () => {
    render(
      <ConnectionInstructions
        agentId="agent-xyz"
        secret={null}
        policy="register"
        mcpUrl="https://my.app.example.com/mcp"
      />,
    );

    const input = screen.getByLabelText(/connection name/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "" } });
    });

    const claudeCmd = screen.getByText(
      /claude mcp add --transport http --client-id agent-xyz my\.app\.example\.com https:\/\/my\.app\.example\.com\/mcp/,
    );
    expect(claudeCmd).toBeDefined();
  });

  it("uses 'civigent' as default for localhost mcp URLs", () => {
    render(
      <ConnectionInstructions
        agentId="agent-xyz"
        secret={null}
        policy="register"
        mcpUrl="http://localhost:3000/mcp"
      />,
    );

    const input = screen.getByLabelText(/connection name/i) as HTMLInputElement;
    expect(input.value).toBe("civigent");

    expect(
      screen.getByText(
        /claude mcp add --transport http --client-id agent-xyz civigent http:\/\/localhost:3000\/mcp/,
      ),
    ).toBeDefined();
  });

  it("includes --client-secret flag when policy is 'verify' with a secret, using connectionName as the alias", () => {
    render(
      <ConnectionInstructions
        agentId="agent-xyz"
        secret="sk_abc123"
        policy="verify"
        mcpUrl="https://my.app.example.com/mcp"
      />,
    );

    const claudeCmd = screen.getByText(
      /claude mcp add --transport http --client-id agent-xyz --client-secret my\.app\.example\.com https:\/\/my\.app\.example\.com\/mcp/,
    );
    expect(claudeCmd).toBeDefined();
  });
});
