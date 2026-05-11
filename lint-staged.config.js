export default {
	'*.{ts,tsx}': () => ['bun run typecheck'],
	'*.{js,mjs,cjs,jsx,ts,tsx}': (stagedFiles) => [`prettier --list-different ${stagedFiles.join(' ')}`, `eslint ${stagedFiles.join(' ')}`],
	'*.{json,jsonc,css,html}': (stagedFiles) => `prettier --list-different ${stagedFiles.join(' ')}`,
	'*.md': (stagedFiles) => `prettier --list-different ${stagedFiles.join(' ')}`,
	'landing/**/*.{astro,ts,tsx,js,json,css}': () => ['bun run --cwd landing format', 'bun run --cwd landing lint'],
};
