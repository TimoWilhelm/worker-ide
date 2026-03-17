import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginAstro from 'eslint-plugin-astro';
import unicorn from 'eslint-plugin-unicorn';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

export default [
	{ ignores: ['dist', '.wrangler', '.astro', 'node_modules'] },

	js.configs.recommended,
	...tseslint.configs.recommended,
	...eslintPluginAstro.configs.recommended,
	unicorn.configs.recommended,
	eslintConfigPrettier,

	{
		plugins: {
			'unused-imports': unusedImports,
		},
		rules: {
			'@typescript-eslint/no-unused-vars': 'off',
			'unused-imports/no-unused-imports': 'error',
			'unused-imports/no-unused-vars': [
				'warn',
				{
					vars: 'all',
					varsIgnorePattern: '^_',
					args: 'after-used',
					argsIgnorePattern: '^_',
				},
			],
			// Astro components use PascalCase filenames by convention
			'unicorn/filename-case': 'off',
			// Astro frontmatter uses null for some APIs
			'unicorn/no-null': 'off',
			// Not relevant in Astro context
			'unicorn/prevent-abbreviations': 'off',
			// Conflicts with Astro's set:html directive usage
			'unicorn/no-keyword-prefix': 'off',
		},
	},
];
