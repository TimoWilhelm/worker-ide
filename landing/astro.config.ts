import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
	site: 'https://codemaxxing.ai',
	adapter: cloudflare(),
	integrations: [sitemap()],
	vite: {
		// @ts-expect-error -- @tailwindcss/vite resolves vite@6 types from root workspace, but Astro v6 uses vite@7 at runtime. The plugin works correctly.
		plugins: [tailwindcss()],
	},
});
