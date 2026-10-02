import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export interface BackgroundBrowserTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

export interface BackgroundBrowserInspection {
  mode: "background";
  browser: "Brave Browser";
  target: BackgroundBrowserTarget;
  targets: BackgroundBrowserTarget[];
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

export interface BackgroundBrowserLaunch {
  command: string;
  argsPrefix: string[];
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class BackgroundBrowserController {
  readonly profileDir: string;
  readonly executablePath: string;
  private readonly launch: BackgroundBrowserLaunch | undefined;

  private currentTargetId: string | null = null;
  private nextMessageId = 1;
  private startPromise: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private input: Writable | null = null;
  private output: Readable | null = null;
  private incoming = Buffer.alloc(0);
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private closed = false;

  get port(): number {
    // Retained for callers that used the prior TCP controller.
    // Pipe transport never opens a listening port.
    return 0;
  }

  constructor(
    dataDir: string,
    options: {
      port?: number;
      profileDir?: string;
      executablePath?: string;
      launch?: BackgroundBrowserLaunch;
    } = {},
  ) {
    this.launch = options.launch;
    this.profileDir = options.profileDir ?? join(dataDir, "background-browser");
    this.executablePath =
      options.executablePath
      ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  }

  async inspect(): Promise<BackgroundBrowserInspection> {
    const target = await this.currentTarget();
    const metrics = await this.cdpCall<{
      cssLayoutViewport?: {
        clientWidth?: number;
        clientHeight?: number;
      };
    }>(target, "Page.getLayoutMetrics");

    return {
      mode: "background",
      browser: "Brave Browser",
      target,
      targets: await this.listTargets(),
      viewport: {
        width:
          metrics.cssLayoutViewport?.clientWidth
          ?? 1440,
        height:
          metrics.cssLayoutViewport?.clientHeight
          ?? 1000,
        deviceScaleFactor: 1,
      },
    };
  }

  async navigate(url: string): Promise<BackgroundBrowserTarget> {
    const target = await this.currentTarget();
    const navigation = await this.cdpCall<{ errorText?: string }>(
      target,
      "Page.navigate",
      { url },
    );
    if (navigation.errorText) {
      throw new Error(`Background browser navigation failed: ${navigation.errorText}`);
    }
    await this.waitForReady(target);
    const refreshed = await this.refreshTarget(target.id);
    if (refreshed.url.startsWith("chrome-error://")) {
      throw new Error("Background browser navigation failed: Brave displayed an error page");
    }
    return refreshed;
  }

  async focusTab(
    targetText: string,
  ): Promise<BackgroundBrowserTarget> {
    const normalized = targetText.toLowerCase();
    const targets = await this.listTargets();
    const match = targets.find((target) => {
      if (target.type !== "page") return false;
      return (
        target.title.toLowerCase().includes(normalized)
        || target.url.toLowerCase().includes(normalized)
      );
    });

    if (!match) {
      throw new Error(
        `No background Brave tab matched ${targetText}`,
      );
    }

    this.currentTargetId = match.id;
    return match;
  }

  async click(
    x: number,
    y: number,
    options: {
      button?: "left" | "right";
      clickCount?: number;
    } = {},
  ): Promise<void> {
    const target = await this.currentTarget();
    const button = options.button ?? "left";
    const clickCount = Math.min(
      Math.max(options.clickCount ?? 1, 1),
      3,
    );

    await this.cdpCall(
      target,
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x,
        y,
        button,
        clickCount,
      },
    );
    await this.cdpCall(
      target,
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x,
        y,
        button,
        clickCount,
      },
    );
  }

  async type(text: string): Promise<void> {
    const target = await this.currentTarget();
    await this.cdpCall(
      target,
      "Input.insertText",
      { text },
    );
  }

