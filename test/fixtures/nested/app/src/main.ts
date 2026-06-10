import { message } from './message';

function render(value: string): void {
	const target = document.querySelector('#message');
	if (target) {
		target.textContent = value;
	}
}

render(message);

if (import.meta.hot) {
	// Accepting './message' makes edits to it an HMR update, not a full reload.
	import.meta.hot.accept('./message', (updated) => {
		if (updated) {
			render(updated.message as string);
		}
	});
}
