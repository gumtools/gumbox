/**
 * Host boundary for browser automation. This is the one place (besides the
 * test-support adapter that re-exports it) allowed to load a real automation
 * driver. playwright-core is imported lazily inside launch(), so projects
 * that never visit a browser environment never pay for (or need) it.
 *
 * No browser binary is downloaded at install time: launch tries the
 * playwright-managed Chromium first (when its cache exists) and falls back to
 * installed system browsers via playwright channels (Chrome, Edge).
 */
import type {
	BrowserLaunchOptions,
	GumboxBrowser,
	GumboxBrowserPage,
	GumboxBrowserSession,
} from '../browser.ts';
import type { Browser, BrowserType, Page } from 'playwright-core';

/** null = the playwright-managed default executable. */
const LAUNCH_CHANNELS: ReadonlyArray<string | null> = [null, 'chrome', 'msedge'];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message.split('\n')[0]! : String(error);
}

async function importChromium(): Promise<BrowserType> {
	let playwright: { chromium: BrowserType };
	try {
		playwright = await import('playwright-core');
	} catch (error) {
		throw new Error(
			`gumbox needs the optional 'playwright-core' package for browser visits, but it could not be loaded: ${errorMessage(error)}`,
		);
	}
	return playwright.chromium;
}

async function launchChromium(chromium: BrowserType, headless: boolean): Promise<Browser> {
	const failures: string[] = [];
	for (const channel of LAUNCH_CHANNELS) {
		try {
			return await chromium.launch({
				headless,
				...(channel === null ? {} : { channel }),
			});
		} catch (error) {
			failures.push(`${channel ?? 'playwright chromium'}: ${errorMessage(error)}`);
		}
	}
	throw new Error(
		`gumbox could not launch a Chromium-family browser. Install one with ` +
			`'npx playwright install chromium' or install Google Chrome / Microsoft Edge. ` +
			`Attempts: ${failures.join(' | ')}`,
	);
}

function adaptPage(page: Page): GumboxBrowserPage {
	return {
		goto: async (url) => {
			await page.goto(url, { waitUntil: 'load' });
		},
		reload: async () => {
			await page.reload({ waitUntil: 'load' });
		},
		content: () => page.content(),
		screenshot: async (filePath) => {
			await page.screenshot({ path: filePath });
		},
		evaluate: (expression) => page.evaluate(expression),
		waitForExpression: async (expression, timeoutMs) => {
			await page.waitForFunction(expression, undefined, { timeout: timeoutMs });
		},
		onConsoleMessage: (listener) => {
			page.on('console', (message) => {
				listener({ level: message.type(), text: message.text() });
			});
		},
		onPageError: (listener) => {
			page.on('pageerror', (error) => {
				listener({ message: error.message });
			});
		},
		onRequestFailed: (listener) => {
			page.on('requestfailed', (request) => {
				listener({
					url: request.url(),
					method: request.method(),
					reason: request.failure()?.errorText ?? null,
				});
			});
		},
		onNavigated: (listener) => {
			page.on('framenavigated', (frame) => {
				if (frame === page.mainFrame()) {
					listener(frame.url());
				}
			});
		},
		close: () => page.close(),
	};
}

function adaptSession(browser: Browser): GumboxBrowserSession {
	return {
		newPage: async () => adaptPage(await browser.newPage()),
		close: () => browser.close(),
	};
}

export function createHostBrowser(): GumboxBrowser {
	return {
		name: 'chromium',
		launch: async (options: BrowserLaunchOptions): Promise<GumboxBrowserSession> => {
			const chromium = await importChromium();
			return adaptSession(await launchChromium(chromium, options.headless));
		},
	};
}
