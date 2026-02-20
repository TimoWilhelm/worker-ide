# Worker-IDE

A browser-based full-stack development environment built on Cloudflare Workers. User projects are stored in Durable Object-backed filesystems with full Git support, transformed on-the-fly with esbuild-wasm, and previewed with HMR. Includes an AI coding assistant powered by TanStack AI and Replicate.

## Architecture

### Frontend (`src/`)

- React 19, Tailwind CSS v4, Zustand for state, CodeMirror 6 for the editor.
- TanStack AI for AI chat with AG-UI streaming. Hono RPC for type-safe API calls.
- Features organized by domain under `src/features/`.

### Backend (`worker/`)

- Cloudflare Workers with Hono. Two Durable Objects: one for per-project file storage (SQLite-backed, with Git via `isomorphic-git`) and one for WebSocket coordination (HMR, collaboration).
- User backend code runs in isolated V8 isolates via Cloudflare's [Dynamic Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) API.
- AI agent with TanStack AI, streaming via AG-UI custom events.

### Shared (`shared/`)

Types, constants, validation, and WebSocket message definitions shared between frontend and worker.

## Prerequisites

- [Bun](https://bun.sh) v1.3.9+
- A Cloudflare account (for deployment)

## Getting Started

```bash
bun install
bun run dev        # Vite dev server + worker at localhost:3000
```

## Scripts

| Script        | Description                                                      |
| ------------- | ---------------------------------------------------------------- |
| `dev`         | Vite dev server with Cloudflare Worker (port 3000)               |
| `build`       | Production build via Turborepo                                   |
| `deploy`      | Build and deploy to Cloudflare                                   |
| `typecheck`   | Run all TypeScript type checks (app, node, worker)               |
| `lint`        | Check formatting (Prettier) and lint (ESLint)                    |
| `format`      | Auto-fix formatting and lint issues                              |
| `test:unit`   | Unit tests (Node env)                                            |
| `test:worker` | Worker tests (workerd env via `@cloudflare/vitest-pool-workers`) |
| `test:react`  | React component tests (jsdom env)                                |
| `test:e2e`    | End-to-end tests (Playwright, Chromium)                          |
| `knip`        | Check for unused dependencies, exports, and files                |
| `storybook`   | Storybook dev server (port 6006)                                 |
| `cf-typegen`  | Generate worker type bindings (`worker-configuration.d.ts`)      |

## Path Aliases

| Alias              | Resolves to          |
| ------------------ | -------------------- |
| `@/*`              | `./src/*`            |
| `@shared/*`        | `./shared/*`         |
| `@server/*`        | `./worker/*`         |
| `node:fs/promises` | `worker-fs-mount/fs` |
