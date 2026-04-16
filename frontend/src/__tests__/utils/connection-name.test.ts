import { describe, it, expect } from "vitest";
import { defaultConnectionName } from "../../utils/connection-name";

describe("defaultConnectionName", () => {
  it("returns 'civigent' for localhost variants", () => {
    expect(defaultConnectionName("http://localhost/mcp")).toBe("civigent");
    expect(defaultConnectionName("http://127.0.0.1:3000/mcp")).toBe("civigent");
    expect(defaultConnectionName("http://[::1]:3000/mcp")).toBe("civigent");
    expect(defaultConnectionName("http://0.0.0.0:3000/mcp")).toBe("civigent");
  });

  it("returns the hostname unchanged for a normal public hostname", () => {
    expect(defaultConnectionName("https://my.app.example.com/mcp")).toBe("my.app.example.com");
  });

  it("strips the port from a hostname-with-port URL", () => {
    expect(defaultConnectionName("https://civigent.example.com:8443/mcp")).toBe("civigent.example.com");
  });

  it("returns 'civigent' for empty input", () => {
    expect(defaultConnectionName("")).toBe("civigent");
  });

  it("returns 'civigent' for a malformed URL", () => {
    expect(defaultConnectionName("not a url")).toBe("civigent");
  });

  it("sanitizes special characters in the hostname labels", () => {
    expect(defaultConnectionName("https://weird--host.io/mcp")).toBe("weird-host.io");
  });

  it("lowercases an uppercase hostname", () => {
    expect(defaultConnectionName("https://MY.APP.example.com/mcp")).toBe("my.app.example.com");
  });
});
