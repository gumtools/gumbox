# Box Authoring

## Principle

The authoring API must be Vite Environment API-first.

Gumbox may use browsers, Playwright, or framework adapters internally, but the
public model should not be a thin browser test wrapper. The public model should
read like:

```text
project files + Vite config -> Vite environments -> project edits -> environment evidence -> receipt
```

The source of truth is the user's resolved Vite config and its environments.

## File Shape

Preferred files:

```text
*.box.ts
*.box.tsx
```

Recommended export:

```ts
import { box } from 'gumbox';

export default box('message updates without reload', async ({ browser, project, expect }) => {
	const page = await browser.visit('/demo');

	const change = await project.edit('src/message.ts', {
		replace: ['before', 'after'],
	});

	await expect.browser.hotUpdate(change);
	await expect.browser.noFullReload(change);
	await expect.page.text(page, '#message', 'after');
});
```

Named exports are allowed when one file naturally contains related pipeline
states:

```ts
import { box } from 'gumbox';

export const Hmr = box('message hmr', async ({ browser, project, expect }) => {
	const page = await browser.visit('/demo');
	const change = await project.edit('src/message.ts', {
		replace: ['before', 'after'],
	});

	await expect.browser.hotUpdate(change);
	await expect.page.text(page, '#message', 'after');
});

export const Preview = box('dashboard preview', async ({ pipeline, expect }) => {
	const build = await pipeline.build();
	const preview = await pipeline.preview(build);

	const page = await preview.browser.visit('/dashboard');
	await expect.page.text(page, 'h1', 'Dashboard');
});
```

Named exports should not become Storybook-style args. They should represent
related Vite pipeline states or QA workflows.

## `box(...)`

`box` is the project primitive. It defines a Vite pipeline recipe and the
receipt Gumbox should produce.

A visible UI state is also a `box`. Gumbox should not add a separate Storybook
story primitive. The UI can treat boxes that visit browser-capable environments
as state-gallery entries.

Recommended overloads:

```ts
box(name, run);
box(options, run);
```

Option sketch:

```ts
type BoxOptions = {
	name: string;
	tags?: string[];
	modes?: Array<'dev' | 'build' | 'preview' | (string & {})>;
	ui?: boolean;
};
```

Examples:

```ts
box('hmr updates without reload', async (ctx) => {
	// Vite environments, project edits, assertions, and receipt checkpoints.
});

box('empty cart', async ({ browser, expect, receipt }) => {
	const page = await browser.visit('/cart?state=empty');

	await expect.page.text(page, '[data-cart-count]', '0');
	await receipt.capture('empty cart');
});

box(
	{
		name: 'preview build visits dashboard',
		tags: ['preview', 'build'],
		modes: ['preview'],
	},
	async (ctx) => {
		// Build/preview pipeline.
	},
);
```

Optional metadata should be small and receipt-oriented, not Storybook args:

```ts
box(
	{
		name: 'empty cart',
		tags: ['ui', 'cart'],
		ui: true,
	},
	async ({ browser, expect, receipt }) => {
		const page = await browser.visit('/cart?state=empty');

		await expect.page.text(page, '[data-cart-count]', '0');
		await receipt.capture('empty cart');
	},
);
```

`ui: true` means "show this box in the state gallery." It should not imply a
component renderer, controls panel, args object, or synthetic route.

## Context

The callback receives a narrow Vite-centered API:

```ts
type BoxContext = {
	environment: EnvironmentApi;
	browser: BrowserEnvironmentAlias;
	project: ProjectApi;
	pipeline: PipelineApi;
	expect: ExpectApi;
	receipt: ReceiptApi;
};
```

No top-level `visit`, `ssr`, `http`, `edit`, or generic `page` object should be
part of the core context.

## UI State Boxes

UI state boxes are the visual state-browsing surface.

They should use the same API as pipeline boxes:

```ts
import { box } from 'gumbox';

export default box('empty cart', async ({ browser, expect, receipt }) => {
	const page = await browser.visit('/cart?state=empty');

	await expect.page.text(page, '[data-cart-count]', '0');
	await receipt.capture('empty cart');
});
```

The state gallery should show this box as a visual state because it visited a
browser-capable environment and captured page evidence.

UI state setup may come from the app itself:

```ts
const page = await browser.visit('/checkout?payment=failed');
```

Or from project edits when the state exists in local app data:

