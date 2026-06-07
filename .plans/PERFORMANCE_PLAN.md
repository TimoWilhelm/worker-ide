# worker-ide Runtime Performance & Reliability Plan

This plan focuses on making the IDE feel local-first during active use: cached file reads, optimistic/durable saves, granular UI subscriptions, offline editing, and robust WebSocket recovery.

## Scope

This document intentionally excludes first-load/app-shell work and animation polish. It focuses only on the runtime behavior that maps most directly to Linear's "database in the browser," "mutations don't wait for the network," and "one delta, one cell" principles.

## Current-state summary

- **File content is treated as immediately stale.** `src/features/editor/hooks/use-file-content.ts` uses `staleTime: 0`, so opening or switching files tends to prefer a network round-trip even though the WebSocket already pushes file updates.
- **Saves are confirmed before local cache update.** `saveFile` waits for the API mutation to succeed before writing the saved content into the TanStack Query cache.
- **Failed saves are not durable.** The UI says changes are preserved locally, but there is no persisted outbound queue that survives reload and flushes later.
- **The WebSocket already has useful deltas.** `src/hooks/use-project-socket.ts` handles `file-edited`, `update`, `full-reload`, test result, git, and collaboration messages, but reconnect does not explicitly reconcile missed state.
- **The Zustand store is broad.** `src/lib/store.ts` combines editor, file tree, agent, collaboration, snapshots, pending changes, UI, identity, and git state; broad subscriptions can turn small deltas into larger render work.

---

## 1. Make file/project data already available

### 1.1 Change file content from network-first to cache-first-with-socket-hydration

**Goal:** Opening a file, switching tabs, or returning to a recently opened file should show known content immediately and only refetch when there is a clear reason.

**Implementation details:**

- Update `src/features/editor/hooks/use-file-content.ts` so file queries use a non-zero `staleTime` instead of `staleTime: 0`.
- Keep the query key shape as `['file', projectId, path]` so existing socket handlers continue to target the same cache entries.
- Treat WebSocket updates as the primary freshness mechanism:
  - `file-edited` should continue to call `queryClient.setQueryData(['file', projectId, path], { path, content })`.
  - `update` and `full-reload` should continue invalidating changed inactive files.
  - The active file should still avoid forced refetches that could race with unsaved editor content.
- Consider `gcTime` separately from `staleTime` so recently opened files remain available for fast tab switching without keeping the entire project in memory forever.
- Keep error behavior unchanged: if a file is not in cache and the fetch fails, show the current error UI/toast path.

**Files to change:**

- `src/features/editor/hooks/use-file-content.ts`
- `src/hooks/use-project-socket.ts` only if socket cache updates need small adjustments

**Tests to add/update:**

- A cached file query should serve content without immediately refetching on remount within `staleTime`.
- A `file-edited` socket message should update the same query key used by `useFileContent`.
- An inactive file update should invalidate/refetch normally.
- The active file should not be overwritten by a background invalidation while it has unsaved local edits.

**Risks and mitigations:**

- **Risk:** stale file content after missed WebSocket messages.
  - **Mitigation:** add reconnect reconciliation in section 4.
- **Risk:** too much cached content for large projects.
  - **Mitigation:** tune `gcTime` and only prefetch targeted files in section 1.2.

### 1.2 Prefetch the file tree and recently opened files on project mount

**Goal:** The first click on a likely-needed file should avoid a spinner whenever possible.

**Implementation details:**

- Reuse the existing per-project persisted session in `src/lib/project-storage.ts` to identify likely files:
  - active file
  - open tabs
  - recently restored editor session entries
- In `src/components/ide-shell/ide-shell.tsx` or a colocated hook, prefetch:
  - the file tree query used by `useFileTree`
  - the active file first
  - the remaining open files afterward, ideally in a small concurrency-limited queue
- Avoid prefetching every file in the project. The goal is data-level code splitting: hydrate likely data, not the whole filesystem.
- Respect project changes by scoping all prefetch work to `projectId` and aborting/ignoring old work when `projectId` changes.

**Files to change:**

- `src/components/ide-shell/ide-shell.tsx`
- `src/components/ide-shell/use-editor-session-persistence.ts`
- `src/lib/project-storage.ts`
- `src/features/file-tree/*` only if the file tree query API needs to be exposed for prefetching

**Tests to add/update:**

