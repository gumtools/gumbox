#!/usr/bin/env node
/**
 * gumbox bin entry. Thin host shim: adapt argv/cwd/exit/filesystem through
 * the host boundary, then hand everything to the runtime-agnostic CLI core.
 */
import { restorePendingEdits } from '../runner.ts';
import { createHostBrowser } from './browser-host.ts';
import {
	createHostFileSystem,
	exitHost,
	getHostCommandLineArgs,
	getHostWorkingDirectory,
} from './host.ts';
import { onHostInterrupt } from './host.ts';
import { runCli } from './run-cli.ts';

// Ctrl-C must not strand box edits on disk: restore everything still pending,
// then exit with the conventional interrupt code.
onHostInterrupt(() => {
	void restorePendingEdits().finally(() => exitHost(130));
});

const exitCode = await runCli(getHostCommandLineArgs(), {
	cwd: getHostWorkingDirectory(),
	fileSystem: createHostFileSystem(),
	// Lazy adapter: playwright-core is only imported when a box launches a browser.
	browser: createHostBrowser(),
	stdout: (line) => console.log(line),
	stderr: (line) => console.error(line),
});
// Force the exit: fixture pipelines may leak open handles past server.close().
await exitHost(exitCode);
