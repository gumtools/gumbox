/**
 * Host boundary for the gumbox CLI. This is the one place (besides the
 * test-support adapter that re-exports it) allowed to adapt runtime APIs —
 * command line arguments, working directory, exit code, and filesystem —
 * into the injected capabilities the runtime-agnostic CLI core consumes.
 * Runtimes are detected through `globalThis` so no `node:*`, `Deno.*`, or
 * `Bun.*` identifier is referenced directly.
 */
import path from 'pathe';
import { createFileSystem } from '../filesystem.ts';
import type {
	FileSystemDirectoryEntry,
	GumboxFileSystem,
	GumboxFileSystemRuntime,
} from '../filesystem.ts';

type DenoRuntimeLike = {
	args?: string[];
	cwd?(): string;
	exitCode?: number;
	exit?(code?: number): never;
	addSignalListener?(signal: 'SIGINT', handler: () => void): void;
	readTextFile(filePath: string): Promise<string>;
	writeTextFile(filePath: string, data: string): Promise<void>;
	mkdir(filePath: string, options?: { recursive?: boolean }): Promise<void>;
	makeTempDir(options?: { dir?: string; prefix?: string; suffix?: string }): Promise<string>;
	realPath(filePath: string): Promise<string>;
	remove(filePath: string, options?: { recursive?: boolean }): Promise<void>;
	copyFile(from: string, to: string): Promise<void>;
	readDir(filePath: string): AsyncIterable<FileSystemDirectoryEntry>;
	stat(filePath: string): Promise<unknown>;
};

type HostProcessLike = {
	getBuiltinModule?(name: string): unknown;
	argv?: string[];
	cwd?(): string;
	exitCode?: number | string | null | undefined;
	exit?(code?: number): never;
	stdout?: { write(chunk: string, callback?: () => void): boolean };
	on?(event: 'SIGINT', listener: () => void): unknown;
};

type NodeDirectoryEntryLike = {
	name: string;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
};

type NodeFileSystemLike = {
	readFile(filePath: string, encoding: 'utf8'): Promise<string>;
	writeFile(filePath: string, data: string, encoding: 'utf8'): Promise<void>;
	mkdir(filePath: string, options?: { recursive?: boolean }): Promise<unknown>;
	mkdtemp(prefix: string): Promise<string>;
	realpath(filePath: string): Promise<string>;
	rm(filePath: string, options?: { recursive?: boolean }): Promise<void>;
	copyFile(from: string, to: string): Promise<void>;
	readdir(filePath: string, options: { withFileTypes: true }): Promise<NodeDirectoryEntryLike[]>;
	stat(filePath: string): Promise<unknown>;
};

function globalDeno(): DenoRuntimeLike | undefined {
	return (globalThis as typeof globalThis & { Deno?: DenoRuntimeLike })['Deno'];
}

function globalProcess(): HostProcessLike | undefined {
	return (globalThis as typeof globalThis & { process?: HostProcessLike })['process'];
}

function createDenoRuntime(runtime: DenoRuntimeLike): GumboxFileSystemRuntime {
	return {
		readTextFile: (filePath) => runtime.readTextFile(filePath),
		writeTextFile: (filePath, data) => runtime.writeTextFile(filePath, data),
		mkdir: (filePath, options) => runtime.mkdir(filePath, options),
		makeTempDirectory: (options) => runtime.makeTempDir(options),
		realPath: (filePath) => runtime.realPath(filePath),
		remove: (filePath, options) => runtime.remove(filePath, options),
		copyFile: (from, to) => runtime.copyFile(from, to),
		readDirectory: (filePath) => runtime.readDir(filePath),
		stat: (filePath) => runtime.stat(filePath),
	};
}

