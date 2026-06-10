import { box } from 'gumbox';

// page.click is the minimal interaction primitive: it lets a box reach a
// user-made UI state (for example a counter at a known count) before an edit,
// so HMR state-preservation scenarios are expressible. Every click is receipt
// evidence; assertions stay in expect.page.*.
export default box(
	{ name: 'counter clicks update page state', modes: ['dev'] },
	async ({ browser, expect }) => {
		const page = await browser.visit('/');

		await expect.page.attribute(page, '#counter', 'data-idle');
		await expect.page.attribute(page, '#counter', 'data-idle', 'true');
		await expect.page.containsText(page, 'clicked 0 times');

		await page.click('#counter');
		await page.click('#counter');

		await expect.page.noAttribute(page, '#counter', 'data-idle');
		await expect.page.attribute(page, '#counter', 'data-clicks', '2');
		await expect.page.containsText(page, 'clicked 2 times');
		await expect.page.notContainsText(page, 'clicked 0 times');
		await expect.page.noFailedRequests(page);
	},
);

export const StaleTextFails = box(
	{ name: 'notContainsText fails while the text is still present', modes: ['dev'] },
	async ({ browser, expect }) => {
		const page = await browser.visit('/');

		await expect.page.containsText(page, 'clicked 0 times');
		// This must fail: nothing removes the initial counter text.
		await expect.page.notContainsText(page, 'clicked 0 times', { timeoutMs: 1500 });
	},
);

export const FailedRequestFails = box(
	{ name: 'noFailedRequests fails after a failed page request', modes: ['dev'] },
	async ({ browser, expect }) => {
		const page = await browser.visit('/?noise=1');

		// Event-driven settle: the page flags the body once the doomed request
		// has been rejected, so the failed-request evidence exists before the
		// assertion runs.
		await expect.page.attribute(page, 'body', 'data-noise-settled', 'true');
		// This must fail: the noise page made a request the browser rejected.
		await expect.page.noFailedRequests(page);
	},
);
