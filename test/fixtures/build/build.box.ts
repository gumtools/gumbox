import { box } from 'gumbox';

const FORBIDDEN = 'GUMBOX_SERVER_ONLY_SECRET';

export const BuildArtifacts = box(
	{ name: 'build artifacts include no server secret', tags: ['build'], modes: ['build'] },
	async ({ pipeline, expect, receipt }) => {
		const build = await pipeline.build();

		await expect.build.environment(build, 'client');
		await expect.build.environment(build, 'ssr');
		await expect.build.artifact(build, 'dist/client/index.html');
		await expect.artifact.exists(build, 'dist/client/assets');

		const manifest = await build.artifact('dist/client/.vite/manifest.json');
		await expect.artifact.json(manifest, (json) => {
			return Object.keys(json as Record<string, unknown>).length > 0;
		});

		// Forbidden-string leakage scan: the server-only secret may exist in the
		// server bundle but must never reach client-facing output.
		const manifestJson = JSON.parse(manifest.text) as Record<
			string,
			{ file: string; isEntry?: boolean }
		>;
		const entry = Object.values(manifestJson).find((chunk) => chunk.isEntry === true);
		if (entry === undefined) {
			throw new Error('expected the client manifest to record an entry chunk');
		}
		await expect.artifact.text(build, `dist/client/${entry.file}`, { notContains: FORBIDDEN });
		await expect.artifact.text(build, 'dist/client/index.html', { notContains: FORBIDDEN });
		await expect.artifact.text(build, 'dist/server/entry-server.js', { contains: FORBIDDEN });

		await receipt.capture('artifact scan complete');
		receipt.note('client build output is free of the server-only secret');
	},
);

export const LeakDetector = box(
	{ name: 'leak detector fails on forbidden strings', tags: ['build'] },
	async ({ pipeline, expect }) => {
		const build = await pipeline.build();

		// Intentionally scans the server bundle (where the secret legitimately
		// lives) so the test suite can prove this assertion is not a stub.
		await expect.artifact.text(build, 'dist/server/entry-server.js', {
			notContains: FORBIDDEN,
		});
	},
);