function createNodeRuntime(fileSystem: NodeFileSystemLike): GumboxFileSystemRuntime {
	return {
		readTextFile: (filePath) => fileSystem.readFile(filePath, 'utf8'),
		writeTextFile: (filePath, data) => fileSystem.writeFile(filePath, data, 'utf8'),
		mkdir: async (filePath, options) => {
			await fileSystem.mkdir(filePath, options);
		},
		makeTempDirectory: (options = {}) => {
			if (options.suffix !== undefined) {
				throw new Error(
					'makeTempDirectory({ suffix }) is not supported by this host runtime.',
				);
			}
			return fileSystem.mkdtemp(path.join(options.dir ?? '', options.prefix ?? ''));
		},
		realPath: (filePath) => fileSystem.realpath(filePath),
		remove: (filePath, options) => fileSystem.rm(filePath, options),
		copyFile: (from, to) => fileSystem.copyFile(from, to),
		readDirectory: async (filePath) => {
			const entries = await fileSystem.readdir(filePath, { withFileTypes: true });
			return entries.map((entry) => ({
				name: entry.name,
				isFile: entry.isFile(),
				isDirectory: entry.isDirectory(),
				isSymlink: entry.isSymbolicLink(),
			}));
		},
		stat: (filePath) => fileSystem.stat(filePath),
	};
}

function createHostRuntime(): GumboxFileSystemRuntime {
	const denoRuntime = globalDeno();
	if (denoRuntime !== undefined) {
		return createDenoRuntime(denoRuntime);
	}

	const fileSystemModule = globalProcess()?.getBuiltinModule?.('fs') as
		| { promises?: NodeFileSystemLike }
		| undefined;
	if (fileSystemModule?.promises !== undefined) {
		return createNodeRuntime(fileSystemModule.promises);
	}

	throw new Error('gumbox could not find a host filesystem on this runtime.');
}

export function createHostFileSystem(): GumboxFileSystem {
	return createFileSystem(createHostRuntime());
}

export function getHostCommandLineArgs(): string[] {
	const denoArgs = globalDeno()?.args;
	if (denoArgs !== undefined) {
		return [...denoArgs];
	}
	const nodeArgv = globalProcess()?.argv;
	if (nodeArgv !== undefined) {
		// argv[0] is the runtime binary and argv[1] is the script path.
		return nodeArgv.slice(2);
	}
	throw new Error('gumbox could not read command line arguments on this runtime.');
}

export function getHostWorkingDirectory(): string {
	const cwd = globalDeno()?.cwd ?? globalProcess()?.cwd;
	if (cwd !== undefined) {
		return cwd();
	}
	throw new Error('gumbox could not determine the working directory on this runtime.');
}

/**
 * Subscribes to the host interrupt signal (Ctrl-C). Registering a listener
 * replaces the runtime's default exit-on-interrupt, so the handler must end
 * the process itself. No-op on runtimes without a signal API. Deno is
 * preferred over the node-compat `process` so the handler registers once.
 */
export function onHostInterrupt(handler: () => void): void {
	const denoRuntime = globalDeno();
	if (denoRuntime?.addSignalListener !== undefined) {
		denoRuntime.addSignalListener('SIGINT', handler);
		return;
	}
	globalProcess()?.on?.('SIGINT', handler);
}

/**
 * Records the exit code without killing the event loop, so pending stdout
 * writes still flush before the runtime exits on its own. Both `Deno.exitCode`
 * and `process.exitCode` are set when present: under Deno, importing Vite
 * loads the node-compat layer, whose `process.exitCode` (default 0) wins over
 * `Deno.exitCode` at exit.
 */
export function setHostExitCode(code: number): void {
	const denoRuntime = globalDeno();
	const hostProcess = globalProcess();
	if (denoRuntime !== undefined) {
		denoRuntime.exitCode = code;
	}
	if (hostProcess !== undefined) {
		hostProcess.exitCode = code;
	}
	if (denoRuntime === undefined && hostProcess === undefined && code !== 0) {
		throw new Error(`gumbox exited with code ${code} on a runtime without exit codes.`);
	}
}

/**
 * Terminates the host process after the run. A project's dev pipeline can
 * leave runtime handles open past `server.close()` (nitro's dev workers do),
 * which would keep the event loop alive forever; the CLI's contract is to
 * exit with the run's code once the receipt is written and the report is
 * printed. Stdout is flushed first so piped output is never truncated, and
 * the exit code is also recorded for runtimes without an exit function.
 */
export async function exitHost(code: number): Promise<void> {
	setHostExitCode(code);
	const hostProcess = globalProcess();
	if (hostProcess?.stdout?.write !== undefined) {
		await new Promise<void>((resolve) => {
			hostProcess.stdout!.write('', () => resolve());
		});
	}
	const exit = globalDeno()?.exit ?? hostProcess?.exit;
	exit?.(code);
}
