/**
 * Playwright Global Setup & Teardown
 *
 * Calls the dev-only `/__test/cleanup` endpoint before and after the
 * entire E2E test suite to ensure no leftover test projects remain,
 * even if a prior run was interrupted.
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function cleanupServer(): Promise<void> {
	try {
		await fetch(`${BASE_URL}/__test/cleanup`, { method: 'POST' });
	} catch {
		// Server may not be reachable yet (setup) or already stopped (teardown)
	}
}

export default async function globalSetup(): Promise<() => Promise<void>> {
	// Clean up leftover projects from prior interrupted runs
	await cleanupServer();

	// Return teardown function
	return async () => {
		await cleanupServer();
	};
}
