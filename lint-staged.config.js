export default {
	'*.{ts,tsx}': (stagedFiles) => [
		'bun run typecheck',
		`prettier --list-different ${stagedFiles.join(' ')}`,
		`eslint ${stagedFiles.join(' ')}`,
	],
	'*.md': (stagedFiles) => `prettier --list-different ${stagedFiles.join(' ')}`,
};
