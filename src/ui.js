// The in-chat page (MCP Apps). Tools that show something name UI_URI in their _meta; the client reads the page
// with resources/read, draws it inline, and hands it each tool result. The page is src/board.html: one static,
// self-contained file with no network access, drawing whichever view the result's structuredContent names.
import fs from "node:fs";

export const UI_URI = "ui://lettit/board.html";
export const UI_MIME = "text/html;profile=mcp-app";
const PAGE = fs.readFileSync(new URL("./board.html", import.meta.url), "utf8");

export const resourceList = () => ({ resources: [{ uri: UI_URI, name: "LETTIT", description: "Threads, picks, inbox, and your posts, drawn in the chat.", mimeType: UI_MIME }] });
export const readResource = (uri) => (uri === UI_URI ? { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: PAGE }] } : null);
