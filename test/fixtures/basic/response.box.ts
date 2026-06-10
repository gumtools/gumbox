import { box } from 'gumbox';

// environment.<name>.fetch(path) returns structured response evidence
// (status, content-type, headers, body) instead of request()'s body-only
// string, so a box can assert how the dev server served a route — for
// example that a virtual stylesheet is served as text/css.
export default box(
	{ name: 'environment fetch records response evidence', modes: ['dev'] },
	async ({ pipeline, environment, expect }) => {
		await pipeline.dev();

		const home = await environment.client.fetch('/');
		await expect.response.matches(home, {
			status: 200,
			contentType: 'text/html',
			contains: '/src/main.ts',
		});

		// The same CSS file is served as a stylesheet for a direct request and
		// as a JS module for an import request — the accept header decides.
		const directCss = await environment.client.fetch('/src/style.css', {
			headers: { accept: 'text/css' },
		});
		await expect.response.matches(directCss, {
			status: 200,
			contentType: 'text/css',
			contains: 'rgb(12, 34, 56)',
		});

		const moduleCss = await environment.client.fetch('/src/style.css');
		await expect.response.matches(moduleCss, { contentType: 'javascript' });
	},
);

export const WrongContentType = box(
	{ name: 'response contentType mismatch fails', modes: ['dev'] },
	async ({ pipeline, environment, expect }) => {
		await pipeline.dev();
		const home = await environment.client.fetch('/');
		// This must fail: the dev server serves '/' as text/html, not text/css.
		await expect.response.matches(home, { contentType: 'text/css' });
	},
);
