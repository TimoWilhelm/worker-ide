/**
 * Apply Vite `resolve.alias` to an import specifier.
 *
 * vinext maps `next/*` (and user `next.config` aliases / tsconfig paths) to its
 * seeded shim files via `resolve.alias`. Vite supports both the object form
 * (`{ find: replacement }`, matched exactly or as a path prefix) and the array
 * form (`[{ find: string | RegExp, replacement }]`). This implements the subset
 * the native plugins rely on.
 */
import type { AliasConfig } from './types';

interface AliasEntry {
	find: string | RegExp;
	replacement: string;
}

function toEntries(alias: AliasConfig | undefined): AliasEntry[] {
	if (alias === undefined) {
		return [];
	}
	if (Array.isArray(alias)) {
		return alias;
	}
	return Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
}

/**
 * Return the aliased specifier, or `undefined` if no alias matches. String
 * `find` matches the specifier exactly or as a `find/...` path prefix (Vite
 * semantics); RegExp `find` is replaced with `String.prototype.replace`.
 */
export function applyAlias(specifier: string, alias: AliasConfig | undefined): string | undefined {
	for (const entry of toEntries(alias)) {
		if (entry.find instanceof RegExp) {
			if (entry.find.test(specifier)) {
				return specifier.replace(entry.find, entry.replacement);
			}
			continue;
		}
		if (specifier === entry.find) {
			return entry.replacement;
		}
		if (specifier.startsWith(`${entry.find}/`)) {
			return entry.replacement + specifier.slice(entry.find.length);
		}
	}
	return undefined;
}
