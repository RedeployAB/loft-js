// Loft browser SDK: a small typed API over the Loft backend so an app hosted on Loft can call
// loft.db / loft.upload / loft.ai / loft.socket / loft.user instead of writing fetch and auth by
// hand.
//
// Intended use is to import this package and bundle it into your app's own build, which you then
// upload as part of your deployment:
//   import loft from "loft-js";
//   const me = await loft.user.me();
// A prebuilt single-file build for a plain <script src="loft.js"> include is also published. Every
// call is same-origin to the backend, which holds all credentials and keys server-side, so nothing
// secret reaches the browser. This module touches fetch/WebSocket/location only at call time, so it
// imports cleanly under SSR but its calls must run in the browser.

import { createParser } from "eventsource-parser";

/**
 * Every loft call rejects with a LoftError on failure. Switch on `kind` to handle one; `status`
 * carries the HTTP status when the failure came from a response (otherwise undefined), and the
 * underlying cause (a network error, an AbortError) is kept on `cause`.
 *   try { await loft.user.me(); }
 *   catch (e) { if (e instanceof LoftError && e.kind === "auth") signIn(); }
 */
export type LoftErrorKind =
  | "auth"       // not signed in or not permitted (401, 403)
  | "not_found"  // 404 from a call that does not model absence as null
  | "http"       // any other non-2xx response
  | "network"    // the request never reached the server
  | "aborted"    // the caller's AbortSignal fired
  | "timeout"    // an AbortSignal.timeout() elapsed before the request finished
  | "stream"     // a streamed reply ended before it signalled completion
  | "parse";     // the response body was not the shape the SDK expected

export class LoftError extends Error {
  readonly kind: LoftErrorKind;
  /** HTTP status when the failure came from a response, otherwise undefined. */
  readonly status: number | undefined;
  constructor(kind: LoftErrorKind, message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "LoftError";
    this.kind = kind;
    this.status = opts?.status;
  }
}

function kindForStatus(status: number): LoftErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  return "http";
}

function failResponse(label: string, status: number, detail?: string): never {
  const tail = detail ? `: ${detail}` : "";
  throw new LoftError(kindForStatus(status), `loft: ${label} failed (${status})${tail}`, { status });
}

// Run a fetch and normalise its non-HTTP failures (a rejected request, a cancel, a timeout) into a
// LoftError. A completed response is returned as-is, ok or not, for the caller to interpret. Every
// loft endpoint is same-origin and cookie-authenticated, so credentials is set here once rather
// than at each call site (it is also the fetch default, but the SDK's auth model is explicit here).
async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { credentials: "same-origin", ...init });
  } catch (cause) {
    // AbortSignal.timeout() aborts with a TimeoutError, a plain controller.abort() with an
    // AbortError; keep them as distinct kinds so a caller can retry a timeout but not a cancel.
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new LoftError("timeout", `loft: request to ${url} timed out`, { cause });
    }
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new LoftError("aborted", `loft: request to ${url} was aborted`, { cause });
    }
    throw new LoftError("network", `loft: request to ${url} could not reach the server`, { cause });
  }
}

async function readJson<T>(res: Response, label: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new LoftError("parse", `loft: malformed response from ${label}`, { status: res.status, cause });
  }
}

/** Options every network call accepts. Pass an AbortSignal to cancel an in-flight request. */
export interface LoftRequestOptions {
  signal?: AbortSignal;
}

// Attach the caller's AbortSignal to a fetch init when they passed one. exactOptionalPropertyTypes
// forbids signal: undefined, so only add the key when it is present.
function withSignal(init: RequestInit, opts?: LoftRequestOptions): RequestInit {
  return opts?.signal ? { ...init, signal: opts.signal } : init;
}

export interface LoftUser {
  email: string; // mutable, for display and contact only
  name: string;  // mutable display name
  /** Stable, immutable identity from the auth provider. Use this for ownership checks, never email/name. */
  id: string;
}

/** Result of loft.upload(): a same-origin URL plus the stored file's name and size. */
export interface LoftUpload {
  url: string;
  name: string;
  size: number;
}

/** Options for loft.upload(): an optional stored filename, plus the shared request options. */
export interface LoftUploadOptions extends LoftRequestOptions {
  name?: string;
}

