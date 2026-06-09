# Product Direction

## Positioning

Gumbox is the Vite Environment API-first QA receipt tool.

It is not "better Vitest", a Storybook clone, or a generic browser automation
runner. It lives in QA and test territory, but the thing it proves is different:
the user's real Vite pipeline.

The short product rule:

> A box runs the user's Vite pipeline, exercises named Vite environments, and
> emits a receipt for what happened.

The user-facing product should also make visible UI states easy to browse:

> A Gumbox state is a real app route or environment state, shown through the
> user's Vite pipeline, with a receipt attached.

The authoring model should follow Vite 8:

```ts
box('message updates without reload', async ({ browser, project, expect }) => {
	const page = await browser.visit('/demo');

	const change = await project.edit('src/message.ts', {
		replace: ['before', 'after'],
	});

	await expect.browser.hotUpdate(change);
	await expect.browser.noFullReload(change);
	await expect.page.text(page, '#message', 'after');
});
```

`browser` is only an alias. The source of truth is:

```ts
environment.<name>
expect.environment.<name>
```

Those names come from the user's resolved Vite environments.

## What Gumbox Proves

Gumbox should prove Vite pipeline behavior that existing UI/browser tools do not
make first-class:

- dev server startup, restart, config reloads, and env-file changes
- named Vite environments from `resolvedConfig.environments`
- client/browser environment HMR, full reloads, and module invalidation
- SSR/server environment requests, imports, invalidation, and isolation
- custom environments such as `rsc`, `edge`, `worker`, or framework-specific
  environments when the project defines them
- plugin hooks, transform evidence, middleware, virtual modules, and errors
- Vite 8 `hotUpdate` evidence and compatibility with older `handleHotUpdate`
  plugins where needed
- build orchestration through Vite 8 `createBuilder(...)` when appropriate
- local preview behavior through Vite `preview(...)`
- dev/build/preview parity
- resolver, alias, workspace, symlink, and module identity behavior
- CSS, HTML, asset, source map, and public path behavior
- optimizer and dependency handling behavior
- generated files and build artifacts
- build hook output integrity and chunk/module graph evidence
- local performance evidence such as request count, reload time, and module
  invalidation breadth
- browser-visible evidence only as part of a Vite environment receipt

The output is not only pass/fail. The output is a receipt that explains the
causal chain:

```text
project edit -> Vite environment event -> browser/SSR/build/artifact result
```

## Canonical QA Use Cases

HMR is a strong first demo, but it is not enough to define the product. The
broader Gumbox wedge is Vite pipeline QA.

Use cases that should shape the MVP and early roadmap:

- **Route receipt:** visit a real app route through the default browser
  environment and capture page, console, network, server, config, and environment
  evidence.
- **Visual UI state gallery:** browse named UI states from `*.box.ts(x)` files,
  preview the real app route, and open the receipt that proves how the state was
  produced.
- **Environment isolation:** prove that a change invalidates the intended Vite
  environment and does not poison unrelated environments.
- **HMR and reload behavior:** prove whether a saved source edit caused a hot
  update, full reload, stale page, overlay, or no Vite reaction.
- **Config and env reload behavior:** edit `vite.config.*`, config dependencies,
  or env files and prove whether Vite restarted or reloaded the expected
  pipeline state.
- **Dev/build/preview parity:** run dev, build, and local preview through Vite
  and compare route output, runtime errors, CSS, HTML, assets, and generated
  files.
- **SSR and server runtimes:** request or import from SSR, edge, worker, RSC, or
  other named environments and verify transforms, externals, runtime errors, and
  hydration evidence.
- **Resolver and module identity:** prove how aliases, tsconfig paths, workspace
  symlinks, virtual modules, URL queries, and cross-platform paths resolve in
  dev and build.
- **CSS and asset pipeline:** verify style injection, CSS modules, sourcemaps,
  `?url` assets, public paths, and visual/runtime differences between dev and
  preview.
- **Plugin hook and artifact integrity:** verify hook order, transform output,
  emitted chunks/assets, manifests, write hooks, and whether on-disk artifacts
  match the plugin evidence.
- **Performance receipts:** record request counts, reload time, invalidated
  modules, transform time, and build timing for a known workflow, especially for
  large apps or monorepos.
- **Agent/refactor oracle:** give Codex, Claude Code, CI, and humans a
  machine-readable receipt that proves whether the actual Vite pipeline still
  works after a refactor.

These use cases keep Gumbox away from generic browser testing while giving it
more than one sharp value case. The question is not only "did the UI render?"
or "did HMR work?" It is:

