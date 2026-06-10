import path from 'pathe';
import type { GumboxFileSystem } from './filesystem.ts';

/**
 * Browser automation is a host capability, exactly like the filesystem:
 * library code never imports an automation driver itself. Hosts (the CLI bin,
 * test support) adapt a real driver — playwright-core in this repo — into
 * this minimal surface and inject it into `runBoxes()`.
 */
export type GumboxBrowser = {
	/** Driver/browser family name recorded in receipts, e.g. 'chromium'. */
	readonly name: string;
	launch(options: BrowserLaunchOptions): Promise<GumboxBrowserSession>;
};

export type BrowserLaunchOptions = {
	headless: boolean;
};

export type GumboxBrowserSession = {
	newPage(): Promise<GumboxBrowserPage>;
	close(): Promise<void>;
};

export type BrowserConsoleMessage = {
	/** Console method level: 'log', 'warning', 'error', ... */
	level: string;
	text: string;
};

export type BrowserPageError = {
	message: string;
};

export type BrowserRequestFailure = {
	url: string;
	method: string;
	reason: string | null;
};

export type GumboxBrowserPage = {
	goto(url: string): Promise<void>;
	reload(): Promise<void>;
	/** Full serialized HTML of the current DOM. */
	content(): Promise<string>;
	/** Writes a PNG screenshot to the given absolute path. */
	screenshot(filePath: string): Promise<void>;
	/** Evaluates a JS expression in the page; the result must be JSON-serializable. */
	evaluate(expression: string): Promise<unknown>;
	/** Event-driven bounded wait until the expression evaluates truthy. */
	waitForExpression(expression: string, timeoutMs: number): Promise<void>;
	/** Clicks the first element matching the selector, waiting (bounded) for it to be actionable. */
	click(selector: string, timeoutMs: number): Promise<void>;
	onConsoleMessage(listener: (message: BrowserConsoleMessage) => void): void;
	onPageError(listener: (error: BrowserPageError) => void): void;
	onRequestFailed(listener: (request: BrowserRequestFailure) => void): void;
	/** Fires on every main-frame navigation (reloads included). */
	onNavigated(listener: (url: string) => void): void;
	close(): Promise<void>;
};

/** A screenshot + DOM/HTML snapshot pair, referenced relative to the run directory. */
export type PageSnapshot = {
	label: string;
	/** Run-dir-relative PNG path, or null when the screenshot could not be taken. */
	screenshot: string | null;
	/** Run-dir-relative HTML snapshot path. */
	html: string;
};

/** A main-frame navigation observed after the initial page load. */
export type PageNavigation = {
	url: string;
	at: string;
};

/** One user-style interaction a box performed on the page. */
export type PageInteraction = {
	kind: 'click';
	selector: string;
	at: string;
};

/** One tracked custom DOM event observed in the page. */
export type TrackedPageEvent = {
	/** ISO timestamp taken inside the page when the event fired. */
	at: string;
	/** JSON-serializable copy of `event.detail` (null when absent). */
	detail: unknown;
};

/** Receipt evidence for one visited page. */
export type PageRecord = {
	id: string;
	route: string;
	environment: string;
	surface: 'dev' | 'preview';
	url: string;
	consoleMessages: BrowserConsoleMessage[];
	pageErrors: BrowserPageError[];
	failedRequests: BrowserRequestFailure[];
	snapshots: PageSnapshot[];
	/** Main-frame navigations after the initial load; empty proves no reload. */
	navigations: PageNavigation[];
	/** Per event name, every occurrence observed since trackEvents(name). */
	trackedEvents: Record<string, TrackedPageEvent[]>;
	/** Interactions the box performed on this page (clicks), in order. */
	interactions: PageInteraction[];
};

/**
 * The box-facing page handle returned by `browser.visit(...)` and
 * `preview.browser.visit(...)`. Intentionally small: assertions go through
 * `expect.page.*`, not through a Playwright-style page object.
 */
export type PageHandle = {
	readonly route: string;
	readonly environment: string;
	readonly url: string;
	reload(): Promise<void>;
	content(): Promise<string>;
	/**
	 * Clicks the first element matching the selector, waiting (bounded,
	 * event-driven) for it to become actionable. The minimal interaction
	 * primitive for reaching a user-made UI state — for example clicking a
	 * counter to a known count before an HMR edit. Each click is recorded as
	 * page evidence; assertions stay in `expect.page.*`.
	 */
	click(selector: string, options?: { timeoutMs?: number }): Promise<void>;
	/**
	 * Starts counting custom DOM events (for example a framework's HMR event)
	 * in the live page. Observed events land in the page receipt evidence and
	 * are asserted with `expect.page.event(page, name, { atLeast })`.
	 * Tracking is per-document: a full reload discards in-page listeners,
	 * which `navigations` evidence makes visible.
	 */
	trackEvents(...eventNames: string[]): Promise<void>;
};

export type VisitArgs = {
	baseUrl: string;
	route: string;
	environment: string;
	surface: 'dev' | 'preview';
};

