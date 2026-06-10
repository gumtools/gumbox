import path from 'pathe';
import type { EvidenceStore } from './evidence.ts';
import { classifyEditOutcome } from './evidence.ts';
import type { GumboxFileSystem } from './filesystem.ts';
import { isPathAlreadyExistsError } from './filesystem.ts';
import type { AssertionRecord, EditReceipt, EnvironmentEditOutcome, Measurement } from './types.ts';

export type TimelineEvent = { seq: number; at: string; type: string } & Record<string, unknown>;

export type BoxReceiptMeta = {
	name: string;
	tags: readonly string[];
	modes: readonly string[];
	ui: boolean;
	file: string;
	exportName: string;
	status: 'passed' | 'failed';
};

function payloadTimelineType(payloadType: string): string {
	switch (payloadType) {
		case 'update':
			return 'vite hmr update sent';
		case 'full-reload':
			return 'vite full reload sent';
		case 'connected':
			return 'vite hot channel connected';
		case 'error':
			return 'vite error payload sent';
		case 'custom':
			return 'vite custom payload sent';
		default:
			return 'vite hot payload sent';
	}
}

/**
 * Collects everything one box run produced: timeline, edits, assertions,
 * captures, notes, measurements, and the Vite facts needed for the receipt.
 */
export class BoxRecorder {
	readonly timelineEvents: TimelineEvent[] = [];
	readonly assertions: AssertionRecord[] = [];
	readonly notes: string[] = [];
	readonly captures: Array<{ label: string; at: string }> = [];
	readonly measurements: Measurement[] = [];
	edits: EditReceipt[] = [];
	vite: {
		configFile: string | null;
		serverUrl: string | null;
		environments: string[];
		browserAlias: string | null;
		kinds: Record<string, EnvironmentEditOutcome['kind']>;
	} = { configFile: null, serverUrl: null, environments: [], browserAlias: null, kinds: {} };
	error: { message: string; stack?: string } | null = null;
	private startedAtMs = 0;
	private startedAt = '';
	private finishedAt = '';
	private durationMs = 0;

	constructor(private readonly store: EvidenceStore) {}

	timeline(type: string, detail: Record<string, unknown> = {}): void {
		this.timelineEvents.push({
			seq: this.store.nextSeq(),
			at: new Date().toISOString(),
			type,
			...detail,
		});
	}

	assertion(record: AssertionRecord): void {
		this.assertions.push(record);
		this.timeline(`assertion ${record.status}`, {
			assertion: record.name,
			environment: record.environment,
			editId: record.editId,
			...(record.message === null ? {} : { message: record.message }),
		});
	}

	note(text: string): void {
		this.notes.push(text);
		this.timeline('receipt note', { note: text });
	}

	capture(label: string): void {
		this.captures.push({ label, at: new Date().toISOString() });
		this.timeline('receipt capture', { label });
	}

	measurement(measurement: Measurement): void {
		this.measurements.push(measurement);
		this.timeline('performance metric recorded', {
			label: measurement.label,
			durationMs: measurement.durationMs,
		});
	}

	start(detail: Record<string, unknown>): void {
		this.startedAtMs = Date.now();
		this.startedAt = new Date(this.startedAtMs).toISOString();
		this.timeline('box started', detail);
	}

	finish(status: 'passed' | 'failed'): void {
		const finishedAtMs = Date.now();
		this.finishedAt = new Date(finishedAtMs).toISOString();
		this.durationMs = finishedAtMs - this.startedAtMs;
		this.timeline('box finished', { status });
	}

