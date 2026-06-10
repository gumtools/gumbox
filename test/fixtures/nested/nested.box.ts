import { box } from '@gumbox/vite';

// The Vite app lives in `app/`, not at the box root. This is the shape of a
// repo whose fixtures are subdirectories (for example qwik-bundler): the box
// overlays the dev root while project.edit stays relative to the runner root.
export default box(
	'app subdirectory edit hot-updates with fixture-rooted evidence',
	async ({ environment, project, pipeline, expect, receipt }) => {
		await pipeline.dev({
			config: (config) => ({ ...config, root: `${config.root}/app` }),
		});

		// Prime the client module graph without a browser.
		await environment.client.request('/');
		await environment.client.request('/src/main.ts');
		await environment.client.request('/src/message.ts');

		const change = await project.edit('app/src/message.ts', {
			replace: ['nested before', 'nested after'],
		});

		await expect.environment.client.hotUpdate(change);
		await expect.environment.client.noFullReload(change);
		await expect.environment.client.invalidated(change, '/src/message.ts');
		await receipt.capture('after nested hmr update');
	},
);
