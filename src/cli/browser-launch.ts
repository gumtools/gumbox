/**
 * Host boundary for launching a Chromium-family browser. Like
 * `src/cli/host.ts` for the filesystem, this is the one place allowed to
 * adapt runtime process/filesystem/env APIs — spawning the browser, reading
 * its stderr, writing screenshot bytes, and managing the temp profile dir.
 * Runtimes are detected through `globalThis` so no `node:*`, `Deno.*`, or
 * `Bun.*` identifier is referenced directly.
 */
import path from 'pathe';
import { discoverBrowserExecutable } from './browser-discovery.ts';
import type { BrowserPlatform } from './browser-discovery.ts';
import type { LaunchedBrowserEndpoint } from './cdp-browser.ts';

/** Upper bound for the browser to announce its DevTools endpoint. */
const ENDPOINT_TIMEOUT_MS = 30_000;
/** Re-poll interval for the DevToolsActivePort fallback file. */
const ENDPOINT_POLL_INTERVAL_MS = 150;

type DenoChildLike = {
	stderr: ReadableStream<Uint8Array>;
	status: Promise<unknown>;
	kill(): void;
};

type DenoCommandLike = new (
	executable: string,
	options: { args: string[]; stdin: 'null'; stdout: 'null'; stderr: 'piped' },
) => { spawn(): DenoChildLike };

type DenoRuntimeLike = {
	build?: { os?: string };
	Command?: DenoCommandLike;
	env?: { get?(name: string): string | undefined };
	makeTempDir?(options?: { prefix?: string }): Promise<string>;
	remove?(filePath: string, options?: { recursive?: boolean }): Promise<void>;
	writeFile?(filePath: string, data: Uint8Array): Promise<void>;
	readTextFile?(filePath: string): Promise<string>;
	readDir?(dirPath: string): AsyncIterable<{ name: string }>;
	stat?(filePath: string): Promise<unknown>;
};

type HostProcessLike = {
	getBuiltinModule?(name: string): unknown;
	platform?: string;
	env?: Record<string, string | undefined>;
};

type NodeChildLike = {
	stderr: { on(event: 'data', listener: (chunk: { toString(): string }) => void): void } | null;
	on(event: 'exit' | 'error', listener: () => void): void;
	kill(): boolean;
};

type NodeChildProcessLike = {
	spawn(
		executable: string,
		args: string[],
		options: { stdio: ['ignore', 'ignore', 'pipe'] },
	): NodeChildLike;
};

type NodeFsPromisesLike = {
	mkdtemp(prefix: string): Promise<string>;
	rm(filePath: string, options: { recursive: boolean; force: boolean }): Promise<void>;
	writeFile(filePath: string, data: Uint8Array): Promise<void>;
	readFile(filePath: string, encoding: 'utf8'): Promise<string>;
	readdir(dirPath: string): Promise<string[]>;
	stat(filePath: string): Promise<unknown>;
};

type NodeOsLike = { tmpdir(): string };

function globalDeno(): DenoRuntimeLike | undefined {
	return (globalThis as typeof globalThis & { Deno?: DenoRuntimeLike })['Deno'];
}

function globalProcess(): HostProcessLike | undefined {
	return (globalThis as typeof globalThis & { process?: HostProcessLike })['process'];
}

function nodeBuiltin<T>(name: string): T | undefined {
	return globalProcess()?.getBuiltinModule?.(name) as T | undefined;
}

function nodeFsPromises(): NodeFsPromisesLike | undefined {
	return nodeBuiltin<{ promises?: NodeFsPromisesLike }>('fs')?.promises;
}

function detectHostPlatform(): BrowserPlatform {
	const nodePlatform = globalProcess()?.platform;
	const os = globalDeno()?.build?.os ?? (nodePlatform === 'win32' ? 'windows' : nodePlatform);
	if (os === 'darwin' || os === 'linux' || os === 'windows') {
		return os;
	}
	throw new Error(
		`gumbox cannot launch a browser on platform '${os ?? 'unknown'}'. ` +
			`Supported platforms: macOS, Linux, Windows.`,
	);
}

function readHostEnv(name: string): string | undefined {
	const denoEnv = globalDeno()?.env;
	if (denoEnv?.get !== undefined) {
		try {
			// Throws under Deno without --allow-env for this variable.
			return denoEnv.get(name);
		} catch {
			return undefined;
		}
	}
	try {
		return globalProcess()?.env?.[name];
	} catch {
		return undefined;
	}
}

