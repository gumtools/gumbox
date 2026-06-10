import type { Plugin } from 'vite';

export { box, isBoxDefinition } from './box.ts';
export { discoverBoxes } from './discovery.ts';
export { createFileSystem } from './filesystem.ts';
export { restorePendingEdits, runBoxes } from './runner.ts';
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
	PageInteraction,
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
	BodyTextExpectation,
	EditApi,
	EditChange,
	EditChangeSummary,
	EditedFile,
	EditEnvironmentExpectation,
	EditExpectation,
	EditOutcomePredicate,
	EditReceipt,
	EnvironmentApi,
	EnvironmentEditOutcome,
	EnvironmentFetchInit,
	EnvironmentHandle,
	EnvironmentResponse,
	ExpectApi,
	ExpectWaitOptions,
	InvalidBoxFile,
	Measurement,
	PageEventExpectation,
	PageExpectApi,
	PageOutcomeExpectation,
	PipelineApi,
	PipelineBuildOptions,
	PipelineDevOptions,
	PipelinePreviewOptions,
	PreviewHandle,
	PreviewRecord,
	ProjectApi,
	ReceiptApi,
	ResponseExpectation,
	RunBoxesOptions,
	RunBoxesResult,
	ViteErrorEvidence,
	ViteHotMessageEvidence,
	ViteModuleEvidence,
	VitePluginEvidence,
	ViteUpdateEvidence,
} from './types.ts';

export function gumbox(): Plugin {
	return {
		name: 'gumbox',
	};
}
