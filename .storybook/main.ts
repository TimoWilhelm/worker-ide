import type { StorybookConfig } from '@storybook/react-vite';

const EXCLUDED_PLUGIN_PREFIXES = ['vite-plugin-cloudflare', 'vite-plugin-pwa', 'raw-minified', 'biome-wasm-noop'];

const config: StorybookConfig = {
	stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
	addons: ['@chromatic-com/storybook', '@storybook/addon-vitest', '@storybook/addon-a11y', '@storybook/addon-docs'],
	framework: '@storybook/react-vite',
	viteFinal(config) {
		config.plugins = (config.plugins ?? []).flat().filter((plugin) => {
			const name = plugin && 'name' in plugin ? plugin.name : undefined;
			return !name || !EXCLUDED_PLUGIN_PREFIXES.some((prefix) => name.startsWith(prefix));
		});
		return config;
	},
};
export default config;
