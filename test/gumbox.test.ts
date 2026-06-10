import { fileURLToPath } from 'mlly';
import path from 'pathe';
import { afterEach, describe, expect, test } from 'vitest';
import { discoverBoxes, runBoxes } from '../src/index.ts';
import type { DiscoveredBox } from '../src/index.ts';
import { fileSystem } from './support/host-file-system.ts';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
// Repo-local scratch space (gitignored) instead of os.tmpdir(), per the
// runtime-agnostic tooling rule: the os module is forbidden in src/ and test/.
const TMP_ROOT = path.join(fileURLToPath(new URL('..', import.meta.url)), '.tmp');
const TEST_TIMEOUT_MS = 60_000;

type ReceiptBox = {
	name: string;
	file: string;
	exportName: string;
	status: string;
	error: { message: string } | null;
	vite: { configFile: string | null; serverUrl: string | null; environments: string[] };
	edits: Array<{
		id: string;
		file: string;
		before?: string | null;
		after?: string | null;
		restored: boolean | null;
		files: Array<{
			file: string;
			change: { kind: string };
			before: string | null;
			after: string | null;
			restored: boolean | null;
		}>;
	}>;
	builds: Array<{
		id: string;
		strategy: string;
		environments: string[];
		outDirs: Record<string, string>;
		artifacts: Array<{ path: string; bytes: number }>;
		durationMs: number;
	}>;
	editOutcomes: Array<{
		editId: string;
		environments: Record<
			string,
			{
				update: boolean;
				fullReload: boolean;
				invalidated: unknown[];
				customPayloads: Array<{ event: string; data?: unknown }>;
			}
		>;
	}>;
	assertions: Array<{ name: string; status: string; environment: string | null }>;
	captures: Array<{ label: string }>;
	notes: string[];
	measurements: Array<{ label: string; durationMs: number }>;
	timeline: Array<Record<string, unknown>>;
	summary: { restorationFailed: boolean };
};

type ReceiptJson = {
	gumboxReceipt: number;
	runId: string;
	summary: { status: string; total: number };
	boxes: ReceiptBox[];
};

const temporaryRoots: string[] = [];

async function createFixtureProject(fixture = 'basic'): Promise<string> {
	await fileSystem.mkdir(TMP_ROOT, { recursive: true });
	const base = await fileSystem.makeTempDirectory({
		dir: TMP_ROOT,
		prefix: `gumbox-${fixture}-`,
	});
	// realpath so watcher file events match the configured Vite root in case
	// any segment of the repo path sits behind a symlink.
	const root = await fileSystem.realPath(base);
	temporaryRoots.push(root);
	await fileSystem.copyDirectory(path.join(FIXTURES_DIR, fixture), root);
	return root;
}

async function selectBoxes(root: string, ...names: string[]): Promise<DiscoveredBox[]> {
	const discovery = await discoverBoxes({ root });
	const selected = names.map((name) => {
		const found = discovery.boxes.find((entry) => entry.box.name === name);
		expect(found, `box named '${name}'`).toBeDefined();
		return found!;
	});
	return selected;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((dir) => fileSystem.remove(dir, { recursive: true, force: true })),
	);
});

