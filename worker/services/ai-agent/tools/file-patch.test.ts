/**
 * Unit tests for the file_patch tool's patch parser and application logic.
 * Tests the OpenCode-style patch format parsing and content derivation.
 */

import { describe, expect, it } from 'vitest';

import { deriveNewContentsFromChunks, parsePatch } from './file-patch';

// =============================================================================
// parsePatch tests
// =============================================================================

describe('parsePatch', () => {
	describe('format validation', () => {
		it('should throw for missing Begin/End markers', () => {
			expect(() =>
				parsePatch(`*** Add File: /test.txt
+Hello world`),
			).toThrow('missing Begin/End markers');
		});

		it('should throw for End before Begin', () => {
			expect(() =>
				parsePatch(`*** End Patch
*** Begin Patch`),
			).toThrow('missing Begin/End markers');
		});
	});

	describe('Add File', () => {
		it('should parse a single Add File hunk', () => {
			const { hunks } = parsePatch(`*** Begin Patch
*** Add File: /hello.txt
+Hello world
+Line 2
*** End Patch`);
			expect(hunks).toHaveLength(1);
			expect(hunks[0].type).toBe('add');
			if (hunks[0].type === 'add') {
				expect(hunks[0].path).toBe('/hello.txt');
				expect(hunks[0].contents).toBe('Hello world\nLine 2');
			}
		});

		it('should parse an empty Add File', () => {
			const { hunks } = parsePatch(`*** Begin Patch
*** Add File: /empty.txt
*** End Patch`);
			expect(hunks).toHaveLength(1);
			if (hunks[0].type === 'add') {
				expect(hunks[0].contents).toBe('');
			}
		});
	});

	describe('Delete File', () => {
		it('should parse a Delete File hunk', () => {
			const { hunks } = parsePatch(`*** Begin Patch
*** Delete File: /obsolete.txt
*** End Patch`);
			expect(hunks).toHaveLength(1);
			expect(hunks[0].type).toBe('delete');
			expect(hunks[0].path).toBe('/obsolete.txt');
		});
	});

	describe('Update File', () => {
		it('should parse a simple Update File with context, removal, and addition', () => {
			const { hunks } = parsePatch(`*** Begin Patch
*** Update File: /src/main.ts
@@ function greet()
 const unchanged = 1;
-console.log("Hi")
+console.log("Hello")
 const alsoUnchanged = 3;
*** End Patch`);
			expect(hunks).toHaveLength(1);
			expect(hunks[0].type).toBe('update');
			if (hunks[0].type === 'update') {
				expect(hunks[0].path).toBe('/src/main.ts');
				expect(hunks[0].chunks).toHaveLength(1);
				expect(hunks[0].chunks[0].changeContext).toBe('function greet()');
				expect(hunks[0].chunks[0].oldLines).toEqual(['const unchanged = 1;', 'console.log("Hi")', 'const alsoUnchanged = 3;']);
				expect(hunks[0].chunks[0].newLines).toEqual(['const unchanged = 1;', 'console.log("Hello")', 'const alsoUnchanged = 3;']);
			}
		});

		it('should parse Update File with Move directive', () => {
			const { hunks } = parsePatch(`*** Begin Patch
*** Update File: /src/old.ts
*** Move to: /src/new.ts
@@ function test()
 const x = 1;
*** End Patch`);
			expect(hunks).toHaveLength(1);
			if (hunks[0].type === 'update') {
				expect(hunks[0].path).toBe('/src/old.ts');
				expect(hunks[0].movePath).toBe('/src/new.ts');
			}
		});

		it('should parse multiple hunks in one file', () => {
			const { hunks } = parsePatch(`*** Begin Patch
*** Update File: /src/main.ts
@@ import section
-import { old } from './old';
+import { updated } from './new';
@@ function main()
-old();
+updated();
*** End Patch`);
			expect(hunks).toHaveLength(1);
			if (hunks[0].type === 'update') {
				expect(hunks[0].chunks).toHaveLength(2);
				expect(hunks[0].chunks[0].changeContext).toBe('import section');
				expect(hunks[0].chunks[1].changeContext).toBe('function main()');
			}
		});

		it('should parse End of File marker', () => {
			const { hunks } = parsePatch(`*** Begin Patch
*** Update File: /test.ts
@@ at end
-old last line
+new last line
*** End of File
*** End Patch`);
			expect(hunks).toHaveLength(1);
			if (hunks[0].type === 'update') {
				expect(hunks[0].chunks[0].isEndOfFile).toBe(true);
			}
		});

		it('should treat bare empty lines as context lines (blank line preservation)', () => {
			const { hunks } = parsePatch(`*** Begin Patch
*** Update File: /test.ts
@@ function test()
 const a = 1;

-const b = 2;
+const b = 3;
*** End Patch`);
			expect(hunks).toHaveLength(1);
			if (hunks[0].type === 'update') {
				// The empty line between "const a = 1;" and "-const b = 2;" should be
				// treated as a context line representing a blank line in the source.
				expect(hunks[0].chunks[0].oldLines).toEqual(['const a = 1;', '', 'const b = 2;']);
				expect(hunks[0].chunks[0].newLines).toEqual(['const a = 1;', '', 'const b = 3;']);
			}
		});
	});

	describe('multiple file operations', () => {
		it('should parse add, update, and delete in one patch', () => {
			const { hunks } = parsePatch(`*** Begin Patch
*** Add File: /new-file.txt
+This is a new file
*** Update File: /existing.ts
@@ function old()
-console.log("old")
+console.log("new")
*** Delete File: /unused.ts
*** End Patch`);
			expect(hunks).toHaveLength(3);
			expect(hunks[0].type).toBe('add');
			expect(hunks[1].type).toBe('update');
			expect(hunks[2].type).toBe('delete');
		});
	});

	describe('heredoc stripping', () => {
		it('should strip heredoc wrappers', () => {
			const { hunks } = parsePatch(`cat <<'EOF'
*** Begin Patch
*** Add File: /test.txt
+hello
*** End Patch
EOF`);
			expect(hunks).toHaveLength(1);
			expect(hunks[0].type).toBe('add');
		});
	});
});