```ts
const change = await project.edit('src/dev/cart-state.json', {
	replace: ['"items": 3', '"items": 0'],
});

const page = await browser.visit('/cart');

await expect.browser.hotUpdate(change);
await expect.page.text(page, '[data-cart-count]', '0');
```

This keeps the UX close to Storybook's useful part, browsing named UI states,
without inheriting Storybook's separate story runtime.

UI state boxes should avoid:

- Storybook CSF exports
- args/controls as the primary state model
- component rendering as the happy path
- synthetic `/__gumbox/story/...` app routes as the state surface
- generic browser or network mocking as the core setup model

The primary state surface remains:

```text
real app route through a browser-capable Vite environment
```

## Environment API

`environment.<name>` is generated from the user's resolved Vite environments.

For a simple app:

```ts
environment.client;
environment.ssr;
```

For a framework or plugin app:

```ts
environment.rsc;
environment.edge;
environment.worker;
```

The environment names come from Vite, not from Gumbox. Gumbox should derive them
from `resolvedConfig.environments`, `server.environments`, and
`builder.environments`.

Each environment exposes only capabilities it can actually support:

```ts
await environment.client.visit('/demo');
await environment.ssr.request('/demo');
await environment.rsc.import('/src/entry.rsc.ts');
```

Expected capabilities:

- `visit(path)` for browser-capable environments
- `request(path)` for fetchable/server environments
- `import(id)` for runnable environments
- receipt evidence for transforms, module graph invalidation, plugin hooks,
  HMR payloads, errors, and environment lifecycle

The type model should autocomplete known environment names and capabilities
without blocking dynamic projects.

## Browser Alias

`browser` is an ergonomic alias for the default browser/client environment.

In a normal Vite app:

```ts
browser === environment.client;
expect.browser === expect.environment.client;
```

If the project names its browser-capable environment differently, Gumbox should
resolve `browser` to that environment and record the alias target in the
receipt.

Good common-path API:

```ts
const page = await browser.visit('/demo');
```

Equivalent explicit API:

```ts
const page = await environment.client.visit('/demo');
```

`browser` should not become a generic browser-control bucket. It should not own
core APIs like `browser.storage`, `browser.http`, or arbitrary network mocking.
Those may exist later as adapters or escape hatches, but the MVP meaning of
`browser` is:

```text
the project's default browser-capable Vite environment
```

## Project API

`project` owns project files and reversible edits.

The API should model developer edits, not low-level patch plumbing. Most Vite QA
scripts ask:

```text
When this project edit is saved, what does Vite do?
```

Preferred shape:

```ts
const change = await project.edit('src/message.ts', {
	replace: ['before', 'after'],
});

await expect.browser.hotUpdate(change);
await expect.browser.noFullReload(change);
```

Config edits should be just as direct:

```ts
const change = await project.edit.config({
	replace: ['oldPlugin()', 'newPlugin()'],
});

await expect.pipeline.serverRestarted(change);
```

Core operations:

```ts
await project.edit('src/message.ts', { replace: ['before', 'after'] });
await project.edit('src/message.ts', (code) => code.replace('before', 'after'));
await project.edit.create('src/new-style.css', '.message { color: green; }');
await project.edit.remove('src/old-style.css');
await project.edit.copy('src/message.ts', 'edits/message.after.ts');
await project.edit.config({ replace: ['oldPlugin()', 'newPlugin()'] });
await project.read('dist/manifest.json');
await project.exists('dist/client/index.html');
```

Recommended type shape:

```ts
type ProjectApi = {
	edit: EditApi;
	read(path: Known<ProjectTypes['files']>): Promise<string>;
	exists(path: Known<ProjectTypes['files']>): Promise<boolean>;
};

type EditApi = {
	(path: Known<ProjectTypes['files']>, change: EditChange): Promise<EditReceipt>;
	(
		label: string,
		changes: Partial<Record<Known<ProjectTypes['files']>, EditChange>>,
	): Promise<EditReceipt>;
	create(path: Known<ProjectTypes['files']>, contents: string): Promise<EditReceipt>;
	remove(path: Known<ProjectTypes['files']>): Promise<EditReceipt>;
	copy(
		path: Known<ProjectTypes['files']>,
		from: Known<ProjectTypes['files']>,
	): Promise<EditReceipt>;
	config(change: EditChange): Promise<EditReceipt>;
};

type EditChange =
	| { replace: [from: string | RegExp, to: string] }
	| ((code: string) => string)
	| { create: string }
	| { remove: true }
	| { copyFrom: string };
```

