import { defineConfig } from 'vite-plus';

export default defineConfig({
	staged: {
		'*': 'vp check --fix',
	},
	pack: {
		entry: {
			index: './src/index.ts',
		},
		format: ['esm'],
		dts: true,
		clean: true,
		exports: {
			customExports: () => ({
				'.': {
					types: './dist/index.d.mts',
					default: './dist/index.mjs',
				},
				'./package.json': './package.json',
			}),
		},
	},
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
	lint: {
		ignorePatterns: ['dist/**', 'node_modules/**'],
	},
	fmt: {
		useTabs: true,
		tabWidth: 4,
		printWidth: 100,
		endOfLine: 'lf',
		singleQuote: true,
		ignorePatterns: ['dist/**', 'node_modules/**'],
	},
});
