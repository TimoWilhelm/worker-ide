/**
 * Dev server module transform pipeline using esbuild-wasm.
 * Handles import rewriting, module resolution, and TypeScript/JSX transformation.
 */

import { transformCode } from './bundler-service';

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
	baseUrl: string;
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

/**
 * Parse and cache tsconfig for a project.
 */
async function loadTsConfig(fs: FileSystem, projectRoot: string): Promise<TsConfig | undefined> {
	try {
		const content = await fs.readFile(`${projectRoot}/tsconfig.json`);
		const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Resolve a path alias from tsconfig paths.
 */
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
	baseUrl: string,
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
					return {
						original: specifier,
						resolved: `${baseUrl}${aliasResolved}${directExtension}`,
						isBare: false,
					};
				}
				const indexExtension = await probeExtensions(fs, `${projectRoot}${aliasResolved}/index`, EXTENSIONS);
				if (indexExtension) {
					return {
						original: specifier,
						resolved: `${baseUrl}${aliasResolved}/index${indexExtension}`,
						isBare: false,
					};
				}
			}
			return {
				original: specifier,
				resolved: `${baseUrl}${aliasResolved}`,
				isBare: false,
			};
		}

		// Bare imports (packages) -> redirect to esm.sh CDN
		return {
			original: specifier,
			resolved: `${ESM_CDN}/${specifier}`,
			isBare: true,
		};
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

	// Try to resolve with extensions if no extension provided
	const extension = getExtension(targetPath);
	if (!extension) {
		const directExtension = await probeExtensions(fs, `${projectRoot}${targetPath}`, EXTENSIONS);
		if (directExtension) {
			return {
				original: specifier,
				resolved: `${baseUrl}${targetPath}${directExtension}`,
				isBare: false,
			};
		}
		const indexExtension = await probeExtensions(fs, `${projectRoot}${targetPath}/index`, EXTENSIONS);
		if (indexExtension) {
			return {
				original: specifier,
				resolved: `${baseUrl}${targetPath}/index${indexExtension}`,
				isBare: false,
			};
		}
	}

	return {
		original: specifier,
		resolved: `${baseUrl}${targetPath}`,
		isBare: false,
	};
}

// =============================================================================
// Import Rewriting
// =============================================================================

/**
 * Rewrite import statements in transformed code.
 */