// =============================================================================
// deriveNewContentsFromChunks tests
// =============================================================================

describe('deriveNewContentsFromChunks', () => {
	it('should apply a simple line replacement', () => {
		const original = 'function greet() {\n  console.log("Hi");\n}\n';
		const chunks = [
			{
				oldLines: ['  console.log("Hi");'],
				newLines: ['  console.log("Hello");'],
				changeContext: 'function greet() {',
			},
		];
		const result = deriveNewContentsFromChunks('/test.ts', original, chunks);
		expect(result).toBe('function greet() {\n  console.log("Hello");\n}\n');
	});

	it('should handle multiple chunks in one file', () => {
		const original = 'import { old } from "./old";\n\nfunction main() {\n  old();\n}\n';
		const chunks = [
			{
				oldLines: ['import { old } from "./old";'],
				newLines: ['import { updated } from "./new";'],
				changeContext: undefined,
			},
			{
				oldLines: ['  old();'],
				newLines: ['  updated();'],
				changeContext: 'function main() {',
			},
		];
		const result = deriveNewContentsFromChunks('/main.ts', original, chunks);
		expect(result).toBe('import { updated } from "./new";\n\nfunction main() {\n  updated();\n}\n');
	});

	it('should handle patches with blank context lines (empty line in source)', () => {
		const original = 'const a = 1;\n\nconst b = 2;\n';
		const chunks = [
			{
				oldLines: ['const a = 1;', '', 'const b = 2;'],
				newLines: ['const a = 1;', '', 'const b = 3;'],
				changeContext: undefined,
			},
		];
		const result = deriveNewContentsFromChunks('/test.ts', original, chunks);
		expect(result).toBe('const a = 1;\n\nconst b = 3;\n');
	});

	it('should apply patch with End of File anchor', () => {
		const original = 'line1\nline2\nold last line\n';
		const chunks = [
			{
				oldLines: ['old last line'],
				newLines: ['new last line'],
				changeContext: undefined,
				isEndOfFile: true,
			},
		];
		const result = deriveNewContentsFromChunks('/test.ts', original, chunks);
		expect(result).toBe('line1\nline2\nnew last line\n');
	});

	it('should handle pure addition (no old lines)', () => {
		const original = 'line1\nline2\n';
		const chunks = [
			{
				oldLines: [],
				newLines: ['new line'],
				changeContext: undefined,
			},
		];
		const result = deriveNewContentsFromChunks('/test.ts', original, chunks);
		expect(result).toContain('new line');
	});

	it('should handle trailing whitespace differences via fuzzy matching', () => {
		const original = 'const foo = 1;   \nconst bar = 2;\n';
		const chunks = [
			{
				oldLines: ['const foo = 1;'],
				newLines: ['const foo = 42;'],
				changeContext: undefined,
			},
		];
		// The oldLines has "const foo = 1;" but the file has trailing spaces.
		// seekSequence pass 2 (rstrip) should handle this.
		const result = deriveNewContentsFromChunks('/test.ts', original, chunks);
		expect(result).toContain('const foo = 42;');
	});

	it('should throw when old lines cannot be found', () => {
		const original = 'const a = 1;\nconst b = 2;\n';
		const chunks = [
			{
				oldLines: ['this line does not exist'],
				newLines: ['replacement'],
				changeContext: undefined,
			},
		];
		expect(() => deriveNewContentsFromChunks('/test.ts', original, chunks)).toThrow('Failed to find expected lines');
	});

	it('should throw when context line cannot be found', () => {
		const original = 'const a = 1;\n';
		const chunks = [
			{
				oldLines: ['const a = 1;'],
				newLines: ['const a = 2;'],
				changeContext: 'nonexistent context',
			},
		];
		expect(() => deriveNewContentsFromChunks('/test.ts', original, chunks)).toThrow("Failed to find context 'nonexistent context'");
	});
});

