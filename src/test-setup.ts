/**
 * Test Setup for React component tests.
 *
 * Configures jsdom environment and testing library matchers.
 */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '@testing-library/jest-dom/vitest';

// jsdom does not implement several DOM methods used by components, so we stub them globally.
Element.prototype.scrollIntoView = () => {};
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

// React Testing Library v16+ does not auto-register cleanup for Vitest.
// Without this, rendered DOM nodes accumulate across tests within the same file,
// causing "Found multiple elements" errors.
afterEach(() => {
	cleanup();
});
