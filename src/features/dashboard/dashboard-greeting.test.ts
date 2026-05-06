import { describe, expect, it } from 'vitest';

import { getDashboardGreeting, getDashboardGreetingPeriod } from './dashboard-greeting';

describe('getDashboardGreetingPeriod', () => {
	it.each([
		['late night', '2026-04-27T01:00:00', 'late-night'],
		['morning', '2026-04-27T09:00:00', 'morning'],
		['daytime', '2026-04-27T12:00:00', 'day'],
		['afternoon', '2026-04-27T15:00:00', 'afternoon'],
		['evening', '2026-04-27T20:00:00', 'evening'],
	])('returns the %s period', (_label, isoDateTime, expectedPeriod) => {
		expect(getDashboardGreetingPeriod(new Date(isoDateTime))).toBe(expectedPeriod);
	});

	it.each([
		['2026-04-27T04:59:59', 'late-night'],
		['2026-04-27T05:00:00', 'morning'],
		['2026-04-27T10:59:59', 'morning'],
		['2026-04-27T11:00:00', 'day'],
		['2026-04-27T13:59:59', 'day'],
		['2026-04-27T14:00:00', 'afternoon'],
		['2026-04-27T17:59:59', 'afternoon'],
		['2026-04-27T18:00:00', 'evening'],
		['2026-04-27T21:59:59', 'evening'],
		['2026-04-27T22:00:00', 'late-night'],
	])('handles the %s boundary correctly', (isoDateTime, expectedPeriod) => {
		expect(getDashboardGreetingPeriod(new Date(isoDateTime))).toBe(expectedPeriod);
	});
});

describe('getDashboardGreeting', () => {
	it('uses the trimmed display name in the selected template', () => {
		const greeting = getDashboardGreeting('   Ada   ', new Date('2026-04-27T09:00:00'));

		expect(greeting).toContain('Ada');
		expect(greeting).not.toContain('   Ada   ');
		expect(greeting).not.toContain('{name}');
	});

	it('selects the same template for the same date regardless of display name', () => {
		const currentDate = new Date('2026-04-27T15:00:00');
		const firstGreeting = getDashboardGreeting('Ada', currentDate);
		const secondGreeting = getDashboardGreeting('Grace', currentDate);

		expect(firstGreeting.replace('Ada', '{name}')).toBe(secondGreeting.replace('Grace', '{name}'));
	});
});
