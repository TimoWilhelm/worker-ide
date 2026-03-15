import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
	testDir: './test/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: [['html', { open: 'never' }]],
	use: {
		baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	webServer: process.env.CI
		? undefined
		: {
				command: 'npm run dev',
				url: 'http://localhost:3000',
				reuseExistingServer: true,
				timeout: 120_000,
			},
});
