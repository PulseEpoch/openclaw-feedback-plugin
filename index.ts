/**
 * OpenClaw Feedback Plugin
 *
 * Sends real-time execution feedback (text + emoji) to the user's channel
 * during agent task processing, so users don't have to wait for the final
 * result to know what's happening.
 *
 * Hooks used:
 *   message_received   — capture conversation context per session
 *   message_sent        — refine outbound target from proven send path
 *   model_call_started  — "thinking" notification
 *   before_tool_call    — tool start / batch notification
 *   after_tool_call     — tool completion notification
 *   agent_end           — completion / error notification
 *   gateway_stop        — cleanup
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./src/config.js";
import { RunTracker } from "./src/run-tracker.js";
import { getMessages, summarizeToolResult } from "./src/formatters.js";
import { FeedbackGatewayClient } from "./src/gateway-client.js";

type ConversationContext = {
  channelId: string;
  to: string;
  accountId?: string;
  threadId?: string;
};

export default definePluginEntry({
  id: "feedback",
  name: "Real-time Feedback",
  description:
    "Sends real-time execution feedback to channels during agent task processing",

  register(api) {
    const config = resolveConfig(api.pluginConfig);

    if (!config.enabled) return;

    const tracker = new RunTracker({
      debounceMs: config.debounceMs,
      runTtlMs: config.runTtlMs,
    });

    const gwClient = new FeedbackGatewayClient();
    const msgs = getMessages(config.locale);

    // sessionKey → conversation context captured from inbound messages
    const sessions = new Map<string, ConversationContext>();

    const sweepTimer = setInterval(() => tracker.sweepStale(), config.runTtlMs);

    // ── helpers ────────────────────────────────────────────────

    async function ensureConnected(): Promise<boolean> {
      try {
        if (!gwClient.connected) await gwClient.connect();
        return true;
      } catch {
        return false;
      }
    }

    async function sendFeedback(
      sessionKey: string | undefined,
      text: string,
    ): Promise<void> {
      if (!sessionKey) return;
      const ctx = sessions.get(sessionKey);
      if (!ctx) return;
      if (!(await ensureConnected())) return;
      try {
        await gwClient.send({
          to: ctx.to,
          channel: ctx.channelId,
          accountId: ctx.accountId,
          threadId: ctx.threadId,
          message: text,
          sessionKey,
        });
      } catch {
        // Best-effort: swallow send errors for feedback messages
      }
    }

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

    // Refine `to` from proven outbound path when available
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
        const action = tracker.onModelCallStarted(runId, {
          sessionKey: ctx.sessionKey,
          channelId: ctx.channelId,
          agentId: ctx.agentId,
        });
        if (action.kind === "thinking") {
          void sendFeedback(ctx.sessionKey, msgs.thinking);
        }
      });
    }

    // ── tool calls ────────────────────────────────────────────

    if (config.events.toolCalls) {
      api.on("before_tool_call", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = tracker.onBeforeToolCall(runId, event.toolName, {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
        if (action.kind === "tool_start") {
          void sendFeedback(ctx.sessionKey, msgs.toolStart(action.name));
        } else if (action.kind === "tool_batch") {
          void sendFeedback(ctx.sessionKey, msgs.toolBatch(action.count));
        }
      });
    }

    // ── tool results ──────────────────────────────────────────

    if (config.events.toolResults) {
      api.on("after_tool_call", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = tracker.onAfterToolCall(
          runId,
          event.toolName,
          event.result,
          event.error,
        );
        if (action.kind === "tool_done") {
          const summary = summarizeToolResult(action.result);
          const text = summary
            ? msgs.toolDoneWithSummary(action.name, summary)
            : msgs.toolDone(action.name);
          void sendFeedback(ctx.sessionKey, text);
        }
      });
    }

    // ── agent end ─────────────────────────────────────────────

    if (config.events.completion) {
      api.on("agent_end", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = tracker.onAgentEnd(runId, event.success, event.error);
        if (action.kind === "done") {
          const secs = Math.round(action.durationMs / 1000);
          void sendFeedback(ctx.sessionKey, msgs.doneWithDuration(secs));
        } else if (action.kind === "error") {
          void sendFeedback(ctx.sessionKey, msgs.error(action.message));
        }
        // Delayed cleanup so the final message has time to send
        setTimeout(() => {
          tracker.cleanup(runId);
          if (ctx.sessionKey) sessions.delete(ctx.sessionKey);
        }, 5_000);
      });
    }

    // ── gateway lifecycle ─────────────────────────────────────

    api.on("gateway_stop", () => {
      gwClient.disconnect();
      clearInterval(sweepTimer);
    });
  },
});
