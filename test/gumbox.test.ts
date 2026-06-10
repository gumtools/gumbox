import { fileURLToPath } from 'mlly';
import path from 'pathe';
import { afterEach, describe, expect, test } from 'vitest';
import { discoverBoxes, runBoxes } from '../src/index.ts';
import type { DiscoveredBox } from '../src/index.ts';
import { fileSystem } from './support/host-file-system.ts';

const FIXTURE_SOURCE = fileURLToPath(new URL('./fixtures/basic', import.meta.url));
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
		before: string;
		after: string;
		restored: boolean | null;
	}>;
	editOutcomes: Array<{
		editId: string;
		environments: Record<
			string,
			{ update: boolean; fullReload: boolean; invalidated: unknown[] }
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

async function createFixtureProject(): Promise<string> {
	await fileSystem.mkdir(TMP_ROOT, { recursive: true });
	const base = await fileSystem.makeTempDirectory({
		dir: TMP_ROOT,
		prefix: 'gumbox-basic-',
	});
	// realpath so watcher file events match the configured Vite root in case
	// any segment of the repo path sits behind a symlink.
	const root = await fileSystem.realPath(base);
	temporaryRoots.push(root);
	await fileSystem.copyDirectory(FIXTURE_SOURCE, root);
	return root;
}

async function selectBoxes(root: string, name: string): Promise<DiscoveredBox[]> {
	const discovery = await discoverBoxes({ root });
	const selected = discovery.boxes.filter((entry) => entry.box.name === name);
	expect(selected).toHaveLength(1);
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
				'client edit stays out of the ssr graph',
				'intentionally failing box',
				'message updates without reload',
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
});