/** Entry names of a directory; rejects when it is missing or unreadable. */
async function listHostDirectoryNames(dirPath: string): Promise<string[]> {
	const denoReadDir = globalDeno()?.readDir;
	if (denoReadDir !== undefined) {
		const names: string[] = [];
		for await (const entry of denoReadDir(dirPath)) {
			names.push(entry.name);
		}
		return names;
	}
	const fs = nodeFsPromises();
	if (fs === undefined) {
		throw new Error('gumbox could not find a host filesystem on this runtime.');
	}
	return fs.readdir(dirPath);
}

async function pathExists(filePath: string): Promise<boolean> {
	const denoStat = globalDeno()?.stat;
	if (denoStat !== undefined) {
		try {
			await denoStat(filePath);
			return true;
		} catch {
			return false;
		}
	}
	const fs = nodeFsPromises();
	if (fs === undefined) {
		throw new Error('gumbox could not find a host filesystem on this runtime.');
	}
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function makeTempProfileDir(): Promise<string> {
	const denoRuntime = globalDeno();
	if (denoRuntime?.makeTempDir !== undefined) {
		return denoRuntime.makeTempDir({ prefix: 'gumbox-chromium-' });
	}
	const fs = nodeFsPromises();
	const os = nodeBuiltin<NodeOsLike>('os');
	if (fs !== undefined && os !== undefined) {
		return fs.mkdtemp(path.join(os.tmpdir(), 'gumbox-chromium-'));
	}
	throw new Error('gumbox could not create a browser profile directory on this runtime.');
}

async function removeDirectoryOnce(dirPath: string): Promise<void> {
	const denoRuntime = globalDeno();
	if (denoRuntime?.remove !== undefined) {
		await denoRuntime.remove(dirPath, { recursive: true }).catch(() => undefined);
		return;
	}
	await nodeFsPromises()
		?.rm(dirPath, { recursive: true, force: true })
		.catch(() => undefined);
}

const PROFILE_REMOVAL_MAX_ATTEMPTS = 5;
const PROFILE_REMOVAL_RETRY_DELAY_MS = 100;

/**
 * Removes the temp profile dir, retrying briefly. Even after the main browser
 * process is reaped, dying Chrome helpers can still drop singleton/lock files
 * into the profile, which makes a single recursive removal race and fail.
 */
async function removeDirectory(dirPath: string): Promise<void> {
	for (let attempt = 1; attempt <= PROFILE_REMOVAL_MAX_ATTEMPTS; attempt++) {
		await removeDirectoryOnce(dirPath);
		if (!(await pathExists(dirPath))) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, PROFILE_REMOVAL_RETRY_DELAY_MS));
	}
}

async function writeBinaryFile(filePath: string, bytes: Uint8Array): Promise<void> {
	const denoRuntime = globalDeno();
	if (denoRuntime?.writeFile !== undefined) {
		await denoRuntime.writeFile(filePath, bytes);
		return;
	}
	const fs = nodeFsPromises();
	if (fs !== undefined) {
		await fs.writeFile(filePath, bytes);
		return;
	}
	throw new Error('gumbox could not find a host filesystem to write the screenshot.');
}

async function readTextFileIfPresent(filePath: string): Promise<string | null> {
	try {
		const denoRuntime = globalDeno();
		if (denoRuntime?.readTextFile !== undefined) {
			return await denoRuntime.readTextFile(filePath);
		}
		const fs = nodeFsPromises();
		if (fs !== undefined) {
			return await fs.readFile(filePath, 'utf8');
		}
		return null;
	} catch {
		return null;
	}
}

type BrowserProcess = {
	kill(): void;
	exited: Promise<void>;
	onStderrText(listener: (text: string) => void): void;
};

function spawnWithDeno(
	DenoCommand: DenoCommandLike,
	executable: string,
	args: string[],
): BrowserProcess {
	const child = new DenoCommand(executable, {
		args,
		stdin: 'null',
		stdout: 'null',
		stderr: 'piped',
	}).spawn();
	const stderrListeners: Array<(text: string) => void> = [];
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr) {
			const text = decoder.decode(chunk, { stream: true });
			for (const listener of stderrListeners) {
				listener(text);
			}
		}
	})().catch(() => undefined);
	return {
		kill: () => {
			try {
				child.kill();
			} catch {
				// Already exited.
			}
		},
		exited: child.status.then(() => undefined),
		onStderrText: (listener) => {
			stderrListeners.push(listener);
		},
	};
}

