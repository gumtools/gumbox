<p align="center">
  <img src="./gumbox.png" alt="Gumbox — prove changes faster, catch regressions early" width="820" />
</p>

# Gumbox

**See what your Vite pipeline is actually doing — and keep the receipts.**

You save a file and the page stays stale. You restart the dev server and now it works — this
time. It worked in dev, then 404'd in production. Every Vite developer knows the ritual:
restart, hard-refresh, `console.log`, pray 🙏.

Vite knew exactly what happened the whole time. It just never told you.

Gumbox makes it tell you. Describe what your pipeline should do, and Gumbox runs the real
thing — your config, your plugins, your environments — and proves what it actually did. Every
run writes a **receipt**: evidence you, CI, or an AI agent can act on.

> ⚠️ **Pre-release.** Gumbox is under active development and not yet published to npm. The API
> follows the [specs](./specs/README.md), which are the product truth — some pieces are still
> landing.
>
> This project is designed by Jack, implemented by **Mythos**, with **Codex** serving as its reviewer.

## A box in 30 seconds

A **box** is a small file that runs inside your real Vite pipeline and asserts what the
pipeline did, in the pipeline's own vocabulary:

```ts
import { box } from 'gumbox';

export default box('message updates without reload', async ({ browser, project, expect }) => {
	// Visit a real route — this auto-starts your real Vite dev server.
	const page = await browser.visit('/demo');

	// Edit a real source file, like a developer saving in their editor.
	const change = await project.edit('src/message.ts', {
		replace: ['before', 'after'],
	});

	// Declare what Vite should have done about it.
	await expect.edit(change, {
		client: { hmr: 'accepted' }, // hot update applied, no full reload
	});

	// Confirm the browser actually shows the new text.
	await expect.page.text(page, '#message', 'after');
});
```

```sh
gumbox hmr
```

Gumbox runs the box, restores the edited file, and writes a receipt to `.gumbox/receipts/` —
pass or fail, human- and machine-readable. If the box fails, the receipt explains _why_ in
Vite's own terms: what payload Vite sent, whether the server restarted, what the console said.

## What a box can prove

- A route renders with every asset loaded and a clean console
- An edit hot-updated, full-reloaded, or silently did nothing — per environment
- A server-only edit left the browser alone
- A config edit restarted the server with the new plugin active
- SSR renders and hydrates without console errors
- The **built** app behaves like dev (build + preview parity)
- Artifacts are right — manifest entries, no stale placeholders, no `node:fs` in worker bundles
- A workflow stayed inside a performance budget

Each of these is a copy-paste recipe in the [guide](./docs/guide.md#recipes).

## Why not Vitest / Playwright / Storybook?

They're great at what they own — but they see the **page**, not the **pipeline** that produced
it. That gap is how "all tests pass" and "the app is broken" happen at the same time. Gumbox
owns the pipeline: the chain from an edit to a Vite environment event to what you see, with a
receipt preserving the whole story.

## Docs

- **[Guide](./docs/guide.md)** — quick start, the box API, recipes, the CLI, and receipts
- **[Specs](./specs/README.md)** — product direction and the source of truth

## Status

Built in slices. Box authoring, dev/build/preview runs, browser evidence, the CLI, and JSON
receipts work today. The state-gallery UI, generated types, and receipt replay are coming —
full list in the [guide](./docs/guide.md#what-works-today).

## Contributing

The workspace runs on **Deno** (the library itself is runtime-agnostic — it runs wherever Vite
runs):

```sh
deno install        # install dependencies
deno task test      # run the test suite (drives real Vite pipelines)
deno task check     # format check + lint + typecheck
```

Start with [`specs/`](./specs/README.md) for intent, and `.claude/rules/` for the working
agreements.
