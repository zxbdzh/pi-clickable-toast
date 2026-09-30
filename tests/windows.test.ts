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
    // 首次是前置宿主窗口（ConPTY hwnd 已在 origin 上），随后 herdr focus
    if (file === "powershell.exe") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const origin: Origin = { cwd: "C:/work/demo", project: "demo", herdrPaneId: "w4:p12", hwnd: "99" };

  assert.deepEqual(await focusOrigin(origin, run), { ok: true, method: "herdr" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(-4), ["-Action", "focus", "-Value", "99"]);
  assert.deepEqual(calls[1], { file: "herdr.exe", args: ["agent", "focus", "w4:p12"] });
});

test("falls back to the captured terminal window if Herdr focus fails", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    if (file === "herdr.exe") throw new Error("pane unavailable");
    // attach 兜底（cmd start）后返回 ok
    if (file === "cmd.exe") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const origin: Origin = { cwd: "C:/work/demo", project: "demo", herdrPaneId: "w4:p12", hwnd: "1234" };

  const result = await focusOrigin(origin, run);
  assert.equal(result.ok, true);
  assert.equal(result.method, "herdr"); // attach 兑底成功即视为 herdr 路径成功
  assert.equal(calls[0].file, "powershell.exe"); // 前置尝试
  assert.equal(calls[1].file, "herdr.exe"); // agent focus（失败）
  assert.equal(calls[2].file, "cmd.exe"); // attach 兑底
  assert.deepEqual(calls[2].args, ["/c", "start", "", "cmd.exe", "/k", "herdr", "session", "attach", "default"]);
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
