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

type TextRange = [number, number];

type DiffOp = { equal: { range: TextRange } } | { insert: { range: TextRange } } | { delete: { range: TextRange } };

type CompressedOp = { diffOp: DiffOp } | { equalLines: { line_count: number } };

interface BiomeTextEdit {
	dictionary: string;
	ops: CompressedOp[];
}

interface BiomeCodeSuggestion {
	span: TextRange;
	suggestion: BiomeTextEdit;
}

interface BiomeCodeAction {
	suggestion: BiomeCodeSuggestion;
}

interface BiomeWorkspace {
	openFile: (options: { projectKey: number; content: { type: string; content: string; version: number }; path: string }) => void;
	closeFile: (options: { projectKey: number; path: string }) => void;
	pullDiagnostics: (options: { projectKey: number; path: string; categories: string[]; pullCodeActions: boolean }) => {
		diagnostics: BiomeDiagnostic[];
	};
	pullActions: (options: { projectKey: number; path: string; range: TextRange; categories: string[] }) => {
		actions: BiomeCodeAction[];
	};
}

interface BiomeLintApi {
	lintContent: (
		projectKey: number,
		content: string,
		options: { filePath: string; fixFileMode?: 'safeFixes' | 'safeAndUnsafeFixes' },
	) => { content: string; diagnostics: BiomeDiagnostic[] };
	formatContent: (
		projectKey: number,
		content: string,
		options: { filePath: string },
	) => { content: string; diagnostics: BiomeDiagnostic[] };
}

let initPromise: Promise<void> | undefined;
let projectKey: number | undefined;
let biomeLintApi: BiomeLintApi | undefined;
let biomeWorkspace: BiomeWorkspace | undefined;

async function ensureBiome(): Promise<void> {
	if (!initPromise) {
		initPromise = initBiome();
	}
	return initPromise;
}

async function initBiome(): Promise<void> {
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
			enabled: true,
		},
	});

	// Store the high-level lintContent API
	biomeLintApi = biome;

	// Extract the workspace reference for direct pullDiagnostics calls.
	// The `workspace` property is private on BiomeCommon but exists at runtime.
	// We use Object.getOwnPropertyDescriptor to avoid type assertions.
	const descriptor = Object.getOwnPropertyDescriptor(biome, 'workspace');
	if (descriptor?.value) {
		biomeWorkspace = descriptor.value;
	}
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
// TextEdit Application
// =============================================================================

/**
 * Apply a Biome TextEdit to produce the new content.
 *
 * Biome's TextEdit format (from biome_text_edit crate):
 * - `dictionary`: interned string containing text for Equal and Insert ops
 * - `Equal { range }`: range into dictionary; advances input_position by range length
 * - `Insert { range }`: range into dictionary; does NOT advance input_position
 * - `Delete { range }`: no output; advances input_position by range length
 * - `EqualLines { line_count }`: copies (line_count + 1) lines from old_string at input_position
 */
function applyTextEdit(originalContent: string, edit: BiomeTextEdit): string {
	const { dictionary, ops } = edit;
	let result = '';
	let inputPosition = 0;

	for (const op of ops) {
		if ('equalLines' in op) {
			const input = originalContent.slice(inputPosition);
			const lineBreakCount = op.equalLines.line_count + 1;
			let consumed = 0;
			let linesFound = 0;
			for (const line of splitInclusive(input, '\n')) {
				if (linesFound >= lineBreakCount) break;
				result += line;
				consumed += line.length;
				linesFound++;
			}
			inputPosition += consumed;
		} else if ('diffOp' in op) {
			const diffOp = op.diffOp;
			if ('equal' in diffOp) {
				const [start, end] = diffOp.equal.range;
				result += dictionary.slice(start, end);
				inputPosition += end - start;
			} else if ('insert' in diffOp) {
				const [start, end] = diffOp.insert.range;
				result += dictionary.slice(start, end);
			} else if ('delete' in diffOp) {
				const [start, end] = diffOp.delete.range;
				inputPosition += end - start;
			}
		}
	}

	return result;
}

