# Scenarios And Receipts

## Box Definition

A Gumbox box is a reproducible QA workflow that exercises the user's real Vite
pipeline and emits a receipt.

It may include:

- starting or connecting to a Vite dev server
- visiting a real app route through the default browser environment
- presenting the visited route as a named UI state in the Gumbox state gallery
- requesting or importing from SSR, edge, worker, RSC, or custom environments
- editing source files, config files, config dependencies, or env files
- observing HMR, full reloads, module invalidation, overlays, and server
  restarts
- running Vite build through the user's pipeline
- running local Vite preview against built output
- comparing dev, build, and preview output
- inspecting resolver, alias, workspace, symlink, virtual module, and URL-query
  behavior
- inspecting CSS, HTML, assets, source maps, public paths, and style runtime
  behavior
- scanning generated chunks, manifests, server bundles, and emitted assets
- recording plugin hooks, transforms, middleware, virtual modules, and errors
- capturing DOM, HTML, screenshots, console, network, server logs, timings, and
  traces
- emitting machine-readable evidence for CI and AI-agent refactor loops

State evidence is first-class. A valid box may start as "visit this route" and
capture a receipt. Stronger boxes add Vite proof such as environment isolation,
config reloads, SSR requests, build/preview parity, resolver behavior, CSS/asset
output, plugin hooks, generated artifacts, or performance budgets.

Visual state browsing is also first-class. A UI state is not a separate story
format; it is a box whose primary surface is a visible app route or
browser-capable environment state.

Agent verification is also first-class. A box should be able to serve as an
oracle for a refactor loop: the agent changes code, runs Gumbox, reads the
receipt, and can tell whether the actual Vite pipeline still works.

## State Surfaces

Supported state surfaces should include:

- dev route: visit a route from `vite dev` through `browser` or
  `environment.client`
- UI state: show a named box in the state gallery when it visits a
  browser-capable environment and captures page evidence
- preview route: visit built output from local `vite preview`
- server request: call `environment.ssr.request(...)` or another fetchable
  environment
- runnable environment import: call `environment.<name>.import(...)`
- hydrated page: inspect browser runtime after client code runs
- build environment: inspect Vite builder environments, chunks, assets, and
  manifests
- artifact surface: inspect files emitted by the user's Vite build
- config surface: edit or overlay Vite config/env inputs and observe the Vite
  lifecycle response
- module graph surface: inspect invalidation, accepted HMR boundaries, duplicate
  module IDs, aliases, symlinks, and virtual modules
- performance surface: record request count, reload time, transform time,
  invalidation breadth, and build timing
- agent oracle surface: emit structured pass/fail evidence, implicated files,
  Vite events, artifact failures, and recommended next investigation targets

The product should avoid treating isolated component mounting, route-input
mocking, or generic browser automation as the default center. Those can become
secondary adapters, but the MVP should focus on real app routes, named Vite
environments, project edits, build/preview output, and receipts.

## Box Sources

The long-term DX should avoid requiring users to hand-maintain a fixture map.

Possible sources:

- conventional box files, for example `*.box.ts` and `*.box.tsx`
- project-local box directories
- explicit plugin config for unusual apps
- route manifests from framework integrations
- imported script helpers that already exist in a project
- future migration helpers for smoke scripts

For the MVP, explicit config is acceptable as an escape hatch. The happy path
should be discovering `*.box.ts` and `*.box.tsx` files, loading the user's Vite
config, generating typed project facts, and showing boxes in the Gumbox UI.

## File Convention

The authoring API is specified in [Box Authoring](./box-authoring.md).

The preferred box file suffixes are:

```text
*.box.ts
*.box.tsx
```

Examples:

```text
src/dashboard.box.ts
scenarios/hmr.box.ts
scenarios/build-preview.box.ts
scenarios/qwik-dev.box.ts
```

`box` should be the project primitive: a QA state or workflow that can run
through the Vite pipeline and produce a receipt. The package name is Gumbox, but
box files should not need to repeat the full package name.

## Box Lifecycle

A typical box should follow this shape:

```text
select Vite surface
optionally edit project files, config files, or env files
start or attach to Vite
visit route, request/import environment, build, preview, or inspect artifact
capture baseline evidence
perform action, source edit, config edit, or build/preview step
observe Vite, environment, browser, and artifact events
assert behavior
write receipt
restore files
```

