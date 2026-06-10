import { isFetchableDevEnvironment, isRunnableDevEnvironment } from 'vite';
import type { DevEnvironment, ViteDevServer } from 'vite';
import type { PageHandle, VisitArgs } from './browser.ts';
import type { EnvironmentFetchInit, EnvironmentHandle, EnvironmentResponse } from './types.ts';

export type EnvironmentRuntime = {
	handles: Record<string, EnvironmentHandle>;
	names: string[];
	kinds: Record<string, 'browser' | 'server'>;
	browserName: string;
	serverUrl: string;
};

function environmentKind(environment: DevEnvironment): 'browser' | 'server' {
	return environment.config.consumer === 'client' ? 'browser' : 'server';
}

/** Normalizes a fetch Response into box-facing response evidence. */
async function toEnvironmentResponse(args: {
	environment: string;
	path: string;
	url: string;
	response: Response;
}): Promise<EnvironmentResponse> {
	const { environment, path: requestPath, url, response } = args;
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		headers[name.toLowerCase()] = value;
	});
	return {
		environment,
		path: requestPath,
		url,
		status: response.status,
		ok: response.ok,
		contentType: headers['content-type']?.toLowerCase() ?? null,
		headers,
		text: await response.text(),
	};
}

export function createEnvironmentRuntime(
	server: ViteDevServer,
	onTimeline: (type: string, detail: Record<string, unknown>) => void,
	visitPage: (args: VisitArgs) => Promise<PageHandle>,
): EnvironmentRuntime {
	const serverUrl = server.resolvedUrls?.local[0];
	if (serverUrl === undefined) {
		throw new Error(
			'the Vite dev server did not report a local URL; Gumbox needs a listening (non-middleware) dev server.',
		);
	}
	const names = Object.keys(server.environments);
	const kinds: Record<string, 'browser' | 'server'> = {};
	for (const name of names) {
		const environment = server.environments[name];
		if (environment !== undefined) {
			kinds[name] = environmentKind(environment);
		}
	}
	const browserName = names.includes('client')
		? 'client'
		: (names.find((name) => kinds[name] === 'browser') ?? names[0] ?? 'client');

	const handles: Record<string, EnvironmentHandle> = {};
	for (const name of names) {
		const environment = server.environments[name];
		if (environment === undefined) {
			continue;
		}
		const kind = kinds[name] ?? 'server';
		const handle: EnvironmentHandle = {
			name,
			kind,
			request: async (requestPath: string): Promise<string> => {
				if (name === browserName) {
					// The dev server serves the browser environment over HTTP;
					// fetching populates its module graph exactly like a browser would.
					onTimeline('route requested', { environment: name, path: requestPath });
					const response = await fetch(new URL(requestPath, serverUrl));
					const body = await response.text();
					if (!response.ok) {
						throw new Error(
							`environment.${name}.request('${requestPath}') returned HTTP ${response.status} from ${serverUrl}.`,
						);
					}
					return body;
				}
				if (isFetchableDevEnvironment(environment)) {
					onTimeline('environment requested', { environment: name, path: requestPath });
					const response = await environment.dispatchFetch(
						new Request(new URL(requestPath, serverUrl)),
					);
					return await response.text();
				}
				throw new Error(
					`environment.${name}.request() is unavailable: '${name}' is not a fetchable environment. Use environment.${name}.import(id) if it is runnable.`,
				);
			},
			fetch: async (
				requestPath: string,
				init?: EnvironmentFetchInit,
			): Promise<EnvironmentResponse> => {
				const url = new URL(requestPath, serverUrl).href;
				let response: Response;
				if (name === browserName) {
					onTimeline('route requested', { environment: name, path: requestPath });
					response = await fetch(
						url,
						init?.headers === undefined ? {} : { headers: init.headers },
					);
				} else if (isFetchableDevEnvironment(environment)) {
					onTimeline('environment requested', { environment: name, path: requestPath });
					response = await environment.dispatchFetch(
						new Request(
							url,
							init?.headers === undefined ? {} : { headers: init.headers },
						),
					);
				} else {
					throw new Error(
						`environment.${name}.fetch() is unavailable: '${name}' is not a fetchable environment. Use environment.${name}.import(id) if it is runnable.`,
					);
				}
				const evidence = await toEnvironmentResponse({
					environment: name,
					path: requestPath,
					url,
					response,
				});
				onTimeline('response received', {
					environment: name,
					path: requestPath,
					status: evidence.status,
					contentType: evidence.contentType,
				});
				return evidence;
			},
			import: async <T = Record<string, unknown>>(id: string): Promise<T> => {
				if (!isRunnableDevEnvironment(environment)) {
					const hint =
						name === browserName
							? ` Use environment.${name}.request(path) instead.`
							: '';
					throw new Error(
						`environment.${name}.import() is unavailable: '${name}' is not a runnable environment.${hint}`,
					);
				}
				onTimeline('environment imported module', { environment: name, id });
				return (await environment.runner.import(id)) as T;
			},
		};
		if (kind === 'browser') {
			handle.visit = (visitPath: string): Promise<PageHandle> => {
				return visitPage({
					baseUrl: serverUrl,
					route: visitPath,
					environment: name,
					surface: 'dev',
				});
			};
		}
		handles[name] = handle;
	}

	return { handles, names, kinds, browserName, serverUrl };
}
