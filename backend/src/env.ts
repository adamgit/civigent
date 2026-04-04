/** Read a trimmed env var, returning the fallback if unset or empty. */
export function readEnvVar(key: string, fallback: string): string;
export function readEnvVar(key: string): string | undefined;
export function readEnvVar(key: string, fallback?: string): string | undefined {
  const value = process.env[key]?.trim();
  if (value) return value;
  return fallback;
}
