/**
 * useTestRun Hooks
 *
 * Provides test discovery (file paths + test names), test execution,
 * and local result management. Test results are stateless on the server —
 * they live entirely in the React Query cache on each client.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { createApiClient } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { mergeTestRunResults } from '@shared/types';

import type { DiscoveredTestFile, TestRunResponse } from '@shared/types';

// =============================================================================
// useTestDiscovery — discovers test files and their test names via parsing
// =============================================================================

interface UseTestDiscoveryOptions {
	projectId: string;
	enabled?: boolean;
}

/**
 * Fetches discovered test files with their parsed test names.
 * The server reads test files and statically parses describe/it/test calls.
 */
export function useTestDiscovery({ projectId, enabled = true }: UseTestDiscoveryOptions) {
	const api = useMemo(() => createApiClient(projectId), [projectId]);
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: ['test-discovery', projectId],
		queryFn: async (): Promise<DiscoveredTestFile[]> => {
			const response = await api.test.discover.$get({});
			if (!response.ok) {
				throw new Error('Failed to discover tests');
			}
			const data = await response.json();
			return data.files;
		},
		enabled,
		staleTime: 1000 * 60,
	});

	const refresh = () => {
		// Reset test results to initial state (undefined) so the UI shows
		// all tests as "not run". resetQueries re-runs the no-op queryFn
		// and properly notifies all observers of the data change.
		void queryClient.resetQueries({ queryKey: ['test-results', projectId] });
		// Re-discover test files
		void queryClient.invalidateQueries({ queryKey: ['test-discovery', projectId] });
	};

	return {
		discoveredFiles: query.data ?? [],
		isLoading: query.isLoading,
		isRefreshing: query.isFetching && !query.isLoading,
		refresh,
	};
}

// =============================================================================
// useTestResults — subscribes to test results from the local query cache
// =============================================================================

interface UseTestResultsOptions {
	projectId: string;
}

/**
 * Subscribes to the most recent test run results from the React Query cache.
 * Data is populated exclusively by:
 *  - The useRunTests mutation's onSuccess (for the user who triggered the run)
 *  - The WebSocket `test-results-changed` handler calling setQueryData (for collaborators)
 *
 * The queryFn is a no-op that returns undefined — data only enters via
 * setQueryData. staleTime: Infinity prevents background refetches.
 */
export function useTestResults({ projectId }: UseTestResultsOptions) {
	const query = useQuery<TestRunResponse | undefined>({
		queryKey: ['test-results', projectId],
		// eslint-disable-next-line unicorn/no-useless-undefined -- explicit undefined needed for correct TQueryFnData inference
		queryFn: () => undefined,
		staleTime: Number.POSITIVE_INFINITY,
	});

	return { results: query.data };
}

// =============================================================================
// useRunTests — mutation to trigger a test run
// =============================================================================

interface UseRunTestsOptions {
	projectId: string;
}

/**
 * Mutation hook to trigger a test run.
 * On success, updates the local query cache immediately. When running a
 * single test, the incoming result is merged with existing results so
 * other tests are not lost.
 */
export function useRunTests({ projectId }: UseRunTestsOptions) {
	const api = useMemo(() => createApiClient(projectId), [projectId]);
	const queryClient = useQueryClient();
	const openFile = useStore((state) => state.openFile);

	const mutation = useMutation<TestRunResponse, Error, { pattern?: string; testName?: string } | void>({
		mutationFn: async (variables) => {
			const response = await api.test.run.$post({
				json: {
					pattern: (variables && variables.pattern) || undefined,
					testName: (variables && variables.testName) || undefined,
				},
			});
			if (!response.ok) {
				throw new Error('Test run failed');
			}
			const data = await response.json();
			return data;
		},
		onSuccess: (data, variables) => {
			const isTestNameRun = variables && variables.testName;

			if (isTestNameRun) {
				// Single-test run: merge into existing results so other tests aren't lost
				const existing = queryClient.getQueryData<TestRunResponse>(['test-results', projectId]);
				if (existing) {
					queryClient.setQueryData(['test-results', projectId], mergeTestRunResults(existing, data));
					return;
				}
			}

			// Full run or no existing results: replace the cache entirely
			queryClient.setQueryData(['test-results', projectId], data);
		},
	});

	const openTestFile = (filePath: string) => {
		openFile(filePath);
	};

	return {
		runTests: mutation.mutate,
		runTestsAsync: mutation.mutateAsync,
		isRunning: mutation.isPending,
		error: mutation.error,
		openTestFile,
	};
}
