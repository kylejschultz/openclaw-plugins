import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const NAMESPACE = "media-requests";
const DEFAULT_MEDIA_MCP_URL = "http://10.10.10.10:3000/mcp";
const MEDIA_MCP_DIR = "/Users/server/.openclaw/workspace/media-mcp";
const VERSION = "0.1.0";
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(PLUGIN_DIR, "media-requests-slack-state.json");
const INTERACTION_STATE_TTL_MS = 30 * 60 * 1000;
const MAX_INLINE_STATE_LENGTH = 72;
let mediaMcpSdkPromise;
const interactionState = new Map();

function cleanupInteractionState() {
  const now = Date.now();
  for (const [key, entry] of interactionState.entries()) {
    if (!entry || entry.expiresAt <= now) interactionState.delete(key);
  }
}

function encodeState(value) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (encoded.length <= MAX_INLINE_STATE_LENGTH) return encoded;
  cleanupInteractionState();
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  interactionState.set(key, { value, expiresAt: Date.now() + INTERACTION_STATE_TTL_MS });
  return `ref:${key}`;
}

function decodeState(value) {
  const raw = String(value ?? "");
  if (raw.startsWith("ref:")) {
    cleanupInteractionState();
    const entry = interactionState.get(raw.slice(4));
    return entry?.value && typeof entry.value === "object" && !Array.isArray(entry.value) ? entry.value : {};
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function actionId(action) {
  return `${NAMESPACE}:${action}`;
}

function mrkdwn(value) {
  return { type: "mrkdwn", text: String(value ?? "") };
}

function plain(value) {
  return { type: "plain_text", text: String(value ?? ""), emoji: true };
}

function truncate(value, max = 280) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function inputValue(inputs, action, key = "inputValue") {
  const found = Array.isArray(inputs) ? inputs.find((entry) => entry?.actionId === action) : undefined;
  const value = found?.[key] ?? found?.value ?? found?.inputValue ?? found?.text ?? "";
  return value ? String(value) : "";
}

function selectedValue(ctx) {
  return Array.isArray(ctx?.interaction?.selectedValues) ? ctx.interaction.selectedValues[0] : undefined;
}

function selectedOrActionValue(ctx) {
  return selectedValue(ctx) ?? ctx?.interaction?.value;
}

async function slackApi(method, body) {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`${method} failed: ${json.error ?? "unknown_error"}`);
  return json;
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(state) {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function ensurePanelMessage(api, reason = "startup") {
  const config = api.pluginConfig ?? {};
  const channel = typeof config.panelChannelId === "string" ? config.panelChannelId.trim() : "";
  if (!channel) return { ok: false, skipped: "panelChannelId is not set" };

  const state = await readState();
  const knownTs = state.channel === channel && typeof state.ts === "string" ? state.ts : "";
  if (knownTs) {
    try {
      const updated = await slackApi("chat.update", { channel, ts: knownTs, ...panelPayload() });
      const nextState = { channel, ts: updated.ts ?? knownTs, updatedAt: new Date().toISOString(), reason, mode: "update" };
      await writeState(nextState);
      return { ok: true, ...nextState };
    } catch (error) {
      api.logger.warn(`media-requests-slack panel update failed; posting replacement: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const posted = await slackApi("chat.postMessage", { channel, ...panelPayload() });
  const nextState = { channel, ts: posted.ts, updatedAt: new Date().toISOString(), reason, mode: "post" };
  await writeState(nextState);
  return { ok: true, ...nextState };
}

async function loadMediaMcpSdk() {
  if (mediaMcpSdkPromise) return mediaMcpSdkPromise;
  mediaMcpSdkPromise = Promise.all([
    import(pathToFileURL(join(MEDIA_MCP_DIR, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js")).href),
    import(pathToFileURL(join(MEDIA_MCP_DIR, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "streamableHttp.js")).href)
  ]).then(([clientModule, transportModule]) => ({
    Client: clientModule.Client,
    StreamableHTTPClientTransport: transportModule.StreamableHTTPClientTransport
  }));
  return mediaMcpSdkPromise;
}

function mediaMcpUrl(config = {}) {
  const configured = typeof config.mediaMcpUrl === "string" ? config.mediaMcpUrl.trim() : "";
  return configured || DEFAULT_MEDIA_MCP_URL;
}

async function callMediaTool(api, name, args = {}) {
  const { Client, StreamableHTTPClientTransport } = await loadMediaMcpSdk();
  const client = new Client({ name: "openclaw-media-requests-slack", version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(mediaMcpUrl(api.pluginConfig ?? {})));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const text = result?.content?.find((entry) => entry?.type === "text" && typeof entry.text === "string")?.text;
    if (result?.isError) throw new Error(text || `${name} failed`);
    return text ? JSON.parse(text) : {};
  } finally {
    await transport.close().catch(() => {});
  }
}

function panelBlocks() {
  return [
    {
      type: "section",
      text: mrkdwn("*Media Requests*\nSearch Radarr or Sonarr, preview the exact request, then confirm.")
    },
    {
      type: "actions",
      block_id: "media_requests_movie",
      elements: [
        {
          type: "button",
          text: plain("Request Movie"),
          style: "primary",
          action_id: actionId("open-search"),
          value: "movie"
        }
      ]
    },
    {
      type: "actions",
      block_id: "media_requests_tv",
      elements: [
        {
          type: "button",
          text: plain("Request TV"),
          action_id: actionId("open-search"),
          value: "series"
        }
      ]
    }
  ];
}

function panelPayload() {
  return {
    text: "Media Requests",
    blocks: panelBlocks(),
    unfurl_links: false,
    unfurl_media: false
  };
}

function searchModal({ kind, channelId, threadTs, userId }) {
  const isSeries = kind === "series";
  const metadata = {
    channelId,
    channelType: "channel",
    userId,
    pluginInteractiveData: `${NAMESPACE}:submit-search:${kind}:${encodeState({ channelId, threadTs })}`
  };
  return {
    type: "modal",
    callback_id: `openclaw:${NAMESPACE}:submit-search:${kind}`,
    private_metadata: JSON.stringify(metadata),
    title: plain(isSeries ? "Search TV" : "Search Movies"),
    submit: plain("Search"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "query_block",
        label: plain(isSeries ? "Series title" : "Movie title"),
        element: {
          type: "plain_text_input",
          action_id: "query",
          placeholder: plain(isSeries ? "Foundation" : "Iron Man")
        }
      }
    ]
  };
}

function candidateId(kind, candidate) {
  return kind === "series" ? Number(candidate?.tvdbId) : Number(candidate?.tmdbId);
}

function candidateLabel(candidate) {
  const title = String(candidate?.title ?? "Untitled");
  return truncate(candidate?.year ? `${title} (${candidate.year})` : title, 75);
}

function candidateDescription(kind, candidate) {
  return truncate([
    candidate?.alreadyExists || candidate?.isExisting ? `Already in ${kind === "series" ? "Sonarr" : "Radarr"}` : undefined,
    kind === "series" ? candidate?.network : candidate?.certification,
    Array.isArray(candidate?.genres) ? candidate.genres.slice(0, 2).join(", ") : undefined
  ].filter(Boolean).join(" | "), 75);
}

function searchResultBlocks({ kind, query, result }) {
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const defaults = result?.requestDraft?.defaults && typeof result.requestDraft.defaults === "object"
    ? result.requestDraft.defaults
    : {};
  const options = candidates.slice(0, 25).map((candidate) => {
    const id = candidateId(kind, candidate);
    if (!id) return undefined;
    const request = {
      kind,
      ...(kind === "series" ? { tvdbId: Number(id) } : { tmdbId: Number(id) }),
      ...defaults
    };
    return {
      text: plain(candidateLabel(candidate)),
      value: encodeState({ kind, id }),
      ...(candidateDescription(kind, candidate) ? { description: plain(candidateDescription(kind, candidate)) } : {})
    };
  }).filter(Boolean);
  const isSeries = kind === "series";
  if (!options.length) {
    return [
      { type: "section", text: mrkdwn(`*No ${isSeries ? "TV" : "movie"} results for:* ${truncate(query, 120)}`) },
      ...panelBlocks().slice(1)
    ];
  }
  return [
    {
      type: "section",
      text: mrkdwn(`*${isSeries ? "TV" : "Movie"} search results*\n${truncate(result?.summary ?? `Pick the exact match for "${query}".`, 250)}`)
    },
    {
      type: "actions",
      block_id: "media_request_results",
      elements: [
        {
          type: "static_select",
          action_id: actionId("preview"),
          placeholder: plain(isSeries ? "Choose a series" : "Choose a movie"),
          options
        }
      ]
    },
    ...panelBlocks().slice(1)
  ];
}

function optionLabel(options, id, fallback) {
  if (!Array.isArray(options)) return fallback;
  const match = options.find((option) =>
    String(option?.id ?? "") === String(id)
    || Number(option?.id) === Number(id)
    || String(option?.path ?? "") === String(id)
    || String(option?.value ?? "") === String(id)
  );
  return match?.label ?? match?.name ?? match?.path ?? fallback;
}

function requestState(result) {
  const draft = result?.requestDraft && typeof result.requestDraft === "object" ? result.requestDraft : {};
  const request = draft.request && typeof draft.request === "object" ? draft.request : {};
  return { draft, request };
}

function fieldValue(request, field) {
  const id = String(field?.id ?? "");
  if (!id) return "";
  const value = request[id] ?? field.value ?? "";
  return Array.isArray(value) ? value.map(String) : String(value);
}

function previewOptionElements(draft, request) {
  const fields = Array.isArray(draft?.formFields) ? draft.formFields : [];
  return fields.flatMap((field) => {
    const id = String(field?.id ?? "");
    if (!id) return [];
    if (field.type === "select" && Array.isArray(field.options) && field.options.length) {
      const current = fieldValue(request, field);
      const options = field.options.slice(0, 25).map((option) => ({
        text: plain(truncate(option.label ?? option.name ?? option.path ?? option.value, 75)),
        value: encodeState({ request, fieldId: id, value: option.value ?? option.id ?? option.path }),
        ...(option.description ? { description: plain(truncate(option.description, 75)) } : {})
      }));
      const initial = options.find((option) => {
        const state = decodeState(option.value);
        return String(state.value ?? "") === current;
      });
      return [{
        type: "static_select",
        action_id: actionId("option"),
        placeholder: plain(truncate(field.label ?? id, 75)),
        options,
        ...(initial ? { initial_option: initial } : {})
      }];
    }
    if (field.type === "checkbox") {
      const enabled = request[id] !== false;
      return [{
        type: "button",
        text: plain(`${truncate(field.label ?? id, 55)}: ${enabled ? "On" : "Off"}`),
        action_id: actionId("toggle"),
        value: encodeState({ request, fieldId: id }),
        ...(enabled ? { style: "primary" } : {})
      }];
    }
    return [];
  });
}

function previewBlocks(result) {
  const { draft, request } = requestState(result);
  const kind = draft.kind === "series" || request.tvdbId ? "series" : "movie";
  const candidate = draft.selectedCandidate && typeof draft.selectedCandidate === "object" ? draft.selectedCandidate : {};
  const title = candidateLabel(candidate);
  const writeEnabled = Boolean(draft?.writeGate?.enabled);
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const quality = optionLabel(draft.qualityProfileOptions, request.qualityProfileId, request.qualityProfileId ?? "default");
  const root = optionLabel(draft.rootFolderOptions, request.rootFolderPath, request.rootFolderPath ?? "default");
  const monitor = optionLabel(draft.monitorOptions, request.monitorMode, request.monitorMode ?? "all");
  const details = [
    `Quality: ${quality}`,
    `Root: ${root}`,
    kind === "series" ? `Monitor: ${monitor}` : `Monitored: ${request.monitored !== false ? "yes" : "no"}`,
    kind === "series" ? `Season folders: ${request.seasonFolder !== false ? "yes" : "no"}` : undefined,
    `Search now: ${request.searchNow !== false ? "yes" : "no"}`,
    warnings[0] ? `Warning: ${warnings[0]}` : undefined,
    !writeEnabled ? "Requests are currently dry-run only; ALLOW_REQUESTS is false." : undefined
  ].filter(Boolean).join("\n");
  const optionElements = previewOptionElements(draft, request);
  const blocks = [
    {
      type: "section",
      text: mrkdwn(`*${kind === "series" ? "TV" : "Movie"} request preview: ${truncate(title, 120)}*\n${truncate(result?.summary ?? "Preview ready.", 240)}\n\`\`\`${details}\`\`\``)
    }
  ];
  for (let i = 0; i < optionElements.length; i += 5) {
    blocks.push({ type: "actions", block_id: `media_request_options_${i}`, elements: optionElements.slice(i, i + 5) });
  }
  blocks.push({
    type: "actions",
    block_id: "media_request_confirm",
    elements: [
      {
        type: "button",
        text: plain(writeEnabled ? `Confirm ${kind === "series" ? "TV" : "Movie"} Request` : "Dry Run Only"),
        action_id: actionId("request"),
        value: encodeState({ request }),
        ...(writeEnabled && warnings.length === 0 ? { style: "primary" } : {})
      },
      {
        type: "button",
        text: plain("Follow Status"),
        action_id: actionId("follow"),
        value: encodeState({
          service: kind === "series" ? "sonarr" : "radarr",
          tmdbId: request.tmdbId,
          tvdbId: request.tvdbId,
          title: candidate.title,
          year: candidate.year
        })
      }
    ]
  });
  blocks.push(...panelBlocks().slice(1));
  return blocks;
}

async function previewForRequest(api, request) {
  const hydrated = await hydrateRequest(api, request);
  if (hydrated?.kind === "series" || hydrated?.tvdbId) {
    return callMediaTool(api, "preview_series_request", {
      tvdbId: Number(hydrated.tvdbId),
      qualityProfileId: Number(hydrated.qualityProfileId),
      rootFolderPath: String(hydrated.rootFolderPath ?? ""),
      monitorMode: String(hydrated.monitorMode ?? "all"),
      seasonFolder: hydrated.seasonFolder !== false,
      searchNow: hydrated.searchNow !== false,
      tagIds: Array.isArray(hydrated.tagIds) ? hydrated.tagIds.map(Number).filter(Number.isFinite) : []
    });
  }
  return callMediaTool(api, "preview_movie_request", {
    tmdbId: Number(hydrated.tmdbId),
    qualityProfileId: Number(hydrated.qualityProfileId),
    rootFolderPath: String(hydrated.rootFolderPath ?? ""),
    monitored: hydrated.monitored !== false,
    searchNow: hydrated.searchNow !== false,
    tagIds: Array.isArray(hydrated.tagIds) ? hydrated.tagIds.map(Number).filter(Number.isFinite) : []
  });
}

async function hydrateRequest(api, request) {
  const kind = request?.kind === "series" || request?.tvdbId ? "series" : "movie";
  const options = await callMediaTool(api, kind === "series" ? "sonarr_request_options" : "radarr_request_options");
  const defaults = options?.requestDraft?.defaults && typeof options.requestDraft.defaults === "object"
    ? options.requestDraft.defaults
    : {};
  const hydrated = { kind, ...defaults, ...(request && typeof request === "object" ? request : {}) };
  if (!Number.isFinite(Number(hydrated.qualityProfileId))) {
    throw new Error(`${kind === "series" ? "Sonarr" : "Radarr"} has no usable quality profile for this request.`);
  }
  if (!String(hydrated.rootFolderPath ?? "").trim()) {
    throw new Error(`${kind === "series" ? "Sonarr" : "Radarr"} has no usable root folder for this request.`);
  }
  return hydrated;
}

async function previewForSelection(api, state) {
  if (state.request && typeof state.request === "object") return previewForRequest(api, state.request);

  const kind = state.kind === "series" ? "series" : "movie";
  const request = {
    kind,
    ...(kind === "series" ? { tvdbId: Number(state.id) } : { tmdbId: Number(state.id) })
  };
  return previewForRequest(api, request);
}

function requestKind(request) {
  return request?.kind === "series" || request?.tvdbId ? "series" : "movie";
}

async function requestMedia(api, request) {
  const kind = requestKind(request);
  const preview = await previewForRequest(api, request);
  const input = preview?.requestDraft?.request;
  if (!preview?.requestDraft?.writeGate?.enabled) return { preview, result: undefined, dryRun: true };
  if (!input || typeof input !== "object") throw new Error("Preview did not return a request payload.");
  const result = kind === "series"
    ? await callMediaTool(api, "request_series", input)
    : await callMediaTool(api, "request_movie", input);
  return { preview, result, dryRun: false };
}

function requestResultBlocks({ request, preview, result, dryRun }) {
  const kind = requestKind(request);
  const candidate = preview?.requestDraft?.selectedCandidate ?? {};
  const title = result?.series?.title ?? result?.movie?.title ?? candidate.title ?? "Selected title";
  const summary = dryRun
    ? "Dry run only. ALLOW_REQUESTS is false on media-mcp."
    : (result?.summary ?? `${title} was requested.`);
  return [
    { type: "section", text: mrkdwn(`*${dryRun ? "Request previewed" : "Request submitted"}: ${truncate(title, 120)}*\n${truncate(summary, 400)}`) },
    {
      type: "actions",
      block_id: "media_request_after_submit",
      elements: [
        {
          type: "button",
          text: plain("Follow Status"),
          action_id: actionId("follow"),
          value: encodeState({
            service: kind === "series" ? "sonarr" : "radarr",
            tmdbId: request.tmdbId,
            tvdbId: request.tvdbId,
            title,
            year: result?.series?.year ?? result?.movie?.year ?? candidate.year
          })
        }
      ]
    },
    ...panelBlocks().slice(1)
  ];
}

function followBlocks(status) {
  const follow = status?.followStatus ?? {};
  const lines = [
    `Phase: ${follow.phase ?? "unknown"}`,
    `Complete: ${follow.complete ? "yes" : "no"}`,
    follow.expectedEpisodeCount ? `Episodes: ${follow.importedCount ?? 0}/${follow.expectedEpisodeCount}` : undefined,
    follow.queueCount !== undefined ? `Queue items: ${follow.queueCount}` : undefined,
    follow.historyCount !== undefined ? `History rows: ${follow.historyCount}` : undefined
  ].filter(Boolean).join("\n");
  return [
    { type: "section", text: mrkdwn(`*Request status: ${truncate(follow.title ?? status?.summary ?? "Media request", 120)}*\n${truncate(status?.summary ?? "Status checked.", 300)}\n\`\`\`${lines}\`\`\``) },
    ...panelBlocks().slice(1)
  ];
}

async function handleOpenSearch(api, ctx, kind) {
  const triggerId = ctx?.interaction?.triggerId;
  if (!triggerId) {
    await ctx.respond.reply({ text: "Could not open the search modal from this click.", responseType: "ephemeral" });
    return;
  }
  await slackApi("views.open", {
    trigger_id: triggerId,
    view: searchModal({
      kind: kind === "series" ? "series" : "movie",
      channelId: ctx?.conversationId,
      threadTs: ctx?.interaction?.threadTs || ctx?.interaction?.messageTs,
      userId: ctx?.senderId
    })
  });
}

async function postSearchResults(api, ctx, payload) {
  const parts = payload.split(":");
  const kind = parts[0] === "series" ? "series" : "movie";
  const state = decodeState(parts.slice(1).join(":"));
  const query = inputValue(ctx?.interaction?.inputs, "query");
  if (!query) throw new Error("Search modal is missing a title.");
  const channel = state.channelId || ctx?.conversationId;
  if (!channel) throw new Error("Search modal is missing a destination channel.");
  const pending = await slackApi("chat.postMessage", {
    channel,
    text: `Searching ${kind === "series" ? "TV" : "movies"} for ${query}...`,
    unfurl_links: false,
    unfurl_media: false
  });
  const result = await callMediaTool(api, kind === "series" ? "search_series" : "search_movie", { query, limit: 10 });
  const blocks = searchResultBlocks({ kind, query, result });
  await slackApi("chat.update", {
    channel,
    ts: pending.ts,
    text: `${kind === "series" ? "TV" : "Movie"} search results for ${query}`,
    blocks,
    unfurl_links: false,
    unfurl_media: false
  });
}

function submitSearchInBackground(api, ctx, value) {
  const channelId = ctx?.conversationId;
  postSearchResults(api, ctx, value).catch(async (error) => {
    const text = `Media request search failed: ${error instanceof Error ? error.message : String(error)}`;
    if (channelId) await slackApi("chat.postMessage", { channel: channelId, text }).catch(() => {});
    api.logger.warn(text);
  });
}

async function handlePreview(api, ctx) {
  const state = decodeState(selectedOrActionValue(ctx));
  const preview = await previewForSelection(api, state);
  await ctx.respond.editMessage({
    text: "Media request preview",
    blocks: previewBlocks(preview)
  });
}

async function handleOption(api, ctx) {
  const state = decodeState(selectedOrActionValue(ctx));
  const request = { ...(state.request ?? {}), [state.fieldId]: state.value };
  const preview = await previewForRequest(api, request);
  await ctx.respond.editMessage({ text: "Media request preview", blocks: previewBlocks(preview) });
}

async function handleToggle(api, ctx, encoded) {
  const state = decodeState(encoded);
  const current = state.request?.[state.fieldId] !== false;
  const request = { ...(state.request ?? {}), [state.fieldId]: !current };
  const preview = await previewForRequest(api, request);
  await ctx.respond.editMessage({ text: "Media request preview", blocks: previewBlocks(preview) });
}

async function handleRequest(api, ctx, encoded) {
  const state = decodeState(encoded);
  const request = state.request ?? {};
  const requested = await requestMedia(api, request);
  await ctx.respond.editMessage({
    text: requested.dryRun ? "Media request dry run" : "Media request submitted",
    blocks: requestResultBlocks({ request, ...requested })
  });
}

async function handleFollow(api, ctx, encoded) {
  const state = decodeState(encoded);
  const status = await callMediaTool(api, "request_follow_status", {
    service: state.service === "sonarr" ? "sonarr" : "radarr",
    tmdbId: Number(state.tmdbId) || undefined,
    tvdbId: Number(state.tvdbId) || undefined,
    title: state.title || undefined,
    year: Number(state.year) || undefined
  });
  await ctx.respond.editMessage({ text: "Media request status", blocks: followBlocks(status) });
}

function parsePayload(payload) {
  const raw = String(payload ?? "");
  const prefix = `${NAMESPACE}:`;
  const body = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const separator = body.indexOf(":");
  return separator === -1
    ? { action: body, value: "" }
    : { action: body.slice(0, separator), value: body.slice(separator + 1) };
}

function registerInteractive(api) {
  api.registerInteractiveHandler({
    channel: "slack",
    namespace: NAMESPACE,
    handler: async (ctx) => {
      const { action, value } = parsePayload(ctx?.interaction?.payload);
      try {
        if (action === "open-search") await handleOpenSearch(api, ctx, value);
        else if (action === "submit-search") submitSearchInBackground(api, ctx, value);
        else if (action === "preview") await handlePreview(api, ctx);
        else if (action === "option") await handleOption(api, ctx);
        else if (action === "toggle") await handleToggle(api, ctx, value);
        else if (action === "request") await handleRequest(api, ctx, value);
        else if (action === "follow") await handleFollow(api, ctx, value);
        else return { handled: false };
        return { handled: true };
      } catch (error) {
        const text = `Media request action failed: ${error instanceof Error ? error.message : String(error)}`;
        if (ctx?.interaction?.kind === "view_submission") {
          const channelId = ctx?.conversationId;
          if (channelId) await slackApi("chat.postMessage", { channel: channelId, text }).catch(() => {});
        } else {
          await ctx.respond.reply({ text, responseType: "ephemeral" }).catch(() => {});
        }
        return { handled: true };
      }
    }
  });
}

function registerCommand(api) {
  api.registerCommand({
    name: "media-requests",
    description: "Post the Slack media request panel.",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const result = await ensurePanelMessage(api, "command");
      return {
        continueAgent: false,
        text: result.ok
          ? `Media request panel ${result.mode === "update" ? "refreshed" : "posted"}.`
          : `Media request panel skipped: ${result.skipped ?? "unknown reason"}.`
      };
    }
  });
}

async function verifyMediaMcpDependency() {
  await readFile(join(MEDIA_MCP_DIR, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js"));
}

export default definePluginEntry({
  id: "media-requests-slack",
  name: "Media Requests Slack",
  version: VERSION,
  register(api) {
    registerInteractive(api);
    registerCommand(api);
    verifyMediaMcpDependency().catch((error) => {
      api.logger.warn(`media-requests-slack dependency check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const config = api.pluginConfig ?? {};
    if (config.autoPost === true && typeof config.panelChannelId === "string" && config.panelChannelId.trim()) {
      ensurePanelMessage(api, "startup").catch((error) => {
        api.logger.warn(`media-requests-slack autopost failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
});
