import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectIconSpec, type Origin } from "../core.ts";
import {
  ToastController,
  buildNativeHelper,
  captureTerminalWindowHandle,
  ensureProjectIcon,
  focusOrigin,
  helperCommand,
  parseHerdrFocusOutput,
  registerToastApp,
  withoutHerdrEnv,
  type ExecFileLike,
  type NotifierLike,
} from "../windows.ts";

test("parses herdr-focus output in both the old and the new format", () => {
  assert.deepEqual(parseHerdrFocusOutput("42015824\r\n"), { hwnd: "42015824" });
  // 辅助程序现在会附带前置方法和 tab 切换结果；旧正则 /^[0-9]+$/ 会把它误判为失败
  assert.deepEqual(parseHerdrFocusOutput("42015824 via=alt tab=selected\r\n"), {
    hwnd: "42015824",
    via: "alt",
    tab: "selected",
  });
  assert.equal(parseHerdrFocusOutput(""), undefined);
  assert.equal(parseHerdrFocusOutput("0"), undefined);
  assert.equal(parseHerdrFocusOutput("no herdr client window found"), undefined);
});

test("prefers the native helper once it exists and falls back to PowerShell otherwise", () => {
  const native = helperCommand(() => true);
  assert.equal(native.native, true);
  assert.match(native.file, /PiToastFocus-[0-9a-f]{12}\.exe$/);
  assert.deepEqual(native.args, []);

  const fallback = helperCommand(() => false);
  assert.equal(fallback.native, false);
  assert.equal(fallback.file, "powershell.exe");
  assert.ok(fallback.args.includes("-File"));
});

