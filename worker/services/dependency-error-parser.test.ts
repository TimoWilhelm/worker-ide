/**
 * Dependency Error Parser Tests
 */

import { describe, expect, it } from 'vitest';

import { parseDependencyErrorsFromMessage } from './dependency-error-parser';

describe('parseDependencyErrorsFromMessage', () => {
	it('returns undefined for messages with no dependency errors', () => {
		expect(parseDependencyErrorsFromMessage('Something went wrong')).toBeUndefined();
		expect(parseDependencyErrorsFromMessage('')).toBeUndefined();
	});

	it('parses a single unregistered dependency', () => {
		const message =
			'BundleDependencyError: Build failed with 1 error:\n' +
			'virtual:worker/index.ts:2:21: ERROR: [plugin: virtual-fs] Unregistered dependency "hono". ' +
			'Add it to project dependencies using the Dependencies panel.';
		const result = parseDependencyErrorsFromMessage(message);
		expect(result).toEqual([
			{
				packageName: 'hono',
				code: 'unregistered',
				message: 'Unregistered dependency "hono"',
			},
		]);
	});

	it('parses a scoped unregistered dependency', () => {
		const message = 'ERROR: [plugin: virtual-fs] Unregistered dependency "@scope/pkg". Add it to project dependencies.';
		const result = parseDependencyErrorsFromMessage(message);
		expect(result).toEqual([
			{
				packageName: '@scope/pkg',
				code: 'unregistered',
				message: 'Unregistered dependency "@scope/pkg"',
			},
		]);
	});

	it('parses a not-found dependency', () => {
		const message = 'Package not found: "nonexistent-pkg". Check that the package name and version are correct.';
		const result = parseDependencyErrorsFromMessage(message);
		expect(result).toEqual([
			{
				packageName: 'nonexistent-pkg',
				code: 'not-found',
				message: 'Package not found: "nonexistent-pkg"',
			},
		]);
	});

	it('parses a resolve-failed dependency', () => {
		const message = 'Failed to resolve "react" from CDN (500 Internal Server Error). The package or version may be invalid.';
		const result = parseDependencyErrorsFromMessage(message);
		expect(result).toEqual([
			{
				packageName: 'react',
				code: 'resolve-failed',
				message: 'Failed to resolve "react" from CDN',
			},
		]);
	});

	it('parses multiple unregistered dependencies from one message', () => {
		const message =
			'Build failed with 2 errors:\n' +
			'ERROR: [plugin: virtual-fs] Unregistered dependency "hono". Add it.\n' +
			'ERROR: [plugin: virtual-fs] Unregistered dependency "zod". Add it.';
		const result = parseDependencyErrorsFromMessage(message);
		expect(result).toHaveLength(2);
		expect(result![0].packageName).toBe('hono');
		expect(result![1].packageName).toBe('zod');
	});

	it('parses mixed error types from one message', () => {
		const message =
			'Unregistered dependency "hono". Add it.\n' +
			'Package not found: "bad-pkg". Check the name.\n' +
			'Failed to resolve "broken" from CDN (404).';
		const result = parseDependencyErrorsFromMessage(message);
		expect(result).toHaveLength(3);
		expect(result![0]).toMatchObject({ packageName: 'hono', code: 'unregistered' });
		expect(result![1]).toMatchObject({ packageName: 'bad-pkg', code: 'not-found' });
		expect(result![2]).toMatchObject({ packageName: 'broken', code: 'resolve-failed' });
	});

	it('does not match partial patterns', () => {
		expect(parseDependencyErrorsFromMessage('Unregistered dependency without quotes')).toBeUndefined();
		expect(parseDependencyErrorsFromMessage('Package not found without quotes')).toBeUndefined();
		expect(parseDependencyErrorsFromMessage('Failed to resolve without quotes')).toBeUndefined();
	});
});
