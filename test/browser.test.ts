import path from 'pathe';
import { afterEach, describe, expect, test } from 'vitest';
import { runCli } from '../src/cli/run-cli.ts';
import { fileURLToPath } from '../src/file-url.ts';
import { discoverBoxes, runBoxes } from '../src/index.ts';
import type { DiscoveredBox } from '../src/index.ts';
import { detectBrowserAvailability, hostBrowser } from './support/host-browser.ts';
import { fileSystem } from './support/host-file-system.ts';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
// Repo-local scratch space (gitignored) instead of os.tmpdir(), per the
// runtime-agnostic tooling rule: the os module is forbidden in src/ and test/.
const TMP_ROOT = path.join(fileURLToPath(new URL('..', import.meta.url)), '.tmp');
const TEST_TIMEOUT_MS = 120_000;

const availability = await detectBrowserAvailability();
if (!availability.available) {
	// Surfaced once so a skipped run records exactly why (stop_if evidence).
	console.warn(`browser-dependent tests skipped: ${availability.reason}`);
}

type SnapshotEntry = { label: string; screenshot: string | null; html: string };

type PageEntry = {
	id: string;
	route: string;
	environment: string;
	surface: string;
	url: string;
	consoleMessages: Array<{ level: string; text: string }>;
	pageErrors: Array<{ message: string }>;
	failedRequests: Array<{ url: string; method: string; reason: string | null }>;
	snapshots: SnapshotEntry[];
	navigations: Array<{ url: string; at: string }>;
	trackedEvents: Record<string, Array<{ at: string; detail: unknown }>>;
};

type PreviewEntry = {
	id: string;
	buildId: string;
	url: string;
	outDir: string;
	browserAlias: string;
};

type WitnessEntry = {
	verdict: string;
	statements: number;
	against: Array<{ kind: string; page?: string; at: string; text: string }>;
};

type ReceiptBox = {
	name: string;
	status: string;
	error: { message: string } | null;
	vite: { browserAlias: string | null; serverUrl: string | null };
	pages: PageEntry[];
	previews: PreviewEntry[];
	assertions: Array<{ name: string; status: string; environment: string | null }>;
	timeline: Array<Record<string, unknown>>;
	witnesses: Record<string, WitnessEntry>;
	summary: { contested: boolean; witnesses: Record<string, string> };
};

type ReceiptJson = {
	gumboxReceipt: number;
	summary: { status: string };
	boxes: ReceiptBox[];
};

const temporaryRoots: string[] = [];

async function createFixtureProject(fixture = 'browser'): Promise<string> {
	await fileSystem.mkdir(TMP_ROOT, { recursive: true });
	const base = await fileSystem.makeTempDirectory({
		dir: TMP_ROOT,
		prefix: `gumbox-${fixture}-`,
	});
	const root = await fileSystem.realPath(base);
	temporaryRoots.push(root);
	await fileSystem.copyDirectory(path.join(FIXTURES_DIR, fixture), root);
	return root;
}

async function selectBoxes(root: string, ...names: string[]): Promise<DiscoveredBox[]> {
	const discovery = await discoverBoxes({ root });
	return names.map((name) => {
		const found = discovery.boxes.find((entry) => entry.box.name === name);
		expect(found, `box named '${name}'`).toBeDefined();
		return found!;
	});
}

async function readReceipt(receiptPath: string): Promise<ReceiptJson> {
	return JSON.parse(await fileSystem.readTextFile(receiptPath)) as ReceiptJson;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((dir) => fileSystem.remove(dir, { recursive: true, force: true })),
	);
});

describe('browser capability boundary', () => {
	test(
		'browser.visit without an injected browser capability fails with a clear error',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(root, 'dashboard route works in dev');
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status).toBe('failed');
			expect(result.boxes[0]?.error?.message).toContain('browser automation capability');
			expect(result.boxes[0]?.error?.message).toContain('Chromium-family browser');
			expect(result.boxes[0]?.error?.message).toContain('GUMBOX_BROWSER_PATH');
		},
		TEST_TIMEOUT_MS,
	);
});