- Mounting a project should prefetch the file tree.
- Restored active/open files should be prefetched with the correct query keys.
- Switching projects should not write old prefetch results into the new project's state.

**Risks and mitigations:**

- **Risk:** prefetch competes with more important startup work.
  - **Mitigation:** prefetch active file immediately, defer secondary open files until after initial render.
- **Risk:** unnecessary API calls for large restored sessions.
  - **Mitigation:** cap the number of prefetched files and prioritize active/recent files.

---

## 2. Make mutations optimistic and durable

### 2.1 Make file saves optimistic

**Goal:** Pressing save should update local app state immediately. The server should confirm the mutation in the background instead of controlling perceived responsiveness.

**Implementation details:**

- Update `src/features/editor/hooks/use-file-content.ts` to use TanStack Query's optimistic mutation flow:
  - `onMutate`: cancel in-flight queries for `['file', projectId, path]`.
  - Snapshot the previous cached file content.
  - Immediately call `queryClient.setQueryData(['file', projectId, path], { path, content })`.
  - Return the snapshot as rollback context.
  - `onError`: restore the previous cache only when the failed save is still the latest known save for that file.
  - `onSuccess`: keep the optimistic content unless the server returns a more authoritative version.
- Preserve existing editor behavior for unsaved markers. Optimistic query cache updates should not incorrectly mark a file clean if the editor buffer has changed again while the request was in flight.
- Keep the existing user-facing save failure toast, but make it point to the durable queue once section 2.2 exists.

**Files to change:**

- `src/features/editor/hooks/use-file-content.ts`
- `src/lib/store.ts` only if save state/unsaved state needs a selector/action refinement

**Tests to add/update:**

- Saving a file should update the query cache before the API promise resolves.
- A failed save should roll back to the previous cache value when no newer save exists.
- A failed older save should not roll back a newer successful/optimistic save.
- The user-facing toast should still appear on failure.

**Risks and mitigations:**

- **Risk:** rollback overwrites newer edits.
  - **Mitigation:** tag saves with a monotonic client-side sequence per `projectId:path` and only roll back if the failed sequence is current.
- **Risk:** cache says saved while editor buffer has diverged.
  - **Mitigation:** keep editor dirty-state checks based on editor/session state, not only query cache state.

### 2.2 Add a persisted save queue

**Goal:** Failed/offline saves should survive reload and automatically flush later.

**Implementation details:**

- Add `src/lib/save-queue.ts` for a small persisted queue keyed by `projectId` and file path.
- Queue entry shape should include:
  - `projectId`
  - `path`
  - `content`
  - `createdAt`
  - `updatedAt`
  - `attemptCount`
  - a client-generated `operationId`
- Dedupe by `projectId:path`: if the same file is saved repeatedly while offline, keep only the latest content and update `updatedAt`/`operationId`.
- Prefer IndexedDB if implementation complexity is acceptable; otherwise use `localStorage` as a first pass because this queue is small and text-only.
- Expose functions such as:
  - `enqueueSave(entry)`
  - `removeQueuedSave(projectId, path, operationId)`
  - `listQueuedSaves(projectId?)`
  - `flushQueuedSaves({ projectId, save })`
- Keep the queue framework independent from React so it can be tested without rendering hooks.

**Files to add/change:**

- `src/lib/save-queue.ts`
- `src/lib/save-queue.test.ts`
- `src/features/editor/hooks/use-file-content.ts`

**Tests to add/update:**

- Enqueue persists an entry.
- Enqueue for the same `projectId:path` dedupes to the latest content.
- Successful flush removes the queued entry.
- Failed flush increments `attemptCount` and keeps the entry.
- Corrupt persisted data is ignored or safely reset.

**Risks and mitigations:**

- **Risk:** queued data grows unbounded.
  - **Mitigation:** dedupe per file and optionally cap queue size per project.
- **Risk:** queued content becomes stale relative to remote collaborator changes.
  - **Mitigation:** section 4 reconciliation should refetch authoritative state after flushing; conflict UI can be a later enhancement if needed.

### 2.3 Flush queued saves on reconnect and app/project mount

**Goal:** The queue should disappear without user intervention once the network and project socket are healthy again.

**Implementation details:**

- Trigger queue flushing from two places:
  - after WebSocket `onOpen` in `src/hooks/use-project-socket.ts`
  - when the app returns online via the existing online/offline hooks/components
