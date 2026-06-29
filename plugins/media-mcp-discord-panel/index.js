import { homedir } from "node:os";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const ACTIONS = new Set(["status", "panel", "search", "series", "queue", "issues", "indexers", "missing", "history"]);
const PANEL_ACTIONS = new Set(["status", "missing", "queue", "issues", "reset"]);
const DEFAULT_PANEL_CHANNEL_ID = "1519062371413262367";
const DEFAULT_MEDIA_MCP_URL = "http://127.0.0.1:3300/mcp";
const MEDIA_MCP_DIR = "/Users/server/.openclaw/workspace/media-mcp";
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(PLUGIN_DIR, "media-panel-state.json");
let discordRuntimeApiPromise;
let mediaMcpSdkPromise;
let panelAutoResetTimer;
let panelRequestFollowTimer;

const PANEL_AUTO_RESET_MS = 20 * 60 * 1000;
const PANEL_REPAIR_INTERVAL_MS = 20 * 60 * 1000;
const REQUEST_FOLLOW_INTERVAL_MS = 15 * 1000;
const REQUEST_FOLLOW_MAX_POLLS = 80;
const DISCORD_COMPONENTS_V2_FLAG = 32768;

const GUIDANCE = [
  {
    surfaces: ["openclaw_main", "codex_app_server"],
    text: [
      "When the user invokes /media, parse the first word as the media action and the rest as action input. Example: `/media search matrix` means action `search` with query `matrix`.",
      "- status or empty: run media_stack_overview and show a compact Discord-friendly component/status view when possible.",
      "- search <query>: run search_movie with the query text after `search`, and render selectable movie results from the neutral `candidates`, `requestDraft`, and `view` payloads.",
      "- series <query>: run search_series with the query text after `series`, and render selectable series results from the neutral `candidates`, `requestDraft`, and `view` payloads.",
      "- queue: run download_queue and summarize Sonarr, Radarr, Lidarr, and SABnzbd queue items.",
      "- issues: run get_import_issues and service_health, then summarize actionable issues.",
      "- indexers: run indexer_status and summarize enabled, disabled, failed, or warning indexers.",
      "- missing: run get_missing_summary and summarize wanted/missing media.",
      "- history: run recent_activity and summarize recent stack activity.",
      "- panel: repair or refresh the persistent Discord Components v2 media control panel.",
      "For Discord responses, prefer OpenClaw presentation/components by rendering the MCP tool's neutral `view` and `requestDraft` payloads; keep a concise text fallback for surfaces that cannot render components.",
      "Do not paste raw component JSON into the visible message. Use the supported Discord component send path when available, and fall back to the text summary otherwise.",
      "If no action is provided, default to status."
    ].join("\n")
  }
];

function parseMediaInput(ctx) {
  const values = ctx?.commandBody?.values ?? ctx?.values;
  const actionValue = typeof values?.action === "string" ? values.action.trim() : "";
  const inputValue = typeof values?.input === "string" ? values.input.trim() : "";
  const queryValue = typeof values?.query === "string" ? values.query.trim() : "";
  if (actionValue) return parseRawMediaInput([actionValue, inputValue || queryValue].filter(Boolean).join(" "));

  const structuredInput = typeof values?.input === "string" ? values.input.trim() : "";
  const legacyAction = typeof values?.action === "string" ? values.action.trim() : "";
  const legacyQuery = typeof values?.query === "string" ? values.query.trim() : "";
  if (structuredInput) return parseRawMediaInput(structuredInput);
  if (legacyAction) return { action: legacyAction.toLowerCase(), input: legacyQuery };
  const raw = typeof ctx?.args === "string" ? ctx.args : "";
  return parseRawMediaInput(raw);
}

function parseRawMediaInput(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { action: "status", input: "" };
  const [first = "", ...rest] = trimmed.split(/\s+/);
  const action = first.toLowerCase();
  if (!ACTIONS.has(action)) return { action: "status", input: trimmed };
  return { action, input: rest.join(" ").trim() };
}

function mediaPanelReply() {
  return {
    continueAgent: false,
    text: "Repairing the persistent media panel..."
  };
}

function panelButton(label, action, style = "secondary", emoji) {
  return {
    label,
    style,
    ...(emoji ? { emoji } : {}),
    reusable: true,
    callbackData: `media-panel:${action}`,
    callbackDataKind: "callback"
  };
}

function searchModalSpec(triggerLabel = "Search", options = {}) {
  const kind = options.kind === "series" ? "series" : options.kind === "movie" ? "movie" : "media";
  const triggerStyle = options.triggerStyle === "success" ? "success"
    : options.triggerStyle === "secondary" ? "secondary"
      : options.triggerStyle === "danger" ? "danger"
        : "primary";
  const titleField = {
    type: "text",
    name: "query",
    label: kind === "series" ? "Series title" : kind === "movie" ? "Movie title" : "Title",
    placeholder: kind === "series" ? "Foundation" : kind === "movie" ? "The Matrix" : "Alien, Foundation, Sugar",
    required: true,
    minLength: 1,
    maxLength: 120
  };
  return {
    title: kind === "series" ? "Search Series" : kind === "movie" ? "Search Movies" : "Search Media",
    triggerLabel,
    triggerStyle,
    callbackData: kind === "series" ? "media-panel:series-search" : kind === "movie" ? "media-panel:movie-search" : "media-panel:search",
    fields: kind === "media" ? [
      {
        type: "select",
        name: "kind",
        label: "Type",
        required: true,
        minValues: 1,
        maxValues: 1,
        options: [
          { label: "Movie", value: "movie" },
          { label: "TV", value: "series" }
        ]
      },
      titleField
    ] : [titleField]
  };
}

function panelComponents() {
  return {
    panelHome: true,
    reusable: true,
    container: { accentColor: "#2f81f7" },
    text: [
      "## Media Stack",
      "Pick an action. Search opens a request form."
    ].join("\n"),
    blocks: [
      {
        type: "actions",
        buttons: [
          panelButton("Status", "status", "primary", "📊"),
          panelButton("Search", "search-kind", "success", "🔎"),
          panelButton("Queue", "queue", "secondary", "⏳"),
          panelButton("Missing", "missing", "primary", "🧩"),
          panelButton("Issues", "issues", "danger", "🚨")
        ]
      }
    ],
    modal: searchModalSpec("Search", { triggerStyle: "success" })
  };
}

function movieSearchPanelComponents() {
  return {
    reusable: true,
    container: { accentColor: "#2f81f7" },
    text: [
      "## Movie Search",
      "Search for a movie to add through Radarr."
    ].join("\n"),
    blocks: [movieFooterBlock()],
    modal: searchModalSpec("Search Movies", { kind: "movie" })
  };
}

function seriesSearchPanelComponents() {
  return {
    reusable: true,
    container: { accentColor: "#2f81f7" },
    text: [
      "## TV Search",
      "Search for a series to add through Sonarr."
    ].join("\n"),
    blocks: [movieFooterBlock()],
    modal: searchModalSpec("Search TV", { kind: "series" })
  };
}

function truncateText(value, maxLength = 240) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function panelFooterButtons(action = "status") {
  const refreshAction = action === "reset" ? "status" : action;
  return {
    type: "actions",
    buttons: [
      panelButton("Reset", "reset"),
      panelButton("Refresh", refreshAction, "primary")
    ]
  };
}

function movieFooterBlock() {
  return {
    type: "actions",
    buttons: [
      panelButton("Reset", "reset")
    ]
  };
}

function encodePanelRequestState(request) {
  const kind = request?.tvdbId ? "series" : "movie";
  const normalized = {
    kind,
    tmdbId: Number(request?.tmdbId),
    tvdbId: Number(request?.tvdbId),
    qualityProfileId: Number(request?.qualityProfileId),
    rootFolderPath: String(request?.rootFolderPath ?? ""),
    monitored: request?.monitored !== false,
    monitorMode: String(request?.monitorMode ?? "all"),
    seasonFolder: request?.seasonFolder !== false,
    searchNow: request?.searchNow !== false,
    tagIds: Array.isArray(request?.tagIds) ? request.tagIds.map(Number).filter(Number.isFinite) : []
  };
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

function optionalPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function encodePanelFollowState(track) {
  const service = track?.service === "sonarr" ? "sonarr" : "radarr";
  const normalized = {
    service,
    tmdbId: optionalPositiveNumber(track?.tmdbId),
    tvdbId: optionalPositiveNumber(track?.tvdbId),
    title: String(track?.title ?? ""),
    year: optionalPositiveNumber(track?.year),
    expectedEpisodeCount: optionalPositiveNumber(track?.expectedEpisodeCount),
    monitorMode: typeof track?.monitorMode === "string" ? track.monitorMode : undefined,
    polls: Number(track?.polls ?? 0)
  };
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

function decodePanelRequestState(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value ?? ""), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || (!Number(parsed.tmdbId) && !Number(parsed.tvdbId))) return undefined;
    const kind = parsed.kind === "series" || Number(parsed.tvdbId) ? "series" : "movie";
    return {
      kind,
      tmdbId: Number(parsed.tmdbId),
      tvdbId: Number(parsed.tvdbId),
      qualityProfileId: Number(parsed.qualityProfileId),
      rootFolderPath: String(parsed.rootFolderPath ?? ""),
      monitored: parsed.monitored !== false,
      monitorMode: String(parsed.monitorMode ?? "all"),
      seasonFolder: parsed.seasonFolder !== false,
      searchNow: parsed.searchNow !== false,
      tagIds: Array.isArray(parsed.tagIds) ? parsed.tagIds.map(Number).filter(Number.isFinite) : []
    };
  } catch {
    return undefined;
  }
}

