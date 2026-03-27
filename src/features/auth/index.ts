/**
 * Auth Feature
 *
 * Exports the login page as a lazy-loaded component.
 */

import { lazy } from 'react';

export const LoginPage = lazy(() => import('./login-page'));
