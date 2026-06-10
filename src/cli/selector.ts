import path from 'pathe';
import { glob } from 'tinyglobby';
import type { DiscoveredBox, InvalidBoxFile } from '../types.ts';

const GLOB_MAGIC_PATTERN = /[*?[\]{}]/;

export function isGlobSelector(selector: string): boolean {
	return GLOB_MAGIC_PATTERN.test(selector);
}

function normalizeSelectorPath(selector: string): string {
	return selector.replaceAll('\\', '/').replace(/^\.\//, '');
}

function fileBasenames(relativeFile: string): string[] {
	const fullBasename = relativeFile.split('/').pop() ?? relativeFile;
	const shortBasename = fullBasename.replace(/\.box\.tsx?$/, '');
	return [fullBasename, shortBasename];
}

/**
 * Matches a selector against a box file location: exact relative path, exact
 * resolved path, full basename (`hmr.box.ts`), or short basename (`hmr`).
 */
export function matchesFileSelector(args: {
	file: string;
	relativeFile: string;
	selector: string;
	root: string;
}): boolean {
	const { file, relativeFile, selector, root } = args;
	const normalizedSelector = normalizeSelectorPath(selector);
	if (relativeFile === normalizedSelector) {
		return true;
	}
	if (path.resolve(root, normalizedSelector) === file) {
		return true;
	}
	return fileBasenames(relativeFile).includes(selector);
}

/**
 * Matches a selector against one discovered box the way a developer expects
 * from tools like Vitest: file path, file basename, tag, or box name
 * (case-insensitive substring). Globs are resolved separately because they
 * need the filesystem.
 */
export function matchesBoxSelector(box: DiscoveredBox, selector: string, root: string): boolean {
	const matchesFile = matchesFileSelector({
		file: box.file,
		relativeFile: box.relativeFile,
		selector,
		root,
	});
	if (matchesFile) {
		return true;
	}
	if (box.box.tags.includes(selector)) {
		return true;
	}
	return box.box.name.toLowerCase().includes(selector.toLowerCase());
}

export type SelectorMatches = {
	boxes: DiscoveredBox[];
	/**
	 * Invalid box files the selector points at, so a selector naming a broken
	 * file surfaces its load error instead of a bare "no match".
	 */
	invalid: InvalidBoxFile[];
};

export async function resolveSelector(args: {
	selector: string;
	root: string;
	boxes: DiscoveredBox[];
	invalid: InvalidBoxFile[];
}): Promise<SelectorMatches> {
	const { selector, root, boxes, invalid } = args;
	if (isGlobSelector(selector)) {
		const matchedFiles = new Set(
			await glob(normalizeSelectorPath(selector), { cwd: root, absolute: true, dot: true }),
		);
		return {
			boxes: boxes.filter((box) => matchedFiles.has(box.file)),
			invalid: invalid.filter((file) => matchedFiles.has(file.file)),
		};
	}
	return {
		boxes: boxes.filter((box) => matchesBoxSelector(box, selector, root)),
		invalid: invalid.filter((file) =>
			matchesFileSelector({
				file: file.file,
				relativeFile: file.relativeFile,
				selector,
				root,
			}),
		),
	};
}
