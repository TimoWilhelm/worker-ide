/**
 * Server-side Biome Linter
 *
 * Provides lint diagnostics for AI agent tool results.
 * Uses @biomejs/js-api with @biomejs/wasm-web distribution.
 *
 * Initialization is lazy — the WASM module is only loaded on first lint call.
 * If initialization fails (e.g. WASM not available), lint calls silently return
 * empty results so they never block file operations.
 */

// =============================================================================
// Types
// =============================================================================

export interface ServerLintDiagnostic {
	/** 1-based line number */
	line: number;
	/** Rule category (e.g. "lint/style/noVar") */
	rule: string;
	/** Human-readable message */
	message: string;
	/** Severity */
	severity: 'error' | 'warning';
	/** Whether Biome can auto-fix this diagnostic */
	fixable: boolean;
}

// =============================================================================
// Supported Extensions
// =============================================================================

const LINTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.json']);

function isLintableFile(filePath: string): boolean {
	const extension = filePath.slice(filePath.lastIndexOf('.'));
	return LINTABLE_EXTENSIONS.has(extension);
}

// =============================================================================
// Lazy Biome Instance
// =============================================================================

interface BiomeDiagnosticResult {
	description: string;
	severity: string;
	category?: string;
	location?: { span?: [number, number]; sourceCode?: string };
	message?: Array<{ content: string }>;
	tags: string[];
}

interface BiomeInstance {
	lintContent: (
		projectKey: number,
		content: string,
		options: { filePath: string; fixFileMode?: 'safeFixes' | 'safeAndUnsafeFixes' },
	) => {
		content: string;
		diagnostics: BiomeDiagnosticResult[];
	};
	openProject: (path?: string) => { projectKey: number };
	applyConfiguration: (projectKey: number, configuration: Record<string, unknown>) => void;
	shutdown: () => void;
}

let biomePromise: Promise<{ biome: BiomeInstance; projectKey: number }> | undefined;
let initFailed = false;

async function getBiome(): Promise<{ biome: BiomeInstance; projectKey: number } | undefined> {
	if (initFailed) return undefined;
	if (!biomePromise) {
		biomePromise = initBiome();
	}
	try {
		return await biomePromise;
	} catch {
		initFailed = true;
		biomePromise = undefined;
		return undefined;
	}
}

async function initBiome(): Promise<{ biome: BiomeInstance; projectKey: number }> {
	// Initialize the WASM binary first — @biomejs/wasm-web exports a default
	// init function that must resolve before any classes (Workspace, etc.) work.
	const wasmModule = await import('@biomejs/wasm-web');
	await wasmModule.default();

	const { Biome, Distribution } = await import('@biomejs/js-api');
	const biome = await Biome.create({ distribution: Distribution.WEB });

	const project = biome.openProject();

	biome.applyConfiguration(project.projectKey, {
		linter: {
			enabled: true,
		},
		formatter: {
			enabled: false,
		},
	});

	return { biome, projectKey: project.projectKey };
}

// =============================================================================
// Severity Mapping
// =============================================================================

function mapDiagnosticSeverity(severity: string): ServerLintDiagnostic['severity'] {
	switch (severity) {
		case 'error':
		case 'fatal': {
			return 'error';
		}
		default: {
			return 'warning';
		}
	}
}

// =============================================================================
// Offset → Line Conversion
// =============================================================================

function offsetToLine(content: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset && index < content.length; index++) {
		if (content[index] === '\n') {
			line++;
		}
	}
	return line;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Lint a file and return diagnostics formatted for AI agent consumption.
 * Returns an empty array if the file type is unsupported or Biome is unavailable.
 */
export async function lintFileForAgent(filePath: string, content: string): Promise<ServerLintDiagnostic[]> {
	if (!isLintableFile(filePath)) return [];

	const instance = await getBiome();
	if (!instance) return [];

	try {
		const result = instance.biome.lintContent(instance.projectKey, content, { filePath });

		return result.diagnostics.map((diagnostic) => {
			const span = diagnostic.location?.span;
			const line = span ? offsetToLine(content, span[0]) : 1;

			let message = diagnostic.description;
			if (!message && diagnostic.message && diagnostic.message.length > 0) {
				message = diagnostic.message.map((node) => node.content).join('');
			}

			return {
				line,
				rule: diagnostic.category ?? 'biome',
				message: message || 'Unknown lint issue',
				severity: mapDiagnosticSeverity(diagnostic.severity),
				fixable: diagnostic.tags.includes('fixable'),
			};
		});
	} catch {
		return [];
	}
}

/**
 * Result of an autofix operation.
 */
export interface ServerLintFixResult {
	/** The fixed file content */
	fixedContent: string;
	/** Number of fixes applied */
	fixCount: number;
	/** Remaining diagnostics after fix */
	remainingDiagnostics: ServerLintDiagnostic[];
}

/**
 * Apply safe lint fixes to a file using Biome WASM.
 * Returns the fixed content and remaining diagnostics, or undefined if unavailable.
 */
export async function fixFileForAgent(filePath: string, content: string): Promise<ServerLintFixResult | undefined> {
	if (!isLintableFile(filePath)) return undefined;

	const instance = await getBiome();
	if (!instance) return undefined;

	try {
		// Count original diagnostics
		const originalResult = instance.biome.lintContent(instance.projectKey, content, { filePath });
		const originalCount = originalResult.diagnostics.length;
		if (originalCount === 0) return { fixedContent: content, fixCount: 0, remainingDiagnostics: [] };

		// Apply safe fixes
		const fixedResult = instance.biome.lintContent(instance.projectKey, content, {
			filePath,
			fixFileMode: 'safeFixes',
		});

		// Lint the fixed content to get remaining diagnostics
		const remainingResult = instance.biome.lintContent(instance.projectKey, fixedResult.content, { filePath });

		const remainingDiagnostics = remainingResult.diagnostics.map((diagnostic) => {
			const span = diagnostic.location?.span;
			const line = span ? offsetToLine(fixedResult.content, span[0]) : 1;

			let message = diagnostic.description;
			if (!message && diagnostic.message && diagnostic.message.length > 0) {
				message = diagnostic.message.map((node) => node.content).join('');
			}

			return {
				line,
				rule: diagnostic.category ?? 'biome',
				message: message || 'Unknown lint issue',
				severity: mapDiagnosticSeverity(diagnostic.severity),
				fixable: diagnostic.tags.includes('fixable'),
			};
		});

		return {
			fixedContent: fixedResult.content,
			fixCount: originalCount - remainingDiagnostics.length,
			remainingDiagnostics,
		};
	} catch {
		return undefined;
	}
}

/**
 * Format lint diagnostics as a string suitable for appending to tool results.
 * Returns undefined if there are no diagnostics.
 */
export async function formatLintResultsForAgent(filePath: string, content: string): Promise<string | undefined> {
	const diagnostics = await lintFileForAgent(filePath, content);
	if (diagnostics.length === 0) return undefined;

	const lines = diagnostics.map(
		(diagnostic) => `  - line ${diagnostic.line}: ${diagnostic.message} (${diagnostic.rule})${diagnostic.fixable ? ' [auto-fixable]' : ''}`,
	);

	const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
	const warningCount = diagnostics.length - errorCount;

	const summary = [errorCount > 0 ? `${errorCount} error(s)` : '', warningCount > 0 ? `${warningCount} warning(s)` : '']
		.filter(Boolean)
		.join(', ');

	return `\nLint diagnostics (${summary}):\n${lines.join('\n')}`;
}
