import { lazy } from 'react';

export { default as SettingsLayout } from './settings-layout';
export const ProfilePage = lazy(() => import('./profile-page'));
export const AccountPage = lazy(() => import('./account-page'));
export const AppearancePage = lazy(() => import('./appearance-page'));
