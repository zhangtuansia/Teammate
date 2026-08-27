export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";

export interface LocalUser {
  id: string;
  email: string;
  user_metadata: { display_name: string };
}

interface QueryError {
  message: string;
  code?: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
  count: number | null;
}

interface QueryFilter {
  column?: string;
  operator: string;
  value: unknown;
}

interface QueryRequest {
  table: string;
  action: "select" | "insert" | "update" | "delete";
  filters: QueryFilter[];
  values?: unknown;
  order?: { column: string; ascending: boolean };
  limit?: number;
  count?: "exact";
  head?: boolean;
  single?: boolean;
}

type QueryCallback<T> = (value: QueryResult) => T | PromiseLike<T>;

const isNativeWebKit =
  typeof navigator !== "undefined" &&
  navigator.userAgent.includes("AppleWebKit") &&
  !navigator.userAgent.includes("Chrome");
const LOCAL_EVENT_POLL_WAIT_MS = isNativeWebKit ? 750 : 20_000;
const LOCAL_EVENT_POLL_GAP_MS = isNativeWebKit ? 25 : 0;
const LOCAL_EVENT_POLL_TIMEOUT_GRACE_MS = 5_000;
const LOCAL_EVENT_RETRY_BASE_MS = 500;
const LOCAL_EVENT_RETRY_MAX_MS = 15_000;
const LOCAL_EVENT_FAILURE_REPORT_THRESHOLD = 3;

type LocalRealtimeStatus =
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT";

