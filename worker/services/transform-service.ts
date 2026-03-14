/**
 * Dev server module transform pipeline using the bundler service.
 * Handles import rewriting, module resolution, and TypeScript/JSX transformation.
 */

import stripJsonComments from 'strip-json-comments';

import { transformCode } from './bundler-client';

const ESM_CDN = 'https://esm.sh';

// =============================================================================
// Types
// =============================================================================

export interface FileSystem {
	readFile(path: string): Promise<string | Uint8Array>;
	access(path: string): Promise<void>;
}

export interface TransformOptions {
	fs: FileSystem;
	projectRoot: string;
}

interface ResolvedImport {
	original: string;
	resolved: string;
	isBare: boolean;
}

interface TsConfigCompilerOptions {
	baseUrl?: string;
	paths?: Record<string, string[]>;
	target?: string;
	jsx?: 'preserve' | 'react' | 'react-jsx' | 'react-jsxdev' | 'react-native';
	jsxFactory?: string;
	jsxFragmentFactory?: string;
	jsxImportSource?: string;
	experimentalDecorators?: boolean;
	useDefineForClassFields?: boolean;
	verbatimModuleSyntax?: boolean;
	alwaysStrict?: boolean;
}

interface TsConfig {
	compilerOptions?: TsConfigCompilerOptions;
}

// =============================================================================
// TSConfig Utilities
// =============================================================================

/**
 * Convert tsconfig compilerOptions to esbuild's tsconfigRaw format.
 */
export function toEsbuildTsconfigRaw(tsConfig: TsConfig | undefined): string | undefined {
	if (!tsConfig?.compilerOptions) return undefined;

	const options = tsConfig.compilerOptions;
	const esbuildCompilerOptions: Record<string, unknown> = {};

	if (options.jsx) {
		esbuildCompilerOptions.jsx = options.jsx;
	}
	if (options.jsxFactory) {
		esbuildCompilerOptions.jsxFactory = options.jsxFactory;
	}
	if (options.jsxFragmentFactory) {
		esbuildCompilerOptions.jsxFragmentFactory = options.jsxFragmentFactory;
	}
	if (options.jsxImportSource) {
		esbuildCompilerOptions.jsxImportSource = options.jsxImportSource;
	}
	if (options.experimentalDecorators !== undefined) {
		esbuildCompilerOptions.experimentalDecorators = options.experimentalDecorators;
	}
	if (options.useDefineForClassFields !== undefined) {
		esbuildCompilerOptions.useDefineForClassFields = options.useDefineForClassFields;
	}
	if (options.verbatimModuleSyntax !== undefined) {
		esbuildCompilerOptions.verbatimModuleSyntax = options.verbatimModuleSyntax;
	}
	if (options.alwaysStrict !== undefined) {
		esbuildCompilerOptions.alwaysStrict = options.alwaysStrict;
	}

	if (Object.keys(esbuildCompilerOptions).length === 0) {
		return undefined;
	}

	return JSON.stringify({ compilerOptions: esbuildCompilerOptions });
}

// =============================================================================
// Module Resolution
// =============================================================================

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];

async function probeExtensions(fs: FileSystem, basePath: string, extensions: string[]): Promise<string | undefined> {
	const results = await Promise.allSettled(extensions.map((extension) => fs.access(`${basePath}${extension}`).then(() => extension)));
	for (const result of results) {
		if (result.status === 'fulfilled') return result.value;
	}
	return undefined;
}

async function loadTsConfig(fs: FileSystem, projectRoot: string): Promise<TsConfig | undefined> {
	try {
		const content = await fs.readFile(`${projectRoot}/tsconfig.json`);
		const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
		const config: TsConfig = JSON.parse(stripJsonComments(text));

		if (!config.compilerOptions) {
			return await loadTsConfigFile(fs, `${projectRoot}/tsconfig.app.json`);
		}

		return config;
	} catch {
		return undefined;
	}
}

async function loadTsConfigFile(fs: FileSystem, filePath: string): Promise<TsConfig | undefined> {
	try {
		const content = await fs.readFile(filePath);
		const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
		return JSON.parse(stripJsonComments(text));
	} catch {
		return undefined;
	}
}

function resolvePathAlias(specifier: string, tsConfig: TsConfig | undefined): string | undefined {
	if (!tsConfig?.compilerOptions?.paths) return undefined;

	const paths = tsConfig.compilerOptions.paths;
	const baseUrl = tsConfig.compilerOptions.baseUrl || '.';

	for (const [pattern, targets] of Object.entries(paths)) {
		if (pattern.endsWith('/*')) {
			const prefix = pattern.slice(0, -2);
			if (specifier.startsWith(prefix + '/')) {
				const rest = specifier.slice(prefix.length + 1);
				for (const target of targets) {
					if (target.endsWith('/*')) {
						const targetBase = target.slice(0, -2);
						return `/${baseUrl}/${targetBase}/${rest}`.replaceAll(/\/+/g, '/');
					}
				}
			}
		} else if (specifier === pattern) {
			for (const target of targets) {
				return `/${baseUrl}/${target}`.replaceAll(/\/+/g, '/');
			}
		}
	}

	return undefined;
}

