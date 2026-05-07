export interface SocialImageMetadata {
	absoluteUrl: string;
	alt: string;
	height: number;
	path: string;
	type: string;
	width: number;
}

export interface AppMetadata {
	applicationName: string;
	appOrigin: string;
	appleMobileWebAppTitle: string;
	canonicalUrl: string;
	description: string;
	formatDetection: string;
	googlebot: string;
	locale: string;
	manifest: {
		background_color: string;
		description: string;
		display: 'standalone';
		display_override: ['window-controls-overlay'];
		icons: Array<{
			sizes: string;
			src: string;
			type: string;
			purpose: 'any';
		}>;
		id: string;
		name: string;
		orientation: 'natural';
		scope: string;
		short_name: string;
		start_url: string;
		theme_color: string;
	};
	productName: string;
	robots: string;
	shortName: string;
	socialDescription: string;
	socialImage: SocialImageMetadata;
	socialTitle: string;
	themeColor: string;
	title: string;
	twitterCard: 'summary_large_image';
	viewport: string;
}

const appOrigin = 'https://codemaxxing.app';
const productName = 'Codemaxxing';
const shortName = 'Codemaxxing';
const socialImagePath = '/meta/app-og.png';
const title = 'Codemaxxing — Cloud IDE';
const description = 'Browser-based cloud IDE with AI agents and instant previews. Code, build, and deploy from anywhere.';

export const appMetadata: AppMetadata = {
	applicationName: 'Codemaxxing',
	appOrigin,
	appleMobileWebAppTitle: shortName,
	canonicalUrl: `${appOrigin}/`,
	description,
	formatDetection: 'telephone=no',
	googlebot: 'index, follow',
	locale: 'en_US',
	manifest: {
		background_color: '#ffffff',
		description,
		display: 'standalone',
		display_override: ['window-controls-overlay'],
		icons: [
			{
				purpose: 'any',
				sizes: 'any',
				src: '/favicon.svg',
				type: 'image/svg+xml',
			},
		],
		id: '7c3a8f1e-9d4b-4e2a-b6f5-1a2d3c4e5f6a',
		name: 'Codemaxxing',
		orientation: 'natural',
		scope: '/',
		short_name: shortName,
		start_url: '/',
		theme_color: '#f14602',
	},
	productName,
	robots: 'index, follow',
	shortName,
	socialDescription: description,
	socialImage: {
		absoluteUrl: `${appOrigin}${socialImagePath}`,
		alt: 'Codemaxxing — Cloud IDE',
		height: 630,
		path: socialImagePath,
		type: 'image/png',
		width: 1200,
	},
	socialTitle: title,
	themeColor: '#f14602',
	title,
	twitterCard: 'summary_large_image',
	viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
};
