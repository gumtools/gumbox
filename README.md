# Gumbox

A Vite-native UI state isolation and QA receipt toolkit.

See [specs](./specs/README.md) for current product direction.

This package currently provides the Vite plugin foundation for Gumbox:

- a reset Vite plugin shell
- early specs for the product direction

## Usage

```ts
import { defineConfig } from 'vite';
import { gumbox } from 'gumbox';

export default defineConfig({
	plugins: [gumbox()],
});
```
