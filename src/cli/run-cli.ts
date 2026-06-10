import type { GumboxBrowser } from '../browser.ts';
import { discoverBoxes } from '../discovery.ts';
import type { GumboxFileSystem } from '../filesystem.ts';
import { runBoxes } from '../runner.ts';
import type { BoxRunResult, DiscoveredBox, InvalidBoxFile } from '../types.ts';
import { resolveSelector } from './selector.ts';

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
};

export const USAGE = `gumbox — Vite pipeline QA boxes that write receipts

Usage:
  gumbox [selector] [options]      run matching boxes headlessly
  gumbox run [selector] [options]  explicit form of gumbox [selector]
  gumbox preview [--run]           run preview-mode boxes against built output
  gumbox list [--json]             list discovered boxes without running them

Selectors match like Vitest: exact file path, glob, box name, file basename, or tag.

Options:
  --json               machine-readable output for CI and agents
  --receipt-dir <dir>  write receipts under <dir> (default .gumbox/receipts)
  --mode <mode>        only run boxes that declare <mode> (dev, build, ...)
  --preview            shorthand for --mode preview
  --headed             run browser sessions with a visible window
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
type HelpCommand = { kind: 'help' };
type CliCommand = RunCommand | ListCommand | HelpCommand;

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
		const valueFlag = ['--receipt-dir', '--mode'].find(
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
	const reportBoxResult = (box: BoxRunResult): void => {
		if (box.status === 'passed') {
			deps.stdout(`pass ${box.name} (${box.file})`);
			return;
		}
		deps.stdout(`fail ${box.name} (${box.file})`);
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
				invalidBoxFiles: relevantInvalid.map((file) => ({
					file: file.relativeFile,
					error: file.error,
				})),
			}),
		);
		return failedBoxes.length === 0 ? EXIT_PASSED : EXIT_BOX_FAILURE;
	}

	deps.stdout(
		`${result.boxes.length - failedBoxes.length} passed, ${failedBoxes.length} failed (${result.boxes.length} boxes)`,
	);
	deps.stdout(`receipt: ${result.receiptPath}`);
	return failedBoxes.length === 0 ? EXIT_PASSED : EXIT_BOX_FAILURE;
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
		return await runRunCommand(parsed.command, deps);
	} catch (error) {
		deps.stderr(`gumbox: ${errorMessage(error)}`);
		return EXIT_USAGE_OR_SETUP_ERROR;
	}
}
