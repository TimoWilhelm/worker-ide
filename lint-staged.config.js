export default {
	'*.{ts,tsx}': (stagedFiles) => [
		'bun run typecheck',
		`prettier --list-different ${stagedFiles.join(' ')}`,
		`eslint ${stagedFiles.join(' ')}`,
	],
	'*.md': (stagedFiles) => `prettier --list-different ${stagedFiles.join(' ')}`,
	'landing/**/*.{astro,ts,tsx,js,json,css}': () => ['bun run --cwd landing format', 'bun run --cwd landing lint'],
};