function decodePanelFollowState(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value ?? ""), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const title = String(parsed.title ?? "");
    if (!Number(parsed.tmdbId) && !Number(parsed.tvdbId) && !title) return undefined;
    return {
      service: parsed.service === "sonarr" || Number(parsed.tvdbId) ? "sonarr" : "radarr",
      tmdbId: optionalPositiveNumber(parsed.tmdbId),
      tvdbId: optionalPositiveNumber(parsed.tvdbId),
      title,
      year: optionalPositiveNumber(parsed.year),
      expectedEpisodeCount: optionalPositiveNumber(parsed.expectedEpisodeCount),
      monitorMode: typeof parsed.monitorMode === "string" ? parsed.monitorMode : undefined,
      polls: Number(parsed.polls ?? 0)
    };
  } catch {
    return undefined;
  }
}

function requestStateCallback(action, request) {
  return `media-panel:${action}:${encodePanelRequestState(request)}`;
}

function followStateCallback(track) {
  return `media-panel:follow:${encodePanelFollowState(track)}`;
}

function requestKind(request) {
  return request?.kind === "series" || Number(request?.tvdbId) ? "series" : "movie";
}

function requestEntityId(request) {
  return requestKind(request) === "series" ? Number(request?.tvdbId) : Number(request?.tmdbId);
}

function requestEntityLabel(request) {
  return requestKind(request) === "series" ? "series" : "movie";
}

function moviePreviewActionBlock(request, writeEnabled = false, disabled = false) {
  const label = requestEntityLabel(request);
  return {
    type: "actions",
    buttons: [
      {
        label: writeEnabled ? `Request ${label}` : "Dry run request",
        style: writeEnabled ? "success" : "secondary",
        reusable: true,
        disabled,
        callbackData: requestStateCallback("request", request),
        callbackDataKind: "callback"
      },
      panelButton("Reset", "reset")
    ]
  };
}

function panelWorkingComponents(label) {
  return {
    reusable: true,
    container: { accentColor: "#9a6700" },
    text: [
      "## Media Stack",
      `${label}...`
    ].join("\n"),
    blocks: [
      {
        type: "actions",
        buttons: [
          { ...panelButton("Working", "reset"), disabled: true },
          panelButton("Reset", "reset")
        ]
      }
    ]
  };
}

function clearPanelAutoReset() {
  if (!panelAutoResetTimer) return;
  clearTimeout(panelAutoResetTimer);
  panelAutoResetTimer = undefined;
}

function clearPanelRequestFollow() {
  if (!panelRequestFollowTimer) return;
  clearTimeout(panelRequestFollowTimer);
  panelRequestFollowTimer = undefined;
}

function schedulePanelAutoReset(api, reason) {
  clearPanelAutoReset();
  panelAutoResetTimer = setTimeout(() => {
    panelAutoResetTimer = undefined;
    editResidentPanel(api, panelComponents(), `auto-reset:${reason}`).catch((error) => {
      api.logger.warn(`media panel auto reset failed: ${String(error)}`);
    });
  }, PANEL_AUTO_RESET_MS);
}

function schedulePanelRequestFollow(api, track) {
  clearPanelRequestFollow();
  const nextPolls = Number(track?.polls ?? 0) + 1;
  if (nextPolls > REQUEST_FOLLOW_MAX_POLLS) return;
  panelRequestFollowTimer = setTimeout(() => {
    panelRequestFollowTimer = undefined;
    updatePanelFromFollow(api, { ...track, polls: nextPolls }, { scheduled: true }).catch((error) => {
      api.logger.warn(`media panel request follow failed: ${String(error)}`);
    });
  }, REQUEST_FOLLOW_INTERVAL_MS);
}

function panelErrorComponents(action, error) {
  return {
    reusable: true,
    container: { accentColor: "#d1242f" },
    text: [
      "## Media Stack",
      `**${actionLabel(action)} failed**`,
      truncateText(error instanceof Error ? error.message : String(error), 1500)
    ].join("\n"),
    blocks: [panelFooterButtons(action)]
  };
}

function actionLabel(action) {
  const labels = {
    status: "Status",
    missing: "Missing",
    queue: "Queue",
    issues: "Issues",
    requests: "Requests",
    search: "Search",
    series: "TV Search"
  };
  return labels[action] ?? action;
}

function toneColor(tone) {
  if (tone === "ok") return "#1a7f37";
  if (tone === "warning") return "#9a6700";
  if (tone === "error") return "#d1242f";
  return "#2f81f7";
}

function metricLine(metric) {
  return `${metric.label}: ${metric.value}`;
}

function itemLine(item) {
  const parts = [
    item.label,
    item.value !== undefined ? String(item.value) : undefined,
    item.detail
  ].filter(Boolean);
  return truncateText(parts.join(" - "), 160);
}

function textBlock(text) {
  return {
    type: "text",
    text
  };
}

function viewToComponents(result, action) {
  const view = result?.view && typeof result.view === "object" ? result.view : undefined;
  const title = view?.title ?? actionLabel(action);
  const summary = view?.summary ?? result?.summary ?? "No summary returned.";
  const cards = Array.isArray(view?.cards) ? view.cards.slice(0, 4) : [];
  const tone = cards.find((card) => card?.tone === "error" || card?.tone === "warning")?.tone ?? cards[0]?.tone;

  return {
    reusable: true,
    container: { accentColor: toneColor(tone) },
    text: [
      `## ${title}`,
      truncateText(summary, 900)
    ].join("\n"),
    blocks: [
      ...cards.map((card) => {
        const metrics = Array.isArray(card.metrics) && card.metrics.length
          ? card.metrics.slice(0, 4).map(metricLine).join("\n")
          : "";
        const items = Array.isArray(card.items) && card.items.length
          ? card.items.slice(0, 5).map(itemLine).join("\n")
          : "";
        return textBlock([
          `**${card.title ?? "Details"}**`,
          truncateText([metrics, items].filter(Boolean).join("\n"), 900) || "No details."
        ].join("\n"));
      }),
      panelFooterButtons(action)
    ]
  };
}

function withPanelFooter(spec, action) {
  const blocks = Array.isArray(spec?.blocks) ? spec.blocks : [];
  return {
    ...spec,
    reusable: true,
    blocks: [
      ...sanitizeBlocks(blocks),
      panelFooterButtons(action)
    ]
  };
}

function withMovieControls(spec, options = {}) {
  const blocks = Array.isArray(spec?.blocks) ? spec.blocks : [];
  const kind = options.kind === "series" ? "series" : options.kind === "movie" ? "movie" : "media";
  return sanitizeComponentSpec({
    ...spec,
    reusable: true,
    blocks: [
      ...sanitizeBlocks(blocks),
      movieFooterBlock()
    ],
    modal: searchModalSpec(kind === "series" ? "Search TV Again" : kind === "movie" ? "Search Movies Again" : "Search Again", { kind })
  });
}

function sanitizeBlocks(blocks) {
  return blocks.map(sanitizeSectionBlock).filter(Boolean);
}

function sanitizeComponentSpec(spec) {
  if (!spec || typeof spec !== "object") return spec;
  const blocks = Array.isArray(spec.blocks) ? sanitizeBlocks(spec.blocks) : [];
  return {
    ...spec,
    blocks
  };
}

function panelRequestOptionBlocks(formFields, request) {
  if (!Array.isArray(formFields) || !requestEntityId(request)) return [];
  const state = encodePanelRequestState(request);
  const blocks = [];
  for (const field of formFields) {
    if (!field || typeof field !== "object") continue;
    const id = String(field.id ?? "");
    const label = String(field.label ?? id);
    if (field.type === "select" && Array.isArray(field.options) && field.options.length > 0) {
      const current = String(request[id] ?? field.value ?? "");
      blocks.push({
        type: "actions",
        select: {
          type: "string",
          placeholder: label,
          minValues: 1,
          maxValues: 1,
          callbackData: `media-panel:option:${id}:${state}`,
          callbackDataKind: "callback",
          options: field.options.slice(0, 25).map((option) => ({
            label: truncateText(option.label ?? option.value, 100),
            value: String(option.value),
            description: option.description ? truncateText(option.description, 100) : undefined,
            default: String(option.value) === current
          }))
        }
      });
      continue;
    }
    if (field.type === "checkbox") {
      const enabled = request[id] !== false;
      blocks.push({
        type: "actions",
        buttons: [
          {
            label: `${label}: ${enabled ? "On" : "Off"}`,
            style: enabled ? "success" : "secondary",
            reusable: true,
            callbackData: `media-panel:toggle:${id}:${state}`,
            callbackDataKind: "callback"
          }
        ]
      });
    }
  }
  return blocks;
}

function selectedRequestCandidate(result) {
  const draft = result?.requestDraft && typeof result.requestDraft === "object" ? result.requestDraft : {};
  return draft.selectedCandidate && typeof draft.selectedCandidate === "object" ? draft.selectedCandidate : {};
}

function optionLabelById(options, id, fallback) {
  if (!Array.isArray(options)) return fallback;
  const match = options.find((option) =>
    String(option?.id ?? "") === String(id)
    || Number(option?.id) === Number(id)
    || String(option?.path ?? "") === String(id)
  );
  return match?.label ?? match?.name ?? match?.path ?? fallback;
}

