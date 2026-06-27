// Loft browser SDK: a small typed API over the loftd backend so an app hosted on Loft can
// call loft.db / loft.upload / loft.ai / loft.socket / loft.user instead of writing fetch and
// auth by hand.
//
// Intended use is to import this package and bundle it into your app's own build, which you
// then upload as part of your deployment:
//   import loft from "@loft/sdk";
//   const me = await loft.user.me();
// A prebuilt single-file build for a plain <script src="loft.js"> include is also meant to
// work once it is published. Every call is same-origin to loftd, which holds all credentials
// and keys server-side, so nothing secret reaches the browser.

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

/** The signed-in user, from the auth proxy's identity headers. */
async function me(): Promise<LoftUser> {
  const res = await fetch("/api/me", { credentials: "same-origin" });
  if (!res.ok) throw new Error("loft: not signed in");
  return res.json() as Promise<LoftUser>;
}

/** Upload a file; resolves to a /uploads/… URL fetchable only by signed-in users. */
async function upload(file: File | Blob, name?: string): Promise<LoftUpload> {
  const filename = name ?? (file instanceof File ? file.name : "file");
  const res = await fetch("/api/upload", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "X-Loft-Filename": filename,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) throw new Error(`loft: upload failed (${res.status})`);
  return res.json() as Promise<LoftUpload>;
}

/** Delete a previously uploaded file. Pass the `url` that loft.upload() returned. Idempotent. */
async function uploadDelete(url: string): Promise<void> {
  const res = await fetch(`/api/upload?path=${encodeURIComponent(url)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`loft: delete failed (${res.status})`);
}

/**
 * A stored document: your fields plus the server-assigned `id` and `creator` (the stable id of the
 * user who created it, stamped server-side from their token, so it's trustworthy). Compare it
 * to `(await loft.user.me()).id` to tell if the current user owns a document.
 */
export type LoftDoc = { id: string; creator?: string } & Record<string, unknown>;

async function req(method: string, url: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`loft.db: ${method} ${url} failed (${res.status})`);
  return res.json() as unknown;
}

/** Live-change handlers for collection.subscribe(). All optional. */
export interface LoftSubscribe {
  onCreate?: (doc: LoftDoc) => void;
  onUpdate?: (doc: LoftDoc) => void;
  onDelete?: (id: string) => void;
}

/** A handle to one per-site collection, returned by loft.db.collection(). */
export interface LoftCollection {
  create(doc: Record<string, unknown>): Promise<LoftDoc>;
  get(id: string): Promise<LoftDoc | null>;
  list(opts?: { limit?: number }): Promise<LoftDoc[]>;
  update(id: string, patch: Record<string, unknown>): Promise<LoftDoc | null>;
  delete(id: string): Promise<{ ok: true } | null>;
  subscribe(handlers: LoftSubscribe): () => void;
}

/**
 * A per-site collection of schemaless documents. Data is scoped to the site the page is served
 * from, isolated from other sites by the server.
 *
 * Pass `{ ownerOnly: true }` to make a collection owner-owned: any signed-in user can still
 * read and create, but a document can only be updated or deleted by the user who created it
 * (enforced server-side against their token, not bypassable from the browser). Without it, the
 * collection is shared/collaborative: anyone on the site can edit anything (right for, e.g., a
 * realtime co-editing tool). The mode is fixed when the collection is first created.
 *   const posts = loft.db.collection('posts', { ownerOnly: true });
 *   const p = await posts.create({ title: 'hi' });   // p.creator === me
 *   await posts.update(p.id, { done: true });        // ok, I made it
 *   const stop = posts.subscribe({ onCreate: d => console.log('new', d) });  // live updates
 */
function collection(name: string, opts?: { ownerOnly?: boolean }): LoftCollection {
  const base = `/api/db/${encodeURIComponent(name)}`;
  return {
    create: (doc: Record<string, unknown>) =>
      req("POST", opts?.ownerOnly ? `${base}?ownerOnly=1` : base, doc) as Promise<LoftDoc>,
    get: (id: string) => req("GET", `${base}/${encodeURIComponent(id)}`) as Promise<LoftDoc | null>,
    list: (opts?: { limit?: number }) =>
      req("GET", opts?.limit ? `${base}?limit=${opts.limit}` : base) as Promise<LoftDoc[]>,
    update: (id: string, patch: Record<string, unknown>) =>
      req("PATCH", `${base}/${encodeURIComponent(id)}`, patch) as Promise<LoftDoc | null>,
    delete: (id: string) => req("DELETE", `${base}/${encodeURIComponent(id)}`) as Promise<{ ok: true } | null>,

    /**
     * Subscribe to live changes in this collection (other clients' writes too). Returns an
     * unsubscribe function. Reconnects automatically if the socket drops.
     */
    subscribe(handlers: LoftSubscribe): () => void {
      let socket: WebSocket | undefined;
      let closed = false;
      let backoff = 500;
      const connect = (): void => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        socket = new WebSocket(`${proto}://${location.host}/api/db/subscribe?collection=${encodeURIComponent(name)}`);
        socket.onopen = () => (backoff = 500);
        socket.onmessage = (e) => {
          const m = JSON.parse(e.data as string) as { op: string; doc?: LoftDoc; id?: string };
          if (m.op === "create" && m.doc) handlers.onCreate?.(m.doc);
          else if (m.op === "update" && m.doc) handlers.onUpdate?.(m.doc);
          else if (m.op === "delete" && m.id) handlers.onDelete?.(m.id);
        };
        socket.onclose = () => {
          if (!closed) setTimeout(connect, (backoff = Math.min(backoff * 2, 10000)));
        };
      };
      connect();
      return () => {
        closed = true;
        socket?.close();
      };
    },
  };
}

