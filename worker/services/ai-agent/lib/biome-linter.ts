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

interface BiomeLintApi {
	lintContent: (
		projectKey: number,
		content: string,
		options: { filePath: string; fixFileMode?: 'safeFixes' | 'safeAndUnsafeFixes' },
	) => {
		content: string;
		diagnostics: BiomeDiagnosticResult[];
	};
}

interface BiomeWorkspace {
	openFile: (options: { projectKey: number; content: { type: string; content: string; version: number }; path: string }) => void;
	closeFile: (options: { projectKey: number; path: string }) => void;
	pullDiagnostics: (options: { projectKey: number; path: string; categories: string[]; pullCodeActions: boolean }) => {
		diagnostics: BiomeDiagnosticResult[];
	};
}

let initPromise: Promise<void> | undefined;
let initFailed = false;
let storedProjectKey: number | undefined;
let biomeLintApi: BiomeLintApi | undefined;
let biomeWorkspace: BiomeWorkspace | undefined;

async function ensureBiome(): Promise<boolean> {
	if (initFailed) return false;
	if (!initPromise) {
		initPromise = initBiome();
	}
	try {
		await initPromise;
		return true;
	} catch {
		initFailed = true;
		initPromise = undefined;
		return false;
	}
}

async function initBiome(): Promise<void> {
	// Initialize the WASM binary first — @biomejs/wasm-web exports a default
	// init function that must resolve before any classes (Workspace, etc.) work.
	const wasmModule = await import('@biomejs/wasm-web');
	await wasmModule.default();

	const { Biome, Distribution } = await import('@biomejs/js-api');
	const biome = await Biome.create({ distribution: Distribution.WEB });

	const project = biome.openProject();
	storedProjectKey = project.projectKey;

	biome.applyConfiguration(storedProjectKey, {
		linter: {
			enabled: true,
		},
		formatter: {
			enabled: false,
		},
	});

	// Store the high-level lintContent API (used by fixFileForAgent)
	biomeLintApi = biome;

	// Extract the workspace reference for direct pullDiagnostics calls.
	// The `workspace` property is private on BiomeCommon but exists at runtime.
	const descriptor = Object.getOwnPropertyDescriptor(biome, 'workspace');
	if (descriptor?.value) {
		biomeWorkspace = descriptor.value;
	}
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
// Workspace-level Diagnostics
// =============================================================================

/**
 * Pull diagnostics directly from the Biome workspace with pullCodeActions
 * enabled so that the `fixable` tag is populated on each diagnostic.
 */
function pullDiagnosticsWithCodeActions(key: number, filePath: string, content: string): BiomeDiagnosticResult[] {
	if (!biomeWorkspace) {
		return [];
	}
	biomeWorkspace.openFile({
		projectKey: key,
		content: { type: 'fromClient', content, version: 0 },
		path: filePath,
	});
	try {
		const { diagnostics } = biomeWorkspace.pullDiagnostics({
			projectKey: key,
			path: filePath,
			categories: ['syntax', 'lint', 'action'],
			pullCodeActions: true,
		});
		return diagnostics;
	} finally {
		biomeWorkspace.closeFile({ projectKey: key, path: filePath });
	}
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

	const ready = await ensureBiome();
	if (!ready || storedProjectKey === undefined || !biomeWorkspace) return [];

	try {
		const diagnostics = pullDiagnosticsWithCodeActions(storedProjectKey, filePath, content);

		return diagnostics.map((diagnostic) => {
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
 * Returned when fixFileForAgent cannot apply fixes.
 * The `reason` field contains a human-readable explanation of why.
 */
export interface FixFileFailure {
	failed: true;
	reason: string;
}

/**
 * Apply safe lint fixes to a file using Biome WASM.
 * Returns the fixed content and remaining diagnostics, or a failure object
 * with a human-readable reason when fixes cannot be applied.
 */
export async function fixFileForAgent(filePath: string, content: string): Promise<ServerLintFixResult | FixFileFailure> {
	if (!isLintableFile(filePath)) {
		return { failed: true, reason: `File type not supported for lint fixing: ${filePath}` };
	}

	const ready = await ensureBiome();
	if (!ready || storedProjectKey === undefined || !biomeLintApi) {
		return { failed: true, reason: 'Biome linter failed to initialize' };
	}

	try {
		// Count original diagnostics
		const originalResult = biomeLintApi.lintContent(storedProjectKey, content, { filePath });
		const originalCount = originalResult.diagnostics.length;
		if (originalCount === 0) return { fixedContent: content, fixCount: 0, remainingDiagnostics: [] };

		// Apply all fixes (safe + unsafe)
		const fixedResult = biomeLintApi.lintContent(storedProjectKey, content, {
			filePath,
			fixFileMode: 'safeAndUnsafeFixes',
		});

		// Lint the fixed content to get remaining diagnostics
		const remainingResult = biomeLintApi.lintContent(storedProjectKey, fixedResult.content, { filePath });

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
	} catch (error) {
		return { failed: true, reason: `Biome threw an error: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Format pre-computed lint diagnostics as a string suitable for appending to tool results.
 * Returns undefined if the array is empty.
 */
export function formatLintDiagnostics(diagnostics: ServerLintDiagnostic[]): string | undefined {
	if (diagnostics.length === 0) return undefined;

	const lines = diagnostics.map(
		(diagnostic) => `  - line ${diagnostic.line}: ${diagnostic.message} (${diagnostic.rule})${diagnostic.fixable ? ' [auto-fixable]' : ''}`,
	);

	const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
	const warningCount = diagnostics.length - errorCount;

	const summary = [errorCount > 0 ? `${errorCount} error(s)` : '', warningCount > 0 ? `${warningCount} warning(s)` : '']
		.filter(Boolean)
		.join(', ');

	return `Lint diagnostics (${summary}):\n${lines.join('\n')}`;
}

/**
 * Lint a file and format the results as a string suitable for appending to tool results.
 * Returns undefined if there are no diagnostics.
 */
export async function formatLintResultsForAgent(filePath: string, content: string): Promise<string | undefined> {
	const diagnostics = await lintFileForAgent(filePath, content);
	const formatted = formatLintDiagnostics(diagnostics);
	return formatted ? `\n${formatted}` : undefined;
}
