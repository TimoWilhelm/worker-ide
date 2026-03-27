/**
 * Organization Feature
 *
 * Exports org-related components. The management page is lazy-loaded
 * to keep it out of the main IDE bundle.
 */

import { lazy } from 'react';

export const OrgManagementPage = lazy(() => import('./org-management-page'));
