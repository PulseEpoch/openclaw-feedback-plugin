/**
 * Plugin configuration types and defaults.
 *
 * Users configure this under `plugins.entries.feedback.config` in openclaw.json.
 */

export type FeedbackLocale = "zh" | "en";

export type FeedbackEventConfig = {
  /** Send "thinking" status when model call starts. */
  thinking: boolean;
  /** Send tool call start notifications. */
  toolCalls: boolean;
  /** Send tool completion summaries. */
  toolResults: boolean;
  /** Send task completion/error notifications. */
  completion: boolean;
};

export type FeedbackPluginConfig = {
  /** Master switch. */
  enabled: boolean;
  /** Display language for feedback messages. */
  locale: FeedbackLocale;
  /** Minimum interval between messages per run (ms). */
  debounceMs: number;
  /** Which lifecycle events trigger feedback. */
  events: FeedbackEventConfig;
  /** Enable Feishu interactive card messages (future). */
  feishuCards: boolean;
  /** Max stale run age before cleanup (ms). */
  runTtlMs: number;
};

export const DEFAULT_CONFIG: FeedbackPluginConfig = {
  enabled: true,
  locale: "zh",
  debounceMs: 2000,
  events: {
    thinking: true,
    toolCalls: true,
    toolResults: true,
    completion: true,
  },
  feishuCards: false,
  runTtlMs: 5 * 60 * 1000,
};

export function resolveConfig(raw?: Record<string, unknown>): FeedbackPluginConfig {
  if (!raw) return { ...DEFAULT_CONFIG };

  const events = (raw.events ?? {}) as Partial<FeedbackEventConfig>;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    locale: raw.locale === "en" ? "en" : DEFAULT_CONFIG.locale,
    debounceMs:
      typeof raw.debounceMs === "number" && raw.debounceMs > 0
        ? raw.debounceMs
        : DEFAULT_CONFIG.debounceMs,
    events: {
      thinking: typeof events.thinking === "boolean" ? events.thinking : DEFAULT_CONFIG.events.thinking,
      toolCalls: typeof events.toolCalls === "boolean" ? events.toolCalls : DEFAULT_CONFIG.events.toolCalls,
      toolResults:
        typeof events.toolResults === "boolean" ? events.toolResults : DEFAULT_CONFIG.events.toolResults,
      completion:
        typeof events.completion === "boolean" ? events.completion : DEFAULT_CONFIG.events.completion,
    },
    feishuCards: typeof raw.feishuCards === "boolean" ? raw.feishuCards : DEFAULT_CONFIG.feishuCards,
    runTtlMs:
      typeof raw.runTtlMs === "number" && raw.runTtlMs > 0
        ? raw.runTtlMs
        : DEFAULT_CONFIG.runTtlMs,
  };
}
