# Contributing to gumbox

gumbox runs **boxes** — small TypeScript files that drive a real Vite pipeline (dev server,
file edits, builds, a real browser) and write a JSON **receipt** proving what happened.

Contributing here means one of three things: making gumbox observe Vite more faithfully,
making receipts richer, or making the authoring API clearer. This guide gets you productive
on all three.

## Setup (two minutes)

The repo runs on Deno — no Node/npm/pnpm setup, `deno.json` is the whole manifest.

1. Install Deno: <https://docs.deno.com/runtime/getting_started/installation/>
2. `deno install` — Deno fetches the npm dependencies for you
3. `deno task dev` — the test suite in watch mode, your main feedback loop

| Task              | What it does                           |
| ----------------- | -------------------------------------- |
| `deno task dev`   | tests in watch mode (start here)       |
| `deno task test`  | run the suite once                     |
| `deno task check` | format + lint + types — CI runs this   |
| `deno task fmt`   | fix formatting when `check` complains  |
| `deno task build` | bundle to `dist/` (what consumers run) |

Browser-dependent tests drive your installed Chrome/Edge/Chromium over the Chrome
DevTools Protocol and skip automatically on machines without one — nothing to download.
Set `GUMBOX_BROWSER_PATH` to pin a specific executable (see "Bring your own browser" in
the README for the full discovery order).

## How a box run works

Everything in this codebase serves one loop:

<p align="center">
  <img src="./assets/contrib-box-run.svg" alt="cart.box.ts → real Vite pipeline (dev, build, preview) → evidence (HMR, modules, console) → receipt.json" width="820" />
</p>

A box looks like this:

```ts
import { box } from 'gumbox';

export default box('message updates without reload', async ({ browser, project, expect }) => {
	const page = await browser.visit('/demo');

	// Edit a real project file; gumbox restores it after the run.
	const change = await project.edit('src/message.ts', {
		replace: ['before', 'after'],
	});

	// Declare what Vite should have done, in the receipt's own vocabulary.
	await expect.edit(change, {
		client: { hmr: 'accepted', invalidated: ['/src/message.ts'] },
		ssr: { invalidated: [] },
	});
	await expect.page.text(page, '#message', 'after');
});
```

While that runs, gumbox records **evidence** — every hot-channel payload, invalidated module,
server restart, console error, navigation, and screenshot — whether or not the box asserts on
it. The run ends with a versioned JSON receipt under `.gumbox/receipts/<run>/` showing the
edit diff, each environment's reaction, every assertion (passed AND failed, with expected vs
observed), and a causal timeline.

### Two rules that shape most reviews

- **An assertion is a partial receipt.** `expect.edit(change, {...})` takes the same shape the
  receipt records — authors copy the outcome they expect. Don't add method-grammar assertions
  (`noFullReload`-style names were removed deliberately).
- **Receipts must not lie.** gumbox drives the _project's own_ Vite copy, never imposes
  `NODE_ENV`, and never replaces real pipeline behavior with mocks. If gumbox changes what the
  pipeline would have produced, that's a bug — we've shipped fixes for exactly that (see
  `src/vite-loader.ts`).

## Code map

How one box run flows through `src/`:

<p align="center">
  <img src="./assets/contrib-code-map.svg" alt="cli → discovery.ts → runner.ts, fanning out to project.ts, build.ts/preview.ts, and browser.ts, converging into evidence.ts → expect.ts → receipt.ts" width="860" />
</p>

