/**
 * Message formatting for feedback notifications.
 *
 * Produces text+emoji messages in zh or en locale.
 */

import type { FeedbackLocale } from "./config.js";

type Messages = {
  thinking: string;
  toolStart: (name: string) => string;
  toolBatch: (count: number) => string;
  toolDone: (name: string) => string;
  toolDoneWithSummary: (name: string, summary: string) => string;
  done: string;
  doneWithDuration: (seconds: number) => string;
  error: (msg: string) => string;
};

const ZH: Messages = {
  thinking: "\u{1f914} \u6b63\u5728\u601d\u8003...",
  toolStart: (name) => `\u{1f525} \u6b63\u5728\u4f7f\u7528\u5de5\u5177: ${name}...`,
  toolBatch: (count) => `\u{1f525} \u6b63\u5728\u4f7f\u7528 ${count} \u4e2a\u5de5\u5177...`,
  toolDone: (name) => `\u2705 \u5de5\u5177\u5b8c\u6210: ${name}`,
  toolDoneWithSummary: (name, summary) => `\u2705 \u5de5\u5177\u5b8c\u6210: ${name}\n${summary}`,
  done: "\u2705 \u4efb\u52a1\u5b8c\u6210",
  doneWithDuration: (s) => `\u2705 \u4efb\u52a1\u5b8c\u6210 (\u8017\u65f6 ${s}s)`,
  error: (msg) => `\u274c \u51fa\u9519\u4e86: ${msg}`,
};

const EN: Messages = {
  thinking: "\u{1f914} Thinking...",
  toolStart: (name) => `\u{1f525} Running tool: ${name}...`,
  toolBatch: (count) => `\u{1f525} Running ${count} tools...`,
  toolDone: (name) => `\u2705 Tool done: ${name}`,
  toolDoneWithSummary: (name, summary) => `\u2705 Tool done: ${name}\n${summary}`,
  done: "\u2705 Task completed",
  doneWithDuration: (s) => `\u2705 Task completed (${s}s)`,
  error: (msg) => `\u274c Error: ${msg}`,
};

const LOCALES: Record<FeedbackLocale, Messages> = { zh: ZH, en: EN };

export function getMessages(locale: FeedbackLocale): Messages {
  return LOCALES[locale] ?? ZH;
}

/** Truncate a tool result to a brief summary. */
export function summarizeToolResult(result: unknown, maxLen = 120): string {
  if (result == null) return "";
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
