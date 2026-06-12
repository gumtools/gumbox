/**
 * Host boundary for browser automation. This is the one place (besides the
 * test-support adapter that re-exports it) allowed to drive a real browser.
 * gumbox owns the whole stack: per-OS discovery + process launch
 * (`browser-launch.ts`), a JSON-RPC client over the global WebSocket
 * (`cdp-client.ts`), and the CDP page adapter (`cdp-browser.ts`).
 *
 * No browser binary is downloaded at install time: launch discovers an
 * installed Chrome, Edge, or Chromium (or an explicit `GUMBOX_BROWSER_PATH`)
 * and speaks the Chrome DevTools Protocol to it directly.
 *
 * The process is pooled: one launched browser per headless mode is shared
 * across every `launch()` call, and each GumboxBrowserSession maps to an
 * isolated CDP browser context (Target.createBrowserContext) instead of a
 * fresh process — the same amortization playwright uses. The pooled process
 * is never shut down by a session; `shutdownLiveBrowserSessions()` (run end,
 * test afterAll, interrupt handler) owns its disposal.
 */
import type { BrowserLaunchOptions, GumboxBrowser, GumboxBrowserSession } from '../browser.ts';
import { launchBrowserEndpoint } from './browser-launch.ts';
import { connectCdpBrowser } from './cdp-browser.ts';
import type { CdpBrowserConnection, LaunchedBrowserEndpoint } from './cdp-browser.ts';

type PoolEntry = {
	endpoint: LaunchedBrowserEndpoint;
	browser: CdpBrowserConnection;
	/** Mutable so the connection-lost/process-exit callbacks can flag it. */
	health: { isDead: boolean };
};

/** Injectable process/connection factories so the pool is unit-testable. */
export type CreateHostBrowserOptions = {
	launchEndpoint?(options: { headless: boolean }): Promise<LaunchedBrowserEndpoint>;
	connectBrowser?(
		endpoint: LaunchedBrowserEndpoint,
		options: { onConnectionLost(): void },
	): Promise<CdpBrowserConnection>;
};

export function createHostBrowser(options: CreateHostBrowserOptions = {}): GumboxBrowser {
	const launchEndpoint = options.launchEndpoint ?? launchBrowserEndpoint;
	const connectBrowser = options.connectBrowser ?? connectCdpBrowser;
	// One pooled browser process per headless mode, keyed by the flag.
	const pool = new Map<boolean, PoolEntry>();

	const spawnEntry = async (headless: boolean): Promise<PoolEntry> => {
		const endpoint = await launchEndpoint({ headless });
		const health = { isDead: false };
		const markEntryDead = (): void => {
			health.isDead = true;
		};
		// Either signal means the process is gone: the browser-level socket
		// closing (crash, external kill) or the child process exiting.
		void endpoint.exited?.then(markEntryDead);
		try {
			const browser = await connectBrowser(endpoint, { onConnectionLost: markEntryDead });
			return { endpoint, browser, health };
		} catch (error) {
			await endpoint.shutdown().catch(() => undefined);
			throw error;
		}
	};

	const evictEntry = async (headless: boolean, entry: PoolEntry): Promise<void> => {
		entry.health.isDead = true;
		if (pool.get(headless) === entry) {
			pool.delete(headless);
		}
		entry.browser.close();
		// shutdown() is memoized in the launch boundary, so awaiting it here is
		// safe even when the interrupt handler already started the same kill.
		await entry.endpoint.shutdown().catch(() => undefined);
	};

	const acquireLiveEntry = async (headless: boolean): Promise<PoolEntry> => {
		const existing = pool.get(headless);
		if (existing !== undefined && !existing.health.isDead) {
			return existing;
		}
		if (existing !== undefined) {
			await evictEntry(headless, existing);
		}
		const entry = await spawnEntry(headless);
		pool.set(headless, entry);
		return entry;
	};

	return {
		name: 'chromium',
		launch: async (launchOptions: BrowserLaunchOptions): Promise<GumboxBrowserSession> => {
			const entry = await acquireLiveEntry(launchOptions.headless);
			try {
				return await entry.browser.createContextSession();
			} catch {
				// A live-looking process that cannot mint a context is unusable:
				// evict it and retry exactly once on a fresh process.
				await evictEntry(launchOptions.headless, entry);
				const freshEntry = await acquireLiveEntry(launchOptions.headless);
				return freshEntry.browser.createContextSession();
			}
		},
	};
}
