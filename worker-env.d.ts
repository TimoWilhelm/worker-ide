/**
 * Manual type augmentations for service bindings that are not auto-generated
 * by `wrangler types`. Auxiliary workers configured via the Cloudflare Vite
 * plugin's `auxiliaryWorkers` option are not picked up by `wrangler types`,
 * so their service binding types must be declared here.
 *
 * This file extends the auto-generated `Cloudflare.Env` from
 * `worker-configuration.d.ts` without modifying it.
 */

import type BiomeWorker from './auxiliary/biome/index';

declare global {
	namespace Cloudflare {
		interface Env {
			BIOME: Service<typeof BiomeWorker>;
		}
	}
}
