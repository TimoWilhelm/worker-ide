/**
 * Settings Feature
 *
 * Exports settings pages as lazy-loaded components.
 */

import { lazy } from 'react';

export const SettingsLayout = lazy(() => import('./settings-layout'));
export const ProfilePage = lazy(() => import('./profile-page'));
export const AccountPage = lazy(() => import('./account-page'));
export const AppearancePage = lazy(() => import('./appearance-page'));