function spawnWithNode(
	childProcess: NodeChildProcessLike,
	executable: string,
	args: string[],
): BrowserProcess {
	const child = childProcess.spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
	const stderrListeners: Array<(text: string) => void> = [];
	child.stderr?.on('data', (chunk) => {
		const text = chunk.toString();
		for (const listener of stderrListeners) {
			listener(text);
		}
	});
	const exited = new Promise<void>((resolve) => {
		child.on('exit', () => resolve());
		child.on('error', () => resolve());
	});
	return {
		kill: () => {
			try {
				child.kill();
			} catch {
				// Already exited.
			}
		},
		exited,
		onStderrText: (listener) => {
			stderrListeners.push(listener);
		},
	};
}

function spawnBrowserProcess(executable: string, args: string[]): BrowserProcess {
	const denoCommand = globalDeno()?.Command;
	if (denoCommand !== undefined) {
		return spawnWithDeno(denoCommand, executable, args);
	}
	const childProcess = nodeBuiltin<NodeChildProcessLike>('child_process');
	if (childProcess !== undefined) {
		return spawnWithNode(childProcess, executable, args);
	}
	throw new Error('gumbox could not spawn a browser process on this runtime.');
}

/**
 * With `--remote-debugging-port=0` the chosen port is only knowable from the
 * browser itself: Chrome writes `<profile>/DevToolsActivePort` with the port
 * and the browser target path. This is the fallback when the stderr line is
 * missed (some runtimes chunk it apart, some Chrome builds suppress it).
 */
async function readDevToolsActivePort(profileDir: string): Promise<string | null> {
	const text = await readTextFileIfPresent(path.join(profileDir, 'DevToolsActivePort'));
	if (text === null) {
		return null;
	}
	const [portLine, browserPath] = text.split('\n');
	const port = Number(portLine?.trim());
	if (!Number.isInteger(port) || port <= 0 || browserPath === undefined) {
		return null;
	}
	const targetPath = browserPath.trim();
	if (!targetPath.startsWith('/')) {
		return null;
	}
	return `ws://127.0.0.1:${port}${targetPath}`;
}

/**
 * Resolves the browser-level WebSocket URL: parses "DevTools listening on
 * ws://..." from stderr, polls the DevToolsActivePort file as a fallback, and
 * fails when the process exits or the bound elapses first.
 */
function resolveDevToolsEndpoint(child: BrowserProcess, profileDir: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let stderrText = '';
		let settled = false;

		const timer = setTimeout(() => {
			fail(
				new Error(
					`The browser did not announce a DevTools endpoint within ${ENDPOINT_TIMEOUT_MS}ms. ` +
						`stderr: ${stderrText.slice(0, 500)}`,
				),
			);
		}, ENDPOINT_TIMEOUT_MS);
		const poller = setInterval(() => {
			void readDevToolsActivePort(profileDir).then((endpoint) => {
				if (endpoint !== null) {
					succeed(endpoint);
				}
			});
		}, ENDPOINT_POLL_INTERVAL_MS);

		const cleanup = (): void => {
			settled = true;
			clearTimeout(timer);
			clearInterval(poller);
		};
		const succeed = (endpoint: string): void => {
			if (!settled) {
				cleanup();
				resolve(endpoint);
			}
		};
		const fail = (error: Error): void => {
			if (!settled) {
				cleanup();
				reject(error);
			}
		};

		child.onStderrText((text) => {
			stderrText += text;
			const match = stderrText.match(/DevTools listening on (ws:\/\/\S+)/);
			if (match !== null) {
				succeed(match[1]!);
			}
		});
		void child.exited.then(() => {
			fail(
				new Error(
					`The browser exited before exposing a DevTools endpoint. ` +
						`stderr: ${stderrText.slice(0, 500)}`,
				),
			);
		});
	});
}

