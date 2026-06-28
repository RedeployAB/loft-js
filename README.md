# loft-js

A small typed browser SDK for apps hosted on [Loft](https://github.com/larsakerlund/loft). It wraps the Loft backend so your app can
call identity, uploads, a document database, AI chat, and realtime channels without writing fetch
and auth by hand. Every call is same-origin to the backend, which holds all credentials and keys
server-side, so nothing secret reaches the browser.

## Requirements

This runs in the browser, in a page served by Loft. It assumes:

- A browser environment. It uses `fetch`, `WebSocket`, and `location`, so it does not run under
  plain Node or during server-side rendering. Guard any SDK call so it only runs on the client.
- Same-origin hosting. Every request goes to a relative path (`/api/...`) on the page's own
  origin, with cookies, so the page must be served by Loft.

## Install

Bundle it into your app and upload the result as part of your deployment:

```bash
npm install loft-js
```

```ts
import loft from "loft-js";

const me = await loft.user.me();
const { url } = await loft.upload(file);
```

The package is ESM-only (no CommonJS build). Import it with `import`, or in a bundler/TypeScript
project; `require("loft-js")` is not supported.

Or include the prebuilt single file with a script tag (no build step), which exposes a global
`loft`. Pin a version so the file cannot change under you:

<!-- x-release-please-start-version -->

```html
<script src="https://unpkg.com/loft-js@0.1.0/dist/loft.js"></script>
<script>
  loft.user.me().then((me) => console.log(me.name));
</script>
```

<!-- x-release-please-end -->

For production you can also add a subresource-integrity hash so the browser rejects a tampered
file; `pnpm run sri` prints it for the version you pin.

## API

### Identity

```ts
const me = await loft.user.me();
// { id: string, email: string, name: string }
```

`id` is the stable identity from the auth provider. Use it for ownership checks. `email` and
`name` are for display and can change, so never key on them.

### Document database

`loft.db.collection(name)` returns a handle to a per-site collection of schemaless documents.
Data is scoped to the site the page is served from and isolated from other sites by the server.
Pass a type to get typed reads; without one, fields come back as `unknown`.

```ts
const posts = loft.db.collection<{ title: string; pinned?: boolean }>("posts");

const post = await posts.create({ title: "Hello" }); // post.title, post.id, post.creator typed
const one = await posts.get(post.id);                // the doc, or null if absent
const many = await posts.list({ limit: 20 });        // an array of docs
await posts.update(post.id, { pinned: true });       // the updated doc, or null
await posts.delete(post.id);                         // true if removed, false if already gone
```

Every stored document carries a server-assigned `id` and a `creator`, the stable id of the user
who created it, stamped server-side from their token. Compare `creator` to `(await
loft.user.me()).id` to tell whether the current user owns a document.

Pass `{ ownerOnly: true }` when first creating a collection to make it owner-owned: any signed-in
user can read and create, but a document can only be updated or deleted by the user who created
it, enforced server-side. Without it, the collection is shared: anyone on the site can edit
anything, which is right for a co-editing tool. The mode is fixed when the collection is first
created.

```ts
const notes = loft.db.collection("notes", { ownerOnly: true });
```

Subscribe to live changes, including other clients' writes. The returned function unsubscribes,
and the socket reconnects on its own if it drops.

```ts
const stop = posts.subscribe({
  onCreate: (doc) => render(doc),
  onUpdate: (doc) => render(doc),
  onDelete: (id) => remove(id),
  onStatus: (s) => setBanner(s), // "open" | "reconnecting" | "closed"
  onError: (e) => console.warn(e.kind),
});
// later: stop();
```

Changes that happen while the socket is disconnected are not replayed. If you need every change,
re-list on reconnect: call `posts.list()` again when `onStatus` reports `"open"` after a
`"reconnecting"`.

### Realtime channels

`loft.socket.channel(name)` joins an ephemeral pub/sub channel scoped to the site. A message sent
by one client is delivered to every other client on the same channel. Nothing is stored. Use it
for chat, presence, multiplayer cursors, or live notifications. It reconnects on its own, and
sends issued before the socket is open are buffered.

```ts
const room = loft.socket.channel("lobby", {
  onStatus: (s) => setBanner(s), // "open" | "reconnecting" | "closed"
  onError: (e) => console.warn(e.kind),
});
const off = room.on((msg) => console.log("peer:", msg));
room.send({ hello: "there" });
// later: off(); room.close();
```

### AI chat

`loft.ai.chat(messages)` sends a conversation to the platform's model and resolves to the
assistant's full reply. Keys stay server-side and the model is chosen by the platform.

```ts
const reply = await loft.ai.chat([
  { role: "system", content: "You are concise." },
  { role: "user", content: "Explain WebSockets in one line." },
]);
```

For token-by-token output, `loft.ai.stream(messages)` returns an async iterable of tokens:

```ts
for await (const token of loft.ai.stream(messages)) {
  output.append(token);
}
```

Break out of the loop (or pass an aborting `signal`) to stop early and release the connection.

### Uploads

`loft.upload(file)` stores a file server-side and resolves to a URL under `/uploads/...` that only
signed-in users can fetch. Use the URL directly as an `<img src>`, an `href`, and so on.

```ts
const { url } = await loft.upload(input.files[0]);
await loft.upload(blob, { name: "report.pdf" }); // override the stored filename
await loft.upload.delete(url); // remove it later; idempotent
```

## Errors

Every call rejects with a `LoftError` on failure. Switch on `kind` to handle it. `status` carries
the HTTP status when the failure came from a response.

```ts
import loft, { LoftError } from "loft-js";

try {
  await loft.user.me();
} catch (e) {
  if (e instanceof LoftError && e.kind === "auth") {
    // not signed in or not permitted
  }
}
```

| `kind`       | Meaning                                                         |
|--------------|----------------------------------------------------------------|
| `auth`       | Not signed in or not permitted (401, 403).                     |
| `not_found`  | A 404 from a call that does not already model absence as null. |
| `http`       | Any other non-2xx response.                                    |
| `network`    | The request never reached the server.                          |
| `aborted`    | The request was cancelled through an AbortSignal.              |
| `timeout`    | An `AbortSignal.timeout()` elapsed before the request finished. |
| `stream`     | A streamed reply ended before it signalled completion.         |
| `parse`      | The response body was not the shape the SDK expected.          |

Note that `get` and `update` resolve to `null`, and `delete` resolves to `false`, for a missing
document rather than throwing, so a 404 there is a normal result. `create` and `list` are not
nullable: a 404 from them throws `not_found`.

## Cancellation and timeouts

Every network call takes an optional `signal` so you can cancel an in-flight request, which
matters most for a long upload or a running chat stream. A cancel rejects with a `LoftError` of
kind `aborted`.

```ts
const controller = new AbortController();
const replyPromise = loft.ai.chat(messages, { signal: controller.signal });
controller.abort();
try {
  await replyPromise;
} catch (e) {
  // e is a LoftError of kind "aborted"
}
```

For a deadline, pass `AbortSignal.timeout(ms)`. It rejects with kind `timeout`, distinct from a
user cancel, so you can retry a timeout without retrying something the user stopped on purpose:

```ts
await loft.upload(file, { signal: AbortSignal.timeout(10_000) }); // kind "timeout" if it elapses
```

## Build

```bash
pnpm install
pnpm run build
```

Emits `dist/loft.mjs` (ES module, used by `import`) and `dist/loft.js` (a minified `<script>`
global), each with a source map, plus `dist/index.d.ts` (types).

## License

MIT. See [LICENSE](./LICENSE).
