import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  KNOWN_EVENTS,
  appendSource,
  autoEventUsesNative,
  buildEventNotification,
  createOrigin,
  hasPendingWakeTask,
  manualRequestUsesNative,
  normalizeClickableConfig,
  normalizeNotifyConfig,
  shouldSilenceNative,
  type ClickableConfig,
  type KnownEvent,
  type NotifyConfig,
  type Origin,
  type Platform,
} from "./core.ts";
import {
  DEFAULT_ICON,
  NativeToast,
  TOAST_APP_ID,
  buildNativeHelper,
  captureTerminalWindowHandle,
  ensureProjectIcon,
  focusOrigin,
  isWindowForeground,
  registerToastApp,
  type ToastAppearance,
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
  return normalizeClickableConfig(parseJson(CLICKABLE_CONFIG_PATH));
}

/** 自定义图标路径相对 ~/.pi/agent 解析；文件不存在就回退到自带图标，避免 toast 因图片缺失而不显示。 */
function resolveIcon(configured: string | undefined): { path: string; missing?: string } {
  if (!configured) return { path: DEFAULT_ICON };
  const path = isAbsolute(configured) ? configured : resolve(join(homedir(), ".pi", "agent"), configured);
  return existsSync(path) ? { path } : { path: DEFAULT_ICON, missing: path };
}

// 换了行为就改这个标记，日志里一眼能看出运行的是不是新代码
const BUILD_TAG = "2026-10-06-exit-cleanup";
const DEBUG_LOG_PATH = join(homedir(), ".pi", "agent", "clickable-toast.log");

