/**
 * Organization Invitation Email Template
 *
 * Sent when a user is invited to join an organization.
 * Uses React Email components for rendering.
 */

import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from '@react-email/components';

interface OrgInvitationEmailProperties {
	inviterName: string;
	organizationName: string;
	role: string;
	acceptUrl: string;
}

export function OrgInvitationEmail({ inviterName, organizationName, role, acceptUrl }: OrgInvitationEmailProperties) {
	return (
		<Html>
			<Head />
			<Preview>
				{inviterName} invited you to join {organizationName}
			</Preview>
			<Body style={bodyStyle}>
				<Container style={containerStyle}>
					<Heading style={headingStyle}>You&apos;re invited!</Heading>
					<Text style={textStyle}>
						<strong>{inviterName}</strong> has invited you to join <strong>{organizationName}</strong> as a <strong>{role}</strong>.
					</Text>
					<Section style={buttonContainerStyle}>
						<Button style={buttonStyle} href={acceptUrl}>
							Accept Invitation
						</Button>
					</Section>
					<Hr style={hrStyle} />
					<Text style={footerStyle}>If you didn&apos;t expect this invitation, you can safely ignore this email.</Text>
				</Container>
			</Body>
		</Html>
	);
}

// =============================================================================
// Styles
// =============================================================================

const bodyStyle = {
	backgroundColor: '#f6f9fc',
	fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const containerStyle = {
	backgroundColor: '#ffffff',
	margin: '0 auto',
	padding: '40px 20px',
	maxWidth: '560px',
	borderRadius: '8px',
};

const headingStyle = {
	fontSize: '24px',
	fontWeight: '600' as const,
	color: '#1a1a1a',
	marginBottom: '16px',
};

const textStyle = {
	fontSize: '16px',
	lineHeight: '24px',
	color: '#4a4a4a',
};

const buttonContainerStyle = {
	textAlign: 'center' as const,
	margin: '32px 0',
};

const buttonStyle = {
	backgroundColor: '#f14602',
	borderRadius: '6px',
	color: '#ffffff',
	fontSize: '16px',
	fontWeight: '600' as const,
	padding: '12px 24px',
	textDecoration: 'none',
};

const hrStyle = {
	borderColor: '#e6e6e6',
	margin: '24px 0',
};

const footerStyle = {
	fontSize: '13px',
	color: '#8c8c8c',
};
