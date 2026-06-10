import { box } from 'gumbox';

export const ConfigRestart = box(
	{ name: 'vite config edit restarts the dev server', tags: ['pipeline'] },
	async ({ pipeline, project, expect }) => {
		await pipeline.dev();

		const change = await project.edit.config({
			replace: ['marker-before', 'marker-after'],
		});

		await expect.pipeline.serverRestarted(change, { timeoutMs: 15_000 });
	},
);

export const EnvReload = box(
	{ name: 'env file edit reloads the dev server', tags: ['pipeline'] },
	async ({ pipeline, project, expect }) => {
		await pipeline.dev();

		const change = await project.edit('.env', {
			replace: ['env-before', 'env-after'],
		});

		await expect.pipeline.serverRestarted(change, { timeoutMs: 15_000 });
	},
);
