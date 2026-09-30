import { execFile } from "node:child_process";
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

/**
 * 解析 herdr TUI 宿主的可聚焦窗口句柄。
 *
 * herdr TUI 跑在 pwsh 里，没有顶层窗口，但它的 ConPTY 子窗口
 * （class=PseudoConsoleWindow）可以被 SetForegroundWindow 前置，
 * 效果是把宿主终端切到 herdr 所在 tab。探索顺序：
 * 1. 从 HERDR_TUI_PID 环境变量读（由用户或 herdr 集成注入）
 * 2. 沿当前进程链向上找（herdr 里直接跑 pi 的场景）
 */
export async function captureHerdrHostHandle(
  run: ExecFileLike = systemExecFile,
): Promise<string | undefined> {
  const explicit = process.env.HERDR_TUI_PID;
  const candidates = explicit && /^\d+$/.test(explicit)
    ? [Number(explicit)]
    : [process.pid, process.ppid].filter((value) => value > 0);
  for (const candidate of candidates) {
    try {
      const { stdout } = await run(
        POWERSHELL,
        [...POWERSHELL_ARGS, "-Action", "console", "-Value", numeric(candidate)],
        { timeout: 5_000, windowsHide: true, encoding: "utf8" },
      );
      const value = stdout.trim();
      if (/^\d+$/.test(value) && value !== "0") return value;
    } catch {
      // AttachConsole fails for dead/non-console pids; try next candidate.
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
  error?: string;
}

export async function focusOrigin(
  origin: Origin,
  run: ExecFileLike = systemExecFile,
): Promise<FocusResult> {
  let herdrError: string | undefined;
  if (origin.herdrPaneId) {
    // 先前置宿主终端（ConPTY owner 即 WT 主窗口，能把窗口提到前台），
    // 再切 Herdr 内部焦点并标记已看。宿主可能是隐藏的 detached TUI：
    // 此时 owner 前置后用户看到的仍不是 herdr，因此再开一个新 tab attach
    // 兜底，保证点击后 herdr TUI 一定可见。
    if (!origin.hwnd) {
      try {
        origin.hwnd = await captureHerdrHostHandle(run);
      } catch {
        // fall through to herdr-only focus
      }
    }
    if (origin.hwnd) {
      try {
        await focusWindow(origin.hwnd, run);
      } catch {
        // Host window focus is best-effort; herdr focus still marks seen.
      }
    }
    try {
      await run("herdr.exe", ["agent", "focus", origin.herdrPaneId], {
        timeout: 5_000,
        windowsHide: true,
        encoding: "utf8",
      });
      return { ok: true, method: "herdr" };
    } catch (error) {
      herdrError = error instanceof Error ? error.message : String(error);
    }
    // herdr agent focus 成功不保证 TUI 可见（detached TUI 或 tab 不在当前窗口）。
    // 新开一个 tab attach 常驻 session，确保用户一定能看到 herdr。
    try {
      await run("cmd.exe", ["/c", "start", "", "cmd.exe", "/k", "herdr", "session", "attach", "default"], {
        timeout: 5_000,
        windowsHide: false,
        encoding: "utf8",
      });
      return { ok: true, method: "herdr" };
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
