# T002 — qwik-bundler Smoke-Script Inventory

Source: `/Users/jacksm5pro/dev/open-source/qwik-bundler/scripts/` (read-only reference).

## 1. SHARED MACHINERY

- `lib/lock.mjs` — only shared helper: mkdir-based mutex under `../../.tmp/locks`, 100ms spin-poll, 10-min stale-lock sweep.
- `with-lock.mjs` — CLI wrapper `with-lock <name> <cmd...>`, propagates exit code.
- Everything else duplicated inline per script: `createServer({root, configFile, server:{host:'127.0.0.1', port:0}})` + `server.resolvedUrls.local[0]`; readFile original -> writeFile mutation -> restore in `finally`; per-script poll helpers; `chromium.launch()`; cleanup chain.

## 2. PER-SCRIPT TABLE

| Script | Starts | Environment | Mutation | Asserts | Cleanup |
|---|---|---|---|---|---|
| smoke-vite-csr-hmr | Vite dev (in-process) | client | edits `fixtures/vite-csr/src/home.tsx` h1 | DOM h1 updated, >=1 `qHmr` event, 0 reload navigations | finally-restore, close, unlock |
| smoke-vite-csr-attribute-hmr | Vite dev | client | injects `data-hmr` attr | attr appears, 0 navigations | same |
| smoke-vite-nitro-hmr | Vite dev | nitro SSR + client | replaces button JSX (2 candidate patterns) | button text, `qHmr`, 0 navigations | same |
| smoke-vite-nitro-remove-handler-hmr | Vite dev | nitro SSR + client | regex-strips `onClick$` | `q-e:click` attr gone, no errors after click (250ms sleep) | same |
| smoke-vite-nitro-remove-signal-hmr | Vite dev | nitro SSR + client | source variants swapped live | counter state survives remove/re-add (Count 8 preserved) | same |
| smoke-vite-workerd-hmr | Vite dev | workerd SSR + client | edits h1 | DOM h1, `qHmr`, 0 navigations | same |
| smoke-vite-workerd | none (assumes build) | built worker in Node, fake `ASSETS` | none | `worker.fetch()` 200 + HTML markers | `process.exit(0)` |
| smoke-vite-workerd-router | Vite dev | workerd SSR | none | SSR content, `/@vite/client` tag, dev-styles.css content-type/body; dumps moduleGraph on fail | server close; no lock |
| smoke-vite-workerd-router-browser | Vite dev | workerd SSR + client | none | computed h1 color, counter click 0->1, no console/page/request errors | close; no lock |
| smoke-vite-router-browser | Vite dev | node SSR + client | none | counter click 0->1; prints consoleErrors but never fails on them | close |
| smoke-vite-ssg | none (assumes build) | build artifact | none | `dist/index.html` contains `q:container="paused"`, manifest hash, bundle-graph, `/build/q-` | none |
| check-hmr-leakage | none (assumes builds) | 4 fixture dists | none | no forbidden HMR strings (`qHmr`, `import.meta.hot.accept(`, `location.reload`, …) in prod output | none |

## 3. FRAGILITY

- Hard timeouts (15-20s), blind settle sleeps (250-750ms).
- Mutate-then-restore only in `finally`; crash leaves fixture dirty. Locking bolted on, inconsistently applied.
- Build-order coupling: three scripts assume prior builds silently.
- No durable evidence: stdout + exit code only; failure dumps vanish; one script collects errors without asserting.
- ~7x copy-pasted boilerplate with drift (nitro script tolerates 2 source shapes — fixtures drift under scripts).
- Brittle assertions: regex over JSX, exact computed color, exact internal attrs and dev URLs.

## 4. CANONICAL GUMBOX SCENARIOS

1. **Client HMR edit** (csr-hmr): snapshot+edit `src/home.tsx` -> dev `client` env + real browser -> DOM transition, custom-event count, 0 navigations -> receipt: diff, event log, per-assertion results, server URL.
2. **SSR HMR with state preservation** (nitro-remove-signal-hmr): source variants -> nitro SSR + client -> counter interactions, remove/re-add edits -> receipt: edit timeline, preserved-state assertion, restoration status.
3. **Build artifact scan** (ssg + check-hmr-leakage): build -> artifact assertions: required strings in `dist/index.html`, forbidden-string scan -> receipt: per-file match list, missing-output diagnostics.
4. **Multi-environment workerd dev** (workerd-router + -browser): dev with client + workerd envs -> SSR HTML markers, CSS endpoint, moduleGraph snapshot, computed style + click, error capture -> receipt: HTTP transcripts, moduleGraph excerpt, browser errors.

## 5. FIXTURE CANDIDATES (under `qwik-bundler/fixtures/`)

- `vite-csr` — minimal: one component with known h1/p text, client-only config.
- `vite-nitro-v3` — `useSignal` counter + `onClick$` button, nitro SSR env.
- `vite-workerd`, `vite-workerd-router` — workerd env config, router route, global.css color.
- `vite-qwik-router` — route with counter button.
- `vite-ssg` — SSG build emitting `q:container="paused"`.
- `vite-library`, `rolldown-library-consumer` — leakage scan only.
