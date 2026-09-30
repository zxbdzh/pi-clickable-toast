import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSource,
  autoEventUsesNative,
  buildEventNotification,
  createOrigin,
  manualRequestUsesNative,
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

test("adds a compact Herdr or Windows Terminal source line", () => {
  const herdr = createOrigin("C:/work/demo", {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p9",
    WT_SESSION: "{12345678-abcd}",
  });
  assert.equal(sourceLine(herdr), "demo · pane w1:p9");
  assert.equal(appendSource("Done", herdr), "Done\n\ndemo · pane w1:p9");

  const terminal = createOrigin("C:/work/api", { WT_SESSION: "{12345678-abcd}" });
  assert.equal(sourceLine(terminal), "api · WT 12345678");
});
