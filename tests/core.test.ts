import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSource,
  autoEventUsesNative,
  buildEventNotification,
  createOrigin,
  hasPendingWakeTask,
  manualRequestUsesNative,
  normalizeClickableConfig,
  normalizeNotifyConfig,
  runOutcome,
  shouldSilenceNative,
  sourceLine,
} from "../core.ts";

test("normalizes config and follows automatic event routing", () => {
  const config = normalizeNotifyConfig({
    defaultPlatforms: ["native"],
    events: {
      agent_end: { enabled: true, platforms: [] },
      agent_settled: { enabled: true, platforms: ["telegram"] },
    },
  });

  assert.equal(autoEventUsesNative(config, "agent_end"), true);
  assert.equal(autoEventUsesNative(config, "agent_settled"), false);
  assert.equal(autoEventUsesNative(config, "permission_request"), false);
});

test("splits native from manual notify_user platforms", () => {
  const config = normalizeNotifyConfig({ defaultPlatforms: ["native", "telegram"] });

  assert.deepEqual(manualRequestUsesNative(config, undefined), {
    usesNative: true,
    requested: ["native", "telegram"],
    remote: ["telegram"],
  });
  assert.deepEqual(manualRequestUsesNative(config, ["gotify"]), {
    usesNative: false,
    requested: ["gotify"],
    remote: ["gotify"],
  });
});

test("recent input silences native except for blocking prompts", () => {
  const config = normalizeNotifyConfig({
    silenceAfterInput: { enabled: true, windowMs: 10_000, platforms: ["native"] },
  });
  const now = 50_000;

  assert.equal(shouldSilenceNative(config, "agent_end", now - 1_000, now), true);
  assert.equal(shouldSilenceNative(config, "agent_end", now - 11_000, now), false);
  assert.equal(shouldSilenceNative(config, "ask_user_prompt", now - 1_000, now), false);
  assert.equal(shouldSilenceNative(config, "permission_request", now - 1_000, now), false);
});

test("builds known event text without importing notify internals", () => {
  assert.deepEqual(buildEventNotification("agent_end", {}, "demo"), {
    title: "Pi — Agent Run Complete",
    message: "demo - Agent run is complete",
  });
  assert.equal(
    buildEventNotification("ask_user_prompt", {
      questions: [{ question: "Choose?", options: [{ label: "A" }, { label: "B" }] }],
    }).message,
    "Agent asks: Choose? — A, B",
  );
});

test("run outcome follows pi's stopReason and picks a readable one-liner", () => {
  // 一次运行：中间有工具调用，只看最后一条 assistant 回复
  const run = (stopReason: string, extra: object = {}) => [
    { role: "user", content: "hi" },
    { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "earlier step" }] },
    { role: "toolResult", content: [] },
    { role: "assistant", stopReason, ...extra },
  ];
  assert.deepEqual(
    runOutcome(run("stop", { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "\n## **已修复这个 403。**\n\n细节" }] })),
    { status: "completed", detail: "已修复这个 403。" },
  );
  assert.deepEqual(runOutcome(run("stop", { content: [] })), { status: "completed" });
  assert.equal(runOutcome(run("stop", { content: [{ type: "text", text: "x".repeat(500) }] })).detail?.length, 200);
  assert.deepEqual(runOutcome(run("aborted")), { status: "aborted" });
  // 工具执行中按 Esc：后续请求立刻失败，记成 error「This operation was aborted」，也算中断
  assert.deepEqual(runOutcome(run("error", { errorMessage: "This operation was aborted" })), { status: "aborted" });
  assert.deepEqual(runOutcome(run("error", { errorMessage: "Request was aborted." })), { status: "aborted" });
  // 工具主动结束本轮：toolUse 那条的开场白不当正文
  assert.deepEqual(runOutcome(run("toolUse", { content: [{ type: "text", text: "我先看看日志" }] })), { status: "completed" });
  assert.deepEqual(
    runOutcome(run("error", { errorMessage: '503 {"error":{"message":"No available accounts: no available accounts","type":"api_error"}' })),
    { status: "error", detail: "503 No available accounts: no available accounts" },
  );
  assert.deepEqual(runOutcome(run("error", { errorMessage: "Connection error." })), { status: "error", detail: "Connection error." });
  assert.deepEqual(runOutcome(run("error")), { status: "error" });
  assert.deepEqual(runOutcome(undefined), { status: "completed" });
});

