import type { AttributionWriterType } from "../types/shared.js";

export function classifyWriterType(raw: string | undefined): AttributionWriterType {
  if (raw === "agent") return "agent";
  if (raw === "human") return "human";
  return "unknown";
}
