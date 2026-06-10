import type { defineConfig } from 'vite-plus';

// No package.json in this workspace (deno.json is the manifest): a runtime
// vite-plus import would be kept as a bare external specifier in vite's
// bundled config and Deno's node-compat resolver cannot resolve it without a
// nearest package.json. A type-only import is erased at bundle time.
export default {
	staged: {
		'*': 'deno task check',
	},
	pack: {
		entry: {
			index: './src/index.ts',
			gumbox: './src/cli/gumbox.ts',
		},
		format: ['esm'],
		dts: true,
		clean: true,
		// tsdown cannot auto-derive externals without package.json
		// dependencies; pack.deps.neverBundle crashes for the same reason.
		external: ['mitt', 'mlly', 'pathe', 'tinyglobby', 'vite'],
	},
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
	lint: {
		ignorePatterns: ['dist/**', 'node_modules/**', 'docs/**'],
	},
	fmt: {
		useTabs: true,
		tabWidth: 4,
		printWidth: 100,
		endOfLine: 'lf',
		singleQuote: true,
		ignorePatterns: ['dist/**', 'node_modules/**', 'docs/**'],
	},
} satisfies Parameters<typeof defineConfig>[0];
