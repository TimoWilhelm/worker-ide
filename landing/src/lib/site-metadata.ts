import type { Graph, Organization, WebApplication, WebPage, WebSite } from 'schema-dts';

import { appSiteUrl, landingSiteUrl, siteLocale, siteName, supportEmail } from '../../site-config';
import landingOpenGraphImagePath from '../assets/meta/landing-og.png?url';

export interface SocialImageMetadata {
	alt: string;
	height: number;
	path: string;
	type: string;
	width: number;
}

export interface LandingPageMetadataInput {
	canonicalUrl?: string;
	description: string;
	googlebot?: string;
	googleSiteVerification?: string;
	noIndex?: boolean;
	openGraphImage?: SocialImageMetadata;
	openGraphType?: 'article' | 'website';
	robots?: string;
	title: string;
}

interface ResolveLandingPageMetadataOptions {
	currentUrl: URL;
	metadata: LandingPageMetadataInput;
	siteOrigin?: string;
}

interface ResolvedLandingPageMetadata {
	applicationName: string;
	canonicalUrl: string;
	description: string;
	formatDetection: string;
	googleSiteVerification?: string;
	googlebot: string;
	locale: string;
	openGraphImage: SocialImageMetadata & { absoluteUrl: string };
	openGraphType: 'article' | 'website';
	robots: string;
	structuredData: Graph;
	themeColor: string;
	title: string;
	twitterCard: 'summary_large_image';
}

const defaultDescription = 'Build in the browser with AI agents, instant previews, Git workflows, and Cloudflare-native deploys.';
const defaultOpenGraphImage: SocialImageMetadata = {
	alt: 'Codemaxxing landing page social card with browser IDE messaging',
	height: 630,
	path: landingOpenGraphImagePath,
	type: 'image/png',
	width: 1200,
};
const defaultThemeColor = '#f14602';
const webApplicationDescription = 'Codemaxxing is a browser-based cloud IDE with AI agents, previews, tests, Git workflows, and deploys.';

function createAbsoluteUrl(pathOrUrl: string, siteOrigin: string): string {
	return new URL(pathOrUrl, siteOrigin).href;
}

function createRobotsValue(metadata: LandingPageMetadataInput): string {
	if (metadata.noIndex) {
		return 'noindex, follow';
	}

	return metadata.robots ?? 'index, follow';
}

function createGooglebotValue(metadata: LandingPageMetadataInput, robots: string): string {
	return metadata.googlebot ?? robots;
}

function createCanonicalUrl(properties: ResolveLandingPageMetadataOptions, siteOrigin: string): string {
	if (properties.metadata.canonicalUrl) {
		return properties.metadata.canonicalUrl;
	}

	return createAbsoluteUrl(properties.currentUrl.pathname, siteOrigin);
}

function createStructuredData(properties: {
	canonicalUrl: string;
	description: string;
	openGraphType: 'article' | 'website';
	siteOrigin: string;
	title: string;
}): Graph {
	const websiteSchema: WebSite = {
		'@id': `${properties.siteOrigin}#website`,
		'@type': 'WebSite',
		description: defaultDescription,
		name: siteName,
		url: properties.siteOrigin,
	};
	const organizationSchema: Organization = {
		'@id': `${properties.siteOrigin}#organization`,
		'@type': 'Organization',
		email: `mailto:${supportEmail}`,
		logo: createAbsoluteUrl('/favicon.svg', properties.siteOrigin),
		name: siteName,
		url: properties.siteOrigin,
	};
	const webApplicationSchema: WebApplication = {
		'@id': `${appSiteUrl}/#webapplication`,
		'@type': 'WebApplication',
		applicationCategory: 'DeveloperApplication',
		description: webApplicationDescription,
		name: siteName,
		operatingSystem: 'Any',
		url: appSiteUrl,
	};
	const webPageSchema: WebPage = {
		'@id': `${properties.canonicalUrl}#webpage`,
		'@type': properties.openGraphType === 'article' ? 'AboutPage' : 'WebPage',
		description: properties.description,
		isPartOf: { '@id': `${properties.siteOrigin}#website` },
		name: properties.title,
		url: properties.canonicalUrl,
	};

	return {
		'@context': 'https://schema.org',
		'@graph': [websiteSchema, organizationSchema, webApplicationSchema, webPageSchema],
	};
}

export const landingPagePresets = {
	docsOverview: {
		canonicalUrl: `${landingSiteUrl}/docs`,
		description: 'Codemaxxing runtime, realtime, AI, and workflow systems.',
		title: 'Architecture — Codemaxxing Architecture',
	},
	home: {
		canonicalUrl: `${landingSiteUrl}/`,
		description: 'A browser-based cloud IDE with AI agents and instant previews. Code, build, and deploy from anywhere.',
		title: 'Codemaxxing — Agentic Cloud IDE',
	},
	notFound: {
		canonicalUrl: `${landingSiteUrl}/404`,
		description: 'The page you are looking for does not exist.',
		noIndex: true,
		title: 'Page Not Found — Codemaxxing',
	},
} satisfies Record<'docsOverview' | 'home' | 'notFound', LandingPageMetadataInput>;

export function createDocsTopicPageMetadata(properties: { description: string; slug: string; title: string }): LandingPageMetadataInput {
	return {
		canonicalUrl: `${landingSiteUrl}/docs/${properties.slug}`,
		description: properties.description,
		openGraphType: 'article',
		title: `${properties.title} — Codemaxxing Architecture`,
	};
}

export function resolveLandingPageMetadata(properties: ResolveLandingPageMetadataOptions): ResolvedLandingPageMetadata {
	const siteOrigin = properties.siteOrigin ?? landingSiteUrl;
	const robots = createRobotsValue(properties.metadata);
	const googlebot = createGooglebotValue(properties.metadata, robots);
	const canonicalUrl = createCanonicalUrl(properties, siteOrigin);
	const openGraphImage = properties.metadata.openGraphImage ?? defaultOpenGraphImage;
	const absoluteOpenGraphImageUrl = createAbsoluteUrl(openGraphImage.path, siteOrigin);
	const openGraphType = properties.metadata.openGraphType ?? 'website';

	return {
		applicationName: siteName,
		canonicalUrl,
		description: properties.metadata.description,
		formatDetection: 'telephone=no',
		googleSiteVerification: properties.metadata.googleSiteVerification,
		googlebot,
		locale: siteLocale,
		openGraphImage: {
			...openGraphImage,
			absoluteUrl: absoluteOpenGraphImageUrl,
		},
		openGraphType,
		robots,
		structuredData: createStructuredData({
			canonicalUrl,
			description: properties.metadata.description,
			openGraphType,
			siteOrigin,
			title: properties.metadata.title,
		}),
		themeColor: defaultThemeColor,
		title: properties.metadata.title,
		twitterCard: 'summary_large_image',
	};
}

export { landingSiteUrl } from '../../site-config';
