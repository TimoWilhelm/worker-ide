import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
	title: 'vinext App',
	description: 'A vinext App Router app running on Vite.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
