import type { Plugin } from 'vite';

export { box, isBoxDefinition } from './box.ts';
export { discoverBoxes } from './discovery.ts';
export { createFileSystem } from './filesystem.ts';
export { runBoxes } from './runner.ts';
export { GumboxAssertionError } from './expect.ts';
export { GumboxTimeoutError } from './evidence.ts';
export type {
	FileSystemDirectoryEntry,
	GumboxFileSystem,
	GumboxFileSystemRuntime,
} from './filesystem.ts';
export type {
	BrowserConsoleMessage,
	BrowserLaunchOptions,
	BrowserPageError,
	BrowserRequestFailure,
	GumboxBrowser,
	GumboxBrowserPage,
	GumboxBrowserSession,
	PageHandle,
	PageNavigation,
	PageRecord,
	PageSnapshot,
	TrackedPageEvent,
} from './browser.ts';
export type {
	EvidenceEvent,
	HotPayloadEvidence,
	HotUpdateHookEvidence,
	ServerListeningEvidence,
	ServerRestartEvidence,
	FileEditEvidence,
} from './evidence.ts';
export type {
	ArtifactHandle,
	ArtifactJsonPredicate,
	ArtifactTextExpectation,
	AssertionRecord,
	BoxContext,
	BoxDefinition,
	BoxOptions,
	BoxRunFn,
	BoxRunResult,
	BrowserEnvironmentAlias,
	BuildArtifact,
	BuildHandle,
	BuildRecord,
	DevServerHandle,
	DiscoveredBox,
	DiscoveryResult,
	EditApi,
	EditChange,
	EditChangeSummary,
	EditedFile,
	EditReceipt,
	EnvironmentApi,
	EnvironmentEditOutcome,
	EnvironmentExpectApi,
	EnvironmentHandle,
	ExpectApi,
	ExpectWaitOptions,
	InvalidBoxFile,
	Measurement,
	PageEventExpectOptions,
	PageExpectApi,
	PipelineApi,
	PipelineBuildOptions,
	PipelineDevOptions,
	PipelinePreviewOptions,
	PreviewHandle,
	PreviewRecord,
	ProjectApi,
	ReceiptApi,
	RunBoxesOptions,
	RunBoxesResult,
	ViteCustomPayloadEvidence,
	ViteErrorEvidence,
	ViteModuleEvidence,
	VitePluginEvidence,
	ViteUpdateEvidence,
} from './types.ts';

export function gumbox(): Plugin {
	return {
		name: 'gumbox',
	};
}
