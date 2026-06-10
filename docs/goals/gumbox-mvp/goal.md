# Goal: Gumbox MVP Implementation

## Original Request

> begin working on the gumbox implementation, use the scripts folder in
> qwik-bundler repo as some example of fixtures of what gumbox solves. Look at
> the specs folder and follow the spec

## Interpreted Outcome

A working Gumbox implementation in this repo (npm package `gumbox`, renamed
from `@gumbox/vite` by user directive 2026-06-10) that follows the
specs in `specs/`, targeting the stated wedge: replacing brittle local smoke
scripts (as exemplified by `/Users/jacksm5pro/dev/open-source/qwik-bundler/scripts/`)
with boxes that run inside a real Vite pipeline and write receipts.

## Intake

- input shape: `specific` (specs exist and are authoritative; fixture source named)
- authority: `requested`
- proof type: `test`
- goal oracle: the workspace test task (`deno task test` after the 2026-06-09
  course correction; previously `pnpm test`) passes with tests that exercise
  spec-defined behaviors against a real Vite pipeline; final Judge audit maps
  the implementation to `specs/*.md` and to at least one qwik-bundler script
  pattern that a box can now express.
- likely misfire: shallow coverage of every spec area instead of a deep,
  working MVP of the wedge; or code that is spec-shaped but never actually
  drives a real Vite dev server / build.
- blind spots: `vp` (vite-plus) toolchain constraints; specs may describe more
  surface than the MVP tranche needs; repo was not a git repository at intake.

## Constraints

- Follow `specs/` as written; where specs conflict with reality, record the
  conflict in a receipt instead of silently deviating.
- Vite 8 Environment API first (`environment.<name>`, `browser` alias,
  `expect.environment.<name>`).
- qwik-bundler repo is read-only reference material — never edit it.

## Course Correction (2026-06-09)

User directive, supersedes the earlier "keep pnpm toolchain" constraint:

- **Runtime-agnostic library.** Never import `node:path`, `node:url`,
  `node:os`, `node:events`, `node:util`, `node:fs`, or touch `process.*` in
  library and ordinary test code. Use environment-agnostic packages instead:
  `pathe` (paths), `ufo` (URLs), `mlly` (module/url utils such as
  `fileURLToPath`), `std-env` (env/runtime detection), `tinyglobby` (file
  discovery). The library must not contain Deno-specific code either
  (`Deno.*` is equally forbidden).
- **Filesystem boundary.** Real project edits and receipts use an injected
  `GumboxFileSystem`. The library must not auto-discover runtime filesystem
  APIs; host entrypoints and test support adapt their runtime capability into
  the interface.
- **Deno workspace.** The workspace runtime/toolchain is Deno (`deno task`,
  `deno install`), replacing pnpm. `package.json` stays for npm publishing
  metadata. Verify commands across the board change from `pnpm ...` to
  `deno task ...`.
- **Best/fastest tooling.** Prefer native tooling with TypeScript APIs and
  the unjs ecosystem. AST work in the gumbox plugin must use rolldown/oxc's
  native parser (`parseAst` from rolldown, oxc-parser) — never babel, acorn,
  or a second JS parser. This policy is encoded in `.claude/rules/` so future
  generated code follows it.

## Extended Outcome (2026-06-09 /goal directive)

The user extended the goal:

1. **Full spec coverage.** Everything in `specs/` must be covered (implemented,
   or explicitly deferred-by-spec) — the T016 coverage map plus slices
   T005–T009 and T017 define the remaining work.
2. **qwik-bundler integration.** Once specs are covered, replace the
   `scripts/` folder in the qwik-bundler repo with gumbox boxes, with
   qwik-bundler depending on gumbox via `link:../gumbox`. This **supersedes**
   the earlier "qwik-bundler repo is read-only — never edit it" constraint:
   editing qwik-bundler is now in scope for the integration task only.
3. **HMR is a flagship use case.** For every fixture exercised under HMR, the
   receipt must show *exactly what happened*: which files were edited, which
   modules were invalidated and why, which boundaries accepted the update vs.
   full-reloaded, what the hot channel broadcast, which plugins were
   implicated, and timing. "An HMR event occurred" is not enough evidence.

## Tranche Definition

Discover the spec surface and fixture patterns, then complete successive safe
verified work packages until: the core runtime (box discovery, execution
against a real Vite pipeline, receipt writing) and the CLI entry path work
end-to-end for at least one canonical scenario class drawn from the
qwik-bundler scripts, verified by `deno task test`. Then continue through the
extended outcome: full spec coverage, deep per-fixture HMR evidence, and the
qwik-bundler `scripts/` replacement via `link:../gumbox`.
