import { getPageDriver, syncTrackedEvents, trackedEventCountExpression } from './browser.ts';
import type { PageHandle } from './browser.ts';
import type { EvidenceStore, HotUpdateHookEvidence } from './evidence.ts';
import { classifyEditOutcome, editTouchesFile, GumboxTimeoutError } from './evidence.ts';
import type { GumboxFileSystem } from './filesystem.ts';
import { resolveWithinRoot } from './project.ts';
import type {
	ArtifactHandle,
	ArtifactJsonPredicate,
	AssertionRecord,
	BuildHandle,
	EditReceipt,
	EnvironmentEditOutcome,
	EnvironmentExpectApi,
	EnvironmentResponse,
	ExpectApi,
	ExpectWaitOptions,
	PageExpectApi,
	ResponseExpectation,
} from './types.ts';

export class GumboxAssertionError extends Error {}

export function createExpectApi(options: {
	store: EvidenceStore;
	receiptPath: string;
	defaultTimeoutMs: number;
	root: string;
	fileSystem: GumboxFileSystem;
	getBrowserName(): string;
	getEnvironmentKind(name: string): EnvironmentEditOutcome['kind'];
	onAssertion(record: AssertionRecord): void;
}): ExpectApi {
	const {
		store,
		receiptPath,
		defaultTimeoutMs,
		root,
		fileSystem,
		getBrowserName,
		getEnvironmentKind,
		onAssertion,
	} = options;

	const passAssertion = (
		name: string,
		environment: string | null,
		change: EditReceipt | null,
	): void => {
		onAssertion({
			name,
			environment,
			editId: change?.id ?? null,
			status: 'passed',
			message: null,
		});
	};

	const failAssertion = (
		name: string,
		environment: string | null,
		change: EditReceipt | null,
		message: string,
	): never => {
		onAssertion({
			name,
			environment,
			editId: change?.id ?? null,
			status: 'failed',
			message,
		});
		throw new GumboxAssertionError(`${message}\nReceipt: ${receiptPath}`);
	};

	const errorMessage = (error: unknown): string =>
		error instanceof Error ? error.message : String(error);

	const waitForHook = (
		environment: string,
		change: EditReceipt,
		timeoutMs: number,
	): Promise<HotUpdateHookEvidence> => {
		return store.waitUntil(
			`environment '${environment}' to observe the file change for ${change.file}`,
			() =>
				store.events.find(
					(event): event is HotUpdateHookEvidence =>
						event.kind === 'hot-update-hook' &&
						event.environment === environment &&
						editTouchesFile(change, event.file) &&
						event.seq > change.seq,
				),
			timeoutMs,
		);
	};

	const classify = (
		environment: string,
		change: EditReceipt,
	): ReturnType<typeof classifyEditOutcome> => {
		return classifyEditOutcome({
			store,
			environmentName: environment,
			kind: getEnvironmentKind(environment),
			edit: change,
		});
	};

	const resolveOutcome = async (
		environment: string,
		change: EditReceipt,
		timeoutMs: number,
	): Promise<EnvironmentEditOutcome> => {
		try {
			return await store.waitUntil(
				`environment '${environment}' to settle its Vite reaction to the edit of ${change.file}`,
				() => {
					const { settled, outcome } = classify(environment, change);
					return settled ? outcome : undefined;
				},
				timeoutMs,
			);
		} catch (error) {
			const { hookSeen, outcome } = classify(environment, change);
			if (error instanceof GumboxTimeoutError && hookSeen) {
				// The environment observed the change but sent no terminal
				// payload ("no update happened"); report the partial outcome.
				return outcome;
			}
			throw error;
		}
	};

	const createEnvironmentExpect = (name: string): EnvironmentExpectApi => {
		return {
			hotUpdate: async (change, waitOptions?: ExpectWaitOptions): Promise<void> => {
				const timeoutMs = waitOptions?.timeoutMs ?? defaultTimeoutMs;
				try {
					await store.waitUntil(
						`environment '${name}' to receive a Vite HMR update payload for ${change.file}`,
						() =>
							store.events.find(
								(event) =>
									event.kind === 'hot-payload' &&
									event.environment === name &&
									event.payload.type === 'update' &&
									event.seq > change.seq &&
									(event.files.length === 0 ||
										event.files.some((file) => editTouchesFile(change, file))),
							),
						timeoutMs,
					);
				} catch {
					const { outcome } = classify(name, change);
					const observed = outcome.fullReload
						? ' Vite sent a full reload instead.'
						: outcome.error !== null
							? ' Vite sent an error payload instead.'
							: '';
					failAssertion(
						'hotUpdate',
						name,
						change,
						`expected environment '${name}' to hot-update after editing ${change.file}, but no HMR update payload was observed within ${timeoutMs}ms.${observed}`,
					);
				}
				passAssertion('hotUpdate', name, change);
			},
			customPayload: async (
				change,
				eventName,
				waitOptions?: ExpectWaitOptions,
			): Promise<void> => {
				const timeoutMs = waitOptions?.timeoutMs ?? defaultTimeoutMs;
				try {
					await store.waitUntil(
						`environment '${name}' to broadcast custom hot payload '${eventName}' for ${change.file}`,
						() =>
							store.events.find(
								(event) =>
									event.kind === 'hot-payload' &&
									event.environment === name &&
									event.source === 'channel' &&
									event.payload.type === 'custom' &&
									event.payload.event === eventName &&
									event.seq > change.seq,
							),
						timeoutMs,
					);
				} catch {
					const seenEvents = [
						...new Set(
							store.events
								.filter(
									(event) =>
										event.kind === 'hot-payload' &&
										event.environment === name &&
										event.payload.type === 'custom' &&
										event.seq > change.seq,
								)
								.map((event) =>
									event.kind === 'hot-payload' ? String(event.payload.event) : '',
								),
						),
					];
					const seen =
						seenEvents.length === 0
							? ''
							: ` Custom payloads observed instead: ${seenEvents.join(', ')}.`;
					failAssertion(
						'customPayload',
						name,
						change,
						`expected environment '${name}' to broadcast custom hot payload '${eventName}' after editing ${change.file}, but none arrived within ${timeoutMs}ms.${seen}`,
					);
				}
				passAssertion('customPayload', name, change);
			},
			noFullReload: async (change, waitOptions?: ExpectWaitOptions): Promise<void> => {
				const timeoutMs = waitOptions?.timeoutMs ?? defaultTimeoutMs;
				let outcome: EnvironmentEditOutcome;
				try {
					outcome = await resolveOutcome(name, change, timeoutMs);
				} catch (error) {
					failAssertion(
						'noFullReload',
						name,
						change,
						`could not verify noFullReload for ${change.file} in environment '${name}': ${errorMessage(error)}`,
					);
					return;
				}
				if (outcome.fullReload) {
					failAssertion(
						'noFullReload',
						name,
						change,
						`expected environment '${name}' to avoid a full reload after editing ${change.file}, but Vite sent a full-reload payload.`,
					);
				}
				passAssertion('noFullReload', name, change);
			},
			invalidated: async (
				change,
				modulePath?: string,
				waitOptions?: ExpectWaitOptions,
			): Promise<void> => {
				const timeoutMs = waitOptions?.timeoutMs ?? defaultTimeoutMs;
				let hook: HotUpdateHookEvidence;
				try {
					hook = await waitForHook(name, change, timeoutMs);
				} catch (error) {
					failAssertion('invalidated', name, change, errorMessage(error));
					return;
				}
				if (hook.modules.length === 0) {
					failAssertion(
						'invalidated',
						name,
						change,
						`expected environment '${name}' to invalidate modules after editing ${change.file}, but its module graph had no modules for that file.`,
					);
				}
				if (modulePath !== undefined) {
					const matched = hook.modules.some(
						(mod) =>
							mod.url === modulePath ||
							mod.id === modulePath ||
							(mod.file !== null &&
								(mod.file === modulePath || mod.file.endsWith(modulePath))),
					);
					if (!matched) {
						const seen = hook.modules.map((mod) => mod.url).join(', ');
						failAssertion(
							'invalidated',
							name,
							change,
							`expected environment '${name}' to invalidate ${modulePath} after editing ${change.file}, but it invalidated: ${seen}.`,
						);
					}
				}
				passAssertion('invalidated', name, change);
			},
			notInvalidated: async (change, waitOptions?: ExpectWaitOptions): Promise<void> => {
				const timeoutMs = waitOptions?.timeoutMs ?? defaultTimeoutMs;
				let hook: HotUpdateHookEvidence;
				try {
					hook = await waitForHook(name, change, timeoutMs);
				} catch (error) {
					failAssertion('notInvalidated', name, change, errorMessage(error));
					return;
				}
				if (hook.modules.length > 0) {
					const seen = hook.modules.map((mod) => mod.url).join(', ');
					failAssertion(
						'notInvalidated',
						name,
						change,
						`expected environment '${name}' to ignore the edit of ${change.file}, but it invalidated: ${seen}.`,
					);
				}
				passAssertion('notInvalidated', name, change);
			},
			satisfies: async (
				change,
				predicate,
				waitOptions?: ExpectWaitOptions,
			): Promise<void> => {
				const timeoutMs = waitOptions?.timeoutMs ?? defaultTimeoutMs;
				let outcome: EnvironmentEditOutcome;
				try {
					outcome = await resolveOutcome(name, change, timeoutMs);
				} catch (error) {
					failAssertion(
						'satisfies',
						name,
						change,
						`could not gather edit evidence for ${change.file} in environment '${name}': ${errorMessage(error)}`,
					);
					return;
				}
				const accepted = await predicate(outcome);
				if (!accepted) {
					failAssertion(
						'satisfies',
						name,
						change,
						`custom evidence predicate rejected the outcome for environment '${name}' after editing ${change.file}: ${JSON.stringify(
							{
								update: outcome.update,
								fullReload: outcome.fullReload,
								restart: outcome.restart,
								invalidated: outcome.invalidated.map((mod) => mod.url),
							},
						)}.`,
					);
				}
				passAssertion('satisfies', name, change);
			},
		};
	};

	const selectorExpression = (selector: string): string =>
		`document.querySelector(${JSON.stringify(selector)})`;

	const styleValueExpression = (selector: string, property: string): string =>
		// getPropertyValue covers kebab-case names; indexed access covers camelCase.
		`(getComputedStyle(${selectorExpression(selector)}).getPropertyValue(${JSON.stringify(property)}) || getComputedStyle(${selectorExpression(selector)})[${JSON.stringify(property)}])`;

	const readPageState = async (page: PageHandle, expression: string): Promise<unknown> => {
		const driver = getPageDriver(page, 'expect.page');
		try {
			return await driver.page.evaluate(expression);
		} catch {
			return undefined;
		}
	};

	const expectPageCondition = async (args: {
		assertion: string;
		page: PageHandle;
		condition: string;
		timeoutMs: number;
		describeFailure(): Promise<string>;
	}): Promise<void> => {
		const { assertion, page, condition, timeoutMs, describeFailure } = args;
		const driver = getPageDriver(page, `expect.${assertion}`);
		try {
			await driver.page.waitForExpression(condition, timeoutMs);
		} catch {
			failAssertion(
				assertion,
				driver.record.environment,
				null,
				`${await describeFailure()} (page ${page.url}, waited ${timeoutMs}ms)`,
			);
		}
		passAssertion(assertion, driver.record.environment, null);
	};

	const pageNamespace: PageExpectApi = {
		text: async (page, selector, expected, waitOptions?: ExpectWaitOptions): Promise<void> => {
			const element = selectorExpression(selector);
			await expectPageCondition({
				assertion: 'page.text',
				page,
				condition: `(() => { const el = ${element}; return el !== null && (el.textContent ?? '').trim() === ${JSON.stringify(expected)}; })()`,
				timeoutMs: waitOptions?.timeoutMs ?? defaultTimeoutMs,
				describeFailure: async () => {
					const actual = await readPageState(
						page,
						`(() => { const el = ${element}; return el === null ? null : (el.textContent ?? '').trim(); })()`,
					);
					if (actual === null) {
						return `expected '${selector}' to have text ${JSON.stringify(expected)}, but no element matched the selector`;
					}
					return `expected '${selector}' to have text ${JSON.stringify(expected)}, but it was ${JSON.stringify(actual)}`;
				},
			});
		},
		containsText: async (page, fragment, waitOptions?: ExpectWaitOptions): Promise<void> => {
			await expectPageCondition({
				assertion: 'page.containsText',
				page,
				condition: `(document.body?.textContent ?? '').includes(${JSON.stringify(fragment)})`,
				timeoutMs: waitOptions?.timeoutMs ?? defaultTimeoutMs,
				describeFailure: async () =>
					`expected the page body text to contain ${JSON.stringify(fragment)}, but it never appeared`,
			});
		},
		notContainsText: async (page, fragment, waitOptions?: ExpectWaitOptions): Promise<void> => {
			await expectPageCondition({
				assertion: 'page.notContainsText',
				page,
				condition: `!(document.body?.textContent ?? '').includes(${JSON.stringify(fragment)})`,
				timeoutMs: waitOptions?.timeoutMs ?? defaultTimeoutMs,
				describeFailure: async () =>
					`expected the page body text to stop containing ${JSON.stringify(fragment)}, but it was still present`,
			});
		},
		attribute: async (
			page,
			selector,
			attributeName,
			expected?: string,
			waitOptions?: ExpectWaitOptions,
		): Promise<void> => {
			const element = selectorExpression(selector);
			const attributeValue = `${element}?.getAttribute(${JSON.stringify(attributeName)})`;
			const condition =
				expected === undefined
					? `(${attributeValue}) !== null && (${attributeValue}) !== undefined`
					: `(${attributeValue}) === ${JSON.stringify(expected)}`;
			await expectPageCondition({
				assertion: 'page.attribute',
				page,
				condition,
				timeoutMs: waitOptions?.timeoutMs ?? defaultTimeoutMs,
				describeFailure: async () => {
					const actual = await readPageState(
						page,
						`(() => { const el = ${element}; return el === null ? { missing: true } : { value: el.getAttribute(${JSON.stringify(attributeName)}) }; })()`,
					);
					if ((actual as { missing?: boolean } | undefined)?.missing === true) {
						return `expected '${selector}' to have attribute '${attributeName}', but no element matched the selector`;
					}
					const value = (actual as { value?: string | null } | undefined)?.value ?? null;
					if (expected === undefined) {
						return `expected '${selector}' to have attribute '${attributeName}', but it was absent`;
					}
					return `expected '${selector}' attribute '${attributeName}' to be ${JSON.stringify(expected)}, but it was ${JSON.stringify(value)}`;
				},
			});
		},
		noAttribute: async (
			page,
			selector,
			attributeName,
			waitOptions?: ExpectWaitOptions,
		): Promise<void> => {
			const element = selectorExpression(selector);
			await expectPageCondition({
				assertion: 'page.noAttribute',
				page,
				condition: `(() => { const el = ${element}; return el !== null && !el.hasAttribute(${JSON.stringify(attributeName)}); })()`,
				timeoutMs: waitOptions?.timeoutMs ?? defaultTimeoutMs,
				describeFailure: async () => {
					const exists = await readPageState(page, `${element} !== null`);
					if (exists === false) {
						return `expected '${selector}' to exist without attribute '${attributeName}', but no element matched the selector`;
					}
					return `expected '${selector}' to lose attribute '${attributeName}', but the element still carries it`;
				},
			});
		},
		exists: async (page, selector, waitOptions?: ExpectWaitOptions): Promise<void> => {
			await expectPageCondition({
				assertion: 'page.exists',
				page,
				condition: `${selectorExpression(selector)} !== null`,
				timeoutMs: waitOptions?.timeoutMs ?? defaultTimeoutMs,
				describeFailure: async () =>
					`expected an element matching '${selector}' to exist in the DOM, but none appeared`,
			});
		},
		visible: async (page, selector, waitOptions?: ExpectWaitOptions): Promise<void> => {
			const element = selectorExpression(selector);
			await expectPageCondition({
				assertion: 'page.visible',
				page,
				condition: `(() => { const el = ${element}; if (el === null) return false; if (typeof el.checkVisibility === 'function') return el.checkVisibility(); return el.getClientRects().length > 0; })()`,
				timeoutMs: waitOptions?.timeoutMs ?? defaultTimeoutMs,
				describeFailure: async () => {
					const exists = await readPageState(page, `${element} !== null`);
					if (exists === false) {
						return `expected '${selector}' to be visible, but no element matched the selector`;
					}
					return `expected '${selector}' to be visible, but it stayed hidden`;
				},
			});
		},
		computedStyle: async (
			page,
			selector,
			styles,
			waitOptions?: ExpectWaitOptions,
		): Promise<void> => {
			const element = selectorExpression(selector);
			const checks = Object.entries(styles)
				.map(
					([property, value]) =>
						`${styleValueExpression(selector, property)} === ${JSON.stringify(value)}`,
				)
				.join(' && ');
			const actualEntries = Object.keys(styles)
				.map(
					(property) =>
						`${JSON.stringify(property)}: ${styleValueExpression(selector, property)}`,
				)
				.join(', ');
			await expectPageCondition({
				assertion: 'page.computedStyle',
				page,
				condition: `(() => { if (${element} === null) return false; return ${checks.length === 0 ? 'true' : checks}; })()`,
				timeoutMs: waitOptions?.timeoutMs ?? defaultTimeoutMs,
				describeFailure: async () => {
					const actual = await readPageState(
						page,
						`(() => { if (${element} === null) return null; return { ${actualEntries} }; })()`,
					);
					if (actual === null) {
						return `expected '${selector}' to match computed styles ${JSON.stringify(styles)}, but no element matched the selector`;
					}
					return `expected '${selector}' to match computed styles ${JSON.stringify(styles)}, but the computed values were ${JSON.stringify(actual)}`;
				},
			});
		},
		event: async (page, eventName, options): Promise<void> => {
			const driver = getPageDriver(page, 'expect.page.event');
			const atLeast = options?.atLeast ?? 1;
			const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
			if (driver.record.trackedEvents[eventName] === undefined) {
				failAssertion(
					'page.event',
					driver.record.environment,
					null,
					`expect.page.event('${eventName}') has no tracking data: call page.trackEvents(${JSON.stringify(eventName)}) before the action that fires it.`,
				);
			}
			try {
				await driver.page.waitForExpression(
					`${trackedEventCountExpression(eventName)} >= ${atLeast}`,
					timeoutMs,
				);
			} catch {
				await syncTrackedEvents(driver.page, driver.record);
				const observedCount = driver.record.trackedEvents[eventName]?.length ?? 0;
				failAssertion(
					'page.event',
					driver.record.environment,
					null,
					`expected page ${page.url} to observe at least ${atLeast} '${eventName}' event(s), but saw ${observedCount} within ${timeoutMs}ms.`,
				);
			}
			await syncTrackedEvents(driver.page, driver.record);
			passAssertion('page.event', driver.record.environment, null);
		},
		noNavigations: async (page): Promise<void> => {
			const driver = getPageDriver(page, 'expect.page.noNavigations');
			const navigations = driver.record.navigations;
			if (navigations.length > 0) {
				const urls = navigations.map((navigation) => navigation.url).join(', ');
				failAssertion(
					'page.noNavigations',
					driver.record.environment,
					null,
					`expected page ${page.url} to stay on its initial document, but observed ${navigations.length} navigation(s): ${urls}.`,
				);
			}
			passAssertion('page.noNavigations', driver.record.environment, null);
		},
		noFailedRequests: async (page): Promise<void> => {
			const driver = getPageDriver(page, 'expect.page.noFailedRequests');
			const failures = driver.record.failedRequests;
			if (failures.length > 0) {
				const shown = failures
					.slice(0, 5)
					.map(
						(failure) =>
							`${failure.method} ${failure.url} (${failure.reason ?? 'unknown reason'})`,
					)
					.join('; ');
				failAssertion(
					'page.noFailedRequests',
					driver.record.environment,
					null,
					`expected page ${page.url} to have no failed requests, but captured ${failures.length} failed request(s): ${shown}`,
				);
			}
			passAssertion('page.noFailedRequests', driver.record.environment, null);
		},
		cleanConsole: async (page): Promise<void> => {
			const driver = getPageDriver(page, 'expect.page.cleanConsole');
			const consoleErrors = driver.record.consoleMessages
				.filter((message) => message.level === 'error')
				.map((message) => message.text);
			const pageErrors = driver.record.pageErrors.map((error) => error.message);
			const problems = [...consoleErrors, ...pageErrors];
			if (problems.length > 0) {
				const shown = problems.slice(0, 5).join('; ');
				failAssertion(
					'page.cleanConsole',
					driver.record.environment,
					null,
					`expected page ${page.url} to have a clean console, but captured ${problems.length} error(s): ${shown}`,
				);
			}
			passAssertion('page.cleanConsole', driver.record.environment, null);
		},
	};

	const memo = new Map<string, EnvironmentExpectApi>();
	const environmentNamespace = new Proxy({} as Record<string, EnvironmentExpectApi>, {
		get: (_target, prop): EnvironmentExpectApi | undefined => {
			if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') {
				return undefined;
			}
			let api = memo.get(prop);
			if (api === undefined) {
				api = createEnvironmentExpect(prop);
				memo.set(prop, api);
			}
			return api;
		},
	});

	const browserNamespace = new Proxy({} as EnvironmentExpectApi, {
		get: (_target, prop): unknown => {
			if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') {
				return undefined;
			}
			const api = environmentNamespace[getBrowserName()];
			return api === undefined ? undefined : api[prop as keyof EnvironmentExpectApi];
		},
	});

	return {
		environment: environmentNamespace,
		browser: browserNamespace,
		page: pageNamespace,
		html: {
			contains: async (html: string, fragment: string): Promise<void> => {
				if (typeof html !== 'string') {
					failAssertion(
						'html.contains',
						null,
						null,
						'expect.html.contains(html, fragment) needs HTML evidence as a string; pass the result of an environment request.',
					);
				}
				if (!html.includes(fragment)) {
					failAssertion(
						'html.contains',
						null,
						null,
						`expected the HTML evidence (${html.length} characters) to contain ${JSON.stringify(fragment)}.`,
					);
				}
				passAssertion('html.contains', null, null);
			},
		},
		response: {
			matches: async (
				response: EnvironmentResponse,
				expectation: ResponseExpectation,
			): Promise<void> => {
				const problems: string[] = [];
				if (expectation.status !== undefined && response.status !== expectation.status) {
					problems.push(`expected status ${expectation.status}, got ${response.status}`);
				}
				if (expectation.ok !== undefined && response.ok !== expectation.ok) {
					problems.push(`expected ok=${expectation.ok}, got ok=${response.ok}`);
				}
				if (
					expectation.contentType !== undefined &&
					!(response.contentType ?? '').includes(expectation.contentType.toLowerCase())
				) {
					problems.push(
						`expected content-type to include ${JSON.stringify(expectation.contentType)}, got ${JSON.stringify(response.contentType)}`,
					);
				}
				if (
					expectation.contains !== undefined &&
					!response.text.includes(expectation.contains)
				) {
					problems.push(
						`expected the body (${response.text.length} characters) to contain ${JSON.stringify(expectation.contains)}`,
					);
				}
				if (problems.length > 0) {
					failAssertion(
						'response.matches',
						response.environment,
						null,
						`response for '${response.path}' from environment '${response.environment}' did not match: ${problems.join('; ')}.`,
					);
				}
				passAssertion('response.matches', response.environment, null);
			},
		},
		pipeline: {
			serverRestarted: async (
				change: EditReceipt,
				waitOptions?: ExpectWaitOptions,
			): Promise<void> => {
				const timeoutMs = waitOptions?.timeoutMs ?? defaultTimeoutMs;
				let restartSeq = 0;
				try {
					const restart = await store.waitUntil(
						`the Vite dev server to restart after editing ${change.file}`,
						() =>
							store.events.find(
								(event) =>
									event.kind === 'server-restart' && event.seq > change.seq,
							),
						timeoutMs,
					);
					restartSeq = restart.seq;
				} catch {
					failAssertion(
						'pipeline.serverRestarted',
						null,
						change,
						`expected the Vite dev server to restart after editing ${change.file}, but no restart was observed within ${timeoutMs}ms.`,
					);
				}
				// Settle on the restarted server accepting connections again, so
				// the box does not tear the server down mid-restart.
				try {
					await store.waitUntil(
						'the restarted Vite dev server to start listening again',
						() =>
							store.events.find(
								(event) =>
									event.kind === 'server-listening' && event.seq > restartSeq,
							),
						timeoutMs,
					);
				} catch {
					failAssertion(
						'pipeline.serverRestarted',
						null,
						change,
						`the Vite dev server began restarting after editing ${change.file}, but it did not start listening again within ${timeoutMs}ms.`,
					);
				}
				passAssertion('pipeline.serverRestarted', null, change);
			},
		},
		build: {
			environment: async (build: BuildHandle, name: string): Promise<void> => {
				if (!build.environments.includes(name)) {
					failAssertion(
						'build.environment',
						name,
						null,
						`expected the Vite build to include environment '${name}', but it built: ${build.environments.join(', ') || '(none)'}.`,
					);
				}
				passAssertion('build.environment', name, null);
			},
			artifact: async (build: BuildHandle, artifactPath: string): Promise<void> => {
				const emitted = build.artifacts.some((artifact) => artifact.path === artifactPath);
				if (!emitted) {
					failAssertion(
						'build.artifact',
						null,
						null,
						`expected the build to emit ${artifactPath}, but it emitted: ${describeArtifactList(build)}.`,
					);
				}
				passAssertion('build.artifact', null, null);
			},
		},
		artifact: {
			exists: async (build: BuildHandle, artifactPath: string): Promise<void> => {
				const absolutePath = resolveWithinRoot(
					root,
					artifactPath,
					`expect.artifact.exists('${artifactPath}')`,
				);
				if (!(await fileSystem.exists(absolutePath))) {
					failAssertion(
						'artifact.exists',
						null,
						null,
						`expected build output ${artifactPath} to exist on disk, but it does not. Emitted artifacts: ${describeArtifactList(build)}.`,
					);
				}
				passAssertion('artifact.exists', null, null);
			},
			text: async (
				build: BuildHandle,
				artifactPath: string,
				expectation: { contains?: string; notContains?: string },
			): Promise<void> => {
				let artifact: ArtifactHandle;
				try {
					artifact = await build.artifact(artifactPath);
				} catch (error) {
					failAssertion('artifact.text', null, null, errorMessage(error));
					return;
				}
				if (
					expectation.contains !== undefined &&
					!artifact.text.includes(expectation.contains)
				) {
					failAssertion(
						'artifact.text',
						null,
						null,
						`expected artifact ${artifactPath} (${artifact.text.length} characters) to contain ${JSON.stringify(expectation.contains)}.`,
					);
				}
				if (
					expectation.notContains !== undefined &&
					artifact.text.includes(expectation.notContains)
				) {
					failAssertion(
						'artifact.text',
						null,
						null,
						`forbidden string leaked into the build: artifact ${artifactPath} contains ${JSON.stringify(expectation.notContains)} at index ${artifact.text.indexOf(expectation.notContains)}.`,
					);
				}
				passAssertion('artifact.text', null, null);
			},
			json: (async (
				target: BuildHandle | ArtifactHandle,
				second: string | ArtifactJsonPredicate,
				third?: ArtifactJsonPredicate,
			): Promise<void> => {
				let artifact: ArtifactHandle;
				let predicate: ArtifactJsonPredicate;
				if (typeof second === 'string') {
					predicate = third as ArtifactJsonPredicate;
					try {
						artifact = await (target as BuildHandle).artifact(second);
					} catch (error) {
						failAssertion('artifact.json', null, null, errorMessage(error));
						return;
					}
				} else {
					artifact = target as ArtifactHandle;
					predicate = second;
				}
				let json: unknown;
				try {
					json = JSON.parse(artifact.text);
				} catch (error) {
					failAssertion(
						'artifact.json',
						null,
						null,
						`artifact ${artifact.path} is not valid JSON: ${errorMessage(error)}.`,
					);
					return;
				}
				const accepted = await predicate(json);
				if (!accepted) {
					failAssertion(
						'artifact.json',
						null,
						null,
						`custom JSON predicate rejected artifact ${artifact.path}.`,
					);
				}
				passAssertion('artifact.json', null, null);
			}) as ExpectApi['artifact']['json'],
		},
	};
}

function describeArtifactList(build: BuildHandle): string {
	if (build.artifacts.length === 0) {
		return '(no artifacts were emitted)';
	}
	const shown = build.artifacts.slice(0, 10).map((artifact) => artifact.path);
	const remaining = build.artifacts.length - shown.length;
	return remaining > 0 ? `${shown.join(', ')} and ${remaining} more` : shown.join(', ');
}
