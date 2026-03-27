/**
 * Git Auxiliary Worker
 *
 * R2-backed Git storage backend for worker-ide. Provides:
 * - Git Smart HTTP v2 protocol (clone, fetch, push) for external clients
 * - RepoDurableObject with RPC methods for the main IDE worker
 *
 * The main worker accesses RepoDO via a cross-worker Durable Object binding
 * (env.REPO_DO with script_name: "git-worker"). External git clients connect
 * via Smart HTTP v2 at git.<domain>/<owner>/<repo>.
 *
 * Adapted from git-on-cloudflare (https://github.com/zllovesuki/git-on-cloudflare).
 */

import { gitRoutes } from '@git/routes/git-routes';
import { Hono } from 'hono';

type GitHonoEnvironment = { Bindings: GitWorkerEnvironment };

const app = new Hono<GitHonoEnvironment>();

// Health check
app.get('/health', (context) => context.json({ status: 'ok', worker: 'git-worker' }));

// Mount git Smart HTTP v2 routes
app.route('/', gitRoutes);

// 404 fallback
app.all('*', (context) => context.text('Not found\n', 404));

export default {
	fetch: app.fetch,
};

// Export the Durable Object class for cross-worker binding
export { RepoDurableObject } from '@git/do/repo/repo-do';
