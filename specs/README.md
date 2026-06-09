# Gumbox Specs

This folder captures the product and implementation direction for Gumbox.

Gumbox is a Vite Environment API-first QA receipt tool. It proves how the
user's real Vite pipeline reacts to real project states and edits.

## Specs

- [Product Direction](./product-direction.md)
- [CLI](./cli.md)
- [Box Authoring](./box-authoring.md)
- [Runtime Routes](./runtime-routes.md)
- [Scenarios And Receipts](./scenarios-and-receipts.md)

## Current Wedge

Gumbox should replace brittle local smoke scripts that manually start Vite,
visit app routes, mutate project files, verify HMR, inspect SSR/runtime
behavior, scan generated artifacts, and leave little or no durable evidence.
It should also give AI agents and humans a concrete oracle for refactor loops:
the real Vite pipeline either produced the expected receipt or it did not.

The first practical customer is `qwik-bundler`, where those script patterns are
already visible and should shape the MVP.

The product rule is:

> A box runs inside the user's real Vite pipeline, exercises one or more Vite
> environments, and writes a receipt explaining what happened.

A visible UI state is still a box:

> state setup -> real Vite route/environment -> visible UI -> receipt

The authoring model follows Vite 8:

- `environment.<name>` is generated from the user's resolved Vite environments.
- `browser` is an ergonomic alias for the default client/browser environment.
- `expect.environment.<name>` asserts environment-specific receipt evidence.
- `expect.browser` aliases the default client/browser environment assertions.

## Canonical Use Cases

HMR is only one receipt class. Gumbox should also cover:

- visual UI state browsing from real app routes
- real route receipts from the user's Vite dev server
- named environment isolation and SSR/server runtime behavior
- config/env edits and Vite restart or reload evidence
- dev/build/preview parity
- resolver, alias, workspace, symlink, and module identity behavior
- CSS, HTML, asset, and source map pipeline behavior
- plugin hook, chunk, manifest, and artifact integrity
- local performance receipts for request counts, invalidation breadth, reload
  time, transform time, and build timing
- AI/refactor verification receipts that reduce false positives and false
  negatives in Codex-style loops
