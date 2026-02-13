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
// HMR Client Generation
// =============================================================================

function sanitizeJsString(s: string): string {
	return s
		.replaceAll('\\', '\\\\')
		.replaceAll("'", String.raw`\'`)
		.replaceAll('\n', String.raw`\n`)
		.replaceAll('\r', String.raw`\r`)
		.replaceAll(/<\/(script)/gi, String.raw`<\/$1`);
}

/**
 * Generate HMR client code to inject into HTML.
 */
export function generateHMRClient(wsUrl: string, baseUrl: string): string {
	const safeWsUrl = sanitizeJsString(wsUrl);
	const safeBaseUrl = sanitizeJsString(baseUrl);
	return `
<script type="module">
// HMR client
const socket = new WebSocket('${safeWsUrl}');
const modules = new Map();
const hmrBaseUrl = '${safeBaseUrl}';

// Console interceptor — forward logs to the parent IDE frame
(function() {
  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    const original = console[level];
    console[level] = function(...args) {
      original.apply(console, args);
      try {
        const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        // Skip HMR-internal messages
        if (message.startsWith('[hmr]')) return;
        window.parent.postMessage({
          type: '__console-log',
          level,
          message,
          timestamp: Date.now()
        }, '*');
      } catch {
        // Ignore serialization errors
      }
    };
  }
})();

window.showErrorOverlay = showErrorOverlay;
window.hideErrorOverlay = hideErrorOverlay;
function showErrorOverlay(err) {
  hideErrorOverlay();
  const overlay = document.createElement('div');
  overlay.id = '__error-overlay';
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const loc = err.file ? esc(err.file + (err.line ? ':' + err.line : '') + (err.column ? ':' + err.column : '')) : '';
  overlay.innerHTML = \`
    <style>
      #__error-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace}
      .__eo-card{background:#1a1a2e;color:#e0e0e0;border-radius:12px;max-width:640px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid rgba(248,81,73,0.4)}
      .__eo-header{padding:16px 20px;border-bottom:1px solid rgba(248,81,73,0.3);display:flex;align-items:center;gap:10px}
      .__eo-badge{background:rgba(248,81,73,0.2);color:#f85149;font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:4px}
      .__eo-title{color:#f85149;font-size:14px;font-weight:600;flex:1}
      .__eo-close{background:none;border:none;color:#8b949e;cursor:pointer;font-size:18px;padding:4px 8px;border-radius:4px}
      .__eo-close:hover{background:rgba(255,255,255,0.1);color:#e0e0e0}
      .__eo-body{padding:16px 20px}
      .__eo-file{color:#58a6ff;font-size:13px;margin-bottom:12px;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;transition:text-decoration-color 0.15s}
      .__eo-file:hover{text-decoration-color:#58a6ff}
      .__eo-msg{background:#0d1117;border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:#f0f0f0;border:1px solid rgba(48,54,61,0.8)}
    </style>
    <div class="__eo-card">
      <div class="__eo-header">
        <span class="__eo-badge">\${esc(err.type || 'error')}</span>
        <span class="__eo-title">Build Error</span>
        <button class="__eo-close" onclick="document.getElementById('__error-overlay')?.remove()">&times;</button>
      </div>
      <div class="__eo-body">
        \${loc ? '<div class="__eo-file" data-file="/' + esc(err.file || '') + '" data-line="' + (err.line || 1) + '" data-column="' + (err.column || 1) + '">' + loc + '</div>' : ''}
        <div class="__eo-msg">\${esc(err.message || 'Unknown error')}</div>
      </div>
    </div>\`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const fileEl = overlay.querySelector('.__eo-file');
  if (fileEl) {
    fileEl.addEventListener('click', () => {
      window.parent.postMessage({ type: '__open-file', file: fileEl.dataset.file, line: parseInt(fileEl.dataset.line, 10) || 1, column: parseInt(fileEl.dataset.column, 10) || 1 }, '*');
    });
  }
}
function hideErrorOverlay() {
  document.getElementById('__error-overlay')?.remove();
}

socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'full-reload') {
    location.reload();
  } else if (data.type === 'server-error' && data.error) {
    showErrorOverlay(data.error);
  } else if (data.type === 'update') {
    hideErrorOverlay();
    data.updates?.forEach(update => {
      if (update.type === 'js-update') {
        import(hmrBaseUrl + update.path + '?t=' + update.timestamp).then(mod => {
          console.log('[hmr] hot updated:', update.path);
        });
      } else if (update.type === 'css-update') {
        const style = document.querySelector(\`style[data-dev-id="\${update.path}"]\`);
        if (style) {
          fetch(hmrBaseUrl + update.path + '?raw&t=' + update.timestamp)
            .then(r => r.text())
            .then(css => {
              style.textContent = css;
              console.log('[hmr] css hot updated:', update.path);
            });
        }
      }
    });
  }
});

socket.addEventListener('open', () => {
  console.log('[hmr] connected.');
});

socket.addEventListener('close', () => {
  console.log('[hmr] server connection lost. polling for restart...');
  setInterval(() => {
    fetch(location.href).then(() => location.reload());
  }, 1000);
});

// Keep connection alive
setInterval(() => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000);

// Expose for HMR API
window.__hot_modules = modules;
</script>`;
}

// =============================================================================
// Fetch Interceptor
// =============================================================================

/**
 * Generate fetch interceptor that rewrites API requests to preview API path.
 */
function generateFetchInterceptor(baseUrl: string): string {
	if (!baseUrl) return '';

	const previewBase = sanitizeJsString(baseUrl.replace(/\/$/, ''));

	return `
<script>
// Fetch interceptor - rewrites /api/* requests to ${previewBase}/api/*
(function() {
  const previewBase = '${previewBase}';
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    let url = input;
    if (typeof input === 'string') {
      if (input.startsWith('/api/') || input === '/api') {
        url = previewBase + input;
      }
    } else if (input instanceof Request) {
      const reqUrl = new URL(input.url);
      if (reqUrl.pathname.startsWith('/api/') || reqUrl.pathname === '/api') {
        reqUrl.pathname = previewBase + reqUrl.pathname;
        input = new Request(reqUrl.toString(), input);
      }
      url = input;
    }
    return originalFetch.call(this, url, init);
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    let newUrl = url;
    if (typeof url === 'string') {
      if (url.startsWith('/api/') || url === '/api') {
        newUrl = previewBase + url;
      }
    }
    return originalXHROpen.call(this, method, newUrl, ...rest);
  };
})();
</script>`;
}

// =============================================================================
// HTML Processing
// =============================================================================

/**
 * Process HTML file using HTMLRewriter - inject HMR client and rewrite script/link tags.
 */
export async function processHTML(html: string, _filePath: string, options: TransformOptions & { hmrUrl: string }): Promise<string> {
	const { baseUrl, hmrUrl } = options;

	const fetchInterceptor = generateFetchInterceptor(baseUrl);
	const hmrClient = generateHMRClient(hmrUrl, baseUrl);

	const rewriter = new HTMLRewriter()
		.on('head', {
			element(element) {
				element.append(fetchInterceptor + hmrClient, { html: true });
			},
		})
		.on('script[src]', {
			element(element) {
				const source = element.getAttribute('src');
				if (!source || source.startsWith('http://') || source.startsWith('https://')) {
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
