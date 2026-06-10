# T014 findings: kill package.json, move everything to deno.json

Status: active in the worktree. The package.json removal is now in place again,
with `deno.json` as the manifest. One correction to the earlier finding: Vite+
0.1.20's `vp` command still treats `package.json` as the workspace root marker,
so the no-package setup cannot currently call the `vp` wrapper. Formatting and
linting still use the Vite+ `fmt` / `lint` objects in `vite.config.ts`; the
Deno tasks call the underlying Oxc tools with `VP_VERSION=0.1.20 --config
vite.config.ts`, which matches the environment Vite+ normally injects.

## Current Verified Shape

- `package.json` is deleted.
- `deno.json` owns name/version/exports, npm imports, and tasks.
- `node_modules` was deleted and rebuilt with `deno install`.
- `deno task check` passes using `vite.config.ts` as the single source for
  format/lint config.
- `deno task build` passes using direct `tsdown`.
- `deno task test` executes direct `vitest`; non-server tests pass, while the
  two HMR tests are blocked in the sandbox by local server bind permission.

## What was proven to work (all three verify tasks green at once)

1. `deno.json` carried full package metadata and dependencies:

```json
{
	"name": "@gumbox/vite",
	"version": "0.0.0",
	"exports": "./src/index.ts",
	"nodeModulesDir": "auto",
	"imports": {
		"mitt": "npm:mitt@^3.0.1",
		"mlly": "npm:mlly@^1.8.2",
		"pathe": "npm:pathe@^2.0.3",
		"tinyglobby": "npm:tinyglobby@^0.2.17",
		"@types/node": "npm:@types/node@24.12.2",
		"typescript": "npm:typescript@5.9.3",
		"vite": "npm:vite@8.0.16",
		"vite-plus": "npm:vite-plus@0.1.20",
		"vitest": "npm:vitest@4.1.5"
	},
	"tasks": {
		"test": "deno run -A npm:vitest@4.1.5",
		"build": "deno run -A npm:tsdown@0.22.2 ...",
		"fmt:check": "VP_VERSION=0.1.20 deno run -A npm:oxfmt@0.46.0 --check --config vite.config.ts .",
		"check": "deno task fmt:check && deno task lint && deno task typecheck"
	}
}
```

2. `package.json` deleted; `rm -rf node_modules && deno install` rebuilt
   node_modules and deno.lock cleanly from deno.json (lock `workspace` section
   switches from `packageJson.dependencies` to `dependencies`).
3. `vite.config.ts` needed two changes to survive without package.json:
   - Runtime `import { defineConfig } from 'vite-plus'` replaced with
     `import type { defineConfig } from 'vite-plus'` and
     `export default { ... } satisfies Parameters<typeof defineConfig>[0];`
   - `pack.exports` block removed; `pack.external: ['mitt','mlly','pathe','tinyglobby','vite']` added.

With that in place: `deno task test` 5/5 passed, `deno task build` produced
dist/index.mjs (41.4 kB) + dist/index.d.mts (10.7 kB) with all four runtime deps
plus vite kept external (verified via import statements in dist/index.mjs).

## Exact errors hit and root causes (how vp derives pack metadata)

1. `deno task test|build|check` with a runtime `vite-plus` import in vite.config.ts:

```
error: Package not found in workspace: `AbsolutePathBuf("/Users/jacksm5pro/dev/open-source/gumbox")`
```

   Root cause: vite's config loader bundles vite.config.ts into a temporary
   `vite.config.ts.timestamp-*.mjs` keeping `vite-plus` as an external bare
   import. Deno's node-compat resolver (the runtime under `deno task` npm bins)
   resolves bare specifiers from workspace files via the nearest package.json;
   with none present it aborts with the workspace error. Type-only imports are
   erased at bundle time and avoid this entirely.

2. tsdown (vp pack's engine, `@voidzero-dev/vite-plus-core/pack`) and package.json:
   - It auto-derives externals from package.json dependencies/peerDependencies;
     without one, externals must be listed manually or deps get bundled.
   - The `exports` generator writes into package.json and hard-throws:
     `` `package.json` not found, cannot write exports `` (build-CgGnBlCD-*.js:4070).
     publint/attw degrade to warnings. So `pack.exports` must be removed.
   - The non-deprecated `pack.deps.neverBundle` form crashes with the same
     "Package not found in workspace" error (its node_modules dependency
     analysis requires a package.json); the deprecated `pack.external` works.
   - Without package.json `type: module`, tsdown still emits `.mjs`/`.d.mts`
     (extension chosen because pkg type is unknown), matching the previous output.

## Why blocked

While verification was in progress, the working tree was concurrently and
intentionally mutated outside this task: deno.json was reverted to its original
form (tasks + nodeModulesDir only), package.json was recreated, and
vite.config.ts was restored to the runtime defineConfig import. Continuing
would have meant overwriting intentional user changes, and concurrent edits to
this task's allowed files violate parallel-safety. The session's only residue
(deno.lock gaining `npm:vite-plus@*` and the imports-based workspace section)
was restored from HEAD. Final state verified green: deno task test 5/5,
deno task build (dist/index.mjs + dist/index.d.mts), deno task check (fmt,
lint, typecheck all pass).

## Publishing implications (recorded per task)

- npm publish requires a package.json. After this migration, publishing must be
  either JSR via `deno publish` (using deno.json name/version/exports — note
  `exports: "./src/index.ts"` publishes TypeScript source, not dist) or a
  package.json manifest generated at release time from deno.json + the pack
  output (restoring files, type, exports → dist/index.d.mts / dist/index.mjs,
  publishConfig.access public).
- `peerDependencies` (vite 8.0.16) and `engines` (node >=22) have **no deno.json
  equivalent** — these semantics are silently lost until a publish manifest is
  generated; consumers on npm would otherwise get no peer/engine constraints.
- `scripts.prepublishOnly` (deno task build) likewise has no deno.json home and
  must move into the release pipeline.
