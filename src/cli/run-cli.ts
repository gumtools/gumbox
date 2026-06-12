import path from 'pathe';
import type { GumboxBrowser } from '../browser.ts';
import { discoverBoxes } from '../discovery.ts';
import type { GumboxFileSystem } from '../filesystem.ts';
import { runBoxes } from '../runner.ts';
import type { BoxRunResult, DiscoveredBox, InvalidBoxFile } from '../types.ts';
import { SCENE_WITNESS_IDS, summarizeWitnessVerdicts, WITNESS_IDS } from '../witness.ts';
import type {
	BoxWitnesses,
	WitnessId,
	WitnessStatement,
	WitnessStatementKind,
	WitnessTestimony,
	WitnessVerdict,
} from '../witness.ts';
import { matchesFileSelector, resolveSelector } from './selector.ts';

/** All boxes passed. */
export const EXIT_PASSED = 0;
/** At least one box failed; the receipt path is printed. */
export const EXIT_BOX_FAILURE = 1;
/** Usage, selector, discovery, config, or infrastructure error. */
export const EXIT_USAGE_OR_SETUP_ERROR = 2;

/**
 * Host capabilities injected into the runtime-agnostic CLI core. The bin shim
 * (and tests) provide these; the core never touches process/Deno globals.
 */
export type CliDependencies = {
	/** Project root the CLI operates on (the host's working directory). */
	cwd: string;
	fileSystem: GumboxFileSystem;
	/** Browser automation capability used by boxes that visit routes. */
	browser?: GumboxBrowser;
	stdout(line: string): void;
	stderr(line: string): void;
	/** ANSI-color human output (default false; the bin shim detects the TTY). */
	colors?: boolean;
};

/**
 * Semantic text colors for human CLI output. Color is renderer-only: the
 * plain palette renders identical text, so symbols and words carry the full
 * meaning and color only paints them.
 */
type Palette = {
	green(text: string): string;
	red(text: string): string;
	yellow(text: string): string;
	dim(text: string): string;
};

const ANSI_PALETTE: Palette = {
	green: (text) => `\u001b[32m${text}\u001b[39m`,
	red: (text) => `\u001b[31m${text}\u001b[39m`,
	yellow: (text) => `\u001b[33m${text}\u001b[39m`,
	dim: (text) => `\u001b[2m${text}\u001b[22m`,
};

const PLAIN_PALETTE: Palette = {
	green: (text) => text,
	red: (text) => text,
	yellow: (text) => text,
	dim: (text) => text,
};

/** Plain symbols that carry the verdict meaning without color. */
const VERDICT_SYMBOLS: Record<WitnessVerdict, string> = {
	corroborates: '+',
	contradicts: '!',
	silent: '-',
	'not-called': '.',
};

function paintVerdict(paint: Palette, verdict: WitnessVerdict, text: string): string {
	if (verdict === 'contradicts') {
		return paint.red(text);
	}
	if (verdict === 'corroborates') {
		return paint.green(text);
	}
	return paint.dim(text);
}

/** Stable greppable witness tokens, always in the order pipeline, client, driver. */
function witnessTokens(witnesses: BoxWitnesses, paint: Palette): string {
	const tokens = SCENE_WITNESS_IDS.map((id) => {
		const verdict = witnesses[id].verdict;
		return paintVerdict(paint, verdict, `${id}${VERDICT_SYMBOLS[verdict]}`);
	});
	return `[${tokens.join(' ')}]`;
}

/** Human nouns for contradiction counts on per-box sub-lines. */
const STATEMENT_COUNT_NOUNS: Record<WitnessStatementKind, string> = {
	'console-error': 'console error',
	'page-error': 'page error',
	'request-failed': 'failed request',
	'vite-error': 'vite error',
	'edit-error': 'edit error',
	'restore-failed': 'failed restore',
	'assertion-failed': 'failed assertion',
	'box-error': 'box error',
};

