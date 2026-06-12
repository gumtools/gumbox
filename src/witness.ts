/**
 * The witness evidence model: every part of the pipeline that can observe a
 * box run is a witness, and the receipt records who saw what, who backs the
 * result, and who speaks against it. This module is the single owner of the
 * attribution maps (timeline type → witness, assertion → witness) and the
 * verdict computation. Pure and runtime-agnostic: it only reads evidence the
 * receipt already records.
 */

/**
 * Witness ids form an open set — future witnesses register a new id without
 * schema changes. The four ids below are the ones the runtime attributes
 * evidence to today.
 */
export type WitnessId = 'pipeline' | 'client' | 'driver' | 'box';

/** Stable presentation order: pipeline, client, driver, box. */
export const WITNESS_IDS: readonly WitnessId[] = ['pipeline', 'client', 'driver', 'box'];

/**
 * The scene witnesses: everyone except the box itself. The box is the
 * investigator — its claims can fail without any scene witness contradicting.
 */
export const SCENE_WITNESS_IDS: readonly WitnessId[] = ['pipeline', 'client', 'driver'];

export type WitnessVerdict = 'corroborates' | 'contradicts' | 'silent' | 'not-called';

/** Stable machine-readable kinds for statements against the run. */
export type WitnessStatementKind =
	| 'console-error'
	| 'page-error'
	| 'request-failed'
	| 'vite-error'
	| 'edit-error'
	| 'restore-failed'
	| 'assertion-failed'
	| 'box-error';

/** One piece of testimony that speaks against the run. */
export type WitnessStatement = {
	kind: WitnessStatementKind;
	page?: string;
	at: string;
	text: string;
};

/** One witness's testimony for one box run. */
export type WitnessTestimony = {
	verdict: WitnessVerdict;
	/** How many timeline statements this witness gave for the box. */
	statements: number;
	/** Every statement that speaks against the run. */
	against: WitnessStatement[];
};

export type BoxWitnesses = Record<WitnessId, WitnessTestimony>;

/** A timeline event after witness attribution. */
export type WitnessTimelineEvent = {
	type: string;
	at: string;
	witness: WitnessId;
} & Record<string, unknown>;

/** One edit outcome row as the witness model needs it: did any environment error? */
export type WitnessedEditOutcome = {
	editId: string;
	/** Timestamp of the edit that produced this outcome. */
	at?: string;
	environments: Record<string, { error?: unknown } | undefined>;
};

/**
 * The slice of one box's evidence the verdict computation reads. The
 * engagement facts (pages visited, dev server, builds, previews) decide
 * whether a witness was called at all.
 */
export type BoxEvidenceForWitnesses = {
	timeline: WitnessTimelineEvent[];
	editOutcomes: WitnessedEditOutcome[];
	pagesVisited: number;
	devServerStarted: boolean;
	builds: number;
	previews: number;
};

/**
 * The static attribution map. The witness is whose facts they are, not the
 * channel they reached us through: client facts arrive over the driver's CDP
 * relay today, yet they stay client testimony.
 */
const TIMELINE_WITNESSES: Record<string, WitnessId> = {
	// pipeline — the Vite server side
	'server started': 'pipeline',
	'vite server listening': 'pipeline',
	'vite server restarted': 'pipeline',
	'environments resolved': 'pipeline',
	'vite hot channel connected': 'pipeline',
	'hot channel websocket connected': 'pipeline',
	'hot update hook observed': 'pipeline',
	'vite hmr update sent': 'pipeline',
	'vite full reload sent': 'pipeline',
	'vite error payload sent': 'pipeline',
	'vite custom payload sent': 'pipeline',
	'vite hot payload sent': 'pipeline',
	'environment requested': 'pipeline',
	'response received': 'pipeline',
	'environment imported module': 'pipeline',
	'build started': 'pipeline',
	'build environment completed': 'pipeline',
	'artifact scanned': 'pipeline',
	'preview server started': 'pipeline',
	'preview server closed': 'pipeline',
	'server closed': 'pipeline',
	// client — facts that originate inside the page
	'console error captured': 'client',
	'page event tracking started': 'client',
	'dom snapshot captured': 'client',
	// driver — facts only observable from outside the page (CDP)
	'browser session started': 'driver',
	'browser session closed': 'driver',
	'route requested': 'driver',
	'route visited': 'driver',
	'page navigated': 'driver',
	'page reloaded': 'driver',
	'page click': 'driver',
	'network failure captured': 'driver',
	'screenshot captured': 'driver',
	'screenshot failed': 'driver',
	// box — the investigator's own actions and claims
	'box started': 'box',
	'box finished': 'box',
	'box failed': 'box',
	'file edited': 'box',
	'file created': 'box',
	'file removed': 'box',
	'file copied': 'box',
	'vite config edited': 'box',
	'env file edited': 'box',
	'file restored': 'box',
	'file restore failed': 'box',
	'receipt capture': 'box',
	'receipt note': 'box',
	'assertion passed': 'box',
	'assertion failed': 'box',
	'performance metric recorded': 'box',
};