function previewRequestComponents(result) {
  const draft = result?.requestDraft && typeof result.requestDraft === "object" ? result.requestDraft : {};
  const request = draft.request && typeof draft.request === "object" ? draft.request : {};
  const kind = draft.kind === "series" || Number(request.tvdbId) ? "series" : "movie";
  const candidate = selectedRequestCandidate(result);
  const title = candidate.title ?? (kind === "series" ? "Selected series" : "Selected movie");
  const year = candidate.year ? ` (${candidate.year})` : "";
  const writeEnabled = Boolean(draft?.writeGate?.enabled);
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const disabled = warnings.length > 0 && writeEnabled;
  const quality = optionLabelById(draft.qualityProfileOptions, request.qualityProfileId, request.qualityProfileId ?? "default");
  const root = optionLabelById(draft.rootFolderOptions, request.rootFolderPath, request.rootFolderPath ?? "default");
  const monitor = optionLabelById(draft.monitorOptions, request.monitorMode, request.monitorMode ?? "all");
  const details = [
    `Quality: ${quality}`,
    `Root: ${root}`,
    kind === "series" ? `Monitor: ${monitor}` : `Monitored: ${request.monitored !== false ? "yes" : "no"}`,
    kind === "series" ? `Season folders: ${request.seasonFolder !== false ? "yes" : "no"}` : undefined,
    `Search now: ${request.searchNow !== false ? "yes" : "no"}`,
    warnings[0] ? `Warning: ${warnings[0]}` : undefined,
    !writeEnabled ? "ALLOW_REQUESTS is false; submit runs as a dry run." : undefined
  ].filter(Boolean).join("\n");
  return sanitizeComponentSpec({
    reusable: true,
    container: { accentColor: disabled || !writeEnabled ? "#9a6700" : "#1a7f37" },
    text: [
      kind === "series" ? "## Series Request Preview" : "## Movie Request Preview",
      truncateText(result?.summary ?? `Preview ready for ${title}${year}.`, 900)
    ].join("\n"),
    blocks: [
      {
        type: "section",
        texts: [
          `**${truncateText(`${title}${year}`, 100)}**`,
          truncateText(result?.summary ?? "", 300),
          details
        ].filter(Boolean),
        accessory: mediaPoster(candidate, kind)
      },
      ...panelRequestOptionBlocks(draft.formFields, request),
      moviePreviewActionBlock(request, writeEnabled, disabled)
    ],
    modal: searchModalSpec(kind === "series" ? "Search TV Again" : "Search Movies Again", { kind })
  });
}

function titleCaseFromKey(value) {
  return String(value ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function episodeMarkers(value) {
  const text = String(value ?? "");
  const markers = new Set();
  for (const match of text.matchAll(/\bS(\d{1,2})E(\d{1,3})\b/gi)) {
    markers.add(`s${match[1].padStart(2, "0")}e${match[2].padStart(2, "0")}`);
  }
  for (const match of text.matchAll(/\b(\d{1,2})x(\d{1,3})\b/gi)) {
    markers.add(`s${match[1].padStart(2, "0")}e${match[2].padStart(2, "0")}`);
  }
  return markers;
}

function activeQueueFollowTracks(result) {
  const services = Array.isArray(result?.services) ? result.services : [];
  const groups = new Map();
  for (const service of services) {
    const rawServiceName = String(service?.service ?? "");
    const serviceName = rawServiceName === "sonarr" || rawServiceName === "radarr" ? rawServiceName : undefined;
    if (!serviceName || !Array.isArray(service.items)) continue;
    for (const item of service.items) {
      const title = String(item?.title ?? "");
      const key = serviceName === "sonarr" ? seriesTitleKey(title) : normalizeMovieTitle(title);
      if (!key) continue;
      const groupKey = `${serviceName}:${key}`;
      const group = groups.get(groupKey) ?? {
        service: serviceName,
        title: titleCaseFromKey(key),
        count: 0,
        episodes: new Set()
      };
      group.count += 1;
      for (const marker of episodeMarkers(title)) group.episodes.add(marker);
      groups.set(groupKey, group);
    }
  }
  return [...groups.values()].map((group) => ({
    service: group.service,
    title: group.title,
    expectedEpisodeCount: group.service === "sonarr" && group.episodes.size > 0 ? group.episodes.size : undefined,
    polls: 0
  }));
}

function queueGroupKeyForItem(serviceName, title) {
  const normalizedService = serviceName === "sonarr" || serviceName === "sabnzbd" ? "sonarr"
    : serviceName === "radarr" ? "radarr"
      : undefined;
  if (!normalizedService) return undefined;
  const key = normalizedService === "sonarr" ? seriesTitleKey(title) : normalizeMovieTitle(title);
  return key ? `${normalizedService}:${key}` : undefined;
}

function queueGroupDisplayTitle(serviceName, key, fallbackTitle) {
  if (serviceName === "sonarr") return titleCaseFromKey(key);
  const parsed = parseMovieLabel(String(fallbackTitle ?? ""));
  return parsed.title || titleCaseFromKey(key);
}

function groupedQueueComponents(result) {
  const services = Array.isArray(result?.services) ? result.services : [];
  const groups = new Map();
  for (const service of services) {
    const rawServiceName = String(service?.service ?? "");
    if (!Array.isArray(service.items)) continue;
    for (const item of service.items) {
      const title = String(item?.title ?? "");
      const groupKey = queueGroupKeyForItem(rawServiceName, title);
      if (!groupKey) continue;
      const [followService, key] = groupKey.split(":");
      const markerSet = episodeMarkers(title);
      const group = groups.get(groupKey) ?? {
        service: followService,
        title: queueGroupDisplayTitle(followService, key, title),
        rawTitle: title,
        services: new Set(),
        episodes: new Set(),
        itemCount: 0,
        progressValues: [],
        statuses: new Set(),
        eta: undefined
      };
      group.services.add(rawServiceName);
      group.itemCount += 1;
      for (const marker of markerSet) group.episodes.add(marker);
      const progress = Number(item?.progress);
      if (Number.isFinite(progress)) group.progressValues.push(progress);
      const status = String(item?.status ?? item?.trackedDownloadStatus ?? "").trim();
      if (status) group.statuses.add(status);
      if (!group.eta && item?.eta) group.eta = item.eta;
      groups.set(groupKey, group);
    }
  }

  const grouped = [...groups.values()];
  if (grouped.length === 0) {
    const fallback = viewToComponents(result, "queue");
    return withQueueFollowControls(fallback, result);
  }
  const activeItems = grouped.reduce((sum, group) => sum + Math.max(group.episodes.size || 0, 1), 0);
  const lines = grouped.slice(0, 8).map((group) => {
    const episodeCount = group.episodes.size;
    const avgProgress = group.progressValues.length
      ? Math.round(group.progressValues.reduce((sum, value) => sum + value, 0) / group.progressValues.length)
      : undefined;
    const servicesText = [...group.services].map((name) => name === "sabnzbd" ? "SAB" : titleCaseFromKey(name)).join(" + ");
    const statusText = [...group.statuses].slice(0, 2).join(" / ");
    const parts = [
      episodeCount > 1 ? `${episodeCount} episodes` : "1 item",
      avgProgress !== undefined ? `${avgProgress}%` : undefined,
      statusText || undefined,
      servicesText || undefined,
      group.eta ? `ETA ${group.eta}` : undefined
    ].filter(Boolean);
    return `**${truncateText(group.title, 80)}**\n${truncateText(parts.join(" - "), 220)}`;
  });
  const spec = {
    reusable: true,
    container: { accentColor: "#9a6700" },
    text: [
      "## Download Queue",
      `${activeItems} active ${activeItems === 1 ? "item" : "items"} grouped across media requests.`
    ].join("\n"),
    blocks: [
      textBlock(lines.join("\n")),
      panelFooterButtons("queue")
    ]
  };
  return withQueueFollowControls(spec, result);
}

function withQueueFollowControls(spec, result) {
  const tracks = activeQueueFollowTracks(result);
  if (tracks.length === 0) return spec;
  const buttons = tracks.slice(0, 5).map((track) => ({
    label: `Follow ${truncateText(track.title, tracks.length === 1 ? 64 : 40)}`,
    style: "primary",
    reusable: true,
    callbackData: followStateCallback(track),
    callbackDataKind: "callback"
  }));
  const blocks = Array.isArray(spec?.blocks) ? spec.blocks : [];
  const lastBlock = blocks[blocks.length - 1];
  const lastIsFooter = Array.isArray(lastBlock?.buttons)
    && lastBlock.buttons.some((button) => String(button?.callbackData ?? "") === "media-panel:reset");
  const followBlock = {
    type: "actions",
    buttons
  };
  return {
    ...spec,
    blocks: lastIsFooter
      ? [...blocks.slice(0, -1), followBlock, lastBlock]
      : [...blocks, followBlock]
  };
}

function resultToComponents(result, action) {
  if (action === "queue") return sanitizeComponentSpec(groupedQueueComponents(result));
  const components = action === "search" || action === "series"
    ? searchResultComponents(result, action === "series" ? "series" : "movie")
    : viewToComponents(result, action);
  return sanitizeComponentSpec(components);
}

function mediaPoster(candidate, kind) {
  const url = typeof candidate?.remotePoster === "string" && candidate.remotePoster
    ? candidate.remotePoster
    : Array.isArray(candidate?.images)
      ? candidate.images.find((image) => image?.coverType === "poster" && typeof image?.remoteUrl === "string")?.remoteUrl
      : undefined;
  return url ? { type: "thumbnail", url } : undefined;
}

function searchOptionLabel(kind, candidate) {
  const title = String(candidate?.title ?? "Untitled");
  const year = candidate?.year ? ` (${candidate.year})` : "";
  return truncateText(`${title}${year}`, 100);
}

function searchOptionDescription(kind, candidate) {
  const pieces = [
    candidate?.alreadyExists || candidate?.isExisting ? `Already in ${kind === "series" ? "Sonarr" : "Radarr"}` : undefined,
    kind === "series" ? candidate?.network : undefined,
    Array.isArray(candidate?.genres) ? candidate.genres.slice(0, 2).join(", ") : undefined,
    kind === "movie" ? candidate?.certification : undefined
  ].filter(Boolean);
  return pieces.length > 0 ? truncateText(pieces.join(" | "), 100) : undefined;
}

function searchResultComponents(result, kind = "movie") {
  const draftCandidates = Array.isArray(result?.requestDraft?.candidateOptions) ? result.requestDraft.candidateOptions : [];
  const candidates = Array.isArray(result?.candidates) && result.candidates.length ? result.candidates : draftCandidates;
  if (candidates.length === 0) return viewToComponents(result, kind === "series" ? "series" : "search");
  const first = candidates[0];
  const options = candidates.slice(0, 25).map((candidate) => {
    const id = kind === "series" ? Number(candidate?.tvdbId) : Number(candidate?.tmdbId);
    return id ? {
      label: searchOptionLabel(kind, candidate),
      value: kind === "series" ? `media-panel:series-preview:${id}` : `media-panel:preview:${id}`,
      description: searchOptionDescription(kind, candidate)
    } : undefined;
  }).filter(Boolean);
  if (options.length === 0) return viewToComponents(result, kind === "series" ? "series" : "search");
  const title = kind === "series" ? "TV Search" : "Movie Search";
  const placeholder = kind === "series" ? "Choose a series to preview" : "Choose a movie to preview";
  return {
    reusable: true,
    container: { accentColor: "#2f81f7" },
    text: [
      `## ${title}`,
      truncateText(result?.summary ?? `${options.length} results found.`, 900)
    ].join("\n"),
    blocks: [
      {
        type: "section",
        text: truncateText(result?.summary ?? "Pick the exact match to preview.", 300),
        accessory: mediaPoster(first, kind)
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder,
          minValues: 1,
          maxValues: 1,
          callbackData: kind === "series" ? "media-panel:series-preview" : "media-panel:preview",
          callbackDataKind: "callback",
          options
        }
      },
      movieFooterBlock()
    ],
    modal: searchModalSpec(kind === "series" ? "Search TV Again" : "Search Movies Again", { kind })
  };
}

function panelChannelId(config = {}) {
  const configured = typeof config.panelChannelId === "string" ? config.panelChannelId.trim() : "";
  return configured || DEFAULT_PANEL_CHANNEL_ID;
}

function panelAccountId(config = {}) {
  const configured = typeof config.accountId === "string" ? config.accountId.trim() : "";
  return configured || undefined;
}

async function readPanelState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writePanelState(state) {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function loadDiscordRuntimeApi() {
  if (discordRuntimeApiPromise) return discordRuntimeApiPromise;
  discordRuntimeApiPromise = (async () => {
    const projectsDir = join(homedir(), ".openclaw", "npm", "projects");
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(
        projectsDir,
        entry.name,
        "node_modules",
        "@openclaw",
        "discord",
        "dist",
        "runtime-api.send.js"
      );
      const apiCandidate = join(
        projectsDir,
        entry.name,
        "node_modules",
        "@openclaw",
        "discord",
        "dist",
        "api.js"
      );
      try {
        await readFile(candidate);
        await readFile(apiCandidate);
        const [sendModule, apiModule] = await Promise.all([
          import(pathToFileURL(candidate).href),
          import(pathToFileURL(apiCandidate).href)
        ]);
        return {
          ...sendModule,
          buildDiscordComponentMessage: apiModule.buildDiscordComponentMessage,
          resolveDiscordAccount: apiModule.resolveDiscordAccount
        };
      } catch {
        // Keep scanning; OpenClaw npm project ids include content hashes.
      }
    }
    throw new Error("Unable to locate installed @openclaw/discord runtime API");
  })();
  return discordRuntimeApiPromise;
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
  const client = new Client({
    name: "openclaw-media-panel",
    version: "0.1.0"
  });
  const transport = new StreamableHTTPClientTransport(new URL(mediaMcpUrl(api.pluginConfig ?? {})));

  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const text = result?.content?.find((entry) => entry?.type === "text" && typeof entry.text === "string")?.text;
    if (result?.isError) throw new Error(text || `${name} failed`);
    if (!text) return {};
    return JSON.parse(text);
  } finally {
    await transport.close().catch(() => {});
  }
}

