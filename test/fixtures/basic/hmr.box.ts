import { box } from 'gumbox';

export default box(
	'message updates without reload',
	async ({ environment, project, pipeline, expect, receipt }) => {
		await pipeline.dev();

		const html = await environment.client.request('/');
		await expect.html.contains(html, 'id="message"');

		const primed = await receipt.measure('prime client module graph', async () => {
			await environment.client.request('/src/main.ts');
			await environment.client.request('/src/message.ts');
		});
		receipt.note(`client module graph primed in ${primed.durationMs}ms without a browser`);

		const change = await project.edit('src/message.ts', {
			replace: ['before edit', 'after edit'],
		});

		await expect.environment.client.hotUpdate(change);
		await expect.browser.noFullReload(change);
		await expect.environment.client.invalidated(change, '/src/message.ts');
		await receipt.capture('after hmr update');
	},
);
