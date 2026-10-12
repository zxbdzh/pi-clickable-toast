import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { buildNativeHelper, NativeToast } from "../windows.ts";

test("completion toasts wait for a genuinely idle reply, including auto-continuations", async (t) => {
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
      events: { agent_settled: { enabled: true }, ask_user_prompt: { enabled: true } },
      native: { windowsAppId: "Pi.ToastTest" },
      renotify: { enabled: false },
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
  let holdStatus = false;
  let heldRequest: any;
  let idle = true;
  let queued = false;
  const statusResponse = (request: any) => listeners.get("pi-background-tasks:response:v1")?.({
    request_id: request.request_id, ok: true, result: { tasks },
  });
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
        if (holdStatus) heldRequest = request;
        else queueMicrotask(() => statusResponse(request));
      },
    },
  } as any);
  const ctx = {
    mode: "tui", cwd: home, ui: { onTerminalInput: () => () => {}, notify() {} },
    isIdle: () => idle, hasPendingMessages: () => queued,
  };
  handlers.get("session_start")?.({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const start = () => {
    idle = false;
    handlers.get("agent_start")?.({}, ctx);
  };
  const end = (stopReason: string, text: string) => {
    handlers.get("agent_end")?.({ messages: [{
      role: "assistant", stopReason, errorMessage: text, content: [{ type: "text", text }],
    }] }, ctx);
    idle = true;
    handlers.get("agent_settled")?.({}, ctx);
  };
  const settle = async () => {
    t.mock.timers.tick(500);
    await setImmediate();
  };
  t.beforeEach(() => {
    start();
    shown.length = 0;
    holdStatus = false;
    heldRequest = undefined;
    queued = false;
  });
  try {
    await t.test("auto-continued intermediate replies never show a completion toast", async () => {
      for (let i = 0; i < 3; i++) {
        start();
        end("stop", `Intermediate step ${i}`);
        // pi-goal-x 在 agent_settled 后用 0/50ms 定时器继续；不是最终交付。
        setTimeout(start, 50);
        await settle();
      }
      assert.deepEqual(shown, []);
      tasks = [];
      end("stop", "Goal actually finished");
      await settle();
      assert.deepEqual(shown, [{ title: "Pi — Agent Complete", message: "Goal actually finished" }]);
      shown.length = 0;
    });
    await t.test("settled replies and errors notify even when a background server never exits", async () => {
      tasks = [{ status: "running", notifyOnCompletion: true, triggerOnCompletion: true }];
      start(); end("stop", "Preview is ready"); await settle();
      assert.deepEqual(shown.at(-1), { title: "Pi — Reply Ready", message: "Preview is ready" });
      start(); end("error", "Connection failed"); await settle();
      assert.deepEqual(shown.at(-1), { title: "Pi — Agent Failed", message: "Connection failed" });
      tasks = [];
      start(); end("stop", "All checks passed"); await settle();
      assert.deepEqual(shown.at(-1), { title: "Pi — Agent Complete", message: "All checks passed" });
      assert.equal(shown.length, 3);
      shown.length = 0;
    });
    await t.test("a new run invalidates a completion while its background status query is in flight", async () => {
      holdStatus = true;
      start(); end("stop", "Stale completed reply"); await settle();
      assert.ok(heldRequest, "completion reached the asynchronous status check");
      start();
      statusResponse(heldRequest);
      await setImmediate();
      assert.deepEqual(shown, []);
      holdStatus = false;
      end("stop", "Newest reply"); await settle();
      assert.deepEqual(shown, [{ title: "Pi — Agent Complete", message: "Newest reply" }]);
      shown.length = 0;
    });
    await t.test("queued work suppresses completion while question prompts remain immediate", async () => {
      start(); end("stop", "Reply with a queued continuation");
      queued = true;
      await settle();
      assert.deepEqual(shown, []);
      idle = false;
      listeners.get("rpiv:ask-user:prompt")?.({ question: "Choose a path?" });
      await setImmediate();
      assert.deepEqual(shown, [{ title: "Pi — Question Asked", message: "Agent asks: Choose a path?" }]);
      queued = false;
    });
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
  }
});
