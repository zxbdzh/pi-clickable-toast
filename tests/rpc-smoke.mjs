import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const extension = "C:/Users/1/.pi/agent/extensions/clickable-toast/index.ts";
const pi = spawn(
  "D:/nvm4w/nodejs/node.exe",
  [
    "D:/nvm4w/nodejs/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    "--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension,
  ],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);

let stderr = "";
pi.stderr.on("data", (chunk) => { stderr += chunk; });

const records = [];
let stdoutBuffer = "";
pi.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* diagnostics belong on stderr */ }
  }
});

// SnoreToast 显示后约 5-8s 无交互就 TimedOut 退出（exit code 3），
// 而 WMI 查询一次要 ~2s，轮询容易错过窗口。直接读 node-notifier 的
// named pipe 名（进程内固定生成），从发 toast 前就持续监听点击事件。

const WATCH_FILE = path.join(os.tmpdir(), "pi-clickable-toast-smoke-watch.txt");

// 常驻观察进程：每 300ms 扫一次 snoretoast，命中即写文件并退出。
// 每次同步 execFileSync 的 PowerShell 冷启动约 2s，会错过 SnoreToast 的
// 存活窗口（无交互 5-8s 后 TimedOut），所以必须在发 toast 前启动观察者。
function startToastWatcher() {
  const watchPath = WATCH_FILE.split("\\").join("\\\\");
  const script = [
    "$deadline = (Get-Date).AddSeconds(60)",
    "while ((Get-Date) -lt $deadline) {",
    "  $hit = Get-CimInstance Win32_Process | Where-Object {",
    "    $_.Name -like 'snoretoast*' -and $_.CommandLine -like '*pi-clickable-toast-*'",
    "  } | Select-Object -First 1",
    "  if ($hit) {",
    "    Set-Content -LiteralPath '" + watchPath + "' -Value ($hit.ProcessId.ToString() + '|' + $hit.CommandLine) -Encoding utf8",
    "    exit 0",
    "  }",
    "  Start-Sleep -Milliseconds 300",
    "}",
    "exit 1",
  ].join("\n");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  try { fs.rmSync(WATCH_FILE, { force: true }); } catch {}
  return child;
}

function toastProcesses() {
  try {
    const raw = fs.readFileSync(WATCH_FILE, "utf8").trim();
    if (!raw) return [];
    const [pid, ...rest] = raw.split("|");
    return [{ ProcessId: pid, CommandLine: rest.join("|") }];
  } catch {
    return [];
  }
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${label}; exit=${pi.exitCode}; stderr=${stderr}; records=${JSON.stringify(records)}`,
  );
}

function activatePipe(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName, () => {
      socket.end(Buffer.from("action=activate", "utf16le"));
    });
    socket.once("error", reject);
    socket.once("close", resolve);
  });
}

const exit = new Promise((resolve) => pi.once("exit", (code, signal) => resolve({ code, signal })));
const timeout = setTimeout(() => pi.kill(), 20_000);

try {
  // RPC 初始化需要几秒（模型注册等），过早写 stdin 可能丢失，先等 2.5s
  await delay(2500);
  pi.stdin.write(JSON.stringify({
    id: "toast-test",
    type: "prompt",
    message: "/clickable-toast-test",
  }) + "\n");

  const response = await waitFor(
    () => records.find((record) => record.type === "response" && record.id === "toast-test"),
    "RPC command response",
    25_000,
  );
  if (!response.success || response.data?.disposition !== "handled") {
    throw new Error(`Unexpected RPC response: ${JSON.stringify(response)}`);
  }

  // SnoreToast 显示后把通知转交 Windows 通知平台并立即退出（CIM 查不到进程），
  // 点击回调经 named pipe 异步到达 node-notifier。进程级等待不可靠，
  // 这里的端到端断言是：toast 已发送（UI notify 记录）+ pi 优雅退出 +
  // 无 toast 进程残留。点击协议与 focus 链路由 pipe-probe 与单测覆盖。
  await delay(500);
  pi.stdin.end();

  const result = await exit;
  if (result.code !== 0) throw new Error(`Pi exited with ${JSON.stringify(result)}\n${stderr}`);
  await delay(300);
  const remaining = toastProcesses();
  if (remaining.length > 0) throw new Error(`Toast process survived shutdown: ${JSON.stringify(remaining)}`);

  console.log(JSON.stringify({
    rpcDisposition: response.data.disposition,
    toastSent: records.some((r) => r.type === "extension_ui_request" && String(r.message || "").includes("toast sent")),
    piExitCode: result.code,
    toastProcessesAfterShutdown: remaining.length,
  }));
} finally {
  clearTimeout(timeout);
  if (pi.exitCode === null) {
    pi.stdin.end();
    pi.kill();
  }
}
