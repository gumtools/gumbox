import { box } from 'gumbox';

export default box('intentionally failing box', async ({ project }) => {
	await project.edit('src/message.ts', {
		replace: ['before edit', 'broken edit'],
	});
	throw new Error('intentional failure to prove restoration');
});
