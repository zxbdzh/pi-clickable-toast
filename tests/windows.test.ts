import assert from "node:assert/strict";
import test from "node:test";
import type { Origin } from "../core.ts";
import {
  ToastController,
  captureTerminalWindowHandle,
  focusOrigin,
  withoutHerdrEnv,
  type ExecFileLike,
  type NotifierLike,
} from "../windows.ts";

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
    // herdr-focus 返回 Herdr 所在 WT 窗口句柄
    if (args.includes("herdr-focus")) return { stdout: "42015824", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const spawned: Call[] = [];

  const result = await focusOrigin(herdrOrigin, run, (file, args) => { spawned.push({ file, args }); });

  assert.deepEqual(result, { ok: true, method: "herdr" });
  assert.deepEqual(calls[0].args.slice(-4), ["-Action", "herdr-focus", "-Value", "1"]);
  assert.deepEqual(calls[1], { file: "herdr.exe", args: ["agent", "focus", "w4:p12"] });
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

  assert.deepEqual(result, { ok: true, method: "herdr", attached: true });
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
