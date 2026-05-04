/**
 * OpenClaw Feedback Plugin
 *
 * Sends a single interactive Feishu card per agent run and edits it
 * in-place as the run progresses. Each tool call adds a descriptive
 * line (e.g., "Read src/config.ts", "Run `npm test`"), and the final
 * card shows a completion summary.
 *
 * IMPORTANT: The gateway calls register() once per agent session, so
 * all mutable state (tracker, sessions, gwClient, cardQueues) lives
 * at module scope to be shared across all sessions.
 *
 * Hooks used:
 *   message_received   — capture conversation context per session
 *   message_sent        — refine outbound target from proven send path
 *   model_call_started  — send initial "thinking" card (or update)
 *   before_tool_call    — add step to card
 *   after_tool_call     — mark step done, update card
 *   agent_end           — replace card with completion/error card
 *   gateway_stop        — cleanup
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig, type FeedbackPluginConfig } from "./src/config.js";
import { RunTracker } from "./src/run-tracker.js";
import { describeToolCall } from "./src/formatters.js";
import { FeedbackGatewayClient } from "./src/gateway-client.js";
import {
  buildProgressCard,
  buildCompletionCard,
  buildErrorCard,
} from "./src/feishu-cards.js";

type ConversationContext = {
  channelId: string;
  to: string;
  accountId?: string;
  threadId?: string;
};

// ── Module-level shared state ──────────────────────────────────
// The gateway calls register() per agent session; these singletons
// ensure all sessions share the same tracker, WS client, etc.

let sharedConfig: FeedbackPluginConfig | null = null;
let tracker: RunTracker | null = null;
let gwClient: FeedbackGatewayClient | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
const sessions = new Map<string, ConversationContext>();
const cardQueues = new Map<string, Promise<void>>();

function getConfig(pluginConfig?: Record<string, unknown>): FeedbackPluginConfig {
  if (!sharedConfig) sharedConfig = resolveConfig(pluginConfig);
  return sharedConfig;
}

function getTracker(config: FeedbackPluginConfig): RunTracker {
  if (!tracker) {
    tracker = new RunTracker({
      debounceMs: config.debounceMs,
      runTtlMs: config.runTtlMs,
    });
    sweepTimer = setInterval(() => tracker!.sweepStale(), config.runTtlMs);
  }
  return tracker;
}

function getGwClient(): FeedbackGatewayClient {
  if (!gwClient) gwClient = new FeedbackGatewayClient();
  return gwClient;
}

function enqueueCardOp(runId: string, op: () => Promise<void>): void {
  const prev = cardQueues.get(runId) ?? Promise.resolve();
  const next = prev.then(op, op);
  cardQueues.set(runId, next);
}

function cleanupCardQueue(runId: string): void {
  cardQueues.delete(runId);
}

const log = (msg: string, ...args: unknown[]) =>
  console.error(`[feedback] ${msg}`, ...args);

async function ensureConnected(): Promise<boolean> {
  try {
    const client = getGwClient();
    if (!client.connected) await client.connect();
    return true;
  } catch {
    return false;
  }
}

// ── Card operations (use shared state) ────────────────────────

async function sendInitialCard(
  runId: string,
  sessionKey: string | undefined,
  config: FeedbackPluginConfig,
  t: RunTracker,
): Promise<void> {
  if (!sessionKey) return;
  const ctx = sessions.get(sessionKey);
  if (!ctx) { log("sendInitialCard SKIP: no ctx", { runId, sessionKey: sessionKey.slice(-12) }); return; }
  if (!(await ensureConnected())) return;

  const run = t.get(runId);
  if (!run) return;

  const card = buildProgressCard(config.locale, run.steps, run.phase === "thinking");
  try {
    const messageId = await getGwClient().sendCard({
      to: ctx.to,
      card,
      channel: ctx.channelId,
      accountId: ctx.accountId,
      sessionKey,
    });
    if (messageId) {
      t.setCardMessageId(runId, messageId);
      log("sendInitialCard OK", { runId: runId.slice(0, 8), messageId });
    }
  } catch (err) {
    log("sendInitialCard ERROR", { runId: runId.slice(0, 8), error: String(err) });
  }
}

async function updateCard(
  runId: string,
  sessionKey: string | undefined,
  config: FeedbackPluginConfig,
  t: RunTracker,
): Promise<void> {
  if (!sessionKey) return;
  const ctx = sessions.get(sessionKey);
  if (!ctx) return;

  const run = t.get(runId);
  if (!run?.cardMessageId) return;
  if (!(await ensureConnected())) return;

  const card = buildProgressCard(config.locale, run.steps, run.phase === "thinking");
  try {
    await getGwClient().editCard({
      messageId: run.cardMessageId,
      card,
      channel: ctx.channelId,
      accountId: ctx.accountId,
    });
  } catch {
    // Best-effort
  }
}

async function sendFinalCard(
  runId: string,
  sessionKey: string | undefined,
  finalCard: Record<string, unknown>,
  t: RunTracker,
): Promise<void> {
  if (!sessionKey) return;
  const ctx = sessions.get(sessionKey);
  if (!ctx) return;
  if (!(await ensureConnected())) return;

  const run = t.get(runId);
  try {
    if (run?.cardMessageId) {
      await getGwClient().editCard({
        messageId: run.cardMessageId,
        card: finalCard,
        channel: ctx.channelId,
        accountId: ctx.accountId,
      });
    } else {
      await getGwClient().sendCard({
        to: ctx.to,
        card: finalCard,
        channel: ctx.channelId,
        accountId: ctx.accountId,
        sessionKey,
      });
    }
    log("sendFinalCard OK", { runId: runId.slice(0, 8) });
  } catch (err) {
    log("sendFinalCard ERROR", { runId: runId.slice(0, 8), error: String(err) });
  }
}

/** Resolve the best sessionKey that has stored conversation context.
 *  Hooks may arrive with a different sessionKey than message_received used. */
