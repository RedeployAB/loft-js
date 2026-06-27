// Print the Subresource Integrity hash for the CDN build, for a <script integrity="..."> tag.
// The hash must match the exact bytes served from the CDN, so this rebuilds dist/loft.js first
// and the value is only final once the source for a release is frozen. Run via `pnpm run sri`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const file = new URL("../dist/loft.js", import.meta.url);
const hash = createHash("sha384").update(readFileSync(file)).digest("base64");
process.stdout.write(`sha384-${hash}\n`);