Edit behavior:

- edit files relative to the Vite project root
- attach Vite/environment observation before writing to disk
- write files with editor-like semantics that trigger real watcher events
- record before/after diff metadata in the receipt
- restore files after the box finishes
- mark the receipt if restoration fails
- allow edits before server start, during dev, or between build and preview
- correlate environment HMR, invalidation, reload, restart, console, page, and
  artifact events to the edit that caused them

Avoid happy-path APIs such as `project.file(...).replace(...)` or
`project.config().replace(...)`. They add ceremony without making the causal
question clearer.

## Pipeline API

`pipeline` controls dev/build/preview lifecycle when a box needs explicit
control.

Gumbox may auto-start or attach to a dev server for simple `browser.visit(...)`
boxes, but explicit pipeline operations should be available:

```ts
await pipeline.dev();
const build = await pipeline.build();
const preview = await pipeline.preview(build);
```

Implementation expectations:

- `pipeline.dev()` uses Vite `createServer(...)`
- dev environment evidence comes from Vite `server.environments`
- `pipeline.build()` uses Vite 8 `createBuilder(...)` when appropriate and
  falls back only for compatibility/simple cases
- build evidence comes from `builder.environments`
- `pipeline.preview()` uses Vite `preview(...)`

Calling `pipeline.build()` does not mean Gumbox manually builds anything. It
means "ask Vite to run the user's build pipeline and preserve the evidence."

Optional config overlays should be possible without editing files:

```ts
await pipeline.dev({
	config(config) {
		return {
			...config,
			define: {
				...config.define,
				__GUMBOX_VARIANT__: JSON.stringify('debug'),
			},
		};
	},
});
```

Use `project.edit.config(...)` when the box specifically needs to prove a
config-file edit or restart.

## Expect API

Gumbox should expose one assertion object: `expect`.

Do not split proving across `should` options on edits, `assert.dom`,
`assert.vite`, and ad hoc assertion helpers. Do not make callable
`expect(subject)` the main style. Object namespaces are easier to autocomplete
and easier for AI agents to generate consistently.

Recommended namespaces:

- `expect.browser.*`
- `expect.environment.<name>.*`
- `expect.pipeline.*`
- `expect.page.*`
- `expect.build.*`
- `expect.artifact.*`
- `expect.html.*`
- `expect.performance.*`

Rejected core namespaces:

- `expect.edit.*`
- `expect.vite.*`
- `expect.view.*`

Edit outcomes should be asserted against the environment that reacted:

```ts
const page = await browser.visit('/demo');
const change = await project.edit('src/message.ts', {
	replace: ['before', 'after'],
});

await expect.browser.hotUpdate(change);
await expect.browser.noFullReload(change);
await expect.browser.invalidated(change, '/src/message.ts');
await expect.page.text(page, '#message', 'after');
```

Custom environment assertions should stay explicit:

```ts
await environment.rsc.import('/src/entry.rsc.ts');

const change = await project.edit('src/server-only.ts', {
	replace: ['before', 'after'],
});

await expect.environment.rsc.invalidated(change);
await expect.environment.client.notInvalidated(change);
```

Config and pipeline assertions:

```ts
const change = await project.edit.config({
	replace: ['debugPlugin(false)', 'debugPlugin(true)'],
});

await expect.pipeline.serverRestarted(change);
await expect.environment.client.plugin('debug-plugin');
```

Build and artifact assertions:

```ts
const build = await pipeline.build();
const manifest = await build.artifact('dist/client/.vite/manifest.json');

await expect.build.environment(build, 'client');
await expect.build.artifact(build, 'dist/client/index.html');
await expect.artifact.json(manifest, (json) => Object.keys(json).length > 0);
```

Advanced users may still use an escape hatch for custom evidence checks:

```ts
await expect.environment.client.satisfies(change, (evidence) => {
	return evidence.error?.plugin === 'debug-plugin';
});
```

`satisfies(...)` should be documented as advanced and should not appear in first
examples.

## Environment Evidence Model

Each project edit should produce a normalized receipt model per environment.

Sketch:

