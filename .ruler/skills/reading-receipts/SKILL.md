---
name: reading-receipts
description: Debug gumbox runs from their receipts — locate the latest receipt, read the per-box timeline, edit outcomes, assertions, and page evidence to find why a box failed or where time went. Use when a box fails, a run is slow, HMR behaves unexpectedly, or you need proof of what the Vite pipeline actually did.
---

# Reading Receipts

Every gumbox run writes a receipt — pass or fail. When anything surprises you, read the
receipt before reaching for a debugger or rerunning with logging. The evidence is usually
already there.

## Locate it

```sh
cat .gumbox/receipts/latest                 # run id of the most recent run
# → .gumbox/receipts/<run-id>/receipt.json  # the receipt
# → .gumbox/receipts/<run-id>/box-N/        # screenshots + HTML snapshots per box
```

The CLI also prints the receipt path after every run, and assertion failures embed it.

## Receipt structure (the parts that answer questions)

`receipt.json` top level: `runId`, `summary` (status/total/passed/failed), `boxes[]`.

Each box record:

| Field              | Answers                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `status` / `error` | did it pass; the failing assertion's message with expected vs observed            |
| `vite`             | config file, server URL, resolved environment names, browser alias                |
| `edits[]`          | every file edit: before/after content, `restored: true` (must be!)                |
| `editOutcomes[]`   | per-environment reaction to each edit: `hmr`, `invalidated`, `messages`           |
| `assertions[]`     | every assertion, passed AND failed, with `expected`/`observed` shapes             |
| `pages[]`          | console errors, failed requests, navigations, tracked DOM events                  |
| `builds[]`         | strategy, environments, outDirs, artifacts with sizes, duration                   |
| `witnesses`        | per-witness verdicts (pipeline/client/driver/box) with statements against the run |
| `timeline[]`       | every evidence event with timestamps — the causal story in order                  |
| `durationMs`       | where the wall-clock went                                                         |

## Debugging patterns

**A box failed** — read `error.message` first (it names expected vs observed), then find the
edit in `editOutcomes` and compare what each environment actually did against the
expectation. The receipt records outcomes for environments the box never asserted on too —
check siblings before concluding the pipeline misbehaved.

**HMR "didn't work"** — in the box's `timeline`, find the edit event, then look at what
followed within the same second: `hot-update-hook` events prove the watcher saw it; payload
events (`update`, `full-reload`, custom messages) prove what Vite sent. Hook seen + no payload
= a plugin swallowed the update. No hook at all = the watcher never saw the file (wrong root,
ignored path).

**A run is slow** — diff consecutive `timeline` timestamps to find the gap, and compare
`durationMs` across boxes. A passing box burning a full assertion timeout is a settle problem,
not pipeline slowness.

**Flaky page state** — `box-N/` holds the screenshot and HTML snapshot for every
`receipt.capture(label)` and visit; compare them against `pages[].consoleMessages` and
`failedRequests`.

**Who saw it** — start from the box's `witnesses` block (or `summary.witnesses` for the
one-line verdicts). A passing box with `summary.contested: true` means a witness still spoke
against the run: `client` contradicts on page/console errors, `driver` on failed requests,
`pipeline` on Vite error payloads or edit errors, `box` on failed assertions or restoration.
Each `against[]` statement carries a stable `kind`, the page, a timestamp, and the text — use
the `witness` field on timeline events to pull that witness's full story in order. The CLI
renders the same data: `gumbox evidence [selector]` drills into the latest receipt
(`--receipt <run-id|path>` for an older one, `--witness <id>` to narrow, `--json` for the raw
blocks).

## Rules

- Receipts are generated output — read them, quote them, never hand-edit them
  (`.gumbox/` is gitignored).
- When reporting a failure, cite the receipt path and the specific evidence
  (timeline entries, outcome fields), not a guess.
- Timestamps are ISO strings; `seq` orders events when timestamps collide.