export type BrowserEvidenceRuntime = {
	readonly pages: PageRecord[];
	visit(args: VisitArgs): Promise<PageHandle>;
	/** Snapshots every open page under the given label (used by receipt.capture). */
	captureOpenPages(label: string): Promise<void>;
	closeAll(): Promise<void>;
};

type PageDriver = {
	page: GumboxBrowserPage;
	record: PageRecord;
};

/** Links a public PageHandle back to its driver without exposing it to boxes. */
const pageDrivers = new WeakMap<PageHandle, PageDriver>();

export function getPageDriver(handle: PageHandle, context: string): PageDriver {
	const driver = pageDrivers.get(handle);
	if (driver === undefined) {
		throw new Error(
			`${context} needs a page returned by browser.visit(...) or preview.browser.visit(...).`,
		);
	}
	return driver;
}

export function missingBrowserCapabilityError(context: string): Error {
	return new Error(
		`${context} needs a browser automation capability, but none was injected. ` +
			`Pass \`browser\` to runBoxes(...) — the gumbox CLI wires a playwright-core ` +
			`adapter automatically when playwright and a Chromium-family browser are installed.`,
	);
}

/** In-page global that accumulates tracked custom DOM events per event name. */
const TRACKED_EVENTS_GLOBAL = 'window.__gumboxTrackedEvents';

/** Expression for how many tracked events of one name fired so far. */
export function trackedEventCountExpression(eventName: string): string {
	return `(((${TRACKED_EVENTS_GLOBAL} || {})[${JSON.stringify(eventName)}] || []).length)`;
}

/**
 * Installs an in-page listener that records every occurrence of the event
 * with a page-side timestamp and a JSON-safe copy of `event.detail`.
 * Capture-phase listeners on both window and document catch window-, document-
 * and element-dispatched events; the WeakSet dedupes propagation overlap.
 */
function trackEventScript(eventName: string): string {
	return `(() => {
	const name = ${JSON.stringify(eventName)};
	const store = (${TRACKED_EVENTS_GLOBAL} = ${TRACKED_EVENTS_GLOBAL} || Object.create(null));
	if (store[name]) { return; }
	store[name] = [];
	const seen = new WeakSet();
	const record = (event) => {
		if (seen.has(event)) { return; }
		seen.add(event);
		let detail = null;
		try {
			detail = JSON.parse(JSON.stringify(event.detail === undefined ? null : event.detail));
		} catch {
			detail = String(event.detail);
		}
		store[name].push({ at: new Date().toISOString(), detail });
	};
	window.addEventListener(name, record, true);
	document.addEventListener(name, record, true);
})()`;
}

/**
 * Pulls the latest tracked-event occurrences out of the live page into the
 * receipt record. A navigated (reloaded) page has a fresh document with no
 * tracked data; previously pulled evidence is kept in that case.
 */
export async function syncTrackedEvents(
	page: GumboxBrowserPage,
	record: PageRecord,
): Promise<void> {
	const trackedNames = Object.keys(record.trackedEvents);
	if (trackedNames.length === 0) {
		return;
	}
	let observed: unknown;
	try {
		observed = await page.evaluate(`(${TRACKED_EVENTS_GLOBAL} || {})`);
	} catch {
		// The page is already closing or mid-navigation; keep what we have.
		return;
	}
	if (observed === null || typeof observed !== 'object') {
		return;
	}
	for (const name of trackedNames) {
		const events = (observed as Record<string, unknown>)[name];
		if (Array.isArray(events)) {
			record.trackedEvents[name] = events as TrackedPageEvent[];
		}
	}
}

function snapshotSlug(label: string): string {
	const slug = label
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
		.replaceAll(/^-|-$/g, '');
	return slug.length === 0 ? 'snapshot' : slug;
}

/**
 * Per-box browser runtime: lazily launches one session through the injected
 * capability, attaches console/network evidence listeners to every page, and
 * writes screenshots + DOM/HTML snapshots under the receipt run directory.
 */
