type DashboardGreetingFormat = `${string}{name}${string}`;

export type DashboardGreetingPeriod = 'late-night' | 'morning' | 'day' | 'afternoon' | 'evening';

const LATE_NIGHT_GREETINGS: DashboardGreetingFormat[] = ['Hey {name}', 'Still at it, {name}?', 'Late night, {name}'];
const MORNING_GREETINGS: DashboardGreetingFormat[] = ['Morning, {name}', 'Good morning, {name}', 'Hey {name}'];
const DAY_GREETINGS: DashboardGreetingFormat[] = ['Hey {name}', 'Hello {name}', 'Good to see you, {name}'];
const AFTERNOON_GREETINGS: DashboardGreetingFormat[] = ['Afternoon, {name}', 'Good afternoon, {name}', 'Hey {name}'];
const EVENING_GREETINGS: DashboardGreetingFormat[] = ['Evening, {name}', 'Good evening, {name}', 'Hey {name}'];

function chooseGreeting(greetings: DashboardGreetingFormat[], currentDate: Date): DashboardGreetingFormat {
	const index = currentDate.getDate() % greetings.length;
	return greetings[index];
}

export function getDashboardGreetingPeriod(currentDate: Date): DashboardGreetingPeriod {
	const hour = currentDate.getHours();

	if (hour < 5) {
		return 'late-night';
	}

	if (hour < 11) {
		return 'morning';
	}

	if (hour < 14) {
		return 'day';
	}

	if (hour < 18) {
		return 'afternoon';
	}

	if (hour < 22) {
		return 'evening';
	}

	return 'late-night';
}

function getDashboardGreetingPattern(currentDate: Date): DashboardGreetingFormat {
	const period = getDashboardGreetingPeriod(currentDate);

	if (period === 'late-night') {
		return chooseGreeting(LATE_NIGHT_GREETINGS, currentDate);
	}

	if (period === 'morning') {
		return chooseGreeting(MORNING_GREETINGS, currentDate);
	}

	if (period === 'day') {
		return chooseGreeting(DAY_GREETINGS, currentDate);
	}

	if (period === 'afternoon') {
		return chooseGreeting(AFTERNOON_GREETINGS, currentDate);
	}

	if (period === 'evening') {
		return chooseGreeting(EVENING_GREETINGS, currentDate);
	}

	return chooseGreeting(LATE_NIGHT_GREETINGS, currentDate);
}

function formatGreeting(format: DashboardGreetingFormat, displayName: string): string {
	return format.replace('{name}', displayName);
}

export function getDashboardGreeting(displayName: string, currentDate = new Date()): string {
	const greetingFormat = getDashboardGreetingPattern(currentDate);
	return formatGreeting(greetingFormat, displayName.trim());
}
