/**
 * Biome Linter Service
 *
 * Lazy-initializes Biome WASM and provides a `lintFile()` function
 * that returns normalized lint diagnostics for a given file.
 * Runs entirely client-side using @biomejs/wasm-web.
 */

import type { Diagnostic as BiomeDiagnostic } from '@biomejs/wasm-web';

// =============================================================================
// Types
// =============================================================================

export interface LintDiagnostic {
	/** File path the diagnostic applies to */
	filePath: string;
	/** Human-readable message */
	message: string;
	/** Severity level */
	severity: 'error' | 'warning' | 'info' | 'hint';
	/** 0-based byte offset of the start of the diagnostic span */
	from: number;
	/** 0-based byte offset of the end of the diagnostic span */
	to: number;
	/** Biome rule category (e.g. "lint/style/noVar") */
	rule?: string;
	/** Whether Biome can auto-fix this diagnostic */
	fixable: boolean;
}

// =============================================================================
// Supported Extensions
// =============================================================================

const LINTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.json']);

export function isLintableFile(filePath: string): boolean {
	const extension = filePath.slice(filePath.lastIndexOf('.'));
	return LINTABLE_EXTENSIONS.has(extension);
}

// =============================================================================
// Singleton Biome Instance
// =============================================================================

interface BiomeInstance {
	lintContent: (
		projectKey: number,
		content: string,
		options: { filePath: string; fixFileMode?: 'safeFixes' | 'safeAndUnsafeFixes' },
	) => { content: string; diagnostics: BiomeDiagnostic[] };
	openProject: (path?: string) => { projectKey: number };
	applyConfiguration: (projectKey: number, configuration: Record<string, unknown>) => void;
	shutdown: () => void;
}

let biomePromise: Promise<BiomeInstance> | undefined;
let projectKey: number | undefined;

async function getBiome(): Promise<BiomeInstance> {
	if (!biomePromise) {
		biomePromise = initBiome();
	}
	return biomePromise;
}

async function initBiome(): Promise<BiomeInstance> {
	// Initialize the WASM binary first — @biomejs/wasm-web exports a default
	// init function that must resolve before any classes (Workspace, etc.) work.
	const wasmModule = await import('@biomejs/wasm-web');
	await wasmModule.default();

	const { Biome, Distribution } = await import('@biomejs/js-api');
	const biome = await Biome.create({ distribution: Distribution.WEB });

	const project = biome.openProject();
	projectKey = project.projectKey;

	biome.applyConfiguration(projectKey, {
		linter: {
			enabled: true,
		},
		formatter: {
			enabled: false,
		},
	});

	return biome;
}

// =============================================================================
// Severity Mapping
// =============================================================================

function mapSeverity(severity: string): LintDiagnostic['severity'] {
	switch (severity) {
		case 'error':
		case 'fatal': {
			return 'error';
		}
		case 'warning': {
			return 'warning';
		}
		case 'information': {
			return 'info';
		}
		default: {
			return 'hint';
		}
	}
}

// =============================================================================
// Extract Message Text
// =============================================================================

function extractMessage(diagnostic: BiomeDiagnostic): string {
	if (diagnostic.description) {
		return diagnostic.description;
	}
	if (diagnostic.message && diagnostic.message.length > 0) {
		return diagnostic.message.map((node) => node.content).join('');
	}
	return 'Unknown lint issue';
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Result of an autofix operation.
 */
export interface LintFixResult {
	/** The fixed file content */
	content: string;
	/** Number of fixes applied */
	fixCount: number;
	/** Remaining diagnostics after fix */
	remainingDiagnostics: LintDiagnostic[];
}

/**
 * Apply safe lint fixes to a file using Biome WASM.
 * Returns the fixed content and remaining diagnostics.
 * Returns undefined for unsupported file types or if Biome fails.
 */
export async function fixFile(filePath: string, content: string): Promise<LintFixResult | undefined> {
	if (!isLintableFile(filePath)) {
		return undefined;
	}

	try {
		const biome = await getBiome();

		// First lint without fixes to count original diagnostics
		const originalResult = biome.lintContent(projectKey!, content, { filePath });
		const originalCount = originalResult.diagnostics.length;

		// Apply safe fixes
		const fixedResult = biome.lintContent(projectKey!, content, {
			filePath,
			fixFileMode: 'safeFixes',
		});

		// Lint the fixed content to get remaining diagnostics
		const remainingResult = biome.lintContent(projectKey!, fixedResult.content, { filePath });

		const remainingDiagnostics = remainingResult.diagnostics.map((diagnostic) => {
			const span = diagnostic.location?.span;
			const from = span ? span[0] : 0;
			const to = span ? span[1] : 0;

			return {
				filePath,
				message: extractMessage(diagnostic),
				severity: mapSeverity(diagnostic.severity),
				from,
				to: to > from ? to : from + 1,
				rule: diagnostic.category ?? undefined,
				fixable: diagnostic.tags.includes('fixable'),
			};
		});

		return {
			content: fixedResult.content,
			fixCount: originalCount - remainingDiagnostics.length,
			remainingDiagnostics,
		};
	} catch (error) {
		console.warn('[biome-linter] Fix failed:', error);
		return undefined;
	}
}

/**
 * Lint a file using Biome WASM. Returns normalized diagnostics.
 * Returns an empty array for unsupported file types or if Biome fails to initialize.
 */
export async function lintFile(filePath: string, content: string): Promise<LintDiagnostic[]> {
	if (!isLintableFile(filePath)) {
		return [];
	}

	try {
		const biome = await getBiome();
		const result = biome.lintContent(projectKey!, content, { filePath });

		return result.diagnostics.map((diagnostic) => {
			const span = diagnostic.location?.span;
			const from = span ? span[0] : 0;
			const to = span ? span[1] : 0;

			return {
				filePath,
				message: extractMessage(diagnostic),
				severity: mapSeverity(diagnostic.severity),
				from,
				to: to > from ? to : from + 1,
				rule: diagnostic.category ?? undefined,
				fixable: diagnostic.tags.includes('fixable'),
			};
		});
	} catch (error) {
		console.warn('[biome-linter] Lint failed:', error);
		return [];
	}
}
