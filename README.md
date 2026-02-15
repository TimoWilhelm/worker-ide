# Worker-IDE

A Cloudflare Worker that serves as a browser-based full-stack development environment. User projects are stored in Durable Object-backed filesystems, transformed on-the-fly with esbuild-wasm, and previewed with HMR support.

## Architecture

- **`src/index.ts`** — Worker entrypoint. Routes static assets, project CRUD APIs (`/api/*`), and per-project preview/HMR (`/p/:id/*`).
- **`DurableObjectFilesystem`** — Persists project files in DO SQLite storage (via `durable-object-fs`).
- **`ProjectCoordinator`** — Durable Object that manages WebSocket connections for HMR update broadcasts, real-time collaboration, and server event forwarding.
- **`src/bundler.ts`** / **`src/transform.ts`** — esbuild-wasm powered bundling and module transformation (TS → JS, CSS → JS modules, import rewriting).
- **`scripts/dev.ts`** — Optional local Vite dev server that proxies files from the Worker's DO filesystem for a native HMR experience.
- **`public/`** — Static frontend (editor UI) served via Workers Assets.

## Dynamic Worker Isolates

User-authored backend code (the `worker/` directory inside each project) is executed via Cloudflare's [Dynamic Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) API. Instead of bundling user code into the host Worker, the platform spawns a **separate V8 isolate on-demand** for each project's server-side logic.

### How it works

1. When a request hits `/p/:id/preview/api/*`, the host Worker reads the project's `worker/` files from the Durable Object filesystem and transforms them (TS → JS, import rewriting) via esbuild-wasm.
2. The transformed modules are passed to `env.LOADER.get(id, callback)`, which returns a `WorkerStub` backed by a fresh isolate. The isolate ID is derived from a content hash of the worker source, so code changes automatically produce a new isolate while unchanged code reuses a cached one.
3. The host Worker calls `worker.getEntrypoint().fetch(request)` to forward the API request into the dynamic isolate, which runs the user's `worker/index.ts` default export.

See `src/index.ts` → `handlePreviewAPI` for the full implementation.

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

| Script        | Description                                             |
| ------------- | ------------------------------------------------------- |
| `dev`         | Run the Worker locally with `wrangler dev`              |
| `dev:preview` | Start the Vite dev server that reads from DO filesystem |
| `dev:all`     | Run both concurrently                                   |
| `build`       | Vite production build                                   |
| `deploy`      | Build and deploy to Cloudflare                          |
| `cf-typegen`  | Generate Worker type bindings                           |

## Key Bindings (wrangler)

| Binding                  | Type           | Purpose                  |
| ------------------------ | -------------- | ------------------------ |
| `DO_FILESYSTEM`          | Durable Object | Per-project file storage |
| `DO_PROJECT_COORDINATOR` | Durable Object | WebSocket coordination   |
| `ASSETS`                 | Assets         | Static frontend assets   |
| `LOADER`                 | Worker Loader  | Worker module loading    |
