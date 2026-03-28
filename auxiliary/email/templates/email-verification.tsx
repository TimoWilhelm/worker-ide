/**
 * Email Verification Template
 *
 * Sent when a user needs to verify their email address (signup or email change).
 * Uses React Email components for rendering.
 */

import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from '@react-email/components';

interface EmailVerificationProperties {
	userName: string;
	verificationUrl: string;
}

export function EmailVerificationEmail({ userName, verificationUrl }: EmailVerificationProperties) {
	return (
		<Html>
			<Head />
			<Preview>Verify your email address for Codemaxxing</Preview>
			<Body style={bodyStyle}>
				<Container style={containerStyle}>
					<Heading style={headingStyle}>Verify your email</Heading>
					<Text style={textStyle}>
						Hi <strong>{userName}</strong>, please verify your email address to complete your account setup.
					</Text>
					<Section style={buttonContainerStyle}>
						<Button style={buttonStyle} href={verificationUrl}>
							Verify Email Address
						</Button>
					</Section>
					<Hr style={hrStyle} />
					<Text style={footerStyle}>If you didn&apos;t create an account on Codemaxxing, you can safely ignore this email.</Text>
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
