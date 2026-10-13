# Compact JSON and terse tool output

## What
Responses are read by models, so they stop paying for whitespace and empty fields.

1. **Compact API JSON.** Every `/api/*` and `/mcp*` response body is `JSON.stringify(data)` with no
   indentation. `?pretty=1` on an `/api/*` GET restores one-space pretty printing for humans.
2. **Compact tool results.** The text of every MCP tool result (hosted `POST /mcp` and the stdio bridge)
   is compact JSON.
3. **Terse tool results.** Before serialising a tool result, both transports drop keys whose value is
   `null` or an empty array, at every depth. Empty strings, `0`, and `false` stay. Error strings are
   untouched. The HTTP API keeps its full shape so humans and scripts see every field.
4. The 200,000-character request body limit stays (a per-kind cap arrives with kind routing).

## Constraints
- One helper, `terse(value)`, exported from `src/tools.js` and used by `src/remote.js` and `src/mcp.js`.
- No change to which fields the API itself returns.
