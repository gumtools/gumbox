import mitt from 'mitt';
import path from 'pathe';
import type { DevEnvironment, Plugin } from 'vite';
import type {
	EditReceipt,
	EnvironmentEditOutcome,
	ViteCustomPayloadEvidence,
	ViteModuleEvidence,
	ViteUpdateEvidence,
} from './types.ts';

export type HotPayloadEvidence = {
	kind: 'hot-payload';
	/** 'channel' = observed on the environment hot channel; 'ws' = received by the Node WebSocket client. */
	source: 'channel' | 'ws';
	environment: string;
	payload: { type: string } & Record<string, unknown>;
	/** Absolute project files implicated by the payload, when derivable. */
	files: string[];
	seq: number;
	at: string;
};

export type HotUpdateHookEvidence = {
	kind: 'hot-update-hook';
	environment: string;
	changeType: string;
	file: string;
	modules: ViteModuleEvidence[];
	seq: number;
	at: string;
};

export type ServerRestartEvidence = {
	kind: 'server-restart';
	seq: number;
	at: string;
};

export type ServerListeningEvidence = {
	kind: 'server-listening';
	seq: number;
	at: string;
};

export type FileEditEvidence = {
	kind: 'file-edit';
	file: string;
	seq: number;
	at: string;
};

export type EvidenceEvent =
	| HotPayloadEvidence
	| HotUpdateHookEvidence
	| ServerRestartEvidence
	| ServerListeningEvidence
	| FileEditEvidence;

