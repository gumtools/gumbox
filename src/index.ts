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
	EvidenceEvent,
	HotPayloadEvidence,
	HotUpdateHookEvidence,
	ServerRestartEvidence,
	FileEditEvidence,
} from './evidence.ts';
export type {
	AssertionRecord,
	BoxContext,
	BoxDefinition,
	BoxOptions,
	BoxRunFn,
	BoxRunResult,
	BrowserEnvironmentAlias,
	DevServerHandle,
	DiscoveredBox,
	DiscoveryResult,
	EditChange,
	EditReceipt,
	EnvironmentApi,
	EnvironmentEditOutcome,
	EnvironmentExpectApi,
	EnvironmentHandle,
	ExpectApi,
	ExpectWaitOptions,
	InvalidBoxFile,
	Measurement,
	PipelineApi,
	PipelineDevOptions,
	ProjectApi,
	ReceiptApi,
	RunBoxesOptions,
	RunBoxesResult,
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
