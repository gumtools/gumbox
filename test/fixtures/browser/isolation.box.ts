import { box } from 'gumbox';

/**
 * Both boxes pin the dev server to the same port so they share an origin:
 * localStorage is origin(port)-scoped, and without the pin Vite's random port
 * would make the storage half of the probe vacuously clean. The cookie half
 * is port-agnostic on 127.0.0.1 either way. Boxes run sequentially, so the
 * first box's server is closed before the second binds the port.
 */
const ISOLATION_DEV_PORT = 14173;

type PinnableConfig = { server?: Record<string, unknown> };

function pinDevServerPort<Config extends PinnableConfig>(config: Config): Config {
	return {
		...config,
		// strictPort keeps a port clash loud — a silently different port would
		// change the origin and quietly weaken the localStorage detector.
		server: { ...config.server, port: ISOLATION_DEV_PORT, strictPort: true },
	};
}

export const WritesIsolationState = box(
	{ name: 'isolation: first box plants cookie and storage state', modes: ['dev'] },
	async ({ pipeline, browser, expect }) => {
		await pipeline.dev({ config: pinDevServerPort });
		const page = await browser.visit('/isolation.html?isolation=write');

		// The write must demonstrably land, or the second box proves nothing.
		await expect.page.text(page, '#isolation-report', 'wrote cookie=true storage=box-a');
	},
);

export const SeesCleanIsolationState = box(
	{ name: 'isolation: second box sees none of the first box state', modes: ['dev'] },
	async ({ pipeline, browser, expect }) => {
		await pipeline.dev({ config: pinDevServerPort });
		const page = await browser.visit('/isolation.html?isolation=read');

		// Same origin as the first box, same pooled browser process: only an
		// isolated browser context per box makes this state invisible.
		await expect.page.text(page, '#isolation-report', 'clean state');
	},
);
