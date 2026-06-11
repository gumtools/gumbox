/**
 * Generates the npm-consumption manifest (package.json) at the repo root from
 * deno.json, which is the canonical workspace/package manifest. The generated
 * package.json is gitignored build output: it only exists so package managers
 * (for example pnpm with `"gumbox": "link:../gumbox"`) can resolve this
 * package and its dist build + CLI bin.
 *
 * This is a host-side Deno tool. It lives outside src/ and test/ on purpose:
 * the runtime-agnostic rule forbids Deno.* in library code, while scripts/ is
 * an explicit host boundary. Run it with `deno task manifest`.
 *
 * Dependency posture: the manifest intentionally lists NO dependencies. The
 * dist build externalizes mitt/pathe/tinyglobby (+ lazy playwright-core),
 * and Node resolves those through gumbox's own node_modules (populated by
 * `deno install`) because module resolution follows the link's real path.
 * Only the vite peer range is declared, taken from deno.json imports.
 */

type DenoManifest = {
	name?: string;
	version?: string;
	imports?: Record<string, string>;
};

function requireField(value: string | undefined, field: string): string {
	if (value === undefined || value.length === 0) {
		throw new Error(`deno.json is missing '${field}', cannot generate package.json.`);
	}
	return value;
}

// Consumers bring their own vite (gumbox drives the project's copy at
// runtime — see src/vite-loader.ts). The workspace itself gets vite through
// vite-plus, so the peer range is declared here rather than derived from a
// direct dependency.
const vitePeerRange = '^8.0.0';

const repoRoot = new URL('..', import.meta.url);
const denoManifest = JSON.parse(
	await Deno.readTextFile(new URL('deno.json', repoRoot)),
) as DenoManifest;

const packageManifest = {
	'//': 'generated from deno.json by scripts/generate-package-json.ts — do not edit, do not commit',
	name: requireField(denoManifest.name, 'name'),
	version: requireField(denoManifest.version, 'version'),
	type: 'module',
	files: ['dist'],
	exports: {
		'.': {
			types: './dist/index.d.mts',
			default: './dist/index.mjs',
		},
		'./cli': './dist/cli/gumbox.mjs',
	},
	bin: {
		gumbox: './dist/cli/gumbox.mjs',
	},
	peerDependencies: {
		vite: vitePeerRange,
	},
};

await Deno.writeTextFile(
	new URL('package.json', repoRoot),
	`${JSON.stringify(packageManifest, null, '\t')}\n`,
);
console.log(`generated package.json for ${packageManifest.name}@${packageManifest.version}`);
