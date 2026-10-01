import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import notifier from "node-notifier";
import { projectIconSpec, type Origin } from "./core.ts";

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
const HELPER_SOURCE = fileURLToPath(new URL("./focus.cs", import.meta.url));
const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  WINDOW_HELPER,
] as const;

export interface HelperCommand {
  file: string;
  args: string[];
  native: boolean;
}

let cachedExePath: string | null | undefined;

/** exe 按 focus.cs 内容哈希命名，源码一变就自动重新编译，不会用到过期的二进制。 */
function nativeHelperPath(): string | undefined {
  if (cachedExePath === undefined) {
    try {
      const hash = createHash("sha256").update(readFileSync(HELPER_SOURCE)).digest("hex").slice(0, 12);
      cachedExePath = join(tmpdir(), "pi-clickable-toast", `PiToastFocus-${hash}.exe`);
    } catch {
      cachedExePath = null;
    }
  }
  return cachedExePath ?? undefined;
}

/**
 * 热路径优先用原生 exe（启动几十毫秒），尚未编译或编译失败时回退到 PowerShell 脚本
 * （启动 + JIT 预热每次 1.1~1.8 秒）。两者命令行约定一致：-Action <名称> -Value <数字>。
 */
export function helperCommand(exists: (path: string) => boolean = existsSync): HelperCommand {
  const exe = nativeHelperPath();
  if (exe && exists(exe)) return { file: exe, args: [], native: true };
  return { file: POWERSHELL, args: [...POWERSHELL_ARGS], native: false };
}

let buildInFlight: Promise<boolean> | undefined;

/** 后台编译 focus.cs；成功后 helperCommand 自动改用 exe。失败则一直走 PowerShell 版。 */
export function buildNativeHelper(): Promise<boolean> {
  buildInFlight ??= (async () => {
    const exe = nativeHelperPath();
    if (!exe) return false;
    if (existsSync(exe)) return true;
    const windir = process.env.windir ?? "C:\\Windows";
    const framework = ["Framework64", "Framework"]
      .map((dir) => join(windir, "Microsoft.NET", dir, "v4.0.30319"))
      .find((dir) => existsSync(join(dir, "csc.exe")));
    if (!framework) return false;
    const wpf = join(framework, "WPF");
    const tmp = `${exe}.${process.pid}.tmp`;
    try {
      mkdirSync(join(tmpdir(), "pi-clickable-toast"), { recursive: true });
      await systemExecFile(
        join(framework, "csc.exe"),
        [
          "-nologo",
          "-optimize+",
          "-target:exe",
          `-out:${tmp}`,
          `-r:${join(framework, "System.Drawing.dll")}`,
          `-r:${join(wpf, "UIAutomationClient.dll")}`,
          `-r:${join(wpf, "UIAutomationTypes.dll")}`,
          `-r:${join(wpf, "WindowsBase.dll")}`,
          HELPER_SOURCE,
        ],
        { timeout: 60_000, windowsHide: true },
      );
      renameSync(tmp, exe);
      return true;
    } catch {
      rmSync(tmp, { force: true });
      // 另一个 pi 进程可能已经编译并占用了目标文件
      return existsSync(exe);
    }
  })();
  return buildInFlight;
}

function helperInvocation(action: string, value: string | number): { file: string; args: string[] } {
  const helper = helperCommand();
  return { file: helper.file, args: [...helper.args, "-Action", action, "-Value", numeric(value)] };
}

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
      const call = helperInvocation("capture", candidate);
      const { stdout } = await run(call.file, call.args, { timeout: 5_000, windowsHide: true, encoding: "utf8" });
      const value = stdout.trim();
      if (/^\d+$/.test(value) && value !== "0") return value;
    } catch {
      // A just-started process may not be visible yet; try its parent.
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
    const call = helperInvocation("foreground", hwnd);
    const { stdout } = await run(call.file, call.args, { timeout: 5_000, windowsHide: true, encoding: "utf8" });
    return stdout.trim() === "True";
  } catch {
    return false;
  }
}

async function focusWindow(hwnd: string, run: ExecFileLike): Promise<void> {
  const call = helperInvocation("focus", hwnd);
  await run(call.file, call.args, { timeout: 5_000, windowsHide: true, encoding: "utf8" });
}

export interface FocusResult {
  ok: boolean;
  method?: "herdr" | "window";
  degraded?: boolean;
  attached?: boolean;
  /** 前置终端窗口用的方法（already/alt/attach/switch），仅用于调试日志。 */
  hostVia?: string;
  /** Herdr 所在 tab 的切换结果（already/selected/notfound/failed）。 */
  hostTab?: string;
  hostError?: string;
  error?: string;
}