function countStatementKinds(against: WitnessStatement[]): string {
	const counts = new Map<WitnessStatementKind, number>();
	for (const statement of against) {
		counts.set(statement.kind, (counts.get(statement.kind) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([kind, count]) => `${count} ${STATEMENT_COUNT_NOUNS[kind]}${count === 1 ? '' : 's'}`)
		.join(', ');
}

/** `client reported: 1 page error, 1 console error   driver reported: 1 failed request` */
function contradictionSummaryLine(witnesses: BoxWitnesses): string | null {
	const parts = WITNESS_IDS.filter((id) => witnesses[id].against.length > 0).map(
		(id) => `${id} reported: ${countStatementKinds(witnesses[id].against)}`,
	);
	return parts.length === 0 ? null : `     ${parts.join('   ')}`;
}

export const USAGE = `gumbox — Vite pipeline QA boxes that write receipts

Usage:
  gumbox [selector] [options]      run matching boxes headlessly
  gumbox run [selector] [options]  explicit form of gumbox [selector]
  gumbox preview [--run]           run preview-mode boxes against built output
  gumbox list [--json]             list discovered boxes without running them
  gumbox evidence [selector]       show per-witness testimony from a receipt

Selectors match like Vitest: exact file path, glob, box name, file basename, or tag.

Options:
  --json               machine-readable output for CI and agents
  --receipt-dir <dir>  write receipts under <dir> (default .gumbox/receipts)
  --mode <mode>        only run boxes that declare <mode> (dev, build, ...)
  --preview            shorthand for --mode preview
  --headed             run browser sessions with a visible window
  --receipt <id|path>  evidence: read a specific receipt (default latest run)
  --witness <id>       evidence: narrow to pipeline, client, driver, or box
  -h, --help           show this help

Exit codes:
  0  all boxes passed
  1  a box failed (the receipt path is printed)
  2  usage, selector, discovery, or pipeline setup error

Not implemented in this slice: open, types, replay, doctor, init, migrate,
--ui, --watch, preview --open.`;

const LATER_SLICE_COMMANDS: Record<string, string> = {
	open: 'the /__gumbox dev middleware slice',
	types: 'the typegen slice',
	replay: 'the receipt viewer slice',
	doctor: 'the typegen slice',
	init: 'a post-MVP slice',
	migrate: 'a post-MVP slice',
};

const LATER_SLICE_FLAGS: Record<string, string> = {
	'--ui': 'the Gumbox UI ships with the dev middleware slice',
	'--watch': 'watch mode ships with a later slice',
	'--open': 'the preview state gallery ships with the dev middleware slice',
};

type RunCommand = {
	kind: 'run';
	selector: string | null;
	json: boolean;
	receiptDir: string | null;
	mode: string | null;
	headed: boolean;
};
type ListCommand = { kind: 'list'; json: boolean };
type EvidenceCommand = {
	kind: 'evidence';
	selector: string | null;
	receipt: string | null;
	witness: WitnessId | null;
	json: boolean;
};
type HelpCommand = { kind: 'help' };
type CliCommand = RunCommand | ListCommand | EvidenceCommand | HelpCommand;

type ParseResult = { command: CliCommand } | { error: string };

function usageError(message: string): ParseResult {
	return { error: `${message} Run gumbox --help for usage.` };
}

function parseCliArguments(args: string[]): ParseResult {
	let json = false;
	let receiptDir: string | null = null;
	let mode: string | null = null;
	let headed = false;
	let runFlag = false;
	let receiptReference: string | null = null;
	let witnessFilter: string | null = null;
	const positionals: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (argument === '--help' || argument === '-h') {
			return { command: { kind: 'help' } };
		}
		if (argument === '--json') {
			json = true;
			continue;
		}
		if (argument === '--headed') {
			headed = true;
			continue;
		}
		if (argument === '--preview') {
			mode = 'preview';
			continue;
		}
		if (argument === '--run') {
			runFlag = true;
			continue;
		}
		const valueFlag = ['--receipt-dir', '--receipt', '--mode', '--witness'].find(
			(flag) => argument === flag || argument.startsWith(`${flag}=`),
		);
		if (valueFlag !== undefined) {
			let value: string | undefined;
			if (argument.includes('=')) {
				value = argument.slice(valueFlag.length + 1);
			} else {
				value = args[index + 1];
				index += 1;
			}
			if (value === undefined || value.length === 0 || value.startsWith('--')) {
				return usageError(`${valueFlag} requires a value.`);
			}
			if (valueFlag === '--receipt-dir') {
				receiptDir = value;
			} else if (valueFlag === '--receipt') {
				receiptReference = value;
			} else if (valueFlag === '--witness') {
				witnessFilter = value;
			} else {
				mode = value;
			}
			continue;
		}
		const laterFlagReason = LATER_SLICE_FLAGS[argument];
		if (laterFlagReason !== undefined) {
			return { error: `${argument} is not implemented yet: ${laterFlagReason}.` };
		}
		if (argument.startsWith('-')) {
			return usageError(`unknown option '${argument}'.`);
		}
		positionals.push(argument);
	}

	const [first, second, ...extra] = positionals;
	if (first !== undefined && LATER_SLICE_COMMANDS[first] !== undefined) {
		return {
			error: `gumbox ${first} is not implemented yet; it ships with ${LATER_SLICE_COMMANDS[first]}.`,
		};
	}
	if (runFlag && first !== 'preview') {
		return usageError('--run only applies to gumbox preview.');
	}
	if (first === 'evidence') {
		if (extra.length > 0) {
			return usageError(`expected at most one selector, saw '${extra.join("', '")}'.`);
		}
		if (witnessFilter !== null && !(WITNESS_IDS as readonly string[]).includes(witnessFilter)) {
			return usageError(`--witness must be one of ${WITNESS_IDS.join(', ')}.`);
		}
		return {
			command: {
				kind: 'evidence',
				selector: second ?? null,
				receipt: receiptReference,
				witness: witnessFilter as WitnessId | null,
				json,
			},
		};
	}
	if (receiptReference !== null || witnessFilter !== null) {
		return usageError('--receipt and --witness only apply to gumbox evidence.');
	}
	if (first === 'list') {
		if (second !== undefined) {
			return usageError(`gumbox list does not take a selector ('${second}').`);
		}
		return { command: { kind: 'list', json } };
	}
	if (first === 'preview') {
		if (second !== undefined) {
			return usageError(`gumbox preview does not take a selector ('${second}').`);
		}
		// `gumbox preview` runs preview-compatible boxes (those declaring the
		// 'preview' mode); --run is the explicit form of the same behavior.
		return {
			command: { kind: 'run', selector: null, json, receiptDir, mode: 'preview', headed },
		};
	}
	const selector = first === 'run' ? second : first;
	const trailing = first === 'run' ? extra : second === undefined ? [] : [second, ...extra];
	if (trailing.length > 0) {
		return usageError(`expected at most one selector, saw '${trailing.join("', '")}'.`);
	}
	return { command: { kind: 'run', selector: selector ?? null, json, receiptDir, mode, headed } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describeBox(box: DiscoveredBox): Record<string, unknown> {
	return {
		name: box.box.name,
		file: box.relativeFile,
		exportName: box.exportName,
		tags: [...box.box.tags],
		modes: [...box.box.modes],
		ui: box.box.ui,
	};
}

function reportInvalidBoxFiles(invalid: InvalidBoxFile[], deps: CliDependencies): void {
	for (const file of invalid) {
		deps.stderr(`invalid box file ${file.relativeFile}: ${file.error}`);
	}
}

async function runListCommand(command: ListCommand, deps: CliDependencies): Promise<number> {
	const discovery = await discoverBoxes({ root: deps.cwd });
	if (command.json) {
		deps.stdout(
			JSON.stringify({
				root: discovery.root,
				boxes: discovery.boxes.map(describeBox),
				invalidBoxFiles: discovery.invalid.map((file) => ({
					file: file.relativeFile,
					error: file.error,
				})),
			}),
		);
		return EXIT_PASSED;
	}
	if (discovery.boxes.length === 0) {
		deps.stdout(`no *.box.ts or *.box.tsx files found under ${discovery.root}`);
	}
	for (const entry of discovery.boxes) {
		const annotations = [
			`modes: ${entry.box.modes.join(', ')}`,
			...(entry.box.tags.length === 0 ? [] : [`tags: ${entry.box.tags.join(', ')}`]),
		];
		deps.stdout(`${entry.box.name}`);
		deps.stdout(
			`  ${entry.relativeFile} (export ${entry.exportName}) — ${annotations.join('; ')}`,
		);
	}
	reportInvalidBoxFiles(discovery.invalid, deps);
	return EXIT_PASSED;
}

function noMatchReason(command: RunCommand): string {
	const selectorPart =
		command.selector === null
			? 'no boxes were discovered'
			: `no boxes matched selector '${command.selector}'`;
	const modePart = command.mode === null ? '' : ` with mode '${command.mode}'`;
	return `${selectorPart}${modePart}.`;
}

async function runRunCommand(command: RunCommand, deps: CliDependencies): Promise<number> {
	const root = deps.cwd;
	const discovery = await discoverBoxes({ root });
	let selected = discovery.boxes;
	let relevantInvalid = discovery.invalid;
	if (command.selector !== null) {
		const matches = await resolveSelector({
			selector: command.selector,
			root,
			boxes: discovery.boxes,
			invalid: discovery.invalid,
		});
		selected = matches.boxes;
		relevantInvalid = matches.invalid;
	}
	if (command.mode !== null) {
		const mode = command.mode;
		selected = selected.filter((entry) => entry.box.modes.includes(mode));
	}
	reportInvalidBoxFiles(relevantInvalid, deps);
	if (selected.length === 0) {
		const reason = noMatchReason(command);
		if (command.json) {
			deps.stdout(JSON.stringify({ status: 'error', error: reason }));
		}
		deps.stderr(`${reason} Run gumbox list to see discovered boxes.`);
		return EXIT_USAGE_OR_SETUP_ERROR;
	}

	// Human output streams each box result as it lands, so multi-box runs
	// never look hung between groups; --json stays one machine-readable blob.
	const paint = deps.colors === true ? ANSI_PALETTE : PLAIN_PALETTE;
	const reportBoxResult = (box: BoxRunResult): void => {
		const tokens = witnessTokens(box.witnesses, paint);
		const filePart = paint.dim(`(${box.file})`);
		if (box.status === 'passed') {
			const contestedPart = box.contested ? `${paint.yellow('contested')}  ` : '';
			deps.stdout(
				`${paint.green('pass')} ${box.name}  ${tokens}  ${contestedPart}${filePart}`,
			);
			const subLine = box.contested ? contradictionSummaryLine(box.witnesses) : null;
			if (subLine !== null) {
				deps.stdout(subLine);
			}
			return;
		}
		deps.stdout(`${paint.red('fail')} ${box.name}  ${tokens}  ${filePart}`);
		if (box.error !== null) {
			deps.stdout(`     ${box.error.message}`);
		}
	};

	const result = await runBoxes({
		root,
		boxes: selected,
		invalid: relevantInvalid,
		fileSystem: deps.fileSystem,
		headless: !command.headed,
		...(deps.browser === undefined ? {} : { browser: deps.browser }),
		...(command.receiptDir === null ? {} : { receiptDir: command.receiptDir }),
		...(command.json ? {} : { onBoxResult: reportBoxResult }),
	});
	const failedBoxes = result.boxes.filter((box) => box.status === 'failed');
	const contestedBoxes = result.boxes.filter((box) => box.contested);

	if (command.json) {
		deps.stdout(
			JSON.stringify({
				status: result.status,
				runId: result.runId,
				receiptPath: result.receiptPath,
				root: result.root,
				summary: {
					total: result.boxes.length,
					passed: result.boxes.length - failedBoxes.length,
					failed: failedBoxes.length,
				},
				failed: failedBoxes.map((box) => ({
					name: box.name,
					file: box.file,
					error: box.error?.message ?? null,
				})),
				contested: contestedBoxes.map((box) => ({
					name: box.name,
					file: box.file,
					witnesses: summarizeWitnessVerdicts(box.witnesses),
				})),
				boxes: result.boxes.map((box) => ({
					name: box.name,
					file: box.file,
					status: box.status,
					contested: box.contested,
					witnesses: summarizeWitnessVerdicts(box.witnesses),
				})),
				invalidBoxFiles: relevantInvalid.map((file) => ({
					file: file.relativeFile,
					error: file.error,
				})),
			}),
		);
		return failedBoxes.length === 0 ? EXIT_PASSED : EXIT_BOX_FAILURE;
	}

	const passedPart = paint.green(`${result.boxes.length - failedBoxes.length} passed`);
	const failedPart =
		failedBoxes.length > 0
			? paint.red(`${failedBoxes.length} failed`)
			: `${failedBoxes.length} failed`;
	const contestedPart =
		contestedBoxes.length === 0
			? ''
			: ` — ${paint.yellow(
					`${contestedBoxes.length} contested pass${contestedBoxes.length === 1 ? '' : 'es'}`,
				)}`;
	deps.stdout(`${passedPart}, ${failedPart} (${result.boxes.length} boxes)${contestedPart}`);
	deps.stdout(`receipt: ${paint.dim(result.receiptPath)}`);
	return failedBoxes.length === 0 ? EXIT_PASSED : EXIT_BOX_FAILURE;
}

/** The slice of one receipt page record the evidence renderer summarizes. */
type ReceiptPageRecord = {
	consoleMessages?: Array<{ level: string; text: string }>;
	snapshots?: Array<{ screenshot: string | null; html: string }>;
	navigations?: unknown[];
	trackedEvents?: Record<string, unknown[]>;
	interactions?: unknown[];
};

/** The slice of one receipt box record the evidence command reads. */
type ReceiptBoxRecord = {
	name: string;
	file: string;
	tags?: string[];
	status: string;
	vite?: { serverUrl: string | null; environments: string[]; browserAlias: string | null };
	edits?: unknown[];
	builds?: unknown[];
	previews?: unknown[];
	pages?: ReceiptPageRecord[];
	timeline?: Array<{ type: string }>;
	witnesses?: BoxWitnesses;
	summary?: {
		assertions?: { passed: number; failed: number };
		restorationFailed?: boolean;
		contested?: boolean;
	};
};

/**
 * Resolves which receipt `gumbox evidence` reads: an explicit receipt.json
 * path, a run directory, a run id under .gumbox/receipts, or (default) the
 * run the `latest` pointer names.
 */
async function resolveEvidenceReceiptPath(
	reference: string | null,
	deps: CliDependencies,
): Promise<string | null> {
	const { fileSystem, cwd } = deps;
	const receiptsDir = path.resolve(cwd, '.gumbox', 'receipts');
	if (reference === null) {
		const latestPointer = path.join(receiptsDir, 'latest');
		if (!(await fileSystem.exists(latestPointer))) {
			return null;
		}
		const runId = (await fileSystem.readTextFile(latestPointer)).trim();
		const receiptPath = path.join(receiptsDir, runId, 'receipt.json');
		return (await fileSystem.exists(receiptPath)) ? receiptPath : null;
	}
	const direct = path.resolve(cwd, reference);
	if (reference.endsWith('.json') && (await fileSystem.exists(direct))) {
		return direct;
	}
	const candidates = [
		path.join(direct, 'receipt.json'),
		path.join(receiptsDir, reference, 'receipt.json'),
	];
	for (const candidate of candidates) {
		if (await fileSystem.exists(candidate)) {
			return candidate;
		}
	}
	return null;
}

/** Receipt boxes match the same way run selectors do: file, tag, or name. */
function matchesReceiptBox(box: ReceiptBoxRecord, selector: string, root: string): boolean {
	const matchesFile = matchesFileSelector({
		file: path.resolve(root, box.file),
		relativeFile: box.file,
		selector,
		root,
	});
	if (matchesFile) {
		return true;
	}
	if ((box.tags ?? []).includes(selector)) {
		return true;
	}
	return box.name.toLowerCase().includes(selector.toLowerCase());
}

/** Drill-down labels for statements against the run. */
const STATEMENT_LABELS: Record<WitnessStatementKind, string> = {
	'console-error': 'console error',
	'page-error': 'page error',
	'request-failed': 'request failed',
	'vite-error': 'vite error',
	'edit-error': 'edit error',
	'restore-failed': 'restore failed',
	'assertion-failed': 'assertion failed',
	'box-error': 'box error',
};

/** '2026-06-11T04:16:44.150Z' → '04:16:44.150Z' for compact statement origins. */
function statementTimestamp(at: string): string {
	return at.length > 11 ? at.slice(11) : at;
}

function pluralizeStatements(count: number): string {
	return `${count} statement${count === 1 ? '' : 's'}`;
}

function witnessHeadline(id: WitnessId, testimony: WitnessTestimony, paint: Palette): string {
	const title = id === 'box' ? 'box' : `${id} witness`;
	const verdictWord = paintVerdict(paint, testimony.verdict, testimony.verdict);
	if (testimony.verdict === 'contradicts') {
		// Renderer-only crime wording; the receipt verdict stays 'contradicts'.
		const crimePhrase = paintVerdict(paint, testimony.verdict, 'reports a crime');
		return `${title} — ${crimePhrase} (${testimony.against.length})`;
	}
	if (testimony.verdict === 'corroborates') {
		return `${title} — ${verdictWord} (${pluralizeStatements(testimony.statements)})`;
	}
	return `${title} — ${verdictWord}`;
}

/** One against-statement paired with the witness that reported it. */
type CrimeReport = { witness: WitnessId; statement: WitnessStatement };

function collectCrimeReports(witnesses: BoxWitnesses): CrimeReport[] {
	return WITNESS_IDS.flatMap((id) =>
		witnesses[id].against.map((statement) => ({ witness: id, statement })),
	);
}

/**
 * The blotter that opens the evidence drill-down: every against-statement
 * across all witnesses, each attributed to its reporting witness. Rendered
 * only when at least one witness reported a crime. Renderer-only wording;
 * receipt verdicts and statement kinds stay untouched.
 */
function renderCrimeBlotter(witnesses: BoxWitnesses, paint: Palette): string[] {
	const reports = collectCrimeReports(witnesses);
	if (reports.length === 0) {
		return [];
	}
	const labelWidth =
		Math.max(...reports.map(({ statement }) => STATEMENT_LABELS[statement.kind].length)) + 2;
	const lines = [`crimes reported (${reports.length}):`];
	for (const { witness, statement } of reports) {
		const label = STATEMENT_LABELS[statement.kind].padEnd(labelWidth);
		lines.push(
			`  ${paint.red('!')} ${label}${statement.text}  ${paint.dim('— reported by')} ${witness}`,
		);
	}
	return lines;
}

function renderAgainstLines(testimony: WitnessTestimony, paint: Palette): string[] {
	const labelWidth =
		Math.max(...testimony.against.map((statement) => STATEMENT_LABELS[statement.kind].length)) +
		2;
	return testimony.against.map((statement) => {
		const label = STATEMENT_LABELS[statement.kind].padEnd(labelWidth);
		const origin = [statement.page, statementTimestamp(statement.at)]
			.filter((part) => part !== undefined && part !== '')
			.join(', ');
		const originPart = origin === '' ? '' : `  (${origin})`;
		return paint.red(`  ! ${label}${statement.text}${originPart}`);
	});
}

/** Hot payload timeline types the pipeline summary counts. */
const HOT_PAYLOAD_TIMELINE_TYPES = new Set([
	'vite hmr update sent',
	'vite full reload sent',
	'vite error payload sent',
	'vite custom payload sent',
	'vite hot payload sent',
]);

function pipelineDetailLines(box: ReceiptBoxRecord): string[] {
	const lines: string[] = [];
	const timelineTypes = (box.timeline ?? []).map((event) => event.type);
	const serverUrl = box.vite?.serverUrl ?? null;
	if (serverUrl !== null) {
		const browserAlias = box.vite?.browserAlias ?? null;
		const aliasPart = browserAlias === null ? '' : ` (browser alias: ${browserAlias})`;
		const environments = (box.vite?.environments ?? []).join(', ');
		lines.push(`  server started ${serverUrl}  environments: ${environments}${aliasPart}`);
		const hotConnected =
			timelineTypes.includes('vite hot channel connected') ||
			timelineTypes.includes('hot channel websocket connected');
		const payloads = timelineTypes.filter((type) =>
			HOT_PAYLOAD_TIMELINE_TYPES.has(type),
		).length;
		const edits = (box.edits ?? []).length;
		lines.push(
			'  ' +
				[
					hotConnected ? 'hot channel connected' : 'no hot channel observed',
					payloads === 0
						? 'no hot payloads sent'
						: `${payloads} hot payload${payloads === 1 ? '' : 's'} sent`,
					edits === 0
						? 'no project edits'
						: `${edits} project edit${edits === 1 ? '' : 's'}`,
				].join('  '),
		);
	}
	const builds = (box.builds ?? []).length;
	const previews = (box.previews ?? []).length;
	if (builds > 0 || previews > 0) {
		lines.push(`  builds: ${builds}  previews: ${previews}`);
	}
	return lines;
}

function clientDetailLines(box: ReceiptBoxRecord): string[] {
	const pages = box.pages ?? [];
	if (pages.length === 0) {
		return [];
	}
	const messages = pages.flatMap((page) => page.consoleMessages ?? []);
	const errors = messages.filter((message) => message.level === 'error').length;
	const trackedNames = [
		...new Set(pages.flatMap((page) => Object.keys(page.trackedEvents ?? {}))),
	];
	const snapshots = pages.reduce((total, page) => total + (page.snapshots ?? []).length, 0);
	return [
		`  console: ${messages.length} message${messages.length === 1 ? '' : 's'} ` +
			`(${errors} error${errors === 1 ? '' : 's'})  ` +
			`tracked events: ${trackedNames.length === 0 ? 'none' : trackedNames.join(', ')}  ` +
			`dom snapshots: ${snapshots}`,
	];
}

function driverDetailLines(box: ReceiptBoxRecord): string[] {
	const pages = box.pages ?? [];
	if (pages.length === 0) {
		return [];
	}
	const navigations = pages.reduce((total, page) => total + (page.navigations ?? []).length, 0);
	const interactions = pages.reduce((total, page) => total + (page.interactions ?? []).length, 0);
	const screenshots = pages
		.flatMap((page) => (page.snapshots ?? []).map((snapshot) => snapshot.screenshot))
		.filter((screenshot): screenshot is string => screenshot !== null);
	return [
		`  navigations after load: ${navigations === 0 ? 'none' : navigations}  ` +
			`interactions: ${interactions === 0 ? 'none' : interactions}  ` +
			`screenshot: ${screenshots.at(-1) ?? 'none'}`,
	];
}

function boxDetailLines(box: ReceiptBoxRecord): string[] {
	const assertions = box.summary?.assertions ?? { passed: 0, failed: 0 };
	const edits = (box.edits ?? []).length;
	const restoration = box.summary?.restorationFailed === true ? 'failed' : 'clean';
	return [
		`  assertions: ${assertions.passed} passed, ${assertions.failed} failed  ` +
			`edits: ${edits === 0 ? 'none' : edits}  restoration: ${restoration}`,
	];
}

function witnessDetailLines(id: WitnessId, box: ReceiptBoxRecord): string[] {
	switch (id) {
		case 'pipeline':
			return pipelineDetailLines(box);
		case 'client':
			return clientDetailLines(box);
		case 'driver':
			return driverDetailLines(box);
		case 'box':
			return boxDetailLines(box);
	}
}

function renderBoxEvidence(args: {
	box: ReceiptBoxRecord;
	receiptDisplayPath: string;
	witnessFilter: WitnessId | null;
	paint: Palette;
	out(line: string): void;
}): void {
	const { box, receiptDisplayPath, witnessFilter, paint, out } = args;
	const statusWord = box.status === 'passed' ? 'pass' : 'fail';
	const contested = box.summary?.contested === true;
	out(`case: ${box.name} — ${statusWord}${contested ? `, ${paint.yellow('contested')}` : ''}`);
	out(`file: ${paint.dim(box.file)}`);
	out(`receipt: ${paint.dim(receiptDisplayPath)}`);
	const witnesses = box.witnesses;
	if (witnesses === undefined) {
		out('');
		out('this receipt predates witness evidence; rerun gumbox to record testimony.');
		return;
	}
	const blotterLines = renderCrimeBlotter(witnesses, paint);
	if (blotterLines.length > 0) {
		out('');
		for (const line of blotterLines) {
			out(line);
		}
	}
	for (const id of WITNESS_IDS) {
		if (witnessFilter !== null && id !== witnessFilter) {
			continue;
		}
		const testimony = witnesses[id];
		out('');
		out(witnessHeadline(id, testimony, paint));
		if (testimony.against.length > 0) {
			for (const line of renderAgainstLines(testimony, paint)) {
				out(line);
			}
		}
		for (const line of witnessDetailLines(id, box)) {
			out(line);
		}
	}
}

/** A cwd-relative receipt path when possible, absolute otherwise. */
function receiptDisplayPath(receiptPath: string, cwd: string): string {
	const relative = path.relative(cwd, receiptPath);
	return relative.startsWith('..') ? receiptPath : relative;
}

async function runEvidenceCommand(
	command: EvidenceCommand,
	deps: CliDependencies,
): Promise<number> {
	const paint = deps.colors === true ? ANSI_PALETTE : PLAIN_PALETTE;
	const receiptPath = await resolveEvidenceReceiptPath(command.receipt, deps);
	if (receiptPath === null) {
		deps.stderr(
			command.receipt === null
				? `no receipt found under ${path.resolve(deps.cwd, '.gumbox', 'receipts')}. Run gumbox first.`
				: `no receipt found for '${command.receipt}'.`,
		);
		return EXIT_USAGE_OR_SETUP_ERROR;
	}
	let receipt: { boxes?: ReceiptBoxRecord[] };
	try {
		receipt = JSON.parse(await deps.fileSystem.readTextFile(receiptPath)) as {
			boxes?: ReceiptBoxRecord[];
		};
	} catch (error) {
		deps.stderr(`could not read receipt ${receiptPath}: ${errorMessage(error)}`);
		return EXIT_USAGE_OR_SETUP_ERROR;
	}
	let boxes = receipt.boxes ?? [];
	if (command.selector !== null) {
		const selector = command.selector;
		boxes = boxes.filter((box) => matchesReceiptBox(box, selector, deps.cwd));
	}
	if (boxes.length === 0) {
		deps.stderr(
			command.selector === null
				? `receipt ${receiptPath} records no boxes.`
				: `no boxes in ${receiptPath} matched selector '${command.selector}'.`,
		);
		return EXIT_USAGE_OR_SETUP_ERROR;
	}
	if (command.json) {
		deps.stdout(
			JSON.stringify({
				receiptPath,
				boxes: boxes.map((box) => ({
					name: box.name,
					file: box.file,
					status: box.status,
					contested: box.summary?.contested ?? false,
					witnesses: box.witnesses ?? null,
				})),
			}),
		);
		return EXIT_PASSED;
	}
	const displayPath = receiptDisplayPath(receiptPath, deps.cwd);
	boxes.forEach((box, index) => {
		if (index > 0) {
			deps.stdout('');
		}
		renderBoxEvidence({
			box,
			receiptDisplayPath: displayPath,
			witnessFilter: command.witness,
			paint,
			out: deps.stdout,
		});
	});
	return EXIT_PASSED;
}

/**
 * Runtime-agnostic CLI core. Parses arguments, runs the requested command,
 * and returns the process exit code (0 passed, 1 box failure, 2 usage or
 * setup error). All host access flows through the injected dependencies.
 */
export async function runCli(args: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseCliArguments(args);
	if ('error' in parsed) {
		deps.stderr(parsed.error);
		return EXIT_USAGE_OR_SETUP_ERROR;
	}
	if (parsed.command.kind === 'help') {
		deps.stdout(USAGE);
		return EXIT_PASSED;
	}
	try {
		if (parsed.command.kind === 'list') {
			return await runListCommand(parsed.command, deps);
		}
		if (parsed.command.kind === 'evidence') {
			return await runEvidenceCommand(parsed.command, deps);
		}
		return await runRunCommand(parsed.command, deps);
	} catch (error) {
		deps.stderr(`gumbox: ${errorMessage(error)}`);
		return EXIT_USAGE_OR_SETUP_ERROR;
	}
}