/** A live channel: send() broadcasts to the other clients on it; on() receives their messages. */
export interface LoftChannel<T = unknown> {
  send: (msg: T) => void;
  on: (handler: (msg: T) => void) => () => void;
  close: () => void;
}

/**
 * Join a realtime channel scoped to this site (ephemeral pub/sub, nothing is stored). A message
 * sent by one client is delivered to every *other* client on the same channel. For chat, presence,
 * multiplayer cursors, live notifications, etc. Reconnects automatically; sends before the socket
 * is open are buffered.
 *   const room = loft.socket.channel('lobby');
 *   room.on(m => console.log('peer:', m));
 *   room.send({ hi: 'there' });
 */
function channelSocket<T = unknown>(name: string): LoftChannel<T> {
  let socket: WebSocket | undefined;
  let closed = false;
  let backoff = 500;
  const handlers = new Set<(msg: T) => void>();
  // Buffer for sends issued before the socket is open. Bounded so a long disconnect (or an app that
  // sends in a tight loop while offline) can't grow it without limit; oldest queued messages are
  // dropped once the cap is reached.
  const maxPending = 1000;
  const pending: string[] = [];
  const connect = (): void => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/socket?channel=${encodeURIComponent(name)}`);
    socket = ws;
    ws.onopen = () => {
      backoff = 500;
      for (const m of pending.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      let msg: T;
      try { msg = JSON.parse(e.data as string) as T; } catch { msg = e.data as T; }
      handlers.forEach((h) => { h(msg); });
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, (backoff = Math.min(backoff * 2, 10000)));
    };
  };
  connect();
  return {
    send(msg: T) {
      const s = JSON.stringify(msg);
      if (socket?.readyState === WebSocket.OPEN) socket.send(s);
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
      closed = true;
      socket?.close();
    },
  };
}

/** A chat message for loft.ai.chat(). */
export interface LoftChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Send a chat conversation to the platform's model; resolves to the assistant's full reply.
 * Pass `onToken` to stream: it's called with each token as it arrives (the Promise still
 * resolves to the complete text at the end). Without it, the call is non-streaming.
 *   const reply = await loft.ai.chat([{ role: 'user', content: 'hi' }]);
 *   await loft.ai.chat(msgs, { onToken: t => out.append(t) });   // streaming
 */
async function aiChat(messages: LoftChatMessage[], opts?: { onToken?: (token: string) => void }): Promise<string> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, stream: !!opts?.onToken }),
  });
  if (!res.ok) throw new Error(`loft.ai: ${res.status} ${await res.text().catch(() => "")}`.trim());

  if (!opts?.onToken || !res.body) {
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }

  // Standard chat-completions stream: `data: {chunk}` frames carrying choices[0].delta.content,
  // terminated by a `data: [DONE]` line. A missing [DONE] means the reply was truncated.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let done = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
      buffer = buffer.slice(i + 2);
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        continue;
      }
      try {
        const evt = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const token = evt.choices?.[0]?.delta?.content;
        if (token) {
          full += token;
          opts.onToken(token);
        }
      } catch {
        /* ignore malformed/partial SSE frames */
      }
    }
  }
  if (!done) throw new Error("loft.ai: stream ended before completion");
  return full;
}

export const loft = {
  user: { me },

  // Server-keyed chat completions. Keys stay server-side; model is chosen by
  // the platform (no model selection). loft.ai.chat([{ role:'user', content:'…' }]) → reply text.
  ai: { chat: aiChat },

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
