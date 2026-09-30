import { basename } from "node:path";

export const KNOWN_EVENTS = [
  "workflow_end",
  "ralph_loop_end",
  "mcp_server_error",
  "agent_end",
  "agent_settled",
  "memory_consolidated",
  "ask_user_prompt",
  "permission_request",
] as const;

export type KnownEvent = (typeof KNOWN_EVENTS)[number];
export type Platform = "native" | "gotify" | "telegram" | "ntfy";

export interface NotifyConfig {
  defaultPlatforms: Platform[];
  events: Record<string, { enabled: boolean; platforms: Platform[] }>;
  native: { suppressWhenFocused: boolean; windowsAppId?: string };
  gotify: { enabled: boolean };
  telegram: { enabled: boolean };
  silenceAfterInput: { enabled: boolean; windowMs: number; platforms: Platform[] };
  renotify: { enabled: boolean; intervalMs: number; maxRepeats: number };
}

const EVENT_DEFAULTS: NotifyConfig["events"] = {
  workflow_end: { enabled: true, platforms: [] },
  ralph_loop_end: { enabled: true, platforms: [] },
  mcp_server_error: { enabled: true, platforms: [] },
  agent_end: { enabled: false, platforms: [] },
  agent_settled: { enabled: false, platforms: [] },
  memory_consolidated: { enabled: false, platforms: [] },
  session_shutdown: { enabled: false, platforms: [] },
  ask_user_prompt: { enabled: false, platforms: [] },
  permission_request: { enabled: false, platforms: [] },
};

