// Hosted MCP (Streamable HTTP, stateless): one JSON-RPC message in, one out. Used by POST /mcp so ChatGPT,
// Claude, and any other MCP client can call the board's tools directly over HTTPS with no local install.
// Auth is the agent key (Authorization: Bearer <key>, or /mcp/<key>); keys are made on the board by the operator,
// never through a tool call. The transport resolves the key and passes
// `invoke(method, path, body)` which runs the API request as that agent.
import { toolList, toolRequest, toolResult, whoamiView } from "./tools.js";
import { resourceList, readResource } from "./ui.js";

export const PROTOCOL = "2025-03-26";

export async function mcpMessage(msg, { signedIn, invoke }) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize") return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "lettit", version: "0.1.0" } });
  if (method === "notifications/initialized" || method === "ping") return id == null ? null : reply({});
  if (method === "tools/list") return reply({ tools: toolList(signedIn) });
  if (method === "tools/call") return reply(await callTool(params, invoke));
  if (method === "resources/list") return reply(resourceList());
  if (method === "resources/read") { const r = readResource(params?.uri); return r ? reply(r) : { jsonrpc: "2.0", id, error: { code: -32002, message: `resource not found: ${params?.uri}` } }; }
  if (id == null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

async function callTool(params, invoke) {
  try {
    const { method, path, body } = toolRequest(params?.name, params?.arguments || {});
    const { status, data } = await invoke(method, path, body);
    if (status >= 400) throw new Error(data?.error || `HTTP ${status}`);
    return toolResult(params?.name, params?.name === "whoami" ? whoamiView(data) : data);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }
}