/** The signed-in user, from the auth proxy's identity headers. */
async function me(opts?: LoftRequestOptions): Promise<LoftUser> {
  const res = await httpFetch("/api/me", withSignal({}, opts));
  if (!res.ok) failResponse("/api/me", res.status);
  return readJson<LoftUser>(res, "/api/me");
}

/** Upload a file; resolves to a /uploads/… URL fetchable only by signed-in users. Pass `name`
 * to set the stored filename, otherwise the File's own name (or "file" for a Blob) is used. */
async function upload(file: File | Blob, opts?: LoftUploadOptions): Promise<LoftUpload> {
  const filename = opts?.name ?? (file instanceof File ? file.name : "file");
  const res = await httpFetch("/api/upload", withSignal({
    method: "POST",
    headers: {
      // Percent-encode: a header value must be Latin1, so a raw non-ASCII or newline-bearing
      // filename would make Request construction throw. The server decodes it.
      "X-Loft-Filename": encodeURIComponent(filename),
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  }, opts));
  if (!res.ok) failResponse("/api/upload", res.status);
  return readJson<LoftUpload>(res, "/api/upload");
}

/** Delete a previously uploaded file. Pass the `url` that loft.upload() returned. Idempotent: a
 * second delete (the file already gone) resolves rather than throwing. */
async function uploadDelete(url: string, opts?: LoftRequestOptions): Promise<void> {
  const res = await httpFetch(`/api/upload?path=${encodeURIComponent(url)}`, withSignal({
    method: "DELETE",
  }, opts));
  if (res.status === 404) return;
  if (!res.ok) failResponse("/api/upload delete", res.status);
}

/**
 * A stored document: your fields (`T`) plus the server-assigned `id` and `creator`. `creator` is
 * the stable id of the user who created it, stamped server-side from their token, so it is always
 * present and trustworthy. Compare it to `(await loft.user.me()).id` to tell if the current user
 * owns a document.
 */
export type LoftDoc<T = Record<string, unknown>> = T & {
  id: string;
  creator: string;
};

// Shared JSON request helper. `nullable` maps a 404 to null (for get/update/delete, where absence
// is a normal result); without it a 404 throws a typed not_found, so create/list never resolve to a
// null that their non-nullable return types deny.
async function req(
  method: string,
  url: string,
  body?: unknown,
  opts?: LoftRequestOptions,
  nullable = false,
): Promise<unknown> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await httpFetch(url, withSignal(init, opts));
  if (nullable && res.status === 404) return null;
  if (!res.ok) failResponse(`${method} ${url}`, res.status);
  return readJson<unknown>(res, url);
}

/** Connection lifecycle of a realtime handle. */
export type LoftSocketStatus = "open" | "reconnecting" | "closed";

/** Live-change handlers for collection.subscribe(). All optional. */
export interface LoftSubscribe<T = Record<string, unknown>> {
  onCreate?: (doc: LoftDoc<T>) => void;
  onUpdate?: (doc: LoftDoc<T>) => void;
  onDelete?: (id: string) => void;
  /** Called on a socket error (for example the session expired and the upgrade was rejected). */
  onError?: (err: LoftError) => void;
  /** Called as the connection opens, drops into reconnect, or is closed by you. */
  onStatus?: (status: LoftSocketStatus) => void;
}

/** A handle to one per-site collection, returned by loft.db.collection(). */
export interface LoftCollection<T = Record<string, unknown>> {
  create(doc: T, opts?: LoftRequestOptions): Promise<LoftDoc<T>>;
  get(id: string, opts?: LoftRequestOptions): Promise<LoftDoc<T> | null>;
  // Returns a plain array on purpose. If the backend ever paginates, expose it as an auto-paging
  // async iterable (for await ... of) so callers never handle a cursor, rather than adding a
  // cursor field here. Do not bolt a cursor onto this signature.
  list(opts?: { limit?: number } & LoftRequestOptions): Promise<LoftDoc<T>[]>;
  update(id: string, patch: Partial<T>, opts?: LoftRequestOptions): Promise<LoftDoc<T> | null>;
  /** Resolves true if a document was removed, false if it was already gone. */
  delete(id: string, opts?: LoftRequestOptions): Promise<boolean>;
  subscribe(handlers: LoftSubscribe<T>): () => void;
}

