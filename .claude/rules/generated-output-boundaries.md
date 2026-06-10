# Generated Output Boundaries Rule

Edit source files, not generated artifacts. Generated files are evidence to regenerate or inspect,
not the place to make durable changes.

## Do Not Hand-Edit

Do not hand-edit generated outputs such as:

- package build output: `dist/`
- lockfiles: `deno.lock` (change dependencies via `deno.json` + `deno install`)
- gumbox runtime output: `.gumbox/receipts/`, `.gumbox/types/`
- scratch space: `.tmp/`

`.claude/rules/*.md` is committed, hand-edited source in this repo — see the guidance source of
truth rule.

## Regenerate Intentionally

Run the narrowest generator or updater that owns the changed output:

- Build output changes: `deno task build`.
- Lockfile changes: `deno install` after editing `deno.json`.
- Receipt fixtures in tests: rerun the test that writes them; never hand-craft receipt JSON.

## Review Standard

Before finishing a change that touches or depends on generated output:

1. Identify the source file or generator that owns the output.
2. Confirm whether the generated file should be regenerated, ignored, or left unchanged.
3. Run the narrowest relevant generator/check when the environment supports it.
4. Record any missing dependency, network, toolchain, or generated-artifact blocker.
5. Do not claim generated output verification from a source-only check unless that check covers the
   generated artifact.
