import { randomUUID } from "node:crypto";
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

/** pi.events 的最小子集，单测可注入假总线。 */
export interface EventBusLike {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

/**
 * agent 结束一轮时，pi-background-tasks 里可能还有跑完会唤醒它的任务（bg_run 等），
 * 这时 agent 并没有完成，应等任务唤醒它、真正结束后再提示。
 * 走该扩展公开的 EventBus status 查询；没装、未就绪或超时都按“没有”处理，宁可多弹也不吞掉完成通知。
 */
export function hasPendingWakeTask(events: EventBusLike, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = `clickable-toast-${randomUUID()}`;
    const finish = (pending: boolean): void => {
      clearTimeout(timer);
      off();
      resolve(pending);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const off = events.on("pi-background-tasks:response:v1", (data) => {
      const frame = record(data);
      if (frame.request_id !== requestId) return;
      const tasks = frame.ok === true ? record(frame.result).tasks : undefined;
      finish(Array.isArray(tasks) && tasks.some((task) => {
        const item = record(task);
        return item.status === "running" && item.triggerOnCompletion === true;
      }));
    });
    events.emit("pi-background-tasks:request:v1", {
      schema_version: "pi-background-tasks.extension-request.v1",
      request_id: requestId,
      operation: "status",
      payload: {},
    });
  });
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
  hwnd?: string;
}

export function createOrigin(cwd: string, env: NodeJS.ProcessEnv = process.env): Origin {
  const herdrPaneId = env.HERDR_ENV === "1" ? text(env.HERDR_PANE_ID) : undefined;
  return {
    cwd,
    project: basename(cwd) || cwd,
    ...(herdrPaneId ? { herdrPaneId } : {}),
  };
}

/** toast 末尾的来源行只写项目名；pane/终端会话 id 对人没有意义，不显示。 */
export function sourceLine(origin: Origin): string {
  return origin.project;
}

export function appendSource(message: string, origin: Origin): string {
  return `${message}\n\n${sourceLine(origin)}`;
}

/** clickable-toast.json：开关、调试和 toast 外观。 */
export interface ClickableConfig {
  enabled: boolean;
  debug: boolean;
  /** 是否在 toast 末尾追加项目名，默认关闭。 */
  showSource: boolean;
  /** 是否用项目名生成 toast 左侧的大图（首字母 + 固定颜色），默认开启；配置了 icon 时以 icon 为准。 */
  projectIcon: boolean;
  /** toast 左上角显示的应用名。 */
  appName: string;
  /** 自定义图标（png/jpg/ico 路径），缺省用扩展自带的图标。 */
  icon?: string;
}

export const DEFAULT_APP_NAME = "Pi";

export function normalizeClickableConfig(raw: unknown): ClickableConfig {
  const value = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const icon = text(value.icon);
  return {
    enabled: value.enabled !== false,
    debug: value.debug === true,
    showSource: value.showSource === true,
    projectIcon: value.projectIcon !== false,
    appName: text(value.appName) ?? DEFAULT_APP_NAME,
    ...(icon ? { icon } : {}),
  };
}

export interface ProjectIconSpec {
  /** 图标上显示的 1~2 个字符。 */
  letter: string;
  /** 背景色，RRGGBB。 */
  color: string;
}

/**
 * 按项目名生成图标的文字和颜色。同一个项目永远得到同一个结果（颜色来自名字的哈希），
 * 大小写不同的同名目录也得到同一个颜色。
 * 文字：名字里有分隔符（- _ 空格 .）就取前两个词的首字母，否则取第一个字符。
 */
export function projectIconSpec(project: string): ProjectIconSpec {
  const words = project.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => Array.from(word)[0].toUpperCase()).join("");

  // FNV-1a 哈希 -> 色相；饱和度和亮度固定，保证白字在任何色相上都看得清。
  // 先归一化：统一小写并把分隔符（- _ 空格 . 等）都去掉，同一项目的不同写法得到同一颜色。
  let hash = 0x811c9dc5;
  const normalized = project.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  for (let i = 0; i < normalized.length; i += 1) {
    hash = Math.imul(hash ^ normalized.charCodeAt(i), 0x01000193) >>> 0;
  }
  return { letter: initials || "π", color: hslToHex(hash % 360, 0.52, 0.38) };
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  const [r, g, b] =
    hue < 60 ? [chroma, x, 0] :
    hue < 120 ? [x, chroma, 0] :
    hue < 180 ? [0, chroma, x] :
    hue < 240 ? [0, x, chroma] :
    hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [r, g, b]
    .map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