```ts
type EnvironmentEditOutcome = {
	name: string;
	kind: 'browser' | 'server' | 'worker' | 'custom';
	update: boolean;
	fullReload: boolean;
	restart: boolean;
	error: null | ViteErrorEvidence;
	invalidated: ViteModuleEvidence[];
	updates: ViteUpdateEvidence[];
	plugins: VitePluginEvidence[];
};
```

The receipt should preserve low-level Vite details:

- websocket payloads: `update`, `full-reload`, `custom`, `error`
- client events: `vite:beforeUpdate`, `vite:afterUpdate`,
  `vite:beforeFullReload`, `vite:invalidate`, `vite:error`
- `hotUpdate` and compatibility `handleHotUpdate` plugin hooks
- module graph invalidation and accepted HMR boundaries
- plugin names, order, transforms, middleware, and virtual modules
- config dependency and env-file restart triggers
- dev/build/preview lifecycle facts

The author should normally write the outcome they expect, not the raw event
transport:

```ts
await expect.browser.hotUpdate(change);
await expect.browser.noFullReload(change);
```

## Typed Project Model

Gumbox should provide typed autocomplete from the user's resolved Vite config.

This requires a generated ambient type file. TypeScript cannot infer
runtime-resolved Vite facts from arbitrary `vite.config.*` code without running
Gumbox.

Example:

```ts
declare module 'gumbox' {
	interface GumboxProjectTypes {
		environments: 'client' | 'ssr' | 'rsc';
		browserEnvironment: 'client';
		files: 'src/App.tsx' | 'src/message.ts' | 'vite.config.ts';
		configFiles: 'vite.config.ts';
		artifacts: 'dist/index.html' | 'dist/.vite/manifest.json';
		routes: '/' | '/demo';
		plugins: 'vite:react-babel' | 'debug-plugin';
		modes: 'development' | 'production';
		env: 'VITE_API_URL';
	}
}
```

Use permissive literal unions:

```ts
type Known<T extends string> = T | (string & {});
```

Known values should come from:

- `resolvedConfig.environments`
- `server.environments` and `builder.environments` when available
- `resolvedConfig.root`, `configFile`, `configFileDependencies`, `envDir`, and
  `envPrefix`
- `resolvedConfig.plugins[].name`
- aliases, base, mode, command, server, preview, and build output settings
- discovered project files under the Vite root, respecting Vite filesystem
  allow/deny behavior
- build output conventions such as `outDir`, `assetsDir`, and manifest paths
- framework integrations that can expose route manifests

When a source is unavailable, the related API should gracefully fall back to
plain `string`.

## Examples

### Simple Route Visit

```ts
import { box } from 'gumbox';

export default box('dashboard route works', async ({ browser, expect, receipt }) => {
	const page = await browser.visit('/dashboard');

	await expect.page.text(page, 'h1', 'Dashboard');
	await receipt.capture('dashboard visited');
});
```

This is valid even without a source edit. The receipt should still include Vite
config, environment name, server URL, route, DOM, screenshot, console, and
network evidence.

### HMR

```ts
import { box } from 'gumbox';

export default box('message updates without reload', async ({ browser, project, expect }) => {
	const page = await browser.visit('/demo');

	const change = await project.edit('src/message.ts', {
		replace: ['before', 'after'],
	});

	await expect.browser.hotUpdate(change);
	await expect.browser.noFullReload(change);
	await expect.page.text(page, '#message', 'after');
});
```

The API should express the real question:

```text
Did this saved file change update the browser environment without a full reload?
```

### SSR Environment

```ts
import { box } from 'gumbox';

export default box('home SSR hydrates cleanly', async ({ environment, browser, expect }) => {
	const html = await environment.ssr.request('/');
	await expect.html.contains(html, '<main');

	const page = await browser.visit('/');
	await expect.page.visible(page, 'main');
	await expect.page.cleanConsole(page);
});
```

### Environment Isolation

```ts
import { box } from 'gumbox';

export default box(
	'server edit does not reload browser',
	async ({ environment, project, expect }) => {
		await environment.ssr.request('/dashboard');

		const change = await project.edit('src/server-only.ts', {
			replace: ['before', 'after'],
		});

		await expect.environment.ssr.invalidated(change);
		await expect.environment.client.notInvalidated(change);
		await expect.environment.client.noFullReload(change);
	},
);
```

### Config Change

