import { appDocumentMetadata } from '@/lib/app-metadata';

export function AppDocumentMetadata() {
	return (
		<>
			<title>{appDocumentMetadata.title}</title>
			<link rel="canonical" href={appDocumentMetadata.canonicalUrl} />
			<meta name="viewport" content={appDocumentMetadata.viewport} />
			<meta name="description" content={appDocumentMetadata.description} />
			<meta name="robots" content={appDocumentMetadata.robots} />
			<meta name="googlebot" content={appDocumentMetadata.googlebot} />
			<meta name="theme-color" content={appDocumentMetadata.themeColor} />
			<meta name="application-name" content={appDocumentMetadata.applicationName} />
			<meta name="apple-mobile-web-app-title" content={appDocumentMetadata.shortName} />
			<meta name="apple-mobile-web-app-capable" content="yes" />
			<meta name="mobile-web-app-capable" content="yes" />
			<meta name="format-detection" content={appDocumentMetadata.formatDetection} />
			<meta property="og:type" content="website" />
			<meta property="og:url" content={appDocumentMetadata.canonicalUrl} />
			<meta property="og:title" content={appDocumentMetadata.title} />
			<meta property="og:description" content={appDocumentMetadata.description} />
			<meta property="og:image" content={appDocumentMetadata.socialImageUrl} />
			<meta property="og:image:secure_url" content={appDocumentMetadata.socialImageUrl} />
			<meta property="og:image:type" content={appDocumentMetadata.socialImageType} />
			<meta property="og:image:width" content={String(appDocumentMetadata.socialImageWidth)} />
			<meta property="og:image:height" content={String(appDocumentMetadata.socialImageHeight)} />
			<meta property="og:image:alt" content={appDocumentMetadata.socialImageAlt} />
			<meta property="og:site_name" content={appDocumentMetadata.productName} />
			<meta property="og:locale" content={appDocumentMetadata.locale} />
			<meta name="twitter:card" content={appDocumentMetadata.twitterCard} />
			<meta name="twitter:title" content={appDocumentMetadata.title} />
			<meta name="twitter:description" content={appDocumentMetadata.description} />
			<meta name="twitter:image" content={appDocumentMetadata.socialImageUrl} />
			<meta name="twitter:image:alt" content={appDocumentMetadata.socialImageAlt} />
		</>
	);
}
