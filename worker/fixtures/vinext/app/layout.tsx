import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
	title: 'vinext App',
	description: 'A Next.js App Router app running on Vite via vinext.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
