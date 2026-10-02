import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TunnelStatus } from "@local-dev/protocol";

type TunnelState = "off" | "starting" | "connected" | "error";

interface TunnelConfiguration {
  tunnelId: string;
  runtimeApiKey: string;
  clientPath?: string | null;
}

export class TunnelManager {
  private process: ChildProcess | null = null;
  private state: TunnelState = "off";
  private error: string | null = null;
  private tunnelId: string | null = null;
  private runtimeApiKey: string | null = null;
  private configuredClientPath: string | null = null;
  private stopping = false;

  private readonly pidFile: string;
  private readonly healthUrlFile: string;
  private readonly logFile: string;

  constructor(
    private readonly localMcpUrl: string,
    private readonly dataDir = join(homedir(), ".local-dev"),
    private readonly explicitExecutable?: string | null,
    private readonly authToken?: string,
  ) {
    this.pidFile = join(dataDir, "openai-tunnel.pid");
    this.healthUrlFile = join(dataDir, "openai-tunnel-health.url");
    this.logFile = join(dataDir, "logs", "openai-tunnel.log");
  }

  configure(input: TunnelConfiguration): TunnelStatus {
    const tunnelId = input.tunnelId.trim();
    const runtimeApiKey = input.runtimeApiKey.trim();

    if (!/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
      throw new Error(
        "Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters.",
      );
    }
    if (!runtimeApiKey) {
      throw new Error("OpenAI tunnel runtime API key is required.");
    }

    this.tunnelId = tunnelId;
    this.runtimeApiKey = runtimeApiKey;
    this.configuredClientPath = input.clientPath?.trim() || null;
    this.error = null;
    return this.status();
  }

  status(): TunnelStatus {
    return {
      enabled: this.state !== "off",
      connected: this.state === "connected",
      provider: this.isConfigured() ? "OpenAI Secure MCP Tunnel" : null,
      tunnelId: this.tunnelId,
      publicEndpoint: null,
      state: this.state,
      accessConfigured: this.isConfigured(),
      error: this.error,
    };
  }

  async start(): Promise<TunnelStatus> {
    if (this.state === "connected" && this.processRunning(this.process?.pid)) {
      return this.status();
    }

    const { tunnelId, runtimeApiKey } = this.requireConfiguration();
    if (!this.authToken) {
      throw new Error("Chat2Local API token is unavailable; refusing to start an unauthenticated tunnel.");
    }
    const tokenPath = resolve(this.dataDir, "api-token");
    const tokenStat = lstatSync(tokenPath);
    if (!tokenStat.isFile() || tokenStat.isSymbolicLink()
      || tokenStat.nlink !== 1 || tokenStat.uid !== process.getuid?.()
      || (tokenStat.mode & 0o077) !== 0) {
      throw new Error("Chat2Local API token file has unsafe permissions.");
    }
    if (readTrimmedFile(tokenPath) !== this.authToken) {
      throw new Error("Chat2Local API token file is unavailable or changed; refusing to start the tunnel.");
    }
    const executable = this.resolveExecutable();

    await this.stop();

    mkdirSync(dirname(this.logFile), { recursive: true });
    mkdirSync(this.dataDir, { recursive: true });
    rmSync(this.pidFile, { force: true });
    rmSync(this.healthUrlFile, { force: true });

    this.state = "starting";
    this.error = null;
    this.stopping = false;

    const child = spawn(
      executable,
      [
        "run",
        "--control-plane.tunnel-id",
        tunnelId,
        "--control-plane.api-key",
        "env:CONTROL_PLANE_API_KEY",
        "--mcp.server-url",
        this.localMcpUrl,
        "--mcp.extra-headers",
        `x-local-dev-token: file:${tokenPath}`,
        "--mcp.discovery-extra-headers",
        `x-local-dev-token: file:${tokenPath}`,
        "--health.listen-addr",
        "127.0.0.1:0",
        "--health.url-file",
        this.healthUrlFile,
        "--pid.file",
        this.pidFile,
        "--log.file",
        this.logFile,
      ],
      {
        env: {
          ...process.env,
          CONTROL_PLANE_API_KEY: runtimeApiKey,
        },
        shell: false,
        stdio: "ignore",
      },
    );

    this.process = child;

    child.once("error", (error) => {
      this.error = error.message;
      this.state = "error";
      this.process = null;
    });

    child.once("exit", (code, signal) => {
      if (this.process === child) {
        this.process = null;
      }
      if (this.stopping || signal === "SIGTERM") {
        this.state = "off";
        this.error = null;
        return;
      }
      if (code === 0) {
        this.state = "off";
        this.error = null;
        return;
      }
      if (code !== 0) {
        this.state = "error";
        this.error =
          `tunnel-client exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`;
      }
    });

    const ready = await this.waitUntilReady(child, 12_000);
    if (!ready) {
      const message =
        this.error
        ?? "OpenAI tunnel-client started but did not become ready.";
      await this.stop();
      this.state = "error";
      this.error = message;
      throw new Error(message);
    }

    this.state = "connected";
    this.error = null;
    return this.status();
  }

