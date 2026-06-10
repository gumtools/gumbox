import type { InlineConfig, ViteDevServer } from 'vite';
import type { GumboxBrowser, PageHandle } from './browser.ts';
import type { GumboxFileSystem } from './filesystem.ts';

/**
 * Options accepted by `box(options, run)`.
 */
export type BoxOptions = {
	name: string;
	tags?: string[];
	modes?: Array<'dev' | 'build' | 'preview' | (string & Record<never, never>)>;
	ui?: boolean;
};

export type BoxRunFn = (context: BoxContext) => Promise<void> | void;

/**
 * The value returned by `box(...)`. Recognized across module instances via a
 * `Symbol.for` brand, so box files loaded through a Vite module runner still
 * count as boxes.
 */
export type BoxDefinition = {
	readonly name: string;
	readonly tags: readonly string[];
	readonly modes: readonly string[];
	readonly ui: boolean;
	readonly run: BoxRunFn;
};

/**
 * The exact six-key context passed to a box run function.
 */
export type BoxContext = {
	environment: EnvironmentApi;
	browser: BrowserEnvironmentAlias;
	project: ProjectApi;
	pipeline: PipelineApi;
	expect: ExpectApi;
	receipt: ReceiptApi;
};

export type EnvironmentFetchInit = {
	headers?: Record<string, string>;
};

/**
 * Structured response evidence from `environment.<name>.fetch(path)`. Unlike
 * `request(path)` it never throws on a non-OK status: status, content type,
 * and headers are evidence a box asserts with `expect.response.matches`.
 */
export type EnvironmentResponse = {
	readonly environment: string;
	readonly path: string;
	readonly url: string;
	readonly status: number;
	readonly ok: boolean;
	/** Lowercased content-type header value, or null when absent. */
	readonly contentType: string | null;
	readonly headers: Record<string, string>;
	readonly text: string;
};

export type EnvironmentHandle = {
	readonly name: string;
	readonly kind: 'browser' | 'server';
	/** Fetch a path. Available for the browser environment (over HTTP) and fetchable environments. */
	request(path: string): Promise<string>;
	/**
	 * Fetch a path and keep the full response as evidence (status, content
	 * type, headers, body). Available for the browser environment (over HTTP)
	 * and fetchable environments.
	 */
	fetch(path: string, init?: EnvironmentFetchInit): Promise<EnvironmentResponse>;
	/** Import a module id through the environment's module runner. Runnable environments only. */
	import<T = Record<string, unknown>>(id: string): Promise<T>;
	/** Visit a route through a real browser. Browser-capable environments only. */
	visit?(path: string): Promise<PageHandle>;
};

export type BrowserEnvironmentAlias = EnvironmentHandle & {
	visit(path: string): Promise<PageHandle>;
};

export type EnvironmentApi = Record<string, EnvironmentHandle>;

export type EditChange =
	| { replace: [from: string | RegExp, to: string] }
	| ((code: string) => string)
	| { create: string }
	| { remove: true }
	| { copyFrom: string };

export type EditChangeSummary =
	| { kind: 'replace'; from: string; to: string }
	| { kind: 'function' }
	| { kind: 'create' }
	| { kind: 'remove' }
	| { kind: 'copy'; from: string };

export type EditedFile = {
	/** Path relative to the Vite root. */
	readonly file: string;
	readonly absolutePath: string;
	/** null when the edit created the file. */
	readonly before: string | null;
	/** null when the edit removed the file. */
	readonly after: string | null;
	readonly change: EditChangeSummary;
	restored: boolean | null;
	restoreError?: string;
};

export type EditReceipt = {
	readonly id: string;
	/** The relative file path for single-file edits, or the batch label. */
	readonly file: string;
	readonly files: EditedFile[];
	/** Evidence sequence marker; events after this sequence can be caused by the edit. */
	readonly seq: number;
	readonly at: string;
};

export type EditApi = {
	(path: string, change: EditChange): Promise<EditReceipt>;
	(label: string, changes: Record<string, EditChange>): Promise<EditReceipt>;
	create(path: string, contents: string): Promise<EditReceipt>;
	remove(path: string): Promise<EditReceipt>;
	copy(path: string, from: string): Promise<EditReceipt>;
	config(change: EditChange): Promise<EditReceipt>;
};