For a UI state box, the important proof is not only that the state is visible.
It should also record the route, environment, screenshot, DOM, console/network
state, server logs, and Vite events that produced it.

Example:

```ts
box('empty cart', async ({ browser, expect, receipt }) => {
	const page = await browser.visit('/cart?state=empty');

	await expect.page.text(page, '[data-cart-count]', '0');
	await receipt.capture('empty cart');
});
```

The Gumbox UI should display this as a state-gallery entry, but the route remains
the user's real `/cart?state=empty` route. `/__gumbox` is the control surface,
not the application route being tested.

For an HMR box, the important proof is not only that the DOM changed. It should
also record whether Vite sent an HMR update or a full reload, which module or
file triggered it, and whether the browser reloaded. The edit receipt should be
able to answer "what did this saved file edit cause?"

For a config/env box, the important proof is not only that the page still
renders. It should also record the config edit or overlay, whether the Vite
server restarted, which plugins/config/env values changed, and whether visited
routes or environments reflect the new pipeline state.

For a dev/build/preview parity box, the important proof is not only that a route
loads. It should record the dev output, build artifacts, preview runtime,
generated HTML/CSS/assets, and any differences that matter.

For a resolver/module identity box, the important proof is whether one physical
file became one or more Vite module IDs across aliases, workspace symlinks,
virtual importers, URL queries, and platform-specific paths.

For a plugin/artifact box, the important proof is whether hook evidence and
on-disk output agree: emitted chunks exist, manifests reference the expected
files, placeholders were replaced, and runtime output does not contain stale
build markers.

For an agent-oracle box, the important proof is whether the receipt is specific
enough to prevent both false positives and false negatives. Passing typecheck or
unit tests should not be enough if the actual Vite pipeline failed. Failing a
box should not force an agent to guess; the receipt should point at the route,
environment, edit, Vite event, artifact, runtime error, or plugin evidence that
made the box fail.

Each project edit should classify its Vite outcome:

- update
- full reload
- server restart
- build rerun
- environment invalidation
- artifact change
- error
- no Vite reaction

The authored condition should read against that normalized outcome. The receipt
can still show lower-level Vite 8 evidence such as websocket payloads, accepted
paths, plugin hooks, module graphs, builder environments, and reload triggers.

## Receipt Definition

A receipt is durable QA evidence for a box run.

It should answer:

- what ran
- which app, route, server, environment, and mode were used
- what state was visited and how it was reached
- whether the box was shown as a UI state
- what changed during the run
- what config was loaded, edited, or overlaid
- which generated Gumbox project type model was used
- what the browser saw
- screenshot, DOM, and visible-state preview metadata
- what server or custom environments emitted
- which Vite events happened
- whether HMR updated, reloaded, errored, or did nothing
- whether environments were isolated or cross-invalidated
- what build and preview output looked like
- which artifacts, chunks, assets, manifests, and source maps were inspected
- which plugin hooks and transforms were observed
- what timings, request counts, and invalidation breadth were recorded
- what assertions passed or failed
- which witness testified to each piece of evidence
- each witness's verdict and any statements against the run
- whether the result is suitable as an agent/CI oracle
- machine-readable summary for tools and agents
- where screenshots, logs, traces, and artifacts are stored

## Witnesses

A box run is a case and the receipt is the case file. Every part of the
pipeline that can observe something is a witness, and the receipt records who
saw what, who backs the result, and who speaks against it.

Witness ids form an open set. A future witness registers a new id without a
schema change. The runtime attributes evidence to four witnesses today:

