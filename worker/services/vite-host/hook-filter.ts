/**
 * Rollup/Vite hook filters.
 *
 * Vite 8 / Rolldown let plugins attach declarative filters to `transform`,
 * `load`, and `resolveId` hooks — `{ filter: { id, code }, handler }` — so the
 * handler only runs for matching modules. vinext relies on this (e.g. its MDX
 * transform is gated to `/\.mdx$/i`). We honour the `id` filter, matching the
 * subset of patterns the native plugins use: RegExp, exact string, glob string,
 * arrays of those, and `{ include, exclude }` objects.
 */
import { globToRegExp } from './node-fs/glob';

export type FilterValue = string | RegExp;
export type FilterPatterns = FilterValue | FilterValue[] | { include?: FilterValue | FilterValue[]; exclude?: FilterValue | FilterValue[] };

export interface HookFilter {
	id?: FilterPatterns;
	code?: FilterPatterns;
}

function toMatcherList(patterns: FilterValue | FilterValue[] | undefined): Array<(value: string) => boolean> {
	if (patterns === undefined) {
		return [];
	}
	const list = Array.isArray(patterns) ? patterns : [patterns];
	return list.map((pattern) => {
		if (pattern instanceof RegExp) {
			return (value: string) => pattern.test(value);
		}
		// A plain string with no glob characters is treated as a substring/exact
		// match (Rollup semantics); otherwise compile it as a glob.
		if (/[*?{}[\]]/.test(pattern)) {
			const regex = globToRegExp(pattern);
			return (value: string) => regex.test(value);
		}
		return (value: string) => value === pattern || value.includes(pattern);
	});
}

function matchesPatterns(patterns: FilterPatterns | undefined, value: string): boolean {
	if (patterns === undefined) {
		return true;
	}
	if (patterns instanceof RegExp || typeof patterns === 'string' || Array.isArray(patterns)) {
		const include = toMatcherList(patterns);
		return include.length === 0 || include.some((matches) => matches(value));
	}
	const exclude = toMatcherList(patterns.exclude);
	if (exclude.some((matches) => matches(value))) {
		return false;
	}
	const include = toMatcherList(patterns.include);
	return include.length === 0 || include.some((matches) => matches(value));
}

/**
 * Whether a hook with the given filter should run for `id` (and optionally
 * `code`). Absent filters always match.
 */
export function matchesHookFilter(filter: HookFilter | undefined, id: string, code?: string): boolean {
	if (filter === undefined) {
		return true;
	}
	if (!matchesPatterns(filter.id, id)) {
		return false;
	}
	if (filter.code !== undefined && code !== undefined && !matchesPatterns(filter.code, code)) {
		return false;
	}
	return true;
}
