import assert from "node:assert/strict";
import test from "node:test";
import type { Origin } from "../core.ts";
import {
  ToastController,
  captureTerminalWindowHandle,
  focusOrigin,
  type ExecFileLike,
  type NotifierLike,
} from "../windows.ts";

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

test("focuses the exact Herdr pane with stable arguments", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    if (args.includes("visible")) return { stdout: "False\r\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const origin: Origin = { cwd: "C:/work/demo", project: "demo", herdrPaneId: "w4:p12", hwnd: "99" };

  // ConPTY 不可见（最常见）→ focus 后新 tab attach 兜底
  assert.deepEqual(await focusOrigin(origin, run), {
    ok: true,
    method: "herdr",
    attached: true,
  });
  assert.equal(calls[0].file, "powershell.exe"); // 前置
  assert.deepEqual(calls[0].args.slice(-4), ["-Action", "focus", "-Value", "99"]);
  assert.equal(calls[1].file, "powershell.exe"); // visible 查询
  assert.deepEqual(calls[2], { file: "herdr.exe", args: ["agent", "focus", "w4:p12"] });
  const attachCall = calls.find((c) => c.file === "cmd.exe");
  assert.ok(attachCall, "invisible ConPTY should trigger attach");
  assert.deepEqual(attachCall.args, ["/c", "start", "", "cmd.exe", "/k", "herdr", "session", "attach", "default"]);
});

test("attaches a new tab when Herdr focus fails even if visible", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    if (file === "herdr.exe") throw new Error("pane unavailable");
    if (args.includes("visible")) return { stdout: "True\r\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const origin: Origin = { cwd: "C:/work/demo", project: "demo", herdrPaneId: "w4:p12", hwnd: "1234" };

  const result = await focusOrigin(origin, run);
  assert.equal(result.ok, true);
  assert.equal(result.method, "herdr");
  assert.equal(result.attached, true); // focus 失败也走 attach 兑底
  assert.equal(calls[0].file, "powershell.exe"); // 前置尝试
  assert.equal(calls[2].file, "herdr.exe"); // agent focus（失败，[1] 是 visible 查询）
  const attachCall = calls.find((c) => c.file === "cmd.exe");
  assert.ok(attachCall, "should attach when herdr focus fails");
  assert.deepEqual(attachCall.args, ["/c", "start", "", "cmd.exe", "/k", "herdr", "session", "attach", "default"]);
});

test("skips attach when the herdr tab is already visible", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    if (args.includes("visible")) return { stdout: "True\r\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const origin: Origin = { cwd: "C:/work/demo", project: "demo", herdrPaneId: "w4:p12", hwnd: "99" };

  assert.deepEqual(await focusOrigin(origin, run), { ok: true, method: "herdr" });
  assert.equal(calls.find((c) => c.file === "cmd.exe"), undefined);
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
