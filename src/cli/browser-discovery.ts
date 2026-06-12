/**
 * Chromium-family browser discovery: a per-OS known-paths table, an explicit
 * `GUMBOX_BROWSER_PATH` override, and the playwright-managed browser cache as
 * a last-resort courtesy for projects migrating from the playwright-core era.
 * Pure logic — the caller injects environment reads, the executable-existence
 * probe, and the directory listing, so the tables and the fail-closed
 * behavior are unit-testable on any platform.
 */

export type BrowserPlatform = 'darwin' | 'linux' | 'windows';

export type ReadEnv = (name: string) => string | undefined;

/** Lists entry names of a directory; rejects when it does not exist. */
export type ListDirectoryNames = (dirPath: string) => Promise<string[]>;

export const BROWSER_EXECUTABLE_OVERRIDE_ENV = 'GUMBOX_BROWSER_PATH';

const MACOS_APP_BINARIES = [
	'Google Chrome.app/Contents/MacOS/Google Chrome',
	'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_BINARY_NAMES = [
	'google-chrome',
	'google-chrome-stable',
	'chromium',
	'chromium-browser',
	'microsoft-edge',
];

/** Application\<exe> suffixes appended to each Windows install root. */
const WINDOWS_BROWSER_SUFFIXES = [
	'Google\\Chrome\\Application\\chrome.exe',
	'Microsoft\\Edge\\Application\\msedge.exe',
];

function macosExecutables(readEnv: ReadEnv): string[] {
	const home = readEnv('HOME');
	const applicationDirs = ['/Applications'];
	if (home !== undefined && home !== '') {
		applicationDirs.push(`${home}/Applications`);
	}
	return applicationDirs.flatMap((dir) => MACOS_APP_BINARIES.map((binary) => `${dir}/${binary}`));
}

function linuxExecutables(readEnv: ReadEnv): string[] {
	const pathDirs = (readEnv('PATH') ?? '/usr/bin:/usr/local/bin')
		.split(':')
		.filter((dir) => dir !== '');
	const candidates = pathDirs.flatMap((dir) =>
		LINUX_BINARY_NAMES.map((name) => `${dir}/${name}`),
	);
	// Chrome's .deb/.rpm install location, reachable even when off PATH.
	candidates.push('/opt/google/chrome/chrome');
	return candidates;
}

function windowsExecutables(readEnv: ReadEnv): string[] {
	const installRoots = [
		readEnv('PROGRAMFILES') ?? 'C:\\Program Files',
		readEnv('PROGRAMFILES(X86)') ?? 'C:\\Program Files (x86)',
	];
	const localAppData = readEnv('LOCALAPPDATA');
	if (localAppData !== undefined && localAppData !== '') {
		installRoots.push(localAppData);
	}
	return installRoots.flatMap((root) =>
		WINDOWS_BROWSER_SUFFIXES.map((suffix) => `${root}\\${suffix}`),
	);
}

/** The ordered per-OS candidate table (Chrome before Edge before Chromium). */
export function knownBrowserExecutables(platform: BrowserPlatform, readEnv: ReadEnv): string[] {
	if (platform === 'darwin') {
		return macosExecutables(readEnv);
	}
	if (platform === 'linux') {
		return linuxExecutables(readEnv);
	}
	return windowsExecutables(readEnv);
}

/**
 * Binary locations inside one `chromium-<revision>` cache directory. Both mac
 * layouts are listed because only the layout matching the downloaded build
 * exists on disk — the existence probe picks the real one.
 */
const PLAYWRIGHT_CHROMIUM_BINARIES: Record<BrowserPlatform, string[]> = {
	darwin: [
		'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
		'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
	],
	linux: ['chrome-linux/chrome'],
	windows: ['chrome-win\\chrome.exe'],
};

