import path from 'pathe';
import type { EvidenceStore } from './evidence.ts';
import type { GumboxFileSystem } from './filesystem.ts';
import type { EditChange, EditReceipt, ProjectApi } from './types.ts';

export type ProjectRuntime = {
	project: ProjectApi;
	edits: EditReceipt[];
	/** Restores every edited file to its original content. Returns how many restores failed. */
	restoreAll(): Promise<{ failed: number }>;
};

export function createProjectApi(options: {
	root: string;
	fileSystem: GumboxFileSystem;
	store: EvidenceStore;
	onTimeline(type: string, detail: Record<string, unknown>): void;
}): ProjectRuntime {
	const { root, fileSystem, store, onTimeline } = options;
	const edits: EditReceipt[] = [];
	const originals = new Map<string, string>();

	const resolveProjectPath = (relativePath: string): string => {
		const absolutePath = path.resolve(root, relativePath);
		const relative = path.relative(root, absolutePath);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error(
				`project paths must stay inside the Vite root (${root}); received '${relativePath}'.`,
			);
		}
		return absolutePath;
	};

	const applyChange = (
		relativePath: string,
		before: string,
		change: EditChange,
	): { after: string; summary: EditReceipt['change'] } => {
		if (typeof change === 'function') {
			const after = change(before);
			if (typeof after !== 'string') {
				throw new Error(
					`project.edit('${relativePath}', fn) must return the new file contents as a string.`,
				);
			}
			return { after, summary: { kind: 'function' } };
		}
		if (
			typeof change === 'object' &&
			change !== null &&
			Array.isArray(change.replace) &&
			change.replace.length === 2
		) {
			const [from, to] = change.replace;
			const found = typeof from === 'string' ? before.includes(from) : from.test(before);
			if (!found) {
				const wanted = typeof from === 'string' ? JSON.stringify(from) : String(from);
				throw new Error(
					`project.edit('${relativePath}') could not find ${wanted} in the file, so the edit has nothing to change. Update the box or the project file.`,
				);
			}
			return {
				after: before.replace(from, to),
				summary: { kind: 'replace', from: String(from), to },
			};
		}
		throw new Error(
			`project.edit('${relativePath}') received an unsupported change. Use { replace: [from, to] } or a (code) => string function; create/remove/copy/config edits ship in a later Gumbox slice.`,
		);
	};

	const edit = async (relativePath: string, change: EditChange): Promise<EditReceipt> => {
		const absolutePath = resolveProjectPath(relativePath);
		let before: string;
		try {
			before = await fileSystem.readTextFile(absolutePath);
		} catch {
			throw new Error(
				`project.edit('${relativePath}') failed: the file does not exist under ${root}.`,
			);
		}
		const { after, summary } = applyChange(relativePath, before, change);
		if (after === before) {
			throw new Error(
				`project.edit('${relativePath}') produced no change, so Vite would have nothing to react to.`,
			);
		}
		// Mark the evidence sequence before writing so every watcher-driven
		// event caused by this write sorts after the marker.
		const marker = store.record({ kind: 'file-edit', file: absolutePath });
		if (!originals.has(absolutePath)) {
			originals.set(absolutePath, before);
		}
		await fileSystem.writeTextFile(absolutePath, after);
		const receipt: EditReceipt = {
			id: `edit-${edits.length + 1}`,
			file: path.relative(root, absolutePath).split(path.sep).join('/'),
			absolutePath,
			before,
			after,
			change: summary,
			seq: marker.seq,
			at: marker.at,
			restored: null,
		};
		edits.push(receipt);
		onTimeline('file edited', { file: receipt.file, editId: receipt.id });
		return receipt;
	};

	const read = async (relativePath: string): Promise<string> => {
		return await fileSystem.readTextFile(resolveProjectPath(relativePath));
	};

	const exists = async (relativePath: string): Promise<boolean> => {
		return await fileSystem.exists(resolveProjectPath(relativePath));
	};

	const restoreAll = async (): Promise<{ failed: number }> => {
		let failed = 0;
		for (const [absolutePath, original] of originals) {
			const fileEdits = edits.filter((entry) => entry.absolutePath === absolutePath);
			const relativeFile = path.relative(root, absolutePath).split(path.sep).join('/');
			try {
				await fileSystem.writeTextFile(absolutePath, original);
				for (const entry of fileEdits) {
					entry.restored = true;
				}
				onTimeline('file restored', { file: relativeFile });
			} catch (error) {
				failed += 1;
				const message = error instanceof Error ? error.message : String(error);
				for (const entry of fileEdits) {
					entry.restored = false;
					entry.restoreError = message;
				}
				onTimeline('file restore failed', { file: relativeFile, error: message });
			}
		}
		originals.clear();
		return { failed };
	};

	return {
		project: { edit, read, exists },
		edits,
		restoreAll,
	};
}
