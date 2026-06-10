import path from 'pathe';
import { createServer } from 'vite';
import type { FSWatcher, InlineConfig, ViteDevServer } from 'vite';
import { createBrowserEvidence, missingBrowserCapabilityError } from './browser.ts';
import type { GumboxBrowser, PageHandle } from './browser.ts';
import { runPipelineBuild } from './build.ts';
import { discoverBoxes } from './discovery.ts';
import { createEnvironmentRuntime } from './environments.ts';
import type { EnvironmentRuntime } from './environments.ts';
import { connectHotWebSocket, createEvidencePlugin, EvidenceStore } from './evidence.ts';
import { createExpectApi } from './expect.ts';
import type { GumboxFileSystem } from './filesystem.ts';
import { startPipelinePreview } from './preview.ts';
import { createProjectApi } from './project.ts';
import { BoxRecorder, createRunDirectory, writeRunReceipt } from './receipt.ts';
import type {
	BoxContext,
	BoxRunResult,
	BrowserEnvironmentAlias,
	BuildHandle,
	DevServerHandle,
	DiscoveredBox,
	EnvironmentApi,
	EnvironmentHandle,
	InvalidBoxFile,
	PipelineApi,
	PipelineBuildOptions,
	PipelinePreviewOptions,
	PreviewHandle,
	ReceiptApi,
	RunBoxesOptions,
	RunBoxesResult,
} from './types.ts';

const DEFAULT_ASSERTION_TIMEOUT_MS = 5000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Waits until the dev server's chokidar watcher finished its initial scan, so
 * project edits written afterwards are guaranteed to produce watcher events.
 */
async function waitForWatcherReady(watcher: FSWatcher, timeoutMs: number): Promise<void> {
	if ((watcher as unknown as { _readyEmitted?: boolean })._readyEmitted === true) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const signal = AbortSignal.timeout(timeoutMs);
		const onReady = (): void => {
			cleanup();
			resolve();
		};
		const onAbort = (): void => {
			cleanup();
			reject(new Error('timed out waiting for the Vite file watcher to become ready.'));
		};
		const cleanup = (): void => {
			watcher.off('ready', onReady);
			signal.removeEventListener('abort', onAbort);
		};
		watcher.once('ready', onReady);
		signal.addEventListener('abort', onAbort);
	});
}

type RunnerState = {
	server: ViteDevServer | null;
	runtime: EnvironmentRuntime | null;
	ws: { close(): void } | null;
	devHandle: DevServerHandle | null;
};

/**
 * If the websocket hot client is connected and the environment channel saw an
 * HMR update, wait (bounded, event-driven) for the over-the-wire copy so the
 * receipt deterministically contains both evidence sources.
 */
async function mirrorWsUpdateEvidence(state: RunnerState, store: EvidenceStore): Promise<void> {
	if (state.ws === null) {
		return;
	}
	const hasChannelUpdate = store.events.some(
		(event) =>
			event.kind === 'hot-payload' &&
			event.source === 'channel' &&
			event.payload.type === 'update',
	);
	if (!hasChannelUpdate) {
		return;
	}
	await store
		.waitUntil(
			'the websocket hot client to mirror the HMR update payload',
			() =>
				store.events.find(
					(event) =>
						event.kind === 'hot-payload' &&
						event.source === 'ws' &&
						event.payload.type === 'update',
				),
			3000,
		)
		.catch(() => undefined);
}