```ts
import { box } from 'gumbox';

export default box(
	'vite config change reloads the plugin pipeline',
	async ({ browser, project, expect }) => {
		await browser.visit('/demo');

		const change = await project.edit.config({
			replace: ['debugPlugin({ enabled: false })', 'debugPlugin({ enabled: true })'],
		});

		await expect.pipeline.serverRestarted(change);
		await expect.environment.client.plugin('debug-plugin');

		const page = await browser.visit('/demo');
		await expect.page.exists(page, '[data-debug-plugin]');
	},
);
```

This is not naturally expressed as a Playwright-style `page` callback. It is a
Vite lifecycle box.

### Build And Preview

```ts
import { box } from 'gumbox';

export default box('built app visits dashboard', async ({ pipeline, expect }) => {
	const build = await pipeline.build();
	const manifest = await build.artifact('dist/client/.vite/manifest.json');

	await expect.build.artifact(build, 'dist/client/index.html');
	await expect.artifact.json(manifest, (json) => Object.keys(json).length > 0);

	const preview = await pipeline.preview(build);
	const page = await preview.browser.visit('/dashboard');

	await expect.page.text(page, 'h1', 'Dashboard');
});
```

Preview routes must stay local to the preview run.

### CSS And Asset Parity

```ts
import { box } from 'gumbox';

export default box('css module matches dev and preview', async ({ browser, pipeline, expect }) => {
	const devPage = await browser.visit('/styles');
	await expect.page.computedStyle(devPage, '#target', {
		color: 'rgb(0, 128, 0)',
	});

	const build = await pipeline.build();
	await expect.build.artifact(build, 'dist/client/index.html');

	const preview = await pipeline.preview(build);
	const previewPage = await preview.browser.visit('/styles');
	await expect.page.computedStyle(previewPage, '#target', {
		color: 'rgb(0, 128, 0)',
	});
	await expect.artifact.exists(build, 'dist/client/assets');
});
```

The question is:

```text
Did Vite transform, emit, and serve CSS/assets consistently in dev and preview?
```

### Resolver And Module Identity

```ts
import { box } from 'gumbox';

export default box(
	'workspace edit invalidates one module identity',
	async ({ browser, project, expect }) => {
		await browser.visit('/workspace-package');

		const change = await project.edit('packages/ui/src/message.ts', {
			replace: ['before', 'after'],
		});

		await expect.browser.hotUpdate(change);
		await expect.environment.client.singleModuleIdentity(change, {
			file: 'packages/ui/src/message.ts',
		});
		await expect.environment.client.noDuplicateModules(change);
	},
);
```

The question is:

```text
Did aliases, symlinks, and platform paths resolve to the intended Vite module?
```

### Plugin Hook And Artifact Integrity

```ts
import { box } from 'gumbox';

export default box('server manifest placeholder is replaced', async ({ pipeline, expect }) => {
	const build = await pipeline.build();

	await expect.build.pluginHook(build, 'manifest-plugin', 'writeBundle');
	await expect.artifact.text(build, 'dist/server/entry.js', {
		notContains: '__VITE_ASSETS_MANIFEST__',
	});
	await expect.artifact.json(build, 'dist/client/.vite/manifest.json', (json) => {
		return Object.keys(json).length > 0;
	});
});
```

The question is:

```text
Did the Vite plugin hook evidence and the emitted build output agree?
```

### Runtime Refactor Oracle

```ts
import { box } from 'gumbox';

export default box('worker build has no node runtime assumptions', async ({ pipeline, expect }) => {
	const build = await pipeline.build();

	await expect.artifact.text(build, 'dist/worker/index.js', {
		notContains: 'node:fs',
	});
	await expect.artifact.text(build, 'dist/worker/index.js', {
		notContains: 'node:path',
	});
	await expect.artifact.text(build, 'dist/worker/index.js', {
		notContains: 'process.cwd',
	});

	const preview = await pipeline.preview(build);
	const page = await preview.browser.visit('/dashboard');

	await expect.page.cleanConsole(page);
	await expect.page.text(page, 'h1', 'Dashboard');
});
```

The question is:

```text
After the refactor, does the actual Vite build and local preview route still
work without Node-only runtime assumptions?
```

This is an agent oracle. It should let Codex or CI distinguish "typecheck
passed" from "the target Vite runtime pipeline actually works."

### Performance Receipt

```ts
import { box } from 'gumbox';

export default box('large route reload budget', async ({ browser, receipt, expect }) => {
	const page = await browser.visit('/large-app');

	const load = await receipt.measure('reload large route', async () => {
		await page.reload();
	});

	await expect.performance.lessThan(load, 'durationMs', 500);
	await expect.performance.lessThan(load, 'requestCount', 300);
});
```

