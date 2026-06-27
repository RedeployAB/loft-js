# Contributing

Thanks for helping improve the Loft SDK. This is a published package that other apps import, so
the bar for the public surface is high: explicit types, no lint warnings, and tests for behavior.

## Setup

The repo pins its package manager, so use [pnpm](https://pnpm.io). Corepack will pick up the
pinned version from `package.json`.

```bash
pnpm install
pre-commit install   # one-time, enables the commit hooks
```

## Checks

Run these before opening a pull request. CI runs the same set on every PR.

```bash
pnpm run typecheck   # tsc --noEmit, strict
pnpm run lint        # eslint, zero warnings
pnpm run build       # bundles and emits types
pnpm test            # vitest
```

The TypeScript config is strict, including `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. The public API carries explicit input and output types so the
generated `.d.ts` stays stable and a change to the surface is deliberate.

## Tests

Add or update tests for any behavior change. The suite stubs `fetch` and `WebSocket`, so tests run
under plain Node without a browser. See `test/` for the helpers and patterns.

## Commits

Commit messages follow Conventional Commits with the discipline described in
[CLAUDE.md](./CLAUDE.md): imperative subject, 72 columns, and a body that explains the motivation.
The hooks enforce the grammar and the prose policy. Keep process and review notes out of the
message; describe the change to the code.
