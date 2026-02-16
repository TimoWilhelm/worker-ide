/**
 * Landing Page Feature
 *
 * Exports the landing page as a lazy-loaded component to keep the
 * halftone shader and landing UI out of the main IDE bundle.
 */

import { lazy } from 'react';

export const LandingPage = lazy(() => import('./landing-page'));
