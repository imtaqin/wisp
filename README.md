# Wisp — let AI assistants drive your browser

Wisp is a Chrome extension plus a local MCP server. AI clients (Claude Code, Claude Desktop, Hermes, Cline, …) connect to the server and drive real tabs in your real browser: navigate, click, fill, scroll, screenshot, read the DOM, read console logs and network traffic.

DevTools does **not** need to be open. The extension's background service worker owns the WebSocket connections and runs commands through `chrome.debugger` (CDP) and content scripts.

While a tab is being driven, the page shows it: an amber frame around the viewport and a small wisp in the corner that names the action it is performing.

```
AI client ──MCP──► Wisp server (:61822) ──WebSocket──► extension ──CDP──► your tab
```

## Install

### 1. Server

```bash
cd server
npm install
npm run build
```

### 2. Extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → pick the `extension/` folder

### 3. Point your AI client at it

Claude Code:

```bash
claude mcp add wisp -s user -- node /absolute/path/to/wisp/server/dist/bridge.js
```

Any client that reads `mcpServers` config (Claude Desktop, Cline, …):

```json
{
  "mcpServers": {
    "wisp": {
      "command": "node",
      "args": ["/absolute/path/to/wisp/server/dist/bridge.js"]
    }
  }
}
```

A client that speaks WebSocket directly can skip the bridge and connect to `ws://127.0.0.1:61822/mcp`.

### 4. Connect a tab

Click the Wisp icon in the toolbar and flip the toggle, or let **Auto-connect tabs** (on by default) do it for every page that loads.

## The popup

| Control | What it does |
|---|---|
| Connection toggle | Connect or disconnect the current tab |
| Connect all / Disconnect all | Every open `http(s)` tab at once |
| Dashboard | Opens the server's own page at `127.0.0.1:61822` |
| Copy tab ID | The ID clients use to target this tab |
| Reconnect | Drop and reopen this tab's socket |
| Reload ext | Reload the extension after editing it |
| Auto-connect tabs | Connect each tab as its page loads (tabs you switch off stay off) |
| Show mascot | The wisp in the page corner |
| Allow JS by default | Grant script execution on every connect |
| Allow JS in this tab | Per-tab grant; resets on disconnect |

## Settings the server reads

| Variable | Default | Meaning |
|---|---|---|
| `WISP_PORT` | `61822` | Port to listen on |
| `WISP_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` lets other devices reach it — there is **no authentication**, so only on a network you trust |
| `WISP_ALLOWED_ORIGINS` | — | Extra browser origins allowed to call the HTTP/WebSocket API |
| `WISP_DETACHED_SERVER` | auto | `0` forces the bridge to host the server in-process, `1` forces the detached child |
| `WISP_LOG_FILE` | — | Write diagnostics to this file |

## Security

Anyone who can reach the server port can drive every connected tab, with your logged-in sessions. Keep `WISP_HOST` on loopback unless you know what you are exposing, and leave **Allow JS** off for tabs where arbitrary script execution would matter.

## Layout

- `extension/` — the Chrome extension (MV3). `overlay.js` draws the in-page frame, mascot and cursor.
- `server/` — the TypeScript MCP server. Tools are declared in `src/tools.yaml`.
- `e2e/` — end-to-end tests.
- `test-app/` — Electron app that acts as an MCP client for manual testing.
- `website/` — project site.

## Development

```bash
cd server && npm run dev     # hot-reload server
cd server && npm test        # unit tests
cd e2e && npm test           # end-to-end (needs the server and a connected tab)
```

After editing anything in `extension/`, reload it in `chrome://extensions` and refresh the tabs you want it in.

## Credits

Wisp is a rebranded fork of [Kapture](https://github.com/williamkapke/kapture) by William Kapke, used under the MIT License. The original project is the source of the extension/server architecture this builds on. See [LICENSE](LICENSE).

## License

MIT
