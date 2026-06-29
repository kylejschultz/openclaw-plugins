# Discord Panel Client Contract

This plugin is an optional thin Discord client for `media-mcp`. It renders
Discord Components v2 locally from neutral MCP tool payloads.

## Boundary

`media-mcp` owns:

- media service normalization
- search/options/preview/request/follow workflows
- safety gates
- `view`
- `requestDraft`
- `payloadPreview`
- `followStatus`

This plugin owns:

- Discord component IDs and callback data
- modal routing
- resident panel message state
- message edits
- panel refresh timers
- Discord-specific display text, colors, buttons, selects, and layout

The plugin must not require the server to return top-level `components`.

## Tool Mapping

- Status: `media_stack_overview`, rendered from `view`.
- Queue: `download_queue`, rendered from normalized queue items plus local
  follow controls.
- Missing: `get_missing_summary`, rendered from `view`.
- Issues: `get_import_issues`, rendered from `view`.
- Movie search: `search_movie`, rendered from `candidates` and
  `requestDraft.candidateOptions`.
- Series search: `search_series`, rendered from `candidates` and
  `requestDraft.candidateOptions`.
- Movie preview: `preview_movie_request`, rendered from `view`,
  `requestDraft`, `payloadPreview`, and warnings.
- Series preview: `preview_series_request`, rendered from `view`,
  `requestDraft`, `payloadPreview`, and warnings.
- Request write: `request_movie` or `request_series`, called only from the
  plugin's confirmed callback state.
- Follow status: `request_follow_status`, rendered from `followStatus`.

## State Encoding

The plugin may encode request/follow state into Discord callback payloads using
`media-panel:*` identifiers. Those identifiers are local to the plugin and must
not appear in server responses.

## Request Controls

`requestDraft.formFields` is the source for request option controls:

- `select` fields become Discord string selects.
- `checkbox` fields become local toggle buttons.
- updated values are re-previewed through `preview_movie_request` or
  `preview_series_request`.

When `requestDraft.writeGate.enabled` is false, the plugin shows a dry-run
button and does not attempt a real write. When writes are enabled but preview
warnings exist, the plugin disables the real write button.
