# T016 — Spec Coverage Audit

Status: current coverage map for the dirty worktree after T014/T015.

This note supersedes the "CURRENT STATE GAP" section in
`notes/T001-spec-inventory.md`. T001 was the intake inventory before the first
runtime slice existed; it is still useful as a requirements extract, but it no
longer describes implementation status.

## Coverage Legend

- **Implemented**: code exists and has focused test or receipt evidence.
- **Partial**: code exists for a narrow slice, but the spec's public behavior is
  broader than the implementation.
- **Queued**: explicitly covered by a board task.
- **Deferred**: intentionally outside the current MVP tranche.
- **Gap**: spec requirement had no clear board owner before this audit.

## Current Implemented Slice

- `box(name, run)` and `box(options, run)` with `name`, `tags`, `modes`, and
  `ui` metadata: **Implemented** in `src/box.ts`, tested by box discovery.
- `*.box.ts` / `*.box.tsx` discovery with default and named exports:
  **Implemented** in `src/discovery.ts`, tested by `test/gumbox.test.ts`.
- Exact six-key box context (`environment`, `browser`, `project`, `pipeline`,
  `expect`, `receipt`): **Implemented** in `src/types.ts` / `src/runner.ts`.
- `pipeline.dev()` through Vite `createServer(...)`: **Implemented** in
  `src/runner.ts`.
- Vite environment names from `server.environments`: **Implemented** in
  `src/environments.ts`, recorded in receipts.
- Environment capability gates for `request(path)` and `import(id)`:
  **Implemented** for the current dev slice.
- `browser` / `expect.browser` alias target: **Partial**. The alias resolves to
  the default browser environment, but `browser.visit(...)` intentionally throws
  until browser evidence ships.
- `project.edit(path, { replace })` and function edits with restore:
  **Implemented** in `src/project.ts`, tested including failure restoration.
- `project.read(...)` and `project.exists(...)`: **Implemented** but lightly
  tested through runtime use only.
- HMR evidence from Vite `hotUpdate` and the environment hot channel:
  **Implemented** in `src/evidence.ts`; receipts contain normalized
  `EnvironmentEditOutcome`.
- WebSocket HMR payload evidence without a browser: **Implemented** in
  `connectHotWebSocket(...)`.
- `expect.environment.<name>.hotUpdate/noFullReload/invalidated/notInvalidated/satisfies`:
  **Implemented** for edit outcome evidence.
- `expect.html.contains(...)`: **Implemented** for request/HTML evidence.
- `expect.pipeline.serverRestarted(...)`: **Implemented**, but no config edit
  test currently proves it.
- `receipt.capture/note/measure(...)`: **Implemented** and receipt-tested.
- Versioned JSON receipts under `.gumbox/receipts/<run>/receipt.json` plus
  `latest`: **Implemented** in `src/receipt.ts`, tested.
- Failure stack/message and edit restoration status in receipts:
  **Implemented**.
- Runtime-agnostic filesystem boundary: **Implemented** as injected
  `GumboxFileSystem`, with host adaptation in test support.

## Spec Coverage By File

### `specs/README.md`

- Current wedge: real Vite pipeline plus receipts: **Partial**. The core dev/HMR
  pipeline exists; CLI, UI, build, preview, and browser receipt paths are not
  complete.
- Canonical use cases: **Partial/Queued**. HMR and environment isolation are
  implemented. Build artifact, preview parity, visual state gallery, and CLI
  reproducibility are queued below.

### `specs/product-direction.md`

- Positioning as "Vite Environment API-first QA receipt tool": **Partial**.
  The runtime uses Vite environments directly, but the public plugin/CLI/UI
  surfaces are still thin.
- "What Gumbox proves" list:
  - Dev server startup and environment discovery: **Implemented**.
  - HMR, full reload, module invalidation: **Implemented** for source edits.
  - SSR/server import evidence: **Implemented** for runnable `ssr`.
  - Config reloads, env-file changes, server restarts: **Queued in T005**.
  - Custom environments and fetchable server requests: **Partial**; generic
    capability code exists, but no fixture coverage.
  - Plugin hook/order/transform/middleware/virtual-module evidence: **Gap
    before this audit; queued in T017**.
  - `createBuilder(...)` build evidence: **Queued in T005**.
  - Vite `preview(...)` and dev/build/preview parity: **Queued in T007/T017**.
  - Resolver/module identity: **Gap before this audit; queued in T017**.
  - CSS/HTML/assets/source maps/public paths: **Gap before this audit; queued
    in T017**.
  - Optimizer/dependency handling: **Gap before this audit; queued in T017**.
  - Build artifacts/chunks/manifests: **Queued in T005/T017**.
  - Performance receipts: **Partial** via `receipt.measure`; richer pipeline
    metrics queued in T017.
  - Browser-visible evidence: **Queued in T007**.
- Agent verification oracle: **Partial**. Receipts are machine-readable and
  causal for source-edit/HMR cases; richer implicated plugin/artifact/runtime
  evidence is queued in T017.
- Visual state gallery: **Queued in T008**.
- Environment model and browser alias: **Partial**. `environment.<name>` and
  alias target exist; typed autocomplete and real `visit` do not.
- Vite pipeline ownership: **Partial**. `createServer(...)` is used. Build,
  preview, and plugin-injected `/__gumbox` routes are queued.
- Anti-drift guardrails: **Covered by design and current API**. No Storybook
  CSF/args/controls or component-mounting API is implemented.
- Manual fixture DX: **Partial**. Box discovery is implemented; manual fixture
  registration is not the happy path.

