import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
	site: 'https://codemaxxing.ai',
	adapter: cloudflare(),
	integrations: [sitemap()],
	vite: {
		plugins: [tailwindcss()],
	},
});
