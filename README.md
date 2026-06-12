<p align="center">
  <img src="./assets/gumbox.png" alt="Gumbox — prove changes faster, catch regressions early" width="820" />
</p>

# Gumbox

**See what your Vite pipeline actually did — with receipts.**

Restart, hard-refresh, `console.log`, pray 🙏 — Vite knew what happened the whole time, it
just never told you. Gumbox runs your real pipeline and writes a **receipt** for every run:
proof you, CI, or an AI agent can act on.

> ⚠️ **Pre-release** — not on npm yet; the [specs](./specs/README.md) are the product truth.
> Designed by Jack, implemented by **Mythos**, reviewed by **Codex**.

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

<p align="center">
  <img src="./assets/box-flow.svg" alt="you edit src/message.ts → your real Vite pipeline (dev server, HMR, SSR, build) → receipt.json: hmr accepted, 0 reloads" width="780" />
</p>

## What a box can prove

- A route renders with every asset loaded and a clean console
- An edit hot-updated, full-reloaded, or silently did nothing — per environment
- A server-only edit left the browser alone
- A config edit restarted the server with the new plugin active
- SSR renders and hydrates without console errors
- The **built** app behaves like dev (build + preview parity)
- Artifacts are right — manifest entries, no stale placeholders, no `node:fs` in worker bundles
- A workflow stayed inside a performance budget

## Every receipt has witnesses

Assertions only answer the questions you thought to ask. The interesting failures live in what
you didn't ask about — the console error that didn't break your selector, the request that
died while the page still rendered, the full reload that happened to land on the right text
anyway. Gumbox treats a box run like a case: the receipt is the case file, and everyone who
observed the run testifies in it.

Three witnesses watch every browser box from different vantage points. The **pipeline**
witness is Vite's server side — it knows what hot payloads were actually sent, whether the
server restarted, what each environment did with your edit. The **client** witness is the page
itself — its console, its uncaught errors, the custom events your framework fired. The
**driver** witness watches from outside the page over CDP — failed requests with their real
`net::ERR_*` reasons, navigations the page can't hide, the screenshots. None of them can see
what the others see, which is the point: they corroborate or contradict each other
independently.

Each witness gets a verdict on every box. When a box passes but a witness holds evidence
against the run, the pass is marked **contested**:

```
pass noisy page records console and network evidence  [pipeline+ client! driver!]  contested
     client reported: 1 console error   driver reported: 1 failed request
```

Every assertion passed here. The page also logged an error and a request died — facts no
assertion asked about, preserved instead of swallowed. That's the gap between "tests pass" and
"the app is fine", made visible on every run.

Cross-examine any box straight from a stored receipt:

```sh
gumbox evidence 'noisy page'
```

```
crimes reported (2):
  ! console error   Failed to load resource: net::ERR_ABORTED   — reported by client
  ! request failed  GET http://127.0.0.1:5173/missing.js        — reported by driver
```

Witness identity and verdicts are plain data in the receipt JSON — stable, greppable, safe for
CI and agents to consume. Color is just how your terminal paints them.

## Why not Vitest / Playwright / Storybook?

They're great at what they own — but they see the **page**, not the **pipeline** that produced
it. That gap is how "all tests pass" and "the app is broken" happen at the same time. Gumbox
owns the pipeline: the chain from an edit to a Vite environment event to what you see, with a
receipt preserving the whole story.

There's no automation framework underneath, either. Gumbox drives the browser itself over the
Chrome DevTools Protocol — a couple thousand lines of WebSocket and JSON it owns outright,
zero dependencies. One pooled browser serves the whole run and every box gets its own isolated
browser context, the same architecture playwright uses internally, which is how gumbox ended
up faster per test than playwright-core on every platform CI measures.

## Bring your own browser

Gumbox drives a Chromium-family browser already on your machine over the Chrome DevTools
Protocol — no playwright dependency, no download at install time. Discovery order:

1. `GUMBOX_BROWSER_PATH` — explicit override. If it's set but doesn't point at an executable,
   discovery fails with an error instead of silently falling through to another browser.
2. System installs of Chrome, Edge, or Chromium, in the usual per-OS locations.
3. Playwright's browser cache as a courtesy fallback (`~/Library/Caches/ms-playwright` on
   macOS, `$XDG_CACHE_HOME` or `~/.cache/ms-playwright` on Linux,
   `%LOCALAPPDATA%\ms-playwright` on Windows) — full `chromium-<revision>` downloads only,
   newest first, the headless shell is skipped.

macOS, Linux, and Windows are all exercised in CI. When nothing is found, gumbox fails with
the exact paths it checked.

## Docs

- **[Specs](./specs/README.md)** — product direction and the source of truth

The website is being worked on at [gum.tools](https://gum.tools).

## Status

Built in slices. Box authoring, dev/build/preview runs, browser evidence, witness verdicts
with the `gumbox evidence` drill-down, the CLI, and JSON receipts work today. The
state-gallery UI, generated types, and receipt replay are coming.

## Contributing

The workspace runs on **Deno** (the library itself is runtime-agnostic — it runs wherever Vite
runs):

```sh
deno install        # install dependencies
deno task test      # run the test suite (drives real Vite pipelines)
deno task check     # format check + lint + typecheck
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full setup. Start with
[`specs/`](./specs/README.md) for intent, and `.ruler/` for the working agreements.
