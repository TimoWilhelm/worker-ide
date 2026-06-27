/**
 * Minimal glob matching for the `node:fs/promises` `glob` facade.
 *
 * vinext's route scanner uses `glob(pattern, { cwd, exclude })` to discover
 * `page`/`layout`/`route` files. We implement the subset of glob syntax it
 * relies on — `**`, `*`, `?`, and `{a,b,c}` brace alternation — over the
 * in-memory project filesystem.
 */
import { normalizePosixPath } from './memory-file-system';

import type { MemoryFileSystem } from './memory-file-system';

/** Expand `{a,b}` alternations into a flat list of patterns (one level deep). */
function expandBraces(pattern: string): string[] {
	const match = /\{([^{}]*)\}/.exec(pattern);
	if (match === null) {
		return [pattern];
	}
	const [token, body] = match;
	const alternatives = body.split(',');
	const results: string[] = [];
	for (const alternative of alternatives) {
		const expanded = pattern.slice(0, match.index) + alternative + pattern.slice(match.index + token.length);
		results.push(...expandBraces(expanded));
	}
	return results;
}

function escapeRegExp(segment: string): string {
	return segment.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Translate a single brace-free glob pattern into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
	let source = '';
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === '*') {
			if (pattern[index + 1] === '*') {
				// `**` (optionally followed by `/`) matches across directories.
				index += 1;
				if (pattern[index + 1] === '/') {
					index += 1;
					source += '(?:.*/)?';
				} else {
					source += '.*';
				}
			} else {
				source += '[^/]*';
			}
			continue;
		}
		if (char === '?') {
			source += '[^/]';
			continue;
		}
		source += escapeRegExp(char);
	}
	return new RegExp(`^${source}$`);
}

export interface GlobOptions {
	cwd?: string;
	exclude?: ((path: string) => boolean) | string[];
}

function makeExcluder(exclude: GlobOptions['exclude']): (path: string) => boolean {
	if (exclude === undefined) {
		return () => false;
	}
	if (typeof exclude === 'function') {
		return exclude;
	}
	const matchers = exclude.flatMap((pattern) => expandBraces(pattern)).map((pattern) => globToRegExp(pattern));
	return (path) => matchers.some((matcher) => matcher.test(path));
}

/**
 * Async generator yielding project-relative paths matching `pattern` under
 * `cwd`, mirroring Node's `fs.promises.glob`.
 */
export async function* glob(fileSystem: MemoryFileSystem, pattern: string, options: GlobOptions = {}): AsyncGenerator<string> {
	const cwd = normalizePosixPath(options.cwd ?? '/');
	const prefix = cwd === '/' ? '/' : cwd + '/';
	const matchers = expandBraces(pattern).map((expanded) => globToRegExp(expanded));
	const isExcluded = makeExcluder(options.exclude);

	for (const absolutePath of Object.keys(fileSystem.toSnapshot())) {
		if (!absolutePath.startsWith(prefix)) {
			continue;
		}
		const relativePath = absolutePath.slice(prefix.length);
		if (matchers.some((matcher) => matcher.test(relativePath)) && !isExcluded(relativePath)) {
			yield relativePath;
		}
	}
}
