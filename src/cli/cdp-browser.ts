/**
 * Adapts raw CDP connections into the `GumboxBrowserSession` /
 * `GumboxBrowserPage` capability surface. Everything here speaks plain CDP
 * JSON over the injected connection — process launch and filesystem writes
 * stay behind the `LaunchedBrowserEndpoint` the host boundary
 * (`browser-launch.ts`) provides, so this module is runtime-agnostic.
 */
import type { GumboxBrowserPage, GumboxBrowserSession } from '../browser.ts';
import { createCdpConnection, openCdpSocket } from './cdp-client.ts';
import type { CdpConnection, CdpSocket } from './cdp-client.ts';

/** A launched browser process, reachable over its DevTools endpoint. */
export type LaunchedBrowserEndpoint = {
	webSocketDebuggerUrl: string;
	/** Host write for screenshot bytes (the one binary write gumbox does). */
	writeBinaryFile(filePath: string, bytes: Uint8Array): Promise<void>;
	/** Kills the browser process (best effort) and removes its temp profile. */
	shutdown(): Promise<void>;
	/** Resolves when the browser process exits, however it dies. */
	exited?: Promise<void>;
};

/** Upper bound for a navigation to reach its load event. */
const NAVIGATION_TIMEOUT_MS = 30_000;
/** Coarse in-page re-check timer for frames where rAF is throttled or absent. */
const WAIT_SAFETY_TICK_MS = 100;
/** Host-side slack above the in-page deadline before declaring the page hung. */
const HOST_BACKSTOP_SLACK_MS = 500;
/** Pause before re-evaluating after a navigation destroys the wait's context. */
const CONTEXT_RETRY_PAUSE_MS = 20;

/** CDP Runtime.RemoteObject, reduced to the fields gumbox reads. */
export type CdpRemoteObject = {
	type?: string;
	subtype?: string;
	value?: unknown;
	unserializableValue?: string;
	description?: string;
};

