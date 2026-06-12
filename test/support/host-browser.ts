/**
 * Test-only host boundary for browser automation. The actual CDP adapter
 * lives in the CLI host boundary (`src/cli/browser-host.ts`); this module
 * instantiates it for tests and adds availability detection so the
 * browser-dependent suites skip (with a reason) on machines without any
 * launchable Chromium-family browser.
 */
import { afterAll } from 'vitest';
import type { GumboxBrowser } from '../../src/browser.ts';
import { createHostBrowser } from '../../src/cli/browser-host.ts';
import { shutdownLiveBrowserSessions } from '../../src/cli/browser-launch.ts';

export const hostBrowser: GumboxBrowser = createHostBrowser();

// The pooled browser process deliberately outlives every session; dispose it
// when the importing test file finishes so the suite exits on its own and no
// gumbox-chromium process or temp profile leaks past the run.
afterAll(() => shutdownLiveBrowserSessions());

export type BrowserAvailability = { available: boolean; reason: string | null };

export async function detectBrowserAvailability(): Promise<BrowserAvailability> {
	try {
		const session = await hostBrowser.launch({ headless: true });
		await session.close();
		return { available: true, reason: null };
	} catch (error) {
		return {
			available: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
