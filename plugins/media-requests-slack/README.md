# Media Requests Slack

Slack-native OpenClaw plugin for requesting movies and TV through the live
`media-mcp` service.

## Flow

- `/media-requests` posts a request panel with Movie and TV buttons.
- Buttons open a Slack modal for title search.
- Search results post back to the channel/thread as a dropdown.
- Selecting a result previews the Radarr/Sonarr request.
- Request options are rendered from `media-mcp.requestDraft.v1`.
- Confirming calls `request_movie` or `request_series` only after preview.
- Follow Status checks `request_follow_status` for the selected title.

## Config

- `mediaMcpUrl` defaults to `http://10.10.10.10:3000/mcp`.
- `panelChannelId` plus `autoPost: true` posts a panel on gateway startup.

The plugin owns Slack UI state only. `media-mcp` remains the source of truth for
search, preview, write gates, request payloads, and lifecycle status.
