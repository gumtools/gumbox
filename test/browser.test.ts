import { fileURLToPath } from 'mlly';
import path from 'pathe';
import { afterEach, describe, expect, test } from 'vitest';
import { runCli } from '../src/cli/run-cli.ts';
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

type ReceiptBox = {
	name: string;
	status: string;
	error: { message: string } | null;
	vite: { browserAlias: string | null; serverUrl: string | null };
	pages: PageEntry[];
	previews: PreviewEntry[];
	assertions: Array<{ name: string; status: string; environment: string | null }>;
	timeline: Array<Record<string, unknown>>;
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
			expect(result.boxes[0]?.error?.message).toContain('playwright');
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
					'page.cleanConsole',
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
			expect(assertionNames).toContain('page.event');
			expect(assertionNames).toContain('page.noNavigations');
			expect(boxReceipt.assertions.every((entry) => entry.status === 'passed')).toBe(true);

			const timelineTypes = boxReceipt.timeline.map((event) => event.type);
			expect(timelineTypes).toContain('page event tracking started');
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
				expect.arrayContaining([
					'page.attribute',
					'page.noAttribute',
					'page.containsText',
					'page.notContainsText',
					'page.noFailedRequests',
				]),
			);
			expect(boxReceipt.assertions.every((entry) => entry.status === 'passed')).toBe(true);

			const timelineTypes = boxReceipt.timeline.map((event) => event.type);
			expect(timelineTypes).toContain('page click');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'notContainsText and noFailedRequests are falsifiable',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'notContainsText fails while the text is still present',
				'noFailedRequests fails after a failed page request',
			);
			const result = await runBoxes({ root, boxes, fileSystem, browser: hostBrowser });

			expect(result.status).toBe('failed');
			expect(result.boxes[0]?.status).toBe('failed');
			expect(result.boxes[0]?.error?.message).toContain('clicked 0 times');
			expect(result.boxes[1]?.status).toBe('failed');
			expect(result.boxes[1]?.error?.message).toContain('failed request');

			const receipt = await readReceipt(result.receiptPath);
			expect(
				receipt.boxes[0]!.assertions.some(
					(entry) => entry.name === 'page.notContainsText' && entry.status === 'failed',
				),
			).toBe(true);
			expect(
				receipt.boxes[1]!.assertions.some(
					(entry) => entry.name === 'page.noFailedRequests' && entry.status === 'failed',
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a page reload counts as a navigation and fails expect.page.noNavigations',
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
					(entry) => entry.name === 'page.noNavigations' && entry.status === 'failed',
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
});
