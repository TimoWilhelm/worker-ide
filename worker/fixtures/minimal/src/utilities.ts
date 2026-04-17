export function greet(name: string): string {
	return `Hello, ${name}!`;
}
export function capitalize(value: string): string {
	if (value.length === 0) return value;
	return value.charAt(0).toUpperCase() + value.slice(1);
}
