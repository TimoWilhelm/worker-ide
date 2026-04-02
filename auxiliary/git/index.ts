/**
 * Git Auxiliary Worker
 *
 * R2-backed Git storage backend for worker-ide. Provides:
 * - Git Smart HTTP v2 protocol (clone, fetch, push) for external clients
 * - RepoDurableObject with RPC methods for the main IDE worker
 * - JWT signing RPC for git credential generation
 *
 * The main worker accesses RepoDO via a cross-worker Durable Object binding
 * (env.REPO_DO with script_name: "git-worker"). External git clients connect
 * via Smart HTTP v2 at git.<domain>/<owner>/<repo>.
 *
 * Adapted from git-on-cloudflare (https://github.com/zllovesuki/git-on-cloudflare).
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';

import { signGitJwt } from '@git/auth/jwt-sign';
import { gitRoutes } from '@git/routes/git-routes';

type GitHonoEnvironment = { Bindings: GitWorkerEnvironment };

const app = new Hono<GitHonoEnvironment>();

// Health check
app.get('/health', (context) => context.json({ status: 'ok', worker: 'git-worker' }));

// Mount git Smart HTTP v2 routes
app.route('/', gitRoutes);

// 404 fallback
app.all('*', (context) => context.text('Not found\n', 404));

export default class GitWorker extends WorkerEntrypoint<GitWorkerEnvironment> {
	fetch(request: Request): Response | Promise<Response> {
		return app.fetch(request, this.env, this.ctx);
	}

	async signJwt(options: { sub: string; scopes: string[] }): Promise<{ token: string; expiresAt: string }> {
		return signGitJwt(this.env.JWT_PRIVATE_KEY, options);
	}
}

// Export the Durable Object class for cross-worker binding
export { RepoDurableObject } from '@git/do/repo/repo-do';