function localAbortError() {
  const error = new Error("The local request was cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * WKWebView can leave a cross-origin POST permanently pending when its fetch
 * receives an AbortSignal, even after that signal fires. Keep cancellation at
 * the promise boundary instead: callers still stop waiting immediately, while
 * the loopback request is allowed to finish harmlessly in the background.
 */
function fetchLocalRequest(url: string, init: RequestInit, signal?: AbortSignal) {
  if (!signal) return fetch(url, init);
  if (signal.aborted) return Promise.reject(localAbortError());

  const request = fetch(url, init);
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(localAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void request
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

class LocalQueryBuilder implements PromiseLike<QueryResult> {
  private action: QueryRequest["action"] = "select";
  private filters: QueryFilter[] = [];
  private values: unknown;
  private orderBy?: QueryRequest["order"];
  private maxRows?: number;
  private countMode?: "exact";
  private headOnly = false;
  private singleRow = false;
  private signal?: AbortSignal;

  constructor(
    private readonly baseUrl: string,
    private readonly table: string,
    private readonly accessToken: string,
  ) {}

  select(
    _columns: string = "*",
    options?: { count?: "exact"; head?: boolean }
  ) {
    if (options?.count) this.countMode = options.count;
    if (options?.head) this.headOnly = true;
    return this;
  }

  insert(values: unknown) {
    this.action = "insert";
    this.values = values;
    return this;
  }

  update(values: unknown) {
    this.action = "update";
    this.values = values;
    return this;
  }

  delete(options?: { count?: "exact" }) {
    this.action = "delete";
    if (options?.count) this.countMode = options.count;
    return this;
  }

  eq(column: string, value: unknown) {
    return this.addFilter(column, "eq", value);
  }

  neq(column: string, value: unknown) {
    return this.addFilter(column, "neq", value);
  }

  in(column: string, value: unknown[]) {
    return this.addFilter(column, "in", value);
  }

  is(column: string, value: unknown) {
    return this.addFilter(column, "is", value);
  }

  lt(column: string, value: unknown) {
    return this.addFilter(column, "lt", value);
  }

  lte(column: string, value: unknown) {
    return this.addFilter(column, "lte", value);
  }

  gt(column: string, value: unknown) {
    return this.addFilter(column, "gt", value);
  }

  gte(column: string, value: unknown) {
    return this.addFilter(column, "gte", value);
  }

  ilike(column: string, value: unknown) {
    return this.addFilter(column, "ilike", value);
  }

  or(expression: string) {
    this.filters.push({ operator: "or", value: expression });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(value: number) {
    this.maxRows = value;
    return this;
  }

  single() {
    this.singleRow = true;
    return this;
  }

  maybeSingle() {
    this.singleRow = true;
    return this;
  }

  abortSignal(signal: AbortSignal) {
    this.signal = signal;
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private addFilter(column: string, operator: string, value: unknown) {
    this.filters.push({ column, operator, value });
    return this;
  }

  private async execute(): Promise<QueryResult> {
    const request: QueryRequest = {
      table: this.table,
      action: this.action,
      filters: this.filters,
      values: this.values,
      order: this.orderBy,
      limit: this.maxRows,
      count: this.countMode,
      head: this.headOnly,
      single: this.singleRow,
    };

    try {
      const response = await fetchLocalRequest(
        `${this.baseUrl}/api/query`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify(request),
        },
        this.signal,
      );
      const result = (await response.json()) as QueryResult;
      if (!response.ok && !result.error) {
        return {
          data: null,
          error: { message: `Local service returned HTTP ${response.status}` },
          count: null,
        };
      }
      return result;
    } catch (error) {
      return {
        data: null,
        error: {
          message:
            error instanceof Error ? error.message : "Local service unavailable",
        },
        count: null,
      };
    }
  }
}

class LocalRpcBuilder implements PromiseLike<QueryResult> {
  private signal?: AbortSignal;

  constructor(
    private readonly baseUrl: string,
    private readonly functionName: string,
    private readonly args: Record<string, unknown>,
    private readonly accessToken: string,
  ) {}

  abortSignal(signal: AbortSignal) {
    this.signal = signal;
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult> {
    try {
      const response = await fetchLocalRequest(
        `${this.baseUrl}/api/rpc/${encodeURIComponent(this.functionName)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify(this.args),
        },
        this.signal,
      );
      const result = (await response.json()) as QueryResult;
      if (!response.ok && !result.error) {
        return {
          data: null,
          error: { message: `Local service returned HTTP ${response.status}` },
          count: null,
        };
      }
      return result;
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : "Local service unavailable",
        },
        count: null,
      };
    }
  }
}

type RealtimeCallback = (payload: {
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}) => void | Promise<void>;

interface RealtimeHandler {
  kind: "postgres_changes" | "broadcast" | "presence";
  filter: Record<string, string>;
  callback: RealtimeCallback;
}

interface LocalEvent {
  id: number;
  topic: string;
  kind: "postgres_changes" | "broadcast";
  event: string;
  table_name: string | null;
  payload: Record<string, unknown> | null;
  record: Record<string, unknown> | null;
}

export class LocalRealtimeChannel {
  private handlers: RealtimeHandler[] = [];
  private presenceEntries: Record<string, Array<Record<string, unknown>>> = {};
  private statusCallbacks = new Set<(status: string) => void>();
  private lastStatus: LocalRealtimeStatus | null = null;
  private subscribed = false;
  private subscriptionGeneration = 0;

  constructor(
    readonly topic: string,
    private readonly client: LocalClient
  ) {}

  on(
    kind: RealtimeHandler["kind"],
    filter: Record<string, string>,
    callback: RealtimeCallback
  ) {
    this.handlers.push({ kind, filter, callback });
    return this;
  }

  subscribe(callback?: (status: string) => void) {
    if (callback) this.statusCallbacks.add(callback);
    if (!this.subscribed) {
      this.subscribed = true;
      this.subscriptionGeneration += 1;
      this.client.addChannel(this);
    } else if (callback && this.lastStatus) {
      const status = this.lastStatus;
      const generation = this.subscriptionGeneration;
      queueMicrotask(() => {
        if (
          this.subscribed &&
          this.subscriptionGeneration === generation &&
          this.statusCallbacks.has(callback)
        ) {
          callback(status);
        }
      });
    }
    return this;
  }

  async send(message: {
    type: string;
    event: string;
    payload: Record<string, unknown>;
  }) {
    const response = await fetch(`${this.client.baseUrl}/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.client.authorizationHeaders(),
      },
      body: JSON.stringify({
        topic: this.topic,
        event: message.event,
        payload: message.payload,
      }),
    });
    return response.ok ? "ok" : "error";
  }

  async track(payload: Record<string, unknown>) {
    await this.send({ type: "broadcast", event: "__presence", payload });
    return "ok";
  }

  presenceState() {
    return this.presenceEntries;
  }

  async unsubscribe() {
    await this.client.removeChannel(this);
    return "ok";
  }

  notifyStatus(status: LocalRealtimeStatus) {
    if (!this.subscribed || this.lastStatus === status) return;
    this.lastStatus = status;
    const generation = this.subscriptionGeneration;
    for (const callback of this.statusCallbacks) {
      queueMicrotask(() => {
        if (
          this.subscribed &&
          this.subscriptionGeneration === generation &&
          this.statusCallbacks.has(callback)
        ) {
          callback(status);
        }
      });
    }
  }

  onRemoved() {
    this.subscribed = false;
    this.subscriptionGeneration += 1;
    this.lastStatus = null;
    this.statusCallbacks.clear();
  }

  private invokeHandler(
    handler: RealtimeHandler,
    payload: Parameters<RealtimeCallback>[0],
  ) {
    try {
      const result = handler.callback(payload);
      if (result && typeof result.then === "function") {
        void result.catch((error) => {
          console.error(`Local realtime handler failed for ${this.topic}:`, error);
        });
      }
    } catch (error) {
      // A consumer bug must not prevent another handler or channel from seeing
      // an event the transport has already received and advanced past.
      console.error(`Local realtime handler failed for ${this.topic}:`, error);
    }
  }

  dispatch(event: LocalEvent) {
    if (event.kind === "broadcast" && event.topic !== this.topic) return;

    if (event.kind === "broadcast" && event.event === "__presence") {
      const key = String(event.payload?.hostname || "bridge");
      this.presenceEntries = { [key]: [event.payload || {}] };
      for (const handler of this.handlers) {
        if (handler.kind === "presence") {
          this.invokeHandler(handler, { payload: event.payload || {} });
        }
      }
      return;
    }

    for (const handler of this.handlers) {
      if (handler.kind !== event.kind) continue;

      if (event.kind === "broadcast") {
        if (handler.filter.event && handler.filter.event !== event.event) continue;
        this.invokeHandler(handler, { payload: event.payload || {} });
        continue;
      }

      if (handler.filter.table && handler.filter.table !== event.table_name) continue;
      if (
        handler.filter.event &&
        handler.filter.event !== "*" &&
        handler.filter.event !== event.event
      ) {
        continue;
      }
      if (!matchesRealtimeFilter(event.record, handler.filter.filter)) continue;

      this.invokeHandler(
        handler,
        event.event === "DELETE"
          ? { old: event.record || {} }
          : { new: event.record || {} }
      );
    }
  }
}

function matchesRealtimeFilter(
  record: Record<string, unknown> | null,
  expression?: string
) {
  if (!expression || !record) return true;
  const match = expression.match(/^([^=]+)=eq\.(.*)$/);
  if (!match) return true;
  return String(record[match[1]]) === match[2];
}

export class LocalClient {
  readonly isLocal = true;
  readonly realtime = { setAuth: (token: string) => { this.accessToken = token; } };
  readonly auth = {
    getUser: async () => ({ data: { user: this.localUser }, error: null }),
    getSession: async () => ({
      data: { session: { user: this.localUser, access_token: this.accessToken } },
      error: null,
    }),
    signInWithPassword: async (_credentials: {
      email: string;
      password: string;
    }) => ({ data: { user: this.localUser }, error: null }),
    signUp: async (_credentials: unknown) => ({
      data: { user: this.localUser },
      error: null,
    }),
    signOut: async () => ({ error: null }),
    exchangeCodeForSession: async (_code: string) => ({ error: null }),
  };

  private channels = new Set<LocalRealtimeChannel>();
  private cursor: number | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollAbortController: AbortController | null = null;
  private polling = false;
  private consecutivePollFailures = 0;
  private realtimeStatus: LocalRealtimeStatus | null = null;
  private readonly localUser: LocalUser = {
    id: LOCAL_USER_ID,
    email: "local@teammate.dev",
    user_metadata: { display_name: "Local User" },
  };
  private accessToken: string;

  constructor(readonly baseUrl: string, accessToken: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.accessToken = accessToken;
  }

  from(table: string) {
    return new LocalQueryBuilder(this.baseUrl, table, this.accessToken);
  }

  rpc(
    functionName: string,
    args: Record<string, unknown> = {},
  ): LocalRpcBuilder | Promise<QueryResult> {
    if (!/^[a-z][a-z0-9_]*$/.test(functionName)) {
      return Promise.resolve({
        data: null,
        error: { message: "Invalid local RPC name" },
        count: null,
      });
    }
    return new LocalRpcBuilder(this.baseUrl, functionName, args, this.accessToken);
  }

  authorizationHeaders() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  channel(topic: string, _options?: unknown) {
    return new LocalRealtimeChannel(topic, this);
  }

  addChannel(channel: LocalRealtimeChannel) {
    this.channels.add(channel);
    // The shared transport may already have completed a real poll while this
    // channel is new. Reuse that truthful client state immediately instead of
    // making short-lived RPC channels wait behind the current long poll.
    if (this.realtimeStatus) channel.notifyStatus(this.realtimeStatus);
    this.schedulePoll(0);
  }

  removeChannel(channel: LocalRealtimeChannel) {
    this.channels.delete(channel);
    channel.onRemoved();
    if (this.channels.size === 0 && this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.channels.size === 0) {
      this.pollAbortController?.abort();
      this.pollAbortController = null;
      this.consecutivePollFailures = 0;
      this.realtimeStatus = null;
    }
    return Promise.resolve("ok");
  }

  async removeAllChannels() {
    for (const channel of this.channels) channel.onRemoved();
    this.channels.clear();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollAbortController?.abort();
    this.pollAbortController = null;
    this.consecutivePollFailures = 0;
    this.realtimeStatus = null;
    return "ok";
  }

  private schedulePoll(delay: number) {
    if (this.pollTimer || this.channels.size === 0) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollEvents();
    }, delay);
  }

  private retryDelay() {
    const exponent = Math.max(0, this.consecutivePollFailures - 1);
    const backoff = Math.min(
      LOCAL_EVENT_RETRY_BASE_MS * 2 ** exponent,
      LOCAL_EVENT_RETRY_MAX_MS,
    );
    const jittered = backoff * (0.8 + Math.random() * 0.4);
    return Math.max(LOCAL_EVENT_RETRY_BASE_MS, Math.min(
      Math.round(jittered),
      LOCAL_EVENT_RETRY_MAX_MS,
    ));
  }

  private notePollSuccess() {
    this.consecutivePollFailures = 0;
    this.realtimeStatus = "SUBSCRIBED";
    // Notify on every successful pass so a channel added while the shared poll
    // was already healthy still receives its own first truthful status.
    for (const channel of this.channels) channel.notifyStatus("SUBSCRIBED");
  }

  private notePollFailure(status: Exclude<LocalRealtimeStatus, "SUBSCRIBED">) {
    this.consecutivePollFailures += 1;
    if (this.consecutivePollFailures < LOCAL_EVENT_FAILURE_REPORT_THRESHOLD) return;
    // Once degraded, keep one stable state until a poll succeeds. Alternating
    // network and timeout errors should not make every subscriber flicker.
    if (this.realtimeStatus === "CHANNEL_ERROR" || this.realtimeStatus === "TIMED_OUT") {
      for (const channel of this.channels) channel.notifyStatus(this.realtimeStatus);
      return;
    }
    this.realtimeStatus = status;
    for (const channel of this.channels) channel.notifyStatus(status);
  }

  private async pollEvents() {
    if (this.polling || this.channels.size === 0) return;
    this.polling = true;
    let retryDelay = LOCAL_EVENT_RETRY_BASE_MS;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Local realtime poll timed out", "TimeoutError")),
      LOCAL_EVENT_POLL_WAIT_MS + LOCAL_EVENT_POLL_TIMEOUT_GRACE_MS,
    );
    this.pollAbortController = controller;
    try {
      // WKWebView may keep just one authenticated connection to the loopback
      // origin. A 20-second events request can then starve channel/document
      // POSTs behind it, so native WebKit yields the connection frequently.
      const search = new URLSearchParams({ wait: String(LOCAL_EVENT_POLL_WAIT_MS) });
      if (this.cursor !== null) search.set("after", String(this.cursor));
      const response = await fetch(`${this.baseUrl}/api/events?${search}`, {
        headers: this.authorizationHeaders(),
        signal: controller.signal,
      });
      if (response.ok) {
        const result = (await response.json()) as {
          cursor: number;
          events: LocalEvent[];
        };
        this.cursor = result.cursor;
        for (const event of result.events) {
          for (const channel of this.channels) {
            try {
              channel.dispatch(event);
            } catch (error) {
              // Keep an unexpected channel-level failure isolated too. The
              // HTTP poll itself succeeded, so it must still recover normally
              // and every remaining channel must receive this event.
              console.error(`Local realtime channel failed for ${channel.topic}:`, error);
            }
          }
        }
        this.notePollSuccess();
        retryDelay = LOCAL_EVENT_POLL_GAP_MS;
      } else {
        this.notePollFailure("CHANNEL_ERROR");
        retryDelay = this.retryDelay();
      }
    } catch {
      // Removing the final channel deliberately aborts the shared request and
      // must not manufacture a degraded status for a later subscription.
      if (!controller.signal.aborted || controller.signal.reason?.name === "TimeoutError") {
        this.notePollFailure(
          controller.signal.reason?.name === "TimeoutError" ? "TIMED_OUT" : "CHANNEL_ERROR",
        );
        retryDelay = this.retryDelay();
      }
    } finally {
      clearTimeout(timeout);
      if (this.pollAbortController === controller) this.pollAbortController = null;
      this.polling = false;
      this.schedulePoll(retryDelay);
    }
  }
}

export function createLocalClient(
  baseUrl = "http://127.0.0.1:8787",
  accessToken = "",
) {
  return new LocalClient(baseUrl, accessToken);
}