// Manage a WebSocket that reconnects with capped, jittered backoff until closed. This is the one
// teardown path both realtime APIs share: close() stops a pending reconnect (clearTimeout) and the
// connect() guard prevents a scheduled reconnect from opening a socket after close(), so neither
// can leak a socket or keep dispatching once the caller is done.
interface ReconnectHandlers {
  onMessage: (data: string) => void;
  onOpen?: (ws: WebSocket) => void;
  onError?: (err: LoftError) => void;
  onStatus?: (status: LoftSocketStatus) => void;
}

function reconnectingSocket(urlFor: () => string, h: ReconnectHandlers): {
  readonly socket: WebSocket | undefined;
  close: () => void;
} {
  let socket: WebSocket | undefined;
  let closed = false;
  let backoff = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = (): void => {
    if (closed) return;
    const ws = new WebSocket(urlFor());
    socket = ws;
    ws.onopen = () => {
      backoff = 500;
      h.onStatus?.("open");
      h.onOpen?.(ws);
    };
    ws.onmessage = (e) => { h.onMessage(e.data as string); };
    ws.onerror = () => { h.onError?.(new LoftError("network", "loft: realtime socket error")); };
    ws.onclose = () => {
      if (closed) return;
      h.onStatus?.("reconnecting");
      const wait = backoff + Math.floor(Math.random() * backoff); // jitter to avoid lockstep reconnects
      backoff = Math.min(backoff * 2, 10000);
      timer = setTimeout(connect, wait);
    };
  };
  connect();
  return {
    get socket() {
      return socket;
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      h.onStatus?.("closed");
      socket?.close();
    },
  };
}

function wsProtocol(): string {
  return location.protocol === "https:" ? "wss" : "ws";
}

/**
 * A per-site collection of schemaless documents. Data is scoped to the site the page is served
 * from, isolated from other sites by the server. Pass a type to get typed reads:
 *   const posts = loft.db.collection<{ title: string; done?: boolean }>('posts');
 *
 * Pass `{ ownerOnly: true }` to make a collection owner-owned: any signed-in user can still read
 * and create, but a document can only be updated or deleted by the user who created it (enforced
 * server-side against their token, not bypassable from the browser). Without it, the collection is
 * shared/collaborative: anyone on the site can edit anything (right for, e.g., a realtime co-editing
 * tool). The mode is fixed when the collection is first created.
 *   const p = await posts.create({ title: 'hi' });            // p.creator is my id
 *   await posts.update(p.id, { done: true });                 // ok, I made it
 *   const stop = posts.subscribe({ onCreate: d => render(d) }); // live updates
 */
function collection<T = Record<string, unknown>>(
  name: string,
  opts?: { ownerOnly?: boolean },
): LoftCollection<T> {
  const base = `/api/db/${encodeURIComponent(name)}`;
  const docUrl = (id: string): string => `${base}/${encodeURIComponent(id)}`;
  return {
    create: (doc: T, o?: LoftRequestOptions) =>
      req("POST", opts?.ownerOnly ? `${base}?ownerOnly=1` : base, doc, o) as Promise<LoftDoc<T>>,
    get: (id: string, o?: LoftRequestOptions) =>
      req("GET", docUrl(id), undefined, o, true) as Promise<LoftDoc<T> | null>,
    list: (o?: { limit?: number } & LoftRequestOptions) =>
      req(
        "GET",
        o?.limit !== undefined ? `${base}?limit=${encodeURIComponent(String(o.limit))}` : base,
        undefined,
        o,
      ) as Promise<LoftDoc<T>[]>,
    update: (id: string, patch: Partial<T>, o?: LoftRequestOptions) =>
      req("PATCH", docUrl(id), patch, o, true) as Promise<LoftDoc<T> | null>,
    delete: (id: string, o?: LoftRequestOptions) =>
      req("DELETE", docUrl(id), undefined, o, true).then((r) => r !== null),

    /**
     * Subscribe to live changes in this collection (other clients' writes too). Returns an
     * unsubscribe function. Reconnects automatically if the socket drops. Note that writes during a
     * disconnect are not replayed, so use onStatus to re-list and resync after a reconnect if you
     * need every change.
     */
    subscribe(handlers: LoftSubscribe<T>): () => void {
      const conn = reconnectingSocket(
        () => `${wsProtocol()}://${location.host}/api/db/subscribe?collection=${encodeURIComponent(name)}`,
        {
          onMessage: (data) => {
            let m: { op?: string; doc?: LoftDoc<T>; id?: string };
            try {
              m = JSON.parse(data) as { op?: string; doc?: LoftDoc<T>; id?: string };
            } catch {
              return; // ignore a malformed frame the server should not send
            }
            if (m.op === "create" && m.doc) handlers.onCreate?.(m.doc);
            else if (m.op === "update" && m.doc) handlers.onUpdate?.(m.doc);
            else if (m.op === "delete" && m.id) handlers.onDelete?.(m.id);
          },
          ...(handlers.onError ? { onError: handlers.onError } : {}),
          ...(handlers.onStatus ? { onStatus: handlers.onStatus } : {}),
        },
      );
      return () => { conn.close(); };
    },
  };
}

