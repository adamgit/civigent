import { fileURLToPath } from "node:url";
import path from "node:path";
import { addLocalUser } from "./local-users.js";
import { getLocalUsersFilePath } from "../storage/data-root.js";

const USAGE =
  `Usage: node --import tsx src/auth/add-local-user.ts <username>\n` +
  `       The password is read from stdin. The account is written to the accounts file\n` +
  `       under the data root (KS_DATA_ROOT), beside roles.json and agents.keys.\n` +
  `Example: printf 'correct horse battery' | node --import tsx src/auth/add-local-user.ts ada\n` +
  `In a container: printf '...' | node dist/backend/src/auth/add-local-user.js ada\n`;

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

export async function runAddLocalUserScript(argv: readonly string[]): Promise<void> {
  const username = argv[0]?.trim();
  if (!username) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const filePath = getLocalUsersFilePath();
  const password = await readPasswordFromStdin();
  const added = await addLocalUser({ username, displayName: username, password });

  process.stdout.write(
    `Added account "${added.username}" (${added.displayName}) with id ${added.id} to ${filePath}\n`,
  );
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  runAddLocalUserScript(process.argv.slice(2)).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to add the account: ${detail}\n`);
    process.exitCode = 1;
  });
}
