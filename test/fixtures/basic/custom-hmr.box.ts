import { box } from '@gumbox/vite';

// Frameworks like qwik replace Vite's 'update' payload with their own custom
// hot protocol. The custom payload is the terminal HMR evidence then:
// expect.environment.<name>.customPayload must observe it, and noFullReload
// must settle on it instead of timing out.
export default box(
	'custom hot payload replaces the vite update protocol',
	async ({ environment, project, pipeline, expect }) => {
		await pipeline.dev();

		await environment.client.request('/');
		await environment.client.request('/src/main.ts');
		await environment.client.request('/src/custom-message.ts');

		const change = await project.edit('src/custom-message.ts', {
			replace: ['custom before', 'custom after'],
		});

		await expect.environment.client.customPayload(change, 'fixture:hmr');
		await expect.environment.client.noFullReload(change);
		await expect.environment.client.invalidated(change, '/src/custom-message.ts');
	},
);
