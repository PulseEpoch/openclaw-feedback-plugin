/**
 * OpenClaw Feedback Plugin
 *
 * Sends a single interactive Feishu card per agent run and edits it
 * in-place as the run progresses. Each tool call adds a descriptive
 * line (e.g., "Read src/config.ts", "Run `npm test`"), and the final
 * card shows a completion summary.
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
import { resolveConfig } from "./src/config.js";
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

export default definePluginEntry({
  id: "feedback",
  name: "Real-time Feedback",
  description:
    "Sends a single updatable card with real-time execution progress to channels",

  register(api) {
    const config = resolveConfig(api.pluginConfig);

    if (!config.enabled) return;

    const tracker = new RunTracker({
      debounceMs: config.debounceMs,
      runTtlMs: config.runTtlMs,
    });

    const gwClient = new FeedbackGatewayClient();

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

    /** Send the initial progress card and store its messageId. */
    async function sendInitialCard(
      runId: string,
      sessionKey: string | undefined,
    ): Promise<void> {
      if (!sessionKey) return;
      const ctx = sessions.get(sessionKey);
      if (!ctx) return;
      if (!(await ensureConnected())) return;

      const run = tracker.get(runId);
      if (!run) return;

      const card = buildProgressCard(
        config.locale,
        run.steps,
        run.phase === "thinking",
      );

      try {
        const messageId = await gwClient.sendCard({
          to: ctx.to,
          card,
          channel: ctx.channelId,
          accountId: ctx.accountId,
          sessionKey,
        });
        if (messageId) {
          tracker.setCardMessageId(runId, messageId);
        }
      } catch {
        // Best-effort
      }
    }

    /** Update the existing progress card in-place. */
    async function updateCard(
      runId: string,
      sessionKey: string | undefined,
    ): Promise<void> {
      if (!sessionKey) return;
      const ctx = sessions.get(sessionKey);
      if (!ctx) return;

      const run = tracker.get(runId);
      if (!run?.cardMessageId) return;
      if (!(await ensureConnected())) return;

      const card = buildProgressCard(
        config.locale,
        run.steps,
        run.phase === "thinking",
      );

      try {
        await gwClient.editCard({
          messageId: run.cardMessageId,
          card,
          channel: ctx.channelId,
          accountId: ctx.accountId,
        });
      } catch {
        // Best-effort
      }
    }

    /** Replace the card with a final completion or error card. */
    async function sendFinalCard(
      runId: string,
      sessionKey: string | undefined,
      finalCard: Record<string, unknown>,
    ): Promise<void> {
      if (!sessionKey) return;
      const ctx = sessions.get(sessionKey);
      if (!ctx) return;

      const run = tracker.get(runId);
      if (!(await ensureConnected())) return;

      try {
        if (run?.cardMessageId) {
          await gwClient.editCard({
            messageId: run.cardMessageId,
            card: finalCard,
            channel: ctx.channelId,
            accountId: ctx.accountId,
          });
        } else {
          await gwClient.sendCard({
            to: ctx.to,
            card: finalCard,
            channel: ctx.channelId,
            accountId: ctx.accountId,
            sessionKey,
          });
        }
      } catch {
        // Best-effort
      }
    }

    // ── dispatch helper ───────────────────────────────────────

    function handleAction(
      action: ReturnType<RunTracker["onModelCallStarted"]>,
      runId: string,
      sessionKey: string | undefined,
    ): void {
      switch (action.kind) {
        case "send_card":
          void sendInitialCard(runId, sessionKey);
          break;
        case "update_card":
          void updateCard(runId, sessionKey);
          break;
        case "final_card": {
          const run = tracker.get(runId);
          const card = buildCompletionCard(
            config.locale,
            run?.steps ?? [],
            action.durationMs,
          );
          void sendFinalCard(runId, sessionKey, card);
          break;
        }
        case "error_card": {
          const run = tracker.get(runId);
          const card = buildErrorCard(
            config.locale,
            run?.steps ?? [],
            action.message,
            action.durationMs,
          );
          void sendFinalCard(runId, sessionKey, card);
          break;
        }
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
        handleAction(action, runId, ctx.sessionKey);
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
        const action = tracker.onBeforeToolCall(runId, desc, event.toolName, {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
        handleAction(action, runId, ctx.sessionKey);
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
          event.error,
        );
        handleAction(action, runId, ctx.sessionKey);
      });
    }

    // ── agent end ─────────────────────────────────────────────

    if (config.events.completion) {
      api.on("agent_end", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = tracker.onAgentEnd(runId, event.success, event.error);
        handleAction(action, runId, ctx.sessionKey);
        // Delayed cleanup so the final card edit has time to complete
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
