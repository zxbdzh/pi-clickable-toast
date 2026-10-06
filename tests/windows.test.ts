import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectIconSpec, type Origin } from "../core.ts";
import {
  NativeToast,
  buildNativeHelper,
  captureTerminalWindowHandle,
  findWinmdRefs,
  ensureProjectIcon,
  focusOrigin,
  helperCommand,
  parseHerdrFocusOutput,
  registerToastApp,
  withoutHerdrEnv,
  type ExecFileLike,
} from "../windows.ts";

test("parses herdr-focus output in both the old and the new format", () => {
  assert.deepEqual(parseHerdrFocusOutput("42015824\r\n"), { hwnd: "42015824" });
  // 辅助程序现在会附带前置方法和 tab 切换结果；旧正则 /^[0-9]+$/ 会把它误判为失败
  assert.deepEqual(parseHerdrFocusOutput("42015824 via=alt tab=selected\r\n"), {
    hwnd: "42015824",
    via: "alt",
    tab: "selected",
  });
  assert.equal(parseHerdrFocusOutput(""), undefined);
  assert.equal(parseHerdrFocusOutput("0"), undefined);
  assert.equal(parseHerdrFocusOutput("no herdr client window found"), undefined);
});

test("prefers the native helper once it exists and falls back to PowerShell otherwise", () => {
  const native = helperCommand(() => true);
  assert.equal(native.native, true);
  assert.match(native.file, /PiToastFocus-[0-9a-f]{12}\.exe$/);
  assert.deepEqual(native.args, []);

  const fallback = helperCommand(() => false);
  assert.equal(fallback.native, false);
  assert.equal(fallback.file, "powershell.exe");
  assert.ok(fallback.args.includes("-File"));
});

