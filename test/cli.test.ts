import path from 'pathe';
import { afterEach, describe, expect, test } from 'vitest';
import { box } from '../src/box.ts';
import { fileURLToPath } from '../src/file-url.ts';
import { runCli } from '../src/cli/run-cli.ts';
import { matchesBoxSelector } from '../src/cli/selector.ts';
import type { DiscoveredBox } from '../src/index.ts';
import { fileSystem } from './support/host-file-system.ts';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
// Repo-local scratch space (gitignored) instead of os.tmpdir(), per the
// runtime-agnostic tooling rule: the os module is forbidden in src/ and test/.
const TMP_ROOT = path.join(fileURLToPath(new URL('..', import.meta.url)), '.tmp');
const TEST_TIMEOUT_MS = 60_000;

const temporaryRoots: string[] = [];

async function createFixtureProject(fixture = 'basic'): Promise<string> {
	await fileSystem.mkdir(TMP_ROOT, { recursive: true });
	const base = await fileSystem.makeTempDirectory({
		dir: TMP_ROOT,
		prefix: `gumbox-cli-${fixture}-`,
	});
	const root = await fileSystem.realPath(base);
	temporaryRoots.push(root);
	await fileSystem.copyDirectory(path.join(FIXTURES_DIR, fixture), root);
	return root;
}

type CliRun = { code: number; stdout: string; stderr: string };

async function execCli(
	args: string[],
	cwd: string,
	options?: { colors?: boolean },
): Promise<CliRun> {
	const stdoutLines: string[] = [];
	const stderrLines: string[] = [];
	const code = await runCli(args, {
		cwd,
		fileSystem,
		stdout: (line) => stdoutLines.push(line),
		stderr: (line) => stderrLines.push(line),
		...(options?.colors === undefined ? {} : { colors: options.colors }),
	});
	return { code, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
}

function printedReceiptPath(stdout: string): string {
	const match = stdout.match(/receipt: (.+)/);
	expect(match, 'expected the CLI output to print a receipt path').not.toBeNull();
	return match![1]!;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((dir) => fileSystem.remove(dir, { recursive: true, force: true })),
	);
});

describe('cli selector matching', () => {
	const root = '/proj';

	function syntheticBox(args: {
		name: string;
		relativeFile: string;
		tags?: string[];
	}): DiscoveredBox {
		return {
			file: path.join(root, args.relativeFile),
			relativeFile: args.relativeFile,
			exportName: 'default',
			box: box({ name: args.name, tags: args.tags ?? [] }, async () => {}),
		};
	}

	const hmrBox = syntheticBox({
		name: 'hmr updates without reload',
		relativeFile: 'scenarios/hmr.box.ts',
		tags: ['hmr'],
	});
	const buttonBox = syntheticBox({
		name: 'button renders',
		relativeFile: 'src/Button.box.tsx',
	});

	test('matches by exact relative file path', () => {
		expect(matchesBoxSelector(hmrBox, 'scenarios/hmr.box.ts', root)).toBe(true);
		expect(matchesBoxSelector(buttonBox, 'scenarios/hmr.box.ts', root)).toBe(false);
	});

	test('matches by file basename with and without the .box extension', () => {
		expect(matchesBoxSelector(hmrBox, 'hmr.box.ts', root)).toBe(true);
		expect(matchesBoxSelector(hmrBox, 'hmr', root)).toBe(true);
		expect(matchesBoxSelector(buttonBox, 'Button', root)).toBe(true);
		expect(matchesBoxSelector(buttonBox, 'hmr', root)).toBe(false);
	});

	test('matches by box name substring and exact name', () => {
		expect(matchesBoxSelector(hmrBox, 'hmr updates without reload', root)).toBe(true);
		expect(matchesBoxSelector(hmrBox, 'updates without', root)).toBe(true);
		expect(matchesBoxSelector(hmrBox, 'UPDATES WITHOUT', root)).toBe(true);
		expect(matchesBoxSelector(buttonBox, 'updates without', root)).toBe(false);
	});

	test('matches by tag', () => {
		expect(matchesBoxSelector(hmrBox, 'hmr', root)).toBe(true);
		expect(matchesBoxSelector(buttonBox, 'nonexistent-tag', root)).toBe(false);
	});

	test('rejects selectors that match nothing about the box', () => {
		expect(matchesBoxSelector(hmrBox, 'totally-unrelated', root)).toBe(false);
	});
});

