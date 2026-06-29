/**
 * `es-module-lexer` drop-in for workerd.
 *
 * The real `es-module-lexer` compiles a WebAssembly module from inline base64 at
 * import time. workerd forbids `WebAssembly.compile` from a buffer, so we
 * reimplement the small surface `@vitejs/plugin-rsc` uses: `init` (a resolved
 * promise) and `parse(code)` returning `[imports, exports]`.
 *
 * Consumers read only `import.n` (the specifier) and `import.t` (static vs
 * dynamic). A tolerant regex scan — matching the lexer's own forgiving,
 * non-AST nature — extracts those precisely while ignoring TypeScript/JSX
 * syntax that a strict parser would reject.
 */

/** Mirrors `es-module-lexer`'s `ImportType` enum (subset). */
export const ImportType = {
	Static: 1,
	Dynamic: 2,
	ImportMeta: 3,
} as const;

export interface ImportSpecifier {
	/** Statically-resolvable module specifier, or undefined. */
	n: string | undefined;
	/** Import kind: 1 static, 2 dynamic, 3 import.meta. */
	t: number;
	/** Specifier start/end (best effort). */
	s: number;
	e: number;
	/** Statement start/end (best effort). */
	ss: number;
	se: number;
	/** Dynamic import argument index, or -1 for static. */
	d: number;
	/** Import attributes index, or -1. */
	a: number;
}

export interface ExportSpecifier {
	n: string;
	ln: string | undefined;
	s: number;
	e: number;
}

/** Resolves immediately — the WASM the real lexer awaits does not exist here. */
export const init: Promise<void> = Promise.resolve();

// `import …` / `export … from "x"` and bare `import "x"`.
const STATIC_FROM_RE = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
const EXPORT_ALL_RE = /\bexport\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_DYNAMIC_RE = /\bimport\s*\(\s*(?!['"])/g;

// `export const/let/var/function/class NAME`, `export default`, `export { a, b }`.
const EXPORT_DECL_RE = /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([\w$]+)/g;
const EXPORT_DEFAULT_RE = /\bexport\s+default\b/g;
const EXPORT_NAMED_RE = /\bexport\s*\{([^}]*)\}/g;

function makeImport(name: string | undefined, type: number, index: number, length: number, dynamic: boolean): ImportSpecifier {
	return { n: name, t: type, s: index, e: index + length, ss: index, se: index + length, d: dynamic ? index : -1, a: -1 };
}

/** Parse module imports/exports. Returns `[imports, exports, facade]`. */
export function parse(code: string, _name?: string): [ImportSpecifier[], ExportSpecifier[], boolean] {
	const imports: ImportSpecifier[] = [];
	const seen = new Set<string>();

	const addStatic = (regex: RegExp): void => {
		for (const match of code.matchAll(regex)) {
			const key = `s:${match.index}:${match[1]}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			imports.push(makeImport(match[1], ImportType.Static, match.index ?? 0, match[0].length, false));
		}
	};
	addStatic(STATIC_FROM_RE);
	addStatic(BARE_IMPORT_RE);
	addStatic(EXPORT_ALL_RE);

	for (const match of code.matchAll(DYNAMIC_IMPORT_RE)) {
		imports.push(makeImport(match[1], ImportType.Dynamic, match.index ?? 0, match[0].length, true));
	}
	for (const match of code.matchAll(DYNAMIC_IMPORT_DYNAMIC_RE)) {
		imports.push(makeImport(undefined, ImportType.Dynamic, match.index ?? 0, match[0].length, true));
	}

	const exports: ExportSpecifier[] = [];
	for (const match of code.matchAll(EXPORT_DECL_RE)) {
		exports.push({ n: match[1], ln: match[1], s: match.index ?? 0, e: (match.index ?? 0) + match[0].length });
	}
	for (const match of code.matchAll(EXPORT_DEFAULT_RE)) {
		exports.push({ n: 'default', ln: undefined, s: match.index ?? 0, e: (match.index ?? 0) + match[0].length });
	}
	for (const match of code.matchAll(EXPORT_NAMED_RE)) {
		for (const part of match[1].split(',')) {
			const name = part
				.trim()
				.split(/\s+as\s+/)
				.at(-1)
				?.trim();
			if (name !== undefined && name.length > 0) {
				exports.push({ n: name, ln: undefined, s: match.index ?? 0, e: (match.index ?? 0) + match[0].length });
			}
		}
	}

	return [imports, exports, false];
}

export default { init, parse, ImportType };
