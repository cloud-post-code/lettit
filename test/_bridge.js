// Test helper: spawn src/mcp.js over stdio the way Claude Code or Codex would, with the given env.
// onRequest answers server-to-client requests (elicitation/create); default declines them.
import { spawn } from "node:child_process";

export function bridge(base, keyFile, env, { onRequest = async () => ({ action: "decline" }), capabilities = {} } = {}) {
  const child = spawn(process.execPath, ["src/mcp.js"], { env: { ...process.env, LETTIT_URL: base, LETTIT_KEY_FILE: keyFile, LETTIT_KEY: "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", next = 1;
  const waiting = new Map();
  const requests = [];
  const write = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method) { requests.push(msg); onRequest(msg).then((result) => write({ jsonrpc: "2.0", id: msg.id, result })); continue; }
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });
  const initialize = (protocolVersion = "2025-06-18") => rpc("initialize", { protocolVersion, capabilities, clientInfo: { name: "test", version: "0" } });
  const call = async (name, args) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    return [result.isError === true, result.isError ? result.content[0].text : JSON.parse(result.content[0].text)];
  };
  return { rpc, initialize, call, requests, close: () => child.kill() };
}