function panelToolForAction(action, input = "") {
  if (action === "status") return { name: "media_stack_overview", args: {} };
  if (action === "missing") return { name: "get_missing_summary", args: { pageSize: 10 } };
  if (action === "queue") return { name: "download_queue", args: { pageSize: 50 } };
  if (action === "issues") return { name: "get_import_issues", args: { pageSize: 50 } };
  if (action === "search") return { name: "search_movie", args: { query: input, limit: 10 } };
  if (action === "series") return { name: "search_series", args: { query: input, limit: 10 } };
  throw new Error(`Unsupported panel action: ${action}`);
}

function combinedSearchOption(kind, candidate) {
  const title = String(candidate?.title ?? "Untitled");
  const year = candidate?.year ? ` (${candidate.year})` : "";
  const labelPrefix = kind === "series" ? "TV" : "Movie";
  const id = kind === "series" ? Number(candidate?.tvdbId) : Number(candidate?.tmdbId);
  if (!id) return undefined;
  const descriptionParts = [
    kind === "series" ? candidate?.network : undefined,
    candidate?.year,
    candidate?.alreadyExists || candidate?.isExisting ? "Already added" : undefined
  ].filter(Boolean);
  return {
    label: truncateText(`${labelPrefix}: ${title}${year}`, 100),
    value: kind === "series" ? `media-panel:series-preview:${id}` : `media-panel:preview:${id}`,
    description: descriptionParts.length ? truncateText(descriptionParts.join(" | "), 100) : undefined
  };
}

async function combinedSearchComponents(api, query) {
  const [movieResult, seriesResult] = await Promise.all([
    callMediaTool(api, "search_movie", { query, limit: 10 }),
    callMediaTool(api, "search_series", { query, limit: 10 })
  ]);
  const movieOptions = (Array.isArray(movieResult?.candidates) ? movieResult.candidates : [])
    .map((candidate) => combinedSearchOption("movie", candidate))
    .filter(Boolean);
  const seriesOptions = (Array.isArray(seriesResult?.candidates) ? seriesResult.candidates : [])
    .map((candidate) => combinedSearchOption("series", candidate))
    .filter(Boolean);
  const options = [...movieOptions, ...seriesOptions].slice(0, 25);
  const summary = options.length === 0
    ? `No movie or TV results found for "${query}".`
    : `${movieOptions.length} movie and ${seriesOptions.length} TV results found for "${query}".`;
  const blocks = [
    textBlock([
      "**Search Results**",
      truncateText(summary, 300)
    ].join("\n"))
  ];
  if (options.length > 0) {
    blocks.push({
      type: "actions",
      select: {
        type: "string",
        placeholder: "Choose a movie or TV series",
        minValues: 1,
        maxValues: 1,
        callbackData: "media-panel:combined-preview",
        callbackDataKind: "callback",
        options
      }
    });
  }
  blocks.push(movieFooterBlock());
  return sanitizeComponentSpec({
    reusable: true,
    container: { accentColor: options.length > 0 ? "#2f81f7" : "#9a6700" },
    text: [
      "## Search",
      truncateText(summary, 900)
    ].join("\n"),
    blocks,
    modal: searchModalSpec("Search Again")
  });
}

function parseTmdbId(value) {
  const text = String(value ?? "");
  const match = text.match(/\btmdb\D+(\d{2,})\b/i) ?? text.match(/\b(\d{2,})\b/);
  return match ? Number(match[1]) : undefined;
}

function parseTvdbId(value) {
  const text = String(value ?? "");
  const match = text.match(/\btvdb\D+(\d{2,})\b/i) ?? text.match(/\b(\d{2,})\b/);
  return match ? Number(match[1]) : undefined;
}

function parseMovieLabel(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (!match) return { title: text, year: undefined };
  return {
    title: match[1].trim(),
    year: Number(match[2])
  };
}

