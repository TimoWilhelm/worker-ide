/**
 * better-auth React Client
 *
 * Provides type-safe auth hooks and methods for the frontend.
 * Includes the organization client plugin for org management.
 */

import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
	baseURL: globalThis.location?.origin ?? '',
	plugins: [organizationClient()],
});
