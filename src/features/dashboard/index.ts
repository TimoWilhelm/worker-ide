/**
 * Dashboard Page Feature
 *
 * Exports the dashboard page as a lazy-loaded component to keep the
 * halftone shader and dashboard UI out of the main IDE bundle.
 */

import { lazy } from 'react';

export const DashboardPage = lazy(() => import('./dashboard-page'));