type CdpExceptionDetails = {
	text?: string;
	exception?: CdpRemoteObject;
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The value an in-page wait resolves when its deadline passes. Resolving a
 * sentinel (instead of rejecting) keeps the timeout path distinguishable from
 * a real page-side failure such as a destroyed execution context.
 */
export const WAIT_TIMED_OUT_SENTINEL = '__gumbox_wait_timed_out__';

/**
 * Wraps a caller predicate in an in-page wait: one expression whose promise
 * resolves the predicate's value once it turns truthy, or the timeout
 * sentinel when the embedded deadline passes. Re-checks on every animation
 * frame plus a coarse safety tick, because headless Chrome can throttle or
 * suspend rAF on non-visible frames. Everything lives inside the IIFE so the
 * wait never clobbers page globals (trackEvents state in particular).
 */
export function buildInPageWaitExpression(predicateExpression: string, timeoutMs: number): string {
	return `(() => {
	const deadline = Date.now() + ${Math.ceil(timeoutMs)};
	const evaluatePredicate = () => {
		try {
			return (${predicateExpression});
		} catch {
			// A throwing predicate (mid-mutation DOM read) is not-ready, not fatal.
			return null;
		}
	};
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value) => {
			if (settled) { return; }
			settled = true;
			resolve(value);
		};
		const scheduleNextCheck = () => {
			let checkedThisRound = false;
			const runOnce = () => {
				if (checkedThisRound || settled) { return; }
				checkedThisRound = true;
				check();
			};
			if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(runOnce); }
			setTimeout(runOnce, ${WAIT_SAFETY_TICK_MS});
		};
		const check = () => {
			if (settled) { return; }
			const value = evaluatePredicate();
			if (value) { settle(value); return; }
			if (Date.now() >= deadline) { settle(${JSON.stringify(WAIT_TIMED_OUT_SENTINEL)}); return; }
			scheduleNextCheck();
		};
		check();
	});
})()`;
}

/** Resolved instead of the page's answer when the host backstop fires first. */
const HOST_BACKSTOP_TIMED_OUT = Symbol('gumbox host backstop timed out');

async function raceHostBackstop(
	pageAnswer: Promise<unknown>,
	backstopMs: number,
): Promise<unknown> {
	let backstopTimer: ReturnType<typeof setTimeout> | undefined;
	const backstop = new Promise<typeof HOST_BACKSTOP_TIMED_OUT>((resolve) => {
		backstopTimer = setTimeout(() => resolve(HOST_BACKSTOP_TIMED_OUT), backstopMs);
	});
	try {
		// Promise.race subscribes to both, so a late page rejection after the
		// backstop fires is still absorbed instead of becoming unhandled.
		return await Promise.race([pageAnswer, backstop]);
	} finally {
		clearTimeout(backstopTimer);
	}
}

/** Signals that the wait's execution context died before the page answered. */
const EXECUTION_CONTEXT_GONE = Symbol('gumbox execution context gone');

export type InPageWaitOptions = {
	/** Page-side predicate; its first truthy value resolves the wait. */
	predicateExpression: string;
	timeoutMs: number;
	/** Error message used for both the in-page and host-side timeout paths. */
	describeTimeout(): string;
	/** Runtime.evaluate (awaitPromise) boundary, injected so it is testable. */
	evaluateExpression(expression: string): Promise<unknown>;
	/**
	 * Subscribes to the page's context-destroyed events; returns unsubscribe.
	 * Needed because Chrome never answers an awaitPromise evaluate whose
	 * context died — the in-flight wait must be abandoned on this signal.
	 */
	onExecutionContextGone?(listener: () => void): () => void;
	hostBackstopSlackMs?: number;
	contextRetryPauseMs?: number;
};

/**
 * Bounded, event-driven wait on an in-page predicate: a single
 * Runtime.evaluate awaits the predicate inside the page instead of the host
 * polling round-trips.
 *
 * Two non-obvious constraints hold here:
 * - Navigation semantic: a navigation destroys the in-page promise with its
 *   execution context (the evaluate call hangs or rejects). The wait retries
 *   against the new document with the remaining time budget, preserving the
 *   navigation-tolerant behavior of the previous host-side poll.
 * - Host backstop: the in-page deadline is authoritative, but a hung or
 *   silently-discarded page must not hang the host, so each evaluate is raced
 *   against a host timer slightly above the remaining budget.
 */
export async function waitForInPagePredicate(options: InPageWaitOptions): Promise<unknown> {
	const {
		predicateExpression,
		timeoutMs,
		describeTimeout,
		evaluateExpression,
		onExecutionContextGone,
		hostBackstopSlackMs = HOST_BACKSTOP_SLACK_MS,
		contextRetryPauseMs = CONTEXT_RETRY_PAUSE_MS,
	} = options;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new Error(describeTimeout());
		}
		let unsubscribeContextGone: (() => void) | undefined;
		let outcome: unknown;
		try {
			// Subscribe before evaluating so a navigation racing the evaluate
			// command is never missed.
			const contextGone = new Promise<typeof EXECUTION_CONTEXT_GONE>((resolve) => {
				unsubscribeContextGone = onExecutionContextGone?.(() =>
					resolve(EXECUTION_CONTEXT_GONE),
				);
			});
			const pageAnswer = Promise.race([
				evaluateExpression(buildInPageWaitExpression(predicateExpression, remainingMs)),
				contextGone,
			]);
			outcome = await raceHostBackstop(pageAnswer, remainingMs + hostBackstopSlackMs);
		} catch {
			// A rejected evaluate means the context died mid-wait too.
			outcome = EXECUTION_CONTEXT_GONE;
		} finally {
			unsubscribeContextGone?.();
		}
		if (outcome === EXECUTION_CONTEXT_GONE) {
			// The pause keeps the retry from spinning the CDP channel while
			// the new document attaches; the deadline above bounds the loop.
			await delay(contextRetryPauseMs);
			continue;
		}
		if (outcome === WAIT_TIMED_OUT_SENTINEL || outcome === HOST_BACKSTOP_TIMED_OUT) {
			throw new Error(describeTimeout());
		}
		return outcome;
	}
}

/**
 * One console argument as receipt text: primitives print their raw value so
 * recorded console messages stay substring-assertable (boxes and tests match
 * fragments of the text), everything else falls back to the remote object
 * description.
 */
export function consoleArgumentText(argument: CdpRemoteObject): string {
	if (argument.unserializableValue !== undefined) {
		return argument.unserializableValue;
	}
	// CDP frames arrive as parsed JSON, so a present value is JSON-safe.
	if (argument.value !== undefined) {
		if (typeof argument.value === 'string') {
			return argument.value;
		}
		return JSON.stringify(argument.value);
	}
	return argument.description ?? argument.type ?? '';
}

