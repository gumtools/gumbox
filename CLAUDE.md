# gumbox

`gumbox` — boxes that run inside a real Vite pipeline and write receipts, replacing brittle
local smoke scripts. Specs in `specs/` are product truth.

## Workspace

- Runtime/toolchain is **Deno**: `deno task test`, `deno task build`, `deno task check`,
  `deno install`. Do not use pnpm/npm commands.
- `deno.json` is the canonical workspace/package manifest. This repo has no `package.json`; npm
  publishing requires a generated manifest or a separate release path.

## Hard Tooling Rules (see `.claude/rules/runtime-agnostic-tooling.md`)

- Library and ordinary test code is runtime-agnostic: no `node:*` imports, no `process.*`, no
  `Deno.*`/`Bun.*`. Filesystem access is an injected `GumboxFileSystem`; only explicit host
  boundaries adapt runtime filesystem APIs.
- Use `pathe` (paths), `ufo` (URLs), `mlly` (fileURLToPath/module utils), `std-env` (runtime
  detection), `tinyglobby` (globbing), global `fetch`.
- AST work uses rolldown/oxc's native parser (`parseAst` from `rolldown` / `oxc-parser`) — never
  babel, acorn, or a second JS parser. Prefer native (Rust-backed) tooling with TypeScript APIs and
  the unjs ecosystem.

All rules in `.claude/rules/*.md` apply; they are hand-edited committed source.
