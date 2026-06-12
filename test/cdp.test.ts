import { describe, expect, test } from 'vitest';
import type { GumboxBrowserSession } from '../src/browser.ts';
import {
	discoverBrowserExecutable,
	knownBrowserExecutables,
	playwrightCacheExecutables,
} from '../src/cli/browser-discovery.ts';
import { createHostBrowser } from '../src/cli/browser-host.ts';
import {
	buildInPageWaitExpression,
	composePageContent,
	connectCdpBrowser,
	consoleArgumentText,
	WAIT_TIMED_OUT_SENTINEL,
	waitForInPagePredicate,
} from '../src/cli/cdp-browser.ts';
import type { CdpBrowserConnection, LaunchedBrowserEndpoint } from '../src/cli/cdp-browser.ts';
import { createCdpConnection } from '../src/cli/cdp-client.ts';
import type { CdpSocket } from '../src/cli/cdp-client.ts';

function envFrom(values: Record<string, string>): (name: string) => string | undefined {
	return (name) => values[name];
}

describe('browser discovery', () => {
	test('macOS candidates cover Chrome, Edge, and Chromium app binaries', () => {
		const candidates = knownBrowserExecutables('darwin', envFrom({ HOME: '/Users/dev' }));
		expect(candidates).toContain(
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		);
		expect(candidates).toContain(
			'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
		);
		expect(candidates).toContain('/Applications/Chromium.app/Contents/MacOS/Chromium');
		// Per-user installs are still discoverable.
		expect(candidates).toContain(
			'/Users/dev/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		);
	});

	test('Linux candidates pair every PATH directory with every known binary name', () => {
		const candidates = knownBrowserExecutables(
			'linux',
			envFrom({ PATH: '/usr/bin:/usr/local/bin' }),
		);
		expect(candidates).toContain('/usr/bin/google-chrome');
		expect(candidates).toContain('/usr/bin/google-chrome-stable');
		expect(candidates).toContain('/usr/bin/chromium');
		expect(candidates).toContain('/usr/bin/chromium-browser');
		expect(candidates).toContain('/usr/bin/microsoft-edge');
		expect(candidates).toContain('/usr/local/bin/google-chrome');
		// Chrome's package install location is covered even when off PATH.
		expect(candidates).toContain('/opt/google/chrome/chrome');
	});

	test('Windows candidates come from Program Files x2 and LocalAppData', () => {
		const candidates = knownBrowserExecutables(
			'windows',
			envFrom({
				PROGRAMFILES: 'C:\\Program Files',
				'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
				LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
			}),
		);
		expect(candidates).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
		expect(candidates).toContain(
			'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
		);
		expect(candidates).toContain(
			'C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
		);
		expect(candidates).toContain(
			'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
		);
	});

	test('returns the first known candidate that exists on disk', async () => {
		const executable = await discoverBrowserExecutable({
			platform: 'linux',
			readEnv: envFrom({ PATH: '/usr/bin' }),
			isExecutableFile: (filePath) => Promise.resolve(filePath === '/usr/bin/chromium'),
		});
		expect(executable).toBe('/usr/bin/chromium');
	});

	test('an explicit GUMBOX_BROWSER_PATH override wins over known paths', async () => {
		const executable = await discoverBrowserExecutable({
			platform: 'darwin',
			readEnv: envFrom({ GUMBOX_BROWSER_PATH: '/opt/custom/chrome' }),
			isExecutableFile: (filePath) => Promise.resolve(filePath === '/opt/custom/chrome'),
		});
		expect(executable).toBe('/opt/custom/chrome');
	});

	test('a missing GUMBOX_BROWSER_PATH override fails closed instead of falling through', async () => {
		await expect(
			discoverBrowserExecutable({
				platform: 'darwin',
				readEnv: envFrom({ GUMBOX_BROWSER_PATH: '/opt/custom/chrome' }),
				isExecutableFile: () => Promise.resolve(false),
			}),
		).rejects.toThrow(/GUMBOX_BROWSER_PATH.*\/opt\/custom\/chrome/s);
	});

	test('no browser anywhere fails closed with an actionable install message', async () => {
		await expect(
			discoverBrowserExecutable({
				platform: 'darwin',
				readEnv: envFrom({}),
				isExecutableFile: () => Promise.resolve(false),
			}),
		).rejects.toThrow(/Install Google Chrome, Microsoft Edge, or Chromium/);
	});
});

describe('playwright cache fallback', () => {
	function cacheListing(values: Record<string, string[]>): (dir: string) => Promise<string[]> {
		return (dir) => {
			const names = values[dir];
			if (names === undefined) {
				return Promise.reject(new Error(`ENOENT: ${dir}`));
			}
			return Promise.resolve(names);
		};
	}

	test('macOS cache yields full-Chromium app binaries for both mac layouts', async () => {
		const candidates = await playwrightCacheExecutables(
			'darwin',
			envFrom({ HOME: '/Users/dev' }),
			cacheListing({
				'/Users/dev/Library/Caches/ms-playwright': ['chromium-1181', 'ffmpeg-1011'],
			}),
		);
		expect(candidates).toEqual([
			'/Users/dev/Library/Caches/ms-playwright/chromium-1181/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
			'/Users/dev/Library/Caches/ms-playwright/chromium-1181/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
		]);
	});

	test('Linux cache prefers XDG_CACHE_HOME and falls back to ~/.cache', async () => {
		const fromXdg = await playwrightCacheExecutables(
			'linux',
			envFrom({ HOME: '/home/dev', XDG_CACHE_HOME: '/custom/cache' }),
			cacheListing({ '/custom/cache/ms-playwright': ['chromium-1181'] }),
		);
		expect(fromXdg).toEqual(['/custom/cache/ms-playwright/chromium-1181/chrome-linux/chrome']);

		const fromHome = await playwrightCacheExecutables(
			'linux',
			envFrom({ HOME: '/home/dev' }),
			cacheListing({ '/home/dev/.cache/ms-playwright': ['chromium-1181'] }),
		);
		expect(fromHome).toEqual([
			'/home/dev/.cache/ms-playwright/chromium-1181/chrome-linux/chrome',
		]);
	});

	test('Windows cache resolves under LOCALAPPDATA', async () => {
		const candidates = await playwrightCacheExecutables(
			'windows',
			envFrom({ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }),
			cacheListing({
				'C:\\Users\\dev\\AppData\\Local\\ms-playwright': ['chromium-1181'],
			}),
		);
		expect(candidates).toEqual([
			'C:\\Users\\dev\\AppData\\Local\\ms-playwright\\chromium-1181\\chrome-win\\chrome.exe',
		]);
	});

	test('the highest revision wins numerically, not lexicographically', async () => {
		const candidates = await playwrightCacheExecutables(
			'linux',
			envFrom({ HOME: '/home/dev' }),
			cacheListing({
				'/home/dev/.cache/ms-playwright': ['chromium-999', 'chromium-1181'],
			}),
		);
		expect(candidates[0]).toBe(
			'/home/dev/.cache/ms-playwright/chromium-1181/chrome-linux/chrome',
		);
		expect(candidates[1]).toBe(
			'/home/dev/.cache/ms-playwright/chromium-999/chrome-linux/chrome',
		);
	});

	test('headless shells and non-chromium downloads are never candidates', async () => {
		// chromium_headless_shell-* cannot run headed, so it is not a
		// full-feature substitute — discovery skips it deliberately.
		const candidates = await playwrightCacheExecutables(
			'linux',
			envFrom({ HOME: '/home/dev' }),
			cacheListing({
				'/home/dev/.cache/ms-playwright': [
					'chromium_headless_shell-1181',
					'firefox-1495',
					'webkit-2215',
					'ffmpeg-1011',
				],
			}),
		);
		expect(candidates).toEqual([]);
	});

	test('a missing cache directory yields no candidates instead of failing', async () => {
		const candidates = await playwrightCacheExecutables(
			'darwin',
			envFrom({ HOME: '/Users/dev' }),
			cacheListing({}),
		);
		expect(candidates).toEqual([]);
	});

	test('a system browser still wins over the playwright cache', async () => {
		const cachedChromium =
			'/Users/dev/Library/Caches/ms-playwright/chromium-1181/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium';
		const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
		const executable = await discoverBrowserExecutable({
			platform: 'darwin',
			readEnv: envFrom({ HOME: '/Users/dev' }),
			isExecutableFile: (filePath) =>
				Promise.resolve(filePath === systemChrome || filePath === cachedChromium),
			listDirectoryNames: cacheListing({
				'/Users/dev/Library/Caches/ms-playwright': ['chromium-1181'],
			}),
		});
		expect(executable).toBe(systemChrome);
	});

	test('with no system browser, discovery falls back to the playwright cache', async () => {
		const cachedChromium =
			'/Users/dev/Library/Caches/ms-playwright/chromium-1181/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium';
		const executable = await discoverBrowserExecutable({
			platform: 'darwin',
			readEnv: envFrom({ HOME: '/Users/dev' }),
			isExecutableFile: (filePath) => Promise.resolve(filePath === cachedChromium),
			listDirectoryNames: cacheListing({
				'/Users/dev/Library/Caches/ms-playwright': ['chromium-1140', 'chromium-1181'],
			}),
		});
		expect(executable).toBe(cachedChromium);
	});

	test('GUMBOX_BROWSER_PATH still fails closed even with a cached chromium', async () => {
		const cachedChromium =
			'/Users/dev/Library/Caches/ms-playwright/chromium-1181/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium';
		await expect(
			discoverBrowserExecutable({
				platform: 'darwin',
				readEnv: envFrom({ HOME: '/Users/dev', GUMBOX_BROWSER_PATH: '/typo/chrome' }),
				isExecutableFile: (filePath) => Promise.resolve(filePath === cachedChromium),
				listDirectoryNames: cacheListing({
					'/Users/dev/Library/Caches/ms-playwright': ['chromium-1181'],
				}),
			}),
		).rejects.toThrow(/GUMBOX_BROWSER_PATH/);
	});
});

type SentMessage = {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
};

/** In-memory CdpSocket: captures sends and lets the test push frames back. */
function createFakeSocket() {
	const sent: SentMessage[] = [];
	const messageListeners: Array<(data: string) => void> = [];
	const closeListeners: Array<() => void> = [];
	let closed = false;
	const socket: CdpSocket = {
		send: (data) => {
			sent.push(JSON.parse(data) as SentMessage);
		},
		close: () => {
			closed = true;
			for (const listener of closeListeners) {
				listener();
			}
		},
		onMessage: (listener) => {
			messageListeners.push(listener);
		},
		onClose: (listener) => {
			closeListeners.push(listener);
		},
	};
	const receive = (frame: Record<string, unknown>): void => {
		for (const listener of messageListeners) {
			listener(JSON.stringify(frame));
		}
	};
	return { socket, sent, receive, isClosed: () => closed };
}

describe('cdp connection', () => {
	test('correlates responses to calls by id, even out of order', async () => {
		const { socket, sent, receive } = createFakeSocket();
		const connection = createCdpConnection(socket);

		const first = connection.send('Page.navigate', { url: 'http://localhost/' });
		const second = connection.send('Runtime.evaluate', { expression: '1 + 1' });
		expect(sent).toHaveLength(2);
		expect(sent[0]!.method).toBe('Page.navigate');
		expect(sent[1]!.params).toEqual({ expression: '1 + 1' });

		receive({ id: sent[1]!.id, result: { result: { value: 2 } } });
		receive({ id: sent[0]!.id, result: { frameId: 'frame-1' } });

		expect(await first).toEqual({ frameId: 'frame-1' });
		expect(await second).toEqual({ result: { value: 2 } });
	});

	test('a CDP error response rejects with the method and message', async () => {
		const { socket, sent, receive } = createFakeSocket();
		const connection = createCdpConnection(socket);

		const call = connection.send('Page.navigate', { url: 'nope' });
		receive({ id: sent[0]!.id, error: { code: -32000, message: 'Cannot navigate' } });

		await expect(call).rejects.toThrow(/Page\.navigate.*Cannot navigate/);
	});

	test('events dispatch to every listener registered for the method', () => {
		const { socket, receive } = createFakeSocket();
		const connection = createCdpConnection(socket);

		const seen: unknown[] = [];
		connection.on('Page.loadEventFired', (params) => seen.push(params));
		connection.on('Page.loadEventFired', (params) => seen.push(params));
		connection.on('Runtime.consoleAPICalled', (params) => seen.push(params));

		receive({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
		expect(seen).toEqual([{ timestamp: 1 }, { timestamp: 1 }]);
	});

	test('closing the socket rejects every pending call', async () => {
		const { socket, isClosed } = createFakeSocket();
		const connection = createCdpConnection(socket);

		const pending = connection.send('Browser.getVersion');
		connection.close();

		await expect(pending).rejects.toThrow(/closed/);
		expect(isClosed()).toBe(true);
	});
});

describe('cdp session routing (flatten)', () => {
	test('two sessions interleave calls on one socket with globally unique ids', async () => {
		const { socket, sent, receive } = createFakeSocket();
		const connection = createCdpConnection(socket);
		const sessionA = connection.session('session-a');
		const sessionB = connection.session('session-b');

		const fromA = sessionA.send('Runtime.evaluate', { expression: 'a' });
		const fromB = sessionB.send('Runtime.evaluate', { expression: 'b' });
		const fromRoot = connection.send('Target.getTargets');

		expect(sent).toHaveLength(3);
		expect(sent[0]!.sessionId).toBe('session-a');
		expect(sent[1]!.sessionId).toBe('session-b');
		expect(sent[2]!.sessionId).toBeUndefined();
		// One global monotonic id sequence keeps ids unique across sessions.
		expect(new Set(sent.map((message) => message.id)).size).toBe(3);

		// Responses arrive out of order; each resolves its own session's call.
		receive({ id: sent[1]!.id, sessionId: 'session-b', result: { result: { value: 'b!' } } });
		receive({ id: sent[0]!.id, sessionId: 'session-a', result: { result: { value: 'a!' } } });
		receive({ id: sent[2]!.id, result: { targetInfos: [] } });

		expect(await fromA).toEqual({ result: { value: 'a!' } });
		expect(await fromB).toEqual({ result: { value: 'b!' } });
		expect(await fromRoot).toEqual({ targetInfos: [] });
	});

	test('events dispatch by sessionId and method, never across sessions', () => {
		const { socket, receive } = createFakeSocket();
		const connection = createCdpConnection(socket);
		const sessionA = connection.session('session-a');
		const sessionB = connection.session('session-b');

		const seenByA: unknown[] = [];
		const seenByB: unknown[] = [];
		const seenByRoot: unknown[] = [];
		sessionA.on('Page.loadEventFired', (params) => seenByA.push(params));
		sessionB.on('Page.loadEventFired', (params) => seenByB.push(params));
		connection.on('Target.targetCreated', (params) => seenByRoot.push(params));

		receive({
			method: 'Page.loadEventFired',
			sessionId: 'session-a',
			params: { timestamp: 1 },
		});
		receive({
			method: 'Page.loadEventFired',
			sessionId: 'session-b',
			params: { timestamp: 2 },
		});
		receive({ method: 'Target.targetCreated', params: { targetInfo: { type: 'page' } } });
		// A session-tagged event must not leak to root listeners of the method.
		receive({
			method: 'Target.targetCreated',
			sessionId: 'session-a',
			params: { stray: true },
		});

		expect(seenByA).toEqual([{ timestamp: 1 }]);
		expect(seenByB).toEqual([{ timestamp: 2 }]);
		expect(seenByRoot).toEqual([{ targetInfo: { type: 'page' } }]);
	});

	test('socket close rejects pending calls in every session and the root', async () => {
		const { socket } = createFakeSocket();
		const connection = createCdpConnection(socket);
		const sessionA = connection.session('session-a');
		const sessionB = connection.session('session-b');

		const fromA = sessionA.send('Page.enable');
		const fromB = sessionB.send('Page.enable');
		const fromRoot = connection.send('Browser.getVersion');
		socket.close();

		await expect(fromA).rejects.toThrow(/closed/);
		await expect(fromB).rejects.toThrow(/closed/);
		await expect(fromRoot).rejects.toThrow(/closed/);
	});

	test('closing a session rejects only its calls and never the shared socket', async () => {
		const { socket, sent, receive, isClosed } = createFakeSocket();
		const connection = createCdpConnection(socket);
		const sessionA = connection.session('session-a');
		const sessionB = connection.session('session-b');
		const eventsAfterClose: unknown[] = [];
		sessionA.on('Page.loadEventFired', (params) => eventsAfterClose.push(params));

		const fromA = sessionA.send('Page.enable');
		const fromB = sessionB.send('Page.enable');
		sessionA.close();

		await expect(fromA).rejects.toThrow(/closed/);
		// The shared socket carries every other session: it must stay open.
		expect(isClosed()).toBe(false);

		// The sibling session and the root connection stay fully usable.
		receive({ id: sent[1]!.id, sessionId: 'session-b', result: { ok: true } });
		await expect(fromB).resolves.toEqual({ ok: true });
		const fromRoot = connection.send('Target.getTargets');
		receive({ id: sent[2]!.id, result: { targetInfos: [] } });
		await expect(fromRoot).resolves.toEqual({ targetInfos: [] });

		// The closed session refuses new sends and drops its event listeners.
		await expect(sessionA.send('Page.enable')).rejects.toThrow(/closed/);
		receive({
			method: 'Page.loadEventFired',
			sessionId: 'session-a',
			params: { timestamp: 3 },
		});
		expect(eventsAfterClose).toEqual([]);
	});
});

describe('console argument stringification', () => {
	test('primitive values use the value itself', () => {
		expect(consoleArgumentText({ type: 'string', value: 'intentional console noise' })).toBe(
			'intentional console noise',
		);
		expect(consoleArgumentText({ type: 'number', value: 42 })).toBe('42');
		expect(consoleArgumentText({ type: 'boolean', value: false })).toBe('false');
		expect(consoleArgumentText({ type: 'object', subtype: 'null', value: null })).toBe('null');
	});

	test('unserializable and missing values degrade readably', () => {
		expect(consoleArgumentText({ type: 'number', unserializableValue: 'NaN' })).toBe('NaN');
		expect(consoleArgumentText({ type: 'undefined' })).toBe('undefined');
	});

	test('objects fall back to the remote object description', () => {
		expect(
			consoleArgumentText({ type: 'object', value: { a: 1 }, description: 'Object' }),
		).toBe('{"a":1}');
		expect(consoleArgumentText({ type: 'function', description: 'function noop() {}' })).toBe(
			'function noop() {}',
		);
	});
});

/**
 * Runs a built wait expression in this runtime the way Runtime.evaluate
 * would in the page: compile the source, get back its promise.
 */
function runWaitExpression(expression: string): Promise<unknown> {
	return new Function(`return (${expression});`)() as Promise<unknown>;
}

/** The in-page deadline the builder embedded, recovered from the source. */
function embeddedBudgetMs(expression: string): number {
	const match = /Date\.now\(\) \+ (\d+)/.exec(expression);
	expect(match, 'embedded deadline').not.toBeNull();
	return Number(match![1]);
}

describe('in-page wait expression', () => {
	test('resolves the predicate value once it turns truthy', async () => {
		const state = { ready: false };
		(globalThis as Record<string, unknown>).__gumboxWaitTestState = state;
		try {
			const expression = buildInPageWaitExpression(
				'(globalThis.__gumboxWaitTestState.ready ? { found: true } : null)',
				5_000,
			);
			const pendingWait = runWaitExpression(expression);
			setTimeout(() => {
				state.ready = true;
			}, 20);
			await expect(pendingWait).resolves.toEqual({ found: true });
		} finally {
			delete (globalThis as Record<string, unknown>).__gumboxWaitTestState;
		}
	});

	test('resolves the timeout sentinel when the predicate never turns truthy', async () => {
		const expression = buildInPageWaitExpression('false', 30);
		await expect(runWaitExpression(expression)).resolves.toBe(WAIT_TIMED_OUT_SENTINEL);
	});

	test('a throwing predicate counts as not-ready instead of failing the wait', async () => {
		const expression = buildInPageWaitExpression('(undefined).never', 30);
		await expect(runWaitExpression(expression)).resolves.toBe(WAIT_TIMED_OUT_SENTINEL);
	});

	test('the wrapper leaks none of its helpers into globals', async () => {
		const expression = buildInPageWaitExpression('true', 1_000);
		await expect(runWaitExpression(expression)).resolves.toBe(true);
		const helperNames = [
			'deadline',
			'settled',
			'settle',
			'check',
			'scheduleNextCheck',
			'evaluatePredicate',
			'runOnce',
		];
		for (const helperName of helperNames) {
			expect(helperName in globalThis, `global '${helperName}'`).toBe(false);
		}
	});
});

describe('in-page predicate wait orchestration', () => {
	test('resolves with the value the page resolves, in one evaluate call', async () => {
		const evaluated: string[] = [];
		const outcome = await waitForInPagePredicate({
			predicateExpression: 'document.title === "ready"',
			timeoutMs: 1_000,
			describeTimeout: () => 'wait timed out',
			evaluateExpression: (expression) => {
				evaluated.push(expression);
				return Promise.resolve({ x: 4, y: 8 });
			},
		});
		expect(outcome).toEqual({ x: 4, y: 8 });
		expect(evaluated).toHaveLength(1);
		expect(evaluated[0]).toContain('document.title === "ready"');
	});

	test('throws the timeout description when the page resolves the sentinel', async () => {
		await expect(
			waitForInPagePredicate({
				predicateExpression: 'false',
				timeoutMs: 1_000,
				describeTimeout: () => 'waitForExpression timed out after 1000ms.',
				evaluateExpression: () => Promise.resolve(WAIT_TIMED_OUT_SENTINEL),
			}),
		).rejects.toThrow('waitForExpression timed out after 1000ms.');
	});

	test('a navigation mid-wait retries on the new document with the remaining budget', async () => {
		// Pins the chosen navigation semantic: the in-page promise dies with
		// its execution context, and the wait retries against the new
		// document using only the time budget that remains.
		const evaluated: string[] = [];
		const outcome = await waitForInPagePredicate({
			predicateExpression: '!!(document.querySelector("#ready"))',
			timeoutMs: 1_000,
			describeTimeout: () => 'wait timed out',
			contextRetryPauseMs: 5,
			evaluateExpression: (expression) => {
				evaluated.push(expression);
				if (evaluated.length === 1) {
					return new Promise((_, reject) => {
						setTimeout(() => reject(new Error('Execution context was destroyed.')), 40);
					});
				}
				return Promise.resolve(true);
			},
		});
		expect(outcome).toBe(true);
		expect(evaluated).toHaveLength(2);
		expect(embeddedBudgetMs(evaluated[1]!)).toBeLessThan(embeddedBudgetMs(evaluated[0]!));
	});

	test('a context-destroyed signal mid-wait abandons the hung evaluate and retries', async () => {
		// Real Chrome behavior: when navigation destroys the context, the
		// awaited in-page promise is collected and the evaluate call never
		// answers — the retry must come from the context-destroyed event.
		let signalContextGone: (() => void) | undefined;
		const evaluated: string[] = [];
		const outcome = await waitForInPagePredicate({
			predicateExpression: 'true',
			timeoutMs: 2_000,
			describeTimeout: () => 'wait timed out',
			contextRetryPauseMs: 5,
			onExecutionContextGone: (listener) => {
				signalContextGone = listener;
				return () => undefined;
			},
			evaluateExpression: (expression) => {
				evaluated.push(expression);
				if (evaluated.length === 1) {
					setTimeout(() => signalContextGone?.(), 20);
					return new Promise<unknown>(() => undefined);
				}
				return Promise.resolve(true);
			},
		});
		expect(outcome).toBe(true);
		expect(evaluated).toHaveLength(2);
		expect(embeddedBudgetMs(evaluated[1]!)).toBeLessThan(embeddedBudgetMs(evaluated[0]!));
	});

	test('repeated context destruction exhausts the budget and throws the timeout', async () => {
		let evaluateCalls = 0;
		await expect(
			waitForInPagePredicate({
				predicateExpression: 'true',
				timeoutMs: 60,
				describeTimeout: () => 'wait timed out',
				contextRetryPauseMs: 10,
				evaluateExpression: () => {
					evaluateCalls++;
					return Promise.reject(new Error('Execution context was destroyed.'));
				},
			}),
		).rejects.toThrow('wait timed out');
		expect(evaluateCalls).toBeGreaterThanOrEqual(2);
	});

	test('a hung page is bounded by the host-side backstop', async () => {
		await expect(
			waitForInPagePredicate({
				predicateExpression: 'true',
				timeoutMs: 40,
				hostBackstopSlackMs: 20,
				describeTimeout: () => "click('#counter') timed out",
				evaluateExpression: () => new Promise<unknown>(() => undefined),
			}),
		).rejects.toThrow("click('#counter') timed out");
	});
});

describe('page content composition', () => {
	test('preserves the doctype above the document element', () => {
		expect(
			composePageContent({ doctype: '<!DOCTYPE html>', html: '<html><body></body></html>' }),
		).toBe('<!DOCTYPE html>\n<html><body></body></html>');
	});

	test('a document without a doctype serializes bare', () => {
		expect(composePageContent({ doctype: null, html: '<html></html>' })).toBe('<html></html>');
	});
});

/**
 * Auto-responding CdpSocket: answers every command on a microtask via the
 * given responder, so adapter code awaiting CDP replies runs to completion.
 */
function createAutoRespondingSocket(respond: (message: SentMessage) => Record<string, unknown>) {
	const sent: SentMessage[] = [];
	const messageListeners: Array<(data: string) => void> = [];
	const closeListeners: Array<() => void> = [];
	let closed = false;
	const socket: CdpSocket = {
		send: (data) => {
			const message = JSON.parse(data) as SentMessage;
			sent.push(message);
			queueMicrotask(() => {
				const frame = JSON.stringify({ id: message.id, result: respond(message) });
				for (const listener of messageListeners) {
					listener(frame);
				}
			});
		},
		close: () => {
			closed = true;
		},
		onMessage: (listener) => {
			messageListeners.push(listener);
		},
		onClose: (listener) => {
			closeListeners.push(listener);
		},
	};
	const loseConnection = (): void => {
		for (const listener of closeListeners) {
			listener();
		}
	};
	return { socket, sent, loseConnection, isClosed: () => closed };
}

function createFakeEndpoint(name = 'fake') {
	let shutdownCalls = 0;
	const endpoint: LaunchedBrowserEndpoint = {
		webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/browser/${name}`,
		writeBinaryFile: () => Promise.resolve(),
		shutdown: () => {
			shutdownCalls++;
			return Promise.resolve();
		},
	};
	return { endpoint, shutdownCount: () => shutdownCalls };
}

/**
 * One browser-level fake socket wired into connectCdpBrowser. Pages ride it
 * as flattened sessions (Target.attachToTarget flatten: true), so the
 * responder mints sessionIds and every frame — page traffic included —
 * arrives on this single socket.
 */
function createBrowserConnectionHarness() {
	let contextCounter = 0;
	let targetCounter = 0;
	let sessionCounter = 0;
	let openedSockets = 0;
	const browserSocket = createAutoRespondingSocket((message) => {
		if (message.method === 'Target.createBrowserContext') {
			contextCounter++;
			return { browserContextId: `context-${contextCounter}` };
		}
		if (message.method === 'Target.createTarget') {
			targetCounter++;
			return { targetId: `target-${targetCounter}` };
		}
		if (message.method === 'Target.attachToTarget') {
			sessionCounter++;
			return { sessionId: `session-${sessionCounter}` };
		}
		return {};
	});
	const openSocket = (): Promise<CdpSocket> => {
		openedSockets++;
		return Promise.resolve(browserSocket.socket);
	};
	return { browserSocket, openSocket, openedSocketCount: () => openedSockets };
}

describe('cdp browser connection (context = session)', () => {
	test('each context session creates and disposes its own browser context', async () => {
		const { browserSocket, openSocket } = createBrowserConnectionHarness();
		const { endpoint, shutdownCount } = createFakeEndpoint();
		const connection = await connectCdpBrowser(endpoint, { openSocket });

		const first = await connection.createContextSession();
		await connection.createContextSession();
		const contextCreations = browserSocket.sent.filter(
			(message) => message.method === 'Target.createBrowserContext',
		);
		expect(contextCreations).toHaveLength(2);

		await first.close();
		const contextDisposals = browserSocket.sent.filter(
			(message) => message.method === 'Target.disposeBrowserContext',
		);
		expect(contextDisposals).toHaveLength(1);
		expect(contextDisposals[0]!.params).toEqual({ browserContextId: 'context-1' });

		// Closing a session never closes the shared browser or its process.
		expect(browserSocket.sent.map((message) => message.method)).not.toContain('Browser.close');
		expect(shutdownCount()).toBe(0);
	});

	test('newPage creates its target inside the session browser context', async () => {
		const { browserSocket, openSocket } = createBrowserConnectionHarness();
		const { endpoint } = createFakeEndpoint();
		const connection = await connectCdpBrowser(endpoint, { openSocket });

		const session = await connection.createContextSession();
		await session.newPage();

		const targetCreation = browserSocket.sent.find(
			(message) => message.method === 'Target.createTarget',
		);
		expect(targetCreation?.params).toMatchObject({
			url: 'about:blank',
			browserContextId: 'context-1',
		});
	});

	test('onConnectionLost fires when the browser socket closes', async () => {
		const { browserSocket, openSocket } = createBrowserConnectionHarness();
		const { endpoint } = createFakeEndpoint();
		let connectionLost = false;
		await connectCdpBrowser(endpoint, {
			openSocket,
			onConnectionLost: () => {
				connectionLost = true;
			},
		});

		browserSocket.loseConnection();
		expect(connectionLost).toBe(true);
	});

	test('newPage attaches as a flattened session on the one shared socket', async () => {
		const { browserSocket, openSocket, openedSocketCount } = createBrowserConnectionHarness();
		const { endpoint } = createFakeEndpoint();
		const connection = await connectCdpBrowser(endpoint, { openSocket });

		const session = await connection.createContextSession();
		await session.newPage();
		await session.newPage();

		const attachments = browserSocket.sent.filter(
			(message) => message.method === 'Target.attachToTarget',
		);
		expect(attachments).toHaveLength(2);
		expect(attachments[0]!.params).toEqual({ targetId: 'target-1', flatten: true });
		expect(attachments[1]!.params).toEqual({ targetId: 'target-2', flatten: true });

		// Page domain enables ride the shared socket tagged by their session.
		const pageEnables = browserSocket.sent.filter(
			(message) => message.method === 'Page.enable',
		);
		expect(pageEnables.map((message) => message.sessionId)).toEqual(['session-1', 'session-2']);

		// Exactly one WebSocket per browser process, never one per page.
		expect(openedSocketCount()).toBe(1);
	});

	test('page close sends Target.closeTarget and never closes the shared socket', async () => {
		const { browserSocket, openSocket } = createBrowserConnectionHarness();
		const { endpoint, shutdownCount } = createFakeEndpoint();
		const connection = await connectCdpBrowser(endpoint, { openSocket });

		const session = await connection.createContextSession();
		const page = await session.newPage();
		await page.close();

		const targetCloses = browserSocket.sent.filter(
			(message) => message.method === 'Target.closeTarget',
		);
		expect(targetCloses).toHaveLength(1);
		expect(targetCloses[0]!.params).toEqual({ targetId: 'target-1' });

		// Closing a page detaches its session locally; the shared socket and
		// the pooled browser process stay alive for every other session.
		expect(browserSocket.isClosed()).toBe(false);
		expect(shutdownCount()).toBe(0);
	});
});

/**
 * Click-shaped harness: auto-responds to the page setup and actionability
 * probe, but withholds every Input.dispatchMouseEvent response. Seeing the
 * release frame on the wire while the press response is withheld proves the
 * driver pipelines the pair instead of paying a round trip between them.
 */
function createStalledDispatchHarness() {
	const sent: SentMessage[] = [];
	const stalledDispatches: SentMessage[] = [];
	const messageListeners: Array<(data: string) => void> = [];
	const sendWaiters: Array<{ matches(message: SentMessage): boolean; notify(): void }> = [];
	const deliver = (frame: Record<string, unknown>): void => {
		const text = JSON.stringify(frame);
		for (const listener of messageListeners) {
			listener(text);
		}
	};
	const respond = (message: SentMessage): Record<string, unknown> => {
		if (message.method === 'Target.createBrowserContext') {
			return { browserContextId: 'context-1' };
		}
		if (message.method === 'Target.createTarget') {
			return { targetId: 'target-1' };
		}
		if (message.method === 'Target.attachToTarget') {
			return { sessionId: 'session-1' };
		}
		if (message.method === 'Runtime.evaluate') {
			// The actionability probe resolves an immediately clickable point.
			return { result: { value: { x: 8, y: 9 } } };
		}
		return {};
	};
	const socket: CdpSocket = {
		send: (data) => {
			const message = JSON.parse(data) as SentMessage;
			sent.push(message);
			for (let index = sendWaiters.length - 1; index >= 0; index--) {
				if (sendWaiters[index]!.matches(message)) {
					sendWaiters[index]!.notify();
					sendWaiters.splice(index, 1);
				}
			}
			if (message.method === 'Input.dispatchMouseEvent') {
				stalledDispatches.push(message);
				return;
			}
			queueMicrotask(() => deliver({ id: message.id, result: respond(message) }));
		},
		close: () => undefined,
		onMessage: (listener) => {
			messageListeners.push(listener);
		},
		onClose: () => undefined,
	};
	const nextSend = (matches: (message: SentMessage) => boolean): Promise<void> => {
		if (sent.some(matches)) {
			return Promise.resolve();
		}
		return new Promise((notify) => sendWaiters.push({ matches, notify }));
	};
	const releaseStalledDispatches = (): void => {
		for (const dispatch of stalledDispatches) {
			deliver({ id: dispatch.id, result: {} });
		}
	};
	return { socket, stalledDispatches, nextSend, releaseStalledDispatches };
}

describe('click input pipelining', () => {
	test('release is sent without awaiting the press round trip', async () => {
		const harness = createStalledDispatchHarness();
		const { endpoint } = createFakeEndpoint();
		const connection = await connectCdpBrowser(endpoint, {
			openSocket: () => Promise.resolve(harness.socket),
		});
		const session = await connection.createContextSession();
		const page = await session.newPage();

		const clickDone = page.click('#counter', 1000);
		await harness.nextSend(
			(message) =>
				message.method === 'Input.dispatchMouseEvent' &&
				message.params?.type === 'mousePressed',
		);
		// One macrotask turn drains every microtask the driver could use; the
		// press response stays withheld the whole time, so a release frame can
		// only appear here if the driver never awaited the press round trip.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const dispatchedTypes = harness.stalledDispatches.map((message) => message.params?.type);
		expect(dispatchedTypes).toEqual(['mousePressed', 'mouseReleased']);

		harness.releaseStalledDispatches();
		await clickDone;
	});
});

type FakeBrowserProcess = {
	endpoint: LaunchedBrowserEndpoint;
	headless: boolean;
	shutdownCount(): number;
	/** Simulates the browser-level socket closing (crash / external kill). */
	loseConnection(): void;
	contextsCreated: number;
	contextsDisposed: number;
};

/**
 * Fake endpoint + connection factories for the pool: every spawned process is
 * recorded so tests can count spawns, shutdowns, and context lifecycles.
 * `contextFailuresPerProcess[i]` makes process i reject that many
 * createContextSession calls (Infinity = always), modeling a live-looking
 * process that cannot mint a context.
 */
function createPoolHarness(options: { contextFailuresPerProcess?: number[] } = {}) {
	const processes: FakeBrowserProcess[] = [];
	const launchEndpoint = (launchOptions: {
		headless: boolean;
	}): Promise<LaunchedBrowserEndpoint> => {
		const index = processes.length;
		let shutdownCalls = 0;
		const record: FakeBrowserProcess = {
			endpoint: {
				webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/browser/${index}`,
				writeBinaryFile: () => Promise.resolve(),
				shutdown: () => {
					shutdownCalls++;
					return Promise.resolve();
				},
			},
			headless: launchOptions.headless,
			shutdownCount: () => shutdownCalls,
			loseConnection: () => undefined,
			contextsCreated: 0,
			contextsDisposed: 0,
		};
		processes.push(record);
		return Promise.resolve(record.endpoint);
	};
	const connectBrowser = (
		endpoint: LaunchedBrowserEndpoint,
		connectOptions: { onConnectionLost(): void },
	): Promise<CdpBrowserConnection> => {
		const record = processes.find((process) => process.endpoint === endpoint)!;
		record.loseConnection = connectOptions.onConnectionLost;
		let remainingFailures = options.contextFailuresPerProcess?.[processes.indexOf(record)] ?? 0;
		return Promise.resolve({
			createContextSession: (): Promise<GumboxBrowserSession> => {
				if (remainingFailures > 0) {
					remainingFailures--;
					return Promise.reject(new Error('Target.createBrowserContext failed'));
				}
				record.contextsCreated++;
				return Promise.resolve({
					newPage: () => Promise.reject(new Error('newPage unused in pool tests')),
					close: () => {
						record.contextsDisposed++;
						return Promise.resolve();
					},
				});
			},
			close: () => undefined,
		});
	};
	return { processes, hooks: { launchEndpoint, connectBrowser } };
}

describe('host browser pool', () => {
	test('two sequential launches share one browser process with separate contexts', async () => {
		const { processes, hooks } = createPoolHarness();
		const browser = createHostBrowser(hooks);

		const first = await browser.launch({ headless: true });
		await first.close();
		const second = await browser.launch({ headless: true });
		await second.close();

		expect(processes).toHaveLength(1);
		expect(processes[0]!.contextsCreated).toBe(2);
		expect(processes[0]!.contextsDisposed).toBe(2);
		// session.close() disposes the context; the pooled process stays alive.
		expect(processes[0]!.shutdownCount()).toBe(0);
	});

	test('headed and headless launches pool separate processes', async () => {
		const { processes, hooks } = createPoolHarness();
		const browser = createHostBrowser(hooks);

		await browser.launch({ headless: true });
		await browser.launch({ headless: false });
		await browser.launch({ headless: true });

		expect(processes).toHaveLength(2);
		expect(processes.map((process) => process.headless)).toEqual([true, false]);
	});

	test('a lost browser connection evicts the entry and the next launch respawns', async () => {
		const { processes, hooks } = createPoolHarness();
		const browser = createHostBrowser(hooks);

		await browser.launch({ headless: true });
		processes[0]!.loseConnection();
		const session = await browser.launch({ headless: true });

		expect(processes).toHaveLength(2);
		// The dead process was shut down (memoized kill + profile removal).
		expect(processes[0]!.shutdownCount()).toBe(1);
		expect(processes[1]!.contextsCreated).toBe(1);
		await session.close();
	});

	test('a context failure on a live-looking process retries exactly once on a fresh one', async () => {
		const { processes, hooks } = createPoolHarness({
			contextFailuresPerProcess: [Number.POSITIVE_INFINITY, 0],
		});
		const browser = createHostBrowser(hooks);

		const session = await browser.launch({ headless: true });

		expect(processes).toHaveLength(2);
		expect(processes[0]!.shutdownCount()).toBe(1);
		expect(processes[1]!.contextsCreated).toBe(1);
		await session.close();
	});

	test('a second context failure after the retry surfaces instead of looping', async () => {
		const { processes, hooks } = createPoolHarness({
			contextFailuresPerProcess: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
		});
		const browser = createHostBrowser(hooks);

		await expect(browser.launch({ headless: true })).rejects.toThrow(
			'Target.createBrowserContext failed',
		);
		// Exactly one retry: no third process is ever spawned.
		expect(processes).toHaveLength(2);
	});
});
