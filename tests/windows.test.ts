import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import type { Origin } from "../core.ts";
import {
  ToastController,
  buildNativeHelper,
  captureTerminalWindowHandle,
  focusOrigin,
  helperCommand,
  parseHerdrFocusOutput,
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
