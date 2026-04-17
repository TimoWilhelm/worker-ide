import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from '@react-email/components';

interface PasswordResetProperties {
	userName: string;
	resetUrl: string;
}

export function PasswordResetEmail({ userName, resetUrl }: PasswordResetProperties) {
	return (
		<Html>
			<Head />
			<Preview>Reset your Codemaxxing password</Preview>
			<Body style={bodyStyle}>
				<Container style={containerStyle}>
					<Heading style={headingStyle}>Reset your password</Heading>
					<Text style={textStyle}>
						Hi <strong>{userName}</strong>, we received a request to reset your password. Click the button below to choose a new password.
					</Text>
					<Section style={buttonContainerStyle}>
						<Button style={buttonStyle} href={resetUrl}>
							Reset Password
						</Button>
					</Section>
					<Text style={textStyle}>This link will expire in 1 hour.</Text>
					<Hr style={hrStyle} />
					<Text style={footerStyle}>
						If you didn&apos;t request a password reset, you can safely ignore this email. Your password will not be changed.
					</Text>
				</Container>
			</Body>
		</Html>
	);
}

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
