/**
 * Vite-like dev server that runs within the Worker using esbuild-wasm.
 * Handles import rewriting, module resolution, and transformation.
 */

import { transformCode } from './bundler';

const ESM_CDN = 'https://esm.sh';

export interface FileSystem {
	readFile(path: string): Promise<string | Uint8Array>;
	access(path: string): Promise<void>;
}

export interface ViteDevOptions {
	fs: FileSystem;
	projectRoot: string;
	baseUrl: string;
}

interface ResolvedImport {
	original: string;
	resolved: string;
	isBare: boolean;
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];

/**
 * Resolve an import specifier to a file path or CDN URL
 */
async function resolveImport(
	specifier: string,
	importer: string,
	fs: FileSystem,
	projectRoot: string,
	baseUrl: string
): Promise<ResolvedImport> {
	// Bare imports (packages) -> redirect to esm.sh CDN
	if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
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
	baseUrl: string
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
			resolution: await resolveImport(imp.specifier, filePath, fs, projectRoot, baseUrl),
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

/**
 * Transform and serve a file with Vite-like behavior
 */
export async function transformModule(
	filePath: string,
	content: string,
	options: ViteDevOptions
): Promise<{ code: string; contentType: string }> {
	const { fs, projectRoot, baseUrl } = options;
	const ext = getExtension(filePath);

	// Transform TypeScript/JSX
	if (['.ts', '.tsx', '.jsx', '.mts'].includes(ext)) {
		const transformed = await transformCode(content, filePath, { sourcemap: true });
		const rewritten = await rewriteImports(transformed.code, filePath, fs, projectRoot, baseUrl);
		return { code: rewritten, contentType: 'application/javascript' };
	}

	// Transform JS files (just rewrite imports)
	if (['.js', '.mjs'].includes(ext)) {
		const rewritten = await rewriteImports(content, filePath, fs, projectRoot, baseUrl);
		return { code: rewritten, contentType: 'application/javascript' };
	}

	// Transform CSS to JS module that injects styles
	if (ext === '.css') {
		const cssContent = JSON.stringify(content);
		const code = `
const css = ${cssContent};
const style = document.createElement('style');
style.setAttribute('data-vite-dev-id', ${JSON.stringify(filePath)});
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
// Vite-like HMR client
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
          console.log('[vite] hot updated:', update.path);
        });
      } else if (update.type === 'css-update') {
        const style = document.querySelector(\`style[data-vite-dev-id="\${update.path}"]\`);
        if (style) {
          fetch(update.path + '?t=' + update.timestamp)
            .then(r => r.text())
            .then(css => {
              style.textContent = css;
              console.log('[vite] css hot updated:', update.path);
            });
        }
      }
    });
  }
});

socket.addEventListener('open', () => {
  console.log('[vite] connected.');
});

socket.addEventListener('close', () => {
  console.log('[vite] server connection lost. polling for restart...');
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
window.__vite_hot_modules = modules;
</script>`;
}

/**
 * Process HTML file - inject HMR client and rewrite script/link tags
 */
export async function processHTML(
	html: string,
	filePath: string,
	options: ViteDevOptions & { hmrUrl: string }
): Promise<string> {
	const { baseUrl, hmrUrl } = options;

	// Inject HMR client
	const hmrClient = generateHMRClient(hmrUrl);
	html = html.replace('</head>', `${hmrClient}</head>`);

	// Rewrite script src to use base URL (for relative paths)
	html = html.replace(
		/<script([^>]*)\ssrc=["'](?!https?:\/\/)([^"']+)["']/gi,
		(match, attrs, src) => {
			if (src.startsWith('/')) {
				return `<script${attrs} src="${baseUrl}${src}"`;
			}
			return `<script${attrs} src="${baseUrl}/${src}"`;
		}
	);

	// Rewrite link href for CSS
	html = html.replace(
		/<link([^>]*)\shref=["'](?!https?:\/\/)([^"']+\.css)["']/gi,
		(match, attrs, href) => {
			if (href.startsWith('/')) {
				return `<link${attrs} href="${baseUrl}${href}"`;
			}
			return `<link${attrs} href="${baseUrl}/${href}"`;
		}
	);

	return html;
}
