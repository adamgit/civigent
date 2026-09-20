import type { AuthenticatedWriter } from "../auth/context.js";
import type { InFlightMcpCall } from "../types/shared.js";

export type InFlightMcpCallToken = number;

let nextToken = 1;
const openCalls = new Map<InFlightMcpCallToken, InFlightMcpCall>();

export function begin(writer: AuthenticatedWriter, tool: string): InFlightMcpCallToken {
  const token = nextToken++;
  openCalls.set(token, {
    writer_id: writer.id,
    writer_display_name: writer.displayName,
    writer_type: writer.type,
    tool,
  });
  return token;
}

export function end(token: InFlightMcpCallToken): void {
  openCalls.delete(token);
}

export function snapshot(): InFlightMcpCall[] {
  return [...openCalls.values()].map((call) => ({ ...call }));
}
