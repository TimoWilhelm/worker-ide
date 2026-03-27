# Git Auxiliary Worker

R2-backed Git storage backend for the worker-ide project. Provides Git Smart HTTP v2 protocol support, durable object storage with R2 offloading, and a typed RPC interface for the main IDE worker.

## Attribution

This worker is adapted from [git-on-cloudflare](https://github.com/zllovesuki/git-on-cloudflare) by ([@zllovesuki](https://github.com/zllovesuki)), licensed under the MIT License.

The original project implements a complete Git Smart HTTP v2 server running on Cloudflare Workers with Durable Objects and R2 storage. Key modules carried over and adapted include:

- **Git protocol** (`git/core/`) — pkt-line encoding, object serialization, capability advertisement
- **Pack operations** (`git/pack/`) — pack assembly, streaming, indexing, unpacking
- **Repository DO** (`do/repo/`) — ref management, two-tier DO+R2 storage, background maintenance
- **Fetch/upload-pack** (`git/operations/`) — pack negotiation, closure computation, streaming fetch

Modifications from the original:

- Removed web UI, auth DO, owner registry, and React SSR layers
- Added `commitTree()` RPC for direct-write commits (no git client needed)
- Added `materializeTree()` RPC for working tree reconstruction
- Added ephemeral branch support (`refs/ephemeral/*`)
- Added JWT authentication for external git access
- Added Cloudflare Queue integration for push event notifications
- Replaced `itty-router` with Hono for consistency with the main worker
- Adapted import paths and Env types to fit the auxiliary worker pattern

## Architecture

```
External git clients ──── Git Smart HTTP v2 ────► GitWorker (WorkerEntrypoint)
                                                       │
                                                       ▼
Main IDE Worker ──── cross-worker DO binding ───► RepoDurableObject
                     (env.REPO_DO)                     │
                                                       ▼
                                                  R2 Bucket
                                                  (packfiles, loose objects, .idx)
```

## License

MIT — see the root LICENSE file and the [original project license](https://github.com/zllovesuki/git-on-cloudflare/blob/main/LICENSE).