function getExtension(path: string): string {
	const match = path.match(/\.[^./]+$/);
	return match ? match[0].toLowerCase() : '';
}

/**
 * Resolve an import specifier to a file path or CDN URL.
 */
async function resolveImport(
	specifier: string,
	importer: string,
	fs: FileSystem,
	projectRoot: string,
	tsConfig: TsConfig | undefined,
): Promise<ResolvedImport> {
	// Check tsconfig paths first for non-relative imports
	if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
		const aliasResolved = resolvePathAlias(specifier, tsConfig);
		if (aliasResolved) {
			const extension = getExtension(aliasResolved);
			if (!extension) {
				const directExtension = await probeExtensions(fs, `${projectRoot}${aliasResolved}`, EXTENSIONS);
				if (directExtension) {
					return { original: specifier, resolved: `${aliasResolved}${directExtension}`, isBare: false };
				}
				const indexExtension = await probeExtensions(fs, `${projectRoot}${aliasResolved}/index`, EXTENSIONS);
				if (indexExtension) {
					return { original: specifier, resolved: `${aliasResolved}/index${indexExtension}`, isBare: false };
				}
			}
			return { original: specifier, resolved: aliasResolved, isBare: false };
		}

		return { original: specifier, resolved: `${ESM_CDN}/${specifier}`, isBare: true };
	}

	// Relative imports
	const importerDirectory = importer.slice(0, Math.max(0, importer.lastIndexOf('/'))) || '';
	let targetPath: string;

	if (specifier.startsWith('/')) {
		targetPath = specifier;
	} else {
		const parts = importerDirectory.split('/').filter(Boolean);
		const specParts = specifier.split('/');

		for (const part of specParts) {
			if (part === '..') {
				parts.pop();
			} else if (part !== '.') {
				parts.push(part);
			}
		}
		targetPath = '/' + parts.join('/');
	}

	const extension = getExtension(targetPath);
	if (!extension) {
		const directExtension = await probeExtensions(fs, `${projectRoot}${targetPath}`, EXTENSIONS);
		if (directExtension) {
			return { original: specifier, resolved: `${targetPath}${directExtension}`, isBare: false };
		}
		const indexExtension = await probeExtensions(fs, `${projectRoot}${targetPath}/index`, EXTENSIONS);
		if (indexExtension) {
			return { original: specifier, resolved: `${targetPath}/index${indexExtension}`, isBare: false };
		}
	}

	return { original: specifier, resolved: targetPath, isBare: false };
}

// =============================================================================
// Import Rewriting
// =============================================================================