/** First line of the page-side exception, mirroring a thrown Error's message. */
function pageExceptionMessage(details: CdpExceptionDetails): string {
	const exception = details.exception;
	const description =
		exception?.description ??
		(exception?.value !== undefined
			? String(exception.value)
			: (details.text ?? 'Unhandled page exception'));
	return description.split('\n')[0]!;
}

/** Bare `outerHTML` drops the doctype; serialize and re-attach it. */
const PAGE_CONTENT_EXPRESSION = `(() => {
	const doctype = document.doctype === null
		? null
		: new XMLSerializer().serializeToString(document.doctype);
	const root = document.documentElement;
	return { doctype, html: root === null ? '' : root.outerHTML };
})()`;

export function composePageContent(parts: { doctype: string | null; html: string }): string {
	if (parts.doctype === null || parts.doctype === '') {
		return parts.html;
	}
	return `${parts.doctype}\n${parts.html}`;
}

/**
 * Actionability probe + click point in one page-side pass: the element must
 * exist, be rendered (non-empty rect, not display:none/visibility:hidden) and
 * not be disabled. Scrolls it into view so the returned viewport coordinates
 * are dispatchable.
 */
function clickPointExpression(selector: string): string {
	return `(() => {
	const element = document.querySelector(${JSON.stringify(selector)});
	if (element === null) { return null; }
	if (element.disabled === true) { return null; }
	const style = getComputedStyle(element);
	if (style.display === 'none' || style.visibility === 'hidden') { return null; }
	element.scrollIntoView({ block: 'center', inline: 'center' });
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) { return null; }
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;
}

function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

type CdpPageWiring = {
	pageConnection: CdpConnection;
	/** Target.closeTarget only answers on the browser-level connection. */
	browserConnection: CdpConnection;
	targetId: string;
	writeBinaryFile(filePath: string, bytes: Uint8Array): Promise<void>;
};

async function createCdpPage(wiring: CdpPageWiring): Promise<GumboxBrowserPage> {
	const { pageConnection, browserConnection, targetId, writeBinaryFile } = wiring;

	await pageConnection.send('Page.enable');
	await pageConnection.send('Runtime.enable');
	await pageConnection.send('Network.enable');
	const frameTree = await pageConnection.send('Page.getFrameTree');
	const mainFrameId =
		(frameTree.frameTree as { frame?: { id?: string } } | undefined)?.frame?.id ?? null;

	// One CDP listener per event, fanned out to adapter listeners. Evidence
	// listeners register before goto(), and onNavigated registers after the
	// initial load on purpose (see browser.ts), so dispatching through these
	// arrays preserves that contract.
	const loadWaiters = new Set<() => void>();
	pageConnection.on('Page.loadEventFired', () => {
		const waiters = [...loadWaiters];
		loadWaiters.clear();
		for (const waiter of waiters) {
			waiter();
		}
	});

	// Navigation announces itself with these Runtime events. In-flight
	// in-page waits hang when their context dies (Chrome never answers the
	// evaluate), so each wait subscribes here to abandon and retry.
	const executionContextGoneListeners = new Set<() => void>();
	const notifyExecutionContextGone = (): void => {
		// Listeners only resolve promises here; their unsubscribe runs on a
		// later microtask, so iterating the live Set is safe.
		for (const listener of executionContextGoneListeners) {
			listener();
		}
	};
	pageConnection.on('Runtime.executionContextsCleared', notifyExecutionContextGone);
	pageConnection.on('Runtime.executionContextDestroyed', notifyExecutionContextGone);
	const subscribeExecutionContextGone = (listener: () => void): (() => void) => {
		executionContextGoneListeners.add(listener);
		return () => executionContextGoneListeners.delete(listener);
	};

	/** Resolves on the next load event; rejects after the navigation bound. */
	const nextLoadEvent = (action: string): { loaded: Promise<void>; cancel(): void } => {
		let cancel = (): void => undefined;
		const loaded = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				loadWaiters.delete(waiter);
				reject(
					new Error(
						`${action} did not reach the load event within ${NAVIGATION_TIMEOUT_MS}ms.`,
					),
				);
			}, NAVIGATION_TIMEOUT_MS);
			const waiter = (): void => {
				clearTimeout(timer);
				resolve();
			};
			loadWaiters.add(waiter);
			cancel = (): void => {
				clearTimeout(timer);
				loadWaiters.delete(waiter);
				resolve();
			};
		});
		return { loaded, cancel };
	};

	const evaluateExpression = async (expression: string): Promise<unknown> => {
		const evaluation = await pageConnection.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		const exceptionDetails = evaluation.exceptionDetails as CdpExceptionDetails | undefined;
		if (exceptionDetails !== undefined) {
			throw new Error(pageExceptionMessage(exceptionDetails));
		}
		return (evaluation.result as CdpRemoteObject | undefined)?.value;
	};

	const navigateAndAwaitLoad = async (
		action: string,
		navigate: () => Promise<Record<string, unknown>>,
	): Promise<void> => {
		// The waiter registers before the command so a load event racing the
		// command response is never missed.
		const load = nextLoadEvent(action);
		let outcome: Record<string, unknown>;
		try {
			outcome = await navigate();
		} catch (error) {
			load.cancel();
			throw error;
		}
		const errorText = outcome.errorText;
		if (typeof errorText === 'string' && errorText !== '') {
			load.cancel();
			throw new Error(`${action} failed: ${errorText}`);
		}
		await load.loaded;
	};

	// requestId -> request facts, evicted once the request settles either way.
	const inflightRequests = new Map<string, { url: string; method: string }>();
	pageConnection.on('Network.requestWillBeSent', (params) => {
		const requestId = params.requestId as string;
		const request = params.request as { url?: string; method?: string } | undefined;
		inflightRequests.set(requestId, {
			url: request?.url ?? '',
			method: request?.method ?? 'GET',
		});
	});
	pageConnection.on('Network.loadingFinished', (params) => {
		inflightRequests.delete(params.requestId as string);
	});

	return {
		goto: (url) =>
			navigateAndAwaitLoad(`goto ${url}`, () =>
				pageConnection.send('Page.navigate', { url }),
			),
		reload: () => navigateAndAwaitLoad('reload', () => pageConnection.send('Page.reload')),
		content: async () => {
			const parts = await evaluateExpression(PAGE_CONTENT_EXPRESSION);
			return composePageContent(parts as { doctype: string | null; html: string });
		},
		screenshot: async (filePath) => {
			const capture = await pageConnection.send('Page.captureScreenshot', { format: 'png' });
			await writeBinaryFile(filePath, decodeBase64(capture.data as string));
		},
		evaluate: (expression) => evaluateExpression(expression),
		waitForExpression: async (expression, timeoutMs) => {
			await waitForInPagePredicate({
				predicateExpression: `!!(${expression})`,
				timeoutMs,
				describeTimeout: () => `waitForExpression timed out after ${timeoutMs}ms.`,
				evaluateExpression,
				onExecutionContextGone: subscribeExecutionContextGone,
			});
		},
		click: async (selector, timeoutMs) => {
			// The actionability probe waits in-page and resolves the
			// scrolled-into-view click point for the dispatch below.
			const clickPoint = (await waitForInPagePredicate({
				predicateExpression: clickPointExpression(selector),
				timeoutMs,
				describeTimeout: () =>
					`click('${selector}') timed out after ${timeoutMs}ms: no visible, enabled element matched.`,
				evaluateExpression,
				onExecutionContextGone: subscribeExecutionContextGone,
			})) as { x: number; y: number };
			const mouseEvent = {
				x: clickPoint.x,
				y: clickPoint.y,
				button: 'left',
				clickCount: 1,
			};
			await pageConnection.send('Input.dispatchMouseEvent', {
				...mouseEvent,
				type: 'mousePressed',
			});
			await pageConnection.send('Input.dispatchMouseEvent', {
				...mouseEvent,
				type: 'mouseReleased',
			});
		},
		onConsoleMessage: (listener) => {
			pageConnection.on('Runtime.consoleAPICalled', (params) => {
				const args = (params.args as CdpRemoteObject[] | undefined) ?? [];
				listener({
					level: (params.type as string | undefined) ?? 'log',
					text: args.map(consoleArgumentText).join(' '),
				});
			});
		},
		onPageError: (listener) => {
			pageConnection.on('Runtime.exceptionThrown', (params) => {
				const details = (params.exceptionDetails ?? {}) as CdpExceptionDetails;
				listener({ message: pageExceptionMessage(details) });
			});
		},
		onRequestFailed: (listener) => {
			pageConnection.on('Network.loadingFailed', (params) => {
				const requestId = params.requestId as string;
				const request = inflightRequests.get(requestId);
				if (request === undefined) {
					return;
				}
				inflightRequests.delete(requestId);
				const errorText = params.errorText as string | undefined;
				listener({
					url: request.url,
					method: request.method,
					reason: errorText === undefined || errorText === '' ? null : errorText,
				});
			});
		},
		onNavigated: (listener) => {
			pageConnection.on('Page.frameNavigated', (params) => {
				const frame = params.frame as { parentId?: string; url?: string } | undefined;
				if (frame?.parentId === undefined && frame?.url !== undefined) {
					listener(frame.url);
				}
			});
			// Same-document navigations (history.pushState, hash changes) are
			// real navigations to a box even though no document loads.
			pageConnection.on('Page.navigatedWithinDocument', (params) => {
				const frameId = params.frameId as string | undefined;
				if (mainFrameId === null || frameId === mainFrameId) {
					listener((params.url as string | undefined) ?? '');
				}
			});
		},
		close: async () => {
			try {
				await browserConnection.send('Target.closeTarget', { targetId });
			} finally {
				pageConnection.close();
			}
		},
	};
}

/**
 * A browser-level CDP connection that mints per-context sessions. One
 * connection serves many GumboxBrowserSessions over the lifetime of the
 * pooled browser process.
 */
export type CdpBrowserConnection = {
	/**
	 * Creates one isolated browsing state (cookies/storage/cache) and adapts
	 * it as a GumboxBrowserSession. The browser context IS the session:
	 * closing the session disposes the context only — the browser process
	 * belongs to the pool and outlives every session.
	 */
	createContextSession(): Promise<GumboxBrowserSession>;
	/** Closes the browser-level socket; the process is owned by `endpoint.shutdown()`. */
	close(): void;
};

export type ConnectCdpBrowserOptions = {
	/** Fires when the browser-level socket closes — process death included. */
	onConnectionLost?(): void;
	/** Injectable transport for unit tests; defaults to the real WebSocket. */
	openSocket?(url: string): Promise<CdpSocket>;
};

export async function connectCdpBrowser(
	endpoint: LaunchedBrowserEndpoint,
	options: ConnectCdpBrowserOptions = {},
): Promise<CdpBrowserConnection> {
	const openSocket = options.openSocket ?? openCdpSocket;
	const browserSocket = await openSocket(endpoint.webSocketDebuggerUrl);
	if (options.onConnectionLost !== undefined) {
		browserSocket.onClose(options.onConnectionLost);
	}
	const browserConnection = createCdpConnection(browserSocket);
	// Page targets attach on sibling WebSocket paths of the browser endpoint.
	const endpointHost = new URL(endpoint.webSocketDebuggerUrl).host;

	const createContextSession = async (): Promise<GumboxBrowserSession> => {
		const created = await browserConnection.send('Target.createBrowserContext');
		const browserContextId = created.browserContextId as string;
		return {
			newPage: async () => {
				const target = await browserConnection.send('Target.createTarget', {
					url: 'about:blank',
					browserContextId,
				});
				const targetId = target.targetId as string;
				const pageConnection = createCdpConnection(
					await openSocket(`ws://${endpointHost}/devtools/page/${targetId}`),
				);
				return createCdpPage({
					pageConnection,
					browserConnection,
					targetId,
					writeBinaryFile: endpoint.writeBinaryFile,
				});
			},
			close: async () => {
				// Disposing the context wipes this session's cookies/storage and
				// closes its remaining targets. Never Browser.close and never
				// endpoint.shutdown() here — the process is shared by the pool
				// and only the pool (or the interrupt handler) may end it.
				await browserConnection.send('Target.disposeBrowserContext', {
					browserContextId,
				});
			},
		};
	};

	return {
		createContextSession,
		close: () => browserConnection.close(),
	};
}
