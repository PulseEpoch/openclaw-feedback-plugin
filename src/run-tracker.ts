/**
 * Per-run execution state machine.
 *
 * Tracks each agent run's phase and tool steps with human-readable
 * descriptions. The card-based feedback system reads `steps` to
 * build the progress card content.
 */

export type RunPhase = "idle" | "thinking" | "tool" | "done" | "error";

/** A single tool call step shown in the progress card. */
export type ToolStep = {
  name: string;
  description: string;
  done: boolean;
  error?: string;
};

export type RunState = {
  runId: string;
  phase: RunPhase;
  sessionKey?: string;
  channelId?: string;
  agentId?: string;
  startedAt: number;
  steps: ToolStep[];
  /** Whether we've already sent the initial card for this run. */
  cardSent: boolean;
  /** The messageId of the progress card (for in-place edits). */
  cardMessageId?: string;
  /** Timestamp of the last card update (for throttling). */
  lastCardUpdateAt: number;
  /** Whether the "thinking" phase has been recorded. */
  thinkingSent: boolean;
};

export type FeedbackAction =
  | { kind: "send_card" }
  | { kind: "update_card" }
  | { kind: "final_card"; durationMs: number; success: true }
  | { kind: "error_card"; durationMs: number; message: string }
  | { kind: "skip" };

export class RunTracker {
  private runs = new Map<string, RunState>();
  private updateThrottleMs: number;
  private runTtlMs: number;

  constructor(params: { debounceMs: number; runTtlMs: number }) {
    this.updateThrottleMs = params.debounceMs;
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
        steps: [],
        cardSent: false,
        lastCardUpdateAt: 0,
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

  private shouldThrottle(run: RunState): boolean {
    return Date.now() - run.lastCardUpdateAt < this.updateThrottleMs;
  }

  private markUpdated(run: RunState): void {
    run.lastCardUpdateAt = Date.now();
  }

  /** Set the card messageId after the initial send. */
  setCardMessageId(runId: string, messageId: string): void {
    const run = this.runs.get(runId);
    if (run) {
      run.cardMessageId = messageId;
      run.cardSent = true;
    }
  }

  /** Model call started: agent is thinking. */
  onModelCallStarted(
    runId: string,
    ctx: { sessionKey?: string; channelId?: string; agentId?: string },
  ): FeedbackAction {
    const run = this.getOrCreate(runId, ctx);
    run.phase = "thinking";

    if (run.thinkingSent) return { kind: "skip" };
    run.thinkingSent = true;

    if (!run.cardSent) {
      this.markUpdated(run);
      return { kind: "send_card" };
    }
    if (this.shouldThrottle(run)) return { kind: "skip" };
    this.markUpdated(run);
    return { kind: "update_card" };
  }

  /** Tool call is about to start. Add a step with description. */
  onBeforeToolCall(
    runId: string,
    description: string,
    toolName: string,
    ctx: { sessionKey?: string; channelId?: string; agentId?: string },
  ): FeedbackAction {
    const run = this.getOrCreate(runId, ctx);
    run.phase = "tool";
    run.steps.push({ name: toolName, description, done: false });

    if (!run.cardSent) {
      this.markUpdated(run);
      return { kind: "send_card" };
    }
    if (this.shouldThrottle(run)) return { kind: "skip" };
    this.markUpdated(run);
    return { kind: "update_card" };
  }

  /** Tool call completed. Mark the step as done. */
  onAfterToolCall(
    runId: string,
    toolName: string,
    error?: string,
  ): FeedbackAction {
    const run = this.runs.get(runId);
    if (!run) return { kind: "skip" };

    const step = [...run.steps].reverse().find((s) => s.name === toolName && !s.done);
    if (step) {
      step.done = true;
      step.error = error;
    }

    if (!run.cardSent) return { kind: "skip" };
    if (this.shouldThrottle(run)) return { kind: "skip" };
    this.markUpdated(run);
    return { kind: "update_card" };
  }

  /** Agent run ended. Always emits (no throttle for terminal states). */
  onAgentEnd(
    runId: string,
    success: boolean,
    error?: string,
  ): FeedbackAction {
    const run = this.runs.get(runId);
    if (!run) return { kind: "skip" };

    const durationMs = Date.now() - run.startedAt;

    // Mark all remaining steps as done
    for (const step of run.steps) {
      if (!step.done) step.done = true;
    }

    if (success) {
      run.phase = "done";
      this.markUpdated(run);
      return { kind: "final_card", durationMs, success: true };
    }

    run.phase = "error";
    this.markUpdated(run);
    return { kind: "error_card", durationMs, message: error ?? "unknown error" };
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
