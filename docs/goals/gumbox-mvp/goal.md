# Goal: Gumbox MVP Implementation

## Original Request

> begin working on the gumbox implementation, use the scripts folder in
> qwik-bundler repo as some example of fixtures of what gumbox solves. Look at
> the specs folder and follow the spec

## Interpreted Outcome

A working Gumbox implementation in this repo (`@gumbox/vite`) that follows the
specs in `specs/`, targeting the stated wedge: replacing brittle local smoke
scripts (as exemplified by `/Users/jacksm5pro/dev/open-source/qwik-bundler/scripts/`)
with boxes that run inside a real Vite pipeline and write receipts.

## Intake

- input shape: `specific` (specs exist and are authoritative; fixture source named)
- authority: `requested`
- proof type: `test`
- goal oracle: `pnpm test` passes with tests that exercise spec-defined
  behaviors against a real Vite pipeline; final Judge audit maps the
  implementation to `specs/*.md` and to at least one qwik-bundler script
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
- Keep `package.json` toolchain (`vp` / vite-plus, vitest, pnpm) unless a spec
  requires otherwise.
- qwik-bundler repo is read-only reference material — never edit it.

## Tranche Definition

Discover the spec surface and fixture patterns, then complete successive safe
verified work packages until: the core runtime (box discovery, execution
against a real Vite pipeline, receipt writing) and the CLI entry path work
end-to-end for at least one canonical scenario class drawn from the
qwik-bundler scripts, verified by `pnpm test`.
