import { describe, expect, test } from 'vitest';
import {
	computeBoxWitnesses,
	isContestedBox,
	SCENE_WITNESS_IDS,
	summarizeWitnessVerdicts,
	WITNESS_IDS,
	witnessForAssertion,
	witnessForTimelineType,
} from '../src/witness.ts';
import type { BoxEvidenceForWitnesses, WitnessId, WitnessTimelineEvent } from '../src/witness.ts';

/**
 * Every timeline type the runtime emits today, pinned to its witness. A new
 * timeline type must be added here (and to the attribution map) on purpose.
 */
const KNOWN_TIMELINE_WITNESSES: Record<string, WitnessId> = {
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

function timelineEvent(type: string, detail: Record<string, unknown> = {}): WitnessTimelineEvent {
	return {
		type,
		at: '2026-06-11T04:16:44.118Z',
		witness: witnessForTimelineType(type),
		...detail,
	};
}

function evidence(overrides: Partial<BoxEvidenceForWitnesses>): BoxEvidenceForWitnesses {
	return {
		timeline: [],
		editOutcomes: [],
		pagesVisited: 0,
		devServerStarted: false,
		builds: 0,
		previews: 0,
		...overrides,
	};
}

/** A minimal "everything engaged and healthy" run for verdict tests. */
function healthyVisitEvidence(): BoxEvidenceForWitnesses {
	return evidence({
		timeline: [
			timelineEvent('box started'),
			timelineEvent('server started'),
			timelineEvent('browser session started'),
			timelineEvent('route visited'),
			timelineEvent('dom snapshot captured'),
			timelineEvent('assertion passed'),
			timelineEvent('box finished'),
		],
		pagesVisited: 1,
		devServerStarted: true,
	});
}

describe('witness attribution', () => {
	test('pins every known timeline type to its witness', () => {
		for (const [type, witness] of Object.entries(KNOWN_TIMELINE_WITNESSES)) {
			expect(witnessForTimelineType(type), `timeline type '${type}'`).toBe(witness);
		}
	});

	test('unknown future timeline types default to the box witness', () => {
		expect(witnessForTimelineType('telepathy observed')).toBe('box');
	});

	test('witness ids are stable and ordered pipeline, client, driver, box', () => {
		expect(WITNESS_IDS).toEqual(['pipeline', 'client', 'driver', 'box']);
		expect(SCENE_WITNESS_IDS).toEqual(['pipeline', 'client', 'driver']);
	});

	test('maps assertions to the witness whose testimony they examined', () => {
		expect(witnessForAssertion('edit')).toBe('pipeline');
		expect(witnessForAssertion('page.text')).toBe('client');
		expect(witnessForAssertion('page.bodyText')).toBe('client');
		expect(witnessForAssertion('page.attribute')).toBe('client');
		expect(witnessForAssertion('page.exists')).toBe('client');
		expect(witnessForAssertion('page.visible')).toBe('client');
		expect(witnessForAssertion('page.computedStyle')).toBe('client');
		expect(witnessForAssertion('page.outcome')).toBe('client');
		expect(witnessForAssertion('html.contains')).toBe('pipeline');
		expect(witnessForAssertion('response.matches')).toBe('pipeline');
		expect(witnessForAssertion('build.environment')).toBe('pipeline');
		expect(witnessForAssertion('build.artifact')).toBe('pipeline');
		expect(witnessForAssertion('build.forbids')).toBe('pipeline');
		expect(witnessForAssertion('artifact.exists')).toBe('pipeline');
		expect(witnessForAssertion('artifact.text')).toBe('pipeline');
		expect(witnessForAssertion('artifact.json')).toBe('pipeline');
	});
});

describe('witness verdicts', () => {
	test('every engaged witness with statements and nothing against corroborates', () => {
		const witnesses = computeBoxWitnesses(healthyVisitEvidence());
		for (const id of WITNESS_IDS) {
			expect(witnesses[id].verdict, id).toBe('corroborates');
			expect(witnesses[id].statements, id).toBeGreaterThan(0);
			expect(witnesses[id].against, id).toEqual([]);
		}
	});

	test('client and driver are not-called when no page was visited', () => {
		const witnesses = computeBoxWitnesses(
			evidence({
				timeline: [timelineEvent('box started'), timelineEvent('server started')],
				devServerStarted: true,
			}),
		);
		expect(witnesses.client.verdict).toBe('not-called');
		expect(witnesses.driver.verdict).toBe('not-called');
		expect(witnesses.pipeline.verdict).toBe('corroborates');
	});

	test('pipeline is not-called when no dev server, build, or preview ran', () => {
		const witnesses = computeBoxWitnesses(
			evidence({ timeline: [timelineEvent('box started')] }),
		);
		expect(witnesses.pipeline.verdict).toBe('not-called');
	});

	test('a build engages the pipeline witness without a dev server', () => {
		const witnesses = computeBoxWitnesses(
			evidence({
				timeline: [timelineEvent('box started'), timelineEvent('build started')],
				builds: 1,
			}),
		);
		expect(witnesses.pipeline.verdict).toBe('corroborates');
	});

	test('an engaged witness with zero statements is silent', () => {
		const witnesses = computeBoxWitnesses(
			evidence({ timeline: [timelineEvent('box started')], previews: 1 }),
		);
		expect(witnesses.pipeline.verdict).toBe('silent');
		expect(witnesses.pipeline.statements).toBe(0);
	});

	test('statements count the witness-attributed timeline entries', () => {
		const witnesses = computeBoxWitnesses(healthyVisitEvidence());
		expect(witnesses.pipeline.statements).toBe(1);
		expect(witnesses.client.statements).toBe(1);
		expect(witnesses.driver.statements).toBe(2);
		expect(witnesses.box.statements).toBe(3);
	});

	test('a console error makes the client witness contradict', () => {
		const base = healthyVisitEvidence();
		base.timeline.push(
			timelineEvent('console error captured', {
				page: 'page-1',
				text: 'intentional console noise',
			}),
		);
		const witnesses = computeBoxWitnesses(base);
		expect(witnesses.client.verdict).toBe('contradicts');
		expect(witnesses.client.against).toEqual([
			{
				kind: 'console-error',
				page: 'page-1',
				at: '2026-06-11T04:16:44.118Z',
				text: 'intentional console noise',
			},
		]);
	});

	test('an uncaught page error becomes a page-error statement against the run', () => {
		const base = healthyVisitEvidence();
		base.timeline.push(
			timelineEvent('console error captured', {
				page: 'page-1',
				text: 'Uncaught Error: boom from the fixture',
				source: 'pageerror',
			}),
		);
		const witnesses = computeBoxWitnesses(base);
		expect(witnesses.client.verdict).toBe('contradicts');
		expect(witnesses.client.against[0]).toMatchObject({
			kind: 'page-error',
			page: 'page-1',
			text: 'Uncaught Error: boom from the fixture',
		});
	});

	test('a failed request makes the driver witness contradict', () => {
		const base = healthyVisitEvidence();
		base.timeline.push(
			timelineEvent('network failure captured', {
				page: 'page-1',
				url: 'http://127.0.0.1:5173/missing.js',
				method: 'GET',
				reason: 'net::ERR_ABORTED',
			}),
		);
		const witnesses = computeBoxWitnesses(base);
		expect(witnesses.driver.verdict).toBe('contradicts');
		expect(witnesses.driver.against[0]).toMatchObject({
			kind: 'request-failed',
			page: 'page-1',
			text: 'GET http://127.0.0.1:5173/missing.js — net::ERR_ABORTED',
		});
	});

	test('a vite error payload makes the pipeline witness contradict', () => {
		const base = healthyVisitEvidence();
		base.timeline.push(
			timelineEvent('vite error payload sent', {
				environment: 'client',
				payload: { type: 'error', err: { message: 'Transform failed' } },
			}),
		);
		const witnesses = computeBoxWitnesses(base);
		expect(witnesses.pipeline.verdict).toBe('contradicts');
		expect(witnesses.pipeline.against[0]).toMatchObject({
			kind: 'vite-error',
			text: 'Transform failed',
		});
	});

	test('an edit outcome carrying an error makes the pipeline witness contradict', () => {
		const base = healthyVisitEvidence();
		base.editOutcomes = [
			{
				editId: 'edit-1',
				at: '2026-06-11T04:16:45.000Z',
				environments: {
					client: { error: { message: 'broken import' } },
					ssr: { error: null },
				},
			},
		];
		const witnesses = computeBoxWitnesses(base);
		expect(witnesses.pipeline.verdict).toBe('contradicts');
		expect(witnesses.pipeline.against[0]).toMatchObject({
			kind: 'edit-error',
			at: '2026-06-11T04:16:45.000Z',
		});
		expect(witnesses.pipeline.against[0]!.text).toContain('client');
		expect(witnesses.pipeline.against[0]!.text).toContain('edit-1');
	});

	test('failed assertions and a failed box land on the box witness, not the scene', () => {
		const base = healthyVisitEvidence();
		base.timeline.push(
			timelineEvent('assertion failed', {
				assertion: 'page.text',
				message: 'expected "after", got "before"',
			}),
			timelineEvent('box failed', { message: 'assertion failed' }),
		);
		const witnesses = computeBoxWitnesses(base);
		expect(witnesses.box.verdict).toBe('contradicts');
		expect(witnesses.box.against.map((statement) => statement.kind)).toEqual([
			'assertion-failed',
			'box-error',
		]);
		// The page told the truth — the box's claim failed.
		expect(witnesses.client.verdict).toBe('corroborates');
		expect(witnesses.driver.verdict).toBe('corroborates');
	});

	test('a failed restoration makes the box witness contradict', () => {
		const base = healthyVisitEvidence();
		base.timeline.push(
			timelineEvent('file restore failed', {
				file: 'src/message.ts',
				error: 'permission denied',
			}),
		);
		const witnesses = computeBoxWitnesses(base);
		expect(witnesses.box.verdict).toBe('contradicts');
		expect(witnesses.box.against[0]).toMatchObject({ kind: 'restore-failed' });
		expect(witnesses.box.against[0]!.text).toContain('src/message.ts');
	});
});

describe('contested boxes', () => {
	test('a passed box with a contradicting witness is contested', () => {
		const base = healthyVisitEvidence();
		base.timeline.push(
			timelineEvent('console error captured', { page: 'page-1', text: 'noise' }),
		);
		const witnesses = computeBoxWitnesses(base);
		expect(isContestedBox('passed', witnesses)).toBe(true);
	});

	test('a failed box is never contested', () => {
		const base = healthyVisitEvidence();
		base.timeline.push(
			timelineEvent('console error captured', { page: 'page-1', text: 'noise' }),
			timelineEvent('box failed', { message: 'down in flames' }),
		);
		const witnesses = computeBoxWitnesses(base);
		expect(isContestedBox('failed', witnesses)).toBe(false);
	});

	test('a passed box with every witness corroborating is not contested', () => {
		const witnesses = computeBoxWitnesses(healthyVisitEvidence());
		expect(isContestedBox('passed', witnesses)).toBe(false);
	});

	test('summarizeWitnessVerdicts flattens testimony to the per-box summary shape', () => {
		const witnesses = computeBoxWitnesses(healthyVisitEvidence());
		expect(summarizeWitnessVerdicts(witnesses)).toEqual({
			pipeline: 'corroborates',
			client: 'corroborates',
			driver: 'corroborates',
			box: 'corroborates',
		});
	});
});
