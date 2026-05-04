/**
 * Feishu interactive card builders (schema 2.0).
 *
 * Builds progress and completion cards that are sent once and edited
 * in-place as the agent run progresses.
 */

import type { FeedbackLocale } from "./config.js";
import type { ToolStep } from "./run-tracker.js";

export type FeishuCard = Record<string, unknown>;

type CardColor = "blue" | "green" | "red" | "orange" | "grey" | "turquoise";

// ── localized labels ──────────────────────────────────────────

type CardLabels = {
  progressTitle: string;
  completeTitle: (secs: number) => string;
  errorTitle: string;
  thinking: string;
  noSteps: string;
  summary: (tools: number, secs: number) => string;
  errorFooter: (msg: string) => string;
};

const ZH_LABELS: CardLabels = {
  progressTitle: "任务处理中...",
  completeTitle: (s) => `任务完成 (${s}s)`,
  errorTitle: "任务出错",
  thinking: "正在思考...",
  noSteps: "准备中...",
  summary: (t, s) => `共 ${t} 个步骤 · 耗时 ${s}s`,
  errorFooter: (msg) => `错误: ${msg}`,
};

const EN_LABELS: CardLabels = {
  progressTitle: "Task Processing...",
  completeTitle: (s) => `Task Complete (${s}s)`,
  errorTitle: "Task Error",
  thinking: "Thinking...",
  noSteps: "Preparing...",
  summary: (t, s) => `${t} steps · ${s}s`,
  errorFooter: (msg) => `Error: ${msg}`,
};

function labels(locale: FeedbackLocale): CardLabels {
  return locale === "en" ? EN_LABELS : ZH_LABELS;
}

// ── card builders ─────────────────────────────────────────────

function buildCard(
  title: string,
  color: CardColor,
  markdown: string,
  footer?: string,
): FeishuCard {
  const content = footer ? `${markdown}\n\n---\n${footer}` : markdown;
  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: {
      title: { tag: "plain_text", content: title },
      template: color,
    },
    body: {
      elements: [{ tag: "markdown", content }],
    },
  };
}

/** Build the in-progress card: only the current step + counter. */
export function buildProgressCard(
  locale: FeedbackLocale,
  steps: ToolStep[],
  thinking: boolean,
): FeishuCard {
  const l = labels(locale);
  const total = steps.length;
  const doneCount = steps.filter((s) => s.done).length;

  // Find the latest active (not done) step, or the last step if all done
  const current = [...steps].reverse().find((s) => !s.done) ?? steps[steps.length - 1];

  let body: string;
  if (total === 0) {
    body = thinking ? `🤔 ${l.thinking}` : l.noSteps;
  } else if (current && !current.done) {
    body = `🔥 ${current.description}`;
  } else {
    body = thinking ? `🤔 ${l.thinking}` : `✅ ${current?.description ?? ""}`;
  }

  const footer = total > 0 ? `${doneCount}/${total}` : undefined;
  return buildCard(l.progressTitle, "blue", body, footer);
}

/** Build the final completion card: just the summary. */
export function buildCompletionCard(
  locale: FeedbackLocale,
  steps: ToolStep[],
  durationMs: number,
): FeishuCard {
  const l = labels(locale);
  const secs = Math.round(durationMs / 1000);
  return buildCard(
    l.completeTitle(secs),
    "green",
    l.summary(steps.length, secs),
  );
}

/** Build the error card. */
export function buildErrorCard(
  locale: FeedbackLocale,
  steps: ToolStep[],
  errorMsg: string,
  durationMs: number,
): FeishuCard {
  const l = labels(locale);
  const secs = Math.round(durationMs / 1000);
  return buildCard(
    l.errorTitle,
    "red",
    `❌ ${errorMsg}`,
    l.summary(steps.length, secs),
  );
}