```text
Did the user's actual Vite pipeline produce the right observable result, and can
the receipt explain the chain of Vite events that led there?
```

## Agent Verification Oracle

Gumbox should be useful for human QA, but it should also be designed as an
oracle for AI-assisted refactor loops.

The tooling gap is not that agents cannot write code. The gap is that agents
often cannot prove the real pipeline still works across a Vite monorepo,
framework runtime, deployment target, or desktop shell. Unit tests and API
surface tests are necessary, but they can miss the production problem:

```text
The code compiles, but the actual Vite/Nitro/Qwik/Cloudflare/Electron pipeline
does not run.
```

Gumbox receipts should reduce both failure modes:

- **False positive:** the agent reports success because typecheck/unit tests pass,
  but Vite dev, HMR, SSR, build, preview, or runtime output is broken.
- **False negative:** the agent cannot prove the pipeline works, so it adds
  unnecessary adapters, config, mocks, or fallback code to work around an
  unverified assumption.

For large refactors, Gumbox should act as the pipeline acceptance check:

```text
refactor -> run boxes -> inspect receipt -> continue or revert/simplify
```

Example target cases:

- move Node-only assumptions out of a router/runtime package
- prove a Qwik route works in dev, build, and a Cloudflare-like preview
- compare Miniflare-like and workerd-like runtime behavior
- prove an Electron Chromium route and a dashboard route share UI while using
  different data boundaries
- verify HMR still works after a plugin or adapter rewrite
- show that an agent-added config/plugin/adapter was unnecessary because the
  real pipeline already passed

Receipts should be both human-readable and machine-readable. An agent should be
able to consume a receipt and know:

- command, box, route, environment, mode, and runtime target
- what source/config/env files changed
- whether Vite restarted, hot updated, reloaded, errored, or did nothing
- what browser/server/build/artifact evidence failed
- which plugin, module, generated file, or runtime error is implicated
- whether the next action should be "fix the pipeline" or "remove unnecessary
  workaround code"

This is where Gumbox is more than a state gallery. It becomes the verification
surface that lets agents safely work on Vite-heavy codebases without constant
manual pipeline QA.

## Visual State Gallery

Seeing UI states is first-class Gumbox behavior.

The distinction from Storybook is that Gumbox does not render stories inside a
separate documentation app. A visual state is a box that reaches a visible state
through the user's Vite app:

```text
state setup -> real Vite route/environment -> visible UI -> receipt
```

Common UI states should feel simple:

```ts
box('empty cart', async ({ browser, expect, receipt }) => {
	const page = await browser.visit('/cart?state=empty');

	await expect.page.text(page, '[data-cart-count]', '0');
	await receipt.capture('empty cart');
});
```

The Gumbox UI should list these boxes as a state gallery with:

- state name, tags, source file, and route
- live or captured preview from the real app route
- screenshot, DOM, console, network, and server evidence
- environment name and browser alias target
- latest pass/fail status and receipt path
- timeline of Vite events that produced the state

State setup may come from:

- app-owned routes, query params, or dev-only state endpoints
- project edits to app data files or fixtures
- config/env overlays when the state is pipeline-dependent
- framework adapters that can expose routes or seed app state
- future secondary network/state adapters

State setup should not require a Storybook args model. The first happy path is
"visit the real route and capture a receipt."

## Environment Model

`environment.<name>` is generated from the user's resolved Vite config.

For a basic app this will usually expose:

```ts
environment.client;
environment.ssr;
```

For framework or plugin projects it may expose more:

```ts
environment.rsc;
environment.edge;
environment.worker;
```

The default browser/client environment receives an ergonomic alias:

```ts
browser === environment.client;
expect.browser === expect.environment.client;
```

If a project uses a different name for its browser-capable environment, Gumbox
should resolve `browser` to that configured default and show the alias target in
the receipt.

Capabilities are environment-specific:

- browser-capable environments may expose `visit(path)`
- fetchable/server environments may expose `request(path)`
- runnable environments may expose `import(id)`
- build environments contribute build and artifact evidence

Gumbox should not pretend every environment supports every operation. The type
model should autocomplete only known capabilities when possible, while still
allowing string fallbacks for dynamic projects.

## Differentiation

| Tool                | Primary object               | What it proves                                                                 |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Storybook           | Component stories            | UI states render in an isolated catalog                                        |
| Vitest Browser Mode | Browser-run test modules     | Test modules pass in a Vitest-controlled browser runner                        |
| Playwright          | Browser automation           | User flows work across pages and browsers                                      |
| Gumbox              | Real app states and receipts | The user's Vite dev, environment, HMR, SSR, build, preview, and artifact chain |

