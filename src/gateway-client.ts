/**
 * Lightweight gateway WebSocket client for sending feedback messages.
 *
 * Connects to the local OpenClaw gateway, performs token auth handshake,
 * and provides a `send()` method for delivering channel messages.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Convert a Feishu schema 2.0 card to a gateway presentation object.
 * Extracts the header title and markdown body elements as text blocks.
 */
function cardToPresentation(card: Record<string, unknown>): {
  title?: string;
  tone?: string;
  blocks: Array<{ type: string; text?: string }>;
} {
  const header = card.header as Record<string, unknown> | undefined;
  const title = (header?.title as Record<string, unknown> | undefined)?.content as string | undefined;
  const template = header?.template as string | undefined;

  const toneMap: Record<string, string> = {
    blue: "info", turquoise: "info", wathet: "info",
    green: "success", lime: "success",
    red: "danger", carmine: "danger",
    orange: "warning", yellow: "warning",
    grey: "neutral", purple: "neutral", indigo: "neutral", violet: "neutral",
  };
  const tone = template ? toneMap[template] ?? "info" : "info";

  const blocks: Array<{ type: string; text?: string }> = [];
  const body = card.body as Record<string, unknown> | undefined;
  const elements = (body?.elements ?? []) as Array<Record<string, unknown>>;
  for (const el of elements) {
    if (el.tag === "markdown" && typeof el.content === "string") {
      blocks.push({ type: "text", text: el.content });
    } else if (el.tag === "hr") {
      blocks.push({ type: "divider" });
    } else if (el.tag === "note") {
      const noteEls = (el.elements ?? []) as Array<Record<string, unknown>>;
      const text = noteEls.map((n) => n.content ?? "").join(" ");
      if (text) blocks.push({ type: "context", text });
    }
  }

  if (blocks.length === 0 && title) {
    blocks.push({ type: "text", text: title });
  }

  return { title, tone, blocks };
}

function readTokenFromConfig(): string {
  try {
    const home = process.env.HOME ?? "";
    const raw = readFileSync(join(home, ".openclaw", "openclaw.json"), "utf-8");
    const cfg = JSON.parse(raw);
    return cfg?.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}

type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
};

export type SendParams = {
  to: string;
  message?: string;
  channel?: string;
  accountId?: string;
  threadId?: string;
  sessionKey?: string;
  idempotencyKey?: string;
};

export type SendResult = {
  messageId?: string;
  chatId?: string;
  channelId?: string;
  runId?: string;
};

export type MessageActionParams = {
  channel: string;
  action: string;
  params: Record<string, unknown>;
  accountId?: string;
  sessionKey?: string;
  idempotencyKey?: string;
};

export type MessageActionResult = {
  ok?: boolean;
  channel?: string;
  action?: string;
  messageId?: string;
  chatId?: string;
  contentType?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type GatewayClientOptions = {
  url?: string;
  token?: string;
  requestTimeoutMs?: number;
};

export class FeedbackGatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private _connected = false;
  private url: string;
  private token: string;
  private requestTimeoutMs: number;
  private connectPromise: Promise<void> | null = null;

  constructor(opts?: GatewayClientOptions) {
    this.url =
      opts?.url ??
      process.env.OPENCLAW_GATEWAY_URL ??
      "ws://127.0.0.1:18789";
    this.token =
      opts?.token ??
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      readTokenFromConfig();
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 15_000;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Connect to the gateway. Safe to call multiple times (deduped). */
  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let done = false;

      const handshakeTimeout = setTimeout(() => {
        if (!done) {
          done = true;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error("Gateway handshake timeout"));
        }
      }, 10_000);

      const finish = (err?: Error) => {
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
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(
            typeof evt.data === "string" ? evt.data : String(evt.data),
          );
        } catch {
          return;
        }

        if (
          frame.type === "event" &&
          frame.event === "connect.challenge" &&
          !done
        ) {
          this.sendHandshake()
            .then(() => finish())
            .catch((err) =>
              finish(
                err instanceof Error ? err : new Error(String(err)),
              ),
            );
          return;
        }

        if (frame.type === "res") {
          this.handleResponse(frame as unknown as ResponseFrame);
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

  private sendHandshake(): Promise<unknown> {
    return this.request("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        version: "0.1.0",
        platform: process.platform,
        mode: "backend",
      },
      scopes: ["operator.write"],
      auth: this.token ? { token: this.token } : undefined,
    });
  }

  private handleResponse(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(
        new Error(frame.error?.message ?? "Unknown gateway error"),
      );
    }
  }

  /** Generic RPC request to the gateway. */
  async request<T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway not connected");
    }
    const id = randomUUID();
    const frame: RequestFrame = { type: "req", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timeout: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  /** Send a message to a channel conversation. */
  async send(params: SendParams): Promise<SendResult> {
    return this.request<SendResult>("send", {
      ...params,
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
    });
  }

  /** Dispatch a channel message action (send card, edit message, etc.). */
  async messageAction(params: MessageActionParams): Promise<MessageActionResult> {
    return this.request<MessageActionResult>("message.action", {
      ...params,
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
    });
  }

  /**
   * Send a Feishu interactive card via the presentation abstraction.
   * Uses `message.action` send with `presentation` param, which the
   * Feishu channel converts to an interactive card. Returns the
   * messageId for later in-place card edits.
   */
  async sendCard(params: {
    to: string;
    card: Record<string, unknown>;
    channel: string;
    accountId?: string;
    sessionKey?: string;
    /** Presentation blocks for the initial card send. */
    presentation?: {
      title?: string;
      tone?: string;
      blocks: Array<{ type: string; text?: string }>;
    };
  }): Promise<string | undefined> {
    const presentation = params.presentation ?? cardToPresentation(params.card);
    const result = await this.messageAction({
      channel: params.channel,
      action: "send",
      params: {
        to: params.to,
        presentation,
      },
      accountId: params.accountId,
      sessionKey: params.sessionKey,
    });
    return result.messageId;
  }

  /** Edit an existing Feishu message with updated card content. */
  async editCard(params: {
    messageId: string;
    card: Record<string, unknown>;
    channel: string;
    accountId?: string;
  }): Promise<void> {
    await this.messageAction({
      channel: params.channel,
      action: "edit",
      params: {
        messageId: params.messageId,
        card: params.card,
      },
      accountId: params.accountId,
    });
  }

  /** Disconnect from the gateway. */
  disconnect(): void {
    this._connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("Gateway client disconnected"));
    }
    this.pending.clear();
  }
}
