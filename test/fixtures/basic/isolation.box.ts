import { box } from 'gumbox';

export const ClientEditIsolation = box(
	{ name: 'client edit stays out of the ssr graph', tags: ['environments'] },
	async ({ environment, project, pipeline, expect }) => {
		await pipeline.dev();

		const serverModule = await environment.ssr.import<{ serverMessage: string }>(
			'/src/server-only.ts',
		);
		if (serverModule.serverMessage !== 'server before') {
			throw new Error(`unexpected ssr module contents: ${serverModule.serverMessage}`);
		}

		await environment.client.request('/src/main.ts');
		await environment.client.request('/src/message.ts');

		const change = await project.edit('src/message.ts', (code) =>
			code.replace('before edit', 'client after'),
		);

		await expect.environment.client.hotUpdate(change);
		await expect.environment.client.invalidated(change, '/src/message.ts');
		await expect.environment.ssr.notInvalidated(change);
		await expect.environment.ssr.satisfies(
			change,
			(outcome) => !outcome.update && !outcome.fullReload && outcome.invalidated.length === 0,
		);
	},
);
