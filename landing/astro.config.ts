import cloudflare from '@astrojs/cloudflare';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { meta } from '../shared/meta';

export default defineConfig({
	site: meta.landingSiteUrl,
	adapter: cloudflare(),
	integrations: [mdx(), react(), sitemap()],
	vite: {
		plugins: [tailwindcss()],
	},
});
