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

/** Format tool steps into markdown lines for the card body. */
function stepsToMarkdown(steps: ToolStep[]): string {
  if (steps.length === 0) return "";
  const lines: string[] = [];
  for (const step of steps) {
    const icon = step.error ? "❌" : step.done ? "✅" : "🔥";
    lines.push(`${icon} ${step.description}`);
  }
  return lines.join("\n");
}

/** Build the in-progress card shown while the agent is working. */
export function buildProgressCard(
  locale: FeedbackLocale,
  steps: ToolStep[],
  thinking: boolean,
): FeishuCard {
  const l = labels(locale);
  let body: string;
  if (steps.length === 0) {
    body = thinking ? `🤔 ${l.thinking}` : l.noSteps;
  } else {
    const md = stepsToMarkdown(steps);
    body = thinking ? `🤔 ${l.thinking}\n${md}` : md;
  }
  const doneCount = steps.filter((s) => s.done).length;
  const footer = steps.length > 0
    ? `${doneCount}/${steps.length}`
    : undefined;
  return buildCard(l.progressTitle, "blue", body, footer);
}

/** Build the final completion card. */
export function buildCompletionCard(
  locale: FeedbackLocale,
  steps: ToolStep[],
  durationMs: number,
): FeishuCard {
  const l = labels(locale);
  const secs = Math.round(durationMs / 1000);
  const md = stepsToMarkdown(steps);
  const body = md || `✅ ${l.completeTitle(secs)}`;
  return buildCard(
    l.completeTitle(secs),
    "green",
    body,
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
  const md = stepsToMarkdown(steps);
  const body = md ? `${md}\n\n❌ ${errorMsg}` : `❌ ${errorMsg}`;
  return buildCard(
    l.errorTitle,
    "red",
    body,
    l.errorFooter(`${errorMsg} (${secs}s)`),
  );
}