function normalizeMovieTitle(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function seriesTitleKey(value) {
  const text = String(value ?? "")
    .replace(/\((\d{4})\)/g, " $1 ")
    .replace(/\b\d{4}\b/g, " ")
    .replace(/\bS\d{1,2}(?:E\d{1,3})?\b.*$/i, " ")
    .replace(/\b\d{1,2}x\d{1,3}\b.*$/i, " ");
  return normalizeMovieTitle(text);
}

async function resolvePreviewTmdbIdFromSelection(api, value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (text.startsWith("media-panel:preview:") || /\btmdb\b/i.test(text)) return parseTmdbId(text);

  const selected = parseMovieLabel(text);
  const result = await callMediaTool(api, "search_movie", { query: selected.title || text, limit: 10 });
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const selectedTitle = normalizeMovieTitle(selected.title);
  const exact = candidates.find((candidate) => {
    if (!candidate?.tmdbId) return false;
    const titleMatches = normalizeMovieTitle(candidate.title) === selectedTitle;
    const yearMatches = selected.year ? Number(candidate.year) === selected.year : true;
    return titleMatches && yearMatches;
  });
  return Number(exact?.tmdbId) || Number(candidates[0]?.tmdbId) || undefined;
}

async function resolvePreviewTvdbIdFromSelection(api, value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (text.startsWith("media-panel:series-preview:") || /\btvdb\b/i.test(text)) return parseTvdbId(text);

  const selected = parseMovieLabel(text);
  const result = await callMediaTool(api, "search_series", { query: selected.title || text, limit: 10 });
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const selectedTitle = normalizeMovieTitle(selected.title);
  const exact = candidates.find((candidate) => {
    if (!candidate?.tvdbId) return false;
    const titleMatches = normalizeMovieTitle(candidate.title) === selectedTitle;
    const yearMatches = selected.year ? Number(candidate.year) === selected.year : true;
    return titleMatches && yearMatches;
  });
  return Number(exact?.tvdbId) || Number(candidates[0]?.tvdbId) || undefined;
}

function encodePanelPreviewValue(value) {
  const raw = String(value ?? "");
  const isSeries = /\b(sonarr|series|tvdb)\b/i.test(raw);
  const tvdbId = isSeries ? parseTvdbId(raw) : undefined;
  if (tvdbId) return `media-panel:series-preview:${tvdbId}`;
  const tmdbId = parseTmdbId(raw);
  return tmdbId ? `media-panel:preview:${tmdbId}` : String(value ?? "");
}

function rewriteSearchSelectForPanel(spec, kind = "movie") {
  if (!spec || typeof spec !== "object") return spec;
  const blocks = Array.isArray(spec.blocks) ? spec.blocks : [];
  return {
    ...spec,
    blocks: blocks.map((block) => {
      const select = block?.select;
      if (!select || !Array.isArray(select.options)) return sanitizeSectionBlock(block);
      return {
        ...sanitizeSectionBlock(block),
        select: {
          ...select,
          callbackData: kind === "series" ? "media-panel:series-preview" : "media-panel:preview",
          callbackDataKind: "callback",
          options: select.options.map((option) => ({
            ...option,
            value: encodePanelPreviewValue(option.value)
          }))
        }
      };
    }),
    modal: searchModalSpec(kind === "series" ? "Search TV Again" : "Search Movies Again", { kind })
  };
}

function sanitizeSectionBlock(block) {
  if (block?.type === "form") return undefined;
  if (block?.type !== "section" || block.accessory) return block;
  const texts = Array.isArray(block.texts) ? block.texts : [block.text].filter(Boolean);
  return textBlock(texts.join("\n"));
}

function buildOrderedPanelHome(accountId, buildDiscordComponentMessage) {
  const baseSpec = {
    ...panelComponents(),
    modal: undefined
  };
  const base = buildDiscordComponentMessage({
    spec: baseSpec,
    fallbackText: baseSpec.text,
    accountId
  });
  const modalSpec = {
    reusable: true,
    text: "Search",
    blocks: [],
    modal: searchModalSpec("Search", { triggerStyle: "success" })
  };
  const modal = buildDiscordComponentMessage({
    spec: modalSpec,
    fallbackText: "Search",
    accountId
  });
  const modalButton = modal.components?.[0]?.components
    ?.find((component) => Array.isArray(component?.components))
    ?.components?.[0];
  const row = base.components?.[0]?.components
    ?.find((component) => Array.isArray(component?.components) && component.components.some((button) => button?.label === "Search"));
  if (!modalButton || !row) throw new Error("Unable to build ordered media panel search modal trigger.");
  modalButton.emoji = "🔎";
  const searchIndex = row.components.findIndex((button) => button?.label === "Search");
  if (searchIndex < 0) throw new Error("Unable to place media panel search modal trigger.");
  row.components[searchIndex] = modalButton;
  const searchEntryIds = new Set(
    base.entries
      .filter((entry) => entry?.label === "Search")
      .map((entry) => entry.id)
  );
  const entries = [
    ...base.entries.filter((entry) => !searchEntryIds.has(entry.id)),
    ...modal.entries
  ];
  return {
    components: base.components,
    entries,
    modals: modal.modals
  };
}

function discordWireComponent(component) {
  if (!component || typeof component !== "object") return component;
  if (typeof component.serialize === "function") return discordWireComponent(component.serialize());
  if (component.type === 17) {
    const accentColor = typeof component.accent_color === "number" ? component.accent_color
      : typeof component.accentColor === "number" ? component.accentColor
      : typeof component.accentColor === "string" && /^#?[0-9a-f]{6}$/i.test(component.accentColor)
        ? Number.parseInt(component.accentColor.replace(/^#/, ""), 16)
        : undefined;
    return {
      type: 17,
      ...(accentColor !== undefined ? { accent_color: accentColor } : {}),
      ...(component.spoiler !== undefined ? { spoiler: component.spoiler } : {}),
      components: Array.isArray(component.components) ? component.components.map(discordWireComponent) : []
    };
  }
  if (component.type === 10) {
    return {
      type: 10,
      content: String(component.content ?? "")
    };
  }
  if (component.type === 1) {
    return {
      type: 1,
      components: Array.isArray(component.components) ? component.components.map(discordWireComponent) : []
    };
  }
  if (component.type === 2) {
    const customId = component.custom_id ?? component.customId;
    return {
      type: 2,
      style: component.style,
      label: component.label,
      custom_id: customId,
      disabled: component.disabled === true,
      ...(component.emoji ? { emoji: typeof component.emoji === "string" ? { name: component.emoji } : component.emoji } : {})
    };
  }
  return component;
}

async function editOrderedPanelHome(api, channelId, messageId, reason, accountId) {
  const {
    buildDiscordComponentMessage,
    registerBuiltDiscordComponentMessage,
    resolveDiscordAccount
  } = await loadDiscordRuntimeApi();
  const resolvedAccount = resolveDiscordAccount({
    cfg: api.config,
    accountId
  });
  const buildResult = buildOrderedPanelHome(resolvedAccount.accountId, buildDiscordComponentMessage);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${resolvedAccount.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      components: buildResult.components.map(discordWireComponent),
      flags: DISCORD_COMPONENTS_V2_FLAG
    })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord panel edit failed (${response.status}): ${truncateText(body, 500)}`);
  }
  const edited = await response.json();
  registerBuiltDiscordComponentMessage({
    buildResult,
    messageId: edited.id ?? messageId
  });
  const nextState = {
    channelId,
    messageId: edited.id ?? messageId,
    accountId: resolvedAccount.accountId,
    updatedAt: new Date().toISOString(),
    reason,
    mode: "edit"
  };
  await writePanelState(nextState);
  return { ok: true, ...nextState };
}

async function editResidentPanel(api, spec, reason = "panel-action") {
  const config = api.pluginConfig ?? {};
  const channelId = panelChannelId(config);
  const accountId = panelAccountId(config);
  const target = `channel:${channelId}`;
  const state = await readPanelState();
  const configuredMessageId = typeof config.panelMessageId === "string" ? config.panelMessageId.trim() : "";
  const knownMessageId = configuredMessageId || (state.channelId === channelId && typeof state.messageId === "string" ? state.messageId : "");
  if (!knownMessageId) return ensureResidentPanel(api, reason);

  if (spec?.panelHome === true) {
    return editOrderedPanelHome(api, channelId, knownMessageId, reason, accountId);
  }

  const { editDiscordComponentMessage } = await loadDiscordRuntimeApi();
  const edited = await editDiscordComponentMessage(target, knownMessageId, spec, { cfg: api.config, accountId });
  const nextState = {
    channelId,
    messageId: edited.messageId ?? knownMessageId,
    accountId: accountId ?? "default",
    updatedAt: new Date().toISOString(),
    reason,
    mode: "edit"
  };
  await writePanelState(nextState);
  return { ok: true, ...nextState };
}

async function updatePanelFromAction(api, action, input = "") {
  if (action === "reset") {
    clearPanelAutoReset();
    clearPanelRequestFollow();
    await editResidentPanel(api, panelComponents(), "reset");
    return;
  }

  clearPanelAutoReset();
  clearPanelRequestFollow();
  await editResidentPanel(api, panelWorkingComponents(`${actionLabel(action)} loading`), `working:${action}`);
  try {
    const tool = panelToolForAction(action, input);
    const result = await callMediaTool(api, tool.name, tool.args);
    const components = action === "search" || action === "series"
      ? rewriteSearchSelectForPanel(resultToComponents(result, action), action === "series" ? "series" : "movie")
      : resultToComponents(result, action);
    await editResidentPanel(api, components, `result:${action}`);
    schedulePanelAutoReset(api, action);
  } catch (error) {
    api.logger.warn(`media panel ${action} failed: ${String(error)}`);
    await editResidentPanel(api, panelErrorComponents(action, error), `error:${action}`);
    schedulePanelAutoReset(api, `error:${action}`);
  }
}

async function updatePanelFromPreview(api, tmdbId, requestInput, options = {}) {
  clearPanelAutoReset();
  clearPanelRequestFollow();
  if (options.showWorking !== false) {
    await editResidentPanel(api, panelWorkingComponents("Preview loading"), `working:preview:${tmdbId}`);
  }
  try {
    const result = await previewMovieForPanel(api, tmdbId, requestInput);
    await editResidentPanel(api, previewRequestComponents(result), `result:preview:${tmdbId}`);
    schedulePanelAutoReset(api, `preview:${tmdbId}`);
  } catch (error) {
    api.logger.warn(`media panel preview failed: ${String(error)}`);
    await editResidentPanel(api, withMovieControls(panelErrorComponents("search", error), { kind: "movie" }), `error:preview:${tmdbId}`);
    schedulePanelAutoReset(api, `error:preview:${tmdbId}`);
  }
}

async function updatePanelFromSeriesPreview(api, tvdbId, requestInput, options = {}) {
  clearPanelAutoReset();
  clearPanelRequestFollow();
  if (options.showWorking !== false) {
    await editResidentPanel(api, panelWorkingComponents("Preview loading"), `working:series-preview:${tvdbId}`);
  }
  try {
    const result = await previewSeriesForPanel(api, tvdbId, requestInput);
    await editResidentPanel(api, previewRequestComponents(result), `result:series-preview:${tvdbId}`);
    schedulePanelAutoReset(api, `series-preview:${tvdbId}`);
  } catch (error) {
    api.logger.warn(`media panel series preview failed: ${String(error)}`);
    await editResidentPanel(api, withMovieControls(panelErrorComponents("series", error), { kind: "series" }), `error:series-preview:${tvdbId}`);
    schedulePanelAutoReset(api, `error:series-preview:${tvdbId}`);
  }
}

async function panelMovieRequestInput(api, tmdbId, overrides = {}) {
  const options = await callMediaTool(api, "radarr_request_options", {});
  const draft = options?.requestDraft && typeof options.requestDraft === "object" ? options.requestDraft : {};
  const qualityProfile = Array.isArray(draft.qualityProfileOptions) ? draft.qualityProfileOptions[0] : undefined;
  const rootFolder = Array.isArray(draft.rootFolderOptions) ? draft.rootFolderOptions[0] : undefined;
  const qualityProfileId = Number(overrides.qualityProfileId ?? qualityProfile?.id);
  const rootFolderPath = String(overrides.rootFolderPath ?? rootFolder?.path ?? "");
  if (!qualityProfileId || !rootFolderPath) {
    throw new Error("Radarr default quality profile or root folder is unavailable.");
  }
  return {
    tmdbId,
    qualityProfileId,
    rootFolderPath,
    monitored: overrides.monitored !== undefined ? overrides.monitored !== false : true,
    searchNow: overrides.searchNow !== undefined ? overrides.searchNow !== false : true,
    tagIds: Array.isArray(overrides.tagIds) ? overrides.tagIds.map(Number).filter(Number.isFinite) : []
  };
}

async function previewMovieForPanel(api, tmdbId, requestInput) {
  const input = requestInput && typeof requestInput === "object"
    ? await panelMovieRequestInput(api, tmdbId, requestInput)
    : await panelMovieRequestInput(api, tmdbId);
  return callMediaTool(api, "preview_movie_request", input);
}

async function panelSeriesRequestInput(api, tvdbId, overrides = {}) {
  const options = await callMediaTool(api, "sonarr_request_options", {});
  const draft = options?.requestDraft && typeof options.requestDraft === "object" ? options.requestDraft : {};
  const qualityProfile = Array.isArray(draft.qualityProfileOptions) ? draft.qualityProfileOptions[0] : undefined;
  const rootFolder = Array.isArray(draft.rootFolderOptions) ? draft.rootFolderOptions[0] : undefined;
  const qualityProfileId = Number(overrides.qualityProfileId ?? qualityProfile?.id);
  const rootFolderPath = String(overrides.rootFolderPath ?? rootFolder?.path ?? "");
  if (!qualityProfileId || !rootFolderPath) {
    throw new Error("Sonarr default quality profile or root folder is unavailable.");
  }
  return {
    tvdbId,
    qualityProfileId,
    rootFolderPath,
    monitorMode: String(overrides.monitorMode ?? "all"),
    seasonFolder: overrides.seasonFolder !== undefined ? overrides.seasonFolder !== false : true,
    searchNow: overrides.searchNow !== undefined ? overrides.searchNow !== false : true,
    tagIds: Array.isArray(overrides.tagIds) ? overrides.tagIds.map(Number).filter(Number.isFinite) : []
  };
}

async function previewSeriesForPanel(api, tvdbId, requestInput) {
  const input = requestInput && typeof requestInput === "object"
    ? await panelSeriesRequestInput(api, tvdbId, requestInput)
    : await panelSeriesRequestInput(api, tvdbId);
  return callMediaTool(api, "preview_series_request", input);
}

async function previewRequestForPanel(api, request) {
  if (requestKind(request) === "series") {
    return previewSeriesForPanel(api, Number(request.tvdbId), request);
  }
  return previewMovieForPanel(api, Number(request.tmdbId), request);
}

function firstInteractionValue(values) {
  return Array.isArray(values)
    ? values.find((value) => typeof value === "string" && value.trim())?.trim() ?? ""
    : "";
}

function findFormField(result, fieldId) {
  const fields = result?.requestDraft?.formFields;
  if (!Array.isArray(fields)) return undefined;
  return fields.find((field) => String(field?.id ?? "") === fieldId);
}

function selectedOptionValue(field, selectedLabel) {
  if (!field || !Array.isArray(field.options)) return undefined;
  const selected = String(selectedLabel ?? "").trim();
  const option = field.options.find((entry) => String(entry?.label ?? "").trim() === selected)
    ?? field.options.find((entry) => String(entry?.value ?? "").trim() === selected);
  return option?.value;
}

async function updatePanelFromOption(api, fieldId, request, selectedLabel) {
  const current = await previewRequestForPanel(api, request);
  const field = findFormField(current, fieldId);
  const value = selectedOptionValue(field, selectedLabel);
  if (value === undefined) {
    throw new Error(`Could not resolve selected ${fieldId} option.`);
  }
  const nextRequest = {
    ...request,
    [fieldId]: fieldId === "qualityProfileId" ? Number(value) : String(value)
  };
  if (requestKind(nextRequest) === "series") {
    await updatePanelFromSeriesPreview(api, nextRequest.tvdbId, nextRequest, { showWorking: false });
  } else {
    await updatePanelFromPreview(api, nextRequest.tmdbId, nextRequest, { showWorking: false });
  }
}

async function updatePanelFromToggle(api, fieldId, request) {
  const nextRequest = {
    ...request,
    [fieldId]: request[fieldId] === false
  };
  if (requestKind(nextRequest) === "series") {
    await updatePanelFromSeriesPreview(api, nextRequest.tvdbId, nextRequest, { showWorking: false });
  } else {
    await updatePanelFromPreview(api, nextRequest.tmdbId, nextRequest, { showWorking: false });
  }
}

function requestFollowControls(track, complete = false) {
  return {
    type: "actions",
    buttons: [
      {
        label: complete ? "Refresh" : "Check Now",
        style: complete ? "secondary" : "primary",
        reusable: true,
        callbackData: followStateCallback(track),
        callbackDataKind: "callback"
      },
      panelButton("Reset", "reset")
    ]
  };
}

function requestFollowComponents(track, status) {
  const complete = Boolean(status?.complete);
  const failed = Boolean(status?.failed);
  const accentColor = failed ? "#d1242f" : complete ? "#1a7f37" : "#2f81f7";
  const noun = track.service === "sonarr" ? "Series" : "Movie";
  const idDetail = track.service === "sonarr"
    ? (track.tvdbId ? `TVDB ${track.tvdbId}` : "tracked title")
    : (track.tmdbId ? `TMDB ${track.tmdbId}` : "tracked title");
  const details = [
    `${noun}: ${track.title || idDetail}${track.year ? ` (${track.year})` : ""}`,
    `Status: ${status.label}`,
    status.episodeDetail,
    status.detail,
    status.progress !== undefined ? `Progress: ${status.progress}%` : undefined,
    status.eta ? `ETA: ${status.eta}` : undefined,
    status.polls !== undefined ? `Updated: ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : undefined
  ].filter(Boolean).join("\n");
  return {
    reusable: true,
    container: { accentColor },
    text: [
      complete ? `## ${noun} Imported` : failed ? `## ${noun} Request Needs Attention` : `## ${noun} Request`,
      status.summary
    ].join("\n"),
    blocks: [
      textBlock(details),
      requestFollowControls(track, complete)
    ],
    modal: searchModalSpec(track.service === "sonarr" ? "Search TV Again" : "Search Movies Again", { kind: track.service === "sonarr" ? "series" : "movie" })
  };
}

async function updatePanelFromFollow(api, track, options = {}) {
  const service = track?.service === "sonarr" || Number(track?.tvdbId) ? "sonarr" : "radarr";
  const normalizedTrack = {
    service,
    tmdbId: optionalPositiveNumber(track?.tmdbId),
    tvdbId: optionalPositiveNumber(track?.tvdbId),
    title: String(track?.title ?? ""),
    year: optionalPositiveNumber(track?.year),
    expectedEpisodeCount: optionalPositiveNumber(track?.expectedEpisodeCount),
    monitorMode: typeof track?.monitorMode === "string" ? track.monitorMode : undefined,
    polls: Number(track?.polls ?? 0)
  };
  if (!normalizedTrack.title && service === "sonarr" && !normalizedTrack.tvdbId) throw new Error("Series follow state is missing a title or TVDB id.");
  if (!normalizedTrack.title && service === "radarr" && !normalizedTrack.tmdbId) throw new Error("Movie follow state is missing a title or TMDB id.");
  if (!options.scheduled) clearPanelRequestFollow();
  const result = await callMediaTool(api, "request_follow_status", normalizedTrack);
  const status = result?.followStatus && typeof result.followStatus === "object"
    ? result.followStatus
    : { label: "Requested", summary: result?.summary ?? "Waiting for request status.", polls: normalizedTrack.polls };
  await editResidentPanel(api, requestFollowComponents(normalizedTrack, status), `follow:request:${service}:${normalizedTrack.tvdbId || normalizedTrack.tmdbId}`);
  if (!status.complete && normalizedTrack.polls < REQUEST_FOLLOW_MAX_POLLS) {
    schedulePanelRequestFollow(api, normalizedTrack);
  }
}

function panelDryRunRequestComponents(result) {
  const preview = result?.payloadPreview && typeof result.payloadPreview === "object" ? result.payloadPreview : {};
  const request = result?.requestDraft?.request && typeof result.requestDraft.request === "object" ? result.requestDraft.request : {};
  const kind = result?.requestDraft?.kind === "series" || request.tvdbId || preview.tvdbId ? "series" : "movie";
  const serviceLabel = kind === "series" ? "Sonarr" : "Radarr";
  const qualityProfile = Array.isArray(result?.requestDraft?.qualityProfileOptions)
    ? result.requestDraft.qualityProfileOptions.find((profile) => Number(profile?.id) === Number(request.qualityProfileId ?? preview.qualityProfileId))
    : undefined;
  const title = preview.title ?? result?.requestDraft?.selectedCandidate?.title ?? "Selected movie";
  const year = preview.year ?? result?.requestDraft?.selectedCandidate?.year;
  const summary = [
    `Dry run ready for ${title}${year ? ` (${year})` : ""}.`,
    `ALLOW_REQUESTS is false, so no ${serviceLabel} write was attempted.`
  ].join(" ");
  const details = [
    kind === "series" ? `TVDB: ${request.tvdbId ?? preview.tvdbId ?? "unknown"}` : `TMDB: ${request.tmdbId ?? preview.tmdbId ?? "unknown"}`,
    `Quality profile: ${qualityProfile?.label ?? qualityProfile?.name ?? request.qualityProfileId ?? preview.qualityProfileId ?? "default"}`,
    `Root: ${request.rootFolderPath ?? preview.rootFolderPath ?? "default"}`,
    kind === "series" ? `Monitor: ${request.monitorMode ?? preview.addOptions?.monitor ?? "all"}` : `Monitored: ${(request.monitored ?? preview.monitored) ? "yes" : "no"}`,
    kind === "series" ? `Season folders: ${(request.seasonFolder ?? preview.seasonFolder) ? "yes" : "no"}` : undefined,
    `Search now: ${(request.searchNow ?? preview.addOptions?.searchForMovie ?? preview.addOptions?.searchForMissingEpisodes) ? "yes" : "no"}`
  ].filter(Boolean).join("\n");
  return {
    reusable: true,
    container: { accentColor: "#9a6700" },
    text: [
      kind === "series" ? "## Series Request Dry Run" : "## Movie Request Dry Run",
      summary
    ].join("\n"),
    blocks: [
      textBlock([
        `**${title}${year ? ` (${year})` : ""}**`,
        details
      ].join("\n")),
      movieFooterBlock()
    ],
    modal: searchModalSpec(kind === "series" ? "Search TV Again" : "Search Movies Again", { kind })
  };
}

async function updatePanelFromRequest(api, requestOrTmdb) {
  const request = typeof requestOrTmdb === "object" && requestOrTmdb
    ? requestOrTmdb
    : { tmdbId: Number(requestOrTmdb) };
  const kind = requestKind(request);
  const entityId = requestEntityId(request);
  clearPanelAutoReset();
  clearPanelRequestFollow();
  await editResidentPanel(api, panelWorkingComponents("Request loading"), `working:request:${kind}:${entityId}`);
  try {
    const preview = await previewRequestForPanel(api, request);
    if (!preview?.requestDraft?.writeGate?.enabled) {
      await editResidentPanel(api, panelDryRunRequestComponents(preview), `dry-run:request:${kind}:${entityId}`);
      schedulePanelAutoReset(api, `dry-run:${kind}:${entityId}`);
      return;
    }
    const input = preview?.requestDraft?.request;
    if (!input?.qualityProfileId || !input?.rootFolderPath || (!input.tmdbId && !input.tvdbId)) {
      throw new Error("Media request payload is incomplete.");
    }
    const result = kind === "series"
      ? await callMediaTool(api, "request_series", input)
      : await callMediaTool(api, "request_movie", input);
    await updatePanelFromFollow(api, {
      service: kind === "series" ? "sonarr" : "radarr",
      tmdbId: input.tmdbId,
      tvdbId: input.tvdbId,
      title: result?.series?.title ?? result?.movie?.title ?? preview?.requestDraft?.selectedCandidate?.title ?? "",
      year: result?.series?.year ?? result?.movie?.year ?? preview?.requestDraft?.selectedCandidate?.year,
      expectedEpisodeCount: kind === "series" ? Number(result?.expectedEpisodeCount) || undefined : undefined,
      monitorMode: kind === "series" ? result?.monitorMode ?? input.monitorMode : undefined,
      polls: 0
    });
  } catch (error) {
    api.logger.warn(`media panel request failed: ${String(error)}`);
    await editResidentPanel(api, withMovieControls(panelErrorComponents(kind === "series" ? "series" : "search", error), { kind }), `error:request:${kind}:${entityId}`);
    schedulePanelAutoReset(api, `error:request:${kind}:${entityId}`);
  }
}

async function ensureResidentPanel(api, reason = "startup") {
  const config = api.pluginConfig ?? {};
  if (config.autoPost === false) return { ok: false, skipped: "autoPost disabled" };

  const channelId = panelChannelId(config);
  const accountId = panelAccountId(config);
  const target = `channel:${channelId}`;
  const state = await readPanelState();
  const configuredMessageId = typeof config.panelMessageId === "string" ? config.panelMessageId.trim() : "";
  const knownMessageId = configuredMessageId || (state.channelId === channelId && typeof state.messageId === "string" ? state.messageId : "");
  const spec = panelComponents();

  if (knownMessageId) {
    try {
      return await editOrderedPanelHome(api, channelId, knownMessageId, reason, accountId);
    } catch (error) {
      api.logger.warn(`media panel edit failed; sending replacement: ${String(error)}`);
    }
  }

  const adapter = await api.runtime.channel.outbound.loadAdapter("discord");
  if (!adapter?.sendPayload) throw new Error("Discord outbound adapter with sendPayload is not available");

  const sent = await adapter.sendPayload({
    cfg: api.config,
    to: target,
    text: "Media control panel",
    accountId,
    payload: {
      text: "Media control panel",
      channelData: { discord: { components: spec } }
    }
  });

  const messageId = sent?.messageId;
  if (!messageId) throw new Error("Discord did not return a media panel message id");

  if (adapter.pinDeliveredMessage) {
    try {
      await adapter.pinDeliveredMessage({
        cfg: api.config,
        target: { channel: "discord", to: target, accountId },
        messageId,
        pin: { enabled: true, notify: false, required: false }
      });
    } catch (error) {
      api.logger.warn(`media panel pin failed: ${String(error)}`);
    }
  }

  const nextState = {
    channelId,
    messageId,
    accountId: accountId ?? "default",
    updatedAt: new Date().toISOString(),
    reason,
    mode: "send"
  };
  await writePanelState(nextState);
  return { ok: true, ...nextState };
}

function firstModalFieldValue(fields) {
  if (!Array.isArray(fields)) return "";
  for (const field of fields) {
    if (typeof field?.value === "string" && field.value.trim()) return field.value.trim();
    if (Array.isArray(field?.values)) {
      const value = field.values.find((entry) => typeof entry === "string" && entry.trim());
      if (value) return value.trim();
    }
  }
  return "";
}

function modalFieldValue(fields, name) {
  if (!Array.isArray(fields)) return "";
  const target = String(name ?? "");
  const field = fields.find((entry) => String(entry?.name ?? "") === target || String(entry?.id ?? "") === target);
  if (!field) return "";
  if (typeof field.value === "string") return field.value.trim();
  if (Array.isArray(field.values)) {
    const value = field.values.find((entry) => typeof entry === "string" && entry.trim());
    return value ? value.trim() : "";
  }
  return "";
}

function normalizeSearchKind(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["series", "tv", "television", "show", "shows"].includes(normalized)) return "series";
  return "movie";
}