const VALID_PLATFORMS = new Set<Platform>(["native", "gotify", "telegram", "ntfy"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finite(value: unknown, fallback: number, minimum = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback;
}

function platforms(value: unknown, fallback: Platform[]): Platform[] {
  if (!Array.isArray(value)) return fallback.slice();
  return value.filter((item): item is Platform => typeof item === "string" && VALID_PLATFORMS.has(item as Platform));
}

export function normalizeNotifyConfig(value: unknown): NotifyConfig {
  const root = record(value);
  const rawEvents = record(root.events);
  const events: NotifyConfig["events"] = {};
  for (const [key, defaults] of Object.entries(EVENT_DEFAULTS)) {
    const raw = record(rawEvents[key]);
    events[key] = {
      enabled: bool(raw.enabled, defaults.enabled),
      platforms: platforms(raw.platforms, defaults.platforms),
    };
  }
  for (const [key, value] of Object.entries(rawEvents)) {
    if (key in events) continue;
    const raw = record(value);
    events[key] = {
      enabled: bool(raw.enabled, false),
      platforms: platforms(raw.platforms, []),
    };
  }

  const native = record(root.native);
  const gotify = record(root.gotify);
  const telegram = record(root.telegram);
  const silence = record(root.silenceAfterInput);
  const renotify = record(root.renotify);

  return {
    defaultPlatforms: platforms(root.defaultPlatforms, ["native"]),
    events,
    native: {
      suppressWhenFocused: bool(native.suppressWhenFocused, false),
      ...(typeof native.windowsAppId === "string" && native.windowsAppId.trim()
        ? { windowsAppId: native.windowsAppId.trim() }
        : {}),
    },
    gotify: { enabled: bool(gotify.enabled, false) },
    telegram: { enabled: bool(telegram.enabled, false) },
    silenceAfterInput: {
      enabled: bool(silence.enabled, false),
      windowMs: finite(silence.windowMs, 10_000),
      platforms: platforms(silence.platforms, ["native"]),
    },
    renotify: {
      enabled: bool(renotify.enabled, true),
      intervalMs: finite(renotify.intervalMs, 120_000, 10_000),
      maxRepeats: Math.floor(finite(renotify.maxRepeats, 3)),
    },
  };
}

export function autoEventUsesNative(config: NotifyConfig, eventKey: string): boolean {
  const event = config.events[eventKey];
  if (!event?.enabled) return false;
  // Empty means all enabled platforms. The local clickable-native owner is enabled.
  return event.platforms.length === 0 || event.platforms.includes("native");
}

export function manualRequestUsesNative(
  config: NotifyConfig,
  requested: unknown,
): { usesNative: boolean; requested: Platform[]; remote: Platform[] } {
  const resolved = platforms(requested, config.defaultPlatforms);
  return {
    usesNative: resolved.includes("native"),
    requested: resolved,
    remote: resolved.filter((platform) => platform !== "native"),
  };
}

export function shouldSilenceNative(
  config: NotifyConfig,
  eventKey: string,
  lastInputAt: number,
  now = Date.now(),
): boolean {
  if (eventKey === "ask_user_prompt" || eventKey === "permission_request") return false;
  const silence = config.silenceAfterInput;
  if (!silence.enabled || lastInputAt <= 0 || now - lastInputAt >= silence.windowMs) return false;
  return silence.platforms.length === 0 || silence.platforms.includes("native");
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function askMessage(payload: unknown): string {
  const root = record(payload);
  const questions = Array.isArray(root.questions) ? root.questions.map(record) : [];
  if (questions.length === 0) {
    const question = text(root.question) ?? "A question";
    const context = text(root.context);
    return context ? `Agent asks: ${question} — ${context}` : `Agent asks: ${question}`;
  }

  const first = questions[0];
  const question = text(first.question) ?? "A question";
  const suffix = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
  const labels = Array.isArray(first.options)
    ? first.options.map(record).map((option) => text(option.label)).filter(Boolean)
    : [];
  return labels.length > 0
    ? `Agent asks: ${question}${suffix} — ${labels.join(", ")}`
    : `Agent asks: ${question}${suffix}`;
}

function permissionMessage(payload: unknown): string {
  const root = record(payload);
  const agent = text(root.agentName) ?? "Agent";
  const surface = text(root.surface);
  const value = text(root.value);
  const message = text(root.message);
  const parts: string[] = [];
  if (surface && value) parts.push(`${agent} requested ${surface} '${value}'.`);
  else if (surface) parts.push(`${agent} requested ${surface} access.`);
  else if (value) parts.push(`${agent} requested '${value}'.`);
  if (message && !parts.includes(message)) parts.push(message);
  if (parts.length === 0) parts.push("Pi is waiting for a permission decision.");
  if (root.forwarding) parts.push("(forwarded)");
  return parts.join(" ");
}

const LABELS: Record<KnownEvent, string> = {
  workflow_end: "Workflow Done",
  ralph_loop_end: "Ralph Complete",
  mcp_server_error: "MCP Error",
  agent_end: "Agent Run Complete",
  agent_settled: "Agent Complete",
  memory_consolidated: "Memory Saved",
  ask_user_prompt: "Question Asked",
  permission_request: "Permission Request",
};

export function buildEventNotification(
  eventKey: KnownEvent,
  payload: unknown,
  sessionName?: string,
): { title: string; message: string } {
  const p = record(payload);
  let message: string;
  switch (eventKey) {
    case "workflow_end":
      message = `Workflow ${String(p.command || "unknown")}${p.success === false ? " failed" : " completed"}`;
      break;
    case "ralph_loop_end":
      message = `Ralph loop "${String(p.name || "unknown")}" ${String(p.status || "completed")}`;
      break;
    case "mcp_server_error":
      message = `Server "${String(p.name || "unknown")}" error: ${String(p.error || "unknown error")}`;
      break;
    case "agent_end":
      message = sessionName ? `${sessionName} - Agent run is complete` : "Agent run is complete";
      break;
    case "agent_settled":
      message = sessionName ? `${sessionName} - Agent is complete` : "Agent is complete";
      break;
    case "memory_consolidated":
      message = `Memory consolidated (${String(p.count || 0)} items)`;
      break;
    case "ask_user_prompt":
      message = askMessage(payload);
      break;
    case "permission_request":
      message = permissionMessage(payload);
      break;
  }
  return { title: `Pi — ${LABELS[eventKey]}`, message };
}

export interface Origin {
  cwd: string;
  project: string;
  herdrPaneId?: string;
  wtSession?: string;
  hwnd?: string;
}

export function createOrigin(cwd: string, env: NodeJS.ProcessEnv = process.env): Origin {
  const herdrPaneId = env.HERDR_ENV === "1" ? text(env.HERDR_PANE_ID) : undefined;
  const wtSession = text(env.WT_SESSION)?.replace(/[{}-]/g, "").slice(0, 8);
  return {
    cwd,
    project: basename(cwd) || cwd,
    ...(herdrPaneId ? { herdrPaneId } : {}),
    ...(wtSession ? { wtSession } : {}),
  };
}

export function sourceLine(origin: Origin): string {
  if (origin.herdrPaneId) return `${origin.project} · pane ${origin.herdrPaneId}`;
  if (origin.wtSession) return `${origin.project} · WT ${origin.wtSession}`;
  return origin.project;
}

export function appendSource(message: string, origin: Origin): string {
  return `${message}\n\n${sourceLine(origin)}`;
}
