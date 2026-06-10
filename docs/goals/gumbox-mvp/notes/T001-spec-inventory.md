# T001 — Spec Required-Behavior Inventory

> Superseded for implementation status by `T016-spec-coverage.md`.
> This file remains the original requirements inventory from before the first
> runtime slice was implemented.

## 1. REQUIRED PUBLIC API (box-authoring.md, product-direction.md)

- Package: `@gumbox/vite`; primary export `box(name, run)` and `box(options, run)` overloads. `BoxOptions = { name, tags?, modes? ('dev'|'build'|'preview'|string), ui? }`. Default + named exports allowed from `*.box.ts(x)`.
- Box context: exactly `{ environment, browser, project, pipeline, expect, receipt }`. Explicitly NO top-level `visit`, `ssr`, `http`, `edit`, or generic `page`.
- Environment API: `environment.<name>` generated from `resolvedConfig.environments` / `server.environments` / `builder.environments`; capability-gated: `visit(path)` (browser-capable), `request(path)` (fetchable), `import(id)` (runnable).
- Browser alias: `browser === environment.client` and `expect.browser === expect.environment.client`; if the browser-capable env is named differently, `browser` resolves to it and the receipt records the alias target.
- Project API: `project.edit(path, change)`, function-style edit `(code)=>string`, `project.edit.create/remove/copy/config`, `project.read`, `project.exists`; `EditChange = {replace:[from,to]} | fn | {create} | {remove:true} | {copyFrom}`. Edits return `EditReceipt`, must trigger real watcher events, record diffs, restore after the box (mark receipt on restore failure).
- Pipeline API: `pipeline.dev()` (`createServer`), `pipeline.build()` (Vite 8 `createBuilder`, `build()` fallback), `pipeline.preview(build)`; config overlay via `pipeline.dev({ config(config){...} })`; `build.artifact(path)`, `preview.browser.visit(path)`.
- Expect API: single `expect` object with namespaces `expect.browser.*`, `expect.environment.<name>.*`, `expect.pipeline.*`, `expect.page.*`, `expect.build.*`, `expect.artifact.*`, `expect.html.*`, `expect.performance.*`. Rejected: `expect.edit.*`, `expect.vite.*`, `expect.view.*`, callable `expect(subject)`. Named assertions in examples: `hotUpdate`, `noFullReload`, `invalidated`, `notInvalidated`, `plugin`, `serverRestarted`, `singleModuleIdentity`, `noDuplicateModules`, `satisfies`; `page.text/visible/exists/cleanConsole/computedStyle`; `build.environment/artifact/pluginHook`; `artifact.json/text/exists`; `html.contains`; `performance.lessThan`.
- Receipt API: `receipt.capture(label)`, `receipt.note(text)`, `receipt.measure(label, fn)`.
- Typed project model: generated ambient `declare module '@gumbox/vite' { interface GumboxProjectTypes {...} }` with permissive unions `Known<T> = T | (string & {})`, under `.gumbox/types`.

## 2. REQUIRED CLI (cli.md)

- `gumbox [selector]` — discover `*.box.ts(x)`, load Vite config, resolve environments, refresh types, start/reuse dev server, headless by default in CI; `--ui`, `--headed`, `--watch`, `--preview`, `--json`, `--receipt-dir`; write a receipt for every run; print receipt path on failure. Selector matches path, glob, box name, basename, tag.
- `gumbox open` — attach to running dev/preview server, open `/__gumbox`; `--url`, `--port`.
- `gumbox list` — list boxes without browser run; `--json`; report invalid box files with actionable errors.
- `gumbox types` — generate ambient types under `.gumbox/types`; `--watch`, `--json`. `gumbox`, `list`, `run` auto-refresh types.
- `gumbox run` — explicit headless form; `--mode dev`, `--headed`, `--json`, `--receipt-dir`; `--json` prints status, receipt path, failed box, route, environment, mode, implicated files, failure event.
- `gumbox preview` — build via `createBuilder(...)`, local preview, Gumbox only on preview port; `--run`, `--open`; build+preview receipts.
- `gumbox replay <receipt>` — serve receipt viewer; do not rerun unless asked.
- `gumbox doctor` — env/Vite/plugin/typegen/browser-deps checks; `--json`.
- Future (non-MVP): `gumbox init`, `gumbox migrate`.
- Exit-code behavior NOT explicitly specified.

## 3. REQUIRED RECEIPT SHAPE (scenarios-and-receipts.md)

- Durable, human- and machine-readable; written for EVERY run; default dir `.gumbox/receipts`, timestamped dirs (e.g. `.gumbox/receipts/2026-06-08T18-42-10Z`) and a `latest` pointer.
- Contents: box file/export, Vite config path + resolved summary, type-model hash, environment names + browser alias target, config overlays/edits, dev/build/preview lifecycle, server URLs, route/request surface, screenshots, DOM/HTML snapshots, console/network errors, file edits + restoration status, HMR/full-reload/invalidation/restart events, plugin evidence, artifact checks, performance metrics, assertion results, machine-readable summary, implicated files/routes/environments/plugins/failure events.
- Per-edit normalized `EnvironmentEditOutcome` per environment (`update`, `fullReload`, `restart`, `error`, `invalidated`, `updates`, `plugins`) plus raw Vite 8 evidence: ws payloads (`update`/`full-reload`/`custom`/`error`), client events (`vite:beforeUpdate` etc.), `hotUpdate`/`handleHotUpdate` hooks.
- Edit outcome classification: update / full reload / server restart / build rerun / environment invalidation / artifact change / error / no Vite reaction.
- Timeline event list with stack traces on failure. Exact on-disk file format unspecified.

## 4. RUNTIME ROUTES (runtime-routes.md)

- Plugin serves `/__gumbox` from dev middleware: UI, state gallery, box metadata, execution endpoints, environment metadata, local-only receipt APIs, timeline playback. Dev-port only.
- Preview: `/__gumbox` only on local preview port; never in production output. State previews point at real app URLs.
- Open security questions: reject remote hosts by default, local token, hide receipt dirs.

## 5. MVP BOUNDARY

- MVP center (product-direction.md anti-drift): real app routes via browser-capable env, state gallery on real routes, SSR requests, project/config edits, environment events, HMR/no-reload evidence, build+preview evidence, receipts + timeline playback.
- NOT MVP: Storybook CSF/args/controls, component mounting, network/state adapters, mocking, locators-first API, `init`/`migrate`.
- Fixture tension: product-direction.md "manual fixture registration acceptable for first plugin foundation" vs scenarios-and-receipts.md "happy path should be discovering `*.box.ts(x)` files" for MVP.
- Wedge tension: box-authoring.md "first HMR/config receipt MVP" vs cli.md's eight MVP commands.
- Open spec questions: default `browser` alias with multiple client-like envs; static vs runtime capability inference; whether `project.edit.config(...)` implies `serverRestarted`; config overlays in preview/build; raw browser access (`browser.page()`) in MVP.

## 6. CURRENT STATE GAP

- Stale intake snapshot: at T001 time, `src/index.ts` was only a no-op plugin
  shell and implementation coverage was effectively 0%.
- Current implementation coverage is tracked in `T016-spec-coverage.md`.
