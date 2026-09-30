import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_EVENTS,
  appendSource,
  autoEventUsesNative,
  buildEventNotification,
  createOrigin,
  manualRequestUsesNative,
  normalizeNotifyConfig,
  shouldSilenceNative,
  type KnownEvent,
  type NotifyConfig,
  type Origin,
  type Platform,
} from "./core.ts";
import {
  ToastController,
  captureTerminalWindowHandle,
  focusOrigin,
  isWindowForeground,
} from "./windows.ts";

const CLICKABLE_CONFIG_PATH = join(homedir(), ".pi", "agent", "clickable-toast.json");
const NOTIFY_CONFIG_PATH = join(homedir(), ".unipi", "config", "notify", "config.json");
const KNOWN_EVENT_SET = new Set<string>([...KNOWN_EVENTS, "session_shutdown"]);
const BUS_EVENTS: ReadonlyArray<[string, KnownEvent]> = [
  ["unipi:workflow:end", "workflow_end"],
  ["unipi:ralph:loop:end", "ralph_loop_end"],
  ["unipi:mcp:server:error", "mcp_server_error"],
  ["unipi:memory:consolidated", "memory_consolidated"],
  ["unipi:ask-user:prompt", "ask_user_prompt"],
  ["rpiv:ask-user:prompt", "ask_user_prompt"],
  ["permissions:ui_prompt", "permission_request"],
];
const SHARED_TASK_REGISTRY = Symbol.for("unipi.background-tasks.shared-registry");

interface ClickableConfig {
  enabled: boolean;
}

interface ManualNotification {
  title: string;
  message: string;
  priority?: string;
  requested: Platform[];
  remote: Platform[];
}

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadClickableConfig(): ClickableConfig {
  const value = parseJson(CLICKABLE_CONFIG_PATH) as { enabled?: unknown };
  return { enabled: value.enabled !== false };
}

function loadNotifyConfig(): NotifyConfig {
  return normalizeNotifyConfig(parseJson(NOTIFY_CONFIG_PATH));
}

function hasPendingWakeTask(): boolean {
  try {
    const registry = (globalThis as Record<symbol, unknown>)[SHARED_TASK_REGISTRY] as {
      allTasks?: () => ReadonlyArray<{ status?: string; triggerOnCompletion?: boolean }>;
    } | undefined;
    return registry?.allTasks?.().some(
      (task) => task.status === "running" && task.triggerOnCompletion === true,
    ) === true;
  } catch {
    return false;
  }
}

