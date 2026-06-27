import { describe, expect, it } from 'vitest';

import { matchesHookFilter } from './hook-filter';

describe('matchesHookFilter', () => {
	it('matches everything when no filter is given', () => {
		expect(matchesHookFilter(undefined, '/any/module.tsx')).toBe(true);
	});

	it('honours a RegExp id include (vinext MDX gate)', () => {
		const filter = { id: { include: /\.mdx$/i, exclude: /\?/ } };
		expect(matchesHookFilter(filter, '/docs/page.mdx')).toBe(true);
		expect(matchesHookFilter(filter, '\0virtual:vinext-rsc-entry')).toBe(false);
		expect(matchesHookFilter(filter, '/docs/page.mdx?used')).toBe(false);
	});

	it('supports bare RegExp / string / array id filters', () => {
		expect(matchesHookFilter({ id: /\.tsx$/ }, '/a.tsx')).toBe(true);
		expect(matchesHookFilter({ id: /\.tsx$/ }, '/a.ts')).toBe(false);
		expect(matchesHookFilter({ id: 'node_modules' }, '/x/node_modules/y.js')).toBe(true);
		expect(matchesHookFilter({ id: ['**/*.css', '**/*.scss'] }, '/styles/app.css')).toBe(true);
		expect(matchesHookFilter({ id: ['**/*.css'] }, '/app.tsx')).toBe(false);
	});

	it('applies exclude before include', () => {
		const filter = { id: { include: /\.[jt]sx?$/, exclude: /node_modules/ } };
		expect(matchesHookFilter(filter, '/src/app.tsx')).toBe(true);
		expect(matchesHookFilter(filter, '/node_modules/react/index.js')).toBe(false);
	});

	it('matches code filters when provided', () => {
		const filter = { code: /['"]use client['"]/ };
		expect(matchesHookFilter(filter, '/c.tsx', '"use client";\nexport const C = () => null;')).toBe(true);
		expect(matchesHookFilter(filter, '/c.tsx', 'export const C = () => null;')).toBe(false);
	});
});
