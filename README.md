# vite-worker

A Cloudflare Worker that serves as a browser-based full-stack development environment. User projects are stored in Durable Object-backed filesystems, transformed on-the-fly with esbuild-wasm, and previewed with HMR support.

## Architecture

- **`src/index.ts`** — Worker entrypoint. Routes static assets, project CRUD APIs (`/api/*`), and per-project preview/HMR (`/p/:id/*`).
- **`DurableObjectFilesystem`** — Persists project files in DO SQLite storage (via `durable-object-fs`).
- **`HMRCoordinator`** — Durable Object that manages WebSocket connections and broadcasts HMR updates to connected clients.
- **`src/bundler.ts`** / **`src/transform.ts`** — esbuild-wasm powered bundling and module transformation (TS → JS, CSS → JS modules, import rewriting).
- **`scripts/dev.ts`** — Optional local Vite dev server that proxies files from the Worker's DO filesystem for a native HMR experience.
- **`public/`** — Static frontend (editor UI) served via Workers Assets.

## Prerequisites

- [Bun](https://bun.sh) (or Node ≥ 18)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) v4+

## Getting Started

```bash
# Install dependencies
bun install

# Start the Worker locally
bun run dev

# Or run both the Worker and the Vite preview dev server
bun run dev:all
```

## Scripts

| Script | Description |
|---|---|
| `dev` | Run the Worker locally with `wrangler dev` |
| `dev:preview` | Start the Vite dev server that reads from DO filesystem |
| `dev:all` | Run both concurrently |
| `build` | Vite production build |
| `deploy` | Build and deploy to Cloudflare |
| `cf-typegen` | Generate Worker type bindings |

## Key Bindings (wrangler)

| Binding | Type | Purpose |
|---|---|---|
| `DO_FILESYSTEM` | Durable Object | Per-project file storage |
| `DO_HMR_COORDINATOR` | Durable Object | WebSocket HMR broadcast |
| `ASSETS` | Assets | Static frontend assets |
| `LOADER` | Worker Loader | Worker module loading |