/** 仅在 clickable-toast.json 的 debug=true 时写日志；日志失败不能影响通知。 */
function debugLog(message: string): void {
  try {
    if (!loadClickableConfig().debug) return;
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} pid=${process.pid} ${message}\n`);
  } catch {
    // ignore
  }
}

function loadNotifyConfig(): NotifyConfig {
  return normalizeNotifyConfig(parseJson(NOTIFY_CONFIG_PATH));
}

export default function clickableToast(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let origin: Origin | undefined;
  let controller: NativeToast | undefined;
  let nativeToastReady = false;
  let lastInputAt = 0;
  let renotifyTimer: ReturnType<typeof setInterval> | undefined;
  let busUnsubscribers: Array<() => void> = [];
  let unsubTerminalInput: (() => void) | undefined;
  let lastAutomatic: { signature: string; at: number } | undefined;
  const pendingManual = new Map<string, ManualNotification>();
  const reported = new Set<string>();

  const onToastEvent = (result: string): void => {
    debugLog(`toast result: ${result}`);
  };

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
    // Herdr 场景由 herdr-focus 直接查找客户端窗口，用不到 pi 自己的窗口句柄。
    // 旧的 PowerShell 版每次要跑十几秒 CIM 查询，且每次交互输入都会触发。
    if (target.herdrPaneId) return;
    const hwnd = await captureTerminalWindowHandle();
    if (origin === target && hwnd) target.hwnd = hwnd;
  };

  const activateOrigin = async (): Promise<void> => {
    if (!origin) return;
    debugLog(`activate: start origin=${JSON.stringify(origin)}`);
    const result = await focusOrigin(origin);
    debugLog(`activate: result=${JSON.stringify(result)}`);
    if (!result.ok) {
      reportOnce("focus", `could not focus the source terminal: ${result.error ?? "unknown error"}`);
    } else if (result.degraded) {
      reportOnce("herdr-fallback", "Herdr pane focus failed; focused the terminal window instead");
    }
  };

  // 应用标识按“名字 + 图标”懒登记：改了配置下一条 toast 就生效，不需要 /reload。
  let appRegistration: { key: string; done: Promise<boolean> } | undefined;

  const resolveAppearance = async (
    clickable: ClickableConfig,
    notify: NotifyConfig,
  ): Promise<ToastAppearance> => {
    // 自定义图标优先；否则可选按项目名生成；都不可用时用自带图标
    const custom = resolveIcon(clickable.icon);
    if (custom.missing) reportOnce("icon", `icon not found, using the project icon: ${custom.missing}`);
    let icon = clickable.icon ? custom.path : DEFAULT_ICON;
    if (!clickable.icon && clickable.projectIcon && origin) {
      const generated = await ensureProjectIcon(origin.project);
      if (generated) icon = generated;
    }

    // notify 配置里显式指定了 windowsAppId 就按用户的来，不由我们登记。
    // 应用标识只含名字（不含图标路径）：图标每次生成后是同路径的，没必要让注册失效。
    if (notify.native.windowsAppId) return { appID: notify.native.windowsAppId, icon };
    const key = clickable.appName;
    if (appRegistration?.key !== key) {
      appRegistration = {
        key,
        done: registerToastApp({ id: TOAST_APP_ID, name: clickable.appName, icon: DEFAULT_ICON }),
      };
    }
    const registered = await appRegistration.done;
    if (!registered) reportOnce("app-id", "could not register the toast app identity; using the default one");
    return { ...(registered ? { appID: TOAST_APP_ID } : {}), icon };
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
    const clickable = readConfig()?.clickable;
    const appearance = clickable ? await resolveAppearance(clickable, notify) : {};
    debugLog(`show: event=${eventKey} title=${JSON.stringify(title)} appID=${appearance.appID ?? "default"} icon=${appearance.icon ?? "-"}`);
    const body = clickable?.showSource ? appendSource(message, origin) : message;
    // 只用 WinRT 通道：SnoreToast 在带应用标识时收不到点击，而没应用的 toast 名字就叫 SnoreToast。
    const shown = nativeToastReady && controller.show(title, body, { ...appearance, tag: originWideTag() });
    if (!shown) reportOnce("toast-channel", "native toast unavailable; the notification was not shown");
    return shown;
  };

  /** 每个 pi 会话一个 tag，同一会话的新通知替换旧通知，不同会话互不影响。 */
  const originWideTag = (): string => `pi-${process.pid}`;

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
    if ((eventKey === "agent_end" || eventKey === "agent_settled") && await hasPendingWakeTask(pi.events)) {
      debugLog(`skip: ${eventKey}, a background task will wake the agent`);
      return;
    }

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
    unsubTerminalInput?.();
    unsubTerminalInput = undefined;
    // 只有交互终端会话自动发通知。magic-context 等扩展会在后台起 `pi --mode json/rpc` 子进程，
    // 子进程同样加载本扩展：它的 agent_end 不是用户的 agent 结束，而且跑完即退出，toast 点了也没人接。
    if (ctx.mode !== "tui") {
      debugLog(`session_start: build=${BUILD_TAG} mode=${ctx.mode} cwd=${ctx.cwd} -> automatic toasts off`);
      return;
    }
    origin = createOrigin(ctx.cwd);
    debugLog(`session_start: build=${BUILD_TAG} mode=${ctx.mode} herdrPane=${origin.herdrPaneId ?? "-"} cwd=${ctx.cwd}`);
    // 后台编译原生辅助程序（仅首次，约 0.7 秒）；就绪前发的 toast 会被跳过并提示。
    controller = new NativeToast(activateOrigin, (error) => reportOnce("toast", error.message), onToastEvent);
    void buildNativeHelper().then((ok) => {
      nativeToastReady = ok;
      debugLog(`native helper: ${ok ? "ready" : "unavailable, toast disabled"}`);
    });
    // 不 await：PowerShell/WMI 冷启动可拖慢 RPC/TUI 启动数秒，
    // 窗口句柄在首次 input 或发 toast 前再取即可。
    void refreshWindowHandle();
    registerBusListeners();

    // 终端里有按键（比如回答了提问）说明人就在跟前，取消“还在等你”的重复提醒。
    // 回答提问不会触发 agent_start，不在这里取消的话，问题答完后重复提醒还会接着弹。
    unsubTerminalInput = ctx.ui.onTerminalInput(() => {
      if (renotifyTimer !== undefined) {
        debugLog("renotify: cancelled by terminal input");
        disarmRenotify();
      }
      return undefined;
    });

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
    unsubTerminalInput?.();
    unsubTerminalInput = undefined;
    for (const unsubscribe of busUnsubscribers) {
      try { unsubscribe(); } catch { /* already removed */ }
    }
    busUnsubscribers = [];
    pendingManual.clear();
    controller?.dispose();
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
        controller = new NativeToast(activateOrigin, (error) => reportOnce("toast", error.message), onToastEvent);
        nativeToastReady = await buildNativeHelper();
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