async function rewriteImports(
	code: string,
	filePath: string,
	fs: FileSystem,
	projectRoot: string,
	baseUrl: string,
	tsConfig: TsConfig | undefined,
): Promise<string> {
	const importRegex = /(?:import|export)\s*(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*(?:from\s*)?['"]([^'"]+)['"]/g;
	const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

	const imports: Array<{ match: string; specifier: string; start: number; end: number }> = [];

	let match: RegExpExecArray | null;
	while ((match = importRegex.exec(code)) !== null) {
		imports.push({
			match: match[0],
			specifier: match[1],
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	while ((match = dynamicImportRegex.exec(code)) !== null) {
		imports.push({
			match: match[0],
			specifier: match[1],
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	const resolved = await Promise.all(
		imports.map(async (imp) => ({
			...imp,
			resolution: await resolveImport(imp.specifier, filePath, fs, projectRoot, baseUrl, tsConfig),
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
export function invalidateTsConfigCache(projectRoot: string, baseUrl?: string): void {
	const key = baseUrl ? `${projectRoot}:${baseUrl}` : projectRoot;
	tsConfigCache.delete(key);
}

async function getTsConfig(fs: FileSystem, projectRoot: string, cacheKey?: string): Promise<TsConfig | undefined> {
	const key = cacheKey || projectRoot;
	const cached = tsConfigCache.get(key);
	if (cached && Date.now() < cached.expiry) {
		return cached.config;
	}
	const config = await loadTsConfig(fs, projectRoot);
	tsConfigCache.set(key, { config, expiry: Date.now() + TSCONFIG_TTL_MS });
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
	const { fs, projectRoot, baseUrl } = options;
	const extension = getExtension(filePath);
	const tsConfig = await getTsConfig(fs, projectRoot, `${projectRoot}:${baseUrl}`);

	// Transform TypeScript/JSX
	if (['.ts', '.tsx', '.jsx', '.mts'].includes(extension)) {
		const tsconfigRaw = toEsbuildTsconfigRaw(tsConfig);
		const transformed = await transformCode(content, filePath, { sourcemap: true, tsconfigRaw });
		const rewritten = await rewriteImports(transformed.code, filePath, fs, projectRoot, baseUrl, tsConfig);
		return { code: rewritten, contentType: 'application/javascript' };
	}

	// Transform JS files (just rewrite imports)
	if (['.js', '.mjs'].includes(extension)) {
		const rewritten = await rewriteImports(content, filePath, fs, projectRoot, baseUrl, tsConfig);
		return { code: rewritten, contentType: 'application/javascript' };
	}

	// Transform CSS to JS module that injects styles
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

	// Transform JSON to JS module
	if (extension === '.json') {
		return {
			code: `export default ${content};`,
			contentType: 'application/javascript',
		};
	}

	// Return as-is for other files
	return { code: content, contentType: getContentType(extension) };
}

// =============================================================================
// HTML Processing
// =============================================================================

/**
 * Escape a string for safe embedding inside a JSON value within a <script> tag.
 */
function escapeForScriptTag(s: string): string {
	return s
		.replaceAll('\\', '\\\\')
		.replaceAll("'", String.raw`\'`)
		.replaceAll('\n', String.raw`\n`)
		.replaceAll('\r', String.raw`\r`)
		.replaceAll(/<\/(script)/gi, String.raw`<\/$1`);
}

/**
 * Generate the tiny inline config script that external preview scripts read.
 * This is the ONLY inline JS injected into the preview HTML.
 */
function generatePreviewConfig(wsUrl: string, baseUrl: string): string {
	const safeWsUrl = escapeForScriptTag(wsUrl);
	const safeBaseUrl = escapeForScriptTag(baseUrl);
	return `<script>window.__PREVIEW_CONFIG={wsUrl:'${safeWsUrl}',baseUrl:'${safeBaseUrl}'};</script>`;
}

/**
 * Generate the external script tags for preview infrastructure.
 * All logic lives in separate .js files served by preview-service at /__*.js.
 * Uses relative paths (no leading /) so the browser resolves them relative
 * to the current preview URL (e.g. /p/:projectId/preview/__hmr-client.js).
 */
function generatePreviewScriptTags(integrityHashes?: Record<string, string>): string {
	const scripts = ['__fetch-interceptor.js', '__error-overlay.js', '__hmr-client.js', '__chobitsu.js', '__chobitsu-init.js'];
	return scripts
		.map((source) => {
			const hash = integrityHashes?.[source];
			// Use hash as cache-buster query param to avoid stale scripts after deploy.
			// SRI integrity is same-origin so no crossorigin attribute needed.
			const cacheBuster = hash ? `?v=${hash.slice(7, 15)}` : '';
			const integrity = hash ? ` integrity="${hash}"` : '';
			return `<script src="${source}${cacheBuster}"${integrity}></script>`;
		})
		.join('\n');
}

/**
 * Process HTML file using HTMLRewriter - inject preview config and rewrite script/link tags.
 */
export async function processHTML(
	html: string,
	_filePath: string,
	options: TransformOptions & { hmrUrl: string; scriptIntegrityHashes?: Record<string, string> },
): Promise<string> {
	const { baseUrl, hmrUrl, scriptIntegrityHashes } = options;

	const previewConfig = generatePreviewConfig(hmrUrl, baseUrl);
	const previewScripts = generatePreviewScriptTags(scriptIntegrityHashes);

	const rewriter = new HTMLRewriter()
		.on('head', {
			element(element) {
				element.append(previewConfig + previewScripts, { html: true });
			},
		})
		.on('script[src]', {
			element(element) {
				const source = element.getAttribute('src');
				if (!source || source.startsWith('http://') || source.startsWith('https://') || source.startsWith('__')) {
					return;
				}
				const newSource = source.startsWith('/') ? `${baseUrl}${source}` : `${baseUrl}/${source}`;
				element.setAttribute('src', newSource);
			},
		})
		.on('link[href]', {
			element(element) {
				const href = element.getAttribute('href');
				if (!href || href.startsWith('http://') || href.startsWith('https://')) {
					return;
				}
				if (!href.endsWith('.css')) {
					return;
				}
				const newHref = href.startsWith('/') ? `${baseUrl}${href}` : `${baseUrl}/${href}`;
				element.setAttribute('href', newHref);
			},
		});

	const response = rewriter.transform(
		new Response(html, {
			headers: { 'Content-Type': 'text/html' },
		}),
	);

	return response.text();
}