test("focus.cs compiles with the in-box csc and the exe answers harmless queries", async () => {
  assert.equal(await buildNativeHelper(), true, "csc build failed");
  const helper = helperCommand();
  assert.equal(helper.native, true);
  assert.ok(existsSync(helper.file));
  // 只跑不会改变前台窗口的动作：未知动作、缺参数、不存在的窗口句柄
  const exit = (args: string[]): number => {
    try {
      execFileSync(helper.file, args, { stdio: "ignore" });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  };
  assert.equal(exit([]), 1);
  assert.equal(exit(["-Action", "bogus", "-Value", "1"]), 1);
  assert.equal(exit(["-Action", "foreground", "-Value", "1"]), 0);
});

test("strips HERDR_* so a spawned attach is not treated as nested herdr", () => {
  const env = withoutHerdrEnv({
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w4:p12",
    HERDR_SOCKET_PATH: "C:/x/herdr.sock",
    PATH: "C:/bin",
    USERPROFILE: "C:/Users/1",
  });
  assert.deepEqual(env, { PATH: "C:/bin", USERPROFILE: "C:/Users/1" });
});

test("derives a stable icon spec from the project name", () => {
  assert.deepEqual(projectIconSpec("Huajingflow"), { letter: "H", color: "2F4B93" });
  assert.equal(projectIconSpec("andornot-schedule").letter, "AS");
  assert.equal(projectIconSpec("pi_clickable_toast").letter, "PC");
  assert.equal(projectIconSpec("中文项目").letter, "中");
  assert.equal(projectIconSpec("1").letter, "1");

  // 同名不同大小写、不同分隔符要去同一个颜色（否则同一项目会得到不同图标）
  assert.equal(projectIconSpec("Huajingflow").color, projectIconSpec("huajingflow").color);
  assert.equal(projectIconSpec("pi-clickable-toast").color, projectIconSpec("pi_clickable_toast").color);
  // 不同项目不应该都撞到同一个颜色
  const colors = new Set(["Huajingflow", "huajingweb", "Siftmark", "Chronos", "voxrail"].map((n) => projectIconSpec(n).color));
  assert.ok(colors.size >= 4, `too many colour collisions: ${[...colors].join(",")}`);
  // 颜色必须是 6 位大写十六进制，C# 端按十六进制解析
  for (const name of ["Huajingflow", "中文项目", "1"]) assert.match(projectIconSpec(name).color, /^[0-9A-F]{6}$/);
});

test("generates the project icon once and reuses it when it already exists", async () => {
  const dir = join(tmpdir(), "pi-clickable-toast-test-icons", String(process.pid));
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let onDisk = false;
  const exists = () => onDisk;
  const run: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    onDisk = true; // 辅助程序跑完就写好了文件
    return { stdout: "", stderr: "" };
  };
  const deps = { run, exists, helper: async () => "X:/fake/PiToastFocus.exe", dir };

  const path = await ensureProjectIcon("andornot-schedule", deps);
  assert.ok(path && path.endsWith(".png"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "X:/fake/PiToastFocus.exe");
  assert.deepEqual(calls[0].args.slice(0, 6), ["-Action", "icon", "-Text", "AS", "-Color", projectIconSpec("andornot-schedule").color]);
  assert.equal(calls[0].args.at(-2), "-Out");

  // 文件已存在就不再调用辅助程序（每个项目首次之后都走这条路径）
  assert.equal(await ensureProjectIcon("andornot-schedule", deps), path);
  assert.equal(calls.length, 1);
});

test("falls back to the built-in icon when the helper cannot draw", async () => {
  const deps = {
    run: async () => { throw new Error("exe missing"); },
    exists: () => false,
    helper: async () => "X:/fake/PiToastFocus.exe",
    dir: join(tmpdir(), "pi-clickable-toast-test-icons", "fail"),
  };
  assert.equal(await ensureProjectIcon("demo", deps), undefined);
  assert.equal(await ensureProjectIcon("demo", { ...deps, helper: async () => undefined }), undefined);
});

test("passes the app identity and icon through to the toast", () => {
  const sent: Array<Record<string, unknown>> = [];
  const client: NotifierLike = { notify(options) { sent.push(options); } };
  const controller = new ToastController("toast-1", () => {}, () => {}, client);

  controller.show("t", "m", { appID: "Pi.ClickableToast", icon: "C:/icons/pi.png" });
  controller.show("t2", "m2");

  assert.equal(sent[0].appID, "Pi.ClickableToast");
  assert.equal(sent[0].icon, "C:/icons/pi.png");
  // 不传外观时不能带空字段（空 appID 会让 SnoreToast 报错）
  assert.equal("appID" in sent[1], false);
  assert.equal("icon" in sent[1], false);
});

test("registers the app identity under HKCU with name and icon, without admin rights", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: ExecFileLike = async (file, args) => { calls.push({ file, args }); return { stdout: "", stderr: "" }; };

  const ok = await registerToastApp({ id: "Pi.ClickableToast", name: "Pi", icon: "C:\\x\\icon.png" }, run);

  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, "reg.exe");
    assert.equal(call.args[1], "HKCU\\Software\\Classes\\AppUserModelId\\Pi.ClickableToast");
    assert.ok(call.args.includes("/f"));
  }
  const byName = new Map(calls.map((c) => [c.args[3], c.args[7]]));
  assert.equal(byName.get("DisplayName"), "Pi");
  assert.equal(byName.get("IconUri"), "C:\\x\\icon.png");
});

test("reports failure instead of throwing so callers can fall back to the default identity", async () => {
  const run: ExecFileLike = async () => { throw new Error("access denied"); };
  assert.equal(await registerToastApp({ id: "Pi.ClickableToast", name: "Pi", icon: "C:\\x.png" }, run), false);
});

test("reports every toast callback (including timedout) to onEvent", async () => {
  let captured: ((error: Error | null, response?: string, metadata?: Record<string, unknown>) => void) | undefined;
  const client: NotifierLike = { notify(_options, callback) { captured = callback; } };
  const events: Array<{ response?: string; action?: unknown }> = [];
  let activations = 0;
  const controller = new ToastController(
    "toast-1",
    () => { activations += 1; },
    () => {},
    client,
    (response, metadata) => events.push({ response, action: metadata?.action }),
  );

  controller.show("t", "m");
  captured?.(null, "timeout", { action: "timedout" });

  // 弹窗超时必须可见于日志，但不能触发聚焦
  assert.deepEqual(events, [{ response: "timeout", action: "timedout" }]);
  assert.equal(activations, 0);
});

