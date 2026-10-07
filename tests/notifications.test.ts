import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { buildNativeHelper, NativeToast } from "../windows.ts";

test("settled replies and errors notify even when a background server never exits", async (t) => {
  // 走真实扩展事件链；只替换 Windows 显示出口，配置写到隔离目录。
  const home = mkdtempSync(join(tmpdir(), "clickable-toast-test-"));
  const keys = ["USERPROFILE", "HERDR_ENV", "HERDR_PANE_ID"];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(home, { recursive: true, force: true });
  });
  process.env.USERPROFILE = home;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "test:p1";
  for (const [file, config] of [
    [".pi/agent/clickable-toast.json", { enabled: true, projectIcon: false }],
    [".unipi/config/notify/config.json", {
      defaultPlatforms: ["native"],
      events: { agent_settled: { enabled: true } },
      native: { windowsAppId: "Pi.ToastTest" },
    }],
  ] as const) {
    const target = join(home, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(config));
  }
  await buildNativeHelper();
  const shown: Array<{ title: string; message: string }> = [];
  t.mock.method(NativeToast.prototype, "show", (title: string, message: string) => {
    shown.push({ title, message });
    return true;
  });
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const listeners = new Map<string, (value: any) => void>();
  let tasks = [{ status: "running", notifyOnCompletion: true, triggerOnCompletion: true }];
  const { default: clickableToast } = await import("../index.ts");
  clickableToast({
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand() {},
    events: {
      on(channel: string, handler: (value: any) => void) {
        listeners.set(channel, handler);
        return () => { listeners.delete(channel); };
      },
      emit(_channel: string, request: any) {
        queueMicrotask(() => listeners.get("pi-background-tasks:response:v1")?.({
          request_id: request.request_id, ok: true, result: { tasks },
        }));
      },
    },
  } as any);
  handlers.get("session_start")?.({}, {
    mode: "tui", cwd: home, ui: { onTerminalInput: () => () => {}, notify() {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  async function finish(stopReason: string, text: string) {
    handlers.get("agent_start")?.();
    handlers.get("agent_end")?.({ messages: [{
      role: "assistant", stopReason, errorMessage: text, content: [{ type: "text", text }],
    }] });
    handlers.get("agent_settled")?.();
    await setImmediate();
  }
  try {
    await finish("stop", "Preview is ready");
    assert.deepEqual(shown.at(-1), { title: "Pi — Reply Ready", message: "Preview is ready" });
    await finish("error", "Connection failed");
    assert.deepEqual(shown.at(-1), { title: "Pi — Agent Failed", message: "Connection failed" });
    tasks = [];
    await finish("stop", "All checks passed");
    assert.deepEqual(shown.at(-1), { title: "Pi — Agent Complete", message: "All checks passed" });
    assert.equal(shown.length, 3);
  } finally {
    handlers.get("session_shutdown")?.();
  }
});
