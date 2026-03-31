/**
 * Settings Feature
 *
 * SettingsLayout is eagerly imported so it persists across settings
 * sub-page navigations (the sidebar/header never unmount).
 * Individual page components remain lazy-loaded — only the content
 * area shows a skeleton while the chunk loads.
 */

import { lazy } from 'react';

export { default as SettingsLayout } from './settings-layout';
export const ProfilePage = lazy(() => import('./profile-page'));
export const AccountPage = lazy(() => import('./account-page'));
export const AppearancePage = lazy(() => import('./appearance-page'));