### `specs/box-authoring.md`

- File shape and `box(...)`: **Implemented**.
- Context shape: **Implemented**.
- UI state boxes: **Partial**. `ui` metadata exists; state gallery and real
  visual previews are queued in T008/T007.
- Environment API:
  - `environment.<name>`: **Implemented**.
  - `request(path)` / `import(id)`: **Implemented for dev**.
  - `visit(path)`: **Queued in T007**.
- Browser alias: **Partial**. Alias exists, but `browser.visit(...)` throws.
- Project API:
  - `project.edit`, `read`, `exists`: **Implemented**.
  - `project.edit.create/remove/copy/config`: **Queued in T005**.
  - Batch edits and richer diff summaries: **Queued in T005**.
- Pipeline API:
  - `pipeline.dev`: **Implemented**.
  - `pipeline.build`: **Queued in T005**.
  - `pipeline.preview`: **Queued in T007**.
- Expect API:
  - `expect.environment`, `expect.browser`, `expect.pipeline.serverRestarted`,
    `expect.html.contains`: **Implemented/Partial**.
  - `expect.page`: **Queued in T007**.
  - `expect.build` / `expect.artifact`: **Queued in T005**.
  - `expect.performance`, resolver/module identity, CSS/asset, plugin hook
    assertions: **Queued in T017**.
- Environment evidence model: **Partial**. `EnvironmentEditOutcome` exists;
  `plugins` is always empty and client lifecycle events are not captured yet.
- Typed project model under `.gumbox/types`: **Queued in T009**.
- Network/state adapters: **Deferred**. Spec says future/secondary.
- Component mounting: **Deferred / rejected as MVP center**.
- Browser escape hatch: **Queued in T007** if a raw page escape hatch is kept.
- Receipt API: **Implemented**.
- Rejected shapes: **Covered**. No global `visit`, `expect.edit`,
  `vite.client`, Storybook CSF center, or Playwright-first file model exists.

### `specs/cli.md`

No CLI exists yet.

- `gumbox [selector]`, selector matching, `--json`, `--receipt-dir`, CI
  headless defaults: **Queued in T006**.
- `gumbox run`: **Queued in T006**.
- `gumbox list`: **Queued in T006**.
- `gumbox open`: **Queued in T008**.
- `gumbox types`: **Queued in T009**.
- `gumbox preview`: **Queued in T007 and should be represented in the CLI task
  acceptance tests**.
- `gumbox replay`: **Queued in T009**.
- `gumbox doctor`: **Queued in T009**.
- `init` and `migrate`: **Deferred**.

### `specs/runtime-routes.md`

No runtime routes exist yet.

- `/__gumbox` dev middleware UI, state gallery, metadata endpoints, execution
  endpoints, receipt APIs, and timeline playback: **Queued in T008**.
- Preview-only `/__gumbox` on local preview port, never production output:
  **Queued in T008**.
- Local-only security posture (reject remote hosts, token, receipt-dir hiding):
  **Queued in T008**.

### `specs/scenarios-and-receipts.md`

- Box definition and sources: **Implemented** for `*.box.ts(x)`.
- State surfaces:
  - Project file edits and environment requests/imports: **Implemented**.
  - Real browser app routes: **Queued in T007**.
  - Build/preview surfaces: **Queued in T005/T007**.
  - External network/state adapters: **Deferred**.
- File convention: **Implemented**.
- Box lifecycle:
  - Discover/load/run/restore/write receipt: **Implemented**.
  - Type refresh, browser lifecycle, UI lifecycle: **Queued in T007-T009**.
- Receipt definition:
  - Version, run id, box file/export, Vite config path, server URL,
    environments, edits, outcomes, assertions, timeline, notes, captures,
    measurements: **Implemented**.
  - Type-model hash, screenshots, DOM snapshots, console/network errors,
    plugin evidence, artifacts, route/preview/build comparison, implicated
    plugin/module/file classification: **Queued in T007/T017**.
- Timeline: **Partial**. Current timeline is ordered and causal for dev/HMR; it
  does not yet cover browser, build, preview, CSS/assets, or replay UI.
- Stack traces: **Implemented** for thrown box errors.
- Time travel/replay: **Queued in T009**.

## Board Changes Needed

This audit found that T005-T009 cover the broad shape, but several spec areas
were only implicit. The board should be tightened as follows:

- T005 must explicitly cover config/env edits, server restart/reload evidence,
  `project.edit.create/remove/copy/config`, build artifacts, and
  `expect.build` / `expect.artifact`.
- T006 must stay narrowly CLI run/list/selector/JSON/receipt-dir/exit-code
  focused.
- T007 must cover `browser.visit`, `expect.page`, screenshots/console/network,
  `pipeline.preview`, and the `gumbox preview` execution path.
- T008 must cover `/__gumbox`, state gallery, local-only dev/preview exposure,
  `gumbox open`, and receipt/timeline APIs.
- T009 must cover typegen, replay, and doctor.
- Add T017 for the remaining Vite-pipeline evidence packs: resolver/module
  identity, CSS/assets/source maps/public paths, optimizer/dependency handling,
  plugin hook/transform/middleware/virtual-module evidence, build chunk/module
  graph integrity, and richer performance receipts.

## Verification Notes

- `deno task check` is green after removing the stray `.oxfmtrc.json`; format
  and lint now read `vite.config.ts` as the single Vite+ config source.
- Full `deno task test` is currently blocked in this sandbox by local server
  bind permissions for the two HMR tests. Focused non-server tests and previous
  full runs prove the implemented slice outside this sandbox restriction.