/** Unknown future timeline types default to the box witness until mapped. */
export function witnessForTimelineType(type: string): WitnessId {
	return TIMELINE_WITNESSES[type] ?? 'box';
}

/**
 * The witness whose testimony an assertion examined. `expect.page.*` reads
 * client testimony; `expect.edit`, artifact, build, and response assertions
 * read pipeline testimony.
 */
export function witnessForAssertion(assertionName: string): WitnessId {
	if (assertionName.startsWith('page.')) {
		return 'client';
	}
	return 'pipeline';
}

function asText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function asPage(value: unknown): { page?: string } {
	return typeof value === 'string' ? { page: value } : {};
}

/**
 * The client witness contradicts on objectively bad facts the page reported:
 * an uncaught page error or a console message with level error. Both reach
 * the timeline as 'console error captured'; the pageerror source marks the
 * uncaught ones.
 */
function clientStatementAgainst(event: WitnessTimelineEvent): WitnessStatement | null {
	if (event.type !== 'console error captured') {
		return null;
	}
	return {
		kind: event.source === 'pageerror' ? 'page-error' : 'console-error',
		...asPage(event.page),
		at: event.at,
		text: asText(event.text),
	};
}

function driverStatementAgainst(event: WitnessTimelineEvent): WitnessStatement | null {
	if (event.type !== 'network failure captured') {
		return null;
	}
	const reason = asText(event.reason) || 'unknown reason';
	return {
		kind: 'request-failed',
		...asPage(event.page),
		at: event.at,
		text: `${asText(event.method)} ${asText(event.url)} — ${reason}`,
	};
}

function viteErrorMessage(event: WitnessTimelineEvent): string {
	const payload = event.payload;
	if (typeof payload === 'object' && payload !== null) {
		const err = (payload as Record<string, unknown>).err;
		if (typeof err === 'object' && err !== null) {
			const message = (err as Record<string, unknown>).message;
			if (typeof message === 'string') {
				return message;
			}
		}
	}
	return 'vite error payload sent';
}

function pipelineStatementAgainst(event: WitnessTimelineEvent): WitnessStatement | null {
	if (event.type !== 'vite error payload sent') {
		return null;
	}
	return { kind: 'vite-error', at: event.at, text: viteErrorMessage(event) };
}

function editErrorStatements(editOutcomes: WitnessedEditOutcome[]): WitnessStatement[] {
	const statements: WitnessStatement[] = [];
	for (const outcome of editOutcomes) {
		for (const [environmentName, reaction] of Object.entries(outcome.environments)) {
			if (reaction?.error === undefined || reaction.error === null) {
				continue;
			}
			const message =
				typeof reaction.error === 'object' &&
				typeof (reaction.error as Record<string, unknown>).message === 'string'
					? `: ${(reaction.error as Record<string, unknown>).message as string}`
					: '';
			statements.push({
				kind: 'edit-error',
				at: outcome.at ?? '',
				text: `edit ${outcome.editId}: environment '${environmentName}' reported an error${message}`,
			});
		}
	}
	return statements;
}