/** 解析 herdr-focus 的输出：`<hwnd> via=<方法> tab=<状态>`，后两段可缺省。 */
export function parseHerdrFocusOutput(stdout: string): { hwnd: string; via?: string; tab?: string } | undefined {
  const match = /^([0-9]+)(?:\s+via=(\S+))?(?:\s+tab=(\S+))?/.exec(stdout.trim());
  if (!match || match[1] === "0") return undefined;
  return {
    hwnd: match[1],
    ...(match[2] ? { via: match[2] } : {}),
    ...(match[3] ? { tab: match[3] } : {}),
  };
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
    // Herdr 界面是独立的客户端进程，不在 pi 的父进程链上，所以由辅助程序直接查找它所在的
    // Windows Terminal 窗口（必要时切到对应 tab）并前置；同时切 Herdr 内部焦点并标记已看。
    // 两件事互不依赖，并行执行以缩短点击后的等待。
    const call = helperInvocation("herdr-focus", 1);
    const [host, focusError] = await Promise.all([
      run(call.file, call.args, { timeout: 10_000, windowsHide: true, encoding: "utf8" }).then(
        ({ stdout }) => ({ parsed: parseHerdrFocusOutput(stdout), error: undefined as string | undefined }),
        // 找不到界面客户端或前台被系统拒绝；记录原因，再走 attach 兜底
        (error: unknown) => ({
          parsed: undefined,
          error: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 240),
        }),
      ),
      run("herdr.exe", ["agent", "focus", origin.herdrPaneId], {
        timeout: 5_000,
        windowsHide: true,
        encoding: "utf8",
      }).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    ]);
    const hostError = host.error;
    herdrError = focusError;
    if (host.parsed && herdrError === undefined) {
      return {
        ok: true,
        method: "herdr",
        ...(host.parsed.via ? { hostVia: host.parsed.via } : {}),
        ...(host.parsed.tab ? { hostTab: host.parsed.tab } : {}),
      };
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
        ...(hostError ? { hostError } : {}),
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

/** ensureProjectIcon 的可注入依赖，单测用它们避免真正编译/绘制。 */
export interface IconDeps {
  run?: ExecFileLike;
  exists?: (path: string) => boolean;
  /** 返回原生辅助程序 exe 的路径（必要时先编译），不可用时返回 undefined。 */
  helper?: () => Promise<string | undefined>;
  dir?: string;
}

const iconInFlight = new Map<string, Promise<string | undefined>>();

/**
 * 按项目名生成 toast 大图（首字母 + 固定颜色），写到 %TEMP% 下并缓存。文件名只由文字和颜色决定，
 * 所以不同项目如果算出同样的结果会共用一个文件。原生辅助程序不可用或绘制失败时返回 undefined，
 * 调用方回退到自带图标。
 */
export function ensureProjectIcon(project: string, deps: IconDeps = {}): Promise<string | undefined> {
  const spec = projectIconSpec(project);
  const dir = deps.dir ?? join(tmpdir(), "pi-clickable-toast", "icons");
  const codePoints = Array.from(spec.letter).map((ch) => ch.codePointAt(0)?.toString(16)).join("-");
  const target = join(dir, `${codePoints}-${spec.color}.png`);
  const exists = deps.exists ?? existsSync;
  if (exists(target)) return Promise.resolve(target);

  const key = `${target}`;
  const pending = iconInFlight.get(key);
  if (pending) return pending;
  const job = (async () => {
    try {
      const exe = await (deps.helper ?? (async () => ((await buildNativeHelper()) ? nativeHelperPath() : undefined)))();
      if (!exe) return undefined;
      mkdirSync(dir, { recursive: true });
      await (deps.run ?? systemExecFile)(
        exe,
        ["-Action", "icon", "-Text", spec.letter, "-Color", spec.color, "-Out", target],
        { timeout: 10_000, windowsHide: true },
      );
      return exists(target) ? target : undefined;
    } catch {
      return undefined;
    } finally {
      iconInFlight.delete(key);
    }
  })();
  iconInFlight.set(key, job);
  return job;
}

export interface ToastAppearance {
  /** Windows 应用标识（AUMID），决定 toast 左上角的应用名和小图标。 */
  appID?: string;
  /** toast 正文左侧的大图。 */
  icon?: string;
}

/** 扩展自带的默认图标。 */
export const DEFAULT_ICON = fileURLToPath(new URL("./assets/icon.png", import.meta.url));

/** 我们自己的应用标识，避免继续用 SnoreToast 的默认身份（名字就是 SnoreToast）。 */
export const TOAST_APP_ID = "Pi.ClickableToast";

export interface ToastApp {
  id: string;
  name: string;
  icon: string;
}

/**
 * 在当前用户的注册表里登记应用标识（HKCU，不需要管理员权限）。Windows 按它查 toast 左上角的
 * 名字和图标，不再需要开始菜单快捷方式。返回 false 时调用方必须回退到默认身份，
 * 否则用了没登记的标识 toast 会直接不显示。
 */
export async function registerToastApp(app: ToastApp, run: ExecFileLike = systemExecFile): Promise<boolean> {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${app.id}`;
  const values: Array<[string, string]> = [
    ["DisplayName", app.name],
    ["IconUri", app.icon],
  ];
  try {
    await Promise.all(
      values.map(([name, data]) =>
        run("reg.exe", ["add", key, "/v", name, "/t", "REG_SZ", "/d", data, "/f"], {
          timeout: 5_000,
          windowsHide: true,
        }),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

export class ToastController {
  private generation = 0;
  private closed = false;
  private readonly id: string;
  private readonly onActivate: () => void | Promise<void>;
  private readonly onError: (error: Error) => void;
  private readonly client: NotifierLike;
  private readonly onEvent?: (response?: string, metadata?: Record<string, unknown>) => void;

  constructor(
    id: string,
    onActivate: () => void | Promise<void>,
    onError: (error: Error) => void,
    client: NotifierLike = notifier as unknown as NotifierLike,
    onEvent?: (response?: string, metadata?: Record<string, unknown>) => void,
  ) {
    this.id = id;
    this.onActivate = onActivate;
    this.onError = onError;
    this.client = client;
    this.onEvent = onEvent;
  }

  show(title: string, message: string, appearance: ToastAppearance = {}): void {
    if (this.closed) return;
    const generation = ++this.generation;
    this.client.notify(
      {
        title,
        message,
        id: this.id,
        ...(appearance.appID ? { appID: appearance.appID } : {}),
        ...(appearance.icon ? { icon: appearance.icon } : {}),
      },
      (error, response, metadata) => {
        if (this.closed || generation !== this.generation) return;
        if (error) {
          this.onError(error);
          return;
        }
        this.onEvent?.(response, metadata);
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
