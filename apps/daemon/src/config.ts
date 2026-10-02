import { homedir } from "node:os";
import { accessSync, constants, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DaemonConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  tunnelClientExecutable: string | null;
}

export function loadConfig(): DaemonConfig {
  const port = readPositiveInt(process.env.LOCAL_DEV_PORT, 43_127);
  const dataDir =
    process.env.LOCAL_DEV_DATA_DIR ??
    join(homedir(), ".local-dev");

  return {
    host: "127.0.0.1",
    port,
    dataDir,
    databasePath:
      process.env.LOCAL_DEV_CHAT_FOLDERS_DATABASE ??
      join(dataDir, "chat-folders.sqlite"),
    tunnelClientExecutable:
      process.env.LOCAL_DEV_TUNNEL_CLIENT?.trim() || bundledTunnelClient(),
  };
}

function bundledTunnelClient(): string | null {
  if (!process.argv[1]) return null;
  const candidate = join(dirname(resolve(process.argv[1])), "tunnel-client");
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
