#!/usr/bin/env node
/**
 * gumbox bin entry. Thin host shim: adapt argv/cwd/exit/filesystem through
 * the host boundary, then hand everything to the runtime-agnostic CLI core.
 */
import { restorePendingEdits } from '../runner.ts';
import { createHostBrowser } from './browser-host.ts';
import { shutdownLiveBrowserSessions } from './browser-launch.ts';
import {
	createHostFileSystem,
	exitHost,
	getHostCommandLineArgs,
	getHostWorkingDirectory,
	hostSupportsColor,
	onHostInterrupt,
} from './host.ts';
import { runCli } from './run-cli.ts';

// Ctrl-C must not orphan browsers or strand box edits on disk: kill every
// live browser session (process + temp profile) first, restore everything
// still pending, then exit with the conventional interrupt code. Single
// flight: the signal can arrive more than once (vite re-raises it after its
// own teardown), and a repeat must not exit before the first pass finishes.
let interruptCleanup: Promise<void> | null = null;
onHostInterrupt(() => {
	interruptCleanup ??= shutdownLiveBrowserSessions().then(() => restorePendingEdits());
	void interruptCleanup.finally(() => exitHost(130));
});

const exitCode = await runCli(getHostCommandLineArgs(), {
	cwd: getHostWorkingDirectory(),
	fileSystem: createHostFileSystem(),
	// Lazy adapter: discovery and launch only happen when a box asks for a browser.
	browser: createHostBrowser(),
	stdout: (line) => console.log(line),
	stderr: (line) => console.error(line),
	colors: hostSupportsColor(),
});
// Pooled browser processes outlive every box on purpose; dispose them now
// that the run is over (kill + temp profile removal).
await shutdownLiveBrowserSessions();
// Force the exit: fixture pipelines may leak open handles past server.close().
await exitHost(exitCode);
