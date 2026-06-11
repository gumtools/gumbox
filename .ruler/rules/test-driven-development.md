# Test Driven Development Rule

Use test-driven development for behavior changes and bug fixes.

## Required Workflow

1. Identify the observable behavior or invariant before editing implementation code.
2. Add or update the closest focused test that proves the behavior.
3. Run that test before the implementation change when feasible and confirm it fails for the
   expected reason.
4. Make the smallest implementation change that satisfies the test.
5. Rerun the focused test and keep iterating until it passes.
6. Run any broader verification required by the touched surface (`deno task test`,
   `deno task build`, `deno task check`).

## Test Selection

- Prefer unit/spec tests next to the changed code (`test/*.test.ts` against in-repo fixtures).
- Drive tests through the real Vite pipeline (dev server, build) rather than mocking it; the spec
  oracle is behavior against real pipelines.
- Use event-driven waits, never blind sleeps.
- Use browser-dependent tests only for behavior that genuinely needs a browser (slice 4+).

## Exceptions

Docs-only, rules-only, formatting-only, dependency metadata, and generated-output maintenance
changes do not need a failing product test first. They still need the narrowest relevant
verification, such as formatting or `deno task check`.

If dependencies, missing generated artifacts, or local environment constraints prevent a pre-fix
test run, write the focused test first, record the blocker, and run the test as soon as the blocker
is resolved.