describe('gumbox runtime', () => {
	test(
		'discovers box files and reports invalid box files with actionable errors',
		async () => {
			const root = await createFixtureProject();
			const discovery = await discoverBoxes({ root });

			const names = discovery.boxes.map((entry) => entry.box.name).sort();
			expect(names).toEqual([
				'batch edit touches multiple files',
				'client edit stays out of the ssr graph',
				'create, remove, and copy files',
				'custom hot payload replaces the vite update protocol',
				'env file edit reloads the dev server',
				'intentionally failing box',
				'message updates without reload',
				'vite config edit restarts the dev server',
			]);

			const hmr = discovery.boxes.find((entry) => entry.relativeFile === 'hmr.box.ts');
			expect(hmr?.exportName).toBe('default');
			const isolation = discovery.boxes.find(
				(entry) => entry.relativeFile === 'isolation.box.ts',
			);
			expect(isolation?.exportName).toBe('ClientEditIsolation');
			expect(isolation?.box.tags).toEqual(['environments']);

			expect(discovery.invalid).toHaveLength(1);
			expect(discovery.invalid[0]?.relativeFile).toBe('invalid.box.ts');
			expect(discovery.invalid[0]?.error).toContain('does not export a box');
			expect(discovery.invalid[0]?.error).toContain('box(name, run)');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'records real HMR update evidence for a project edit and writes a receipt',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(root, 'message updates without reload');
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const latest = (
				await fileSystem.readTextFile(path.join(root, '.gumbox', 'receipts', 'latest'))
			).trim();
			expect(latest).toBe(result.runId);
			expect(path.basename(result.runDir)).toBe(result.runId);

			const receipt = JSON.parse(
				await fileSystem.readTextFile(result.receiptPath),
			) as ReceiptJson;
			expect(receipt.gumboxReceipt).toBe(1);
			expect(receipt.summary.status).toBe('passed');

			const boxReceipt = receipt.boxes[0]!;
			expect(boxReceipt.status).toBe('passed');
			expect(boxReceipt.vite.environments).toContain('client');
			expect(boxReceipt.vite.environments).toContain('ssr');
			expect(boxReceipt.vite.configFile).toContain('vite.config.ts');

			// Edit diff plus guaranteed restoration.
			expect(boxReceipt.edits).toHaveLength(1);
			expect(boxReceipt.edits[0]!.before).toContain('before edit');
			expect(boxReceipt.edits[0]!.after).toContain('after edit');
			expect(boxReceipt.edits[0]!.restored).toBe(true);

			// Normalized per-environment edit outcome.
			const clientOutcome = boxReceipt.editOutcomes[0]!.environments['client']!;
			expect(clientOutcome.update).toBe(true);
			expect(clientOutcome.fullReload).toBe(false);
			expect(clientOutcome.invalidated.length).toBeGreaterThan(0);

			// Assertion results (passes are recorded too).
			expect(boxReceipt.assertions.length).toBeGreaterThanOrEqual(4);
			expect(boxReceipt.assertions.every((entry) => entry.status === 'passed')).toBe(true);

			// HMR evidence arrived both on the hot channel and over a real
			// Node WebSocket client -- no browser involved.
			expect(
				boxReceipt.timeline.some(
					(event) => event.type === 'vite hmr update sent' && event.source === 'channel',
				),
			).toBe(true);
			expect(
				boxReceipt.timeline.some(
					(event) => event.type === 'vite hmr update sent' && event.source === 'ws',
				),
			).toBe(true);

			// Receipt API surface.
			expect(boxReceipt.captures.map((capture) => capture.label)).toContain(
				'after hmr update',
			);
			expect(boxReceipt.measurements[0]?.label).toBe('prime client module graph');
			expect(boxReceipt.notes.some((note) => note.includes('primed'))).toBe(true);

			const restoredFile = await fileSystem.readTextFile(
				path.join(root, 'src', 'message.ts'),
			);
			expect(restoredFile).toContain("'before edit'");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'custom hot payloads (framework HMR protocols) become edit outcome evidence',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'custom hot payload replaces the vite update protocol',
			);
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = JSON.parse(
				await fileSystem.readTextFile(result.receiptPath),
			) as ReceiptJson;
			const boxReceipt = receipt.boxes[0]!;

			// The framework suppressed Vite's update payload; the custom payload
			// is the HMR evidence and must land in the normalized outcome.
			const clientOutcome = boxReceipt.editOutcomes[0]!.environments['client']!;
			expect(clientOutcome.update).toBe(false);
			expect(clientOutcome.fullReload).toBe(false);
			expect(clientOutcome.invalidated.length).toBeGreaterThan(0);
			expect(clientOutcome.customPayloads.length).toBeGreaterThanOrEqual(1);
			expect(clientOutcome.customPayloads[0]!.event).toBe('fixture:hmr');
			expect(clientOutcome.customPayloads[0]!.data).toMatchObject({});

			expect(
				boxReceipt.assertions.some(
					(entry) => entry.name === 'customPayload' && entry.status === 'passed',
				),
			).toBe(true);
			expect(
				boxReceipt.timeline.some((event) => event.type === 'vite custom payload sent'),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'correlates HMR evidence to edits when the dev root is a project subdirectory',
		async () => {
			const root = await createFixtureProject('nested');
			const boxes = await selectBoxes(
				root,
				'app subdirectory edit hot-updates with fixture-rooted evidence',
			);
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = JSON.parse(
				await fileSystem.readTextFile(result.receiptPath),
			) as ReceiptJson;
			const boxReceipt = receipt.boxes[0]!;
			expect(boxReceipt.status).toBe('passed');

			// The edit targets app/src/message.ts relative to the runner root,
			// while Vite resolves update payload paths against the app/ dev root.
			// The receipt must still attribute the update to this edit.
			const clientOutcome = boxReceipt.editOutcomes[0]!.environments['client']!;
			expect(clientOutcome.update).toBe(true);
			expect(clientOutcome.fullReload).toBe(false);
			expect(clientOutcome.invalidated.length).toBeGreaterThan(0);
			expect(boxReceipt.edits[0]!.files[0]!.file).toBe('app/src/message.ts');
			expect(boxReceipt.edits[0]!.restored).toBe(true);

			expect(
				boxReceipt.timeline.some(
					(event) => event.type === 'vite hmr update sent' && event.source === 'channel',
				),
			).toBe(true);

			const restoredFile = await fileSystem.readTextFile(
				path.join(root, 'app', 'src', 'message.ts'),
			);
			expect(restoredFile).toContain('nested before');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'keeps client edits isolated from the ssr environment graph',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(root, 'client edit stays out of the ssr graph');
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = JSON.parse(
				await fileSystem.readTextFile(result.receiptPath),
			) as ReceiptJson;
			const boxReceipt = receipt.boxes[0]!;
			expect(boxReceipt.status).toBe('passed');

			const outcomes = boxReceipt.editOutcomes[0]!.environments;
			expect(outcomes['client']!.update).toBe(true);
			expect(outcomes['client']!.invalidated.length).toBeGreaterThan(0);
			expect(outcomes['ssr']!.update).toBe(false);
			expect(outcomes['ssr']!.fullReload).toBe(false);
			expect(outcomes['ssr']!.invalidated).toHaveLength(0);

			expect(
				boxReceipt.assertions.some(
					(entry) =>
						entry.name === 'notInvalidated' &&
						entry.environment === 'ssr' &&
						entry.status === 'passed',
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'restores edited files even when the box body throws',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(root, 'intentionally failing box');
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status).toBe('failed');
			expect(result.boxes[0]?.status).toBe('failed');
			expect(result.boxes[0]?.error?.message).toContain('intentional failure');

			// The receipt is still written for failed runs.
			const receipt = JSON.parse(
				await fileSystem.readTextFile(result.receiptPath),
			) as ReceiptJson;
			expect(receipt.gumboxReceipt).toBe(1);
			expect(receipt.summary.status).toBe('failed');
			const boxReceipt = receipt.boxes[0]!;
			expect(boxReceipt.status).toBe('failed');
			expect(boxReceipt.error?.message).toContain('intentional failure');
			expect(boxReceipt.edits[0]!.restored).toBe(true);
			expect(boxReceipt.summary.restorationFailed).toBe(false);

			const restoredFile = await fileSystem.readTextFile(
				path.join(root, 'src', 'message.ts'),
			);
			expect(restoredFile).toContain("'before edit'");
			expect(restoredFile).not.toContain('broken edit');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'creates, removes, copies, and batch-edits project files with guaranteed restoration',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'create, remove, and copy files',
				'batch edit touches multiple files',
			);
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status, result.boxes.map((box) => box.error?.message).join('; ')).toBe(
				'passed',
			);

			// Everything the boxes did is rolled back on disk.
			expect(await fileSystem.exists(path.join(root, 'src', 'created-style.css'))).toBe(
				false,
			);
			expect(await fileSystem.exists(path.join(root, 'edits', 'message.after.ts'))).toBe(
				false,
			);
			expect(await fileSystem.exists(path.join(root, 'notes', 'batch.txt'))).toBe(false);
			expect(
				await fileSystem.readTextFile(path.join(root, 'src', 'server-only.ts')),
			).toContain('server before');
			expect(await fileSystem.readTextFile(path.join(root, 'src', 'message.ts'))).toContain(
				"'before edit'",
			);

			const receipt = JSON.parse(
				await fileSystem.readTextFile(result.receiptPath),
			) as ReceiptJson;

			const fileOps = receipt.boxes.find(
				(box) => box.name === 'create, remove, and copy files',
			)!;
			expect(fileOps.edits).toHaveLength(3);
			expect(fileOps.edits.map((edit) => edit.files[0]!.change.kind)).toEqual([
				'create',
				'remove',
				'copy',
			]);
			expect(fileOps.edits[0]!.files[0]!.before).toBeNull();
			expect(fileOps.edits[1]!.files[0]!.after).toBeNull();
			expect(
				fileOps.edits.every((edit) => edit.files.every((file) => file.restored === true)),
			).toBe(true);
			const fileOpsTimeline = fileOps.timeline.map((event) => event.type);
			expect(fileOpsTimeline).toContain('file created');
			expect(fileOpsTimeline).toContain('file removed');
			expect(fileOpsTimeline).toContain('file copied');

			const batch = receipt.boxes.find(
				(box) => box.name === 'batch edit touches multiple files',
			)!;
			expect(batch.edits).toHaveLength(1);
			expect(batch.edits[0]!.file).toBe('swap message and add a note');
			expect(batch.edits[0]!.files).toHaveLength(3);
			expect(batch.edits[0]!.files.map((file) => file.change.kind).sort()).toEqual([
				'create',
				'remove',
				'replace',
			]);
			expect(batch.edits[0]!.restored).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'config and env file edits restart the dev server with receipt evidence',
		async () => {
			const root = await createFixtureProject();
			const boxes = await selectBoxes(
				root,
				'vite config edit restarts the dev server',
				'env file edit reloads the dev server',
			);
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status, result.boxes.map((box) => box.error?.message).join('; ')).toBe(
				'passed',
			);

			const receipt = JSON.parse(
				await fileSystem.readTextFile(result.receiptPath),
			) as ReceiptJson;

			const configBox = receipt.boxes.find(
				(box) => box.name === 'vite config edit restarts the dev server',
			)!;
			expect(
				configBox.assertions.some(
					(entry) =>
						entry.name === 'pipeline.serverRestarted' && entry.status === 'passed',
				),
			).toBe(true);
			const configTimeline = configBox.timeline.map((event) => event.type);
			expect(configTimeline).toContain('vite config edited');
			expect(configTimeline).toContain('vite server restarted');
			expect(configTimeline).toContain('vite server listening');

			const envBox = receipt.boxes.find(
				(box) => box.name === 'env file edit reloads the dev server',
			)!;
			expect(
				envBox.assertions.some(
					(entry) =>
						entry.name === 'pipeline.serverRestarted' && entry.status === 'passed',
				),
			).toBe(true);
			const envTimeline = envBox.timeline.map((event) => event.type);
			expect(envTimeline).toContain('env file edited');
			expect(envTimeline).toContain('vite server restarted');

			// Config and env files are restored to their pre-box contents.
			expect(await fileSystem.readTextFile(path.join(root, 'vite.config.ts'))).toContain(
				'marker-before',
			);
			expect(await fileSystem.readTextFile(path.join(root, '.env'))).toContain('env-before');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'builds every environment via createBuilder and scans artifacts for forbidden strings',
		async () => {
			const root = await createFixtureProject('build');
			const boxes = await selectBoxes(root, 'build artifacts include no server secret');
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status, result.boxes[0]?.error?.message).toBe('passed');

			const receipt = JSON.parse(
				await fileSystem.readTextFile(result.receiptPath),
			) as ReceiptJson;
			const boxReceipt = receipt.boxes[0]!;
			expect(boxReceipt.status).toBe('passed');

			// Build outcome facts in the receipt.
			expect(boxReceipt.builds).toHaveLength(1);
			const build = boxReceipt.builds[0]!;
			expect(build.strategy).toBe('builder');
			expect(build.environments).toEqual(expect.arrayContaining(['client', 'ssr']));
			expect(build.outDirs['client']).toBe('dist/client');
			expect(build.outDirs['ssr']).toBe('dist/server');
			const artifactPaths = build.artifacts.map((artifact) => artifact.path);
			expect(artifactPaths).toContain('dist/client/index.html');
			expect(artifactPaths).toContain('dist/client/.vite/manifest.json');
			expect(artifactPaths).toContain('dist/server/entry-server.js');
			expect(build.artifacts.every((artifact) => artifact.bytes > 0)).toBe(true);
			expect(build.durationMs).toBeGreaterThan(0);

			// Timeline covers the build lifecycle and artifact scans.
			const timelineTypes = boxReceipt.timeline.map((event) => event.type);
			expect(timelineTypes).toContain('build started');
			expect(
				boxReceipt.timeline
					.filter((event) => event.type === 'build environment completed')
					.map((event) => event.environment),
			).toEqual(expect.arrayContaining(['client', 'ssr']));
			expect(
				boxReceipt.timeline.some(
					(event) =>
						event.type === 'artifact scanned' &&
						event.path === 'dist/client/.vite/manifest.json',
				),
			).toBe(true);

			// All build/artifact assertions recorded and passed.
			const assertionNames = boxReceipt.assertions.map((entry) => entry.name);
			expect(assertionNames).toContain('build.environment');
			expect(assertionNames).toContain('build.artifact');
			expect(assertionNames).toContain('artifact.exists');
			expect(assertionNames).toContain('artifact.json');
			expect(assertionNames).toContain('artifact.text');
			expect(boxReceipt.assertions.every((entry) => entry.status === 'passed')).toBe(true);

			// The build output really exists on disk.
			expect(await fileSystem.exists(path.join(root, 'dist', 'client', 'index.html'))).toBe(
				true,
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'fails the box when a forbidden string leaks into a scanned artifact',
		async () => {
			const root = await createFixtureProject('build');
			const boxes = await selectBoxes(root, 'leak detector fails on forbidden strings');
			const result = await runBoxes({ root, boxes, fileSystem });

			expect(result.status).toBe('failed');
			expect(result.boxes[0]?.error?.message).toContain('forbidden string leaked');
			expect(result.boxes[0]?.error?.message).toContain('dist/server/entry-server.js');
			expect(result.boxes[0]?.error?.message).toContain('GUMBOX_SERVER_ONLY_SECRET');

			const receipt = JSON.parse(
				await fileSystem.readTextFile(result.receiptPath),
			) as ReceiptJson;
			const boxReceipt = receipt.boxes[0]!;
			expect(boxReceipt.status).toBe('failed');
			expect(
				boxReceipt.assertions.some(
					(entry) => entry.name === 'artifact.text' && entry.status === 'failed',
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);
});
