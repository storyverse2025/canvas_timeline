# canvas-mcp — drive the canvas from Claude Code / Hermes

External agents (Claude Code, Hermes, anything that speaks MCP) can read
and mutate the running canvas through a bridge:

```
[Claude Code]
   ↓ stdio MCP (JSON-RPC 2.0)
[canvas-mcp-server.mjs]                  ← repo root
   ↕ ws://127.0.0.1:3002
[Browser tab running canvas_timeline]    ← src/lib/mcp-bridge
   ↓
[canvas-api]                             ← src/lib/canvas-api
```

The bridge is bidirectional and transparent: the MCP client sees a flat
list of tools, the browser executes them against canvas-api, and the
result flows back as a JSON text block.

## One-time setup

```bash
# Register the server with Claude Code (or your MCP client of choice).
claude mcp add canvas node /absolute/path/to/canvas-mcp-server.mjs
```

Claude Code now lists 7 `canvas_*` tools whenever a Claude session is
active. The server is launched on demand and exits when the session
closes.

## Each session

1. Start the dev server: `npm run dev`
2. Open the app in a browser tab — the bridge attaches automatically.
3. Start your Claude Code session. The browser shows a connection in
   its console (`[canvas-mcp] bridge connected to ws://localhost:3002`).
4. Ask the agent to read or mutate the canvas:
   - "Show me a snapshot of the canvas"
   - "Find every keyframe whose prompt mentions revolvers"
   - "Regenerate node abc123 with a mecha prompt"

To disable the bridge for a tab, append `?canvasMcp=0` to the URL. To
disable it for an entire build, set `VITE_CANVAS_MCP=0`.

## Tool surface

Every tool maps 1:1 to a canvas-api method. The full schema is in
`canvas-mcp-server.mjs` (`TOOLS` array) and `src/lib/mcp-bridge/dispatch.ts`
— change one, update the other.

| Tool | Returns | Notes |
| --- | --- | --- |
| `canvas_get_snapshot` | `CanvasSnapshot` | Counts + histograms + row list. Cheap. |
| `canvas_search_nodes` | `NodeMatch[]` | Substring + 中英 synonym match against item prompts. |
| `canvas_get_node` | `NodeDetail` | Full item including `versions[]` history. |
| `canvas_add_node` | `NodeDetail` | Creates item + canvas node in one call. |
| `canvas_update_node_prompt` | `NodeDetail` | Versions the old prompt. Does *not* regenerate. |
| `canvas_regenerate_image` | `NodeDetail` | Calls text-to-image. Long-running (up to ~3min). Versions old image+prompt. |
| `canvas_set_keyframe` | `{ok, rowId, nodeId}` | Binds a node as a row's keyframe. |

## Failure modes

- **No browser attached**: tool calls fail immediately with "no browser
  is connected. Open the canvas_timeline app in a browser tab so the
  bridge can attach."
- **Browser disconnects mid-call** (refresh, network blip): in-flight
  tool calls reject with "browser disconnected before tool call
  completed". The browser reconnects with exponential backoff; retry
  the tool call afterwards.
- **Two browsers open the app**: the second connection is refused with
  "canvas-mcp accepts only one browser client at a time". The first
  one keeps the bridge.
- **regenerateImage fails server-side**: the item is left untouched
  (snapshot only after a successful URL is returned). The tool call
  reports the underlying error.

## Versioning

Every mutation that overwrites `content` or `prompt` snapshots the
prior head into `item.versions[]` before applying the change. There is
no "undo" tool exposed yet — the version stack is the source of truth.
For now, an agent can manually read `versions[0]` via `canvas_get_node`
and restore it through `canvas_update_node_prompt` + `canvas_regenerate_image`.

## Ports + env

| Env var | Default | Purpose |
| --- | --- | --- |
| `CANVAS_MCP_WS_PORT` | `3002` | WS port the server listens on. |
| `CANVAS_MCP_TOOL_TIMEOUT_MS` | `180000` | Per-tool deadline before the call rejects. |
| `VITE_CANVAS_MCP` | (unset) | Set to `0` to disable the bridge in the browser. |