/**
 * Work-disabling automation flags, mirroring the playwright chromium defaults
 * that matter for headless evidence-gathering: no background activity
 * competes with the run, no first-run/update/sync machinery runs against the
 * throwaway profile, and no prompt or popup can stall an automated page.
 * `--disable-gpu` is deliberately absent — modern headless handles GPU and
 * benchmarking showed no win from disabling it.
 */
const AUTOMATION_LAUNCH_FLAGS = [
	'--disable-background-networking',
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--disable-extensions',
	'--disable-component-extensions-with-background-pages',
	'--disable-component-update',
	'--disable-default-apps',
	'--disable-sync',
	'--disable-features=Translate',
	'--disable-prompt-on-repost',
	'--disable-client-side-phishing-detection',
	'--disable-hang-monitor',
	'--disable-ipc-flooding-protection',
	'--disable-popup-blocking',
	'--metrics-recording-only',
	'--no-service-autorun',
	'--no-first-run',
	'--no-default-browser-check',
	'--mute-audio',
];

/** OS-specific flags that keep credential stores out of automated runs. */
function platformLaunchFlags(platform: BrowserPlatform): string[] {
	if (platform === 'darwin') {
		return ['--use-mock-keychain'];
	}
	if (platform === 'linux') {
		return ['--password-store=basic'];
	}
	return [];
}

/**
 * Live browser shutdowns, registered at spawn and deregistered only once
 * their own shutdown runs. Pooled browser processes outlive every
 * GumboxBrowserSession (a session is a browser context, not a process), so an
 * entry stays registered for the pool's whole lifetime — nothing deregisters
 * per session. Without this registry an interrupted or finished run would
 * orphan headless browsers and strand `gumbox-chromium-*` profile dirs in the
 * temp directory.
 */
const liveBrowserShutdowns = new Set<() => Promise<void>>();

/**
 * Disposes every pooled browser process still alive: kills it and removes its
 * temp profile dir. This is the one disposal path for pooled browsers — the
 * CLI calls it after the run resolves, the test support registers it in
 * afterAll, and the interrupt handler calls it on Ctrl-C. Safe to call at any
 * time and more than once (each shutdown is memoized).
 */
export async function shutdownLiveBrowserSessions(): Promise<void> {
	const pendingShutdowns: Array<Promise<void>> = [];
	for (const shutdown of liveBrowserShutdowns) {
		pendingShutdowns.push(shutdown().catch(() => undefined));
	}
	await Promise.all(pendingShutdowns);
}

/**
 * Discovers, spawns, and connects to a Chromium-family browser, returning the
 * DevTools endpoint plus the host capabilities the CDP adapter needs.
 */
export async function launchBrowserEndpoint(options: {
	headless: boolean;
}): Promise<LaunchedBrowserEndpoint> {
	const platform = detectHostPlatform();
	const executable = await discoverBrowserExecutable({
		platform,
		readEnv: readHostEnv,
		isExecutableFile: pathExists,
		listDirectoryNames: listHostDirectoryNames,
	});

	const profileDir = await makeTempProfileDir();
	const args = [
		...(options.headless ? ['--headless=new'] : []),
		'--remote-debugging-port=0',
		`--user-data-dir=${profileDir}`,
		...AUTOMATION_LAUNCH_FLAGS,
		...platformLaunchFlags(platform),
		'about:blank',
	];

	const child = spawnBrowserProcess(executable, args);
	const performShutdown = async (): Promise<void> => {
		child.kill();
		await child.exited.catch(() => undefined);
		await removeDirectory(profileDir);
		liveBrowserShutdowns.delete(shutdown);
	};
	// Memoized: concurrent callers (the session owner, the interrupt handler,
	// a re-raised interrupt) all await the same kill + profile removal instead
	// of racing, and the registry entry stays live until cleanup truly ends.
	let shutdownOutcome: Promise<void> | null = null;
	const shutdown = (): Promise<void> => {
		shutdownOutcome ??= performShutdown();
		return shutdownOutcome;
	};
	liveBrowserShutdowns.add(shutdown);

	try {
		const webSocketDebuggerUrl = await resolveDevToolsEndpoint(child, profileDir);
		return {
			webSocketDebuggerUrl,
			writeBinaryFile,
			shutdown,
			exited: child.exited.catch(() => undefined),
		};
	} catch (error) {
		await shutdown();
		throw error;
	}
}
