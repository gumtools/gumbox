import { box } from 'gumbox';

/**
 * The canonical contested case: every assertion passes, yet the page threw an
 * uncaught error and a network request failed. The box must stay green while
 * the client and driver witnesses contradict in the receipt.
 */
export default box(
	{ name: 'uncaught page error stays evidence on a passing box', modes: ['dev'] },
	async ({ browser, expect }) => {
		const page = await browser.visit('/?boom=1');

		// Event-driven settle points: both flags appear only after the uncaught
		// throw and the rejected request happened in the page.
		await expect.page.attribute(page, 'body', 'data-boom-thrown', 'true');
		await expect.page.attribute(page, 'body', 'data-boom-request-settled', 'true');
		await expect.page.text(page, '#message', 'hello from the browser fixture');
	},
);