| Place                            | Owns                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `specs/`                         | **product truth** — behavior changes start (or end) here                     |
| `src/box.ts`, `src/discovery.ts` | the `box()` function; finding `*.box.ts` files and deriving names            |
| `src/runner.ts`                  | one box run: the six-key context, lifecycle, guaranteed file restoration     |
| `src/project.ts`                 | file edits with diffs and restore                                            |
| `src/build.ts`, `src/preview.ts` | `pipeline.build()` / `pipeline.preview()`                                    |
| `src/browser.ts`                 | page evidence (console, network, navigations, screenshots)                   |
| `src/evidence.ts`                | taps Vite's hot channel and `hotUpdate` hook, classifies each reaction       |
| `src/expect.ts`                  | the assertion surface (`expect.edit`, `expect.page.outcome`, ...)            |
| `src/receipt.ts`                 | assembles and writes receipts                                                |
| `src/cli/`                       | the `gumbox` CLI and the host boundary (argv, fs, signals, colors, browser)  |
| `test/fixtures/`                 | small real Vite apps — their box files are executable documentation          |
| `test/*.test.ts`                 | copy a fixture to a temp dir, run boxes for real, assert on the receipt JSON |

## Making a change

<p align="center">
  <img src="./assets/contrib-workflow.svg" alt="1 check specs → 2 failing test first → 3 smallest fix → 4 verify (test, build, check) → PR" width="860" />
</p>

1. Find the spec section that covers the behavior (`specs/box-authoring.md` for the API,
   `specs/scenarios-and-receipts.md` for receipts). If your change contradicts it, the spec
   changes first — in the same PR is fine.
2. Write the failing test: usually a small box in a `test/fixtures/*` app plus a test that
   runs it and asserts on the receipt. Confirm it fails for the right reason.
3. Implement the smallest change that makes it pass, keeping `deno task dev` green.
4. Run the full gate: `deno task test && deno task build && deno task check`.

Testing rules you'll be reviewed against:

- Drive the **real** Vite pipeline; never mock it.
- Waits are event-driven (evidence events, page conditions) — never `sleep(250)`.
- Failure paths matter: if you add an assertion, prove it can fail (the suite has
  deliberate-failure boxes for exactly this).

### The rule that surprises newcomers

**`src/` and test bodies never import `node:*` or touch `process.*`/`Deno.*`.** Paths come
from `pathe`, file-URL helpers from `src/file-url.ts`, globbing from `tinyglobby`, filesystem access through
the injected `GumboxFileSystem`. Only explicit host boundaries (`src/cli/host.ts`,
`test/support/*`) may adapt runtime APIs. Full policy:
`.ruler/rules/runtime-agnostic-tooling.md`.

## AI tools (Ruler)

This project uses [Ruler](https://github.com/intellectronica/ruler) to manage AI assistant
configuration from a single source of truth. Instead of maintaining separate config files per
tool (Claude Code, Codex, Cursor, ...), everything lives in one place:

```
.ruler/
├── AGENTS.md                     # project overview for all AI tools
├── rules/                        # focused rules, one concern per file
│   ├── code-quality.md
│   ├── runtime-agnostic-tooling.md
│   └── ...
└── ruler.toml                    # which agent outputs to generate
```

Generated outputs (root `CLAUDE.md`, `AGENTS.md`, `.claude/`, editor rule files) are
**gitignored** — never hand-edit them. To work on this repo with an AI assistant:

```sh
npx @intellectronica/ruler apply
```

That regenerates the config for the agents in `ruler.toml` (Claude Code and Codex by default).
When guidance is wrong or stale, edit the narrowest `.ruler/*.md` file and rerun `ruler apply`.
Rule of thumb: if it helps everyone working on this repo, it goes in `.ruler/`; personal
preferences belong in your global `~/.config/ruler/`.

## See it used for real

The sibling `qwik-bundler` repo consumes gumbox via `link:../gumbox`: its `boxes/` directory
replaced thirteen smoke scripts with twelve boxes (HMR across client/SSR/workerd environments,
build artifact scans, state preservation). When you change the authoring API or receipts,
those boxes are the best reality check — and the best examples to read.

## Before you open a PR

```sh
deno task test && deno task build && deno task check
```

All green, focused diff, spec updated if behavior changed. Thanks for contributing!
