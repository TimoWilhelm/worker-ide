# Agents.md

This document is a collection of guidelines for agents working on the project.

## Definition of Done

- [ ] If you made significant changes, add appropriate tests (unit, integration, e2e, storybook) to cover them.
- [ ] You ran `bun run format` to format the code and it passes with no errors.
- [ ] You ran `bun run typecheck` to check for type errors and it passes with no errors.
- [ ] You ran `bun run knip` to check for unused dependencies, exports and files and it passes with no errors.
- [ ] You ran `bun run test:unit --run` to run unit tests and it passes with no errors.
- [ ] You ran `bun run test:react --run` to run React component tests and it passes with no errors.
- [ ] You ran `bun run test:e2e` to run end-to-end tests and it passes with no errors.
- [ ] You checked the `README.md` to make sure it is up to date.

## Coding Conventions

- All file names must use kebab-case (e.g., `my-component.tsx`, `api-client.ts`).
- Use TypeScript for all code.
- Use early returns when possible.
- Follow existing code patterns in the codebase.
- Always use the `cn` utility from `@/lib/utils` when merging or applying conditional classes.
- Use `undefined` instead of `null` (`unicorn/no-null` ESLint rule enforced). Exception: WebSocket wire format types in `shared/types.ts`.
- No `as` type assertions (`@typescript-eslint/consistent-type-assertions` enforced).
- No `forwardRef` — use React 19 ref-as-prop pattern.
- No abbreviated variable names (`unicorn/prevent-abbreviations` enforced). Use `AppEnvironment` not `AppEnv`, `properties` not `props` (in non-React contexts), etc.
- Install all dependencies as devDependencies (`bun add -d`) since everything is bundled with Vite.
- Use `bun` as the package manager (not npm/yarn/pnpm).

## React Best Practices

- If you can calculate something during render, you don't need an Effect.
- To cache expensive calculations, add useMemo instead of useEffect.
- To reset the state of an entire component tree, pass a different key to it.
- To reset a particular bit of state in response to a prop change, set it during rendering.
- Code that runs because a component was displayed should be in Effects, the rest should be in events.
- If you need to update the state of several components, it's better to do it during a single event.
- Whenever you try to synchronize state variables in different components, consider lifting state up.
- You can fetch data with Effects, but you need to implement cleanup to avoid race conditions.

## Project Structure

- **Group by Feature**: Organize files by feature, not type. Code that changes together stays together.
- **Reusable Components**: Place strictly reusable UI components in `src/components/ui/`.
- **Feature Modules**: Each part of the IDE has its own folder in `src/features/` containing its specific components, hooks, and utilities.
- Colocate unit tests with the code they test.
- E2E tests remain in `test/e2e/` directory.

## Directories

- `src/` - React app sources.
  - `components/` - Reusable UI components (e.g., `error-boundary`, `ui/button`).
  - `features/` - Feature-based modules (e.g., `editor/`, `file-tree/`, `preview/`, `terminal/`, `ai-assistant/`, `snapshots/`).
  - `lib/` - Shared utilities and libraries (`store.ts`, `api-client.ts`, `utils.ts`).
  - `hooks/` - Shared global hooks.
- `worker/` - Cloudflare Worker (API routes, Durable Objects, services).
- `shared/` - Shared code between frontend and worker (types, constants, validation, errors).
- `test/` - E2E tests.
- `.storybook/` - Storybook configuration.

## Tech Stack

### Frontend

- React 19 with TypeScript.
- Tailwind CSS v4 for styling.
- Zustand for client state management (6 slices + persist middleware).
- CodeMirror 6 for the code editor.
- Hono RPC client for type-safe API calls.
- TanStack AI (`@tanstack/ai-react`, `@tanstack/ai-client`) for the AI chat UI.

### Backend

- Cloudflare Workers with Hono framework.
- Cloudflare Durable Objects for filesystem and project coordination.
- WebSockets (hibernation API) for real-time communication.
- Durable Objects SQLite for storage.
- TanStack AI (`@tanstack/ai`) for the AI agent loop and AG-UI streaming protocol.

### Build and Tooling

- Package manager: bun (use bun commands, not npm/yarn/pnpm).
- Build tool: Vite with @cloudflare/vite-plugin.
- Dev server: `bun run dev` (runs at localhost:3000).
- Turborepo for task caching (`turbo.json`).
- Install all dependencies as dev dependencies (`bun add -d`) since they are bundled with Vite.

## Testing & Quality

- Unit tests: Vitest (`bun run test:unit --run`).
- React component tests: Vitest + jsdom (`bun run test:react --run`).
- E2E tests: Playwright (`bun run test:e2e`).
- Storybook: Component documentation (`bun run storybook`).
- Linting: ESLint (`bun run lint`).
- Formatting: Prettier (`bun run format`).
- Report unused dependencies: Knip (`bun run knip`).
- Type checking: TypeScript (`bun run typecheck`).

## AI Architecture

The AI assistant uses **TanStack AI** with the **AG-UI streaming protocol** across the full stack.

### Key Packages

- `@tanstack/ai` (backend) — `chat()`, `toServerSentEventsResponse()`, `convertMessagesToModelMessages()`, `toolDefinition()`, `maxIterations()`, `BaseTextAdapter`.
- `@tanstack/ai-react` (frontend) — `useChat()` hook for managing chat state and streaming.
- `@tanstack/ai-client` (frontend) — `fetchServerSentEvents()` connection adapter, `UIMessage` type.

### LLM Provider

- API calls go through **Replicate** (not directly to Anthropic). The `REPLICATE_API_TOKEN` binding is required.
- Model IDs use Replicate format: `"anthropic/claude-4.5-haiku"`.
- A custom adapter (`worker/services/ai-agent/replicate/adapter.ts`) extends `BaseTextAdapter` from `@tanstack/ai/adapters`.
- Do **not** use `@tanstack/ai-anthropic`

### Backend Agent Loop

- `worker/services/ai-agent/service.ts` — Async generator (`createAgentStream()`) wraps `chat()` calls in a manual outer loop with `maxIterations(1)` per call for doom-loop detection and snapshot management.
- `toServerSentEventsResponse()` converts the async iterable of `StreamChunk` (AG-UI events) into an SSE `Response`.
- App-specific events (snapshot_created, file_changed, plan_created, user_question, status, usage, max_iterations_reached, turn_complete) are injected as **CUSTOM AG-UI events**: `{ type: 'CUSTOM', name: string, data?: unknown, timestamp: number }`.
- Tool executors push CUSTOM events to a shared `CustomEventQueue` array (synchronous push, drained by the generator).
- Tools are defined with `toolDefinition()` from `@tanstack/ai`.


## Important Notes

- The `@server/*` path alias resolves to `./worker/*` at build time.
- `node:fs/promises` is aliased to `worker-fs-mount/fs` at build time
- The global `Env` interface from `worker-configuration.d.ts` (generated by `bunx wrangler types`) is used for worker bindings.
- `AppEnvironment` in `worker/types.ts` references `Env` for its `Bindings`.
