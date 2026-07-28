import { spawn } from "node:child_process";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const NAMESPACE = "reminder-actions";
const REMINDER_NAMESPACE = "reminder";
const RUNNER = "/Volumes/dockerDisk/openclaw/reminders/reminder_runner.py";
const ENV_WRAPPER = "/Users/server/.openclaw/service-env/ai.openclaw.reminder-interactions-env-wrapper.sh";
const DEFAULT_TIME_ZONE = "America/Los_Angeles";

function encodeState(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeState(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value ?? ""), "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseSetDonePayload(payload) {
  const raw = String(payload ?? "").trim();
  const value = raw.startsWith("set-done-time:") ? raw.slice("set-done-time:".length) : raw;
  const match = value.match(/^([^:]+):([^:]+)$/);
  if (!match) return null;
  return { taskId: match[1], nonce: match[2] };
}

function parseSubmitPayload(payload) {
  const raw = String(payload ?? "").trim();
  const encoded = raw.startsWith("submit-set-done-time:") ? raw.slice("submit-set-done-time:".length) : "";
  return encoded ? decodeState(encoded) : {};
}

function parseReminderPayload(payload) {
  const raw = String(payload ?? "").trim();
  const match = raw.match(/^(done|snooze|skip_once):(.+)$/);
  if (!match) return null;
  const action = match[1];
  const value = match[2];
  const parts = value.split(":");
  if (parts.length < 2) return null;
  return {
    action,
    value,
    taskId: parts[0],
    nonce: parts[1],
    preset: parts.slice(2).join(":") || undefined
  };
}

function inputValue(inputs, actionId, key) {
  const found = Array.isArray(inputs)
    ? inputs.find((entry) => entry?.actionId === actionId)
    : undefined;
  return found?.[key] ? String(found[key]) : "";
}

function offsetForLocalTime(timeZone, date, time) {
  const probe = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(probe);
  const zoneName = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = zoneName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return "+00:00";
  const sign = match[1];
  const hours = match[2].padStart(2, "0");
  const minutes = (match[3] ?? "00").padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function completedAtIso(date, time, timeZone = DEFAULT_TIME_ZONE) {
  return `${date}T${time}:00${offsetForLocalTime(timeZone, date, time)}`;
}

function localToday(timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function localNowTime(timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
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

function runReminderComplete({ taskId, nonce, messageTs, completedAt }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ENV_WRAPPER, [
      "/usr/bin/python3",
      RUNNER,
      "--transport",
      "slack",
      "--complete",
      "--action-value",
      `${taskId}:${nonce}`,
      "--message-id",
      String(messageTs ?? ""),
      "--completed-at",
      completedAt,
      "--json"
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `reminder runner exited ${code}`));
      }
    });
  });
}

function runReminderAction({ action, actionValue, messageTs }) {
  return new Promise((resolve, reject) => {
    const actionFlag = action === "done" ? "--complete"
      : action === "snooze" ? "--snooze"
        : action === "skip_once" ? "--skip-once"
          : undefined;
    if (!actionFlag) {
      reject(new Error(`Unsupported reminder action: ${action}`));
      return;
    }
    const child = spawn(ENV_WRAPPER, [
      "/usr/bin/python3",
      RUNNER,
      "--transport",
      "slack",
      actionFlag,
      "--action-value",
      actionValue,
      "--message-id",
      String(messageTs ?? ""),
      "--json"
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `reminder runner exited ${code}`));
      }
    });
  });
}

function registerReminderButtons(api) {
  api.registerInteractiveHandler({
    channel: "slack",
    namespace: REMINDER_NAMESPACE,
    handler: async (ctx) => {
      const parsed = parseReminderPayload(ctx?.interaction?.payload);
      if (!parsed?.taskId || !parsed?.nonce) return { handled: false };
      try {
        await runReminderAction({
          action: parsed.action,
          actionValue: parsed.value,
          messageTs: ctx?.interaction?.messageTs
        });
        return {
          handled: true,
          systemEvent: {
            summary: `Reminder ${parsed.action === "done" ? "completed" : parsed.action === "snooze" ? "snoozed" : "skipped"}`,
            data: { taskId: parsed.taskId, action: parsed.action, preset: parsed.preset }
          }
        };
      } catch (error) {
        await ctx.respond.reply({
          text: `Reminder action failed: ${error instanceof Error ? error.message : String(error)}`,
          responseType: "ephemeral"
        });
        return { handled: true };
      }
    }
  });
}

export function registerReminderActions(api) {
  registerReminderButtons(api);
  api.registerInteractiveHandler({
      channel: "slack",
      namespace: NAMESPACE,
      handler: async (ctx) => {
        const payload = String(ctx?.interaction?.payload ?? "").trim();
        if (!payload.startsWith("submit-set-done-time:")) {
          const parsed = parseSetDonePayload(payload);
          if (!parsed?.taskId || !parsed?.nonce) return { handled: false };
          const triggerId = ctx?.interaction?.triggerId;
          if (!triggerId) {
            await ctx.respond.reply({ text: "Could not open the date/time picker from this click.", ephemeral: true });
            return { handled: true };
          }
          const messageTs = ctx?.interaction?.messageTs;
          const channelId = ctx?.conversationId;
          const metadata = {
            channelId,
            channelType: "channel",
            userId: ctx?.senderId,
            pluginInteractiveData: `${NAMESPACE}:submit-set-done-time:${encodeState({
              taskId: parsed.taskId,
              nonce: parsed.nonce,
              messageTs,
              timeZone: DEFAULT_TIME_ZONE
            })}`
          };
          await slackApi("views.open", {
            trigger_id: triggerId,
            view: {
              type: "modal",
              callback_id: "openclaw:reminder-actions",
              private_metadata: JSON.stringify(metadata),
              title: { type: "plain_text", text: "Set done time" },
              submit: { type: "plain_text", text: "Save" },
              close: { type: "plain_text", text: "Cancel" },
              blocks: [
                {
                  type: "input",
                  block_id: "completed_date_block",
                  label: { type: "plain_text", text: "Date completed" },
                  element: {
                    type: "datepicker",
                    action_id: "completed_date",
                    initial_date: localToday(DEFAULT_TIME_ZONE)
                  }
                },
                {
                  type: "input",
                  block_id: "completed_time_block",
                  label: { type: "plain_text", text: "Time completed" },
                  element: {
                    type: "timepicker",
                    action_id: "completed_time",
                    initial_time: localNowTime(DEFAULT_TIME_ZONE)
                  }
                }
              ]
            }
          });
          return { handled: true };
        }

        if (payload.startsWith("submit-set-done-time:")) {
          const state = parseSubmitPayload(payload);
          const date = inputValue(ctx?.interaction?.inputs, "completed_date", "selectedDate");
          const time = inputValue(ctx?.interaction?.inputs, "completed_time", "selectedTime");
          if (!state.taskId || !state.nonce || !state.messageTs || !date || !time) {
            throw new Error("Reminder completion modal is missing state.");
          }
          const completedAt = completedAtIso(date, time, state.timeZone || DEFAULT_TIME_ZONE);
          await runReminderComplete({
            taskId: state.taskId,
            nonce: state.nonce,
            messageTs: state.messageTs,
            completedAt
          });
          return {
            handled: true,
            systemEvent: {
              summary: "Reminder completed with selected done time",
              data: { taskId: state.taskId, completedAt }
            }
          };
        }

        return { handled: false };
      }
  });
}

export default definePluginEntry({
  id: NAMESPACE,
  name: "Reminder Actions",
  version: "0.1.0",
  register(api) {
    registerReminderActions(api);
  }
});
