import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import notifier from "node-notifier";
import type { Origin } from "./core.ts";

export interface NotifierLike {
  notify(
    options: Record<string, unknown>,
    callback?: (error: Error | null, response?: string, metadata?: Record<string, unknown>) => void,
  ): unknown;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; windowsHide?: boolean; encoding?: BufferEncoding },
) => Promise<{ stdout: string; stderr: string }>;

function systemExecFile(
  file: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean; encoding?: BufferEncoding } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

const POWERSHELL = "powershell.exe";
const WINDOW_HELPER = fileURLToPath(new URL("./window.ps1", import.meta.url));
const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  WINDOW_HELPER,
] as const;

function numeric(value: string | number): string {
  const result = String(value);
  if (!/^\d+$/.test(result)) throw new Error(`Expected an unsigned integer, got: ${result}`);
  return result;
}

export async function captureTerminalWindowHandle(
  pid = process.pid,
  run: ExecFileLike = systemExecFile,
  fallbackPid = process.ppid,
): Promise<string | undefined> {
  const candidates = [...new Set([pid, fallbackPid].filter((value) => value > 0))];
  for (const candidate of candidates) {
    try {
      const { stdout } = await run(
        POWERSHELL,
        [...POWERSHELL_ARGS, "-Action", "capture", "-Value", numeric(candidate)],
        { timeout: 5_000, windowsHide: true, encoding: "utf8" },
      );
      const value = stdout.trim();
      if (/^\d+$/.test(value) && value !== "0") return value;
    } catch {
      // A just-started process may not be visible to CIM yet; try its parent.
    }
  }
  return undefined;
}

export async function isWindowForeground(
  hwnd: string | undefined,
  run: ExecFileLike = systemExecFile,
): Promise<boolean> {
  if (!hwnd) return false;
  try {
    const { stdout } = await run(
      POWERSHELL,
      [...POWERSHELL_ARGS, "-Action", "foreground", "-Value", numeric(hwnd)],
      { timeout: 5_000, windowsHide: true, encoding: "utf8" },
    );
    return stdout.trim() === "True";
  } catch {
    return false;
  }
}

async function focusWindow(hwnd: string, run: ExecFileLike): Promise<void> {
  await run(
    POWERSHELL,
    [...POWERSHELL_ARGS, "-Action", "focus", "-Value", numeric(hwnd)],
    { timeout: 5_000, windowsHide: true, encoding: "utf8" },
  );
}

export interface FocusResult {
  ok: boolean;
  method?: "herdr" | "window";
  degraded?: boolean;
  attached?: boolean;
  error?: string;
}

export type SpawnDetachedLike = (file: string, args: readonly string[]) => void;

/**
 * 去掉所有 HERDR_* 环境变量。pi 跑在 Herdr pane 里时子进程会继承它们，
 * herdr 据此判定“嵌套”并拒绝 attach（error: nested herdr is disabled by default）。
 */
export function withoutHerdrEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("HERDR_")));
}

/** 默认实现：真实开新终端。测试必须注入假实现，否则每跑一次就弹一个窗口。 */
function systemSpawnDetached(file: string, args: readonly string[]): void {
  const child = spawn(file, [...args], {
    stdio: "ignore",
    detached: true,
    windowsHide: false,
    env: withoutHerdrEnv(),
  });
  child.unref();
}

export async function focusOrigin(
  origin: Origin,
  run: ExecFileLike = systemExecFile,
  spawnDetached: SpawnDetachedLike = systemSpawnDetached,
): Promise<FocusResult> {
  let herdrError: string | undefined;
  if (origin.herdrPaneId) {
    // Herdr 界面是独立的客户端进程，不在 pi 的父进程链上，所以由脚本直接查找它所在的
    // Windows Terminal 窗口（必要时切到对应 tab）并前置，再切 Herdr 内部焦点并标记已看。
    let hostFocused = false;
    try {
      const { stdout } = await run(
        POWERSHELL,
        [...POWERSHELL_ARGS, "-Action", "herdr-focus", "-Value", "1"],
        { timeout: 10_000, windowsHide: true, encoding: "utf8" },
      );
      hostFocused = /^[0-9]+$/.test(stdout.trim());
    } catch {
      // 找不到界面客户端（Herdr 在后台运行、没有任何终端显示它）→ 走 attach 兜底
    }
    try {
      await run("herdr.exe", ["agent", "focus", origin.herdrPaneId], {
        timeout: 5_000,
        windowsHide: true,
        encoding: "utf8",
      });
    } catch (error) {
      herdrError = error instanceof Error ? error.message : String(error);
    }
    if (hostFocused && herdrError === undefined) {
      return { ok: true, method: "herdr" };
    }
    // 没有可前置的界面窗口或 focus 失败：新开窗口 attach 常驻 session。
    // ponytail: 必须用 spawn detached 而非 execFile —— start 打开的 cmd /k 是常驻进程，
    // execFile 等它退出会永远阻塞（5s 超时后报错，点击看起来就是“没反应”）。
    try {
      spawnDetached("cmd.exe", ["/c", "start", "", "cmd.exe", "/k", "herdr", "session", "attach", "default"]);
      return {
        ok: true,
        method: "herdr",
        attached: true,
        ...(herdrError ? { degraded: true, error: herdrError } : {}),
      };
    } catch (error) {
      const attachError = error instanceof Error ? error.message : String(error);
      return { ok: false, error: [herdrError, attachError].filter(Boolean).join("; ") };
    }
  }

  if (origin.hwnd) {
    try {
      await focusWindow(origin.hwnd, run);
      return {
        ok: true,
        method: "window",
        ...(herdrError ? { degraded: true, error: herdrError } : {}),
      };
    } catch (error) {
      const windowError = error instanceof Error ? error.message : String(error);
      return { ok: false, error: [herdrError, windowError].filter(Boolean).join("; ") };
    }
  }

  return { ok: false, error: herdrError ?? "No terminal window handle was captured" };
}

function activated(response: unknown, metadata: unknown): boolean {
  const direct = typeof response === "string" ? response.toLowerCase() : "";
  const meta = metadata !== null && typeof metadata === "object"
    ? String((metadata as Record<string, unknown>).activationType ?? "").toLowerCase()
    : "";
  return direct === "activate" || direct === "click" || meta === "activate" || meta === "click";
}

export class ToastController {
  private generation = 0;
  private closed = false;
  private readonly id: string;
  private readonly onActivate: () => void | Promise<void>;
  private readonly onError: (error: Error) => void;
  private readonly client: NotifierLike;

  constructor(
    id: string,
    onActivate: () => void | Promise<void>,
    onError: (error: Error) => void,
    client: NotifierLike = notifier as unknown as NotifierLike,
  ) {
    this.id = id;
    this.onActivate = onActivate;
    this.onError = onError;
    this.client = client;
  }

  show(title: string, message: string, appID?: string): void {
    if (this.closed) return;
    const generation = ++this.generation;
    this.client.notify(
      {
        title,
        message,
        id: this.id,
        ...(appID ? { appID } : {}),
      },
      (error, response, metadata) => {
        if (this.closed || generation !== this.generation) return;
        if (error) {
          this.onError(error);
          return;
        }
        if (activated(response, metadata)) void this.onActivate();
      },
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    // ponytail: node-notifier 的 Windows toaster 不支持 remove（会抛
    // "Message or ID to close is required."），toast 靠系统自动过期；
    // 真正需要主动清除时再换 WinRT ToastNotifier.Hide。
  }
}
