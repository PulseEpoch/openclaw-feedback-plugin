// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// src/config.ts
var DEFAULT_CONFIG = {
  enabled: true,
  locale: "zh",
  debounceMs: 2e3,
  events: {
    thinking: true,
    toolCalls: true,
    toolResults: true,
    completion: true
  },
  feishuCards: false,
  runTtlMs: 5 * 60 * 1e3
};
function resolveConfig(raw) {
  if (!raw) return { ...DEFAULT_CONFIG };
  const events = raw.events ?? {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    locale: raw.locale === "en" ? "en" : DEFAULT_CONFIG.locale,
    debounceMs: typeof raw.debounceMs === "number" && raw.debounceMs > 0 ? raw.debounceMs : DEFAULT_CONFIG.debounceMs,
    events: {
      thinking: typeof events.thinking === "boolean" ? events.thinking : DEFAULT_CONFIG.events.thinking,
      toolCalls: typeof events.toolCalls === "boolean" ? events.toolCalls : DEFAULT_CONFIG.events.toolCalls,
      toolResults: typeof events.toolResults === "boolean" ? events.toolResults : DEFAULT_CONFIG.events.toolResults,
      completion: typeof events.completion === "boolean" ? events.completion : DEFAULT_CONFIG.events.completion
    },
    feishuCards: typeof raw.feishuCards === "boolean" ? raw.feishuCards : DEFAULT_CONFIG.feishuCards,
    runTtlMs: typeof raw.runTtlMs === "number" && raw.runTtlMs > 0 ? raw.runTtlMs : DEFAULT_CONFIG.runTtlMs
  };
}

