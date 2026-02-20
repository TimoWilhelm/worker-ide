/**
 * Retry-wrapped Durable Object namespaces.
 *
 * All Durable Object access in the worker should go through these namespaces
 * instead of using `exports` directly. This ensures every RPC call automatically
 * retries on transient failures with exponential backoff and jitter.
 *
 * @see https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 */

import { exports } from 'cloudflare:workers';

import { withRetry } from './do-retry-proxy';

/**
 * Filesystem Durable Object namespace with automatic retry.
 * Used for all file system and git operations.
 */
export const filesystemNamespace = withRetry(exports.DurableObjectFilesystem);

/**
 * Project Coordinator Durable Object namespace with automatic retry.
 * Used for HMR broadcasts, WebSocket messages, and real-time collaboration.
 */
export const coordinatorNamespace = withRetry(exports.ProjectCoordinator);
