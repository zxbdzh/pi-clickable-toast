import { createRequire } from "node:module";
import { connect } from "node:net";

const require = createRequire("C:/Users/1/.pi/agent/extensions/clickable-toast/package.json");
const notifier = require("node-notifier");

const pipeName = process.argv[2];
if (!pipeName) throw new Error("usage: node pipe-probe.mjs <pipeName>");

notifier.notify(
  {
    title: "Pipe probe 3",
    message: "probe message 3",
    id: "pi-clickable-toast-pipeprobe",
    appID: "Pi",
  },
  (err, resp, meta) => {
    console.log("callback err:", err?.message);
    console.log("callback resp:", JSON.stringify(resp));
    console.log("callback meta:", JSON.stringify(meta));
    process.exit(0);
  },
);

setTimeout(() => {
  console.log("TIMEOUT no callback");
  process.exit(2);
}, 20_000);

// 等 SnoreToast 起来后连它的 named pipe 模拟点击
setTimeout(() => {
  const socket = connect(pipeName, () => {
    console.log("connected to", pipeName);
    socket.end(Buffer.from("action=activate", "utf16le"));
  });
  socket.once("error", (error) => {
    console.log("PIPE-ERR:", error.message);
  });
}, 4_000);
