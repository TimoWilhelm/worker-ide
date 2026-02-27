import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig } from 'vite';
import { defineConfig as defineVitestConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(dirname, '../');

export default mergeConfig(
	defineConfig({
		plugins: [
			react(),
			storybookTest({
				configDir: path.join(projectRoot, '.storybook'),
				storybookScript: 'bun run storybook --ci',
			}),
		],
		resolve: {
			alias: {
				'@': path.join(projectRoot, 'src'),
				'@shared': path.join(projectRoot, 'shared'),
				'virtual:pwa-register/react': path.join(projectRoot, '.storybook/mock-pwa.ts'),
			},
		},
		define: {
			__APP_VERSION__: '"storybook"',
		},
		optimizeDeps: {
			include: ['react-dom/client'],
		},
	}),
	defineVitestConfig({
		test: {
			name: 'storybook',
			browser: {
				enabled: true,
				headless: true,
				provider: 'playwright',
				instances: [{ browser: 'chromium' }],
			},
			setupFiles: [path.join(projectRoot, '.storybook/vitest.setup.ts')],
		},
	}),
);
