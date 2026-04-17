import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
	baseURL: globalThis.location?.origin ?? '',
	plugins: [organizationClient()],
});
