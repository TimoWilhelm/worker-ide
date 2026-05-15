import type { FixFileFailure, ServerLintDiagnostic, ServerLintFixResult } from '@shared/biome-types';

const LINTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.json']);

function isLintableFile(filePath: string): boolean {
	const extension = filePath.slice(filePath.lastIndexOf('.'));
	return LINTABLE_EXTENSIONS.has(extension);
}

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

interface BiomeAction {
	category?: { quickFix?: string };
	ruleName?: string[];
}

interface BiomeWorkspace {
	openFile: (options: { projectKey: number; content: { type: string; content: string; version: number }; path: string }) => void;
	closeFile: (options: { projectKey: number; path: string }) => void;
	pullDiagnostics: (options: { projectKey: number; path: string; categories: string[] }) => {
		diagnostics: BiomeDiagnosticResult[];
	};
	pullActions: (options: { projectKey: number; path: string }) => {
		actions: BiomeAction[];
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
	// In the Cloudflare Workers runtime, `.wasm` imports are pre-compiled at
	// deploy time and resolve to a WebAssembly.Module.
	// @ts-expect-error -- WASM module import resolved to WebAssembly.Module by Cloudflare at deploy time
	const { default: biomeWasm } = await import('../../vendor/biome_wasm_bg.wasm');
	const wasmModule = await import('@biomejs/wasm-web');
	await wasmModule.default({ module_or_path: biomeWasm });

	const { Biome, Distribution } = await import('@biomejs/js-api');
	const biome = await Biome.create({ distribution: Distribution.WEB });

	const project = biome.openProject();
	storedProjectKey = project.projectKey;

	biome.applyConfiguration(storedProjectKey, {
		linter: {
			enabled: true,
		},
		formatter: {
			enabled: true,
		},
	});

	// Store the high-level lintContent API (used by fixFile)
	biomeLintApi = biome;

	// Extract the workspace reference for direct pullDiagnostics calls.
	// The `workspace` property is private on BiomeCommon but exists at runtime.
	const descriptor = Object.getOwnPropertyDescriptor(biome, 'workspace');
	if (descriptor?.value) {
		biomeWorkspace = descriptor.value;
	}
}

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

function offsetToLineAndColumn(content: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lastNewlineIndex = -1;
	for (let index = 0; index < offset && index < content.length; index++) {
		if (content[index] === '\n') {
			line++;
			lastNewlineIndex = index;
		}
	}
	const column = offset - lastNewlineIndex;
	return { line, column };
}

function pullDiagnosticsAndActions(
	key: number,
	filePath: string,
	content: string,
): { diagnostics: BiomeDiagnosticResult[]; fixableRules: Set<string> } {
	if (!biomeWorkspace) {
		return { diagnostics: [], fixableRules: new Set() };
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
			categories: ['syntax', 'lint'],
		});
		const { actions } = biomeWorkspace.pullActions({
			projectKey: key,
			path: filePath,
		});
		const fixableRules = new Set<string>();
		for (const action of actions) {
			if (action.category?.quickFix && action.ruleName) {
				fixableRules.add(`lint/${action.ruleName.join('/')}`);
			}
		}
		return { diagnostics, fixableRules };
	} finally {
		biomeWorkspace.closeFile({ projectKey: key, path: filePath });
	}
}

function mapDiagnostics(diagnostics: BiomeDiagnosticResult[], content: string, fixableRules?: Set<string>): ServerLintDiagnostic[] {
	return diagnostics.map((diagnostic) => {
		const span = diagnostic.location?.span;
		const { line, column } = span ? offsetToLineAndColumn(content, span[0]) : { line: 1, column: 1 };

		let message = diagnostic.description;
		if (!message && diagnostic.message && diagnostic.message.length > 0) {
			message = diagnostic.message.map((node) => node.content).join('');
		}

		const rule = diagnostic.category ?? 'biome';

		return {
			line,
			column,
			rule,
			message: message || 'Unknown lint issue',
			severity: mapDiagnosticSeverity(diagnostic.severity),
			fixable: fixableRules ? fixableRules.has(rule) : diagnostic.tags.includes('fixable'),
		};
	});
}

/**
 * Lint a file and return diagnostics.
 * Returns an empty array if the file type is unsupported or Biome is unavailable.
 */
export async function lintFile(filePath: string, content: string): Promise<ServerLintDiagnostic[]> {
	if (!isLintableFile(filePath)) return [];

	const ready = await ensureBiome();
	if (!ready || storedProjectKey === undefined || !biomeWorkspace) return [];

	try {
		const { diagnostics, fixableRules } = pullDiagnosticsAndActions(storedProjectKey, filePath, content);
		return mapDiagnostics(diagnostics, content, fixableRules);
	} catch {
		return [];
	}
}

/**
 * Apply safe lint fixes to a file using Biome WASM.
 * Returns the fixed content and remaining diagnostics, or a failure object
 * with a human-readable reason when fixes cannot be applied.
 */
export async function fixFile(filePath: string, content: string): Promise<ServerLintFixResult | FixFileFailure> {
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
		const remainingDiagnostics = mapDiagnostics(remainingResult.diagnostics, fixedResult.content);

		return {
			fixedContent: fixedResult.content,
			fixCount: originalCount - remainingDiagnostics.length,
			remainingDiagnostics,
		};
	} catch (error) {
		return { failed: true, reason: `Biome threw an error: ${error instanceof Error ? error.message : String(error)}` };
	}
}