/**
 * Split a string by a delimiter, keeping the delimiter at the end of each segment.
 * Equivalent to Rust's `str::split_inclusive`.
 */
function* splitInclusive(text: string, delimiter: string): Generator<string> {
	let start = 0;
	let index = text.indexOf(delimiter, start);
	while (index !== -1) {
		yield text.slice(start, index + delimiter.length);
		start = index + delimiter.length;
		index = text.indexOf(delimiter, start);
	}
	if (start < text.length) {
		yield text.slice(start);
	}
}

/**
 * Apply a single fix for a specific diagnostic span using workspace.pullActions.
 * Returns the fixed file content, or undefined if no fix is available.
 */
export async function applySingleFix(
	filePath: string,
	content: string,
	diagnosticFrom: number,
	diagnosticTo: number,
): Promise<string | undefined> {
	if (!isLintableFile(filePath)) return undefined;

	try {
		await ensureBiome();
		if (projectKey === undefined || !biomeWorkspace) return undefined;

		biomeWorkspace.openFile({
			projectKey,
			content: { type: 'fromClient', content, version: 0 },
			path: filePath,
		});

		try {
			const { actions } = biomeWorkspace.pullActions({
				projectKey,
				path: filePath,
				range: [diagnosticFrom, diagnosticTo],
				categories: ['syntax', 'lint', 'action'],
			});

			if (actions.length === 0) return undefined;

			// The TextEdit produces the complete new file content when applied
			// to the full original content (EqualLines copies unchanged regions).
			const suggestion = actions[0].suggestion;
			return applyTextEdit(content, suggestion.suggestion);
		} finally {
			biomeWorkspace.closeFile({ projectKey, path: filePath });
		}
	} catch (error) {
		console.warn('[biome-linter] Single fix failed:', error);
		return undefined;
	}
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
 * Apply lint fixes and formatting to a file using Biome WASM.
 * Returns undefined for unsupported file types or if Biome fails.
 */
export async function fixFile(
	filePath: string,
	content: string,
	fixFileMode: 'safeFixes' | 'safeAndUnsafeFixes' = 'safeAndUnsafeFixes',
): Promise<LintFixResult | undefined> {
	if (!isLintableFile(filePath)) {
		return undefined;
	}

	try {
		await ensureBiome();
		if (!biomeLintApi || projectKey === undefined) return undefined;

		// First lint without fixes to count original diagnostics
		const originalResult = biomeLintApi.lintContent(projectKey, content, { filePath });
		const originalCount = originalResult.diagnostics.length;

		// Apply fixes
		const fixedResult = biomeLintApi.lintContent(projectKey, content, {
			filePath,
			fixFileMode,
		});

		// Format the fixed content
		const formattedResult = biomeLintApi.formatContent(projectKey, fixedResult.content, { filePath });

		// Lint the formatted content to get remaining diagnostics
		const remainingResult = biomeLintApi.lintContent(projectKey, formattedResult.content, { filePath });

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
			content: formattedResult.content,
			fixCount: originalCount - remainingDiagnostics.length,
			remainingDiagnostics,
		};
	} catch (error) {
		console.warn('[biome-linter] Fix failed:', error);
		return undefined;
	}
}

/**
 * Pull diagnostics directly from the Biome workspace with pullCodeActions
 * enabled so that the `fixable` tag is populated on each diagnostic.
 */
function pullDiagnosticsWithCodeActions(key: number, filePath: string, content: string): BiomeDiagnostic[] {
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

/**
 * Lint a file using Biome WASM. Returns normalized diagnostics.
 * Returns an empty array for unsupported file types or if Biome fails to initialize.
 */
export async function lintFile(filePath: string, content: string): Promise<LintDiagnostic[]> {
	if (!isLintableFile(filePath)) {
		return [];
	}

	try {
		await ensureBiome();
		if (projectKey === undefined) return [];
		const diagnostics = pullDiagnosticsWithCodeActions(projectKey, filePath, content);

		return diagnostics.map((diagnostic) => {
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