  async adoptLegacyTunnel(): Promise<TunnelStatus> {
    this.requireConfiguration();

    await this.stopLegacyTunnelClient();

    try {
      const status = await this.start();
      this.disableLegacyTunnelAutostart();
      return status;
    } catch (error) {
      const migrationError =
        error instanceof Error ? error.message : String(error);

      try {
        await this.restoreLegacyTunnelClient();
      } catch (rollbackError) {
        const rollbackMessage =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        this.state = "error";
        this.error =
          `${migrationError} Legacy tunnel rollback also failed: ${rollbackMessage}`;
        throw new Error(this.error);
      }

      this.state = "error";
      this.error =
        `${migrationError} The previous ChatGPT tunnel was restored.`;
      throw new Error(this.error);
    }
  }

  async stop(): Promise<TunnelStatus> {
    const child = this.process;
    if (!child || !this.processRunning(child.pid)) {
      this.process = null;
      this.state = "off";
      this.error = null;
      rmSync(this.pidFile, { force: true });
      rmSync(this.healthUrlFile, { force: true });
      return this.status();
    }

    this.stopping = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && this.processRunning(child.pid)) {
      await sleep(100);
    }

    if (this.processRunning(child.pid)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }

    this.process = null;
    this.stopping = false;
    this.state = "off";
    this.error = null;
    rmSync(this.pidFile, { force: true });
    rmSync(this.healthUrlFile, { force: true });
    return this.status();
  }

  private isConfigured(): boolean {
    return Boolean(this.tunnelId && this.runtimeApiKey);
  }

  private requireConfiguration(): {
    tunnelId: string;
    runtimeApiKey: string;
  } {
    if (!this.tunnelId || !this.runtimeApiKey) {
      throw new Error(
        "OpenAI tunnel credentials are not configured. Import the existing Chat2Local connection first.",
      );
    }
    return {
      tunnelId: this.tunnelId,
      runtimeApiKey: this.runtimeApiKey,
    };
  }

  private resolveExecutable(): string {
    const candidates = [
      this.configuredClientPath,
      this.explicitExecutable,
      process.env.LOCAL_DEV_TUNNEL_CLIENT,
      ...String(process.env.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((entry) => join(entry, "tunnel-client")),
      join(this.dataDir, "bin", "tunnel-client"),
      "/opt/homebrew/bin/tunnel-client",
      "/usr/local/bin/tunnel-client",
      "/Applications/Chat On Steroids.app/Contents/Resources/tunnel/tunnel-client",
      join(
        homedir(),
        "Applications/Chat On Steroids.app/Contents/Resources/tunnel/tunnel-client",
      ),
    ].filter((value): value is string => Boolean(value));

    const found = Array.from(new Set(candidates)).find((candidate) =>
      isExecutable(candidate),
    );

    if (!found) {
      throw new Error(
        "OpenAI tunnel-client was not found. Use the packaged Chat2Local app or select an official tunnel-client executable in Connection settings.",
      );
    }
    return found;
  }

  private async waitUntilReady(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.processRunning(child.pid)) return false;

      const healthUrl = readTrimmedFile(this.healthUrlFile);
      if (healthUrl && /^http:\/\/127\.0\.0\.1:\d+$/.test(healthUrl)) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1_500);
          const response = await fetch(`${healthUrl}/readyz`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (response.ok) return true;
        } catch {
          // Still starting.
        }
      }

      await sleep(150);
    }

    return false;
  }

  private async stopLegacyTunnelClient(): Promise<void> {
    const legacyPidFile = join(homedir(), ".localant", "openai-tunnel.pid");
    const rawPid = readTrimmedFile(legacyPidFile);
    const pid = rawPid ? Number.parseInt(rawPid, 10) : Number.NaN;

    if (!Number.isFinite(pid) || pid <= 1 || !this.processRunning(pid)) {
      return;
    }

    const command = processCommand(pid);
    if (
      !command.includes("tunnel-client")
      || (this.tunnelId && !command.includes(this.tunnelId))
    ) {
      throw new Error(
        "Refusing to stop the legacy tunnel process because its command does not match the expected tunnel-client and tunnel ID.",
      );
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && this.processRunning(pid)) {
      await sleep(100);
    }

    if (this.processRunning(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }

  private async restoreLegacyTunnelClient(): Promise<void> {
    const { tunnelId, runtimeApiKey } = this.requireConfiguration();
    const root = join(homedir(), ".localant");
    const configPath = join(root, "config.json");
    const legacyPidFile = join(root, "openai-tunnel.pid");
    const legacyHealthFile = join(root, "openai-tunnel-health.url");
    const legacyLogFile = join(root, "logs", "openai-tunnel.log");

    let target = "http://127.0.0.1:8787/mcp";
    try {
      const parsed = JSON.parse(
        readFileSync(configPath, "utf8"),
      ) as Record<string, unknown>;
      const openaiTunnel =
        parsed.openaiTunnel && typeof parsed.openaiTunnel === "object"
          ? parsed.openaiTunnel as Record<string, unknown>
          : null;
      const configuredTarget =
        typeof openaiTunnel?.localMcpUrl === "string"
          ? openaiTunnel.localMcpUrl.trim()
          : "";
      if (configuredTarget) target = configuredTarget;
    } catch {
      // Fall back to the legacy default target.
    }

    const token = readTrimmedFile(join(root, "token"));
    const executable = this.resolveExecutable();
    rmSync(legacyPidFile, { force: true });
    rmSync(legacyHealthFile, { force: true });
    mkdirSync(dirname(legacyLogFile), { recursive: true });

    const args = [
      "run",
      "--control-plane.tunnel-id",
      tunnelId,
      "--control-plane.api-key",
      "env:CONTROL_PLANE_API_KEY",
      "--mcp.server-url",
      target,
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CONTROL_PLANE_API_KEY: runtimeApiKey,
    };

    if (token) {
      env.LOCALANT_MCP_TOKEN = token;
      args.push(
        "--mcp.extra-headers",
        "x-cla-token: env:LOCALANT_MCP_TOKEN",
        "--mcp.discovery-extra-headers",
        "x-cla-token: env:LOCALANT_MCP_TOKEN",
      );
    }

    args.push(
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      legacyHealthFile,
      "--pid.file",
      legacyPidFile,
      "--log.file",
      legacyLogFile,
    );

    const child = spawn(executable, args, {
      env,
      shell: false,
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const rawPid = readTrimmedFile(legacyPidFile);
      const pid = rawPid ? Number.parseInt(rawPid, 10) : Number.NaN;
      const healthUrl = readTrimmedFile(legacyHealthFile);

      if (
        Number.isFinite(pid)
        && this.processRunning(pid)
        && healthUrl
        && /^http:\/\/127\.0\.0\.1:\d+$/.test(healthUrl)
      ) {
        try {
          const response = await fetch(`${healthUrl}/readyz`);
          if (response.ok) return;
        } catch {
          // Still recovering.
        }
      }
      await sleep(150);
    }

    throw new Error("The previous OpenAI tunnel could not be restarted.");
  }

  private disableLegacyTunnelAutostart(): void {
    const configPath = join(homedir(), ".localant", "config.json");
    if (!existsSync(configPath)) return;

    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const openaiTunnel =
        parsed.openaiTunnel && typeof parsed.openaiTunnel === "object"
          ? { ...(parsed.openaiTunnel as Record<string, unknown>) }
          : {};

      if (openaiTunnel.enabled !== true) return;

      openaiTunnel.enabled = false;
      parsed.openaiTunnel = openaiTunnel;

      const tempPath = `${configPath}.local-dev-migration`;
      writeFileSync(tempPath, JSON.stringify(parsed, null, 2) + "\n", {
        mode: 0o600,
      });
      writeFileSync(configPath, readFileSync(tempPath));
      rmSync(tempPath, { force: true });
    } catch {
      // Migration still succeeds even if the legacy config cannot be edited.
    }
  }

  private processRunning(pid?: number): boolean {
    if (!pid || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

function isExecutable(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function readTrimmedFile(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function processCommand(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
  } catch {
    return "";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