describe('gumbox cli', () => {
	test(
		'list shows box names, files, tags, and modes and reports invalid box files',
		async () => {
			const root = await createFixtureProject();
			const { code, stdout, stderr } = await execCli(['list'], root);

			expect(code).toBe(0);
			expect(stdout).toContain('message updates without reload');
			expect(stdout).toContain('hmr.box.ts');
			expect(stdout).toContain('environments');
			expect(stdout).toContain('dev');
			expect(stderr).toContain('invalid.box.ts');
			expect(stderr).toContain('does not export a box');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'list --json emits machine-readable boxes and invalid files',
		async () => {
			const root = await createFixtureProject();
			const { code, stdout } = await execCli(['list', '--json'], root);

			expect(code).toBe(0);
			const parsed = JSON.parse(stdout) as {
				root: string;
				boxes: Array<{
					name: string;
					file: string;
					exportName: string;
					tags: string[];
					modes: string[];
				}>;
				invalidBoxFiles: Array<{ file: string; error: string }>;
			};
			// The CLI emits pathe-normalized (forward-slash) paths, while `root`
			// comes from the host filesystem and uses backslashes on Windows.
			expect(parsed.root).toBe(path.normalize(root));
			expect(parsed.boxes).toHaveLength(12);
			const isolation = parsed.boxes.find((entry) => entry.file === 'isolation.box.ts')!;
			expect(isolation.name).toBe('client edit stays out of the ssr graph');
			expect(isolation.exportName).toBe('ClientEditIsolation');
			expect(isolation.tags).toEqual(['environments']);
			expect(isolation.modes).toEqual(['dev']);
			expect(parsed.invalidBoxFiles).toHaveLength(1);
			expect(parsed.invalidBoxFiles[0]!.file).toBe('invalid.box.ts');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'colors pass/fail tokens and summary counts when the host supports color',
		async () => {
			const root = await createFixtureProject();

			const passing = await execCli(['create, remove, and copy files'], root, {
				colors: true,
			});
			expect(passing.code).toBe(0);
			expect(passing.stdout).toContain(
				'\u001b[32mpass\u001b[39m create, remove, and copy files',
			);
			expect(passing.stdout).toContain('\u001b[32m1 passed\u001b[39m, 0 failed (1 boxes)');

			const failing = await execCli(['intentionally failing box'], root, { colors: true });
			expect(failing.code).toBe(1);
			expect(failing.stdout).toContain('\u001b[31mfail\u001b[39m intentionally failing box');
			expect(failing.stdout).toContain('\u001b[31m1 failed\u001b[39m (1 boxes)');

			// Colors stay off by default so piped output remains plain text.
			const plain = await execCli(['create, remove, and copy files'], root);
			expect(plain.stdout).toContain('pass create, remove, and copy files');
			expect(plain.stdout).not.toContain('\u001b[');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'run with a basename selector runs only the matching boxes and exits 0',
		async () => {
			const root = await createFixtureProject();
			const { code, stdout } = await execCli(['run', 'edits'], root);

			expect(code).toBe(0);
			expect(stdout).toContain('pass create, remove, and copy files');
			expect(stdout).toContain('pass batch edit touches multiple files');
			expect(stdout).toContain('2 passed, 0 failed (2 boxes)');

			const receiptPath = printedReceiptPath(stdout);
			const receipt = JSON.parse(await fileSystem.readTextFile(receiptPath)) as {
				gumboxReceipt: number;
				boxes: unknown[];
			};
			expect(receipt.gumboxReceipt).toBe(1);
			expect(receipt.boxes).toHaveLength(2);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'run with a glob selector matches box files like a developer expects',
		async () => {
			const root = await createFixtureProject();
			const { code, stdout } = await execCli(['run', 'edits.*'], root);

			expect(code).toBe(0);
			expect(stdout).toContain('2 passed, 0 failed (2 boxes)');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a failing box exits 1 and prints the receipt path',
		async () => {
			const root = await createFixtureProject();
			const { code, stdout } = await execCli(['failing'], root);

			expect(code).toBe(1);
			expect(stdout).toContain('fail intentionally failing box');
			expect(stdout).toContain('intentional failure');

			const receiptPath = printedReceiptPath(stdout);
			const receipt = JSON.parse(await fileSystem.readTextFile(receiptPath)) as {
				summary: { status: string };
			};
			expect(receipt.summary.status).toBe('failed');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'--json prints a compact machine-readable run summary',
		async () => {
			const root = await createFixtureProject();
			const { code, stdout } = await execCli(['failing', '--json'], root);

			expect(code).toBe(1);
			const summary = JSON.parse(stdout) as {
				status: string;
				runId: string;
				receiptPath: string;
				root: string;
				summary: { total: number; passed: number; failed: number };
				failed: Array<{ name: string; file: string; error: string | null }>;
			};
			expect(summary.status).toBe('failed');
			// pathe-normalized CLI output vs a native (backslash on Windows) tmp path.
			expect(summary.root).toBe(path.normalize(root));
			expect(summary.summary).toEqual({ total: 1, passed: 0, failed: 1 });
			expect(summary.failed[0]!.name).toBe('intentionally failing box');
			expect(summary.failed[0]!.error).toContain('intentional failure');
			expect(await fileSystem.exists(summary.receiptPath)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'--receipt-dir writes the receipt and latest pointer under the override directory',
		async () => {
			const root = await createFixtureProject();
			const { code, stdout } = await execCli(
				['run', 'edits', '--receipt-dir', 'qa/receipts'],
				root,
			);

			expect(code).toBe(0);
			const receiptPath = printedReceiptPath(stdout);
			const receiptsDir = path.join(root, 'qa', 'receipts');
			expect(receiptPath.startsWith(receiptsDir)).toBe(true);
			expect(await fileSystem.exists(receiptPath)).toBe(true);

			const runId = path.basename(path.dirname(receiptPath));
			const latest = (await fileSystem.readTextFile(path.join(receiptsDir, 'latest'))).trim();
			expect(latest).toBe(runId);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a selector that matches nothing exits 2 with a clear message',
		async () => {
			const root = await createFixtureProject();
			const { code, stderr } = await execCli(['totally-missing-selector'], root);

			expect(code).toBe(2);
			expect(stderr).toContain("no boxes matched selector 'totally-missing-selector'");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a selector that matches an invalid box file exits 2 with the load error',
		async () => {
			const root = await createFixtureProject();
			const { code, stderr } = await execCli(['invalid'], root);

			expect(code).toBe(2);
			expect(stderr).toContain('invalid.box.ts');
			expect(stderr).toContain('does not export a box');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'--mode filters boxes by declared mode and exits 2 when nothing matches',
		async () => {
			const root = await createFixtureProject();
			const { code, stderr } = await execCli(['run', 'edits', '--mode', 'build'], root);

			expect(code).toBe(2);
			expect(stderr).toContain("mode 'build'");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'gumbox preview exits 2 when no preview-compatible boxes exist',
		async () => {
			const root = await createFixtureProject();
			const { code, stderr } = await execCli(['preview'], root);

			expect(code).toBe(2);
			expect(stderr).toContain("mode 'preview'");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'later-slice commands and flags exit 2 with a clear not-implemented message',
		async () => {
			const root = await createFixtureProject();

			const typesCommand = await execCli(['types'], root);
			expect(typesCommand.code).toBe(2);
			expect(typesCommand.stderr).toContain('not implemented');

			const watchFlag = await execCli(['hmr', '--watch'], root);
			expect(watchFlag.code).toBe(2);
			expect(watchFlag.stderr).toContain('not implemented');

			const uiFlag = await execCli(['--ui'], root);
			expect(uiFlag.code).toBe(2);
			expect(uiFlag.stderr).toContain('not implemented');

			const unknownFlag = await execCli(['--nope'], root);
			expect(unknownFlag.code).toBe(2);
			expect(unknownFlag.stderr).toContain("unknown option '--nope'");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'--help prints usage and exits 0',
		async () => {
			const root = await createFixtureProject();
			const { code, stdout } = await execCli(['--help'], root);

			expect(code).toBe(0);
			expect(stdout).toContain('Usage');
			expect(stdout).toContain('gumbox list');
			expect(stdout).toContain('--receipt-dir');
			expect(stdout).toContain('gumbox evidence');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'per-box lines carry witness tokens in stable order with plain symbols',
		async () => {
			const root = await createFixtureProject();

			// Edit-only boxes never engage the pipeline or a page: every scene
			// witness reads not-called.
			const editsRun = await execCli(['create, remove, and copy files'], root);
			expect(editsRun.code).toBe(0);
			expect(editsRun.stdout).toContain('[pipeline. client. driver.]');

			// A dev-pipeline box without a browser: the pipeline corroborates
			// while client and driver stay not-called.
			const hmrRun = await execCli(['message updates without reload'], root);
			expect(hmrRun.code).toBe(0);
			expect(hmrRun.stdout).toContain('[pipeline+ client. driver.]');
			// No contested marker on an uncontested run.
			expect(hmrRun.stdout).not.toContain('contested');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'--json adds per-box witness summaries and a contested list',
		async () => {
			const root = await createFixtureProject();
			const { code, stdout } = await execCli(['run', 'edits', '--json'], root);

			expect(code).toBe(0);
			const summary = JSON.parse(stdout) as {
				contested: unknown[];
				boxes: Array<{
					name: string;
					status: string;
					contested: boolean;
					witnesses: Record<string, string>;
				}>;
			};
			expect(summary.contested).toEqual([]);
			expect(summary.boxes).toHaveLength(2);
			const fileOperations = summary.boxes.find(
				(box) => box.name === 'create, remove, and copy files',
			)!;
			expect(fileOperations.status).toBe('passed');
			expect(fileOperations.contested).toBe(false);
			expect(fileOperations.witnesses).toEqual({
				pipeline: 'not-called',
				client: 'not-called',
				driver: 'not-called',
				box: 'corroborates',
			});
		},
		TEST_TIMEOUT_MS,
	);
});

describe('gumbox evidence', () => {
	test(
		'renders witness testimony for the latest receipt by default',
		async () => {
			const root = await createFixtureProject();
			const run = await execCli(['run', 'edits'], root);
			expect(run.code).toBe(0);

			const evidence = await execCli(['evidence'], root);
			expect(evidence.code).toBe(0);
			expect(evidence.stdout).toContain('case: create, remove, and copy files — pass');
			expect(evidence.stdout).toContain('case: batch edit touches multiple files — pass');
			expect(evidence.stdout).toContain('pipeline witness — not-called');
			expect(evidence.stdout).toContain('box — corroborates');
			expect(evidence.stdout).toContain('edits: 3');
			expect(evidence.stdout).toContain('restoration: clean');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'narrows by selector and witness, and --json emits the semantic blocks',
		async () => {
			const root = await createFixtureProject();
			const run = await execCli(['run', 'edits'], root);
			expect(run.code).toBe(0);

			const narrowed = await execCli(['evidence', 'batch', '--witness', 'box'], root);
			expect(narrowed.code).toBe(0);
			expect(narrowed.stdout).toContain('case: batch edit touches multiple files — pass');
			expect(narrowed.stdout).not.toContain('create, remove, and copy files');
			expect(narrowed.stdout).not.toContain('pipeline witness');
			expect(narrowed.stdout).toContain('box — corroborates');

			const json = await execCli(['evidence', 'batch', '--json'], root);
			expect(json.code).toBe(0);
			const parsed = JSON.parse(json.stdout) as {
				receiptPath: string;
				boxes: Array<{
					name: string;
					status: string;
					contested: boolean;
					witnesses: Record<
						string,
						{ verdict: string; statements: number; against: unknown[] }
					>;
				}>;
			};
			expect(parsed.boxes).toHaveLength(1);
			expect(parsed.boxes[0]!.name).toBe('batch edit touches multiple files');
			expect(parsed.boxes[0]!.contested).toBe(false);
			expect(parsed.boxes[0]!.witnesses['box']!.verdict).toBe('corroborates');
			expect(parsed.boxes[0]!.witnesses['box']!.against).toEqual([]);
			expect(await fileSystem.exists(parsed.receiptPath)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'reads a receipt by run id or path and exits 2 when none is found',
		async () => {
			const root = await createFixtureProject();

			// No run yet: nothing to drill into.
			const missing = await execCli(['evidence'], root);
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain('no receipt found');

			const run = await execCli(['run', 'edits'], root);
			expect(run.code).toBe(0);
			const receiptPath = printedReceiptPath(run.stdout);
			const runId = path.basename(path.dirname(receiptPath));

			const byId = await execCli(['evidence', '--receipt', runId], root);
			expect(byId.code).toBe(0);
			expect(byId.stdout).toContain('case: create, remove, and copy files — pass');

			const byPath = await execCli(['evidence', '--receipt', receiptPath], root);
			expect(byPath.code).toBe(0);

			const unknownRun = await execCli(['evidence', '--receipt', 'no-such-run'], root);
			expect(unknownRun.code).toBe(2);
			expect(unknownRun.stderr).toContain("no receipt found for 'no-such-run'");

			// --receipt and --witness belong to gumbox evidence only.
			const misused = await execCli(['run', 'edits', '--witness', 'client'], root);
			expect(misused.code).toBe(2);
			expect(misused.stderr).toContain('only apply to gumbox evidence');

			const badWitness = await execCli(['evidence', '--witness', 'judge'], root);
			expect(badWitness.code).toBe(2);
			expect(badWitness.stderr).toContain('--witness must be one of');
		},
		TEST_TIMEOUT_MS,
	);
});