// src/run-tracker.ts
var RunTracker = class {
  runs = /* @__PURE__ */ new Map();
  updateThrottleMs;
  runTtlMs;
  constructor(params) {
    this.updateThrottleMs = params.debounceMs;
    this.runTtlMs = params.runTtlMs;
  }
  getOrCreate(runId, ctx) {
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
        cardReady: false,
        lastCardUpdateAt: 0,
        thinkingSent: false
      };
      this.runs.set(runId, run);
    }
    if (ctx.sessionKey && !run.sessionKey) run.sessionKey = ctx.sessionKey;
    if (ctx.channelId && !run.channelId) run.channelId = ctx.channelId;
    if (ctx.agentId && !run.agentId) run.agentId = ctx.agentId;
    return run;
  }
  get(runId) {
    return this.runs.get(runId);
  }
  shouldThrottle(run) {
    return Date.now() - run.lastCardUpdateAt < this.updateThrottleMs;
  }
  markUpdated(run) {
    run.lastCardUpdateAt = Date.now();
  }
  /** Set the card messageId after the initial send completes. */
  setCardMessageId(runId, messageId) {
    const run = this.runs.get(runId);
    if (run) {
      run.cardMessageId = messageId;
      run.cardSent = true;
      run.cardReady = true;
    }
  }
  /** Model call started: agent is thinking. */
  onModelCallStarted(runId, ctx) {
    const run = this.getOrCreate(runId, ctx);
    run.phase = "thinking";
    if (run.thinkingSent) return { kind: "skip" };
    run.thinkingSent = true;
    if (!run.cardSent) {
      run.cardSent = true;
      this.markUpdated(run);
      return { kind: "send_card" };
    }
    if (this.shouldThrottle(run)) return { kind: "skip" };
    this.markUpdated(run);
    return { kind: "update_card" };
  }
  /** Tool call is about to start. Add a step with description. */
  onBeforeToolCall(runId, description, toolName, ctx) {
    const run = this.getOrCreate(runId, ctx);
    run.phase = "tool";
    run.steps.push({ name: toolName, description, done: false });
    if (!run.cardSent) {
      run.cardSent = true;
      this.markUpdated(run);
      return { kind: "send_card" };
    }
    if (this.shouldThrottle(run)) return { kind: "skip" };
    this.markUpdated(run);
    return { kind: "update_card" };
  }
  /** Tool call completed. Mark the step as done. */
  onAfterToolCall(runId, toolName, error) {
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
  onAgentEnd(runId, success, error) {
    const run = this.runs.get(runId);
    if (!run) return { kind: "skip" };
    const durationMs = Date.now() - run.startedAt;
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
  cleanup(runId) {
    this.runs.delete(runId);
  }
  /** Sweep stale runs that exceeded the TTL. */
  sweepStale() {
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
  get size() {
    return this.runs.size;
  }
};

// src/formatters.ts
function describeToolCall(toolName, params, locale = "zh") {
  const p = params ?? {};
  const zh = locale === "zh";
  switch (toolName) {
    case "read":
    case "read_file": {
      const fp = shortPath(getString(p, "file_path"));
      return fp ? zh ? `\u8BFB\u53D6 ${fp}` : `Read ${fp}` : zh ? "\u8BFB\u53D6\u6587\u4EF6" : "Read file";
    }
    case "edit":
    case "edit_file": {
      const fp = shortPath(getString(p, "file_path"));
      return fp ? zh ? `\u7F16\u8F91 ${fp}` : `Edit ${fp}` : zh ? "\u7F16\u8F91\u6587\u4EF6" : "Edit file";
    }
    case "write":
    case "write_file": {
      const fp = shortPath(getString(p, "file_path"));
      return fp ? zh ? `\u5199\u5165 ${fp}` : `Write ${fp}` : zh ? "\u5199\u5165\u6587\u4EF6" : "Write file";
    }
    case "exec":
    case "shell": {
      const cmd = truncate(getString(p, "command"), 60);
      return cmd ? zh ? `\u6267\u884C \`${cmd}\`` : `Run \`${cmd}\`` : zh ? "\u6267\u884C\u547D\u4EE4" : "Run command";
    }
    case "grep":
    case "search": {
      const pat = getString(p, "pattern") ?? getString(p, "query");
      const dir = shortPath(getString(p, "path"));
      if (pat && dir) return zh ? `\u641C\u7D22 "${pat}" in ${dir}` : `Search "${pat}" in ${dir}`;
      if (pat) return zh ? `\u641C\u7D22 "${pat}"` : `Search "${pat}"`;
      return zh ? "\u641C\u7D22\u4EE3\u7801" : "Search code";
    }
    case "find_file_by_name":
    case "glob": {
      const pat = getString(p, "pattern") ?? getString(p, "glob");
      return pat ? zh ? `\u67E5\u627E ${pat}` : `Find ${pat}` : zh ? "\u67E5\u627E\u6587\u4EF6" : "Find files";
    }
    case "notebook_read": {
      const fp = shortPath(getString(p, "notebook_path"));
      return fp ? zh ? `\u8BFB\u53D6 ${fp}` : `Read ${fp}` : zh ? "\u8BFB\u53D6 notebook" : "Read notebook";
    }
    case "notebook_edit": {
      const fp = shortPath(getString(p, "notebook_path"));
      return fp ? zh ? `\u7F16\u8F91 ${fp}` : `Edit ${fp}` : zh ? "\u7F16\u8F91 notebook" : "Edit notebook";
    }
    case "run_subagent": {
      const title = getString(p, "title");
      return title ? zh ? `\u5B50\u4EFB\u52A1: ${truncate(title, 40)}` : `Subtask: ${truncate(title, 40)}` : zh ? "\u542F\u52A8\u5B50\u4EFB\u52A1" : "Run subtask";
    }
    case "webfetch":
    case "web_fetch": {
      const url = getString(p, "url");
      if (url) {
        try {
          return zh ? `\u8BBF\u95EE ${new URL(url).hostname}` : `Fetch ${new URL(url).hostname}`;
        } catch {
        }
      }
      return zh ? "\u8BBF\u95EE\u7F51\u9875" : "Fetch web";
    }
    default:
      return toolName;
  }
}
function getString(obj, key) {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function shortPath(fp) {
  if (!fp) return void 0;
  const parts = fp.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}
function truncate(s, max) {
  if (!s) return void 0;
  return s.length <= max ? s : s.slice(0, max) + "...";
}

// src/gateway-client.ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
function cardToPresentation(card) {
  const header = card.header;
  const title = header?.title?.content;
  const template = header?.template;
  const toneMap = {
    blue: "info",
    turquoise: "info",
    wathet: "info",
    green: "success",
    lime: "success",
    red: "danger",
    carmine: "danger",
    orange: "warning",
    yellow: "warning",
    grey: "neutral",
    purple: "neutral",
    indigo: "neutral",
    violet: "neutral"
  };
  const tone = template ? toneMap[template] ?? "info" : "info";
  const blocks = [];
  const body = card.body;
  const elements = body?.elements ?? [];
  for (const el of elements) {
    if (el.tag === "markdown" && typeof el.content === "string") {
      blocks.push({ type: "text", text: el.content });
    } else if (el.tag === "hr") {
      blocks.push({ type: "divider" });
    } else if (el.tag === "note") {
      const noteEls = el.elements ?? [];
      const text = noteEls.map((n) => n.content ?? "").join(" ");
      if (text) blocks.push({ type: "context", text });
    }
  }
  if (blocks.length === 0 && title) {
    blocks.push({ type: "text", text: title });
  }
  return { title, tone, blocks };
}
function readTokenFromConfig() {
  try {
    const home = process.env.HOME ?? "";
    const raw = readFileSync(join(home, ".openclaw", "openclaw.json"), "utf-8");
    const cfg = JSON.parse(raw);
    return cfg?.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}
var FeedbackGatewayClient = class {
  ws = null;
  pending = /* @__PURE__ */ new Map();
  _connected = false;
  url;
  token;
  requestTimeoutMs;
  connectPromise = null;
  constructor(opts) {
    this.url = opts?.url ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
    this.token = opts?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? readTokenFromConfig();
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 15e3;
  }
  get connected() {
    return this._connected;
  }
  /** Connect to the gateway. Safe to call multiple times (deduped). */
  async connect() {
    if (this._connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }
  doConnect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let done = false;
      const handshakeTimeout = setTimeout(() => {
        if (!done) {
          done = true;
          try {
            ws.close();
          } catch {
          }
          reject(new Error("Gateway handshake timeout"));
        }
      }, 1e4);
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(handshakeTimeout);
        if (err) {
          reject(err);
        } else {
          this._connected = true;
          resolve();
        }
      };
      ws.addEventListener("message", (evt) => {
        let frame;
        try {
          frame = JSON.parse(
            typeof evt.data === "string" ? evt.data : String(evt.data)
          );
        } catch {
          return;
        }
        if (frame.type === "event" && frame.event === "connect.challenge" && !done) {
          this.sendHandshake().then(() => finish()).catch(
            (err) => finish(
              err instanceof Error ? err : new Error(String(err))
            )
          );
          return;
        }
        if (frame.type === "res") {
          this.handleResponse(frame);
        }
      });
      ws.addEventListener("error", () => {
        finish(new Error("Gateway WS connection error"));
      });
      ws.addEventListener("close", () => {
        this._connected = false;
        for (const [, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new Error("Gateway connection closed"));
        }
        this.pending.clear();
        if (!done) {
          finish(new Error("Gateway WS closed before handshake"));
        }
      });
    });
  }
  sendHandshake() {
    return this.request("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        version: "0.1.0",
        platform: process.platform,
        mode: "backend"
      },
      scopes: ["operator.write"],
      auth: this.token ? { token: this.token } : void 0
    });
  }
  handleResponse(frame) {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(
        new Error(frame.error?.message ?? "Unknown gateway error")
      );
    }
  }
  /** Generic RPC request to the gateway. */
  async request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway not connected");
    }
    const id = randomUUID();
    const frame = { type: "req", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timeout: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v),
        reject,
        timer
      });
      this.ws.send(JSON.stringify(frame));
    });
  }
  /** Send a message to a channel conversation. */
  async send(params) {
    return this.request("send", {
      ...params,
      idempotencyKey: params.idempotencyKey ?? randomUUID()
    });
  }
  /** Dispatch a channel message action (send card, edit message, etc.). */
  async messageAction(params) {
    return this.request("message.action", {
      ...params,
      idempotencyKey: params.idempotencyKey ?? randomUUID()
    });
  }
  /**
   * Send a Feishu interactive card via the presentation abstraction.
   * Uses `message.action` send with `presentation` param, which the
   * Feishu channel converts to an interactive card. Returns the
   * messageId for later in-place card edits.
   */
  async sendCard(params) {
    const presentation = params.presentation ?? cardToPresentation(params.card);
    const result = await this.messageAction({
      channel: params.channel,
      action: "send",
      params: {
        to: params.to,
        presentation
      },
      accountId: params.accountId,
      sessionKey: params.sessionKey
    });
    return result.messageId;
  }
  /** Edit an existing Feishu message with updated card content. */
  async editCard(params) {
    await this.messageAction({
      channel: params.channel,
      action: "edit",
      params: {
        messageId: params.messageId,
        card: params.card
      },
      accountId: params.accountId
    });
  }
  /** Disconnect from the gateway. */
  disconnect() {
    this._connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("Gateway client disconnected"));
    }
    this.pending.clear();
  }
};

