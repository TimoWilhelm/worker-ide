import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

import { landingSiteUrl } from './site-config';

export default defineConfig({
	site: landingSiteUrl,
	adapter: cloudflare(),
	integrations: [react(), sitemap()],
	vite: {
		plugins: [tailwindcss()],
	},
});