function boxStatementAgainst(event: WitnessTimelineEvent): WitnessStatement | null {
	if (event.type === 'assertion failed') {
		const text = asText(event.message) || `assertion '${asText(event.assertion)}' failed`;
		return { kind: 'assertion-failed', at: event.at, text };
	}
	if (event.type === 'box failed') {
		return { kind: 'box-error', at: event.at, text: asText(event.message) };
	}
	if (event.type === 'file restore failed') {
		const file = asText(event.file);
		const error = asText(event.error);
		return { kind: 'restore-failed', at: event.at, text: `${file}: ${error}` };
	}
	return null;
}

function statementAgainst(event: WitnessTimelineEvent): WitnessStatement | null {
	switch (event.witness) {
		case 'client':
			return clientStatementAgainst(event);
		case 'driver':
			return driverStatementAgainst(event);
		case 'pipeline':
			return pipelineStatementAgainst(event);
		case 'box':
			return boxStatementAgainst(event);
	}
}

function verdictFor(
	engaged: boolean,
	statements: number,
	against: WitnessStatement[],
): WitnessVerdict {
	if (!engaged) {
		return 'not-called';
	}
	if (against.length > 0) {
		return 'contradicts';
	}
	if (statements === 0) {
		return 'silent';
	}
	return 'corroborates';
}

/** Uncaught page errors read before console noise in the testimony list. */
function sortClientStatements(against: WitnessStatement[]): WitnessStatement[] {
	const pageErrors = against.filter((statement) => statement.kind === 'page-error');
	const rest = against.filter((statement) => statement.kind !== 'page-error');
	return [...pageErrors, ...rest];
}

/**
 * Computes every witness's testimony for one box run. Statements count the
 * witness-attributed timeline entries; `against` lists every statement that
 * speaks against the run, per the contradiction rules in the spec.
 */
export function computeBoxWitnesses(evidence: BoxEvidenceForWitnesses): BoxWitnesses {
	const statementCounts: Record<WitnessId, number> = {
		pipeline: 0,
		client: 0,
		driver: 0,
		box: 0,
	};
	const against: Record<WitnessId, WitnessStatement[]> = {
		pipeline: [],
		client: [],
		driver: [],
		box: [],
	};
	for (const event of evidence.timeline) {
		statementCounts[event.witness] += 1;
		const statement = statementAgainst(event);
		if (statement !== null) {
			against[event.witness].push(statement);
		}
	}
	against.pipeline.push(...editErrorStatements(evidence.editOutcomes));
	against.client = sortClientStatements(against.client);

	const pipelineEngaged =
		evidence.devServerStarted || evidence.builds > 0 || evidence.previews > 0;
	const pageEngaged = evidence.pagesVisited > 0;
	const engagement: Record<WitnessId, boolean> = {
		pipeline: pipelineEngaged,
		client: pageEngaged,
		driver: pageEngaged,
		// The investigator is always on the stand for its own run.
		box: true,
	};

	const witnesses = {} as BoxWitnesses;
	for (const id of WITNESS_IDS) {
		witnesses[id] = {
			verdict: verdictFor(engagement[id], statementCounts[id], against[id]),
			statements: statementCounts[id],
			against: against[id],
		};
	}
	return witnesses;
}

/**
 * A box is contested when it passed but a witness still spoke against the
 * run — the headline case being a console error captured while every
 * assertion passed. Contested never changes box status; it is a
 * presentation-priority flag over the semantic verdicts.
 */
export function isContestedBox(status: 'passed' | 'failed', witnesses: BoxWitnesses): boolean {
	if (status !== 'passed') {
		return false;
	}
	return WITNESS_IDS.some((id) => witnesses[id].verdict === 'contradicts');
}

/** Flattens full testimony to the per-box summary shape: id → verdict. */
export function summarizeWitnessVerdicts(
	witnesses: BoxWitnesses,
): Record<WitnessId, WitnessVerdict> {
	const summary = {} as Record<WitnessId, WitnessVerdict>;
	for (const id of WITNESS_IDS) {
		summary[id] = witnesses[id].verdict;
	}
	return summary;
}
