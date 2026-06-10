import { box } from 'gumbox';

// Simulates a run interrupted mid-box: the edit lands on disk and the box
// never finishes on its own, so the per-box restoration in the runner's
// finally is never reached. The emergency restore path must put the file
// back without waiting for the box.
export default box('hangs after editing', async ({ project }) => {
	await project.edit('data.txt', {
		replace: ['original contents', 'edited contents'],
	});
	await new Promise<never>(() => {
		// Intentionally never resolves; only an interrupt ends this box.
	});
});