export type ProjectApi = {
	edit: EditApi;
	read(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
};

export type PipelineDevOptions = {
	/** Overlay the inline Vite config used for `createServer` without editing files. */
	config?(config: InlineConfig): InlineConfig | void;
};

export type DevServerHandle = {
	readonly url: string;
	readonly environments: readonly string[];
	readonly server: ViteDevServer;
};

export type PipelineBuildOptions = {
	/** Overlay the inline Vite config used for the build without editing files. */
	config?(config: InlineConfig): InlineConfig | void;
	/**
	 * 'builder' (default) builds every environment via Vite's createBuilder();
	 * 'build' runs the single vite build() pipeline — pin it when the project's
	 * real build command is a plain `vite build`, whose output can legitimately
	 * differ from the builder path.
	 */
	strategy?: 'builder' | 'build';
};

export type BuildArtifact = {
	/**
	 * Path relative to the runner root (even when the box overlays the build
	 * root to a subdirectory), for example 'dist/client/index.html'.
	 */
	path: string;
	bytes: number;
};

export type ArtifactHandle = {
	/** Path relative to the runner root. */
	readonly path: string;
	readonly absolutePath: string;
	readonly text: string;
};

export type BuildHandle = {
	readonly id: string;
	/** 'builder' = Vite createBuilder() built every environment; 'build' = single-build fallback. */
	readonly strategy: 'builder' | 'build';
	readonly environments: readonly string[];
	/** Per-environment output directory relative to the runner root. */
	readonly outDirs: Record<string, string>;
	readonly artifacts: readonly BuildArtifact[];
	artifact(path: string): Promise<ArtifactHandle>;
};

/** Build outcome facts recorded in the box receipt. */
export type BuildRecord = {
	id: string;
	strategy: 'builder' | 'build';
	/**
	 * The NODE_ENV the host process carried when this build started, or null
	 * when unset (vite then resolves production itself). Faithfulness evidence:
	 * plugins gate production-only output on it.
	 */
	nodeEnv: string | null;
	environments: string[];
	/** Per-environment output directory relative to the runner root. */
	outDirs: Record<string, string>;
	artifacts: BuildArtifact[];
	startedAt: string;
	durationMs: number;
};

export type PipelinePreviewOptions = {
	/** Overlay the inline Vite config used for the preview server without editing files. */
	config?(config: InlineConfig): InlineConfig | void;
};

export type PreviewHandle = {
	readonly url: string;
	/** Browser alias for the preview surface: visits stay local to the preview run. */
	readonly browser: {
		visit(path: string): Promise<PageHandle>;
	};
	/** Browserless preview evidence: fetch a route from the preview server. */
	request(path: string): Promise<string>;
	close(): Promise<void>;
};

/** Preview outcome facts recorded in the box receipt. */
export type PreviewRecord = {
	id: string;
	buildId: string;
	url: string;
	/** Output directory served by the preview server, relative to the Vite root. */
	outDir: string;
	/** The environment name `preview.browser` aliases to. */
	browserAlias: string;
	startedAt: string;
};

export type PipelineApi = {
	dev(options?: PipelineDevOptions): Promise<DevServerHandle>;
	build(options?: PipelineBuildOptions): Promise<BuildHandle>;
	preview(build: BuildHandle, options?: PipelinePreviewOptions): Promise<PreviewHandle>;
};

export type ExpectWaitOptions = {
	timeoutMs?: number;
};

/**
 * What one environment is expected to have done in reaction to an edit.
 * The vocabulary is identical to the receipt's `EnvironmentEditOutcome`:
 * authors can read a receipt and copy the shape they expect.
 *
 * Every omitted field means "don't care". Naming an environment implies
 * `error: null` (fail closed) unless an error expectation is given.
 */
export type EditEnvironmentExpectation = {
	/**
	 * 'accepted' = an HMR update was applied with no full reload.
	 * 'full-reload' = the environment reloaded (browser document or server
	 * module runner). 'none' = the environment observed the change and did
	 * nothing.
	 */
	hmr?: 'accepted' | 'full-reload' | 'none';
	/**
	 * Module paths that must be among the invalidated modules (suffix
	 * matching). An empty array asserts nothing was invalidated.
	 */
	invalidated?: string[];
	/**
	 * Names of framework hot-channel messages that must have been broadcast
	 * after the edit (for example 'qwik:hmr').
	 */
	messages?: string[];
	/**
	 * Expected error evidence as a subset match against the recorded error
	 * fields. Omit to require that the environment reported no error.
	 */
	error?: Record<string, unknown>;
};

/** Advanced escape hatch for evidence checks the vocabulary cannot express. */
export type EditOutcomePredicate = (outcome: EnvironmentEditOutcome) => boolean | Promise<boolean>;

/**
 * The declarative expectation passed to `expect.edit(change, expectation)`.
 * Keys are Vite environment names; the reserved `server` key asserts the dev
 * server reaction (config and env-file edits restart the server).
 */
export type EditExpectation = {
	server?: 'restarted';
} & {
	[environmentName: string]:
		| EditEnvironmentExpectation
		| EditOutcomePredicate
		| 'restarted'
		| undefined;
};

/** Expected occurrences of one tracked DOM event in `expect.page.outcome`. */
export type PageEventExpectation = {
	/** Minimum number of observed events (default 1). */
	atLeast?: number;
	/**
	 * Only count events whose JSON-serialized detail contains this substring.
	 * The settle-point pattern when a framework fires the same event name for
	 * unrelated reasons (for example qwik's qsymbol for HMR re-renders versus
	 * for a clicked handler's QRL).
	 */
	detailIncludes?: string;
};

/**
 * Declarative check against the recorded page evidence, mirroring the
 * receipt's page record. Numeric fields are exact counts; omitted fields are
 * not checked.
 */
export type PageOutcomeExpectation = {
	/** Exact number of main-frame navigations after the initial load (0 = never reloaded). */
	navigations?: number;
	/** Exact number of console errors plus uncaught page errors. */
	consoleErrors?: number;
	/** Exact number of failed network requests. */
	failedRequests?: number;
	/** Tracked DOM events that must have fired. Requires `page.trackEvents(name)` first. */
	events?: Record<string, PageEventExpectation>;
};

export type ArtifactTextExpectation = {
	/** Fragment(s) the artifact text must contain. */
	contains?: string | string[];
	/** Fragment(s) the artifact text must not contain. */
	notContains?: string | string[];
};

/** Scope options for `expect.build.forbids`. */
export type BuildForbidsOptions = {
	/**
	 * Glob (relative to the runner root) selecting which emitted artifacts to
	 * scan. Defaults to every text-like artifact the build emitted.
	 */
	files?: string;
};

export type ArtifactJsonPredicate = (json: unknown) => boolean | Promise<boolean>;

/** What `expect.page.bodyText` checks against the page body text. */
export type BodyTextExpectation = {
	contains?: string;
	notContains?: string;
};

export type PageExpectApi = {
	/** Waits until the selector's trimmed text equals the expected string. */
	text(
		page: PageHandle,
		selector: string,
		expected: string,
		options?: ExpectWaitOptions,
	): Promise<void>;
	/** Waits until the page body text contains / no longer contains fragments. */
	bodyText(
		page: PageHandle,
		expectation: BodyTextExpectation,
		options?: ExpectWaitOptions,
	): Promise<void>;
	/**
	 * Waits until the selector's element carries the attribute. With a string
	 * `expected`, waits until the attribute equals that value; with `null`,
	 * waits until the element exists without the attribute (absence).
	 */
	attribute(
		page: PageHandle,
		selector: string,
		attributeName: string,
		expected?: string | null,
		options?: ExpectWaitOptions,
	): Promise<void>;
	/** Waits until the selector matches an element in the DOM. */
	exists(page: PageHandle, selector: string, options?: ExpectWaitOptions): Promise<void>;
	/** Waits until the selector matches a visible element. */
	visible(page: PageHandle, selector: string, options?: ExpectWaitOptions): Promise<void>;
	/** Waits until every given computed style property matches. */
	computedStyle(
		page: PageHandle,
		selector: string,
		styles: Record<string, string>,
		options?: ExpectWaitOptions,
	): Promise<void>;
	/**
	 * Declaratively checks the recorded page evidence (navigations, console
	 * errors, failed requests, tracked events) and reports every mismatch at
	 * once. Event expectations wait (bounded) for their counts; the numeric
	 * checks compare what the page record holds at that point.
	 */
	outcome(
		page: PageHandle,
		expectation: PageOutcomeExpectation,
		options?: ExpectWaitOptions,
	): Promise<void>;
};

/** What `expect.response.matches` checks against an environment response. */
export type ResponseExpectation = {
	status?: number;
	ok?: boolean;
	/** Substring match against the lowercased content-type header. */
	contentType?: string;
	/** Substring match against the response body. */
	contains?: string;
};

export type ExpectApi = {
	/**
	 * The only edit/HMR assertion: declares the expected reaction to one edit
	 * across every named environment (and the reserved `server` key), waits
	 * for each to settle, then diffs expectation against the recorded outcome
	 * and reports all mismatches at once.
	 */
	edit(
		change: EditReceipt,
		expectation: EditExpectation,
		options?: ExpectWaitOptions,
	): Promise<void>;
	page: PageExpectApi;
	html: {
		contains(html: string, fragment: string): Promise<void>;
	};
	response: {
		/** Asserts status / content-type / body facts of an environment fetch. */
		matches(response: EnvironmentResponse, expectation: ResponseExpectation): Promise<void>;
	};
	build: {
		environment(build: BuildHandle, name: string): Promise<void>;
		artifact(build: BuildHandle, path: string): Promise<void>;
		/**
		 * Scans the build's emitted text artifacts and fails if any forbidden
		 * string appears, listing every file and string that matched. The
		 * canonical leakage check: `expect.build.forbids(build, ['node:fs'])`.
		 */
		forbids(
			build: BuildHandle,
			forbidden: string[],
			options?: BuildForbidsOptions,
		): Promise<void>;
	};
	artifact: {
		exists(build: BuildHandle, path: string): Promise<void>;
		text(build: BuildHandle, path: string, expectation: ArtifactTextExpectation): Promise<void>;
		json: {
			(artifact: ArtifactHandle, predicate: ArtifactJsonPredicate): Promise<void>;
			(build: BuildHandle, path: string, predicate: ArtifactJsonPredicate): Promise<void>;
		};
	};
};

export type Measurement = {
	label: string;
	durationMs: number;
};

export type ReceiptApi = {
	capture(label: string): Promise<void>;
	note(text: string): void;
	measure(label: string, fn: () => unknown | Promise<unknown>): Promise<Measurement>;
};

export type ViteErrorEvidence = Record<string, unknown>;

export type ViteModuleEvidence = {
	url: string;
	id: string | null;
	file: string | null;
};

export type ViteUpdateEvidence = {
	type: string;
	path: string;
	acceptedPath: string;
} & Record<string, unknown>;

export type VitePluginEvidence = {
	name: string;
	hook: string;
};

/**
 * A framework hot-channel message broadcast after an edit. Frameworks (for
 * example qwik with 'qwik:hmr') replace Vite's standard 'update' protocol
 * with their own messages; these are first-class HMR evidence.
 */
export type ViteHotMessageEvidence = {
	name: string;
	data?: unknown;
};

/**
 * Normalized per-environment reaction to one project edit. The `hmr` field is
 * the headline classification and uses the exact words the `expect.edit`
 * vocabulary uses; the raw updates, messages, and reload payloads stay
 * recorded underneath it.
 */
export type EnvironmentEditOutcome = {
	name: string;
	kind: 'browser' | 'server' | 'worker' | 'custom';
	/**
	 * 'accepted' = an HMR update was applied with no full reload.
	 * 'full-reload' = the environment reloaded (browser document or server
	 * module runner). 'none' = no update and no reload were observed.
	 */
	hmr: 'accepted' | 'full-reload' | 'none';
	restart: boolean;
	error: ViteErrorEvidence | null;
	invalidated: ViteModuleEvidence[];
	updates: ViteUpdateEvidence[];
	/** Framework hot-channel messages broadcast after the edit. */
	messages: ViteHotMessageEvidence[];
	plugins: VitePluginEvidence[];
};

export type AssertionRecord = {
	name: string;
	environment: string | null;
	editId: string | null;
	status: 'passed' | 'failed';
	message: string | null;
	/** Structured expectation for declarative assertions (`expect.edit`, `expect.page.outcome`). */
	expected?: unknown;
	/** What the evidence actually recorded, for failed declarative assertions. */
	observed?: unknown;
};

export type DiscoveredBox = {
	file: string;
	relativeFile: string;
	exportName: string;
	box: BoxDefinition;
};

export type InvalidBoxFile = {
	file: string;
	relativeFile: string;
	error: string;
};

export type DiscoveryResult = {
	root: string;
	boxes: DiscoveredBox[];
	invalid: InvalidBoxFile[];
};

export type BoxRunResult = {
	name: string;
	file: string;
	exportName: string;
	status: 'passed' | 'failed';
	error: { message: string; stack?: string } | null;
};

export type RunBoxesOptions = {
	root: string;
	/** Run a pre-selected set instead of discovering every `*.box.ts(x)` file. */
	boxes?: DiscoveredBox[];
	/** Invalid box files to record in the receipt when `boxes` is pre-selected. */
	invalid?: InvalidBoxFile[];
	/** Receipt directory, absolute or relative to root. Default `.gumbox/receipts`. */
	receiptDir?: string;
	/** Default bounded wait used by `expect.*` assertions. */
	assertionTimeoutMs?: number;
	/** Host filesystem capability used for project edits and receipt writes. */
	fileSystem: GumboxFileSystem;
	/** Host browser automation capability used by visit() and page evidence. */
	browser?: GumboxBrowser;
	/** Run browser sessions headlessly (default true). */
	headless?: boolean;
	/** Called with each box result as that box finishes, before the run summary. */
	onBoxResult?(result: BoxRunResult): void;
};

export type RunBoxesResult = {
	status: 'passed' | 'failed';
	root: string;
	runId: string;
	runDir: string;
	receiptPath: string;
	boxes: BoxRunResult[];
	invalid: InvalidBoxFile[];
};