async function rewriteImports(
	code: string,
	filePath: string,
	fs: FileSystem,
	projectRoot: string,
	tsConfig: TsConfig | undefined,
): Promise<string> {
	const importRegex = /(?:import|export)\s*(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*(?:from\s*)?['"]([^'"]+)['"]/g;
	const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

	const imports: Array<{ match: string; specifier: string; start: number; end: number }> = [];

	let match: RegExpExecArray | null;
	while ((match = importRegex.exec(code)) !== null) {
		imports.push({ match: match[0], specifier: match[1], start: match.index, end: match.index + match[0].length });
	}

	while ((match = dynamicImportRegex.exec(code)) !== null) {
		imports.push({ match: match[0], specifier: match[1], start: match.index, end: match.index + match[0].length });
	}

	const resolved = await Promise.all(
		imports.map(async (imp) => ({
			...imp,
			resolution: await resolveImport(imp.specifier, filePath, fs, projectRoot, tsConfig),
		})),
	);

	let result = code;
	for (const imp of resolved.toSorted((a, b) => b.start - a.start)) {
		const newStatement = imp.match.replace(imp.specifier, imp.resolution.resolved);
		result = result.slice(0, imp.start) + newStatement + result.slice(imp.end);
	}

	return result;
}

// =============================================================================
// TSConfig Cache
// =============================================================================

const tsConfigCache = new Map<string, { config: TsConfig | undefined; expiry: number }>();
const TSCONFIG_TTL_MS = 5000;
const MAX_TSCONFIG_CACHE = 100;

/**
 * Invalidate cached tsconfig for a project so the next transform picks up changes.
 */
export function invalidateTsConfigCache(projectRoot: string): void {
	tsConfigCache.delete(projectRoot);
}

async function getTsConfig(fs: FileSystem, projectRoot: string): Promise<TsConfig | undefined> {
	const cached = tsConfigCache.get(projectRoot);
	if (cached && Date.now() < cached.expiry) {
		return cached.config;
	}
	const config = await loadTsConfig(fs, projectRoot);
	tsConfigCache.set(projectRoot, { config, expiry: Date.now() + TSCONFIG_TTL_MS });
	while (tsConfigCache.size > MAX_TSCONFIG_CACHE) {
		const first = tsConfigCache.keys().next().value;
		if (first === undefined) {
			break;
		} else {
			tsConfigCache.delete(first);
		}
	}
	return config;
}

// =============================================================================
// Module Transform
// =============================================================================

function getContentType(extension: string): string {
	const types: Record<string, string> = {
		'.html': 'text/html',
		'.js': 'application/javascript',
		'.mjs': 'application/javascript',
		'.css': 'text/css',
		'.json': 'application/json',
		'.svg': 'image/svg+xml',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.gif': 'image/gif',
		'.webp': 'image/webp',
	};
	return types[extension] || 'text/plain';
}

/**
 * Transform and serve a module file.
 */
export async function transformModule(
	filePath: string,
	content: string,
	options: TransformOptions,
): Promise<{ code: string; contentType: string }> {
	const { fs, projectRoot } = options;
	const extension = getExtension(filePath);
	const tsConfig = await getTsConfig(fs, projectRoot);

	if (['.ts', '.tsx', '.jsx', '.mts'].includes(extension)) {
		const tsconfigRaw = toEsbuildTsconfigRaw(tsConfig);
		const transformed = await transformCode(content, filePath, { sourcemap: true, tsconfigRaw });
		const rewritten = await rewriteImports(transformed.code, filePath, fs, projectRoot, tsConfig);
		return { code: rewritten, contentType: 'application/javascript' };
	}

	if (['.js', '.mjs'].includes(extension)) {
		const rewritten = await rewriteImports(content, filePath, fs, projectRoot, tsConfig);
		return { code: rewritten, contentType: 'application/javascript' };
	}

	if (extension === '.css') {
		const cssContent = JSON.stringify(content);
		const code = `
const css = ${cssContent};
const style = document.createElement('style');
style.setAttribute('data-dev-id', ${JSON.stringify(filePath)});
style.textContent = css;
document.head.appendChild(style);
export default css;
`;
		return { code, contentType: 'application/javascript' };
	}

	if (extension === '.json') {
		return { code: `export default ${content};`, contentType: 'application/javascript' };
	}

	return { code: content, contentType: getContentType(extension) };
}

// =============================================================================
// HTML Processing
// =============================================================================

function escapeForScriptTag(s: string): string {
	return s
		.replaceAll('\\', '\\\\')
		.replaceAll("'", String.raw`\'`)
		.replaceAll('\n', String.raw`\n`)
		.replaceAll('\r', String.raw`\r`)
		.replaceAll(/<\/(script)/gi, String.raw`<\/$1`);
}

/** Generate the inline config script that preview scripts read. */
function generatePreviewConfig(wsUrl: string, ideOrigin: string, projectId: string): string {
	const safeWsUrl = escapeForScriptTag(wsUrl);
	const safeIdeOrigin = escapeForScriptTag(ideOrigin);
	const safeProjectId = escapeForScriptTag(projectId);
	return `<script>window.__PREVIEW_CONFIG={wsUrl:'${safeWsUrl}',ideOrigin:'${safeIdeOrigin}',projectId:'${safeProjectId}'};</script>`;
}

/**
 * Generate script tags for preview infrastructure.
 *
 * Script order matters:
 * 1. react-refresh-preamble — MUST run before React loads
 * 2. error-overlay — shows build errors
 * 3. hmr-client — handles hot module replacement
 * 4. chobitsu + chobitsu-init — Chrome DevTools Protocol bridge
 */
function generatePreviewScriptTags(integrityHashes?: Record<string, string>): string {
	const scripts = ['__react-refresh-preamble.js', '__error-overlay.js', '__hmr-client.js', '__chobitsu.js', '__chobitsu-init.js'];
	return scripts
		.map((source) => {
			const hash = integrityHashes?.[source];
			const cacheBuster = hash ? `?v=${hash.slice(7, 15)}` : '';
			const integrity = hash ? ` integrity="${hash}"` : '';
			return `<script src="/${source}${cacheBuster}"${integrity}></script>`;
		})
		.join('\n');
}

export interface ProcessHtmlOptions extends TransformOptions {
	wsUrl: string;
	ideOrigin: string;
	projectId: string;
	scriptIntegrityHashes?: Record<string, string>;
}

/** Process HTML file — inject preview config and scripts. */
export async function processHTML(html: string, _filePath: string, options: ProcessHtmlOptions): Promise<string> {
	const { wsUrl, ideOrigin, projectId, scriptIntegrityHashes } = options;

	const previewConfig = generatePreviewConfig(wsUrl, ideOrigin, projectId);
	const previewScripts = generatePreviewScriptTags(scriptIntegrityHashes);

	const rewriter = new HTMLRewriter().on('head', {
		element(element) {
			element.append(previewConfig + previewScripts, { html: true });
		},
	});

	const response = rewriter.transform(new Response(html, { headers: { 'Content-Type': 'text/html' } }));

	return response.text();
}
