# Contributing to gumbox

gumbox runs **boxes** — small TypeScript files that drive a real Vite pipeline (dev server,
file edits, builds, a real browser) and write a JSON **receipt** proving what happened.

Contributing here means one of three things: making gumbox observe Vite more faithfully,
making receipts richer, or making the authoring API clearer. This guide gets you productive
on all three.

## Setup (two minutes)

The repo runs on Deno — no Node/npm/pnpm setup, `deno.json` is the whole manifest.

1. Install Deno: <https://docs.deno.com/runtime/getting-started/installation/>
2. `deno install` — Deno fetches the npm dependencies for you
3. `deno task dev` — the test suite in watch mode, your main feedback loop

| Task              | What it does                           |
| ----------------- | -------------------------------------- |
| `deno task dev`   | tests in watch mode (start here)       |
| `deno task test`  | run the suite once                     |
| `deno task check` | format + lint + types — CI runs this   |
| `deno task fmt`   | fix formatting when `check` complains  |
| `deno task build` | bundle to `dist/` (what consumers run) |

Browser-dependent tests use your installed Chrome/Edge via `playwright-core` and skip
automatically on machines without one — nothing to download.

## How a box run works

Everything in this codebase serves one loop:

```mermaid
flowchart LR
    box["📦 cart.box.ts"]:::pink --> runner["runner<br/>builds the box context"]:::orange
    runner --> vite["your real Vite pipeline<br/>dev · build · preview"]:::cream
    vite --> evidence["evidence store<br/>HMR payloads · invalidations<br/>console · network · artifacts"]:::cream
    evidence --> expect["expect.*<br/>diffs expectation vs evidence"]:::orange
    expect --> receipt["🧾 receipt.json<br/>pass or fail, with the whole story"]:::pink

    classDef orange fill:#F97316,stroke:#C2410C,color:#ffffff
    classDef pink fill:#EC4899,stroke:#BE185D,color:#ffffff
    classDef cream fill:#FFF7ED,stroke:#F97316,color:#7C2D12
```

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

```mermaid
flowchart TD
    specs["📜 specs/<br/>product truth — behavior changes start here"]:::pink

    subgraph authoring["Authoring"]
        boxfn["box.ts<br/>the box() function"]:::cream
        disc["discovery.ts<br/>finds *.box.ts files,<br/>derives names"]:::cream
    end

    subgraph engine["Engine — one box run"]
        runner["runner.ts<br/>six-key context, lifecycle,<br/>guaranteed file restoration"]:::orange
        project["project.ts<br/>file edits + diffs + restore"]:::cream
        buildprev["build.ts · preview.ts<br/>pipeline.build / preview"]:::cream
        browser["browser.ts<br/>page evidence"]:::cream
        evidence["evidence.ts<br/>taps Vite's hot channel and<br/>hotUpdate hook, classifies reactions"]:::orange
        expectfile["expect.ts<br/>the assertion surface"]:::orange
        receiptfile["receipt.ts<br/>assembles and writes receipts"]:::cream
    end

    subgraph host["Host boundary — the only place runtime APIs are allowed"]
        cli["cli/<br/>argv · fs · signals · colors ·<br/>playwright-core"]:::pink
    end

    specs -.govern.-> engine
    disc --> runner
    boxfn --> disc
    runner --> project & buildprev & browser
    project & buildprev & browser --> evidence
    evidence --> expectfile --> receiptfile
    cli --> runner

    classDef orange fill:#F97316,stroke:#C2410C,color:#ffffff
    classDef pink fill:#EC4899,stroke:#BE185D,color:#ffffff
    classDef cream fill:#FFF7ED,stroke:#F97316,color:#7C2D12
```

Two places not on the diagram that you'll touch constantly:

- `test/fixtures/` — small real Vite apps the tests run boxes against; the box files inside
  them are executable documentation of the API
- `test/*.test.ts` — the suite; tests copy a fixture to a temp dir, run boxes through the real
  pipeline, then assert on the written receipt JSON

## Making a change

```mermaid
flowchart TD
    spec["1 · Check specs/ — does the spec cover it?<br/>If your change contradicts it, change the spec first<br/>(same PR is fine)"]:::pink
    test["2 · Write the failing test:<br/>a small box in test/fixtures/* plus a test<br/>that runs it and asserts on the receipt"]:::orange
    red{"fails for the<br/>right reason?"}:::cream
    impl["3 · Implement the smallest change<br/>that makes it pass"]:::orange
    green{"deno task dev<br/>green?"}:::cream
    verify["4 · deno task test && deno task build && deno task check"]:::orange
    pr["Open the PR 🎉"]:::pink

    spec --> test --> red
    red -- "no — fix the test" --> test
    red -- yes --> impl --> green
    green -- "no — keep iterating" --> impl
    green -- yes --> verify --> pr

    classDef orange fill:#F97316,stroke:#C2410C,color:#ffffff
    classDef pink fill:#EC4899,stroke:#BE185D,color:#ffffff
    classDef cream fill:#FFF7ED,stroke:#F97316,color:#7C2D12
```

Testing rules you'll be reviewed against:

- Drive the **real** Vite pipeline; never mock it.
- Waits are event-driven (evidence events, page conditions) — never `sleep(250)`.
- Failure paths matter: if you add an assertion, prove it can fail (the suite has
  deliberate-failure boxes for exactly this).

### The rule that surprises newcomers

**`src/` and test bodies never import `node:*` or touch `process.*`/`Deno.*`.** Paths come
from `pathe`, module utils from `mlly`, globbing from `tinyglobby`, filesystem access through
the injected `GumboxFileSystem`. Only explicit host boundaries (`src/cli/host.ts`,
`test/support/*`) may adapt runtime APIs. Full policy:
`.claude/rules/runtime-agnostic-tooling.md`.

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
