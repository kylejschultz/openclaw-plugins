# Media MCP Discord Panel

OpenClaw plugin for the persistent Discord media control panel.

The panel owns Discord component routing, modal handling, message edits, and
polling timers. The `media-mcp` server owns media-stack data normalization,
request previews, gated writes, and request lifecycle status.

## Live Install

The active OpenClaw plugin path is:

`/Users/server/.openclaw/agents/main/agent/plugins/media-commands`

After changing this repo, copy `index.js`, `package.json`, and
`openclaw.plugin.json` to that path and restart the OpenClaw gateway.

Do not commit `media-panel-state.json`; it is local runtime state for the
resident Discord message.
