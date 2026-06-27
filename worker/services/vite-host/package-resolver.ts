/**
 * Conditions-aware `node_modules` package resolver.
 *
 * Resolves bare specifiers against a flat virtual `node_modules` in the project
 * filesystem, honouring `package.json` `exports` with per-environment export
 * conditions (e.g. `react-server` for the RSC environment). This is what lets
 * each server environment bundle the *correct* build of React and the RSC
 * runtime from source — so esbuild handles CommonJS↔ESM interop natively and
 * each environment inlines a single, correctly-conditioned React instance.
 *
 * Modelled on Cloudflare's `@cloudflare/worker-bundler` resolver, using
 * `resolve.exports` for the exports/legacy field handling.
 */
import { legacy, resolve as resolveExports } from 'resolve.exports';

import { normalizePosixPath } from './node-fs/memory-file-system';

import type { MemoryFileSystem } from './node-fs/memory-file-system';

const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json'];

export interface PackageResolveResult {
	/** Absolute path of the resolved file in the virtual filesystem. */
	path: string;
}

interface ParsedSpecifier {
	packageName: string;
	subpath: string | undefined;
}

/** Split `@scope/pkg/sub/path` or `pkg/sub` into package name + subpath. */
export function parsePackageSpecifier(specifier: string): ParsedSpecifier {
	if (specifier.startsWith('@')) {
		const parts = specifier.split('/');
		if (parts.length < 2) {
			return { packageName: specifier, subpath: undefined };
		}
		const packageName = `${parts[0]}/${parts[1]}`;
		const subpath = parts.slice(2).join('/');
		return { packageName, subpath: subpath.length > 0 ? subpath : undefined };
	}
	const parts = specifier.split('/');
	const packageName = parts[0];
	const subpath = parts.slice(1).join('/');
	return { packageName, subpath: subpath.length > 0 ? subpath : undefined };
}

function readJson(fileSystem: MemoryFileSystem, path: string): Record<string, unknown> | undefined {
	if (!fileSystem.exists(path)) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(fileSystem.readFileText(path));
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return undefined;
		}
		return Object.fromEntries(Object.entries(parsed));
	} catch {
		return undefined;
	}
}

function resolveWithExtensions(fileSystem: MemoryFileSystem, basePath: string): string | undefined {
	const normalized = normalizePosixPath(basePath);
	if (fileSystem.exists(normalized) && fileSystem.stat(normalized).isFile()) {
		return normalized;
	}
	for (const extension of DEFAULT_EXTENSIONS) {
		if (fileSystem.exists(normalized + extension)) {
			return normalized + extension;
		}
	}
	for (const extension of DEFAULT_EXTENSIONS) {
		const indexPath = `${normalized}/index${extension}`;
		if (fileSystem.exists(indexPath)) {
			return indexPath;
		}
	}
	return undefined;
}

/**
 * Resolve a bare specifier to a file in the virtual `node_modules`, or
 * `undefined` if the package (or entry) is not present. `conditions` selects
 * the `exports` branch (the resolver always includes `default`).
 */
export function resolvePackage(
	specifier: string,
	fileSystem: MemoryFileSystem,
	conditions: readonly string[],
): PackageResolveResult | undefined {
	const { packageName, subpath } = parsePackageSpecifier(specifier);
	const packageRoot = `/node_modules/${packageName}`;
	const manifest = readJson(fileSystem, `${packageRoot}/package.json`);
	if (manifest === undefined) {
		return undefined;
	}

	const entrySubpath = subpath === undefined ? '.' : `./${subpath}`;
	try {
		const resolved = resolveExports(manifest, entrySubpath, { conditions: [...conditions], unsafe: false });
		const target = resolved?.[0];
		if (target !== undefined) {
			const full = normalizePosixPath(`${packageRoot}/${target}`);
			if (fileSystem.exists(full)) {
				return { path: full };
			}
		}
	} catch {
		// Fall through to legacy / extension resolution.
	}

	if (subpath === undefined) {
		const legacyEntry = legacy(manifest, { fields: ['module', 'main'] });
		if (typeof legacyEntry === 'string') {
			const full = resolveWithExtensions(fileSystem, `${packageRoot}/${legacyEntry}`);
			if (full !== undefined) {
				return { path: full };
			}
		}
	}

	const direct = resolveWithExtensions(fileSystem, subpath === undefined ? packageRoot : `${packageRoot}/${subpath}`);
	return direct === undefined ? undefined : { path: direct };
}
