import { message } from './message';

const target = document.querySelector('#message');
if (target) {
	target.textContent = message;
}

// `?events=1` lets a box prove that tracked custom DOM events become receipt
// evidence: the page dispatches `fixture:ping` on a steady interval so an
// event-driven wait for "at least N events" always settles.
if (location.search.includes('events=1')) {
	let tick = 0;
	setInterval(() => {
		tick += 1;
		document.dispatchEvent(new CustomEvent('fixture:ping', { detail: { tick } }));
	}, 100);
}

// `?noise=1` lets a box prove that console errors and failed network
// requests become receipt evidence without failing the happy-path boxes.
if (location.search.includes('noise=1')) {
	console.error('intentional console noise');
	// Port 9 (discard) is rejected by the browser as ERR_UNSAFE_PORT, which is
	// a deterministic failed network request without any external dependency.
	fetch('http://127.0.0.1:9/unreachable').catch(() => {});
}