/** A live channel: send() broadcasts to the other clients on it; on() receives their messages. */
export interface LoftChannel<T = unknown> {
  send: (msg: T) => void;
  on: (handler: (msg: T) => void) => () => void;
  close: () => void;
}

/** Connection callbacks for loft.socket.channel(). */
export interface LoftChannelOptions {
  /** Called on a socket error (for example the session expired and the upgrade was rejected). */
  onError?: (err: LoftError) => void;
  /** Called as the connection opens, drops into reconnect, or is closed by you. */
  onStatus?: (status: LoftSocketStatus) => void;
}

/**
 * Join a realtime channel scoped to this site (ephemeral pub/sub, nothing is stored). A message
 * sent by one client is delivered to every *other* client on the same channel. For chat, presence,
 * multiplayer cursors, live notifications, etc. Reconnects automatically; sends issued before the
 * socket is open are buffered (bounded, oldest dropped past the cap). Non-JSON frames are ignored.
 *   const room = loft.socket.channel('lobby');
 *   room.on(m => console.log('peer:', m));
 *   room.send({ hi: 'there' });
 */
function channelSocket<T = unknown>(name: string, opts?: LoftChannelOptions): LoftChannel<T> {
  const handlers = new Set<(msg: T) => void>();
  // Buffer for sends issued before the socket is open. Bounded so a long disconnect (or an app that
  // sends in a tight loop while offline) can't grow it without limit; oldest queued messages are
  // dropped once the cap is reached.
  const maxPending = 1000;
  const pending: string[] = [];
  const conn = reconnectingSocket(
    () => `${wsProtocol()}://${location.host}/api/socket?channel=${encodeURIComponent(name)}`,
    {
      onMessage: (data) => {
        let msg: T;
        try {
          msg = JSON.parse(data) as T;
        } catch {
          return; // ignore a non-JSON frame; every send() is JSON, so this is corruption
        }
        handlers.forEach((h) => { h(msg); });
      },
      onOpen: (ws) => {
        for (const m of pending.splice(0)) ws.send(m);
      },
      ...(opts?.onError ? { onError: opts.onError } : {}),
      ...(opts?.onStatus ? { onStatus: opts.onStatus } : {}),
    },
  );
  return {
    send(msg: T) {
      const s = JSON.stringify(msg);
      const ws = conn.socket;
      if (ws?.readyState === WebSocket.OPEN) ws.send(s);
      else {
        if (pending.length >= maxPending) pending.shift();
        pending.push(s);
      }
    },
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      handlers.clear();
      conn.close();
    },
  };
}

/** A chat message for loft.ai.chat(). */
export interface LoftChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Cap the server error body folded into a LoftError message so an upstream provider's detail can't
// flood a client toast or log.
function errorDetail(text: string): string {
  return text.length > 300 ? text.slice(0, 300) + "…" : text;
}

