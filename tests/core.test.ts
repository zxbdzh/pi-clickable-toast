import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSource,
  autoEventUsesNative,
  buildEventNotification,
  createOrigin,
  manualRequestUsesNative,
  normalizeClickableConfig,
  normalizeNotifyConfig,
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
