import { box } from 'gumbox';

export const PreviewDashboard = box(
	{ name: 'built app serves dashboard in preview', tags: ['preview'], modes: ['preview'] },
	async ({ pipeline, expect, receipt }) => {
		const build = await pipeline.build();
		await expect.build.artifact(build, 'dist/client/index.html');

		const preview = await pipeline.preview(build);
		const page = await preview.browser.visit('/');

		await expect.page.text(page, '#message', 'hello from the browser fixture');
		await expect.page.computedStyle(page, '#title', { color: 'rgb(0, 128, 0)' });
		await expect.page.cleanConsole(page);
		await receipt.capture('preview dashboard state');
	},
);
