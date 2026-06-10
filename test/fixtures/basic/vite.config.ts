// This config intentionally avoids importing 'vite' so the fixture can be
// copied to a temp directory (with no node_modules) and still load.

/**
 * Emulates frameworks (for example qwik) that replace Vite's standard
 * 'update' payload with their own custom hot protocol: edits to
 * custom-message.ts broadcast a 'fixture:hmr' custom payload and suppress
 * Vite's default propagation by returning an empty module list.
 */
const customHotProtocolPlugin = {
	name: 'fixture:custom-hot-protocol',
	hotUpdate(context) {
		if (!context.file.endsWith('custom-message.ts')) {
			return undefined;
		}
		this.environment.hot.send({
			type: 'custom',
			event: 'fixture:hmr',
			data: { file: context.file, t: Date.now() },
		});
		return [];
	},
};

export default {
	define: {
		// The restart box replaces this marker to prove that a config-file
		// edit restarts the dev server.
		__GUMBOX_CONFIG_MARKER__: JSON.stringify('marker-before'),
	},
	plugins: [customHotProtocolPlugin],
	environments: {
		// One extra server-runnable environment so environment isolation is testable.
		ssr: {},
	},
};