The question is:

```text
Did this Vite workflow stay within a local QA budget, and can the receipt show why?
```

## Network And State Adapters

Network and state control can be useful, but it should not define the MVP
surface.

Do not make the core model:

```ts
await http.get('/api/cart').json({ items: [] });
await browser.storage.local.set('auth', 'customer');
await visit('/checkout');
```

Those APIs make Gumbox look like a browser/network mocking tool. Vitest Browser
Mode and Playwright already cover much of that territory.

Future adapters may exist, but they should attach to an environment or framework
integration and appear as secondary capabilities. The receipt must make clear
whether an adapter affected browser requests, SSR/server requests, or both.

## Component Mounting

Component mounting should not be a core primitive in the MVP.

Mounting may become an escape hatch for tiny Vite plugin fixtures,
difficult-to-reach UI states, or transform/HMR reproduction cases. If it exists,
it should be explicitly secondary to real app routes and environment evidence.

## Browser Escape Hatch

An advanced browser handle may exist for cases Gumbox does not model yet:

```ts
const page = await browser.page();
await page.getByRole('button', { name: 'Save' }).click();
```

This should be documented as an escape hatch. The main API should keep Vite
pipeline questions readable without requiring users to script the browser
directly.

## Receipt API

Receipts should be automatic by default and extensible when users want named
checkpoints.

```ts
await receipt.capture('initial state');
await receipt.capture('after config restart');
receipt.note('Verified debug plugin is active after config edit.');
```

Automatic receipt events should include:

- selected box file and export
- Vite config path and resolved config summary
- generated project type model hash and source facts
- environment names and browser alias target
- config overlays and config-file edits
- dev/build/preview lifecycle events
- server URL and preview URL
- route, page, or environment request surface
- screenshots and DOM/HTML snapshots
- console and network errors
- file edits and restoration status
- environment HMR, full reload, invalidation, and restart events
- plugin evidence when available
- artifact checks
- build and preview output facts
- local performance metrics and measurement labels
- assertion results
- machine-readable summary for `--json`, CI, and AI agents
- implicated files, routes, environments, plugin hooks, artifacts, and failure
  events when a box fails

## Rejected Shapes

### No Global `visit`

Route visits should happen through the environment that owns the browser route:

```ts
await browser.visit('/demo');
await environment.client.visit('/demo');
```

Not:

```ts
await visit('/demo');
```

### No `expect.edit`

Edits do not react; environments react to edits.

Use:

```ts
await expect.browser.hotUpdate(change);
await expect.environment.ssr.invalidated(change);
```

Not:

```ts
await expect.edit.hotUpdate(change);
```

### No `vite.client` / `vite.ssr`

Environment names come from Vite config:

```ts
await environment.client.visit('/demo');
await environment.ssr.request('/demo');
```

Not:

```ts
await vite.client.visit('/demo');
await vite.ssr.request('/demo');
```

### No Storybook CSF Center

Storybook's API is optimized for a component catalog:

```ts
export default meta;
export const Default = { args: {} };
```

Gumbox should center the Vite pipeline:

```ts
export default box('state name', async ({ browser, expect }) => {
	const page = await browser.visit('/demo');
	await expect.page.visible(page, 'body');
});
```

### No Playwright-First Test Files

Playwright is excellent browser automation, but Gumbox should not put `page` at
the center:

```ts
test('works', async ({ page }) => {
	await page.goto('/demo');
});
```

Gumbox puts project edits and environment evidence at the center:

```ts
box('config change works', async ({ browser, project, expect }) => {
	const change = await project.edit.config(replacePluginConfig);

	await expect.pipeline.serverRestarted(change);

	const page = await browser.visit('/demo');
	await expect.page.cleanConsole(page);
});
```

## Open Questions

- How should Gumbox choose the default `browser` alias when multiple client-like
  environments exist?
- Which Vite environment capabilities can be inferred statically, and which
  must be discovered at runtime?
- How much plugin causality can the MVP capture without Vite core changes?
- Should `project.edit.config(...)` imply `expect.pipeline.serverRestarted(...)`
  as a default expectation?
- Should config overlays be allowed in preview and build modes?
- Should raw browser access ship in MVP or wait until after the first
  HMR/config receipt MVP?