test("uses one notification id and ignores clicks from replaced toasts", async () => {
  const calls: Array<{
    options: Record<string, unknown>;
    callback?: (error: Error | null, response?: string, metadata?: Record<string, unknown>) => void;
  }> = [];
  const client: NotifierLike = {
    notify(options, callback) {
      calls.push({ options, callback });
    },
  };
  let activations = 0;
  const errors: Error[] = [];
  const controller = new ToastController("session-7", () => { activations += 1; }, (error) => errors.push(error), client);

  controller.show("First", "one");
  controller.show("Second", "two");
  assert.equal(calls[0].options.id, "session-7");
  assert.equal(calls[1].options.id, "session-7");

  calls[0].callback?.(null, "activate");
  calls[1].callback?.(null, "activate");
  await Promise.resolve();
  assert.equal(activations, 1);
  assert.deepEqual(errors, []);

  controller.close();
  assert.equal(calls.length, 2);
});

type Call = { file: string; args: readonly string[] };
const herdrOrigin: Origin = { cwd: "C:/work/demo", project: "demo", herdrPaneId: "w4:p12" };

test("brings the herdr terminal window forward then focuses the exact pane", async () => {
  const calls: Call[] = [];
  const run: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    // herdr-focus 返回 Herdr 所在 WT 窗口句柄、前置方法和 tab 切换结果
    if (args.includes("herdr-focus")) return { stdout: "42015824 via=alt tab=selected", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const spawned: Call[] = [];

  const result = await focusOrigin(herdrOrigin, run, (file, args) => { spawned.push({ file, args }); });

  // 真实输出带 via/tab 后仍必须算成功，不能误走 attach 兑底
  assert.deepEqual(result, { ok: true, method: "herdr", hostVia: "alt", hostTab: "selected" });
  const hostCall = calls.find((c) => c.args.includes("herdr-focus"));
  assert.ok(hostCall);
  assert.deepEqual(hostCall.args.slice(-4), ["-Action", "herdr-focus", "-Value", "1"]);
  assert.deepEqual(calls.find((c) => c.file === "herdr.exe"), { file: "herdr.exe", args: ["agent", "focus", "w4:p12"] });
  assert.equal(spawned.length, 0, "terminal is already open, must not open another window");
});

test("opens an attach window only when no herdr terminal can be found", async () => {
  const run: ExecFileLike = async (file, args) => {
    // 找不到界面客户端：脚本以非零退出
    if (args.includes("herdr-focus")) throw new Error("exit 2");
    return { stdout: "", stderr: "" };
  };
  const spawned: Call[] = [];

  const result = await focusOrigin(herdrOrigin, run, (file, args) => { spawned.push({ file, args }); });

  assert.equal(result.ok, true);
  assert.equal(result.attached, true);
  assert.match(result.hostError ?? "", /exit 2/, "failure reason must be surfaced for the debug log");
  assert.deepEqual(spawned, [{ file: "cmd.exe", args: ["/c", "start", "", "cmd.exe", "/k", "herdr", "session", "attach", "default"] }]);
});

test("falls back to attach when herdr agent focus fails", async () => {
  const run: ExecFileLike = async (file, args) => {
    if (file === "herdr.exe") throw new Error("pane unavailable");
    if (args.includes("herdr-focus")) return { stdout: "42015824", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const spawned: Call[] = [];

  const result = await focusOrigin(herdrOrigin, run, (file, args) => { spawned.push({ file, args }); });

  assert.equal(result.ok, true);
  assert.equal(result.attached, true);
  assert.equal(result.degraded, true);
  assert.equal(spawned.length, 1);
});

test("captures a numeric ancestor window handle", async () => {
  const calls: string[][] = [];
  const run: ExecFileLike = async (_file, args) => {
    calls.push([...args]);
    if (calls.length === 1) throw new Error("CIM registration lag");
    return { stdout: "98765\r\n", stderr: "" };
  };

  assert.equal(await captureTerminalWindowHandle(42, run, 41), "98765");
  assert.deepEqual(calls.map((args) => args.slice(-2)), [
    ["-Value", "42"],
    ["-Value", "41"],
  ]);
});