test("completion notification title and body follow the run outcome", () => {
  assert.deepEqual(buildEventNotification("agent_settled", { status: "completed", detail: "已修复这个 403。" }, "demo"), {
    title: "Pi — Agent Complete",
    message: "demo - 已修复这个 403。",
  });
  assert.deepEqual(buildEventNotification("agent_settled", { status: "error", detail: "503 No available accounts" }), {
    title: "Pi — Agent Failed",
    message: "503 No available accounts",
  });
  assert.deepEqual(buildEventNotification("agent_settled", { status: "error" }), {
    title: "Pi — Agent Failed",
    message: "Agent stopped with an error",
  });
  assert.deepEqual(buildEventNotification("agent_settled", { status: "aborted" }, "demo"), {
    title: "Pi — Agent Stopped",
    message: "demo - Agent stopped before finishing",
  });
  // agent_end 之前没收到（拿不到结果）时保持原来的文字
  assert.deepEqual(buildEventNotification("agent_settled", undefined), {
    title: "Pi — Agent Complete",
    message: "Agent is complete",
  });
});

test("a settled reply stays visible while background work is running", () => {
  assert.deepEqual(buildEventNotification("agent_settled", {
    status: "completed", detail: "预览已经可以打开。", pendingBackground: true,
  }), {
    title: "Pi — Reply Ready",
    message: "预览已经可以打开。",
  });
  assert.deepEqual(buildEventNotification("agent_settled", { status: "completed", pendingBackground: true }), {
    title: "Pi — Reply Ready",
    message: "Agent replied; background tasks are still running",
  });
  // 常驻服务不能把报错或非用户中断的通知吞掉，也不能改成成功标题
  assert.equal(buildEventNotification("agent_settled", { status: "error", pendingBackground: true }).title, "Pi — Agent Failed");
  assert.equal(buildEventNotification("agent_settled", { status: "aborted", pendingBackground: true }).title, "Pi — Agent Stopped");
});

test("source line shows only the project name, never pane or terminal session ids", () => {
  const herdr = createOrigin("C:/work/demo", {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p9",
    WT_SESSION: "{12345678-abcd}",
  });
  // pane id 仍然保留在 origin 上用于聚焦，只是不再显示给用户
  assert.equal(herdr.herdrPaneId, "w1:p9");
  assert.equal(sourceLine(herdr), "demo");
  assert.equal(appendSource("Done", herdr), "Done\n\ndemo");
  assert.equal(sourceLine(createOrigin("C:/work/api", {})), "api");
});

test("clickable config defaults: no source line, project icon on, app name Pi, built-in icon", () => {
  assert.deepEqual(normalizeClickableConfig({}), {
    enabled: true,
    debug: false,
    showSource: false,
    projectIcon: true,
    appName: "Pi",
  });
  assert.deepEqual(normalizeClickableConfig(null), normalizeClickableConfig({}));

  assert.deepEqual(
    normalizeClickableConfig({
      enabled: false,
      debug: true,
      showSource: true,
      projectIcon: false,
      appName: " My Agent ",
      icon: " D:/i.png ",
    }),
    { enabled: false, debug: true, showSource: true, projectIcon: false, appName: "My Agent", icon: "D:/i.png" },
  );
  // 空白字符串不能覆盖默认值
  assert.deepEqual(normalizeClickableConfig({ appName: "  ", icon: "" }), normalizeClickableConfig({}));
});

test("hasPendingWakeTask asks pi-background-tasks over the event bus and only counts running tasks that wake the agent", async () => {
  // 假总线：收到 status 请求后先回一条别人的响应（必须忽略），再异步回本次请求的结果
  const bus = (tasks?: unknown[]) => {
    const listeners = new Map<string, Array<(data: unknown) => void>>();
    const emit = (channel: string, data: unknown): void => {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
      const request = data as { request_id: string; operation: string };
      if (channel !== "pi-background-tasks:request:v1" || !tasks || request.operation !== "status") return;
      emit("pi-background-tasks:response:v1", { request_id: "someone-else", ok: true, result: { tasks: [{ status: "running", triggerOnCompletion: true }] } });
      queueMicrotask(() => emit("pi-background-tasks:response:v1", { request_id: request.request_id, ok: true, result: { tasks } }));
    };
    return {
      emit,
      on(channel: string, handler: (data: unknown) => void) {
        listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
        return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((item) => item !== handler));
      },
    };
  };

  assert.equal(await hasPendingWakeTask(bus([{ status: "completed", notifyOnCompletion: true, triggerOnCompletion: true }, { status: "running", notifyOnCompletion: true, triggerOnCompletion: true }])), true);
  assert.equal(await hasPendingWakeTask(bus([{ status: "running", triggerOnCompletion: false }, { status: "completed", triggerOnCompletion: true }])), false);
  assert.equal(await hasPendingWakeTask(bus([{ status: "running", notifyOnCompletion: false, triggerOnCompletion: true }])), false);
  // 没装 pi-background-tasks：没人回应，超时按“没有”处理
  assert.equal(await hasPendingWakeTask(bus(), 20), false);
});