| id         | who                                         | testifies to                                                                                                                                                          |
| ---------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline` | the Vite server side                        | the `vite` block, `editOutcomes[]`, `builds[]`, `previews[]`, and server-side timeline events such as server starts, hot payloads, environment requests, and previews |
| `client`   | facts that originate inside the page        | `pages[].consoleMessages`, `pages[].pageErrors`, `pages[].trackedEvents`, and `pages[].snapshots[].html` (the DOM's own statement)                                    |
| `driver`   | facts only observable from outside the page | `pages[].failedRequests`, `pages[].navigations`, `pages[].interactions`, and `pages[].snapshots[].screenshot`                                                         |
| `box`      | the investigator                            | `edits[]`, `assertions[]`, `captures[]`, `notes[]`, `measurements[]`, and the box lifecycle timeline events                                                           |

The witness is whose facts they are, and the channel is how they reached us.
Today the client witness testifies through the driver's CDP relay and the
injected page script. When a client-witness plugin lands, the same `client`
witness gains a Vite websocket channel with no new id and no schema change.
Pipeline deepening such as transform timing and plugin attribution likewise
enriches `pipeline` without renaming anything.

Witnesses report and the box claims. A failed assertion lands on the `box`
attribution because the page truthfully reported its state while the box's
claim failed. Scene witnesses contradict only on objectively bad facts they
observed.

Each witness receives a verdict per box:

- `corroborates` — called, gave at least one statement, none against the run
- `contradicts` — gave at least one statement against the run
- `silent` — called, but gave zero statements
- `not-called` — the box never engaged this witness (client and driver when no
  page was visited, pipeline when no dev server, build, or preview ran)

The contradiction rules are exact. `client` contradicts on any `pageErrors`
entry or any console message with level `error`. `driver` contradicts on any
`failedRequests` entry. `pipeline` contradicts on any `vite error payload
sent` event or any edit outcome carrying a non-null `error`. `box` contradicts
on a failed box status, any failed assertion, a failed restoration, or a
thrown box error.

The receipt records testimony as data. Every timeline event and every
assertion carries a `witness` field, and each box record carries a
`witnesses` block:

```json
"witnesses": {
	"pipeline": { "verdict": "corroborates", "statements": 14, "against": [] },
	"client": {
		"verdict": "contradicts",
		"statements": 9,
		"against": [
			{
				"kind": "page-error",
				"page": "page-1",
				"at": "2026-06-11T04:16:44.150Z",
				"text": "Uncaught Error: boom from the fixture"
			}
		]
	},
	"driver": { "verdict": "corroborates", "statements": 11, "against": [] },
	"box": { "verdict": "corroborates", "statements": 5, "against": [] }
}
```

`statements` counts the witness's evidence entries for the box. `against`
lists every statement that speaks against the run with stable `kind` values:
`console-error`, `page-error`, `request-failed`, `vite-error`, `edit-error`,
`restore-failed`, `assertion-failed`, `box-error`.

A box is contested when it passed but a witness still contradicts, the
headline case being a console error captured while every assertion passed.
Contested never changes box status. The per-box summary records the flat
verdicts plus a `contested` flag, and the run summary counts contested
passes.

All witness fields are additive. `gumboxReceipt` stays `1`, no existing field
changes shape or meaning, and existing receipt consumers keep working unread.

Witness identity and verdicts are data, and color belongs to the renderer.
The CLI paints verdicts green, red, dim, and yellow, while plain output
carries the full meaning through stable greppable tokens such as `pipeline+`,
`client!`, and `driver.`.

## Timeline

The Gumbox UI should center on a box timeline before promising full application
time travel. Every timeline event carries a `witness` attribution naming whose
testimony it is.

Example timeline events:

- server started
- environments resolved
- UI state selected
- route requested
- route visited
- SSR or server environment requested
- runnable environment imported a module
- browser hydrated
- source file edited
- Vite config edited
- env file edited
- Vite module invalidated
- Vite server restarted
- Vite HMR update sent
- module accepted update
- full reload detected or avoided
- overlay shown or cleared
- DOM changed
- console error captured
- network failure captured
- build started
- build environment completed
- preview server started
- artifact scanned
- plugin hook observed
- performance metric recorded
- screenshot captured
- assertion passed or failed

## Stack Traces

Stack traces belong on timeline failures and errors.

The UI should make it easy to move from a failed event to:

- source location
- server log
- Vite plugin, transform, middleware, build, or HMR event
- environment event
- browser console entry
- network request
- generated artifact
- screenshot or DOM snapshot
- related project edit

## Time Travel

"Time travel" should initially mean replaying captured evidence along the box
timeline.

Gumbox should not promise that it can rewind arbitrary application state unless a
specific framework or instrumentation layer supports that. The safer MVP is
timeline playback: inspect what happened at each captured step and compare
evidence before and after a project edit, environment request, build, preview, or
artifact scan.
