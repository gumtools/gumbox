/**
 * Test-only host boundary: the Vite HMR tests need real files on disk. The
 * actual runtime adaptation lives in the CLI host boundary
 * (`src/cli/host.ts`); this module just instantiates it for tests so there
 * is exactly one runtime filesystem adapter in the repo.
 */
import { createHostFileSystem } from '../../src/cli/host.ts';
import type { GumboxFileSystem } from '../../src/filesystem.ts';

export const fileSystem: GumboxFileSystem = createHostFileSystem();