function playwrightCacheRoot(platform: BrowserPlatform, readEnv: ReadEnv): string | null {
	if (platform === 'darwin') {
		const home = readEnv('HOME');
		if (home === undefined || home === '') {
			return null;
		}
		return `${home}/Library/Caches/ms-playwright`;
	}
	if (platform === 'linux') {
		const xdgCacheHome = readEnv('XDG_CACHE_HOME');
		if (xdgCacheHome !== undefined && xdgCacheHome !== '') {
			return `${xdgCacheHome}/ms-playwright`;
		}
		const home = readEnv('HOME');
		if (home === undefined || home === '') {
			return null;
		}
		return `${home}/.cache/ms-playwright`;
	}
	const localAppData = readEnv('LOCALAPPDATA');
	if (localAppData === undefined || localAppData === '') {
		return null;
	}
	return `${localAppData}\\ms-playwright`;
}

/**
 * Chromium executables inside playwright's managed browser cache, highest
 * revision first. Only full `chromium-<revision>` downloads qualify:
 * `chromium_headless_shell-*` cannot run headed, so it is not a full-feature
 * substitute and is skipped deliberately. A missing or unreadable cache
 * yields no candidates — this fallback never fails discovery on its own.
 */
export async function playwrightCacheExecutables(
	platform: BrowserPlatform,
	readEnv: ReadEnv,
	listDirectoryNames: ListDirectoryNames,
): Promise<string[]> {
	const cacheRoot = playwrightCacheRoot(platform, readEnv);
	if (cacheRoot === null) {
		return [];
	}
	const entryNames = await listDirectoryNames(cacheRoot).catch(() => [] as string[]);
	const revisions = entryNames
		.map((name) => /^chromium-(\d+)$/.exec(name))
		.filter((match) => match !== null)
		.map((match) => Number(match[1]))
		.sort((a, b) => b - a);
	const separator = platform === 'windows' ? '\\' : '/';
	return revisions.flatMap((revision) =>
		PLAYWRIGHT_CHROMIUM_BINARIES[platform].map(
			(binary) => `${cacheRoot}${separator}chromium-${revision}${separator}${binary}`,
		),
	);
}

/**
 * Resolves the browser executable to launch. An explicit
 * `GUMBOX_BROWSER_PATH` must exist or the discovery fails closed — a typo'd
 * override silently falling through to a different browser would make runs
 * unexplainable. Without an override, the first known system candidate that
 * exists wins, then playwright's managed cache is probed as a migration
 * courtesy; nothing existing fails closed naming what to install.
 */
export async function discoverBrowserExecutable(options: {
	platform: BrowserPlatform;
	readEnv: ReadEnv;
	isExecutableFile(filePath: string): Promise<boolean>;
	/** Optional: enables the playwright-cache fallback when provided. */
	listDirectoryNames?: ListDirectoryNames;
}): Promise<string> {
	const { platform, readEnv, isExecutableFile, listDirectoryNames } = options;

	const override = readEnv(BROWSER_EXECUTABLE_OVERRIDE_ENV);
	if (override !== undefined && override !== '') {
		if (await isExecutableFile(override)) {
			return override;
		}
		throw new Error(
			`${BROWSER_EXECUTABLE_OVERRIDE_ENV} points at '${override}', but no executable exists there.`,
		);
	}

	const candidates = knownBrowserExecutables(platform, readEnv);
	if (listDirectoryNames !== undefined) {
		const cached = await playwrightCacheExecutables(platform, readEnv, listDirectoryNames);
		candidates.push(...cached);
	}
	for (const candidate of candidates) {
		if (await isExecutableFile(candidate)) {
			return candidate;
		}
	}
	throw new Error(
		`gumbox could not find a Chromium-family browser to launch. ` +
			`Install Google Chrome, Microsoft Edge, or Chromium, or set ` +
			`${BROWSER_EXECUTABLE_OVERRIDE_ENV} to a Chromium-family executable. ` +
			`Paths checked: ${candidates.join(', ')}`,
	);
}
