# Media MCP Discord Panel

OpenClaw plugin for the persistent Discord media control panel.

The panel owns Discord component routing, modal handling, message edits, and
polling timers. The `media-mcp` server owns media-stack data normalization,
request previews, gated writes, and request lifecycle status.

The panel renders Discord components locally from the server's neutral
`view`, `candidates`, `requestDraft`, `payloadPreview`, and `followStatus`
payloads. The server should not emit Discord component IDs, modal routes,
message edit instructions, or resident panel state.

See [`CLIENT_CONTRACT.md`](CLIENT_CONTRACT.md) for the exact mapping from MCP
tool payloads to Discord panel controls.

## Live Install

The active OpenClaw plugin path is:

`/Users/server/.openclaw/workspace/openclaw-plugins/plugins/media-mcp-discord-panel`

After changing this repo, copy `index.js`, `package.json`, and
`openclaw.plugin.json` to that path and restart the OpenClaw gateway.

Do not commit `media-panel-state.json`; it is local runtime state for the
resident Discord message.

## Resident Panel Contract

- The resident panel lives in Discord channel `1519062371413262367`.
- The home row order is Status, Search, Queue, Missing, Issues.
- Search opens one modal directly. The modal has a `Type` select (`Movie` or
  `TV`) and a title field.
- Movie searches route to Radarr. TV searches route to Sonarr.
- Search results, previews, option changes, request writes, and follow-up
  status all edit the resident panel in place.
- Search and preview controls are built in this plugin from `requestDraft`
  fields and selected request payloads.
- The panel refreshes itself every 20 minutes so Discord component/modal IDs do
  not expire between normal uses.
- The panel may be manually repaired with `/media panel` or `/media-panel`.
