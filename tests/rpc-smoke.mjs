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

// pi 退出后，等待点击的 helper 进程也应随之结束（否则 pi 崩溃会留下孤儿）。
function helperProcessCount() {
  const raw = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "(Get-Process -Name 'PiToastFocus*' -ErrorAction SilentlyContinue | Measure-Object).Count",
  ], { encoding: "utf8", windowsHide: true });
  return Number(String(raw).trim()) || 0;
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

  await delay(500);
  pi.stdin.end();

  const result = await exit;
  if (result.code !== 0) throw new Error(`Pi exited with ${JSON.stringify(result)}\n${stderr}`);
  await delay(300);

  const leftovers = helperProcessCount();
  if (leftovers > 0) throw new Error(leftovers + " toast helper process(es) survived shutdown");

  console.log(JSON.stringify({
    rpcDisposition: response.data.disposition,
    toastSent: records.some((r) => r.type === "extension_ui_request" && String(r.message || "").includes("toast sent")),
    piExitCode: result.code,
    helperProcessesAfterShutdown: leftovers,
  }));
} finally {
  clearTimeout(timeout);
  if (pi.exitCode === null) {
    pi.stdin.end();
    pi.kill();
  }
}