// POST the conversation to the chat endpoint. chat() and stream() send the identical request; only
// the stream flag and how they read the response differ, so the request and its error handling live
// here once.
async function aiRequest(
  messages: LoftChatMessage[],
  stream: boolean,
  opts?: LoftRequestOptions,
): Promise<Response> {
  const res = await httpFetch("/api/ai/chat", withSignal({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, stream }),
  }, opts));
  if (!res.ok) failResponse("/api/ai/chat", res.status, errorDetail(await res.text().catch(() => "")));
  return res;
}

/**
 * Send a chat conversation to the platform's model and resolve to the assistant's full reply.
 * For token-by-token output use loft.ai.stream() instead.
 *   const reply = await loft.ai.chat([{ role: 'user', content: 'hi' }]);
 * Pass `signal` to cancel: a cancel rejects with kind "aborted", a timeout with kind "timeout".
 */
async function aiChat(messages: LoftChatMessage[], opts?: LoftRequestOptions): Promise<string> {
  const res = await aiRequest(messages, false, opts);
  const data = await readJson<{ choices?: { message?: { content?: string } }[] }>(res, "/api/ai/chat");
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Stream the assistant's reply token by token as an async iterable:
 *   for await (const token of loft.ai.stream(msgs)) out.append(token);
 * The iterable ends when the reply completes. A truncated stream throws kind "stream", a cancel
 * "aborted", and a timeout "timeout". Break out of the loop, or pass an aborting `signal`, to stop
 * early and release the connection.
 */
async function* aiStream(
  messages: LoftChatMessage[],
  opts?: LoftRequestOptions,
): AsyncGenerator<string, void, unknown> {
  const res = await aiRequest(messages, true, opts);
  if (!res.body) throw new LoftError("stream", "loft.ai: the server returned no stream body");

  // Standard chat-completions stream: SSE `data:` frames carrying choices[0].delta.content,
  // terminated by `data: [DONE]`. eventsource-parser handles the framing; we own the transport so
  // we can POST and cancel. parser.feed runs onEvent synchronously, so draining the queue right
  // after each feed yields tokens in order without buffering the whole reply.
  const queue: string[] = [];
  const state = { done: false };
  const parser = createParser({
    onEvent(event) {
      if (event.data === "[DONE]") {
        state.done = true;
        return;
      }
      try {
        const evt = JSON.parse(event.data) as { choices?: { delta?: { content?: string } }[] };
        const token = evt.choices?.[0]?.delta?.content;
        if (token) queue.push(token);
      } catch {
        /* ignore malformed frames the server should not send */
      }
    },
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let failure: unknown;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.feed(decoder.decode(chunk.value, { stream: true }));
      while (queue.length > 0) {
        const token = queue.shift();
        if (token !== undefined) yield token;
      }
    }
  } catch (cause) {
    failure = cause;
  } finally {
    // Release the body whether the loop finished, threw, or the consumer broke out early.
    await reader.cancel().catch(() => undefined);
  }
  if (failure !== undefined) {
    if (failure instanceof DOMException && failure.name === "TimeoutError") {
      throw new LoftError("timeout", "loft.ai: stream timed out", { cause: failure });
    }
    if (failure instanceof DOMException && failure.name === "AbortError") {
      throw new LoftError("aborted", "loft.ai: stream aborted", { cause: failure });
    }
    throw new LoftError("network", "loft.ai: stream failed", { cause: failure });
  }
  if (!state.done) throw new LoftError("stream", "loft.ai: stream ended before completion");
}

export const loft = {
  user: { me },

  // Server-keyed chat completions. Keys stay server-side; model is chosen by the platform (no
  // model selection). chat() resolves to the full reply; stream() yields tokens as they arrive.
  ai: { chat: aiChat, stream: aiStream },

  // Schemaless, per-site document store, server-isolated, with realtime collection.subscribe().
  db: { collection },

  // Ephemeral per-site realtime channels (chat/presence/multiplayer), nothing persisted.
  socket: { channel: channelSocket },

  /**
   * Upload a file. Stored server-side; returns a URL under /uploads/…
   * that only signed-in users can fetch. Use it directly as an <img src>, href, etc.
   *   const { url } = await loft.upload(input.files[0]);
   *   await loft.upload.delete(url);   // remove it later
   */
  upload: Object.assign(upload, { delete: uploadDelete }),
};

export default loft;
