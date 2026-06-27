// Entry point for the prebuilt single-file `<script src="loft.js">` include. It loads the SDK
// and publishes it as a global `loft`, the one bit of global state the package owns. The library
// entry (index.ts) stays side-effect free so bundlers can tree-shake it; this side effect is
// confined to the CDN build that genuinely needs a global.

import loft from "./index";

(globalThis as Record<string, unknown>)["loft"] = loft;
