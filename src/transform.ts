/**
 * Dev server module transform pipeline using esbuild-wasm.
 * Handles import rewriting, module resolution, and TypeScript/JSX transformation.
 */

import { transformCode } from './bundler';

const ESM_CDN = 'https://esm.sh';

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

interface TsConfig {
	compilerOptions?: {
		baseUrl?: string;
		paths?: Record<string, string[]>;
	};
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];

/**
 * Parse and cache tsconfig for a project
 */
async function loadTsConfig(fs: FileSystem, projectRoot: string): Promise<TsConfig | null> {
	try {
		const content = await fs.readFile(`${projectRoot}/tsconfig.json`);
		const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Resolve a path alias from tsconfig paths
 */
function resolvePathAlias(
	specifier: string,
	tsConfig: TsConfig | null,
	projectRoot: string
): string | null {
	if (!tsConfig?.compilerOptions?.paths) return null;

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
						return `/${baseUrl}/${targetBase}/${rest}`.replace(/\/+/g, '/');
					}
				}
			}
		} else if (specifier === pattern) {
			for (const target of targets) {
				return `/${baseUrl}/${target}`.replace(/\/+/g, '/');
			}
		}
	}

	return null;
}

/**
 * Resolve an import specifier to a file path or CDN URL
 */
async function resolveImport(
	specifier: string,
	importer: string,
	fs: FileSystem,
	projectRoot: string,
	baseUrl: string,
	tsConfig: TsConfig | null
): Promise<ResolvedImport> {
	// Check tsconfig paths first for non-relative imports
	if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
		const aliasResolved = resolvePathAlias(specifier, tsConfig, projectRoot);
		if (aliasResolved) {
			// Resolve the alias path like a relative import
			const ext = getExtension(aliasResolved);
			if (!ext) {
				for (const tryExt of EXTENSIONS) {
					try {
						await fs.access(`${projectRoot}${aliasResolved}${tryExt}`);
						return {
							original: specifier,
							resolved: `${baseUrl}${aliasResolved}${tryExt}`,
							isBare: false,
						};
					} catch {
						// Try next
					}
				}
				for (const tryExt of EXTENSIONS) {
					try {
						await fs.access(`${projectRoot}${aliasResolved}/index${tryExt}`);
						return {
							original: specifier,
							resolved: `${baseUrl}${aliasResolved}/index${tryExt}`,
							isBare: false,
						};
					} catch {
						// Try next
					}
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
	const importerDir = importer.substring(0, importer.lastIndexOf('/')) || '';
	let targetPath: string;

	if (specifier.startsWith('/')) {
		targetPath = specifier;
	} else {
		// Resolve relative path
		const parts = importerDir.split('/').filter(Boolean);
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
	const ext = getExtension(targetPath);
	if (!ext) {
		// Try each extension
		for (const tryExt of EXTENSIONS) {
			try {
				await fs.access(`${projectRoot}${targetPath}${tryExt}`);
				return {
					original: specifier,
					resolved: `${baseUrl}${targetPath}${tryExt}`,
					isBare: false,
				};
			} catch {
				// Try next
			}
		}
		// Try index files
		for (const tryExt of EXTENSIONS) {
			try {
				await fs.access(`${projectRoot}${targetPath}/index${tryExt}`);
				return {
					original: specifier,
					resolved: `${baseUrl}${targetPath}/index${tryExt}`,
					isBare: false,
				};
			} catch {
				// Try next
			}
		}
	}

	// Return as-is with base URL
	return {
		original: specifier,
		resolved: `${baseUrl}${targetPath}`,
		isBare: false,
	};
}

function getExtension(path: string): string {
	const match = path.match(/\.[^./]+$/);
	return match ? match[0].toLowerCase() : '';
}

/**
 * Rewrite import statements in transformed code
 */
async function rewriteImports(
	code: string,
	filePath: string,
	fs: FileSystem,
	projectRoot: string,
	baseUrl: string,
	tsConfig: TsConfig | null
): Promise<string> {
	// Match import statements
	// Handles: import x from 'y', import 'y', import { x } from 'y', export * from 'y', etc.
	const importRegex = /(?:import|export)\s*(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*(?:from\s*)?['"]([^'"]+)['"]/g;
	const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

	const imports: Array<{ match: string; specifier: string; start: number; end: number }> = [];

	// Collect all imports
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

	// Resolve all imports
	const resolved = await Promise.all(
		imports.map(async (imp) => ({
			...imp,
			resolution: await resolveImport(imp.specifier, filePath, fs, projectRoot, baseUrl, tsConfig),
		}))
	);

	// Rewrite from end to start to preserve positions
	let result = code;
	for (const imp of resolved.sort((a, b) => b.start - a.start)) {
		const newStatement = imp.match.replace(imp.specifier, imp.resolution.resolved);
		result = result.slice(0, imp.start) + newStatement + result.slice(imp.end);
	}

	return result;
}

// Cache tsconfig per project root
const tsConfigCache = new Map<string, TsConfig | null>();

async function getTsConfig(fs: FileSystem, projectRoot: string): Promise<TsConfig | null> {
	if (!tsConfigCache.has(projectRoot)) {
		tsConfigCache.set(projectRoot, await loadTsConfig(fs, projectRoot));
	}
	return tsConfigCache.get(projectRoot) ?? null;
}

/**
 * Transform and serve a module file
 */
export async function transformModule(
	filePath: string,
	content: string,
	options: TransformOptions
): Promise<{ code: string; contentType: string }> {
	const { fs, projectRoot, baseUrl } = options;
	const ext = getExtension(filePath);
	const tsConfig = await getTsConfig(fs, projectRoot);

	// Transform TypeScript/JSX
	if (['.ts', '.tsx', '.jsx', '.mts'].includes(ext)) {
		const transformed = await transformCode(content, filePath, { sourcemap: true });
		const rewritten = await rewriteImports(transformed.code, filePath, fs, projectRoot, baseUrl, tsConfig);
		return { code: rewritten, contentType: 'application/javascript' };
	}

	// Transform JS files (just rewrite imports)
	if (['.js', '.mjs'].includes(ext)) {
		const rewritten = await rewriteImports(content, filePath, fs, projectRoot, baseUrl, tsConfig);
		return { code: rewritten, contentType: 'application/javascript' };
	}

	// Transform CSS to JS module that injects styles
	if (ext === '.css') {
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
	if (ext === '.json') {
		return {
			code: `export default ${content};`,
			contentType: 'application/javascript',
		};
	}

	// Return as-is for other files
	return { code: content, contentType: getContentType(ext) };
}

function getContentType(ext: string): string {
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
	return types[ext] || 'text/plain';
}

/**
 * Generate HMR client code to inject into HTML
 */
export function generateHMRClient(wsUrl: string): string {
	return `
<script type="module">
// HMR client
const socket = new WebSocket('${wsUrl}');
const modules = new Map();

socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'full-reload') {
    location.reload();
  } else if (data.type === 'update') {
    // Hot module update
    data.updates?.forEach(update => {
      if (update.type === 'js-update') {
        import(update.path + '?t=' + update.timestamp).then(mod => {
          console.log('[hmr] hot updated:', update.path);
        });
      } else if (update.type === 'css-update') {
        const style = document.querySelector(\`style[data-dev-id="\${update.path}"]\`);
        if (style) {
          fetch('/preview' + update.path + '?raw&t=' + update.timestamp)
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

/**
 * Generate fetch interceptor that rewrites API requests to include baseUrl prefix
 */
function generateFetchInterceptor(baseUrl: string): string {
	if (!baseUrl) return '';

	return `
<script>
// Fetch interceptor - rewrites /api/* requests to ${baseUrl}/api/*
(function() {
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    let url = input;
    if (typeof input === 'string') {
      if (input.startsWith('/api/') || input === '/api') {
        url = '${baseUrl}' + input;
      }
    } else if (input instanceof Request) {
      const reqUrl = new URL(input.url);
      if (reqUrl.pathname.startsWith('/api/') || reqUrl.pathname === '/api') {
        reqUrl.pathname = '${baseUrl}' + reqUrl.pathname;
        input = new Request(reqUrl.toString(), input);
      }
      url = input;
    }
    return originalFetch.call(this, url, init);
  };

  // Also intercept XMLHttpRequest for completeness
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    let newUrl = url;
    if (typeof url === 'string') {
      if (url.startsWith('/api/') || url === '/api') {
        newUrl = '${baseUrl}' + url;
      }
    }
    return originalXHROpen.call(this, method, newUrl, ...rest);
  };
})();
</script>`;
}

/**
 * Process HTML file using HTMLRewriter - inject HMR client and rewrite script/link tags
 */
export async function processHTML(
	html: string,
	filePath: string,
	options: TransformOptions & { hmrUrl: string }
): Promise<string> {
	const { baseUrl, hmrUrl } = options;

	const fetchInterceptor = generateFetchInterceptor(baseUrl);
	const hmrClient = generateHMRClient(hmrUrl);

	const rewriter = new HTMLRewriter()
		.on('head', {
			element(element) {
				element.append(fetchInterceptor + hmrClient, { html: true });
			},
		})
		.on('script[src]', {
			element(element) {
				const src = element.getAttribute('src');
				if (!src || src.startsWith('http://') || src.startsWith('https://')) {
					return;
				}
				const newSrc = src.startsWith('/') ? `${baseUrl}${src}` : `${baseUrl}/${src}`;
				element.setAttribute('src', newSrc);
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

	const response = rewriter.transform(new Response(html, {
		headers: { 'Content-Type': 'text/html' },
	}));

	return response.text();
}
