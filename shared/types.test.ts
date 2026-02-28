/**
 * Unit tests for mergeTestRunResults.
 */

import { describe, expect, it } from 'vitest';

import { mergeTestRunResults } from './types';

import type { TestRunResponse } from './types';

// =============================================================================
// Helpers
// =============================================================================

function makeTestRunResponse(overrides: Partial<TestRunResponse> = {}): TestRunResponse {
	return {
		title: '1 passed',
		output: 'PASS test/math.test.ts\n  ✓ adds\n\nTests: 1 passed, 1 total',
		metadata: { passed: 1, failed: 0, total: 1, files: 1, bundleErrors: 0 },
		fileResults: [
			{
				file: 'test/math.test.ts',
				results: {
					suites: [
						{
							name: 'math',
							tests: [{ name: 'adds', status: 'passed', duration: 1 }],
							passed: 1,
							failed: 0,
						},
					],
					passed: 1,
					failed: 0,
					total: 1,
					duration: 5,
				},
			},
		],
		bundleErrors: [],
		timestamp: 1000,
		...overrides,
	};
}

function makeMultiFileResponse(): TestRunResponse {
	return {
		title: '3 passed',
		output: '',
		metadata: { passed: 3, failed: 0, total: 3, files: 2, bundleErrors: 0 },
		fileResults: [
			{
				file: 'test/math.test.ts',
				results: {
					suites: [
						{
							name: 'math',
							tests: [
								{ name: 'adds', status: 'passed', duration: 1 },
								{ name: 'subtracts', status: 'passed', duration: 2 },
							],
							passed: 2,
							failed: 0,
						},
					],
					passed: 2,
					failed: 0,
					total: 2,
					duration: 5,
				},
			},
			{
				file: 'test/string.test.ts',
				results: {
					suites: [
						{
							name: 'string',
							tests: [{ name: 'trims', status: 'passed', duration: 1 }],
							passed: 1,
							failed: 0,
						},
					],
					passed: 1,
					failed: 0,
					total: 1,
					duration: 3,
				},
			},
		],
		bundleErrors: [],
		timestamp: 1000,
	};
}

// =============================================================================
// mergeTestRunResults
// =============================================================================