// src/feishu-cards.ts
var ZH_LABELS = {
  progressTitle: "\u4EFB\u52A1\u5904\u7406\u4E2D...",
  completeTitle: (s) => `\u4EFB\u52A1\u5B8C\u6210 (${s}s)`,
  errorTitle: "\u4EFB\u52A1\u51FA\u9519",
  thinking: "\u6B63\u5728\u601D\u8003...",
  noSteps: "\u51C6\u5907\u4E2D...",
  summary: (t, s) => `\u5171 ${t} \u4E2A\u6B65\u9AA4 \xB7 \u8017\u65F6 ${s}s`,
  errorFooter: (msg) => `\u9519\u8BEF: ${msg}`
};
var EN_LABELS = {
  progressTitle: "Task Processing...",
  completeTitle: (s) => `Task Complete (${s}s)`,
  errorTitle: "Task Error",
  thinking: "Thinking...",
  noSteps: "Preparing...",
  summary: (t, s) => `${t} steps \xB7 ${s}s`,
  errorFooter: (msg) => `Error: ${msg}`
};
function labels(locale) {
  return locale === "en" ? EN_LABELS : ZH_LABELS;
}
function buildCard(title, color, markdown, footer) {
  const content = footer ? `${markdown}

---
${footer}` : markdown;
  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: {
      title: { tag: "plain_text", content: title },
      template: color
    },
    body: {
      elements: [{ tag: "markdown", content }]
    }
  };
}
function buildProgressCard(locale, steps, thinking) {
  const l = labels(locale);
  const total = steps.length;
  const doneCount = steps.filter((s) => s.done).length;
  const current = [...steps].reverse().find((s) => !s.done) ?? steps[steps.length - 1];
  let body;
  if (total === 0) {
    body = thinking ? `\u{1F914} ${l.thinking}` : l.noSteps;
  } else if (current && !current.done) {
    body = `\u{1F525} ${current.description}`;
  } else {
    body = thinking ? `\u{1F914} ${l.thinking}` : `\u2705 ${current?.description ?? ""}`;
  }
  const footer = total > 0 ? `${doneCount}/${total}` : void 0;
  return buildCard(l.progressTitle, "blue", body, footer);
}
function buildCompletionCard(locale, steps, durationMs) {
  const l = labels(locale);
  const secs = Math.round(durationMs / 1e3);
  return buildCard(
    l.completeTitle(secs),
    "green",
    l.summary(steps.length, secs)
  );
}
function buildErrorCard(locale, steps, errorMsg, durationMs) {
  const l = labels(locale);
  const secs = Math.round(durationMs / 1e3);
  return buildCard(
    l.errorTitle,
    "red",
    `\u274C ${errorMsg}`,
    l.summary(steps.length, secs)
  );
}

