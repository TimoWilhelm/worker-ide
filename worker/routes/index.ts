/**
 * API Routes barrel export and type definition.
 * Combines all route modules for the Hono RPC type inference.
 */

import { Hono } from 'hono';

import { aiRoutes } from './ai-routes';
import { fileRoutes } from './file-routes';
import { gitRoutes } from './git-routes';
import { projectRoutes } from './project-routes';
import { sessionRoutes } from './session-routes';
import { snapshotRoutes } from './snapshot-routes';
import { transformRoutes } from './transform-routes';

import type { AppEnvironment } from '../types';

/**
 * Combined API routes with full type information for Hono RPC.
 * All routes are prefixed with /api by the main app.
 */
export const apiRoutes = new Hono<AppEnvironment>()
	.route('', fileRoutes)
	.route('', projectRoutes)
	.route('', sessionRoutes)
	.route('', snapshotRoutes)
	.route('', aiRoutes)
	.route('', transformRoutes)
	.route('', gitRoutes);

/**
 * Export the full API routes type for client-side type inference.
 * This type is used by the Hono RPC client to provide type-safe API calls.
 */
export type ApiRoutes = typeof apiRoutes;

// Re-export individual route modules
export { aiRoutes } from './ai-routes';
export { fileRoutes } from './file-routes';
export { projectRoutes } from './project-routes';
export { sessionRoutes } from './session-routes';
export { snapshotRoutes } from './snapshot-routes';
export { gitRoutes } from './git-routes';
export { transformRoutes } from './transform-routes';
