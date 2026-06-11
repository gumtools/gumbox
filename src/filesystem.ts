import path from 'pathe';

export type FileSystemDirectoryEntry = {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymlink: boolean;
};

export type GumboxFileSystemRuntime = {
	readTextFile(filePath: string): Promise<string>;
	writeTextFile(filePath: string, data: string): Promise<void>;
	mkdir(filePath: string, options?: { recursive?: boolean }): Promise<void>;
	makeTempDirectory(options?: {
		dir?: string;
		prefix?: string;
		suffix?: string;
	}): Promise<string>;
	realPath(filePath: string): Promise<string>;
	remove(filePath: string, options?: { recursive?: boolean }): Promise<void>;
	copyFile(from: string, to: string): Promise<void>;
	readDirectory(
		filePath: string,
	):
		| AsyncIterable<FileSystemDirectoryEntry>
		| Iterable<FileSystemDirectoryEntry>
		| Promise<AsyncIterable<FileSystemDirectoryEntry> | Iterable<FileSystemDirectoryEntry>>;
	stat(filePath: string): Promise<unknown>;
};

export type GumboxFileSystem = {
	readTextFile(filePath: string): Promise<string>;
	writeTextFile(filePath: string, data: string): Promise<void>;
	mkdir(filePath: string, options?: { recursive?: boolean }): Promise<void>;
	makeTempDirectory(options?: {
		dir?: string;
		prefix?: string;
		suffix?: string;
	}): Promise<string>;
	realPath(filePath: string): Promise<string>;
	remove(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	copyDirectory(from: string, to: string): Promise<void>;
	exists(filePath: string): Promise<boolean>;
	fileSize(filePath: string): Promise<number>;
};

export function isPathAlreadyExistsError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	const { code, name } = error as { code?: unknown; name?: unknown };
	return code === 'EEXIST' || name === 'AlreadyExists';
}

export function isPathNotFoundError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	const { code, name } = error as { code?: unknown; name?: unknown };
	return code === 'ENOENT' || name === 'NotFound';
}

export function createFileSystem(runtime: GumboxFileSystemRuntime): GumboxFileSystem {
	const exists = async (filePath: string): Promise<boolean> => {
		try {
			await runtime.stat(filePath);
			return true;
		} catch (error) {
			if (isPathNotFoundError(error)) {
				return false;
			}
			throw error;
		}
	};

	const remove = async (
		filePath: string,
		options: { recursive?: boolean; force?: boolean } = {},
	): Promise<void> => {
		try {
			// Node's fs.rm rejects a literal `recursive: undefined`; always
			// pass a boolean.
			await runtime.remove(filePath, { recursive: options.recursive === true });
		} catch (error) {
			if (options.force === true && isPathNotFoundError(error)) {
				return;
			}
			throw error;
		}
	};

	const copyDirectory = async (from: string, to: string): Promise<void> => {
		await runtime.mkdir(to, { recursive: true });
		for await (const entry of await runtime.readDirectory(from)) {
			const source = path.join(from, entry.name);
			const target = path.join(to, entry.name);
			if (entry.isDirectory) {
				await copyDirectory(source, target);
				continue;
			}
			if (entry.isFile) {
				await runtime.copyFile(source, target);
				continue;
			}
			if (entry.isSymlink) {
				throw new Error(`copyDirectory('${from}', '${to}') does not support symlinks yet.`);
			}
		}
	};

	const fileSize = async (filePath: string): Promise<number> => {
		// Both Deno.stat and node fs.stat results expose a numeric `size`.
		const stats = (await runtime.stat(filePath)) as { size?: unknown };
		return typeof stats.size === 'number' ? stats.size : 0;
	};

	return {
		readTextFile: (filePath) => runtime.readTextFile(filePath),
		writeTextFile: (filePath, data) => runtime.writeTextFile(filePath, data),
		mkdir: (filePath, options) => runtime.mkdir(filePath, options),
		makeTempDirectory: (options) => runtime.makeTempDirectory(options),
		realPath: (filePath) => runtime.realPath(filePath),
		remove,
		copyDirectory,
		exists,
		fileSize,
	};
}