async function runSingleBox(args: {
	discovered: DiscoveredBox;
	root: string;
	runDir: string;
	receiptPath: string;
	boxIndex: number;
	assertionTimeoutMs: number;
	fileSystem: GumboxFileSystem;
	browser: GumboxBrowser | undefined;
	headless: boolean;
}): Promise<{ result: BoxRunResult; receipt: Record<string, unknown> }> {
	const {
		discovered,
		root,
		runDir,
		receiptPath,
		boxIndex,
		assertionTimeoutMs,
		fileSystem,
		browser: browserCapability,
		headless,
	} = args;
	const definition = discovered.box;
	const store = new EvidenceStore();
	const recorder = new BoxRecorder(store);
	const state: RunnerState = { server: null, runtime: null, ws: null, devHandle: null };
	const openPreviews: Array<{ close(): Promise<void> }> = [];

	const browserEvidence = createBrowserEvidence({
		browser: browserCapability,
		headless,
		fileSystem,
		runDir,
		assetDir: `box-${boxIndex}`,
		interactionTimeoutMs: assertionTimeoutMs,
		onTimeline: (type, detail) => recorder.timeline(type, detail),
	});
	recorder.pages = browserEvidence.pages;

	const projectRuntime = createProjectApi({
		root,
		fileSystem,
		store,
		getConfigFile: () => state.server?.config.configFile ?? null,
		onTimeline: (type, detail) => recorder.timeline(type, detail),
	});
	recorder.edits = projectRuntime.edits;

	const pipeline: PipelineApi = {
		dev: async (devOptions): Promise<DevServerHandle> => {
			if (state.devHandle !== null) {
				return state.devHandle;
			}
			let inline: InlineConfig = {
				root,
				logLevel: 'error',
				server: { host: '127.0.0.1' },
				plugins: [createEvidencePlugin(store, root)],
			};
			if (devOptions?.config !== undefined) {
				inline = devOptions.config(inline) ?? inline;
			}
			const server = await createServer(inline);
			state.server = server;
			await server.listen();
			await waitForWatcherReady(server.watcher, 10_000);
			const runtime = createEnvironmentRuntime(
				server,
				(type, detail) => recorder.timeline(type, detail),
				(visitArgs) => browserEvidence.visit(visitArgs),
			);
			state.runtime = runtime;
			recorder.vite = {
				configFile: server.config.configFile ?? null,
				serverUrl: runtime.serverUrl,
				environments: runtime.names,
				browserAlias: runtime.browserName,
				kinds: runtime.kinds,
			};
			recorder.timeline('server started', { url: runtime.serverUrl });
			recorder.timeline('environments resolved', {
				environments: runtime.names,
				browserAlias: runtime.browserName,
			});
			try {
				state.ws = await connectHotWebSocket({
					serverUrl: runtime.serverUrl,
					token: server.config.webSocketToken,
					// The resolved root, not the runner root: a box may overlay
					// the dev root to a project subdirectory.
					root: server.config.root,
					store,
				});
				recorder.timeline('hot channel websocket connected', { url: runtime.serverUrl });
			} catch (error) {
				recorder.note(
					`hot channel websocket unavailable; relying on hot-channel sends and plugin hotUpdate hooks: ${errorMessage(error)}`,
				);
			}
			state.devHandle = { url: runtime.serverUrl, environments: runtime.names, server };
			return state.devHandle;
		},
		build: async (buildOptions?: PipelineBuildOptions): Promise<BuildHandle> => {
			const { handle, record } = await runPipelineBuild({
				root,
				fileSystem,
				buildId: `build-${recorder.builds.length + 1}`,
				options: buildOptions,
				onTimeline: (type, detail) => recorder.timeline(type, detail),
			});
			recorder.builds.push(record);
			return handle;
		},
		preview: async (
			build: BuildHandle,
			previewOptions?: PipelinePreviewOptions,
		): Promise<PreviewHandle> => {
			const browserAlias = state.runtime?.browserName ?? 'client';
			const { handle, record, close } = await startPipelinePreview({
				root,
				build,
				previewId: `preview-${recorder.previews.length + 1}`,
				options: previewOptions,
				browserAlias,
				visit: (visitArgs) => browserEvidence.visit(visitArgs),
				onTimeline: (type, detail) => recorder.timeline(type, detail),
			});
			recorder.previews.push(record);
			openPreviews.push({ close });
			return handle;
		},
	};

	const environment = new Proxy({} as EnvironmentApi, {
		get: (_target, prop): EnvironmentHandle | undefined => {
			if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') {
				return undefined;
			}
			const runtime = state.runtime;
			if (runtime === null) {
				throw new Error(
					`environment.${prop} is unavailable before the dev server starts. Call \`await pipeline.dev()\` first.`,
				);
			}
			const handle = runtime.handles[prop];
			if (handle === undefined) {
				throw new Error(
					`unknown Vite environment '${prop}'. Known environments: ${runtime.names.join(', ')}.`,
				);
			}
			return handle;
		},
	});

	const resolveBrowserHandle = (runtime: EnvironmentRuntime): EnvironmentHandle => {
		const handle = runtime.handles[runtime.browserName];
		if (handle === undefined) {
			throw new Error(
				`no browser-capable environment found. Known environments: ${runtime.names.join(', ')}.`,
			);
		}
		return handle;
	};

	const browser = new Proxy({} as BrowserEnvironmentAlias, {
		get: (_target, prop): unknown => {
			if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') {
				return undefined;
			}
			if (prop === 'visit') {
				// The simple-box happy path: browser.visit() auto-starts the dev
				// server, so a visit box does not need an explicit pipeline.dev().
				return async (visitPath: string): Promise<PageHandle> => {
					if (browserCapability === undefined) {
						throw missingBrowserCapabilityError(`browser.visit('${visitPath}')`);
					}
					await pipeline.dev();
					const handle = resolveBrowserHandle(state.runtime!);
					if (handle.visit === undefined) {
						throw new Error(
							`environment '${handle.name}' is not browser-capable, so browser.visit('${visitPath}') is unavailable.`,
						);
					}
					return await handle.visit(visitPath);
				};
			}
			const runtime = state.runtime;
			if (runtime === null) {
				throw new Error(
					`browser.${prop} is unavailable before the dev server starts. Call \`await pipeline.dev()\` first.`,
				);
			}
			return resolveBrowserHandle(runtime)[prop as keyof EnvironmentHandle];
		},
	});

	const expectApi = createExpectApi({
		store,
		receiptPath,
		defaultTimeoutMs: assertionTimeoutMs,
		root,
		fileSystem,
		getBrowserName: () => state.runtime?.browserName ?? 'client',
		getEnvironmentKind: (name) => state.runtime?.kinds[name] ?? 'server',
		onAssertion: (record) => recorder.assertion(record),
	});

	const receiptApi: ReceiptApi = {
		capture: async (label: string): Promise<void> => {
			recorder.capture(label);
			// A named checkpoint snapshots every open page so the receipt can
			// show the visible state at that moment.
			await browserEvidence.captureOpenPages(label);
		},
		note: (text: string): void => {
			recorder.note(text);
		},
		measure: async (label, fn) => {
			const startedAt = performance.now();
			await fn();
			const measurement = {
				label,
				durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
			};
			recorder.measurement(measurement);
			return measurement;
		},
	};

	const context: BoxContext = {
		environment,
		browser,
		project: projectRuntime.project,
		pipeline,
		expect: expectApi,
		receipt: receiptApi,
	};

	recorder.start({
		name: definition.name,
		file: discovered.relativeFile,
		exportName: discovered.exportName,
	});
	let status: 'passed' | 'failed' = 'passed';
	try {
		await definition.run(context);
	} catch (error) {
		status = 'failed';
		recorder.error =
			error instanceof Error
				? {
						message: error.message,
						...(error.stack === undefined ? {} : { stack: error.stack }),
					}
				: { message: String(error) };
		recorder.timeline('box failed', { message: recorder.error.message });
	} finally {
		await mirrorWsUpdateEvidence(state, store);
		// Close the browser before the servers so no page keeps requests
		// in flight against a server that is tearing down.
		await browserEvidence.closeAll();
		for (const openPreview of openPreviews.splice(0)) {
			await openPreview.close().catch(() => undefined);
		}
		state.ws?.close();
		if (state.server !== null) {
			await state.server.close().catch(() => undefined);
			recorder.timeline('server closed', {});
		}
		// Restore after the server closes so restoration cannot trigger another
		// Vite reaction (a config restore would otherwise restart the server
		// while the box is tearing down).
		await projectRuntime.restoreAll();
	}
	recorder.finish(status);
	const receipt = recorder.buildBoxReceipt({
		name: definition.name,
		tags: definition.tags,
		modes: definition.modes,
		ui: definition.ui,
		file: discovered.relativeFile,
		exportName: discovered.exportName,
		status,
	});
	return {
		result: {
			name: definition.name,
			file: discovered.relativeFile,
			exportName: discovered.exportName,
			status,
			error: recorder.error,
		},
		receipt,
	};
}

