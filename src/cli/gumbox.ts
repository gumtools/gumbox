#!/usr/bin/env node
/**
 * gumbox bin entry. Thin host shim: adapt argv/cwd/exit/filesystem through
 * the host boundary, then hand everything to the runtime-agnostic CLI core.
 */
import {
	createHostFileSystem,
	getHostCommandLineArgs,
	getHostWorkingDirectory,
	setHostExitCode,
} from './host.ts';
import { runCli } from './run-cli.ts';

const exitCode = await runCli(getHostCommandLineArgs(), {
	cwd: getHostWorkingDirectory(),
	fileSystem: createHostFileSystem(),
	stdout: (line) => console.log(line),
	stderr: (line) => console.error(line),
});
setHostExitCode(exitCode);