- Use the typed Hono RPC client (`createApiClient(projectId)`) for file save calls; do not use raw `fetch`.
- Flush only entries for the current project from the project socket hook.
- Rate-limit or serialize flushes per project to avoid overlapping writes for the same file.
- After a queued save succeeds:
  - remove it from the queue
  - update `['file', projectId, path]` with the flushed content
  - invalidate git status if file changes affect git state
- After a queued save fails:
  - keep it in the queue
  - increment attempt count
  - avoid infinite tight loops; retry on next reconnect/online event or with backoff

**Files to change:**

- `src/hooks/use-project-socket.ts`
- `src/hooks/use-online-status.ts`
- `src/components/offline-banner/*` if queue status should be shown there
- `src/lib/save-queue.ts`

**Tests to add/update:**

- Queue flush runs when the socket opens.
- Queue flush does not run when the socket is disabled/unmounted.
- Queue flush uses the typed API client.
- Failed flush remains queued and does not spin.
- Successful flush updates the query cache and removes the queue entry.

**Risks and mitigations:**

- **Risk:** flush conflicts with a manual save in progress.
  - **Mitigation:** serialize per file and use operation IDs to avoid removing newer queued work after an older response.
- **Risk:** reconnect immediately after wake triggers too much work.
  - **Mitigation:** flush current project first; defer broader cross-project flushing.

---

## 3. Reduce cascading renders from small deltas

### 3.1 Replace broad Zustand subscriptions with narrow selectors

**Goal:** A single collaboration, git, file, or pending-change update should re-render only components that read that exact state.

**Implementation details:**

- Audit calls to `useStore()` across `src/`.
- Replace whole-store destructures with narrow selectors:
  - use `useStore((state) => state.someAction)` for one action
  - use `useShallow` for small grouped selectors
  - add exported selectors in `src/lib/store.ts` for reused derived values
- Prioritize hot paths first:
  - editor shell/layout
  - file tree rows
  - git status indicators
  - collaboration participants/cursors
  - pending AI changes
  - output/log counters
- Avoid selectors that allocate new arrays/maps on every call unless wrapped in memoization or `useShallow`.

**Files to inspect/change:**

- `src/lib/store.ts`
- `src/components/ide-shell/*`
- `src/features/file-tree/*`
- `src/features/git/*`
- `src/features/editor/*`
- `src/features/snapshots/hooks/use-snapshots.ts`
- `src/features/agent/*`

**Tests to add/update:**

- Existing component tests should continue passing.
- Add focused tests for selectors with derived values where useful.
- If practical, add render-count regression tests around file tree/git rows for unrelated store updates.

**Risks and mitigations:**

- **Risk:** selector refactors accidentally change behavior.
  - **Mitigation:** refactor incrementally by feature and keep existing tests green after each group.
- **Risk:** too many tiny selectors reduce readability.
  - **Mitigation:** export named selectors for common concepts and group only stable related values with `useShallow`.

### 3.2 Keep WebSocket cache updates granular

**Goal:** Socket deltas should update the smallest relevant cache/store entry, not invalidate broad app state unless necessary.

**Implementation details:**

- Review `src/hooks/use-project-socket.ts` message handling.
- Keep direct `setQueryData` for messages that already contain complete authoritative data, such as `file-edited` and `test-results-changed`.
- Use query invalidation only when the socket message does not include enough data to patch locally.
- Avoid invalidating the entire file list for every content-only file edit unless the message represents structural changes (create/delete/move/full reload).
- Separate structural file changes from content changes if the current message shape supports it; if not, document the limitation and defer protocol changes.

**Files to inspect/change:**

- `src/hooks/use-project-socket.ts`
- shared WebSocket message types under `shared/` if message shape changes are needed
- worker-side socket broadcast code under `worker/` if protocol changes are needed

**Tests to add/update:**

- Content-only file update should patch the file cache without forcing broad file-tree invalidation when possible.
- Structural updates should still refresh the file tree.
- Test-result deltas should preserve existing merge behavior.

**Risks and mitigations:**

- **Risk:** under-invalidating misses created/deleted files.
  - **Mitigation:** only narrow invalidation when the message clearly indicates a content-only update.
- **Risk:** protocol changes touch worker and frontend.
  - **Mitigation:** prefer frontend-only improvements first; only change shared message types if necessary.

---

## 4. Harden offline and reconnect behavior

### 4.1 Make offline read/edit an explicit supported mode

**Goal:** When the network drops, users can continue reading cached files and editing open files, with clear feedback that saves are queued.