export default function clickableToast(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let origin: Origin | undefined;
  let controller: ToastController | undefined;
  let lastInputAt = 0;
  let renotifyTimer: ReturnType<typeof setInterval> | undefined;
  let busUnsubscribers: Array<() => void> = [];
  let lastAutomatic: { signature: string; at: number } | undefined;
  const pendingManual = new Map<string, ManualNotification>();
  const reported = new Set<string>();

  const reportOnce = (key: string, message: string): void => {
    if (reported.has(key)) return;
    reported.add(key);
    try {
      context?.ui.notify(`Clickable toast: ${message}`, "warning");
    } catch {
      // UI may already be shutting down.
    }
  };

  const readConfig = (): { clickable: ClickableConfig; notify: NotifyConfig } | undefined => {
    try {
      return { clickable: loadClickableConfig(), notify: loadNotifyConfig() };
    } catch (error) {
      reportOnce("config", error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const disarmRenotify = (): void => {
    if (renotifyTimer !== undefined) clearInterval(renotifyTimer);
    renotifyTimer = undefined;
  };

  const refreshWindowHandle = async (): Promise<void> => {
    const target = origin;
    if (!target) return;
    const hwnd = await captureTerminalWindowHandle();
    if (origin === target && hwnd) target.hwnd = hwnd;
  };

  const activateOrigin = async (): Promise<void> => {
    if (!origin) return;
    const result = await focusOrigin(origin);
    if (!result.ok) {
      reportOnce("focus", `could not focus the source terminal: ${result.error ?? "unknown error"}`);
    } else if (result.degraded) {
      reportOnce("herdr-fallback", "Herdr pane focus failed; focused the terminal window instead");
    }
  };

  const showNative = async (
    eventKey: string,
    title: string,
    message: string,
    notify: NotifyConfig,
    force = false,
  ): Promise<boolean> => {
    if (!origin || !controller) return false;
    if (!force && shouldSilenceNative(notify, eventKey, lastInputAt)) return false;
    if (!force && notify.native.suppressWhenFocused && await isWindowForeground(origin.hwnd)) return false;
    controller.show(title, appendSource(message, origin), notify.native.windowsAppId);
    return true;
  };

  const armRenotify = (
    eventKey: KnownEvent,
    title: string,
    message: string,
  ): void => {
    if (eventKey !== "ask_user_prompt" && eventKey !== "permission_request") return;
    disarmRenotify();
    const loaded = readConfig();
    if (!loaded?.clickable.enabled || !loaded.notify.renotify.enabled) return;
    if (loaded.notify.renotify.maxRepeats <= 0) return;

    let fired = 0;
    renotifyTimer = setInterval(() => {
      const current = readConfig();
      if (!current?.clickable.enabled || !current.notify.renotify.enabled ||
          !autoEventUsesNative(current.notify, eventKey)) {
        disarmRenotify();
        return;
      }
      fired += 1;
      void showNative(eventKey, `${title} (still waiting)`, message, current.notify);
      if (fired >= current.notify.renotify.maxRepeats) disarmRenotify();
    }, loaded.notify.renotify.intervalMs);
    renotifyTimer.unref?.();
  };

  const handleAutomatic = async (eventKey: KnownEvent, payload: unknown): Promise<void> => {
    const loaded = readConfig();
    if (!loaded?.clickable.enabled || !autoEventUsesNative(loaded.notify, eventKey)) return;
    if ((eventKey === "agent_end" || eventKey === "agent_settled") && hasPendingWakeTask()) return;

    const notification = buildEventNotification(eventKey, payload, pi.getSessionName?.());
    const signature = `${eventKey}\0${notification.message}`;
    const now = Date.now();
    if (lastAutomatic?.signature === signature && now - lastAutomatic.at < 750) return;
    lastAutomatic = { signature, at: now };

    await showNative(eventKey, notification.title, notification.message, loaded.notify);
    armRenotify(eventKey, notification.title, notification.message);
  };

  const registerBusListeners = (): void => {
    for (const unsubscribe of busUnsubscribers) unsubscribe();
    busUnsubscribers = BUS_EVENTS.map(([hook, eventKey]) =>
      pi.events.on(hook, (payload: unknown) => {
        void handleAutomatic(eventKey, payload);
      }),
    );
    busUnsubscribers.push(
      pi.events.on("herdr:blocked", (payload: unknown) => {
        const value = payload as { active?: unknown } | null;
        if (value?.active === false) disarmRenotify();
      }),
    );
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    lastInputAt = 0;
    reported.clear();
    pendingManual.clear();
    disarmRenotify();
    origin = createOrigin(ctx.cwd);
    // 不 await：PowerShell/WMI 冷启动可拖慢 RPC/TUI 启动数秒，
    // 窗口句柄在首次 input 或发 toast 前再取即可。
    void refreshWindowHandle();
    controller = new ToastController(
      `pi-clickable-toast-${process.pid}`,
      activateOrigin,
      (error) => reportOnce("toast", error.message),
    );
    registerBusListeners();

    const loaded = readConfig();
    if (loaded?.clickable.enabled) {
      const unknown = Object.entries(loaded.notify.events)
        .filter(([key, value]) => value.enabled && !KNOWN_EVENT_SET.has(key))
        .map(([key]) => key);
      if (unknown.length > 0) {
        reportOnce("unknown-events", `unsupported notify events were skipped: ${unknown.join(", ")}`);
      }
    }
  });

  pi.on("input", (event) => {
    if (event.source !== "interactive") return;
    lastInputAt = Date.now();
    void refreshWindowHandle();
  });

  pi.on("agent_start", () => disarmRenotify());
  pi.on("agent_end", (event) => void handleAutomatic("agent_end", event));
  pi.on("agent_settled", (event) => void handleAutomatic("agent_settled", event));

  pi.on("tool_call", (event: ToolCallEvent) => {
    if (event.toolName !== "notify_user") return;
    const loaded = readConfig();
    if (!loaded?.clickable.enabled) return;

    const input = event.input as Record<string, unknown>;
    const routing = manualRequestUsesNative(loaded.notify, input.platforms);
    if (!routing.usesNative) return;

    pendingManual.set(event.toolCallId, {
      title: typeof input.title === "string" && input.title.trim() ? input.title : "Pi Notification",
      message: typeof input.message === "string" ? input.message : "",
      ...(typeof input.priority === "string" ? { priority: input.priority } : {}),
      requested: routing.requested,
      remote: routing.remote,
    });
    // An empty list means "use defaults" to the original tool. Keep disabled
    // native as a no-op placeholder when this request has no remote targets.
    input.platforms = routing.remote.length > 0 ? routing.remote : ["native"];
  });

  pi.on("tool_result", async (event: ToolResultEvent) => {
    if (event.toolName !== "notify_user") return;
    const request = pendingManual.get(event.toolCallId);
    if (!request) return;
    pendingManual.delete(event.toolCallId);
    if (event.isError) return;

    const loaded = readConfig();
    if (!loaded?.clickable.enabled) return;
    const queued = await showNative("agent_tool", request.title, request.message, loaded.notify);
    const targets = [...request.remote, ...(queued ? ["native" as const] : [])];
    return {
      content: [{
        type: "text" as const,
        text: queued
          ? `Notification queued for ${targets.length} platform(s): ${targets.join(", ")}`
          : `Notification sent to ${request.remote.length} remote platform(s); native was suppressed by current settings`,
      }],
      details: {
        ...(event.details !== null && typeof event.details === "object" ? event.details as object : {}),
        platforms: targets,
        clickableNative: queued,
      },
    };
  });

  pi.on("session_shutdown", () => {
    disarmRenotify();
    for (const unsubscribe of busUnsubscribers) {
      try { unsubscribe(); } catch { /* already removed */ }
    }
    busUnsubscribers = [];
    pendingManual.clear();
    controller?.close();
    controller = undefined;
    origin = undefined;
    context = undefined;
  });

  pi.registerCommand("clickable-toast-test", {
    description: "Send a clickable Windows toast and focus this terminal when clicked",
    handler: async (_args, ctx) => {
      context = ctx;
      if (!origin) origin = createOrigin(ctx.cwd);
      await refreshWindowHandle();
      if (!controller) {
        controller = new ToastController(
          `pi-clickable-toast-${process.pid}`,
          activateOrigin,
          (error) => reportOnce("toast", error.message),
        );
      }
      const loaded = readConfig();
      if (!loaded?.clickable.enabled) {
        ctx.ui.notify("Clickable toast is disabled in clickable-toast.json", "warning");
        return;
      }
      const queued = await showNative(
        "test",
        "Pi — Clickable Toast Test",
        "Click this notification to return to its source terminal.",
        loaded.notify,
        true,
      );
      ctx.ui.notify(queued ? "Clickable test toast sent" : "Clickable test toast could not be sent", queued ? "info" : "error");
    },
  });
}
