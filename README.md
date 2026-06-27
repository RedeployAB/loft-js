# Loft SDK

A small typed browser SDK for apps hosted on Loft. It wraps loftd so your app can call
identity, uploads, the document DB, AI chat, and realtime channels without writing fetch
and auth by hand. Every call is same-origin to loftd, which holds all credentials and keys
server-side, so nothing secret reaches the browser.

## Install

Bundle it into your app and upload the result as part of your deployment:

```bash
npm install @loft/sdk
```

```ts
import loft from "@loft/sdk";

const me = await loft.user.me();
const { url } = await loft.upload(file);
```

Or include the prebuilt single file with a script tag (no build step), which exposes a
global `loft`:

```html
<script src="https://unpkg.com/@loft/sdk/dist/loft.js"></script>
<script>
  loft.user.me().then((me) => console.log(me.name));
</script>
```

## Build

```bash
pnpm run build
```

Emits `dist/loft.mjs` (ES module, used by `import`), `dist/loft.js` (a `<script>` global),
and `dist/index.d.ts` (types).
