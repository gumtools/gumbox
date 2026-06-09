import { describe, expect, test } from 'vitest';
import { gumbox } from '../src/index.ts';

describe('gumbox', () => {
	test('creates a Vite plugin shell', () => {
		expect(gumbox()).toEqual({
			name: 'gumbox',
		});
	});
});