describe('mergeTestRunResults', () => {
	it('updates a single test result when it changes from passed to failed', () => {
		const existing = makeMultiFileResponse();

		// Incoming: re-ran "adds" and it now fails
		const incoming: TestRunResponse = {
			title: '1 failed, 0 passed',
			output: '',
			metadata: { passed: 0, failed: 1, total: 1, files: 1, bundleErrors: 0 },
			fileResults: [
				{
					file: 'test/math.test.ts',
					results: {
						suites: [
							{
								name: 'math',
								tests: [{ name: 'adds', status: 'failed', error: 'Expected 3 to be 4', duration: 2 }],
								passed: 0,
								failed: 1,
							},
						],
						passed: 0,
						failed: 1,
						total: 1,
						duration: 2,
					},
				},
			],
			bundleErrors: [],
			timestamp: 2000,
		};

		const merged = mergeTestRunResults(existing, incoming);

		// The "adds" test should now be failed
		const mathFile = merged.fileResults.find((f) => f.file === 'test/math.test.ts');
		expect(mathFile).toBeDefined();
		const mathSuite = mathFile!.results.suites[0];
		expect(mathSuite.tests[0]).toEqual(expect.objectContaining({ name: 'adds', status: 'failed', error: 'Expected 3 to be 4' }));

		// The "subtracts" test should remain passed (unchanged)
		expect(mathSuite.tests[1]).toEqual(expect.objectContaining({ name: 'subtracts', status: 'passed' }));
	});

	it('recomputes file-level passed/failed/total counts', () => {
		const existing = makeMultiFileResponse();

		const incoming: TestRunResponse = {
			title: '1 failed, 0 passed',
			output: '',
			metadata: { passed: 0, failed: 1, total: 1, files: 1, bundleErrors: 0 },
			fileResults: [
				{
					file: 'test/math.test.ts',
					results: {
						suites: [
							{
								name: 'math',
								tests: [{ name: 'adds', status: 'failed', error: 'bad', duration: 1 }],
								passed: 0,
								failed: 1,
							},
						],
						passed: 0,
						failed: 1,
						total: 1,
						duration: 1,
					},
				},
			],
			bundleErrors: [],
			timestamp: 2000,
		};

		const merged = mergeTestRunResults(existing, incoming);
		const mathFile = merged.fileResults.find((f) => f.file === 'test/math.test.ts');

		// 1 failed (adds) + 1 passed (subtracts) = 1 passed, 1 failed, 2 total
		expect(mathFile!.results.passed).toBe(1);
		expect(mathFile!.results.failed).toBe(1);
		expect(mathFile!.results.total).toBe(2);
	});

	it('recomputes top-level metadata counts', () => {
		const existing = makeMultiFileResponse(); // 3 passed, 0 failed

		const incoming: TestRunResponse = {
			title: '',
			output: '',
			metadata: { passed: 0, failed: 1, total: 1, files: 1, bundleErrors: 0 },
			fileResults: [
				{
					file: 'test/math.test.ts',
					results: {
						suites: [
							{
								name: 'math',
								tests: [{ name: 'adds', status: 'failed', error: 'bad', duration: 1 }],
								passed: 0,
								failed: 1,
							},
						],
						passed: 0,
						failed: 1,
						total: 1,
						duration: 1,
					},
				},
			],
			bundleErrors: [],
			timestamp: 2000,
		};

		const merged = mergeTestRunResults(existing, incoming);

		// math: 1 passed (subtracts) + 1 failed (adds) = 1p 1f
		// string: 1 passed (trims) = 1p 0f
		// total: 2 passed, 1 failed, 3 total
		expect(merged.metadata.passed).toBe(2);
		expect(merged.metadata.failed).toBe(1);
		expect(merged.metadata.total).toBe(3);
	});

	it('generates correct title when all tests pass', () => {
		const existing = makeTestRunResponse();

		// Re-run the same test and it still passes
		const incoming: TestRunResponse = {
			...makeTestRunResponse({ timestamp: 2000 }),
		};

		const merged = mergeTestRunResults(existing, incoming);
		expect(merged.title).toBe('1 passed');
	});

	it('generates correct title when some tests fail', () => {
		const existing = makeMultiFileResponse();

		const incoming: TestRunResponse = {
			title: '',
			output: '',
			metadata: { passed: 0, failed: 1, total: 1, files: 1, bundleErrors: 0 },
			fileResults: [
				{
					file: 'test/math.test.ts',
					results: {
						suites: [
							{
								name: 'math',
								tests: [{ name: 'adds', status: 'failed', error: 'bad', duration: 1 }],
								passed: 0,
								failed: 1,
							},
						],
						passed: 0,
						failed: 1,
						total: 1,
						duration: 1,
					},
				},
			],
			bundleErrors: [],
			timestamp: 2000,
		};

		const merged = mergeTestRunResults(existing, incoming);
		expect(merged.title).toBe('1 failed, 2 passed');
	});

	it('preserves files not present in incoming results', () => {
		const existing = makeMultiFileResponse();

		// Incoming only has math file results
		const incoming: TestRunResponse = {
			title: '',
			output: '',
			metadata: { passed: 1, failed: 0, total: 1, files: 1, bundleErrors: 0 },
			fileResults: [
				{
					file: 'test/math.test.ts',
					results: {
						suites: [
							{
								name: 'math',
								tests: [{ name: 'adds', status: 'passed', duration: 1 }],
								passed: 1,
								failed: 0,
							},
						],
						passed: 1,
						failed: 0,
						total: 1,
						duration: 1,
					},
				},
			],
			bundleErrors: [],
			timestamp: 2000,
		};

		const merged = mergeTestRunResults(existing, incoming);

		// string file should be unchanged
		const stringFile = merged.fileResults.find((f) => f.file === 'test/string.test.ts');
		expect(stringFile).toBeDefined();
		expect(stringFile!.results.passed).toBe(1);
		expect(stringFile!.results.suites[0].tests[0].name).toBe('trims');
	});

	it('uses the incoming timestamp', () => {
		const existing = makeTestRunResponse({ timestamp: 1000 });
		const incoming = makeTestRunResponse({ timestamp: 5000 });

		const merged = mergeTestRunResults(existing, incoming);
		expect(merged.timestamp).toBe(5000);
	});

	it('preserves existing bundleErrors', () => {
		const existing = makeTestRunResponse({
			bundleErrors: [{ file: 'test/broken.test.ts', error: 'syntax error' }],
			metadata: { passed: 1, failed: 0, total: 1, files: 1, bundleErrors: 1 },
		});
		const incoming = makeTestRunResponse({ timestamp: 2000 });

		const merged = mergeTestRunResults(existing, incoming);
		expect(merged.bundleErrors).toEqual([{ file: 'test/broken.test.ts', error: 'syntax error' }]);
	});

	it('handles multiple suites within a single file', () => {
		const existing: TestRunResponse = {
			title: '3 passed',
			output: '',
			metadata: { passed: 3, failed: 0, total: 3, files: 1, bundleErrors: 0 },
			fileResults: [
				{
					file: 'test/math.test.ts',
					results: {
						suites: [
							{
								name: 'add',
								tests: [{ name: 'positive', status: 'passed', duration: 1 }],
								passed: 1,
								failed: 0,
							},
							{
								name: 'subtract',
								tests: [
									{ name: 'positive', status: 'passed', duration: 1 },
									{ name: 'negative', status: 'passed', duration: 1 },
								],
								passed: 2,
								failed: 0,
							},
						],
						passed: 3,
						failed: 0,
						total: 3,
						duration: 5,
					},
				},
			],
			bundleErrors: [],
			timestamp: 1000,
		};

		// Re-run "subtract > negative" and it now fails
		const incoming: TestRunResponse = {
			title: '',
			output: '',
			metadata: { passed: 0, failed: 1, total: 1, files: 1, bundleErrors: 0 },
			fileResults: [
				{
					file: 'test/math.test.ts',
					results: {
						suites: [
							{
								name: 'subtract',
								tests: [{ name: 'negative', status: 'failed', error: 'wrong', duration: 1 }],
								passed: 0,
								failed: 1,
							},
						],
						passed: 0,
						failed: 1,
						total: 1,
						duration: 1,
					},
				},
			],
			bundleErrors: [],
			timestamp: 2000,
		};

		const merged = mergeTestRunResults(existing, incoming);
		const file = merged.fileResults[0];

		// "add" suite untouched
		expect(file.results.suites[0].tests[0].status).toBe('passed');
		expect(file.results.suites[0].passed).toBe(1);
		expect(file.results.suites[0].failed).toBe(0);

		// "subtract" suite: "positive" passed (unchanged), "negative" failed (updated)
		expect(file.results.suites[1].tests[0]).toEqual(expect.objectContaining({ name: 'positive', status: 'passed' }));
		expect(file.results.suites[1].tests[1]).toEqual(expect.objectContaining({ name: 'negative', status: 'failed', error: 'wrong' }));
		expect(file.results.suites[1].passed).toBe(1);
		expect(file.results.suites[1].failed).toBe(1);

		// File totals: 2 passed, 1 failed
		expect(file.results.passed).toBe(2);
		expect(file.results.failed).toBe(1);
		expect(file.results.total).toBe(3);

		// Top-level metadata
		expect(merged.metadata.passed).toBe(2);
		expect(merged.metadata.failed).toBe(1);
		expect(merged.metadata.total).toBe(3);
	});
});