Vitest Browser Mode has real overlap around rendering, DOM assertions, browser
sessions, traces, screenshots, and future network mocking. Gumbox should not
compete there.

The non-overlap is Vite pipeline causality:

```text
edit src/message.ts
-> environment.client hot updated
-> environment.ssr did not invalidate
-> browser route changed without full reload
-> receipt preserved the Vite event chain
```

That is Gumbox territory.

## Vite Pipeline Ownership

Gumbox must use the user's Vite pipeline, not recreate one.

Expected implementation direction:

- load the user's existing `vite.config.*`
- inject Gumbox instrumentation only for the current run
- use Vite `createServer(...)` for dev
- use Vite 8 `server.environments` for dev environment evidence
- use Vite 8 `createBuilder(...)` for build and multi-environment validation
- use Vite `preview(...)` for local built-output validation
- record Vite plugin hooks, module graphs, HMR payloads, config dependencies,
  env files, middleware, virtual modules, and artifacts

Gumbox should not manually bundle, manually emulate HMR, or run the app inside a
special browser-only test environment.

## Anti-Drift Guardrails

### Not Storybook

Gumbox may show UI states, but those states are evidence from the user's app
pipeline. If a feature only catalogs components in a separate documentation app,
it belongs outside the MVP.

First-class:

- real app routes visited through a browser-capable Vite environment
- visual state gallery backed by real app routes and receipts
- SSR/server environment requests
- project edits and config edits
- Vite environment events
- HMR/no-reload evidence
- build and preview evidence
- receipts and timeline playback

Not the MVP center:

- component library documentation
- generic controls panels
- standalone component stories with no pipeline proof
- Storybook CSF, args, decorators, or synthetic story runtime as the core model
- a separate app that exists only to render examples

### Not Vitest Browser Mode

Gumbox may use a browser internally, but its public API should not become a
browser test runner.

Avoid centering:

- component mounting
- locators as the primary abstraction
- test module isolation
- snapshot/visual regression as the main value
- network mocking as the main value
- a Vitest-style browser session lifecycle

Own instead:

- environment-specific Vite evidence
- project edit causality
- config reload/restart proof
- SSR/client environment isolation
- dev/build/preview parity
- artifact receipts

## Project Edits As Causality

Saved project edits are first-class receipt events.

The core workflow is:

```ts
const page = await browser.visit('/demo');

const change = await project.edit('src/message.ts', {
	replace: ['before', 'after'],
});

await expect.browser.hotUpdate(change);
await expect.browser.noFullReload(change);
await expect.page.text(page, '#message', 'after');
```

Config edits are equally important:

```ts
const change = await project.edit.config({
	replace: ['oldPlugin()', 'newPlugin()'],
});

await expect.pipeline.serverRestarted(change);
await expect.environment.client.plugin('new-plugin');
```

Gumbox should correlate each edit with environment events:

- update
- full reload
- module invalidation
- plugin hook invocation
- server restart
- config reload
- error
- no Vite reaction

## 10/10 Wedge

The most valuable Gumbox explains why a QA state passed or failed.

Example failure:

```text
Expected browser HMR update without reload.
Visited route: /demo
Environment: client
File changed: src/message.ts
Observed Vite payload: full-reload
Triggered by plugin: qwik-bundler-dev
SSR environment invalidated: false
Browser reloaded before DOM reached expected state.
Receipt written: .gumbox/receipts/...
```

This is the gap between browser automation and Vite internals. Playwright can
observe the page. Vitest Browser Mode can execute browser tests. Gumbox should
connect the page, SSR/build output, and artifacts back to the Vite environment
event chain.

## Typed Authoring From Vite Config

Gumbox should make boxes feel like they are authored inside the user's Vite
project.

The CLI/plugin should load the resolved Vite config and generate a project type
model. Known values should autocomplete:

- Vite environment names
- default browser environment alias target
- root-relative files for `project.edit(...)`
- active config file and config dependencies for `project.edit.config(...)`
- plugin names for environment assertions
- build output and manifest paths
- modes, base, env prefix, aliases, server/preview facts
- route surfaces when a framework integration can discover them

Unknown values should still be accepted. Autocomplete is a DX layer over known
Vite evidence, not a restriction.

## Manual Fixture DX

Manual fixture registration is acceptable for the first plugin foundation, but
it should not be the long-term primary DX.

Preferred direction:

- discover boxes from `*.box.ts` and `*.box.tsx`
- discover Vite environments from the resolved config
- allow explicit registration for edge cases
- make box execution reproducible from the CLI and UI
- keep setup close to the app/workflow being verified

Manual fixtures should become an escape hatch, not the default happy path.
