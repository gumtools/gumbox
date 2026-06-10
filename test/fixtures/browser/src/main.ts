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

// The counter button lets boxes prove page.click interactions plus the
// attribute and body-text assertions: clicking flips data-idle off, records
// the click count in data-clicks, and rewrites the button text.
const counter = document.querySelector('#counter');
if (counter) {
	let clicks = 0;
	counter.addEventListener('click', () => {
		clicks += 1;
		counter.textContent = `clicked ${clicks} times`;
		counter.removeAttribute('data-idle');
		counter.setAttribute('data-clicks', String(clicks));
	});
}

// `?noise=1` lets a box prove that console errors and failed network
// requests become receipt evidence without failing the happy-path boxes.
if (location.search.includes('noise=1')) {
	console.error('intentional console noise');
	// Port 9 (discard) is rejected by the browser as ERR_UNSAFE_PORT, which is
	// a deterministic failed network request without any external dependency.
	// The data-noise-settled flag lets a box wait (event-driven) until the
	// request has been rejected before asserting on failed-request evidence.
	fetch('http://127.0.0.1:9/unreachable').catch(() => {
		document.body.setAttribute('data-noise-settled', 'true');
	});
}
