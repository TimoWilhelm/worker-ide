import { describe, expect, it } from 'vitest';

import {
	gitDiscardSchema,
	gitStageSchema,
	gitDiffQuerySchema,
	gitBranchRenameSchema,
	gitCheckoutSchema,
	gitMergeSchema,
} from './validation';

describe('gitDiscardSchema', () => {
	it('accepts normal paths like src/index.ts', () => {
		expect(gitDiscardSchema.safeParse({ path: 'src/index.ts' }).success).toBe(true);
	});

	it('rejects paths containing ".."', () => {
		expect(gitDiscardSchema.safeParse({ path: '../etc/passwd' }).success).toBe(false);
		expect(gitDiscardSchema.safeParse({ path: 'src/../secret' }).success).toBe(false);
	});

	it('rejects paths containing null bytes', () => {
		expect(gitDiscardSchema.safeParse({ path: 'src/index\0.ts' }).success).toBe(false);
	});

	it('rejects empty paths', () => {
		expect(gitDiscardSchema.safeParse({ path: '' }).success).toBe(false);
	});
});

describe('gitDiffQuerySchema', () => {
	it('accepts normal paths', () => {
		expect(gitDiffQuerySchema.safeParse({ path: 'src/main.ts' }).success).toBe(true);
	});

	it('rejects paths containing ".."', () => {
		expect(gitDiffQuerySchema.safeParse({ path: '../etc/passwd' }).success).toBe(false);
		expect(gitDiffQuerySchema.safeParse({ path: 'src/../secret' }).success).toBe(false);
	});
});

describe('gitStageSchema', () => {
	it('accepts valid paths', () => {
		expect(gitStageSchema.safeParse({ paths: ['src/index.ts'] }).success).toBe(true);
	});

	it('rejects paths containing ".." in array items', () => {
		expect(gitStageSchema.safeParse({ paths: ['src/../secret'] }).success).toBe(false);
	});

	it('rejects empty arrays', () => {
		expect(gitStageSchema.safeParse({ paths: [] }).success).toBe(false);
	});
});

describe('gitBranchRenameSchema', () => {
	it('accepts valid branch names', () => {
		expect(gitBranchRenameSchema.safeParse({ oldName: 'main', newName: 'develop' }).success).toBe(true);
	});

	it('rejects oldName longer than 255 chars', () => {
		const longName = 'a'.repeat(256);
		expect(gitBranchRenameSchema.safeParse({ oldName: longName, newName: 'develop' }).success).toBe(false);
	});

	it('rejects newName longer than 255 chars', () => {
		const longName = 'a'.repeat(256);
		expect(gitBranchRenameSchema.safeParse({ oldName: 'main', newName: longName }).success).toBe(false);
	});
});

describe('gitCheckoutSchema', () => {
	it('accepts valid references', () => {
		expect(gitCheckoutSchema.safeParse({ reference: 'main' }).success).toBe(true);
	});

	it('rejects reference longer than 255 chars', () => {
		const longReference = 'a'.repeat(256);
		expect(gitCheckoutSchema.safeParse({ reference: longReference }).success).toBe(false);
	});

	it('rejects empty reference', () => {
		expect(gitCheckoutSchema.safeParse({ reference: '' }).success).toBe(false);
	});
});

describe('gitMergeSchema', () => {
	it('accepts valid branch names', () => {
		expect(gitMergeSchema.safeParse({ branch: 'feature-branch' }).success).toBe(true);
	});

	it('rejects branch longer than 255 chars', () => {
		const longBranch = 'a'.repeat(256);
		expect(gitMergeSchema.safeParse({ branch: longBranch }).success).toBe(false);
	});

	it('rejects empty branch', () => {
		expect(gitMergeSchema.safeParse({ branch: '' }).success).toBe(false);
	});
});
