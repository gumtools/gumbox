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
};

export type BuildArtifact = {
	/** Path relative to the Vite root, for example 'dist/client/index.html'. */
	path: string;
	bytes: number;
};

export type ArtifactHandle = {
	/** Path relative to the Vite root. */
	readonly path: string;
	readonly absolutePath: string;
	readonly text: string;
};

export type BuildHandle = {
	readonly id: string;
	/** 'builder' = Vite createBuilder() built every environment; 'build' = single-build fallback. */
	readonly strategy: 'builder' | 'build';
	readonly environments: readonly string[];
	/** Per-environment output directory relative to the Vite root. */
	readonly outDirs: Record<string, string>;
	readonly artifacts: readonly BuildArtifact[];
	artifact(path: string): Promise<ArtifactHandle>;
};

/** Build outcome facts recorded in the box receipt. */
export type BuildRecord = {
	id: string;
	strategy: 'builder' | 'build';
	environments: string[];
	/** Per-environment output directory relative to the Vite root. */
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

export type PageEventExpectOptions = ExpectWaitOptions & {
	/** Minimum number of observed events (default 1). */
	atLeast?: number;
};

export type EnvironmentExpectApi = {
	hotUpdate(change: EditReceipt, options?: ExpectWaitOptions): Promise<void>;
	/**
	 * Waits until the environment broadcasts a custom hot payload with this
	 * event name after the edit. Frameworks that replace Vite's 'update'
	 * protocol (for example qwik's 'qwik:hmr') are asserted with this.
	 */
	customPayload(
		change: EditReceipt,
		eventName: string,
		options?: ExpectWaitOptions,
	): Promise<void>;
	noFullReload(change: EditReceipt, options?: ExpectWaitOptions): Promise<void>;
	invalidated(
		change: EditReceipt,
		modulePath?: string,
		options?: ExpectWaitOptions,
	): Promise<void>;
	notInvalidated(change: EditReceipt, options?: ExpectWaitOptions): Promise<void>;
	satisfies(
		change: EditReceipt,
		predicate: (outcome: EnvironmentEditOutcome) => boolean | Promise<boolean>,
		options?: ExpectWaitOptions,
	): Promise<void>;
};

export type ArtifactTextExpectation = {
	contains?: string;
	notContains?: string;
};

export type ArtifactJsonPredicate = (json: unknown) => boolean | Promise<boolean>;

export type PageExpectApi = {
	/** Waits until the selector's trimmed text equals the expected string. */
	text(
		page: PageHandle,
		selector: string,
		expected: string,
		options?: ExpectWaitOptions,
	): Promise<void>;
	/** Waits until the page body text contains the given fragment. */
	containsText(page: PageHandle, fragment: string, options?: ExpectWaitOptions): Promise<void>;
	/** Waits until the page body text no longer contains the given fragment. */
	notContainsText(page: PageHandle, fragment: string, options?: ExpectWaitOptions): Promise<void>;
	/**
	 * Waits until the selector's element carries the attribute (and, when
	 * `expected` is given, until the attribute equals that value).
	 */
	attribute(
		page: PageHandle,
		selector: string,
		attributeName: string,
		expected?: string,
		options?: ExpectWaitOptions,
	): Promise<void>;
	/** Waits until the selector's element exists without the attribute. */
	noAttribute(
		page: PageHandle,
		selector: string,
		attributeName: string,
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
	/** Asserts the page captured no console errors or uncaught page errors. */
	cleanConsole(page: PageHandle): Promise<void>;
	/**
	 * Waits until at least `atLeast` tracked DOM events of this name fired in
	 * the page, then records every occurrence (timestamp + detail) as page
	 * evidence. Requires a prior `page.trackEvents(eventName)`.
	 */
	event(page: PageHandle, eventName: string, options?: PageEventExpectOptions): Promise<void>;
	/** Asserts the page never navigated (no reloads) after the initial load. */
	noNavigations(page: PageHandle): Promise<void>;
	/** Asserts the page captured no failed network requests so far. */
	noFailedRequests(page: PageHandle): Promise<void>;
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
	environment: Record<string, EnvironmentExpectApi>;
	/** Alias for `expect.environment.<browser environment>`. */
	browser: EnvironmentExpectApi;
	page: PageExpectApi;
	html: {
		contains(html: string, fragment: string): Promise<void>;
	};
	response: {
		/** Asserts status / content-type / body facts of an environment fetch. */
		matches(response: EnvironmentResponse, expectation: ResponseExpectation): Promise<void>;
	};
	pipeline: {
		serverRestarted(change: EditReceipt, options?: ExpectWaitOptions): Promise<void>;
	};
	build: {
		environment(build: BuildHandle, name: string): Promise<void>;
		artifact(build: BuildHandle, path: string): Promise<void>;
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
 * A custom hot payload broadcast on the environment channel after an edit.
 * Frameworks (for example qwik) replace Vite's standard 'update' protocol
 * with their own events; these are first-class HMR evidence.
 */
export type ViteCustomPayloadEvidence = {
	event: string;
	data?: unknown;
};

/**
 * Normalized per-environment reaction to one project edit.
 */
export type EnvironmentEditOutcome = {
	name: string;
	kind: 'browser' | 'server' | 'worker' | 'custom';
	update: boolean;
	fullReload: boolean;
	restart: boolean;
	error: ViteErrorEvidence | null;
	invalidated: ViteModuleEvidence[];
	updates: ViteUpdateEvidence[];
	/** Custom hot payloads broadcast after the edit (framework HMR protocols). */
	customPayloads: ViteCustomPayloadEvidence[];
	plugins: VitePluginEvidence[];
};

export type AssertionRecord = {
	name: string;
	environment: string | null;
	editId: string | null;
	status: 'passed' | 'failed';
	message: string | null;
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
