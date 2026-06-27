import { describe, expect, it } from 'vitest';

import {
	defaultServerConditions,
	defineConfig,
	isCSSRequest,
	loadEnv as loadEnvironment,
	normalizePath,
	parseAst,
	parseAstAsync,
	transformWithOxc,
} from './index';
import { installViteHostServices } from './services';

describe('vite shim: parseAst', () => {
	it('parses ESM into an ESTree program with offsets', () => {
		const ast = parseAst('import { x } from "y"; export const z = 1;');
		expect(ast.type).toBe('Program');
		const first = ast.body[0];
		expect(first.type).toBe('ImportDeclaration');
		expect(typeof first.start).toBe('number');
		expect(typeof first.end).toBe('number');
	});

	it('parses JSX', () => {
		const ast = parseAst('const a = <div className="x">hi</div>;');
		expect(ast.body[0].type).toBe('VariableDeclaration');
	});

	it('detects a leading "use client" directive', () => {
		const ast = parseAst('"use client";\nexport function C() { return null; }');
		const directive = ast.body[0];
		expect(directive.type).toBe('ExpressionStatement');
	});
});

describe('vite shim: parseAstAsync TS fallback', () => {
	it('transforms via host services when acorn cannot parse types', async () => {
		installViteHostServices({
			transform: async (code) => ({ code: code.replaceAll(': number', '') }),
			loadEnv: () => ({}),
		});
		const ast = await parseAstAsync('export const n: number = 1;');
		expect(ast.type).toBe('Program');
		expect(ast.body[0].type).toBe('ExportNamedDeclaration');
	});
});

describe('vite shim: transformWithOxc', () => {
	it('delegates to host transform service', async () => {
		installViteHostServices({
			transform: async (code, id) => ({ code: `/* ${id} */ ${code}` }),
			loadEnv: () => ({}),
		});
		const result = await transformWithOxc('const x = 1;', '/a.ts');
		expect(result.code).toContain('/* /a.ts */');
	});
});

describe('vite shim: pure utilities', () => {
	it('normalizePath converts separators', () => {
		expect(normalizePath(String.raw`a\b\c`)).toBe('a/b/c');
	});

	it('defineConfig is identity', () => {
		const config = { plugins: [] };
		expect(defineConfig(config)).toBe(config);
	});

	it('isCSSRequest matches stylesheet ids', () => {
		expect(isCSSRequest('/a.css')).toBe(true);
		expect(isCSSRequest('/a.scss?used')).toBe(true);
		expect(isCSSRequest('/a.tsx')).toBe(false);
	});

	it('exposes default server conditions including workerd', () => {
		expect(defaultServerConditions).toContain('workerd');
	});

	it('loadEnv delegates to host services', () => {
		installViteHostServices({
			transform: async (code) => ({ code }),
			loadEnv: (mode, prefixes) => ({ MODE: mode, PREFIX: prefixes.join(',') }),
		});
		expect(loadEnvironment('production', '/root', 'NEXT_PUBLIC_')).toEqual({
			MODE: 'production',
			PREFIX: 'NEXT_PUBLIC_',
		});
	});
});
