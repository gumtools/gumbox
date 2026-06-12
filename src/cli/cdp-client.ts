/**
 * Minimal Chrome DevTools Protocol client: JSON-RPC over a WebSocket-shaped
 * transport. Uses only the web-standard global `WebSocket`, so it runs on
 * every runtime Vite runs on. The transport is an injectable `CdpSocket` so
 * the id correlation and event dispatch are unit-testable with a fake socket.
 *
 * One socket carries every flattened CDP session (Target.attachToTarget
 * flatten: true): outgoing frames optionally carry a `sessionId`, incoming
 * frames route back by their globally unique `id` and dispatch events by
 * (sessionId, method).
 */

/** WebSocket-shaped transport carrying JSON text frames. */
export type CdpSocket = {
	send(data: string): void;
	close(): void;
	onMessage(listener: (data: string) => void): void;
	onClose(listener: () => void): void;
};

export type CdpEventParams = Record<string, unknown>;

export type CdpConnection = {
	/** Calls one CDP method and resolves with its result object. */
	send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
	/** Registers an event listener; every listener for the method fires. */
	on(method: string, listener: (params: CdpEventParams) => void): void;
	close(): void;
};

/** The browser-level connection that owns the socket and mints sessions. */
export type CdpRootConnection = CdpConnection & {
	/**
	 * A handle scoped to one flattened session: its sends carry the sessionId
	 * and only events tagged with that sessionId reach its listeners. The
	 * handle satisfies `CdpConnection`, but its close() detaches the session
	 * locally only — it must never close the shared socket, which carries
	 * every other session and the browser-level traffic.
	 */
	session(sessionId: string): CdpConnection;
};

type IncomingFrame = {
	id?: number;
	sessionId?: string;
	result?: Record<string, unknown>;
	error?: { code?: number; message?: string };
	method?: string;
	params?: CdpEventParams;
};

type PendingCall = {
	method: string;
	sessionId?: string;
	resolve(result: Record<string, unknown>): void;
	reject(error: Error): void;
};

/** Connects the global WebSocket to a CDP endpoint and adapts it to CdpSocket. */
export function openCdpSocket(url: string): Promise<CdpSocket> {
	return new Promise((resolve, reject) => {
		const webSocket = new WebSocket(url);
		webSocket.addEventListener(
			'open',
			() => {
				resolve({
					send: (data) => webSocket.send(data),
					close: () => webSocket.close(),
					onMessage: (listener) => {
						webSocket.addEventListener('message', (event) => {
							if (typeof event.data === 'string') {
								listener(event.data);
							}
						});
					},
					onClose: (listener) => {
						webSocket.addEventListener('close', () => listener(), { once: true });
					},
				});
			},
			{ once: true },
		);
		webSocket.addEventListener(
			'error',
			() => reject(new Error(`CDP WebSocket connection to ${url} failed.`)),
			{ once: true },
		);
	});
}

/** Listener map key: sessionIds are hex and methods are dotted identifiers, so a space never collides. */
function eventListenerKey(sessionId: string | undefined, method: string): string {
	return `${sessionId ?? ''} ${method}`;
}

export function createCdpConnection(socket: CdpSocket): CdpRootConnection {
	// One global monotonic id across the root and every session: ids stay
	// globally unique, so responses route by id alone.
	let nextId = 1;
	let isClosed = false;
	const pendingCalls = new Map<number, PendingCall>();
	const eventListeners = new Map<string, Array<(params: CdpEventParams) => void>>();
	const closedSessionIds = new Set<string>();

	const failPendingCalls = (
		matches: (pending: PendingCall) => boolean,
		description: string,
	): void => {
		for (const [id, pending] of pendingCalls) {
			if (!matches(pending)) {
				continue;
			}
			pendingCalls.delete(id);
			pending.reject(new Error(`${description} before '${pending.method}' answered.`));
		}
	};

	const sendCall = (
		sessionId: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		if (isClosed) {
			return Promise.reject(new Error(`CDP connection closed; cannot send '${method}'.`));
		}
		if (sessionId !== undefined && closedSessionIds.has(sessionId)) {
			return Promise.reject(new Error(`CDP session closed; cannot send '${method}'.`));
		}
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pendingCalls.set(id, { method, sessionId, resolve, reject });
			const frame: Record<string, unknown> = { id, method };
			if (params !== undefined) {
				frame.params = params;
			}
			if (sessionId !== undefined) {
				frame.sessionId = sessionId;
			}
			socket.send(JSON.stringify(frame));
		});
	};

	const addEventListener = (
		sessionId: string | undefined,
		method: string,
		listener: (params: CdpEventParams) => void,
	): void => {
		const key = eventListenerKey(sessionId, method);
		const listeners = eventListeners.get(key);
		if (listeners === undefined) {
			eventListeners.set(key, [listener]);
			return;
		}
		listeners.push(listener);
	};

	socket.onMessage((data) => {
		let frame: IncomingFrame;
		try {
			frame = JSON.parse(data) as IncomingFrame;
		} catch {
			return;
		}
		if (frame.id !== undefined) {
			// Ids are globally unique across sessions, so the frame's sessionId
			// is redundant for response correlation.
			const pending = pendingCalls.get(frame.id);
			if (pending === undefined) {
				return;
			}
			pendingCalls.delete(frame.id);
			if (frame.error !== undefined) {
				pending.reject(
					new Error(
						`${pending.method} failed: ${frame.error.message ?? 'unknown CDP error'}`,
					),
				);
				return;
			}
			pending.resolve(frame.result ?? {});
			return;
		}
		if (frame.method !== undefined) {
			const key = eventListenerKey(frame.sessionId, frame.method);
			for (const listener of eventListeners.get(key) ?? []) {
				listener(frame.params ?? {});
			}
		}
	});

	socket.onClose(() => {
		isClosed = true;
		// The socket carried every session, so the process (or transport) dying
		// fails all of them at once — pool eviction then covers the rest.
		failPendingCalls(() => true, 'CDP connection closed');
	});

	const createSessionHandle = (sessionId: string): CdpConnection => ({
		send: (method, params) => sendCall(sessionId, method, params),
		on: (method, listener) => addEventListener(sessionId, method, listener),
		close: () => {
			// Local detach only: reject this session's in-flight calls and drop
			// its listeners. Never close the shared socket here — it carries
			// every other session.
			if (closedSessionIds.has(sessionId)) {
				return;
			}
			closedSessionIds.add(sessionId);
			failPendingCalls((pending) => pending.sessionId === sessionId, 'CDP session closed');
			for (const key of eventListeners.keys()) {
				if (key.startsWith(`${sessionId} `)) {
					eventListeners.delete(key);
				}
			}
		},
	});

	return {
		send: (method, params) => sendCall(undefined, method, params),
		on: (method, listener) => addEventListener(undefined, method, listener),
		session: createSessionHandle,
		close: () => {
			if (isClosed) {
				return;
			}
			isClosed = true;
			failPendingCalls(() => true, 'CDP connection closed');
			socket.close();
		},
	};
}