	private evidenceTimeline(): TimelineEvent[] {
		const entries: TimelineEvent[] = [];
		for (const event of this.store.events) {
			if (event.kind === 'file-edit') {
				// project.edit records its own 'file edited' timeline entry.
				continue;
			}
			if (event.kind === 'server-restart') {
				entries.push({ seq: event.seq, at: event.at, type: 'vite server restarted' });
				continue;
			}
			if (event.kind === 'hot-update-hook') {
				entries.push({
					seq: event.seq,
					at: event.at,
					type: 'hot update hook observed',
					environment: event.environment,
					file: event.file,
					changeType: event.changeType,
					modules: event.modules.map((mod) => mod.url),
				});
				continue;
			}
			entries.push({
				seq: event.seq,
				at: event.at,
				type: payloadTimelineType(event.payload.type),
				environment: event.environment,
				source: event.source,
				payload: event.payload,
			});
		}
		return entries;
	}

	buildBoxReceipt(meta: BoxReceiptMeta): Record<string, unknown> {
		const timeline = [...this.timelineEvents, ...this.evidenceTimeline()].sort(
			(a, b) => a.seq - b.seq,
		);
		const editOutcomes = this.edits.map((edit) => ({
			editId: edit.id,
			environments: Object.fromEntries(
				this.vite.environments.map((name) => [
					name,
					classifyEditOutcome({
						store: this.store,
						environmentName: name,
						kind: this.vite.kinds[name] ?? 'server',
						edit,
					}).outcome,
				]),
			),
		}));
		const passedAssertions = this.assertions.filter(
			(record) => record.status === 'passed',
		).length;
		const restorationFailed = this.edits.some((edit) => edit.restored === false);
		return {
			name: meta.name,
			tags: [...meta.tags],
			modes: [...meta.modes],
			ui: meta.ui,
			file: meta.file,
			exportName: meta.exportName,
			status: meta.status,
			error: this.error,
			vite: {
				configFile: this.vite.configFile,
				serverUrl: this.vite.serverUrl,
				environments: this.vite.environments,
				browserAlias: this.vite.browserAlias,
			},
			edits: this.edits.map((edit) => ({
				id: edit.id,
				file: edit.file,
				change: edit.change,
				before: edit.before,
				after: edit.after,
				at: edit.at,
				restored: edit.restored,
				...(edit.restoreError === undefined ? {} : { restoreError: edit.restoreError }),
			})),
			editOutcomes,
			assertions: this.assertions,
			captures: this.captures,
			notes: this.notes,
			measurements: this.measurements,
			timeline,
			startedAt: this.startedAt,
			finishedAt: this.finishedAt,
			durationMs: this.durationMs,
			summary: {
				status: meta.status,
				assertions: {
					passed: passedAssertions,
					failed: this.assertions.length - passedAssertions,
				},
				edits: this.edits.length,
				restorationFailed,
			},
		};
	}
}

export function runStamp(date = new Date()): string {
	return date.toISOString().replaceAll(':', '-');
}

export async function createRunDirectory(
	root: string,
	fileSystem: GumboxFileSystem,
): Promise<{ runId: string; runDir: string; receiptPath: string }> {
	const receiptsDir = path.join(root, '.gumbox', 'receipts');
	await fileSystem.mkdir(receiptsDir, { recursive: true });
	let runId = runStamp();
	let runDir = path.join(receiptsDir, runId);
	for (let attempt = 2; attempt < 100; attempt += 1) {
		try {
			await fileSystem.mkdir(runDir);
			return { runId, runDir, receiptPath: path.join(runDir, 'receipt.json') };
		} catch (error) {
			if (!isPathAlreadyExistsError(error)) {
				throw error;
			}
			runId = `${runStamp()}-${attempt}`;
			runDir = path.join(receiptsDir, runId);
		}
	}
	throw new Error(`could not create a unique receipt run directory under ${receiptsDir}.`);
}

export async function writeRunReceipt(
	root: string,
	runId: string,
	receiptPath: string,
	receipt: Record<string, unknown>,
	fileSystem: GumboxFileSystem,
): Promise<void> {
	await fileSystem.writeTextFile(receiptPath, `${JSON.stringify(receipt, null, '\t')}\n`);
	await fileSystem.writeTextFile(path.join(root, '.gumbox', 'receipts', 'latest'), `${runId}\n`);
}
