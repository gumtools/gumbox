import path from 'pathe';
import { createFileSystem } from '../../src/filesystem.ts';
import type {
	FileSystemDirectoryEntry,
	GumboxFileSystem,
	GumboxFileSystemRuntime,
} from '../../src/filesystem.ts';

type DenoRuntimeLike = {
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
	const denoRuntime = (
		globalThis as typeof globalThis & {
			Deno?: DenoRuntimeLike;
		}
	)['Deno'];
	if (denoRuntime !== undefined) {
		return createDenoRuntime(denoRuntime);
	}

	const hostProcess = (
		globalThis as typeof globalThis & {
			process?: HostProcessLike;
		}
	)['process'];
	const fileSystemModule = hostProcess?.getBuiltinModule?.('fs') as
		| { promises?: NodeFileSystemLike }
		| undefined;
	if (fileSystemModule?.promises !== undefined) {
		return createNodeRuntime(fileSystemModule.promises);
	}

	throw new Error('The Gumbox test harness could not find a host filesystem.');
}

export const fileSystem: GumboxFileSystem = createFileSystem(createHostRuntime());