export function createBrowserEvidence(options: {
	browser: GumboxBrowser | undefined;
	headless: boolean;
	fileSystem: GumboxFileSystem;
	/** Absolute receipt run directory; snapshots are referenced relative to it. */
	runDir: string;
	/** Run-dir-relative directory for this box's page assets, e.g. 'box-1'. */
	assetDir: string;
	/** Default bounded wait for page interactions such as click(). */
	interactionTimeoutMs: number;
	onTimeline(type: string, detail: Record<string, unknown>): void;
}): BrowserEvidenceRuntime {
	const { browser, headless, fileSystem, runDir, assetDir, interactionTimeoutMs, onTimeline } =
		options;
	const pages: PageRecord[] = [];
	const openDrivers: PageDriver[] = [];
	let session: GumboxBrowserSession | null = null;
	let assetDirCreated = false;

	const ensureSession = async (): Promise<GumboxBrowserSession> => {
		if (session === null) {
			if (browser === undefined) {
				throw missingBrowserCapabilityError('browser.visit()');
			}
			session = await browser.launch({ headless });
			onTimeline('browser session started', { browser: browser.name, headless });
		}
		return session;
	};

	const snapshotPage = async (driver: PageDriver, label: string): Promise<void> => {
		if (!assetDirCreated) {
			await fileSystem.mkdir(path.join(runDir, assetDir), { recursive: true });
			assetDirCreated = true;
		}
		const baseName = `${driver.record.id}-${snapshotSlug(label)}-${driver.record.snapshots.length + 1}`;
		const htmlRelative = path.join(assetDir, `${baseName}.html`);
		const screenshotRelative = path.join(assetDir, `${baseName}.png`);

		const html = await driver.page.content();
		await fileSystem.writeTextFile(path.join(runDir, htmlRelative), html);
		onTimeline('dom snapshot captured', {
			page: driver.record.id,
			label,
			path: htmlRelative,
		});

		let screenshot: string | null = screenshotRelative;
		try {
			await driver.page.screenshot(path.join(runDir, screenshotRelative));
			onTimeline('screenshot captured', {
				page: driver.record.id,
				label,
				path: screenshotRelative,
			});
		} catch (error) {
			screenshot = null;
			onTimeline('screenshot failed', {
				page: driver.record.id,
				label,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		driver.record.snapshots.push({ label, screenshot, html: htmlRelative });
	};

	const visit = async (args: VisitArgs): Promise<PageHandle> => {
		const { baseUrl, route, environment, surface } = args;
		if (browser === undefined) {
			throw missingBrowserCapabilityError(`browser.visit('${route}')`);
		}
		const activeSession = await ensureSession();
		const url = new URL(route, baseUrl).href;
		const record: PageRecord = {
			id: `page-${pages.length + 1}`,
			route,
			environment,
			surface,
			url,
			consoleMessages: [],
			pageErrors: [],
			failedRequests: [],
			snapshots: [],
			navigations: [],
			trackedEvents: {},
			interactions: [],
		};
		pages.push(record);

		const page = await activeSession.newPage();
		const driver: PageDriver = { page, record };
		openDrivers.push(driver);
		// Listeners attach before navigation so evidence from the very first
		// document request is captured.
		page.onConsoleMessage((message) => {
			record.consoleMessages.push(message);
			if (message.level === 'error') {
				onTimeline('console error captured', { page: record.id, text: message.text });
			}
		});
		page.onPageError((error) => {
			record.pageErrors.push(error);
			onTimeline('console error captured', {
				page: record.id,
				text: error.message,
				source: 'pageerror',
			});
		});
		page.onRequestFailed((request) => {
			record.failedRequests.push(request);
			onTimeline('network failure captured', {
				page: record.id,
				url: request.url,
				method: request.method,
				reason: request.reason,
			});
		});

		onTimeline('route requested', { environment, path: route, surface, url });
		await page.goto(url);
		onTimeline('route visited', { environment, path: route, surface, url });
		// Attached after the initial load on purpose: `navigations` evidence
		// answers "did the page reload after the visit?", so the initial
		// navigation must not count.
		page.onNavigated((navigatedUrl) => {
			record.navigations.push({ url: navigatedUrl, at: new Date().toISOString() });
			onTimeline('page navigated', { page: record.id, url: navigatedUrl });
		});
		await snapshotPage(driver, 'visit');

		const handle: PageHandle = {
			route,
			environment,
			url,
			reload: async (): Promise<void> => {
				await page.reload();
				onTimeline('page reloaded', { page: record.id, url });
			},
			content: () => page.content(),
			click: async (
				selector: string,
				clickOptions?: { timeoutMs?: number },
			): Promise<void> => {
				const timeoutMs = clickOptions?.timeoutMs ?? interactionTimeoutMs;
				await page.click(selector, timeoutMs);
				record.interactions.push({
					kind: 'click',
					selector,
					at: new Date().toISOString(),
				});
				onTimeline('page click', { page: record.id, selector });
			},
			trackEvents: async (...eventNames: string[]): Promise<void> => {
				for (const eventName of eventNames) {
					await page.evaluate(trackEventScript(eventName));
					record.trackedEvents[eventName] ??= [];
					onTimeline('page event tracking started', {
						page: record.id,
						event: eventName,
					});
				}
			},
		};
		pageDrivers.set(handle, driver);
		return handle;
	};

	const captureOpenPages = async (label: string): Promise<void> => {
		for (const driver of openDrivers) {
			await snapshotPage(driver, label);
		}
	};

	const closeAll = async (): Promise<void> => {
		for (const driver of openDrivers.splice(0)) {
			// Late tracked events (after the last assertion) still become evidence.
			await syncTrackedEvents(driver.page, driver.record);
			await driver.page.close().catch(() => undefined);
		}
		if (session !== null) {
			await session.close().catch(() => undefined);
			session = null;
			onTimeline('browser session closed', {});
		}
	};

	return { pages, visit, captureOpenPages, closeAll };
}