const MEDIA_COMMAND_ARGS = [
  {
    name: "action",
    description: "status, panel, search, series, queue, issues, indexers, missing, or history",
    type: "string",
    choices: ["status", "panel", "search", "series", "queue", "issues", "indexers", "missing", "history"]
  },
  {
    name: "input",
    description: "Search query or extra input",
    type: "string",
    captureRemaining: true
  }
];

function handleMediaAction(action, input) {
  if (action === "panel") {
    return mediaPanelReply();
  }

  if ((action === "search" || action === "series") && !input) {
    return {
      continueAgent: false,
      text: "Use `/media search <movie title>`, `/media series <series title>`, or `/media-panel` for the panel."
    };
  }

  return {
    continueAgent: true,
    text: action === "search" || action === "series" ? `Searching media for "${input}"...` : `Checking media ${action}...`
  };
}

export default definePluginEntry({
  id: "media-commands",
  name: "Media Commands",
  description: "Persistent Discord media panel and media stack shortcuts.",
  register(api) {
    const startupTimer = setTimeout(() => {
      ensureResidentPanel(api, "startup").catch((error) => {
        api.logger.warn(`media panel startup repair failed: ${String(error)}`);
      });
    }, 4000);
    const repairTimer = setInterval(() => {
      ensureResidentPanel(api, "periodic-repair").catch((error) => {
        api.logger.warn(`media panel periodic repair failed: ${String(error)}`);
      });
    }, PANEL_REPAIR_INTERVAL_MS);

    api.lifecycle.registerRuntimeLifecycle({
      id: "media-panel-startup-timer",
      description: "Clear media panel repair timers during plugin cleanup.",
      cleanup: () => {
        clearTimeout(startupTimer);
        clearInterval(repairTimer);
        clearPanelAutoReset();
        clearPanelRequestFollow();
      }
    });

    api.registerInteractiveHandler({
      channel: "discord",
      namespace: "media-panel",
      handler: async (ctx) => {
        const rawAction = String(ctx?.interaction?.payload ?? "").trim();
        const action = rawAction.toLowerCase();
        const normalizedRaw = rawAction.startsWith("media-panel:") ? rawAction.slice("media-panel:".length) : rawAction;
        const normalized = normalizedRaw.toLowerCase();
        if (normalized === "combined-preview") {
          const selected = Array.isArray(ctx?.interaction?.values)
            ? ctx.interaction.values.find((value) => typeof value === "string" && value.trim())
            : "";
          if (String(selected).startsWith("media-panel:series-preview:") || /\btvdb\b/i.test(String(selected))) {
            const tvdbId = await resolvePreviewTvdbIdFromSelection(api, selected);
            if (!tvdbId) {
              await ctx.respond.reply({
                text: "Series preview is missing a TVDB id.",
                ephemeral: true
              });
              return { handled: true };
            }
            await ctx.respond.acknowledge();
            await editResidentPanel(api, panelWorkingComponents("Preview loading"), `working:series-preview:${tvdbId}`).catch((error) => {
              api.logger.warn(`media panel series preview working update failed: ${String(error)}`);
            });
            void updatePanelFromSeriesPreview(api, tvdbId).catch((error) => {
              api.logger.warn(`media panel series preview update failed: ${String(error)}`);
            });
            return { handled: true };
          }

          const tmdbId = await resolvePreviewTmdbIdFromSelection(api, selected);
          if (!tmdbId) {
            await ctx.respond.reply({
              text: "Movie preview is missing a TMDB id.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          await editResidentPanel(api, panelWorkingComponents("Preview loading"), `working:preview:${tmdbId}`).catch((error) => {
            api.logger.warn(`media panel preview working update failed: ${String(error)}`);
          });
          void updatePanelFromPreview(api, tmdbId).catch((error) => {
            api.logger.warn(`media panel preview update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized === "preview") {
          const selected = Array.isArray(ctx?.interaction?.values)
            ? ctx.interaction.values.find((value) => typeof value === "string" && value.trim())
            : "";
          const tmdbId = await resolvePreviewTmdbIdFromSelection(api, selected);
          if (!tmdbId) {
            await ctx.respond.reply({
              text: "Movie preview is missing a TMDB id.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          await editResidentPanel(api, panelWorkingComponents("Preview loading"), `working:preview:${tmdbId}`).catch((error) => {
            api.logger.warn(`media panel preview working update failed: ${String(error)}`);
          });
          void updatePanelFromPreview(api, tmdbId).catch((error) => {
            api.logger.warn(`media panel preview update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized.startsWith("preview:")) {
          const tmdbId = parseTmdbId(normalized);
          if (!tmdbId) {
            await ctx.respond.reply({
              text: "Movie preview is missing a TMDB id.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          await editResidentPanel(api, panelWorkingComponents("Preview loading"), `working:preview:${tmdbId}`).catch((error) => {
            api.logger.warn(`media panel preview working update failed: ${String(error)}`);
          });
          void updatePanelFromPreview(api, tmdbId).catch((error) => {
            api.logger.warn(`media panel preview update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized === "series-preview") {
          const selected = Array.isArray(ctx?.interaction?.values)
            ? ctx.interaction.values.find((value) => typeof value === "string" && value.trim())
            : "";
          const tvdbId = await resolvePreviewTvdbIdFromSelection(api, selected);
          if (!tvdbId) {
            await ctx.respond.reply({
              text: "Series preview is missing a TVDB id.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          await editResidentPanel(api, panelWorkingComponents("Preview loading"), `working:series-preview:${tvdbId}`).catch((error) => {
            api.logger.warn(`media panel series preview working update failed: ${String(error)}`);
          });
          void updatePanelFromSeriesPreview(api, tvdbId).catch((error) => {
            api.logger.warn(`media panel series preview update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized.startsWith("series-preview:")) {
          const tvdbId = parseTvdbId(normalized);
          if (!tvdbId) {
            await ctx.respond.reply({
              text: "Series preview is missing a TVDB id.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          await editResidentPanel(api, panelWorkingComponents("Preview loading"), `working:series-preview:${tvdbId}`).catch((error) => {
            api.logger.warn(`media panel series preview working update failed: ${String(error)}`);
          });
          void updatePanelFromSeriesPreview(api, tvdbId).catch((error) => {
            api.logger.warn(`media panel series preview update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized.startsWith("request:")) {
          const state = normalizedRaw.slice("request:".length);
          const request = decodePanelRequestState(state);
          const entityId = requestEntityId(request) || parseTmdbId(normalizedRaw) || parseTvdbId(normalizedRaw);
          if (!entityId) {
            await ctx.respond.reply({
              text: "Media request is missing an id.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          void updatePanelFromRequest(api, request ?? entityId).catch((error) => {
            api.logger.warn(`media panel request update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized.startsWith("follow:")) {
          const state = normalizedRaw.slice("follow:".length);
          const track = decodePanelFollowState(state);
          if (!track?.tmdbId && !track?.tvdbId && !track?.title) {
            await ctx.respond.reply({
              text: "Media tracking state is missing an id.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          void updatePanelFromFollow(api, { ...track, polls: Number(track.polls ?? 0) + 1 }).catch((error) => {
            api.logger.warn(`media panel follow update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized.startsWith("option:")) {
          const match = normalizedRaw.match(/^option:([^:]+):(.+)$/);
          const fieldId = match?.[1];
          const request = decodePanelRequestState(match?.[2]);
          const selected = firstInteractionValue(ctx?.interaction?.values);
          if (!fieldId || !requestEntityId(request) || !selected) {
            await ctx.respond.reply({
              text: "Media option update is missing a selected value.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          void updatePanelFromOption(api, fieldId, request, selected).catch((error) => {
            api.logger.warn(`media panel option update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized.startsWith("toggle:")) {
          const match = normalizedRaw.match(/^toggle:([^:]+):(.+)$/);
          const fieldId = match?.[1];
          const request = decodePanelRequestState(match?.[2]);
          if (!fieldId || !requestEntityId(request)) {
            await ctx.respond.reply({
              text: "Media toggle update is missing request state.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          void updatePanelFromToggle(api, fieldId, request).catch((error) => {
            api.logger.warn(`media panel toggle update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized === "search") {
          const query = modalFieldValue(ctx?.interaction?.fields, "query") || firstModalFieldValue(ctx?.interaction?.fields);
          if (!query) {
            await ctx.respond.reply({
              text: "Search needs a title.",
              ephemeral: true
            });
            return { handled: true };
          }
          const kind = normalizeSearchKind(modalFieldValue(ctx?.interaction?.fields, "kind"));
          await ctx.respond.acknowledge();
          void updatePanelFromAction(api, kind === "series" ? "series" : "search", query).catch((error) => {
            api.logger.warn(`media panel ${kind === "series" ? "series" : "search"} update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized === "movie-search") {
          const query = modalFieldValue(ctx?.interaction?.fields, "query") || firstModalFieldValue(ctx?.interaction?.fields);
          if (!query) {
            await ctx.respond.reply({
              text: "Search needs a movie title.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          void updatePanelFromAction(api, "search", query).catch((error) => {
            api.logger.warn(`media panel search update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized === "series-search") {
          const query = modalFieldValue(ctx?.interaction?.fields, "query") || firstModalFieldValue(ctx?.interaction?.fields);
          if (!query) {
            await ctx.respond.reply({
              text: "Search needs a series title.",
              ephemeral: true
            });
            return { handled: true };
          }
          await ctx.respond.acknowledge();
          void updatePanelFromAction(api, "series", query).catch((error) => {
            api.logger.warn(`media panel series search update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        if (normalized === "search-kind") {
          await ctx.respond.acknowledge();
          await editResidentPanel(api, panelComponents(), "search-kind");
          return { handled: true };
        }

        if (normalized === "movie") {
          await ctx.respond.acknowledge();
          await editResidentPanel(api, movieSearchPanelComponents(), "movie-search");
          return { handled: true };
        }

        if (normalized === "series") {
          await ctx.respond.acknowledge();
          await editResidentPanel(api, seriesSearchPanelComponents(), "series-search");
          return { handled: true };
        }

        if (PANEL_ACTIONS.has(normalized)) {
          await ctx.respond.acknowledge();
          void updatePanelFromAction(api, normalized, "").catch((error) => {
            api.logger.warn(`media panel ${normalized} update failed: ${String(error)}`);
          });
          return { handled: true };
        }

        await ctx.respond.reply({
          text: "Unknown media panel action.",
          ephemeral: true
        });
        return { handled: true };
      }
    });

    api.registerCommand({
      name: "media",
      description: "Check media stack status, open panel, search, queue, issues, indexers, missing, or history.",
      acceptsArgs: true,
      args: MEDIA_COMMAND_ARGS,
      argsMenu: "auto",
      requireAuth: true,
      agentPromptGuidance: GUIDANCE,
      handler: async (ctx) => {
        const { action, input } = parseMediaInput(ctx);
        if (action === "panel") {
          const result = await ensureResidentPanel(api, "command");
          return {
            continueAgent: false,
            text: result.ok
              ? `Media panel ${result.mode === "edit" ? "refreshed" : "posted"} in <#${result.channelId}>.`
              : `Media panel repair skipped: ${result.skipped ?? "unknown reason"}.`
          };
        }
        return handleMediaAction(action, input);
      }
    });

    api.registerCommand({
      name: "media-panel",
      description: "Open the persistent media control panel.",
      acceptsArgs: false,
      requireAuth: true,
      nativeProgressMessages: {
        default: "Repairing media panel..."
      },
      handler: async () => {
        const result = await ensureResidentPanel(api, "command");
        return {
          continueAgent: false,
          text: result.ok
            ? `Media panel ${result.mode === "edit" ? "refreshed" : "posted"} in <#${result.channelId}>.`
            : `Media panel repair skipped: ${result.skipped ?? "unknown reason"}.`
        };
      }
    });
  }
});