test("focus.cs compiles with the in-box csc and the exe answers harmless queries", async () => {
  assert.equal(await buildNativeHelper(), true, "csc build failed");
  const helper = helperCommand();
  assert.equal(helper.native, true);
  assert.ok(existsSync(helper.file));
  // 只跑不会改变前台窗口的动作：未知动作、缺参数、不存在的窗口句柄
  const exit = (args: string[]): number => {
    try {
      execFileSync(helper.file, args, { stdio: "ignore" });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  };
  assert.equal(exit([]), 1);
  assert.equal(exit(["-Action", "bogus", "-Value", "1"]), 1);
  assert.equal(exit(["-Action", "foreground", "-Value", "1"]), 0);
});

test("strips HERDR_* so a spawned attach is not treated as nested herdr", () => {
  const env = withoutHerdrEnv({
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w4:p12",
    HERDR_SOCKET_PATH: "C:/x/herdr.sock",
    PATH: "C:/bin",
    USERPROFILE: "C:/Users/1",
  });
  assert.deepEqual(env, { PATH: "C:/bin", USERPROFILE: "C:/Users/1" });
});

test("derives a stable icon spec from the project name", () => {
  assert.deepEqual(projectIconSpec("Huajingflow"), { letter: "H", color: "2F4B93" });
  assert.equal(projectIconSpec("andornot-schedule").letter, "AS");
  assert.equal(projectIconSpec("pi_clickable_toast").letter, "PC");
  assert.equal(projectIconSpec("中文项目").letter, "中");
  assert.equal(projectIconSpec("1").letter, "1");

  // 同名不同大小写、不同分隔符要去同一个颜色（否则同一项目会得到不同图标）
  assert.equal(projectIconSpec("Huajingflow").color, projectIconSpec("huajingflow").color);
  assert.equal(projectIconSpec("pi-clickable-toast").color, projectIconSpec("pi_clickable_toast").color);
  // 不同项目不应该都撞到同一个颜色
  const colors = new Set(["Huajingflow", "huajingweb", "Siftmark", "Chronos", "voxrail"].map((n) => projectIconSpec(n).color));
  assert.ok(colors.size >= 4, `too many colour collisions: ${[...colors].join(",")}`);
  // 颜色必须是 6 位大写十六进制，C# 端按十六进制解析
  for (const name of ["Huajingflow", "中文项目", "1"]) assert.match(projectIconSpec(name).color, /^[0-9A-F]{6}$/);
});

test("generates the project icon once and reuses it when it already exists", async () => {
  const dir = join(tmpdir(), "pi-clickable-toast-test-icons", String(process.pid));
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let onDisk = false;
  const exists = () => onDisk;
  const run: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    onDisk = true; // 辅助程序跑完就写好了文件
    return { stdout: "", stderr: "" };
  };
  const deps = { run, exists, helper: async () => "X:/fake/PiToastFocus.exe", dir };

  const path = await ensureProjectIcon("andornot-schedule", deps);
  assert.ok(path && path.endsWith(".png"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "X:/fake/PiToastFocus.exe");
  assert.deepEqual(calls[0].args.slice(0, 6), ["-Action", "icon", "-Text", "AS", "-Color", projectIconSpec("andornot-schedule").color]);
  assert.equal(calls[0].args.at(-2), "-Out");

  // 文件已存在就不再调用辅助程序（每个项目首次之后都走这条路径）
  assert.equal(await ensureProjectIcon("andornot-schedule", deps), path);
  assert.equal(calls.length, 1);
});

test("falls back to the built-in icon when the helper cannot draw", async () => {
  const deps = {
    run: async () => { throw new Error("exe missing"); },
    exists: () => false,
    helper: async () => "X:/fake/PiToastFocus.exe",
    dir: join(tmpdir(), "pi-clickable-toast-test-icons", "fail"),
  };
  assert.equal(await ensureProjectIcon("demo", deps), undefined);
  assert.equal(await ensureProjectIcon("demo", { ...deps, helper: async () => undefined }), undefined);
});

test("passes identity, icon and tag to the native toast helper", () => {
  const spawned: Array<{ file: string; args: readonly string[] }> = [];
  let activator: (() => void | Promise<void>) | undefined;
  const toast = new NativeToast(
    () => { activator?.(); },
    () => {},
    undefined,
    () => "X:/fake/PiToastFocus.exe",
    ((file: string, args: readonly string[]) => {
      spawned.push({ file, args });
      return { stdout: { on() {} }, once() {}, kill() {}, removeAllListeners() {} };
    }) as unknown as typeof spawn,
  );

  assert.equal(toast.show("Title", "Body", { appID: "Pi.AgentToast", icon: "C:/i.png", tag: "pi-1" }), true);
  assert.equal(spawned[0].file, "X:/fake/PiToastFocus.exe");
  assert.deepEqual(spawned[0].args, [
    "-Action", "toast", "-Title", "Title", "-Message", "Body",
    "-AppID", "Pi.AgentToast", "-ParentPid", String(process.pid), "-Lifeline", "stdin",
    "-Icon", "C:/i.png", "-Tag", "pi-1",
  ]);
});

test("does not show anything without the helper or an app id", () => {
  const spawned: unknown[] = [];
  const spawnStub = ((file: string, args: readonly string[]) => {
    spawned.push([file, args]);
    return { stdout: { on() {} }, once() {}, kill() {}, removeAllListeners() {} };
  }) as unknown as typeof spawn;

  const noHelper = new NativeToast(() => {}, () => {}, undefined, () => undefined, spawnStub);
  assert.equal(noHelper.show("t", "m", { appID: "Pi.AgentToast" }), false);

  const noAppId = new NativeToast(() => {}, () => {}, undefined, () => "X:/fake.exe", spawnStub);
  assert.equal(noAppId.show("t", "m", {}), false);
  assert.equal(spawned.length, 0);
});

test("focuses only when the helper reports the toast was clicked", async () => {
  let activations = 0;
  const events: string[] = [];
  const makeToast = (output: string) =>
    new NativeToast(
      () => { activations += 1; },
      () => {},
      (result) => events.push(result),
      () => "X:/fake.exe",
      (() => {
        let onData: ((chunk: Buffer) => void) | undefined;
        let onClose: (() => void) | undefined;
        const child = {
          stdout: { on(_event: string, cb: (chunk: Buffer) => void) { onData = cb; } },
          once(event: string, cb: () => void) { if (event === "close") onClose = cb; },
          kill() {},
          removeAllListeners() {},
        };
        // 真实顺序：helper 先写结果到 stdout，然后退出触发 close
        setImmediate(() => { onData?.(Buffer.from(output)); onClose?.(); });
        return child;
      }) as unknown as typeof spawn,
    );

  makeToast("activated").show("t", "m", { appID: "Pi.AgentToast" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(activations, 1);
  assert.deepEqual(events, ["activated"]);

  // 通知中心里被关掉，或者长时间没人点：不能触发聚焦
  makeToast("dismissed").show("t", "m", { appID: "Pi.AgentToast" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  makeToast("timeout").show("t", "m", { appID: "Pi.AgentToast" });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(activations, 1, "只有 activated 才聚焦");
  assert.deepEqual(events, ["activated", "dismissed", "timeout"]);
});

test("replaces the previous toast process instead of stacking listeners", () => {
  const killed: number[] = [];
  let sequence = 0;
  const toast = new NativeToast(
    () => {},
    () => {},
    undefined,
    () => "X:/fake.exe",
    (() => {
      const id = sequence++;
      const child = {
        stdout: { on() {} },
        once() {},
        kill() { killed.push(id); },
        removeAllListeners() {},
      };
      return child;
    }) as unknown as typeof spawn,
  );

  toast.show("First", "one", { appID: "Pi.AgentToast" });
  toast.show("Second", "two", { appID: "Pi.AgentToast" });
  assert.deepEqual(killed, [0], "first toast process must be killed when replaced");

  toast.close();
  assert.deepEqual(killed, [0, 1]);
});

test("dispose ends the helper's stdin lifeline instead of killing it and refuses new toasts", () => {
  const calls: string[] = [];
  let options: { stdio?: unknown; detached?: boolean } = {};
  const toast = new NativeToast(
    () => {},
    () => {},
    undefined,
    () => "X:/fake.exe",
    ((_file: string, _args: readonly string[], spawnOptions: typeof options) => {
      options = spawnOptions;
      return {
        stdin: { on() {}, end() { calls.push("end"); } },
        stdout: { on() {} },
        once() {},
        kill() { calls.push("kill"); },
        removeAllListeners() {},
      };
    }) as unknown as typeof spawn,
  );

  assert.equal(toast.show("t", "m", { appID: "Pi.AgentToast" }), true);
  // 辅助程序靠 stdin 断开判断会话结束（-Lifeline stdin），所以 stdin 必须是管道；
  // 还得 detached，否则 pi 退出时 libuv 的 job 会连它一起杀掉，来不及撤通知
  assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
  assert.equal(options.detached, true);

  // 不能 kill：被杀掉的辅助程序没机会把通知中心里的条目撤掉
  toast.dispose();
  assert.deepEqual(calls, ["end"]);
  assert.equal(toast.show("t", "m", { appID: "Pi.AgentToast" }), false);
});

type Call = { file: string; args: readonly string[] };
const herdrOrigin: Origin = { cwd: "C:/work/demo", project: "demo", herdrPaneId: "w4:p12" };

test("brings the herdr terminal window forward then focuses the exact pane", async () => {
  const calls: Call[] = [];
  const run: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    // herdr-focus 返回 Herdr 所在 WT 窗口句柄、前置方法和 tab 切换结果
    if (args.includes("herdr-focus")) return { stdout: "42015824 via=alt tab=selected", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const spawned: Call[] = [];

  const result = await focusOrigin(herdrOrigin, run, (file, args) => { spawned.push({ file, args }); });

  // 真实输出带 via/tab 后仍必须算成功，不能误走 attach 兑底
  assert.deepEqual(result, { ok: true, method: "herdr", hostVia: "alt", hostTab: "selected" });
  const hostCall = calls.find((c) => c.args.includes("herdr-focus"));
  assert.ok(hostCall);
  assert.deepEqual(hostCall.args.slice(-4), ["-Action", "herdr-focus", "-Value", "1"]);
  assert.deepEqual(calls.find((c) => c.file === "herdr.exe"), { file: "herdr.exe", args: ["agent", "focus", "w4:p12"] });
  assert.equal(spawned.length, 0, "terminal is already open, must not open another window");
});

test("opens an attach window only when no herdr terminal can be found", async () => {
  const run: ExecFileLike = async (file, args) => {
    // 找不到界面客户端：脚本以非零退出
    if (args.includes("herdr-focus")) throw new Error("exit 2");
    return { stdout: "", stderr: "" };
  };
  const spawned: Call[] = [];

  const result = await focusOrigin(herdrOrigin, run, (file, args) => { spawned.push({ file, args }); });

  assert.equal(result.ok, true);
  assert.equal(result.attached, true);
  assert.match(result.hostError ?? "", /exit 2/, "failure reason must be surfaced for the debug log");
  assert.deepEqual(spawned, [{ file: "cmd.exe", args: ["/c", "start", "", "cmd.exe", "/k", "herdr", "session", "attach", "default"] }]);
});

test("falls back to attach when herdr agent focus fails", async () => {
  const run: ExecFileLike = async (file, args) => {
    if (file === "herdr.exe") throw new Error("pane unavailable");
    if (args.includes("herdr-focus")) return { stdout: "42015824", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const spawned: Call[] = [];

  const result = await focusOrigin(herdrOrigin, run, (file, args) => { spawned.push({ file, args }); });

  assert.equal(result.ok, true);
  assert.equal(result.attached, true);
  assert.equal(result.degraded, true);
  assert.equal(spawned.length, 1);
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

test("findWinmdRefs prefers system WinMetadata and falls back to the SDK merged winmd", () => {
  const systemDir = join(process.env.windir ?? "C:\\Windows", "System32", "WinMetadata");
  // 系统自带目录存在 → 全量 winmd（过滤非 winmd、排序），不再看 SDK
  const systemRefs = findWinmdRefs(
    (path) => path === systemDir || path === "C:\\Program Files (x86)\\Windows Kits\\10\\UnionMetadata",
    (dir) => (dir === systemDir ? ["Windows.UI.winmd", "readme.txt", "Windows.Data.winmd"] : ["Facade"]),
  );
  assert.deepEqual(systemRefs, [join(systemDir, "Windows.Data.winmd"), join(systemDir, "Windows.UI.winmd")]);

  // 系统目录缺失 → 回退 SDK 合并 winmd（Facade 纯转发被版本号过滤跳过）
  const sdkRoot = "C:\\Program Files (x86)\\Windows Kits\\10\\UnionMetadata";
  const sdkOnly = findWinmdRefs(
    (path) => path === sdkRoot || path === join(sdkRoot, "10.0.26100.0", "Windows.winmd"),
    (dir) => (dir === sdkRoot ? ["Facade", "10.0.26100.0"] : []),
  );
  assert.deepEqual(sdkOnly, [join(sdkRoot, "10.0.26100.0", "Windows.winmd")]);

  // 两边都没有 → 空数组（focus.cs 编译失败，toast 不可用）
  assert.deepEqual(findWinmdRefs(() => false, () => []), []);
});