**Implementation details:**

- Combine cached file queries from section 1 with the durable queue from section 2.
- Update save failure/offline UX so the message distinguishes:
  - save failed and was queued
  - save failed and could not be queued
  - queued save later flushed successfully
- Surface queue state in or near the existing `OfflineBanner` so users know edits are safe and pending.
- Avoid blocking the editor just because the socket is disconnected; the editor buffer remains the source of immediate local truth.

**Files to inspect/change:**

- `src/components/offline-banner/*` or `src/components/offline-banner.tsx`
- `src/hooks/use-online-status.ts`
- `src/features/editor/hooks/use-file-content.ts`
- `src/lib/save-queue.ts`

**Tests to add/update:**

- Offline save enqueues and shows the correct message.
- Cached file content remains readable while offline.
- Returning online flushes and updates UI state.

**Risks and mitigations:**

- **Risk:** users assume queued means conflict-free.
  - **Mitigation:** wording should say changes are queued and will sync when possible, not guaranteed merged.
- **Risk:** unsupported browser storage breaks queueing.
  - **Mitigation:** gracefully fall back to current in-memory/editor-buffer behavior and show a stronger warning.

### 4.2 Add WebSocket heartbeat timeout and reconnect resync

**Goal:** Detect half-open connections, reconnect proactively, flush queued work, and refresh any state that may have changed while disconnected.

**Implementation details:**

- Extend `src/hooks/use-project-socket.ts` heartbeat behavior:
  - send periodic `ping` if supported by the existing `ClientMessage` type
  - track the timestamp of the most recent `pong`
  - close/reconnect if no `pong` arrives within a timeout
- On successful reconnect:
  - mark connected
  - flush queued saves for the current project
  - invalidate/refetch project file list
  - invalidate/refetch git status/branches/log
  - invalidate/refetch project settings/meta/dependencies if config files may have changed
  - avoid refetching the active dirty editor file unless forced by explicit user action
- Keep the existing exponential backoff, but add jitter to avoid many clients reconnecting at the same time.

**Files to inspect/change:**

- `src/hooks/use-project-socket.ts`
- `shared/ws-messages.ts`
- worker WebSocket handling under `worker/` if `ping`/`pong` protocol support needs adjustment

**Tests to add/update:**

- Missing `pong` closes the connection and schedules reconnect.
- Receiving `pong` keeps the connection alive.
- Reconnect resets attempt count and triggers resync.
- Reconnect flushes queued saves once and does not duplicate concurrent flushes.

**Risks and mitigations:**

- **Risk:** heartbeat is too aggressive and causes reconnect churn.
  - **Mitigation:** use conservative intervals/timeouts and pause when the document is hidden if appropriate.
- **Risk:** reconnect resync overwrites active unsaved edits.
  - **Mitigation:** preserve the current active-file skip behavior and only refresh inactive files automatically.

---

## 5. Verification checklist

- **Formatting:** run `bun run format`.
- **Types:** run `bun run typecheck`.
- **Lint/unused checks:** run `bun run lint` and `bun run knip`.
- **Unit tests:** run `bun run test:unit --run`.
- **React tests:** run `bun run test:react --run`.
- **Worker tests:** run `bun run test:worker --run`.
- **Integration tests:** run `bun run test:integration --run`.
- **Storybook tests:** run `bun run test:storybook` if UI state/OfflineBanner behavior changes.
- **E2E tests:** run `bun run test:e2e` for open-file, edit, save, reconnect, and offline/retry flows.
- **Manual measurement:** compare before/after for file open latency, tab-switch latency, save perceived latency, reconnect recovery, and large socket-update scenarios.
- **README:** update `README.md` only if behavior/setup changes or offline guarantees need user-facing documentation.

## 6. Recommended implementation sequence

1. **Cache-first file reads:** update `useFileContent` stale/cache behavior and confirm socket hydration still works.
2. **Optimistic saves:** add `onMutate`/rollback logic without persistence first.
3. **Persisted save queue:** add queue module, tests, enqueue-on-failure/offline behavior.
4. **Queue flushing:** flush on reconnect/online and update offline UI messaging.
5. **Reconnect resync and heartbeat:** harden WebSocket lifecycle and missed-delta recovery.
6. **Granular reactivity audit:** refactor broad `useStore` subscriptions by hot path.
7. **Final verification:** run the full checklist and measure runtime interaction improvements.
