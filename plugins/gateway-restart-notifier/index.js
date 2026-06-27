import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(PLUGIN_DIR, "restart-notifier-state.json");
const HANDOFF_FILENAME = "gateway-supervisor-restart-handoff.json";
const DEFAULT_CHANNEL_ID = "1516325131243229244";
const DEFAULT_STARTUP_DELAY_MS = 5000;
const DEFAULT_MAX_HANDOFF_AGE_MS = 10 * 60 * 1000;
const DEFAULT_RECOVERY_WATCH_DELAY_MS = 2 * 60 * 1000;
const DEFAULT_RECOVERY_FINAL_DELAY_MS = 6 * 60 * 1000;

function stateDir() {
  const configured = process.env.OPENCLAW_STATE_DIR?.trim();
  return configured || join(homedir(), ".openclaw");
}

function handoffPath() {
  return join(stateDir(), HANDOFF_FILENAME);
}

function sessionsStorePath() {
  return join(stateDir(), "agents", "main", "sessions", "sessions.json");
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asPositiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function uniqueStrings(values) {
  return [...new Set(values.map(asString).filter(Boolean))];
}

function configuredChannelIds(config) {
  const fromList = Array.isArray(config.channelIds) ? config.channelIds : [];
  const configured = uniqueStrings([...fromList, config.channelId]);
  return configured.length > 0 ? configured : [DEFAULT_CHANNEL_ID];
}

function validHandoff(value, now = Date.now(), maxAgeMs = DEFAULT_MAX_HANDOFF_AGE_MS) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind !== "gateway-supervisor-restart-handoff" || value.version !== 1) return null;
  const intentId = asString(value.intentId);
  const source = asString(value.source);
  const restartKind = asString(value.restartKind);
  const supervisorMode = asString(value.supervisorMode);
  const reason = asString(value.reason);
  const processInstanceId = asString(value.processInstanceId);
  const pid = Number(value.pid);
  const createdAt = Number(value.createdAt);
  if (!intentId || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (now < createdAt || now - createdAt > maxAgeMs) return null;
  return {
    intentId,
    pid,
    createdAt: Math.floor(createdAt),
    source,
    restartKind,
    supervisorMode,
    reason,
    processInstanceId
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readSessionsStore(path) {
  const store = await readJson(path);
  return store && typeof store === "object" && !Array.isArray(store) ? store : {};
}

async function readPendingHandoff(maxAgeMs) {
  const path = handoffPath();
  if (!existsSync(path)) return null;
  return validHandoff(await readJson(path), Date.now(), maxAgeMs);
}

async function readState() {
  const state = await readJson(STATE_PATH);
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

async function writeState(state) {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function formatAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatMessage(handoff) {
  const age = formatAge(Date.now() - handoff.createdAt);
  const unix = Math.floor(handoff.createdAt / 1000);
  const detail = [
    `kind=${handoff.restartKind || "unknown"}`,
    `via=${handoff.supervisorMode || "unknown"}`,
    `source=${handoff.source || "unknown"}`,
    handoff.reason ? `reason=${handoff.reason}` : null,
    `oldPid=${handoff.pid}`,
    `newPid=${process.pid}`,
    `age=${age}`
  ].filter(Boolean).join(" ");
  return `Gateway restarted <t:${unix}:T>\n${detail}`;
}

function formatComponentDetails(handoff) {
  const age = formatAge(Date.now() - handoff.createdAt);
  return [
    `**Restart**: ${handoff.restartKind || "unknown"} via ${handoff.supervisorMode || "unknown"}`,
    `**Source**: ${handoff.source || "unknown"}`,
    handoff.reason ? `**Reason**: ${handoff.reason}` : null,
    `**Process**: ${handoff.pid} -> ${process.pid}`,
    `**Detected**: ${age} after handoff`
  ].filter(Boolean).join("\n");
}

function alertComponents(handoff) {
  const unix = Math.floor(handoff.createdAt / 1000);
  return {
    reusable: true,
    container: { accentColor: "#2f81f7" },
    text: [
      "## Gateway Restarted",
      `Back online after a supervised restart at <t:${unix}:T>.`
    ].join("\n"),
    blocks: [
      {
        type: "text",
        text: formatComponentDetails(handoff)
      }
    ]
  };
}

function displaySessionName(sessionKey, entry) {
  return asString(entry?.displayName) || asString(entry?.groupChannel) || sessionKey;
}

function latestRecoveryRun(entry) {
  const runs = Array.isArray(entry?.restartRecoveryRuns) ? entry.restartRecoveryRuns : [];
  return runs.map((run) => ({
    runId: asString(run?.runId),
    lifecycleGeneration: asString(run?.lifecycleGeneration)
  })).filter((run) => run.runId || run.lifecycleGeneration).at(-1) ?? null;
}

function wasTouchedByRestart(entry, handoff) {
  const values = [
    Number(entry?.updatedAt),
    Number(entry?.startedAt),
    Number(entry?.endedAt),
    Number(entry?.pendingFinalDeliveryCreatedAt),
    Number(entry?.pendingFinalDeliveryLastAttemptAt)
  ];
  return values.some((value) => Number.isFinite(value) && value >= handoff.createdAt - 30_000);
}

function recoveredSessions(store, handoff) {
  return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }))
    .filter(({ entry }) => latestRecoveryRun(entry))
    .filter(({ entry }) => wasTouchedByRestart(entry, handoff))
    .sort((a, b) => displaySessionName(a.sessionKey, a.entry).localeCompare(displaySessionName(b.sessionKey, b.entry)));
}

function recoveryState(entry, now = Date.now()) {
  const status = asString(entry?.status) || "unknown";
  const pendingFinalDelivery = entry?.pendingFinalDelivery === true || Boolean(asString(entry?.pendingFinalDeliveryText));
  const endedAt = Number(entry?.endedAt);
  const startedAt = Number(entry?.startedAt);
  const updatedAt = Number(entry?.updatedAt);
  const ageBase = Number.isFinite(startedAt) ? startedAt : Number.isFinite(updatedAt) ? updatedAt : now;
  const runtimeMs = Number.isFinite(endedAt) && Number.isFinite(startedAt) ? Math.max(0, endedAt - startedAt) : Math.max(0, now - ageBase);

  if (pendingFinalDelivery) return {
    level: "warning",
    label: "pending final delivery",
    status,
    runtimeMs
  };
  if (["failed", "timeout", "error", "aborted"].includes(status)) return {
    level: "warning",
    label: status,
    status,
    runtimeMs
  };
  if (status === "running") return {
    level: "running",
    label: `still running (${formatAge(runtimeMs)})`,
    status,
    runtimeMs
  };
  return {
    level: "ok",
    label: status === "done" || status === "success" ? "completed" : status,
    status,
    runtimeMs
  };
}

function recoveryProblemSessions(store, handoff, stage, minRunningMs) {
  const now = Date.now();
  const sessions = recoveredSessions(store, handoff);
  const rows = sessions.map(({ sessionKey, entry }) => ({
    sessionKey,
    name: displaySessionName(sessionKey, entry),
    run: latestRecoveryRun(entry),
    state: recoveryState(entry, now)
  }));
  const problems = rows.filter((row) => {
    if (row.state.level === "warning") return true;
    if (row.state.level === "running" && row.state.runtimeMs >= minRunningMs) return true;
    return false;
  });
  return { rows, problems };
}

function recoverySummaryText(handoff, stage, problems, rows) {
  const title = stage === "final" ? "Gateway Recovery Watchdog" : "Gateway Recovery Still Running";
  const lines = [
    title,
    `${problems.length} issue${problems.length === 1 ? "" : "s"} after restart ${handoff.intentId}`,
    `observed=${rows.length}`
  ];
  for (const problem of problems.slice(0, 5)) {
    lines.push(`- ${problem.name}: ${problem.state.label}`);
  }
  return lines.join("\n");
}

function recoveryWatchComponents(handoff, stage, problems, rows) {
  const unix = Math.floor(handoff.createdAt / 1000);
  const problemLines = problems.slice(0, 8).map((problem) => {
    const run = problem.run?.runId ? `\nrun: \`${problem.run.runId}\`` : "";
    return `**${problem.name}**\n${problem.state.label}${run}`;
  });
  const okCount = rows.filter((row) => row.state.level === "ok").length;
  return {
    reusable: true,
    container: { accentColor: "#d29922" },
    text: [
      "## Gateway Recovery Watchdog",
      `Restart at <t:${unix}:T> needs attention.`
    ].join("\n"),
    blocks: [
      {
        type: "text",
        text: [
          `**Stage**: ${stage}`,
          `**Recovered sessions observed**: ${rows.length}`,
          `**Completed cleanly**: ${okCount}`,
          `**Issues**: ${problems.length}`
        ].join("\n")
      },
      {
        type: "text",
        text: problemLines.join("\n\n") || "No problem sessions."
      }
    ]
  };
}

async function sendDiscordAlert(api, handoff, channelIds, accountId) {
  const adapter = await api.runtime.channel.outbound.loadAdapter("discord");
  if (!adapter?.sendPayload) throw new Error("Discord outbound adapter with sendPayload is not available");
  const text = formatMessage(handoff);
  for (const channelId of channelIds) {
    await adapter.sendPayload({
      cfg: api.config,
      to: `channel:${channelId}`,
      text,
      accountId,
      payload: {
        text,
        channelData: {
          discord: {
            components: alertComponents(handoff)
          }
        }
      }
    });
  }
}

async function sendRecoveryWatchAlert(api, handoff, channelIds, accountId, stage, problems, rows) {
  const adapter = await api.runtime.channel.outbound.loadAdapter("discord");
  if (!adapter?.sendPayload) throw new Error("Discord outbound adapter with sendPayload is not available");
  const text = recoverySummaryText(handoff, stage, problems, rows);
  for (const channelId of channelIds) {
    await adapter.sendPayload({
      cfg: api.config,
      to: `channel:${channelId}`,
      text,
      accountId,
      payload: {
        text,
        channelData: {
          discord: {
            components: recoveryWatchComponents(handoff, stage, problems, rows)
          }
        }
      }
    });
  }
}

async function maybeNotify(api, handoff, channelIds, accountId) {
  const state = await readState();
  if (state.lastIntentId === handoff.intentId) return;
  await sendDiscordAlert(api, handoff, channelIds, accountId);
  await writeState({
    lastIntentId: handoff.intentId,
    lastNotifiedAt: new Date().toISOString(),
    lastChannelIds: channelIds,
    lastHandoff: handoff
  });
}

async function maybeNotifyRecoveryWatch(api, handoff, channelIds, accountId, stage, options) {
  const store = await readSessionsStore(options.sessionsPath);
  const { rows, problems } = recoveryProblemSessions(store, handoff, stage, options.minRunningMs);
  if (problems.length === 0) return;

  const state = await readState();
  const notified = state.recoveryWatchNotified && typeof state.recoveryWatchNotified === "object" ? state.recoveryWatchNotified : {};
  const problemKey = problems.map((problem) => `${problem.sessionKey}:${problem.state.status}:${problem.state.label}`).join("|");
  const notifyKey = `${handoff.intentId}:${stage}:${problemKey}`;
  if (notified[notifyKey]) return;

  await sendRecoveryWatchAlert(api, handoff, channelIds, accountId, stage, problems, rows);
  await writeState({
    ...state,
    recoveryWatchNotified: {
      ...notified,
      [notifyKey]: new Date().toISOString()
    },
    lastRecoveryWatch: {
      intentId: handoff.intentId,
      stage,
      problems: problems.map((problem) => ({
        sessionKey: problem.sessionKey,
        name: problem.name,
        status: problem.state.status,
        label: problem.state.label
      })),
      observedSessions: rows.length,
      notifiedAt: new Date().toISOString()
    }
  });
}

export default definePluginEntry({
  id: "gateway-restart-notifier",
  name: "Gateway Restart Notifier",
  description: "Post a Discord alert when the OpenClaw Gateway comes back after a supervised restart.",
  register(api) {
    const config = api.pluginConfig ?? {};
    const channelIds = configuredChannelIds(config);
    const accountId = asString(config.accountId) || undefined;
    const startupDelayMs = asPositiveNumber(config.startupDelayMs, DEFAULT_STARTUP_DELAY_MS);
    const maxHandoffAgeMs = asPositiveNumber(config.maxHandoffAgeMs, DEFAULT_MAX_HANDOFF_AGE_MS);
    const recoveryWatchEnabled = config.recoveryWatchEnabled !== false;
    const recoveryWatchDelayMs = asPositiveNumber(config.recoveryWatchDelayMs, DEFAULT_RECOVERY_WATCH_DELAY_MS);
    const recoveryFinalDelayMs = asPositiveNumber(config.recoveryFinalDelayMs, DEFAULT_RECOVERY_FINAL_DELAY_MS);
    const configuredSessionsPath = asString(config.sessionsPath);
    const recoveryWatchOptions = {
      sessionsPath: configuredSessionsPath || sessionsStorePath(),
      minRunningMs: recoveryWatchDelayMs
    };

    const timers = new Set();
    const schedule = (callback, delayMs) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delayMs);
      timers.add(timer);
    };

    readPendingHandoff(maxHandoffAgeMs).then((handoff) => {
      if (!handoff) return;
      schedule(() => {
        maybeNotify(api, handoff, channelIds, accountId).catch((error) => {
          api.logger.warn(`gateway restart notification failed: ${String(error)}`);
        });
      }, startupDelayMs);
      if (recoveryWatchEnabled) {
        schedule(() => {
          maybeNotifyRecoveryWatch(api, handoff, channelIds, accountId, "watch", recoveryWatchOptions).catch((error) => {
            api.logger.warn(`gateway recovery watch failed: ${String(error)}`);
          });
        }, Math.max(startupDelayMs, recoveryWatchDelayMs));
        schedule(() => {
          maybeNotifyRecoveryWatch(api, handoff, channelIds, accountId, "final", recoveryWatchOptions).catch((error) => {
            api.logger.warn(`gateway recovery final watch failed: ${String(error)}`);
          });
        }, Math.max(startupDelayMs, recoveryFinalDelayMs));
      }
    }).catch((error) => {
      api.logger.warn(`gateway restart handoff read failed: ${String(error)}`);
    });

    api.lifecycle.registerRuntimeLifecycle({
      id: "gateway-restart-notifier",
      description: "Clear pending gateway restart notification timer during plugin cleanup.",
      cleanup: () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      }
    });
  }
});