function resolveSessionKey(
  runId: string,
  sessionKey: string | undefined,
  t: RunTracker,
): string | undefined {
  // 1. Current sessionKey has context — use it directly
  if (sessionKey && sessions.has(sessionKey)) return sessionKey;
  // 2. Run's stored sessionKey has context — use the original
  const run = t.get(runId);
  if (run?.sessionKey && sessions.has(run.sessionKey)) return run.sessionKey;
  // 3. Find any session with a matching channelId (same bot/channel)
  if (run?.channelId) {
    for (const [key, ctx] of sessions) {
      if (ctx.channelId === run.channelId) {
        // Also propagate: store under current sessionKey for future lookups
        if (sessionKey) sessions.set(sessionKey, ctx);
        return key;
      }
    }
  }
  return sessionKey;
}

// ── dispatch helper ───────────────────────────────────────────

function handleAction(
  action: ReturnType<RunTracker["onModelCallStarted"]>,
  runId: string,
  sessionKey: string | undefined,
  config: FeedbackPluginConfig,
  t: RunTracker,
): void {
  switch (action.kind) {
    case "send_card":
      enqueueCardOp(runId, () => sendInitialCard(runId, sessionKey, config, t));
      break;
    case "update_card":
      enqueueCardOp(runId, () => updateCard(runId, sessionKey, config, t));
      break;
    case "final_card": {
      const run = t.get(runId);
      const card = buildCompletionCard(
        config.locale,
        run?.steps ?? [],
        action.durationMs,
      );
      enqueueCardOp(runId, () => sendFinalCard(runId, sessionKey, card, t));
      break;
    }
    case "error_card": {
      const run = t.get(runId);
      const card = buildErrorCard(
        config.locale,
        run?.steps ?? [],
        action.message,
        action.durationMs,
      );
      enqueueCardOp(runId, () => sendFinalCard(runId, sessionKey, card, t));
      break;
    }
  }
}

export default definePluginEntry({
  id: "feedback",
  name: "Real-time Feedback",
  description:
    "Sends a single updatable card with real-time execution progress to channels",

  register(api) {
    const config = getConfig(api.pluginConfig as Record<string, unknown> | undefined);
    if (!config.enabled) return;

    const t = getTracker(config);

    // ── capture conversation context ──────────────────────────

    api.on("message_received", (event, ctx) => {
      if (!ctx.sessionKey) return;
      const to = ctx.conversationId ?? event.from;
      if (!to) return;
      const threadId =
        event.threadId != null ? String(event.threadId) : undefined;
      sessions.set(ctx.sessionKey, {
        channelId: ctx.channelId,
        to,
        accountId: ctx.accountId,
        threadId,
      });
    });

    api.on("message_sent", (event, ctx) => {
      if (!ctx.sessionKey || !event.to || !event.success) return;
      const existing = sessions.get(ctx.sessionKey);
      if (existing) {
        existing.to = event.to;
      } else {
        sessions.set(ctx.sessionKey, {
          channelId: ctx.channelId,
          to: event.to,
          accountId: ctx.accountId,
        });
      }
    });

    // ── agent thinking ────────────────────────────────────────

    if (config.events.thinking) {
      api.on("model_call_started", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = t.onModelCallStarted(runId, {
          sessionKey: ctx.sessionKey,
          channelId: ctx.channelId,
          agentId: ctx.agentId,
        });
        const sk = resolveSessionKey(runId, ctx.sessionKey, t);
        handleAction(action, runId, sk, config, t);
      });
    }

    // ── tool calls ────────────────────────────────────────────

    if (config.events.toolCalls) {
      api.on("before_tool_call", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const desc = describeToolCall(
          event.toolName,
          event.params as Record<string, unknown> | undefined,
          config.locale,
        );
        const action = t.onBeforeToolCall(runId, desc, event.toolName, {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
        const sk = resolveSessionKey(runId, ctx.sessionKey, t);
        handleAction(action, runId, sk, config, t);
      });
    }

    // ── tool results ──────────────────────────────────────────

    if (config.events.toolResults) {
      api.on("after_tool_call", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = t.onAfterToolCall(runId, event.toolName, event.error);
        const sk = resolveSessionKey(runId, ctx.sessionKey, t);
        handleAction(action, runId, sk, config, t);
      });
    }

    // ── agent end ─────────────────────────────────────────────

    if (config.events.completion) {
      api.on("agent_end", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = t.onAgentEnd(runId, event.success, event.error);
        const sk = resolveSessionKey(runId, ctx.sessionKey, t);
        handleAction(action, runId, sk, config, t);
        // Delayed cleanup so the final card edit has time to complete
        setTimeout(() => {
          t.cleanup(runId);
          cleanupCardQueue(runId);
          if (ctx.sessionKey) sessions.delete(ctx.sessionKey);
        }, 5_000);
      });
    }

    // ── gateway lifecycle ─────────────────────────────────────

    api.on("gateway_stop", () => {
      if (gwClient) { gwClient.disconnect(); gwClient = null; }
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      cardQueues.clear();
      sessions.clear();
      tracker = null;
      sharedConfig = null;
    });
  },
});
