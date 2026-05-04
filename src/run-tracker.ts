/**
 * Per-run execution state machine.
 *
 * Tracks each agent run's phase and tool calls, handles debouncing,
 * and decides when to emit feedback messages.
 */

export type RunPhase = "idle" | "thinking" | "tool" | "streaming" | "done" | "error";

export type ToolRecord = {
  name: string;
  startedAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
};

export type RunState = {
  runId: string;
  phase: RunPhase;
  sessionKey?: string;
  channelId?: string;
  agentId?: string;
  startedAt: number;
  lastFeedbackAt: number;
  tools: ToolRecord[];
  pendingToolCount: number;
  thinkingSent: boolean;
};

export type FeedbackAction =
  | { kind: "thinking" }
  | { kind: "tool_start"; name: string }
  | { kind: "tool_batch"; count: number }
  | { kind: "tool_done"; name: string; result?: unknown }
  | { kind: "done"; durationMs: number }
  | { kind: "error"; message: string; durationMs: number }
  | { kind: "skip" };

export class RunTracker {
  private runs = new Map<string, RunState>();
  private debounceMs: number;
  private runTtlMs: number;

  constructor(params: { debounceMs: number; runTtlMs: number }) {
    this.debounceMs = params.debounceMs;
    this.runTtlMs = params.runTtlMs;
  }

  private getOrCreate(
    runId: string,
    ctx: { sessionKey?: string; channelId?: string; agentId?: string },
  ): RunState {
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        runId,
        phase: "idle",
        sessionKey: ctx.sessionKey,
        channelId: ctx.channelId,
        agentId: ctx.agentId,
        startedAt: Date.now(),
        lastFeedbackAt: 0,
        tools: [],
        pendingToolCount: 0,
        thinkingSent: false,
      };
      this.runs.set(runId, run);
    }
    if (ctx.sessionKey && !run.sessionKey) run.sessionKey = ctx.sessionKey;
    if (ctx.channelId && !run.channelId) run.channelId = ctx.channelId;
    if (ctx.agentId && !run.agentId) run.agentId = ctx.agentId;
    return run;
  }

  get(runId: string): RunState | undefined {
    return this.runs.get(runId);
  }

  private shouldDebounce(run: RunState): boolean {
    return Date.now() - run.lastFeedbackAt < this.debounceMs;
  }

  private markSent(run: RunState): void {
    run.lastFeedbackAt = Date.now();
  }

  /** Model call started: agent is thinking. */
  onModelCallStarted(
    runId: string,
    ctx: { sessionKey?: string; channelId?: string; agentId?: string },
  ): FeedbackAction {
    const run = this.getOrCreate(runId, ctx);
    run.phase = "thinking";

    if (run.thinkingSent) return { kind: "skip" };
    if (this.shouldDebounce(run)) return { kind: "skip" };

    run.thinkingSent = true;
    this.markSent(run);
    return { kind: "thinking" };
  }

  /** Tool call is about to start. */
  onBeforeToolCall(
    runId: string,
    toolName: string,
    ctx: { sessionKey?: string; channelId?: string; agentId?: string },
  ): FeedbackAction {
    const run = this.getOrCreate(runId, ctx);
    run.phase = "tool";
    run.pendingToolCount++;
    run.tools.push({ name: toolName, startedAt: Date.now() });

    if (this.shouldDebounce(run)) {
      // Check if we have multiple pending tools accumulating during debounce.
      // We'll send a batch notification after debounce clears.
      return { kind: "skip" };
    }

    if (run.pendingToolCount > 1) {
      this.markSent(run);
      return { kind: "tool_batch", count: run.pendingToolCount };
    }

    this.markSent(run);
    return { kind: "tool_start", name: toolName };
  }

  /** Tool call completed. */
  onAfterToolCall(
    runId: string,
    toolName: string,
    result?: unknown,
    error?: string,
  ): FeedbackAction {
    const run = this.runs.get(runId);
    if (!run) return { kind: "skip" };

    run.pendingToolCount = Math.max(0, run.pendingToolCount - 1);

    const record = run.tools.findLast((t) => t.name === toolName && !t.completedAt);
    if (record) {
      record.completedAt = Date.now();
      record.result = result;
      record.error = error;
    }

    if (this.shouldDebounce(run)) return { kind: "skip" };

    this.markSent(run);
    return { kind: "tool_done", name: toolName, result };
  }

  /** Agent run ended. Always emits (no debounce for terminal states). */
  onAgentEnd(
    runId: string,
    success: boolean,
    error?: string,
  ): FeedbackAction {
    const run = this.runs.get(runId);
    if (!run) return { kind: "skip" };

    const durationMs = Date.now() - run.startedAt;

    if (success) {
      run.phase = "done";
      this.markSent(run);
      return { kind: "done", durationMs };
    }

    run.phase = "error";
    this.markSent(run);
    return { kind: "error", message: error ?? "unknown error", durationMs };
  }

  /** Remove a completed run from tracking. */
  cleanup(runId: string): void {
    this.runs.delete(runId);
  }

  /** Sweep stale runs that exceeded the TTL. */
  sweepStale(): number {
    const now = Date.now();
    let swept = 0;
    for (const [runId, run] of this.runs) {
      if (now - run.startedAt > this.runTtlMs) {
        this.runs.delete(runId);
        swept++;
      }
    }
    return swept;
  }

  /** Number of tracked runs (for diagnostics). */
  get size(): number {
    return this.runs.size;
  }
}
