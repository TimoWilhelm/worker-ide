/* eslint-disable unicorn/prevent-abbreviations -- widely imported as utils.ts, renaming would break many imports */
/**
 * Utility functions for the application.
 */

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names with Tailwind CSS support.
 * Combines clsx and tailwind-merge for proper class handling.
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

/**
 * Format file size in human readable format.
 */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
	if (bytes === 0) return '0 B';

	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const index = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

	return `${Number.parseFloat((bytes / Math.pow(k, index)).toFixed(1))} ${sizes[index]}`;
}

/**
 * Format timestamp as relative time (e.g., "2 minutes ago").
 */
export function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;

	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return 'just now';
}

/**
 * Debounce a function.
 */
export function debounce<T extends (...arguments_: unknown[]) => unknown>(
	function_: T,
	delay: number,
): (...arguments_: Parameters<T>) => void {
	let timeoutId: ReturnType<typeof setTimeout>;

	return (...arguments_: Parameters<T>) => {
		clearTimeout(timeoutId);
		timeoutId = setTimeout(() => function_(...arguments_), delay);
	};
}

/**
 * Throttle a function.
 */
export function throttle<T extends (...arguments_: unknown[]) => unknown>(
	function_: T,
	delay: number,
): (...arguments_: Parameters<T>) => void {
	let lastCall = 0;

	return (...arguments_: Parameters<T>) => {
		const now = Date.now();
		if (now - lastCall >= delay) {
			lastCall = now;
			function_(...arguments_);
		}
	};
}

/**
 * Get file extension from path.
 */
export function getFileExtension(path: string): string {
	const match = path.match(/\.([^./]+)$/);
	return match ? match[1].toLowerCase() : '';
}

/**
 * Get filename from path.
 */
export function getFilename(path: string): string {
	const parts = path.split('/');
	return parts.at(-1) || path;
}

/**
 * Get directory from path.
 */
export function getDirectory(path: string): string {
	const lastSlash = path.lastIndexOf('/');
	return lastSlash > 0 ? path.slice(0, lastSlash) : '/';
}

/**
 * Check if a path is a directory (ends with /).
 */
export function isDirectory(path: string): boolean {
	return path.endsWith('/');
}

/**
 * Normalize a file path.
 */
export function normalizePath(path: string): string {
	return '/' + path.replace(/^\/+/, '').replaceAll(/\/+/g, '/');
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Check whether an error indicates a network/connection failure.
 *
 * `fetch` throws a `TypeError` when the request cannot be sent at all
 * (offline, DNS failure, CORS pre-flight failure, etc.). This helper
 * detects that case so callers can show a user-friendly offline message.
 */
export function isNetworkError(error: unknown): boolean {
	return error instanceof TypeError && (error.message === 'Failed to fetch' || error.message === 'Load failed');
}

/**
 * Generate a random alphanumeric ID.
 */
export function generateId(length: number = 8): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let index = 0; index < length; index++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}