/**
 * Runs boxes against a project root and writes one versioned receipt for the
 * whole run to `<root>/.gumbox/receipts/<run id>/receipt.json`, plus a
 * `latest` pointer file. A receipt is written even when boxes fail.
 */
export async function runBoxes(options: RunBoxesOptions): Promise<RunBoxesResult> {
	const root = path.resolve(options.root);
	const { fileSystem } = options;
	let boxes = options.boxes;
	let invalid: InvalidBoxFile[] = options.invalid ?? [];
	if (boxes === undefined) {
		const discovery = await discoverBoxes({ root });
		boxes = discovery.boxes;
		invalid = discovery.invalid;
	}
	const { runId, runDir, receiptPath, receiptsDir } = await createRunDirectory(
		root,
		fileSystem,
		options.receiptDir,
	);
	const results: BoxRunResult[] = [];
	const boxReceipts: Record<string, unknown>[] = [];
	for (const [index, discovered] of boxes.entries()) {
		const { result, receipt } = await runSingleBox({
			discovered,
			root,
			runDir,
			receiptPath,
			boxIndex: index + 1,
			assertionTimeoutMs: options.assertionTimeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS,
			fileSystem,
			browser: options.browser,
			headless: options.headless ?? true,
		});
		results.push(result);
		boxReceipts.push(receipt);
	}
	const failed = results.filter((result) => result.status === 'failed').length;
	const status: 'passed' | 'failed' = failed === 0 ? 'passed' : 'failed';
	const receipt = {
		gumboxReceipt: 1,
		runId,
		createdAt: new Date().toISOString(),
		root,
		summary: {
			status,
			total: results.length,
			passed: results.length - failed,
			failed,
			invalidBoxFiles: invalid.length,
		},
		invalidBoxFiles: invalid,
		boxes: boxReceipts,
	};
	await writeRunReceipt(receiptsDir, runId, receiptPath, receipt, fileSystem);
	return { status, root, runId, runDir, receiptPath, boxes: results, invalid };
}
