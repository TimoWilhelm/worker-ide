import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import type { Preview } from '@storybook/react-vite';

import '../src/index.css';

import { TooltipProvider } from '../src/components/ui/tooltip';

const preview: Preview = {
	parameters: {
		backgrounds: {
			default: 'dark',
			values: [
				{ name: 'dark', value: '#0d1117' },
				{ name: 'secondary', value: '#161b22' },
			],
		},
		controls: {
			matchers: {
				color: /(background|color)$/i,
				date: /Date$/i,
			},
		},
	},
	tags: ['autodocs'],
	decorators: [
		(Story) => {
			const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
			return (
				<QueryClientProvider client={queryClient}>
					<TooltipProvider>
						<Story />
					</TooltipProvider>
				</QueryClientProvider>
			);
		},
	],
};

export default preview;