describe.skipIf(!availability.available)('gumbox browser evidence', () => {
	test(
		'browser.visit captures screenshot, DOM snapshot, and page assertions into the receipt',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(root, 'dashboard route works in dev');
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = await readReceipt(result.receiptPath);
			const boxReceipt = receipt.boxes[0]!;
			expect(boxReceipt.status).toBe('passed');
			expect(boxReceipt.vite.browserAlias).toBe('client');

			// Page evidence: route, environment, surface, and live URL.
			expect(boxReceipt.pages).toHaveLength(1);
			const page = boxReceipt.pages[0]!;
			expect(page.route).toBe('/');
			expect(page.environment).toBe('client');
			expect(page.surface).toBe('dev');
			expect(page.url).toContain('127.0.0.1');

			// Snapshots: one on visit, one from receipt.capture('dashboard state').
			expect(page.snapshots.length).toBeGreaterThanOrEqual(2);
			const labels = page.snapshots.map((snapshot) => snapshot.label);
			expect(labels).toContain('visit');
			expect(labels).toContain('dashboard state');
			for (const snapshot of page.snapshots) {
				const html = await fileSystem.readTextFile(path.join(result.runDir, snapshot.html));
				expect(html).toContain('hello from the browser fixture');
				expect(snapshot.screenshot).not.toBeNull();
				const screenshotPath = path.join(result.runDir, snapshot.screenshot!);
				expect(await fileSystem.exists(screenshotPath)).toBe(true);
				expect(await fileSystem.fileSize(screenshotPath)).toBeGreaterThan(0);
			}

			// expect.page assertions are recorded against the browser environment.
			const assertionNames = boxReceipt.assertions.map((entry) => entry.name);
			expect(assertionNames).toEqual(
				expect.arrayContaining([
					'page.exists',
					'page.visible',
					'page.text',
					'page.computedStyle',
					'page.outcome',
				]),
			);
			expect(boxReceipt.assertions.every((entry) => entry.status === 'passed')).toBe(true);

			// Timeline includes the browser lifecycle facts.
			const timelineTypes = boxReceipt.timeline.map((event) => event.type);
			expect(timelineTypes).toContain('route visited');
			expect(timelineTypes).toContain('screenshot captured');
			expect(timelineTypes).toContain('dom snapshot captured');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'console errors and failed network requests become receipt evidence',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'noisy page records console and network evidence',
			);
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = await readReceipt(result.receiptPath);
			const page = receipt.boxes[0]!.pages[0]!;
			expect(
				page.consoleMessages.some(
					(message) =>
						message.level === 'error' &&
						message.text.includes('intentional console noise'),
				),
			).toBe(true);
			expect(page.failedRequests.length).toBeGreaterThan(0);
			expect(page.failedRequests[0]!.url).toContain('127.0.0.1:9');

			const timelineTypes = receipt.boxes[0]!.timeline.map((event) => event.type);
			expect(timelineTypes).toContain('console error captured');
			expect(timelineTypes).toContain('network failure captured');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'tracked custom DOM events and zero navigations become receipt evidence',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'page custom events and navigations become receipt evidence',
			);
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = await readReceipt(result.receiptPath);
			const boxReceipt = receipt.boxes[0]!;
			const page = boxReceipt.pages[0]!;

			// Browser-side event evidence: every observed event with timestamp + detail.
			const observed = page.trackedEvents['fixture:ping']!;
			expect(observed.length).toBeGreaterThanOrEqual(2);
			expect(observed[0]!.detail).toMatchObject({ tick: 1 });
			expect(typeof observed[0]!.at).toBe('string');

			// No navigation happened after the initial load.
			expect(page.navigations).toEqual([]);

			const assertionNames = boxReceipt.assertions.map((entry) => entry.name);
			expect(assertionNames).toContain('page.outcome');
			expect(boxReceipt.assertions.every((entry) => entry.status === 'passed')).toBe(true);

			const timelineTypes = boxReceipt.timeline.map((event) => event.type);
			expect(timelineTypes).toContain('page event tracking started');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'gnarly event details (DOM node, circular ref) serialize into evidence and filter by content',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'gnarly event details serialize and filter by detail content',
			);
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = await readReceipt(result.receiptPath);
			const page = receipt.boxes[0]!.pages[0]!;
			const observed = page.trackedEvents['fixture:gnarly']!;
			expect(observed.length).toBeGreaterThanOrEqual(1);

			// The detail survives as structured evidence, not '[object Object]':
			// the DOM node and the circular reference are replaced with readable
			// placeholders while plain values stay intact.
			const detail = observed[0]!.detail as {
				label: string;
				tick: number;
				node: unknown;
				circular: { self: unknown };
			};
			expect(detail).not.toBe('[object Object]');
			expect(['even', 'odd']).toContain(detail.label);
			expect(typeof detail.tick).toBe('number');
			expect(detail.node).toBe('[element button]');
			expect(detail.circular.self).toBe('[circular]');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'detailIncludes that never matches fails the page.outcome assertion',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'detailIncludes never matching fails the event assertion',
			);
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status).toBe('failed');
			const message = result.boxes[0]?.error?.message ?? '';
			expect(message).toContain('needle-that-never-appears');

			const receipt = await readReceipt(result.receiptPath);
			expect(
				receipt.boxes[0]!.assertions.some(
					(entry) => entry.name === 'page.outcome' && entry.status === 'failed',
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'page.click interactions become receipt evidence and drive attribute/text assertions',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(root, 'counter clicks update page state');
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = await readReceipt(result.receiptPath);
			const boxReceipt = receipt.boxes[0]!;
			const page = boxReceipt.pages[0]! as PageEntry & {
				interactions: Array<{ kind: string; selector: string; at: string }>;
			};

			// Every click is page evidence with its selector and timestamp.
			expect(page.interactions).toHaveLength(2);
			expect(page.interactions[0]).toMatchObject({ kind: 'click', selector: '#counter' });
			expect(typeof page.interactions[0]!.at).toBe('string');

			const assertionNames = boxReceipt.assertions.map((entry) => entry.name);
			expect(assertionNames).toEqual(
				expect.arrayContaining(['page.attribute', 'page.bodyText', 'page.outcome']),
			);
			expect(boxReceipt.assertions.every((entry) => entry.status === 'passed')).toBe(true);

			const timelineTypes = boxReceipt.timeline.map((event) => event.type);
			expect(timelineTypes).toContain('page click');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'bodyText notContains and failedRequests: 0 are falsifiable',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'bodyText notContains fails while the text is still present',
				'failedRequests: 0 fails after a failed page request',
			);
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status).toBe('failed');
			expect(result.boxes[0]?.status).toBe('failed');
			expect(result.boxes[0]?.error?.message).toContain('clicked 0 times');
			expect(result.boxes[1]?.status).toBe('failed');
			expect(result.boxes[1]?.error?.message).toContain(
				'failedRequests: expected 0, observed 1',
			);

			const receipt = await readReceipt(result.receiptPath);
			expect(
				receipt.boxes[0]!.assertions.some(
					(entry) => entry.name === 'page.bodyText' && entry.status === 'failed',
				),
			).toBe(true);
			expect(
				receipt.boxes[1]!.assertions.some(
					(entry) => entry.name === 'page.outcome' && entry.status === 'failed',
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a page reload counts as a navigation and fails the page outcome check',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(root, 'page reload is recorded as a navigation');
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status).toBe('failed');
			const message = result.boxes[0]?.error?.message ?? '';
			expect(message).toContain('navigation');

			const receipt = await readReceipt(result.receiptPath);
			const page = receipt.boxes[0]!.pages[0]!;
			expect(page.navigations.length).toBeGreaterThanOrEqual(1);
			expect(page.navigations[0]!.url).toContain('127.0.0.1');
			expect(
				receipt.boxes[0]!.assertions.some(
					(entry) => entry.name === 'page.outcome' && entry.status === 'failed',
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'expect.page.text failure reports the actual text and fails the box',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(root, 'failing page text assertion');
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status).toBe('failed');
			const message = result.boxes[0]?.error?.message ?? '';
			expect(message).toContain('text that never appears');
			expect(message).toContain('hello from the browser fixture');

			const receipt = await readReceipt(result.receiptPath);
			expect(
				receipt.boxes[0]!.assertions.some(
					(entry) => entry.name === 'page.text' && entry.status === 'failed',
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'an uncaught page error contests a passing box: client testimony contradicts',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'uncaught page error stays evidence on a passing box',
			);
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			// The box passes — a contradicting witness never fails a passing box.
			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');
			expect(result.boxes[0]!.contested).toBe(true);

			const receipt = await readReceipt(result.receiptPath);
			const boxReceipt = receipt.boxes[0]!;
			const page = boxReceipt.pages[0]!;

			// The pageErrors evidence class records the uncaught error end-to-end.
			expect(page.pageErrors.length).toBeGreaterThan(0);
			expect(
				page.pageErrors.some((error) => error.message.includes('boom from the fixture')),
			).toBe(true);
			expect(page.failedRequests.length).toBeGreaterThan(0);

			// Witness testimony: client and driver contradict, the box corroborates.
			expect(boxReceipt.witnesses['client']!.verdict).toBe('contradicts');
			expect(
				boxReceipt.witnesses['client']!.against.some(
					(statement) =>
						statement.kind === 'page-error' &&
						statement.text.includes('boom from the fixture'),
				),
			).toBe(true);
			expect(boxReceipt.witnesses['driver']!.verdict).toBe('contradicts');
			expect(boxReceipt.witnesses['driver']!.against[0]).toMatchObject({
				kind: 'request-failed',
			});
			expect(boxReceipt.witnesses['box']!.verdict).toBe('corroborates');
			expect(boxReceipt.summary.contested).toBe(true);
			expect(boxReceipt.summary.witnesses['client']).toBe('contradicts');
			expect(boxReceipt.assertions.every((entry) => entry.status === 'passed')).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'the CLI renders contested witness tokens and gumbox evidence drills into testimony',
		async () => {
			const root = await createFixtureProject();
			const runLines: string[] = [];
			const runCode = await runCli(['uncaught page error'], {
				cwd: root,
				fileSystem,
				browser: hostBrowser,
				stdout: (line) => runLines.push(line),
				stderr: () => undefined,
			});
			expect(runCode, runLines.join('\n')).toBe(0);
			const runOutput = runLines.join('\n');
			expect(runOutput).toContain('[pipeline+ client! driver!]');
			expect(runOutput).toContain('contested');
			expect(runOutput).toContain('1 contested pass');
			expect(runOutput).toMatch(/client reported: .*page error/);
			expect(runOutput).toMatch(/driver reported: 1 failed request/);

			// Drill-down reads the latest receipt by default.
			const evidenceLines: string[] = [];
			const evidenceCode = await runCli(['evidence', 'uncaught page error'], {
				cwd: root,
				fileSystem,
				stdout: (line) => evidenceLines.push(line),
				stderr: () => undefined,
			});
			expect(evidenceCode).toBe(0);
			const evidenceOutput = evidenceLines.join('\n');
			expect(evidenceOutput).toContain(
				'case: uncaught page error stays evidence on a passing box — pass, contested',
			);
			// The crime blotter lists every against-statement before the
			// per-witness testimony, each attributed to its reporting witness.
			expect(evidenceOutput).toContain('crimes reported (');
			expect(evidenceOutput).toContain('— reported by client');
			expect(evidenceOutput).toContain('— reported by driver');
			expect(evidenceOutput.indexOf('crimes reported (')).toBeLessThan(
				evidenceOutput.indexOf('pipeline witness'),
			);
			expect(evidenceOutput).toContain('pipeline witness — corroborates');
			expect(evidenceOutput).toContain('client witness — reports a crime (');
			expect(evidenceOutput).toContain('! page error');
			expect(evidenceOutput).toContain('boom from the fixture');
			expect(evidenceOutput).toContain('driver witness — reports a crime (');
			expect(evidenceOutput).toContain('! request failed');
			expect(evidenceOutput).toContain('box — corroborates');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'waitForExpression survives a mid-wait reload and resolves on the new document',
		async () => {
			// Pins the navigation semantic of the in-page wait: a reload
			// destroys the wait's execution context, and the wait retries
			// against the new document with the remaining time budget.
			const session = await hostBrowser.launch({ headless: true });
			try {
				const page = await session.newPage();
				// about:blank, not a data: URL — Chrome blocks renderer-initiated
				// reloads of top-frame data: documents.
				await page.goto('about:blank');
				// window.name survives the reload while the marker dies with
				// its document, so the predicate can only turn true on the
				// document created by the mid-wait reload.
				await page.evaluate(
					`(() => {
						window.name = 'gumbox-nav-wait';
						window.__gumboxOldDocumentMarker = true;
						setTimeout(() => location.reload(), 100);
					})()`,
				);
				await page.waitForExpression(
					`window.name === 'gumbox-nav-wait' && window.__gumboxOldDocumentMarker !== true`,
					10_000,
				);
				await page.close();
			} finally {
				await session.close();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'pipeline.preview serves the built output and records the preview browser alias',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(root, 'built app serves dashboard in preview');
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = await readReceipt(result.receiptPath);
			const boxReceipt = receipt.boxes[0]!;

			expect(boxReceipt.previews).toHaveLength(1);
			const preview = boxReceipt.previews[0]!;
			expect(preview.url).toContain('127.0.0.1');
			expect(preview.buildId).toBe('build-1');
			expect(preview.outDir).toBe('dist/client');
			expect(preview.browserAlias).toBe('client');

			// Preview page evidence stays local to the preview run.
			expect(boxReceipt.pages).toHaveLength(1);
			expect(boxReceipt.pages[0]!.surface).toBe('preview');
			expect(boxReceipt.pages[0]!.url.startsWith(preview.url)).toBe(true);

			const timelineTypes = boxReceipt.timeline.map((event) => event.type);
			expect(timelineTypes).toContain('preview server started');
			expect(timelineTypes).toContain('preview server closed');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'gumbox preview runs preview-compatible boxes and exits 0 with a receipt',
		async () => {
			const root = await createFixtureProject();
			const stdoutLines: string[] = [];
			const stderrLines: string[] = [];
			const code = await runCli(['preview', '--json'], {
				cwd: root,
				fileSystem,
				browser: hostBrowser,
				stdout: (line) => stdoutLines.push(line),
				stderr: (line) => stderrLines.push(line),
			});

			expect(code, stderrLines.join('\n')).toBe(0);
			const summary = JSON.parse(stdoutLines.join('\n')) as {
				status: string;
				receiptPath: string;
				summary: { total: number; passed: number };
			};
			expect(summary.status).toBe('passed');
			expect(summary.summary).toMatchObject({ total: 1, passed: 1 });

			const receipt = await readReceipt(summary.receiptPath);
			expect(receipt.boxes[0]!.name).toBe('built app serves dashboard in preview');
			expect(receipt.boxes[0]!.previews[0]!.browserAlias).toBe('client');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'two boxes in one run share a browser process but never browser state',
		async () => {
			// Isolation proof for the pooled browser: box A plants a cookie
			// (host-scoped on 127.0.0.1, so port-agnostic) AND localStorage on a
			// pinned dev-server port; box B, on the same origin in the same run,
			// must see neither. If pooled boxes shared a browser context, the
			// read box would observe the cookie and the storage value and its
			// 'clean state' assertion would fail.
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'isolation: first box plants cookie and storage state',
				'isolation: second box sees none of the first box state',
			);
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(
				result.status,
				result.boxes.map((entry) => entry.error?.message).join('\n'),
			).toBe('passed');

			const receipt = await readReceipt(result.receiptPath);
			expect(receipt.boxes).toHaveLength(2);
			// The write demonstrably landed before the clean read, so the clean
			// read cannot be vacuous.
			expect(receipt.boxes[0]!.status).toBe('passed');
			expect(receipt.boxes[1]!.status).toBe('passed');
			// Both boxes ran against the same pinned origin.
			expect(receipt.boxes[0]!.pages[0]!.url).toContain(':14173');
			expect(receipt.boxes[1]!.pages[0]!.url).toContain(':14173');
			// Each box still gets its own truthful session lifecycle events.
			for (const boxReceipt of receipt.boxes) {
				const timelineTypes = boxReceipt.timeline.map((event) => event.type);
				expect(timelineTypes).toContain('browser session started');
				expect(timelineTypes).toContain('browser session closed');
			}
		},
		TEST_TIMEOUT_MS,
	);
});
