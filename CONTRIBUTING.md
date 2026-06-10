# Contributing to gumbox

Welcome! This guide gets you from zero to a running dev loop in about two
minutes — no prior Deno experience needed.

## 1. Install Deno

Deno is the only tool you need. There is no Node, npm, or pnpm setup in this
repo — `deno.json` is the whole manifest.

Install it from the official site: <https://docs.deno.com/runtime/getting-started/installation/>

On macOS/Linux that's one command:

```sh
curl -fsSL https://deno.land/install.sh | sh
```

On Windows (PowerShell):

```powershell
irm https://deno.land/install.ps1 | iex
```

Check it worked:

```sh
deno --version
```

## 2. Install dependencies

From the repo root:

```sh
deno install
```

This reads `deno.json` and populates `node_modules` (yes, Deno manages npm
packages for you — you never run npm).

## 3. Develop

```sh
deno task dev
```

That starts the test runner in watch mode: edit a file in `src/` or `test/`,
and the affected tests re-run instantly. It is the main feedback loop while
you work.

Other tasks you'll use:

```sh
deno task test    # run the whole test suite once
deno task build   # build the publishable package into dist/
deno task check   # formatting + lint + type check (CI runs this)
deno task fmt     # auto-fix formatting
```

If `deno task check` complains about formatting, `deno task fmt` fixes it.

## What is this project?

gumbox runs "boxes" — small TypeScript files (`*.box.ts`) that drive a real
Vite pipeline (dev server, HMR edits, builds, a real browser) and write a
JSON **receipt** describing exactly what happened. Start reading here:

- `specs/` — what gumbox is supposed to do (product truth)
- `src/` — the library and CLI
- `test/fixtures/` — small Vite apps the tests run boxes against
- `test/*.test.ts` — the test suite (`deno task dev` watches these)

## Two house rules worth knowing up front

1. **Library code is runtime-agnostic.** Nothing in `src/` may import
   `node:*` modules or touch `process.*` / `Deno.*` — use `pathe`, `mlly`,
   `tinyglobby`, the injected `GumboxFileSystem`, and friends. The full policy
   lives in `.claude/rules/runtime-agnostic-tooling.md`.
2. **Tests drive real Vite.** No mocked pipelines, no `sleep(...)` waits —
   evidence is event-driven. If you're fixing behavior, add the failing test
   first.

A note on browser tests: they use your installed Chrome/Edge (via
`playwright-core`) and skip automatically on machines without one — nothing
to download or configure.

## Before you open a PR

```sh
deno task test && deno task build && deno task check
```

If all three pass, you're good. Thanks for contributing!
