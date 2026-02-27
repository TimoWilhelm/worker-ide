import { setProjectAnnotations } from '@storybook/react-vite';
import { beforeAll, vi } from 'vitest';

import * as previewAnnotations from './preview';

vi.mock('virtual:pwa-register/react', () => ({
	useRegisterSW: () => ({
		needRefresh: [false, () => {}],
		offlineReady: [false, () => {}],
		updateServiceWorker: () => {},
	}),
}));

const annotations = setProjectAnnotations([previewAnnotations]);

// Run Storybook's beforeAll hook
beforeAll(annotations.beforeAll);
