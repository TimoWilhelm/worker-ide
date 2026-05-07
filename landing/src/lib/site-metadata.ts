import type { Graph, Organization, WebApplication, WebPage, WebSite } from 'schema-dts';

import { meta } from '../../../shared/meta';
import landingOpenGraphImagePath from '../assets/meta/landing-og.png?url';

export interface OpenGraphImageMetadata {
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
	openGraphImage?: OpenGraphImageMetadata;
	openGraphType?: 'article' | 'website';
	robots?: string;
	title: string;
}

interface ResolveLandingPageMetadataOptions {
	currentUrl: URL;
	metadata: LandingPageMetadataInput;
	siteOrigin?: string;
	canonicalUrl?: string;
}

interface ResolvedLandingPageMetadata {
	applicationName: string;
	canonicalUrl: string;
	description: string;
	formatDetection: string;
	googleSiteVerification?: string;
	googlebot: string;
	locale: string;
	openGraphImage: OpenGraphImageMetadata & { absoluteUrl: string };
	openGraphType: 'article' | 'website';
	robots: string;
	structuredData: Graph;
	themeColor: string;
	title: string;
	twitterCard: 'summary_large_image';
}

const defaultDescription = meta.description;
const defaultOpenGraphImage: OpenGraphImageMetadata = {
	alt: meta.title,
	height: 630,
	path: landingOpenGraphImagePath,
	type: 'image/png',
	width: 1200,
};
const defaultThemeColor = '#f14602';

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
	if (properties.canonicalUrl) {
		return properties.canonicalUrl;
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
		name: meta.applicationName,
		url: properties.siteOrigin,
	};
	const organizationSchema: Organization = {
		'@id': `${properties.siteOrigin}#organization`,
		'@type': 'Organization',
		email: `mailto:${meta.supportEmail}`,
		logo: createAbsoluteUrl('/favicon.svg', properties.siteOrigin),
		name: meta.applicationName,
		url: properties.siteOrigin,
	};
	const webApplicationSchema: WebApplication = {
		'@id': `${meta.appSiteUrl}/#webapplication`,
		'@type': 'WebApplication',
		applicationCategory: 'DeveloperApplication',
		description: defaultDescription,
		name: meta.applicationName,
		operatingSystem: 'Any',
		url: meta.appSiteUrl,
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

export function resolveLandingPageMetadata(properties: ResolveLandingPageMetadataOptions): ResolvedLandingPageMetadata {
	const siteOrigin = properties.siteOrigin ?? meta.landingSiteUrl;
	const robots = createRobotsValue(properties.metadata);
	const googlebot = createGooglebotValue(properties.metadata, robots);
	const canonicalUrl = createCanonicalUrl(properties, siteOrigin);
	const openGraphImage = properties.metadata.openGraphImage ?? defaultOpenGraphImage;
	const absoluteOpenGraphImageUrl = createAbsoluteUrl(openGraphImage.path, siteOrigin);
	const openGraphType = properties.metadata.openGraphType ?? 'website';

	return {
		applicationName: meta.applicationName,
		canonicalUrl,
		description: properties.metadata.description,
		formatDetection: 'telephone=no',
		googleSiteVerification: properties.metadata.googleSiteVerification,
		googlebot,
		locale: 'en_US',
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
