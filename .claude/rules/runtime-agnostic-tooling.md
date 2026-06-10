# Runtime-Agnostic Tooling Rule

Gumbox library code must run anywhere Vite runs: Node, Deno, and Bun. The workspace itself runs on
Deno. Generated code must always pick the fastest, most portable tool available — native tooling
with TypeScript APIs and the unjs ecosystem first.

## Forbidden In Library And Ordinary Test Code

- `node:path`, `node:url`, `node:os`, `node:events`, `node:util`, `node:http`, `node:crypto`,
  `node:fs`, `node:fs/promises`, `node:child_process`, `node:worker_threads`
- `process.*` (including `process.env`, `process.cwd`, `process.platform`)
- `Deno.*` and `Bun.*` — the library must not be Deno-specific either
- `require()`, `__dirname`, `__filename`

## Required Replacements

| Need                          | Use                                                            | Never                            |
| ----------------------------- | -------------------------------------------------------------- | -------------------------------- |
| Path join/resolve/relative    | `pathe`                                                        | `node:path`                      |
| URL build/parse/query         | `ufo`                                                          | `node:url`, string concat        |
| `fileURLToPath`, module utils | `mlly`                                                         | `node:url`                       |
| Runtime/env detection         | `std-env`                                                      | `process.platform`, `Deno.build` |
| File discovery/globbing       | `tinyglobby`                                                   | hand-rolled `readdir` walks      |
| Event emitters                | web-standard `EventTarget` or a tiny agnostic emitter (`mitt`) | `node:events`                    |
| Hashing/object hash           | `ohash` or `globalThis.crypto` (Web Crypto)                    | `node:crypto`                    |
| HTTP requests                 | global `fetch`                                                 | `node:http`, `axios`             |
| Temp/scratch space in tests   | repo-local `.tmp/` directory (gitignored)                      | `node:os` `tmpdir()`             |
| Filesystem access             | injected `GumboxFileSystem` from `src/filesystem.ts`           | direct runtime FS imports        |

## Filesystem Boundary

The library needs real filesystem access for project edits and receipts, but library code must not
find runtime filesystem APIs itself. `src/filesystem.ts` exposes `GumboxFileSystem` plus
`createFileSystem(runtime)`, and callers such as the CLI, adapters, and tests must inject that
capability into `runBoxes()`.

Only explicit host boundaries may adapt runtime filesystem APIs into `GumboxFileSystem`. In this
repo, `test/support/host-file-system.ts` is the test-only host boundary because the Vite HMR tests
need real files on disk. Keep that adapter small and do not import `node:fs`, `node:fs/promises`,
or scatter direct filesystem access through `src/` or test bodies.

## Fast Native Tooling

- AST work in the gumbox plugin uses rolldown/oxc's native parser — `parseAst` from `rolldown` (or
  `oxc-parser` directly). Never add babel, acorn, esprima, or a second JS parser; never parse with
  the `typescript` compiler API at runtime.
- String-position transforms use `magic-string`, not re-printing an AST.
- Prefer Rust-native tools with TypeScript APIs (oxc, rolldown, lightningcss, tinyglobby/fdir) and
  unjs packages over slower JS reimplementations.

## Workspace Runtime: Deno

- Run tasks with `deno task test`, `deno task build`, `deno task check`; install with
  `deno install`.
- Do not add pnpm/npm-specific workflow steps, scripts, lockfiles, or dependency sources.
  `deno.json` is the canonical manifest; npm publishing requires a generated manifest or a
  separate release path.
- Never weaken the runtime-agnostic rules above because "the workspace is Deno" — workspace runtime
  and library portability are independent.

## New Dependency Checklist

Before adding a dependency, confirm:

1. It is environment-agnostic (no Node-only or Deno-only APIs in its public behavior).
2. An unjs or native-backed equivalent doesn't already cover it.
3. If it sits on a hot path (parsing, traversal, bundling), it is native-backed.
