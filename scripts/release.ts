/**
 * Local release flow for gumbox, run with `deno task release`:
 *
 *   1. preflight — on main, no modified tracked files, tests pass
 *   2. bump the version in deno.json (bumpp's interactive picker)
 *   3. regenerate package.json from deno.json (deno task manifest)
 *   4. commit `chore: release vX.Y.Z` and tag vX.Y.Z
 *   5. build dist and `npm publish`
 *   6. push main + tag, then create the GitHub release (gh CLI) with
 *      changelogen's conventional-commit notes
 *
 * There is no committed CHANGELOG.md: the GitHub release is the changelog
 * surface. Nothing touches the remote until the npm publish succeeds. Auth
 * is interactive on purpose: npm prompts during publish and gh uses its own
 * login — the release flow never reads or stores tokens.
 *
 * `--dry-run` stops before the release commit: it bumps, builds, previews
 * the release notes, and runs `npm publish --dry-run`, leaving the bumped
 * deno.json behind for inspection. Any other arguments are forwarded to
 * bumpp (for example `--release patch --yes` for a non-interactive bump).
 *
 * This is a host-side Deno tool. It lives in scripts/ on purpose: the
 * runtime-agnostic rule forbids Deno.* in library code, while scripts/ is an
 * explicit host boundary.
 */

const BUMPP = 'npm:bumpp@11.1.0';
const CHANGELOGEN = 'npm:changelogen@0.6.2';

const isDryRun = Deno.args.includes('--dry-run');
const bumppArgs = Deno.args.filter((argument) => argument !== '--dry-run');

async function main(): Promise<void> {
	await preflight();

	await step('bump version in deno.json', [
		'deno',
		'run',
		'-A',
		BUMPP,
		'deno.json',
		'--no-commit',
		'--no-tag',
		'--no-push',
		...bumppArgs,
	]);
	const version = await readReleasedVersion();
	const tag = `v${version}`;

	await step('regenerate package.json', ['deno', 'task', 'manifest']);
	await step('build dist', ['deno', 'task', 'build']);

	if (isDryRun) {
		console.log(`\nrelease notes preview for ${tag}:\n`);
		console.log(await releaseNotes(version));
		await step('npm publish (dry run)', ['npm', 'publish', '--dry-run']);
		console.log(`\ndry run complete: ${tag} was not committed, tagged, or published.`);
		console.log('inspect the bump, then undo with: git restore deno.json');
		return;
	}

	await step(`stage release of ${tag}`, ['git', 'add', 'deno.json']);
	await step(`commit ${tag}`, ['git', 'commit', '-m', `chore: release ${tag}`]);
	await step(`tag ${tag}`, ['git', 'tag', '-a', tag, '-m', tag]);

	try {
		await step('npm publish', ['npm', 'publish']);
		await step('push main and tag', ['git', 'push', 'origin', 'main', tag]);
		await createGithubRelease(tag, version);
	} catch (error) {
		console.error(`\nrelease ${tag} is committed and tagged locally but did not finish.`);
		console.error('finish the remaining steps by hand, or roll back with:');
		console.error(`  git tag -d ${tag} && git reset --hard HEAD~1`);
		throw error;
	}

	console.log(`\nreleased gumbox ${tag} 🎉`);
}

/** Refuses to release from a branch, a dirty tree, or a failing test suite. */
async function preflight(): Promise<void> {
	const branch = await capture(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
	if (branch !== 'main') {
		throw new Error(`releases ship from main; currently on '${branch}'.`);
	}

	// Untracked scratch files are fine; modified tracked files would leak
	// unreviewed changes into the release commit.
	const trackedChanges = await capture(['git', 'status', '--porcelain', '--untracked-files=no']);
	if (trackedChanges !== '') {
		throw new Error(
			`tracked files have local changes; commit or stash them first:\n${trackedChanges}`,
		);
	}

	await step('run tests', ['deno', 'task', 'test']);
}

/** Reads the version bumpp just wrote, keeping deno.json the only source. */
async function readReleasedVersion(): Promise<string> {
	const manifest = JSON.parse(await Deno.readTextFile('deno.json')) as { version?: string };
	if (manifest.version === undefined || manifest.version === '') {
		throw new Error('deno.json has no version after the bump.');
	}
	return manifest.version;
}

/** Conventional-commit release notes since the previous release (changelogen). */
async function releaseNotes(version: string): Promise<string> {
	const from = await previousReleaseRef(version);
	return capture(['deno', 'run', '-A', CHANGELOGEN, '-r', version, '--from', from]);
}

/**
 * The previous release tag, or the first commit when this is the first
 * release. changelogen's own "last tag" guess cannot be trusted here: by the
 * time notes are generated this release's tag already exists at HEAD, so the
 * default range would be empty.
 */
async function previousReleaseRef(version: string): Promise<string> {
	const tags = await capture(['git', 'tag', '-l', 'v*', '--sort=-v:refname']);
	const previousTag = tags.split('\n').find((tag) => tag !== '' && tag !== `v${version}`);
	if (previousTag !== undefined) {
		return previousTag;
	}
	return capture(['git', 'rev-list', '--max-parents=0', 'HEAD']);
}

/**
 * Publishes the changelogen notes as a GitHub release through the gh CLI,
 * which owns its own authentication.
 */
async function createGithubRelease(tag: string, version: string): Promise<void> {
	const notes = await releaseNotes(version);
	const notesFile = await Deno.makeTempFile({ suffix: '.md' });
	try {
		await Deno.writeTextFile(notesFile, notes);
		await step(`create GitHub release ${tag}`, [
			'gh',
			'release',
			'create',
			tag,
			'--title',
			tag,
			'--notes-file',
			notesFile,
		]);
	} finally {
		await Deno.remove(notesFile);
	}
}

/** Runs one release step attached to the terminal so prompts stay usable. */
async function step(label: string, command: string[]): Promise<void> {
	console.log(`\n→ ${label}`);
	const [executable, ...args] = command;
	const status = await new Deno.Command(executable, {
		args,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	}).output();
	if (!status.success) {
		throw new Error(`step failed: ${label} (${command.join(' ')})`);
	}
}

async function capture(command: string[]): Promise<string> {
	const [executable, ...args] = command;
	const result = await new Deno.Command(executable, { args }).output();
	if (!result.success) {
		throw new Error(
			`command failed: ${command.join(' ')}\n${new TextDecoder().decode(result.stderr)}`,
		);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

await main();
