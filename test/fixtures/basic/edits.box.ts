import { box } from 'gumbox';

function ensure(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

export const FileOperations = box(
	{ name: 'create, remove, and copy files', tags: ['project'] },
	async ({ project }) => {
		const created = await project.edit.create(
			'src/created-style.css',
			'.message { color: green; }\n',
		);
		ensure(created.files[0]?.change.kind === 'create', 'expected a create change summary');
		ensure(await project.exists('src/created-style.css'), 'expected the created file on disk');

		const removed = await project.edit.remove('src/server-only.ts');
		ensure(removed.files[0]?.change.kind === 'remove', 'expected a remove change summary');
		ensure(
			!(await project.exists('src/server-only.ts')),
			'expected the removed file to be gone',
		);

		const copied = await project.edit.copy('edits/message.after.ts', 'src/message.ts');
		ensure(copied.files[0]?.change.kind === 'copy', 'expected a copy change summary');
		const copyContents = await project.read('edits/message.after.ts');
		ensure(
			copyContents.includes('before edit'),
			'expected the copy to carry the source contents',
		);
	},
);

export const BatchEdit = box(
	{ name: 'batch edit touches multiple files', tags: ['project'] },
	async ({ project }) => {
		const change = await project.edit('swap message and add a note', {
			'src/message.ts': { replace: ['before edit', 'batch edit'] },
			'notes/batch.txt': { create: 'batch note\n' },
			'src/server-only.ts': { remove: true },
		});
		ensure(change.files.length === 3, `expected 3 edited files, saw ${change.files.length}`);
		ensure(
			(await project.read('src/message.ts')).includes('batch edit'),
			'expected the batched replace to apply',
		);
		ensure(await project.exists('notes/batch.txt'), 'expected the batched create to apply');
		ensure(
			!(await project.exists('src/server-only.ts')),
			'expected the batched remove to apply',
		);
	},
);