/** True when the given absolute file path was written/removed by this edit. */
export function editTouchesFile(edit: EditReceipt, absolutePath: string): boolean {
	return edit.files.some((file) => file.absolutePath === absolutePath);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class GumboxTimeoutError extends Error {}

/**
 * Ordered store of Vite evidence with event-driven waiting. There are no
 * fixed sleeps anywhere: every wait resolves on a matching event or rejects
 * at a bounded deadline.
 */
export class EvidenceStore {
	readonly events: EvidenceEvent[] = [];
	private readonly emitter = mitt<{ event: EvidenceEvent }>();
	private seq = 0;

	nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	record(event: DistributiveOmit<EvidenceEvent, 'seq' | 'at'>): EvidenceEvent {
		const full = {
			...event,
			seq: this.nextSeq(),
			at: new Date().toISOString(),
		} as EvidenceEvent;
		this.events.push(full);
		this.emitter.emit('event', full);
		return full;
	}

	/**
	 * Re-evaluates `check` now and on every new evidence event until it
	 * returns a value, or rejects with a GumboxTimeoutError at the deadline.
	 */
	async waitUntil<T>(
		description: string,
		check: () => T | undefined,
		timeoutMs: number,
	): Promise<T> {
		const immediate = check();
		if (immediate !== undefined) {
			return immediate;
		}
		return await new Promise<T>((resolve, reject) => {
			const signal = AbortSignal.timeout(timeoutMs);
			const cleanup = (): void => {
				this.emitter.off('event', onEvent);
				signal.removeEventListener('abort', onAbort);
			};
			const onEvent = (): void => {
				let result: T | undefined;
				try {
					result = check();
				} catch (error) {
					cleanup();
					reject(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				if (result !== undefined) {
					cleanup();
					resolve(result);
				}
			};
			const onAbort = (): void => {
				cleanup();
				reject(
					new GumboxTimeoutError(
						`timed out after ${timeoutMs}ms waiting for ${description} (${this.events.length} Vite evidence events observed so far)`,
					),
				);
			};
			this.emitter.on('event', onEvent);
			signal.addEventListener('abort', onAbort);
		});
	}
}

function urlPathToFile(root: string, urlPath: string): string | null {
	const clean = urlPath.split('?')[0] ?? urlPath;
	if (!clean.startsWith('/')) {
		return null;
	}
	return path.join(root, clean);
}

/**
 * Derives the absolute project files implicated by a hot payload so payloads
 * can be correlated to the project edit that caused them.
 */
export function payloadFiles(
	root: string,
	payload: { type: string } & Record<string, unknown>,
): string[] {
	if (payload.type === 'update' && Array.isArray(payload.updates)) {
		const files = new Set<string>();
		for (const update of payload.updates as ViteUpdateEvidence[]) {
			for (const candidate of [update.acceptedPath, update.path]) {
				if (typeof candidate === 'string') {
					const file = urlPathToFile(root, candidate);
					if (file !== null) {
						files.add(file);
					}
				}
			}
		}
		return [...files];
	}
	if (payload.type === 'full-reload' && typeof payload.triggeredBy === 'string') {
		return [payload.triggeredBy];
	}
	return [];
}

/**
 * Internal Vite plugin that observes `hotUpdate` hooks for every environment,
 * wraps each environment hot channel to capture outgoing payloads, and
 * records dev server restarts.
 *
 * Payload URL paths are mapped to files against the *resolved* Vite root: a
 * box may overlay the dev root to a project subdirectory (a fixture app), and
 * edit correlation must follow the root the server actually serves from.
 */
export function createEvidencePlugin(store: EvidenceStore, fallbackRoot: string): Plugin {
	const wrappedChannels = new WeakSet<object>();
	let resolvedRoot = fallbackRoot;
	let configureCount = 0;

	const wrapEnvironment = (environment: DevEnvironment): void => {
		const hot = environment.hot;
		if (wrappedChannels.has(hot)) {
			return;
		}
		wrappedChannels.add(hot);
		const originalSend = hot.send.bind(hot) as (...args: unknown[]) => void;
		const wrappedSend = (...args: unknown[]): void => {
			const payload =
				typeof args[0] === 'string'
					? ({ type: 'custom', event: args[0], data: args[1] } as {
							type: string;
						} & Record<string, unknown>)
					: (args[0] as { type: string } & Record<string, unknown>);
			store.record({
				kind: 'hot-payload',
				source: 'channel',
				environment: environment.name,
				payload,
				files: payloadFiles(resolvedRoot, payload),
			});
			originalSend(...args);
		};
		hot.send = wrappedSend as typeof hot.send;
	};

	return {
		name: 'gumbox:evidence',
		configResolved(config) {
			resolvedRoot = config.root;
		},
		configureServer(server) {
			configureCount += 1;
			if (configureCount > 1) {
				store.record({ kind: 'server-restart' });
			}
			// 'server-listening' marks when this (initial or restarted) server
			// actually accepts connections again, so restart assertions can
			// settle without racing box teardown against an in-flight restart.
			const httpServer = server.httpServer;
			if (httpServer !== null) {
				if (httpServer.listening) {
					store.record({ kind: 'server-listening' });
				} else {
					httpServer.once('listening', () => {
						store.record({ kind: 'server-listening' });
					});
				}
			}
			for (const environment of Object.values(server.environments)) {
				wrapEnvironment(environment);
			}
		},
		hotUpdate: {
			// 'pre' so the original invalidated module list is recorded before
			// a framework plugin can replace it (returning [] to take over HMR
			// with a custom protocol must not hide the invalidation evidence).
			order: 'pre',
			handler(options) {
				store.record({
					kind: 'hot-update-hook',
					environment: this.environment.name,
					changeType: options.type,
					file: options.file,
					modules: options.modules.map((mod) => ({
						url: mod.url,
						id: mod.id ?? null,
						file: mod.file ?? null,
					})),
				});
			},
		},
	};
}

/**
 * Connects a plain Node WebSocket (no browser) to the dev server hot channel
 * using the `vite-hmr` subprotocol and the server websocket token, proving
 * payload delivery over the wire.
 */
export async function connectHotWebSocket(options: {
	serverUrl: string;
	token: string;
	root: string;
	store: EvidenceStore;
	timeoutMs?: number;
}): Promise<{ close(): void }> {
	const { serverUrl, token, root, store, timeoutMs = 5000 } = options;
	const url = new URL(serverUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('token', token);
	const socket = new WebSocket(url, 'vite-hmr');
	socket.addEventListener('error', () => {
		// Connection failures surface through the bounded 'connected' wait below.
	});
	socket.addEventListener('message', (event) => {
		const data = (event as { data?: unknown }).data;
		if (typeof data !== 'string') {
			return;
		}
		let payload: ({ type: string } & Record<string, unknown>) | null = null;
		try {
			payload = JSON.parse(data) as { type: string } & Record<string, unknown>;
		} catch {
			return;
		}
		if (payload === null || typeof payload.type !== 'string') {
			return;
		}
		store.record({
			kind: 'hot-payload',
			source: 'ws',
			environment: 'client',
			payload,
			files: payloadFiles(root, payload),
		});
	});
	try {
		await store.waitUntil(
			'the Vite dev server hot channel to acknowledge the websocket client',
			() =>
				store.events.find(
					(event) =>
						event.kind === 'hot-payload' &&
						event.source === 'ws' &&
						event.payload.type === 'connected',
				),
			timeoutMs,
		);
	} catch (error) {
		socket.close();
		throw error;
	}
	return {
		close: (): void => {
			socket.close();
		},
	};
}

/**
 * Classifies the per-environment Vite reaction to one project edit from the
 * recorded evidence. `settled` is true once a terminal payload arrived or the
 * environment's hotUpdate hook observed the change with zero affected modules
 * (a definitive "no reaction" for non-HTML files).
 */
export function classifyEditOutcome(options: {
	store: EvidenceStore;
	environmentName: string;
	kind: EnvironmentEditOutcome['kind'];
	edit: EditReceipt;
}): { settled: boolean; hookSeen: boolean; outcome: EnvironmentEditOutcome } {
	const { store, environmentName, kind, edit } = options;
	let update = false;
	let fullReload = false;
	let restart = false;
	let error: Record<string, unknown> | null = null;
	let invalidated: ViteModuleEvidence[] = [];
	const updates: ViteUpdateEvidence[] = [];
	const customPayloads: ViteCustomPayloadEvidence[] = [];
	let hookSeen = false;

	for (const event of store.events) {
		if (event.seq <= edit.seq) {
			continue;
		}
		if (event.kind === 'server-restart') {
			restart = true;
			continue;
		}
		if (
			event.kind === 'hot-update-hook' &&
			event.environment === environmentName &&
			editTouchesFile(edit, event.file)
		) {
			hookSeen = true;
			if (event.modules.length >= invalidated.length) {
				invalidated = event.modules;
			}
			continue;
		}
		if (event.kind === 'hot-payload' && event.environment === environmentName) {
			if (
				event.files.length > 0 &&
				!event.files.some((file) => editTouchesFile(edit, file))
			) {
				continue;
			}
			if (event.payload.type === 'update') {
				update = true;
				if (event.source === 'channel' && Array.isArray(event.payload.updates)) {
					updates.push(...(event.payload.updates as ViteUpdateEvidence[]));
				}
			} else if (event.payload.type === 'full-reload') {
				fullReload = true;
			} else if (event.payload.type === 'error') {
				error = (event.payload.err as Record<string, unknown> | undefined) ?? event.payload;
			} else if (event.payload.type === 'custom' && event.source === 'channel') {
				// Channel sends only: the websocket client mirrors the same
				// payload and would double-count it.
				customPayloads.push({
					event: String(event.payload.event),
					...(event.payload.data === undefined ? {} : { data: event.payload.data }),
				});
			}
		}
	}

	// A custom payload after the hook observed the change is a terminal
	// reaction too: frameworks like qwik replace the 'update' protocol.
	const settled =
		update ||
		fullReload ||
		restart ||
		error !== null ||
		(hookSeen && (invalidated.length === 0 || customPayloads.length > 0));
	return {
		settled,
		hookSeen,
		outcome: {
			name: environmentName,
			kind,
			update,
			fullReload,
			restart,
			error,
			invalidated,
			updates,
			customPayloads,
			plugins: [],
		},
	};
}