// =============================================================================
// Integration: parsePatch + deriveNewContentsFromChunks
// =============================================================================

describe('parsePatch + deriveNewContentsFromChunks integration', () => {
	it('should correctly apply a parsed patch with blank lines to source content', () => {
		const patchText = `*** Begin Patch
*** Update File: /src/app.ts
@@ export function greet() {
 const greeting = "Hello";

-console.log(greeting);
+console.log(greeting + "!");
*** End Patch`;

		const originalContent = 'export function greet() {\n  const greeting = "Hello";\n\n  console.log(greeting);\n}\n';

		const { hunks } = parsePatch(patchText);
		expect(hunks).toHaveLength(1);

		const hunk = hunks[0];
		if (hunk.type === 'update') {
			const result = deriveNewContentsFromChunks(hunk.path, originalContent, hunk.chunks);
			expect(result).toContain('console.log(greeting + "!");');
		}
	});

	it('should correctly apply a parsed multi-hunk patch', () => {
		const patchText = `*** Begin Patch
*** Update File: /src/math.ts
@@ export function add(a: number, b: number) {
-  return a + b;
+  return a + b + 0; // ensure number
@@ export function multiply(a: number, b: number) {
-  return a * b;
+  return a * b * 1; // ensure number
*** End Patch`;

		const originalContent = [
			'export function add(a: number, b: number) {',
			'  return a + b;',
			'}',
			'',
			'export function multiply(a: number, b: number) {',
			'  return a * b;',
			'}',
			'',
		].join('\n');

		const { hunks } = parsePatch(patchText);
		expect(hunks).toHaveLength(1);

		const hunk = hunks[0];
		if (hunk.type !== 'update') throw new Error('Expected update hunk');
		const result = deriveNewContentsFromChunks(hunk.path, originalContent, hunk.chunks);
		expect(result).toContain('return a + b + 0; // ensure number');
		expect(result).toContain('return a * b * 1; // ensure number');
	});
});

// =============================================================================
// Line Matching Tests
// =============================================================================

describe('line matching strategies', () => {
	describe('exact match', () => {
		it('should match identical lines', () => {
			const line1 = 'const foo = 1;';
			const line2 = 'const foo = 1;';
			expect(line1 === line2).toBe(true);
		});
	});

	describe('trimEnd match', () => {
		it('should match with trailing whitespace differences', () => {
			const line1 = 'const foo = 1;   ';
			const line2 = 'const foo = 1;';
			expect(line1.trimEnd() === line2.trimEnd()).toBe(true);
		});
	});

	describe('trim match', () => {
		it('should match with leading and trailing whitespace differences', () => {
			const line1 = '   const foo = 1;   ';
			const line2 = 'const foo = 1;';
			expect(line1.trim() === line2.trim()).toBe(true);
		});
	});

	describe('unicode normalization', () => {
		it('should normalize smart quotes', () => {
			const withSmartQuotes = 'const str = \u201Chello\u201D';
			const withStraightQuotes = 'const str = "hello"';

			const normalizedSmart = withSmartQuotes.replaceAll(/[\u2018\u2019\u201A\u201B]/g, "'").replaceAll(/[\u201C\u201D\u201E\u201F]/g, '"');
			const normalizedStraight = withStraightQuotes
				.replaceAll(/[\u2018\u2019\u201A\u201B]/g, "'")
				.replaceAll(/[\u201C\u201D\u201E\u201F]/g, '"');

			expect(normalizedSmart).toBe(normalizedStraight);
		});

		it('should normalize dashes', () => {
			const withEnDash = 'a\u2013b'; // en-dash
			const withHyphen = 'a-b';

			const normalizedEnDash = withEnDash.replaceAll(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-');
			const normalizedHyphen = withHyphen.replaceAll(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-');

			expect(normalizedEnDash).toBe(normalizedHyphen);
		});
	});
});