// index.ts
var sharedConfig = null;
var tracker = null;
var gwClient = null;
var sweepTimer = null;
var sessions = /* @__PURE__ */ new Map();
var cardQueues = /* @__PURE__ */ new Map();
function getConfig(pluginConfig) {
  if (!sharedConfig) sharedConfig = resolveConfig(pluginConfig);
  return sharedConfig;
}
function getTracker(config) {
  if (!tracker) {
    tracker = new RunTracker({
      debounceMs: config.debounceMs,
      runTtlMs: config.runTtlMs
    });
    sweepTimer = setInterval(() => tracker.sweepStale(), config.runTtlMs);
  }
  return tracker;
}
function getGwClient() {
  if (!gwClient) gwClient = new FeedbackGatewayClient();
  return gwClient;
}
function enqueueCardOp(runId, op) {
  const prev = cardQueues.get(runId) ?? Promise.resolve();
  const next = prev.then(op, op);
  cardQueues.set(runId, next);
}
function cleanupCardQueue(runId) {
  cardQueues.delete(runId);
}
var log = (msg, ...args) => console.error(`[feedback] ${msg}`, ...args);
async function ensureConnected() {
  try {
    const client = getGwClient();
    if (!client.connected) await client.connect();
    return true;
  } catch {
    return false;
  }
}
async function sendInitialCard(runId, sessionKey, config, t) {
  if (!sessionKey) return;
  const ctx = sessions.get(sessionKey);
  if (!ctx) {
    log("sendInitialCard SKIP: no ctx", { runId, sessionKey: sessionKey.slice(-12) });
    return;
  }
  if (!await ensureConnected()) return;
  const run = t.get(runId);
  if (!run) return;
  const card = buildProgressCard(config.locale, run.steps, run.phase === "thinking");
  try {
    const messageId = await getGwClient().sendCard({
      to: ctx.to,
      card,
      channel: ctx.channelId,
      accountId: ctx.accountId,
      sessionKey
    });
    if (messageId) {
      t.setCardMessageId(runId, messageId);
      log("sendInitialCard OK", { runId: runId.slice(0, 8), messageId });
    }
  } catch (err) {
    log("sendInitialCard ERROR", { runId: runId.slice(0, 8), error: String(err) });
  }
}
async function updateCard(runId, sessionKey, config, t) {
  if (!sessionKey) return;
  const ctx = sessions.get(sessionKey);
  if (!ctx) return;
  const run = t.get(runId);
  if (!run?.cardMessageId) return;
  if (!await ensureConnected()) return;
  const card = buildProgressCard(config.locale, run.steps, run.phase === "thinking");
  try {
    await getGwClient().editCard({
      messageId: run.cardMessageId,
      card,
      channel: ctx.channelId,
      accountId: ctx.accountId
    });
  } catch {
  }
}
async function sendFinalCard(runId, sessionKey, finalCard, t) {
  if (!sessionKey) return;
  const ctx = sessions.get(sessionKey);
  if (!ctx) return;
  if (!await ensureConnected()) return;
  const run = t.get(runId);
  try {
    if (run?.cardMessageId) {
      await getGwClient().editCard({
        messageId: run.cardMessageId,
        card: finalCard,
        channel: ctx.channelId,
        accountId: ctx.accountId
      });
    } else {
      await getGwClient().sendCard({
        to: ctx.to,
        card: finalCard,
        channel: ctx.channelId,
        accountId: ctx.accountId,
        sessionKey
      });
    }
    log("sendFinalCard OK", { runId: runId.slice(0, 8) });
  } catch (err) {
    log("sendFinalCard ERROR", { runId: runId.slice(0, 8), error: String(err) });
  }
}
function resolveSessionKey(runId, sessionKey, t) {
  if (sessionKey && sessions.has(sessionKey)) return sessionKey;
  const run = t.get(runId);
  if (run?.sessionKey && sessions.has(run.sessionKey)) return run.sessionKey;
  if (run?.channelId) {
    for (const [key, ctx] of sessions) {
      if (ctx.channelId === run.channelId) {
        if (sessionKey) sessions.set(sessionKey, ctx);
        return key;
      }
    }
  }
  return sessionKey;
}
function handleAction(action, runId, sessionKey, config, t) {
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
        action.durationMs
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
        action.durationMs
      );
      enqueueCardOp(runId, () => sendFinalCard(runId, sessionKey, card, t));
      break;
    }
  }
}
var index_default = definePluginEntry({
  id: "feedback",
  name: "Real-time Feedback",
  description: "Sends a single updatable card with real-time execution progress to channels",
  register(api) {
    const config = getConfig(api.pluginConfig);
    if (!config.enabled) return;
    const t = getTracker(config);
    api.on("message_received", (event, ctx) => {
      if (!ctx.sessionKey) return;
      const to = ctx.conversationId ?? event.from;
      if (!to) return;
      const threadId = event.threadId != null ? String(event.threadId) : void 0;
      sessions.set(ctx.sessionKey, {
        channelId: ctx.channelId,
        to,
        accountId: ctx.accountId,
        threadId
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
          accountId: ctx.accountId
        });
      }
    });
    if (config.events.thinking) {
      api.on("model_call_started", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = t.onModelCallStarted(runId, {
          sessionKey: ctx.sessionKey,
          channelId: ctx.channelId,
          agentId: ctx.agentId
        });
        const sk = resolveSessionKey(runId, ctx.sessionKey, t);
        handleAction(action, runId, sk, config, t);
      });
    }
    if (config.events.toolCalls) {
      api.on("before_tool_call", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const desc = describeToolCall(
          event.toolName,
          event.params,
          config.locale
        );
        const action = t.onBeforeToolCall(runId, desc, event.toolName, {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId
        });
        const sk = resolveSessionKey(runId, ctx.sessionKey, t);
        handleAction(action, runId, sk, config, t);
      });
    }
    if (config.events.toolResults) {
      api.on("after_tool_call", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = t.onAfterToolCall(runId, event.toolName, event.error);
        const sk = resolveSessionKey(runId, ctx.sessionKey, t);
        handleAction(action, runId, sk, config, t);
      });
    }
    if (config.events.completion) {
      api.on("agent_end", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) return;
        const action = t.onAgentEnd(runId, event.success, event.error);
        const sk = resolveSessionKey(runId, ctx.sessionKey, t);
        handleAction(action, runId, sk, config, t);
        setTimeout(() => {
          t.cleanup(runId);
          cleanupCardQueue(runId);
          if (ctx.sessionKey) sessions.delete(ctx.sessionKey);
        }, 5e3);
      });
    }
    api.on("gateway_stop", () => {
      if (gwClient) {
        gwClient.disconnect();
        gwClient = null;
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      cardQueues.clear();
      sessions.clear();
      tracker = null;
      sharedConfig = null;
    });
  }
});
export {
  index_default as default
};