  async key(
    key: string,
    modifiers: string[] = [],
  ): Promise<void> {
    const target = await this.currentTarget();
    const modifierMask = this.modifierMask(modifiers);
    const normalized = this.normalizeKey(key);

    await this.cdpCall(
      target,
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: normalized.key,
        code: normalized.code,
        windowsVirtualKeyCode:
          normalized.windowsVirtualKeyCode,
        nativeVirtualKeyCode:
          normalized.windowsVirtualKeyCode,
        modifiers: modifierMask,
      },
    );
    await this.cdpCall(
      target,
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: normalized.key,
        code: normalized.code,
        windowsVirtualKeyCode:
          normalized.windowsVirtualKeyCode,
        nativeVirtualKeyCode:
          normalized.windowsVirtualKeyCode,
        modifiers: modifierMask,
      },
    );
  }

  async scroll(
    deltaX: number,
    deltaY: number,
    x = 720,
    y = 500,
  ): Promise<void> {
    const target = await this.currentTarget();
    await this.cdpCall(
      target,
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
      },
    );
  }

  async resize(
    width: number,
    height: number,
  ): Promise<void> {
    const target = await this.currentTarget();
    await this.cdpCall(
      target,
      "Emulation.setDeviceMetricsOverride",
      {
        width: Math.max(320, Math.round(width)),
        height: Math.max(240, Math.round(height)),
        deviceScaleFactor: 1,
        mobile: false,
      },
    );
  }

  async screenshot(): Promise<Buffer> {
    const target = await this.currentTarget();
    const result = await this.cdpCall<{
      data: string;
    }>(
      target,
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      },
    );
    return Buffer.from(result.data, "base64");
  }

  async evaluate<T = unknown>(
    expression: string,
  ): Promise<T> {
    const target = await this.currentTarget();
    const result = await this.cdpCall<{
      result?: {
        value?: T;
        description?: string;
      };
      exceptionDetails?: {
        text?: string;
      };
    }>(
      target,
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    );

    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text
        ?? "Background browser evaluation failed",
      );
    }

    return result.result?.value as T;
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("Background browser controller is closed");
    if (this.startPromise) {
      await this.startPromise;
      if (this.closed) throw new Error("Background browser controller is closed");
      return;
    }
    if (this.child && this.input && this.output) return;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
    if (this.closed) throw new Error("Background browser controller is closed");
  }

  private async start(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true });
    if (this.closed) throw new Error("Background browser controller is closed");

    const child = spawn(
      this.launch?.command ?? this.executablePath,
      [
        ...(this.launch?.argsPrefix ?? []),
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--remote-debugging-pipe",
        `--user-data-dir=${this.profileDir}`,
        "--window-size=1440,1000",
        ...(this.launch?.extraArgs ?? []),
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        detached: Boolean(this.launch),
        ...(this.launch?.env ? { env: this.launch.env } : {}),
      },
    );
    this.child = child;
    this.input = child.stdio[3] as Writable | null;
    this.output = child.stdio[4] as Readable | null;
    this.incoming = Buffer.alloc(0);
    if (!this.input || !this.output) {
      child.kill("SIGTERM");
      throw new Error("Background Brave did not provide CDP pipes");
    }

    // CDP EOF can arrive before stderr and the process exit event. Retain a
    // bounded tail and prefer the child close event, which follows stdio drain.
    // A broken pipe on a still-running browser must nevertheless fail promptly.
    let stderrTail = Buffer.alloc(0);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.from(Buffer.concat([stderrTail, chunk]).subarray(-8192));
    });
    child.stderr?.on("error", () => {});
    let terminationError: Error | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    let terminationFinished = false;
    const finishTermination = () => {
      if (terminationFinished || !terminationError) return;
      terminationFinished = true;
      clearTimeout(terminationTimer);
      const details = [terminationError.message];
      const exit = child.exitCode ?? child.signalCode;
      if (exit !== null) {
        const status = `Background Brave exited (${exit})`;
        if (!details.includes(status)) details.push(status);
      }
      const stderr = stderrTail.toString("utf8").trim();
      if (stderr) details.push(`Brave launch stderr (last 8 KiB):\n${stderr}`);
      this.onTermination(child, new Error(details.join("\n")));
    };
    const terminate = (error: Error) => {
      if (terminationFinished) return;
      terminationError ??= error;
      terminationTimer ??= setTimeout(finishTermination, 100);
    };
    child.once("error", terminate);
    child.once("exit", (code, signal) => {
      terminate(new Error(`Background Brave exited (${code ?? signal ?? "unknown"})`));
    });
    child.once("close", finishTermination);
    this.input.once("error", terminate);
    this.input.once("close", () => {
      terminate(new Error("Background Brave CDP pipe closed"));
    });
    this.output.once("error", terminate);
    this.output.once("end", () => {
      terminate(new Error("Background Brave CDP pipe closed"));
    });
    this.output.once("close", () => {
      terminate(new Error("Background Brave CDP pipe closed"));
    });
    this.output.on("data", (chunk: Buffer | string) => {
      this.onPipeData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    await this.sendCommand("Browser.getVersion", {}, undefined, 15_000);
  }

  private onTermination(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    // Wrapped launches own a detached process group. Kill its helpers before
    // dropping the only ownership handle, including when the leader exited.
    if (this.launch && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    this.child = null;
    this.input = null;
    this.output = null;
    this.incoming = Buffer.alloc(0);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }

  private onPipeData(chunk: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, chunk]);
    if (this.incoming.length > 64 * 1024 * 1024) {
      this.child?.kill("SIGTERM");
      return;
    }
    for (;;) {
      const end = this.incoming.indexOf(0);
      if (end < 0) return;
      const frame = this.incoming.subarray(0, end).toString("utf8");
      this.incoming = this.incoming.subarray(end + 1);
      let response: CdpResponse;
      try {
        response = JSON.parse(frame) as CdpResponse;
      } catch {
        continue;
      }
      if (typeof response.id !== "number") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timeout);
      if (response.error) {
        pending.reject(new Error(response.error.message ?? "CDP command failed"));
      } else {
        pending.resolve(response.result ?? {});
      }
    }
  }

  private async sendCommand<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10_000,
  ): Promise<T> {
    const input = this.input;
    if (!input || !this.child) {
      throw new Error(`Background Brave CDP pipe is unavailable: ${method}`);
    }
    const id = this.nextMessageId++;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timeout,
      });
      try {
        input.write(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0",
          (error) => {
            if (!error) return;
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            clearTimeout(pending.timeout);
            pending.reject(error);
          },
        );
      } catch (error) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async browserCall<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.ensureStarted();
    return await this.sendCommand<T>(method, params);
  }

  async disableDownloads(): Promise<void> {
    await this.browserCall("Browser.setDownloadBehavior", { behavior: "deny" });
  }

  async close(): Promise<void> {
    this.closed = true;
    const owned = this.launch ? this.child : null;
    const stopOwnedGroup = (signal: NodeJS.Signals) => {
      if (!owned?.pid) return;
      try { process.kill(-owned.pid, signal); } catch {}
    };
    if (this.startPromise && owned) stopOwnedGroup("SIGTERM");
    try {
      await this.startPromise;
    } catch {
      // A failed launch still needs any spawned process cleaned up.
    }
    const child = this.child;
    if (!child) { stopOwnedGroup("SIGKILL"); return; }
    try {
      await this.sendCommand("Browser.close", {}, undefined, 1_000);
    } catch {
      // A process with a broken pipe still needs to be terminated.
    }
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(1_500),
      ]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(2_000),
      ]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    stopOwnedGroup("SIGKILL");
  }

  private async listTargets(): Promise<BackgroundBrowserTarget[]> {
    const result = await this.browserCall<{
      targetInfos?: Array<{
        targetId: string;
        title: string;
        url: string;
        type: string;
      }>;
    }>("Target.getTargets");
    return (result.targetInfos ?? []).map((target) => ({
      id: target.targetId,
      title: target.title,
      url: target.url,
      type: target.type,
    }));
  }

  private async currentTarget(): Promise<
    BackgroundBrowserTarget
  > {
    const targets = await this.listTargets();

    if (this.currentTargetId) {
      const existing = targets.find(
        (target) =>
          target.id === this.currentTargetId
          && target.type === "page",
      );
      if (existing) return existing;
    }

    const page =
      targets.find(
        (target) =>
          target.type === "page"
          && target.url !== "about:blank",
      )
      ?? targets.find((target) => target.type === "page");

    if (!page) {
      const created = await this.createTarget("about:blank");
      this.currentTargetId = created.id;
      return created;
    }

    this.currentTargetId = page.id;
    return page;
  }

  private async createTarget(
    url: string,
  ): Promise<BackgroundBrowserTarget> {
    const result = await this.browserCall<{ targetId: string }>(
      "Target.createTarget",
      { url },
    );
    return await this.refreshTarget(result.targetId);
  }

  private async refreshTarget(
    id: string,
  ): Promise<BackgroundBrowserTarget> {
    const targets = await this.listTargets();
    const target = targets.find(
      (candidate) => candidate.id === id,
    );
    if (!target) {
      throw new Error(
        "Background Brave tab disappeared",
      );
    }
    this.currentTargetId = target.id;
    return target;
  }

  private async waitForReady(
    target: BackgroundBrowserTarget,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const state = await this.cdpCall<{
          result?: {
            value?: string;
          };
        }>(
          target,
          "Runtime.evaluate",
          {
            expression: "document.readyState",
            returnByValue: true,
          },
        );
        if (
          state.result?.value === "complete"
          || state.result?.value === "interactive"
        ) {
          return;
        }
      } catch {
        // Retry while navigation swaps the renderer.
      }
      await delay(100);
    }
  }

  private async cdpCall<T = Record<string, unknown>>(
    target: BackgroundBrowserTarget,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const attached = await this.browserCall<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: target.id, flatten: true },
    );
    try {
      return await this.sendCommand<T>(method, params, attached.sessionId);
    } finally {
      try {
        await this.sendCommand("Target.detachFromTarget", {
          sessionId: attached.sessionId,
        });
      } catch {
        // The page or browser may have closed during the command.
      }
    }
  }

  private modifierMask(
    modifiers: string[],
  ): number {
    let mask = 0;
    for (const modifier of modifiers) {
      switch (modifier.toLowerCase()) {
        case "option":
        case "alt":
          mask |= 1;
          break;
        case "control":
        case "ctrl":
          mask |= 2;
          break;
        case "command":
        case "cmd":
          mask |= 4;
          break;
        case "shift":
          mask |= 8;
          break;
      }
    }
    return mask;
  }

  private normalizeKey(
    key: string,
  ): {
    key: string;
    code: string;
    windowsVirtualKeyCode: number;
  } {
    const normalized = key.toLowerCase();
    const special: Record<
      string,
      {
        key: string;
        code: string;
        windowsVirtualKeyCode: number;
      }
    > = {
      enter: {
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      },
      return: {
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      },
      tab: {
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      },
      escape: {
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      },
      backspace: {
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      },
      delete: {
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      },
      arrowup: {
        key: "ArrowUp",
        code: "ArrowUp",
        windowsVirtualKeyCode: 38,
      },
      up: {
        key: "ArrowUp",
        code: "ArrowUp",
        windowsVirtualKeyCode: 38,
      },
      arrowdown: {
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 40,
      },
      down: {
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 40,
      },
      arrowleft: {
        key: "ArrowLeft",
        code: "ArrowLeft",
        windowsVirtualKeyCode: 37,
      },
      left: {
        key: "ArrowLeft",
        code: "ArrowLeft",
        windowsVirtualKeyCode: 37,
      },
      arrowright: {
        key: "ArrowRight",
        code: "ArrowRight",
        windowsVirtualKeyCode: 39,
      },
      right: {
        key: "ArrowRight",
        code: "ArrowRight",
        windowsVirtualKeyCode: 39,
      },
      space: {
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
      },
    };

    const mapped = special[normalized];
    if (mapped) return mapped;

    if (key.length === 1) {
      const upper = key.toUpperCase();
      const virtualKey = upper.charCodeAt(0);
      return {
        key,
        code:
          /[a-z]/i.test(key)
            ? `Key${upper}`
            : /[0-9]/.test(key)
              ? `Digit${key}`
              : key,
        windowsVirtualKeyCode: virtualKey,
      };
    }

    throw new Error(
      `Unsupported background browser key: ${key}`,
    );
  }
}

export class BackgroundBrowserPool {
  private readonly controllers = new Map<
    string,
    BackgroundBrowserController
  >();

  constructor(
    private readonly dataDir: string,
    private readonly options: { executablePath?: string } = {},
  ) {}

  forChat(chatId: string): BackgroundBrowserController {
    if (!chatId.trim()) throw new Error("Browser chat identity is required");
    const existing = this.controllers.get(chatId);
    if (existing) return existing;
    const hash = createHash("sha256").update(chatId).digest("hex");
    const controller = new BackgroundBrowserController(this.dataDir, {
      profileDir: join(this.dataDir, "chat-browsers", hash),
      ...this.options,
    });
    this.controllers.set(chatId, controller);
    return controller;
  }

  async releaseChat(chatId: string): Promise<void> {
    const controller = this.controllers.get(chatId);
    this.controllers.delete(chatId);
    await controller?.close();
  }

  async closeAll(): Promise<void> {
    const controllers = [...this.controllers.values()];
    this.controllers.clear();
    await Promise.all(controllers.map((controller) => controller.close()));
  }
}
